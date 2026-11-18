import { createHash } from "node:crypto";

import { CAPABILITIES, isCapabilityName, type CapabilityName } from "../../../shared/api/capabilities.mjs";
import { ApiError } from "../../../shared/api/core.mjs";
import { parsePageManifest, type DataScope, type PageManifest } from "../../../shared/api/manifest.mjs";
import { extractPageManifest, PAGE_LIMITS, type PageVersionStatus } from "../../../shared/api/pages.mjs";
import { ROOM_RESOURCE_PAGES } from "../../../shared/room-resource-invalidation.mjs";
import { isRoomAdminAccount } from "../connectors/rules/engine.js";
import type { MessageAttachmentData } from "../db/types.js";
import * as store from "../db/pages.js";
import { isHumanAppWrite, isSameOriginCookieWrite } from "../request/app-session.js";
import { decideRoomAdmin, roomAccessPrincipal } from "../rooms/access-decision.js";
import { queueRoomResourceInvalidation } from "../server/events.js";
import {
  createPresignedAttachmentDownload,
  isAttachmentStorageConfigured,
} from "../messages/attachment-storage.js";
import type { ApiCallContext } from "./context.js";

// The rules of the pages registry: who may do what with a page, which status
// a new version gets, and what a page version may reach. The routes in
// areas/pages.ts call these; other API areas call the exported page hooks.

/**
 * The capabilities that act for the viewer (`writeLike` in the registry:
 * jobs.start, messages.post, *.propose). A page holding one is where a bad
 * version could act as a person without them, so its versions need a
 * trusted author.
 */
export function isWriteLikeCapability(name: string): boolean {
  return isCapabilityName(name) && CAPABILITIES[name].writeLike;
}

export type PageAuthorTrust =
  /** A room admin (a person), or an agent whose owner is a room admin. */
  | "trusted"
  /** Any agent in the room whose owner is not a room admin. */
  | "agent"
  /** A person who is not a room admin. */
  | "participant";

/**
 * The status a new version gets (plan section 9, "Who can do what"):
 * 1. `draft` when the author asked for one.
 * 2. `pending_approval` when it asks for a capability the live version was
 *    not granted (with no live version, any capability at all).
 * 3. `pending_approval` when a person who is not a room admin made it.
 * 4. `pending_approval` when the page holds a write-like capability (granted
 *    now or asked for) and the author is not trusted.
 * 5. `live` otherwise: a room admin, or any agent in the room.
 */
export function decideVersionStatus(input: {
  draft: boolean;
  trust: PageAuthorTrust;
  granted: readonly string[];
  requested: readonly string[];
}): Exclude<PageVersionStatus, "superseded"> {
  if (input.draft) return "draft";
  const granted = new Set(input.granted);
  if (input.requested.some((name) => !granted.has(name))) return "pending_approval";
  if (input.trust === "participant") return "pending_approval";
  const writeLike = [...input.granted, ...input.requested].some(isWriteLikeCapability);
  if (writeLike && input.trust !== "trusted") return "pending_approval";
  return "live";
}

// ── The caller ──────────────────────────────────────────────────────────

/** Who calls, as the registry sees it. Admin status is read once per call, and only when a rule needs it. */
export interface PageCaller {
  call: ApiCallContext;
  /**
   * The person's account, when a person calls for themselves: no via, or the
   * remote MCP integration, which acts as the person's owner token does.
   * Never through a page or a job.
   */
  accountId: string | null;
  /** The agent key, when an agent calls. */
  agentKey: string | null;
  /** The page id, when the call comes through a page grant. */
  viaPage: string | null;
  isRoomAdmin(): Promise<boolean>;
}

export function pageCaller(call: ApiCallContext): PageCaller {
  const { actor } = call;
  const viaPage = actor.via?.kind === "page" ? actor.via.id : null;
  const forThemselves = !actor.via || actor.via.kind === "integration";
  const accountId = actor.principal.kind === "person" && forThemselves && call.account ? call.account.account_id : null;
  const agentKey = actor.principal.kind === "agent" ? actor.principal.id : null;
  let admin: Promise<boolean> | null = null;
  return {
    call,
    accountId,
    agentKey,
    viaPage,
    isRoomAdmin() {
      if (!accountId || !call.account) return Promise.resolve(false);
      admin ??= decideRoomAdmin({ project: call.room, principal: roomAccessPrincipal(call.account), outage: "throw" })
        .then((decision) => decision.role === "admin");
      return admin;
    },
  };
}

const ADMIN_REFUSED = "Only a room admin, signed in to the LetAgents app, can do this.";

/**
 * Pin, unpin, approve, roll back, delete: a room admin acting for themselves
 * in the app. Owner tokens are what MCP agents hold, so these need the
 * person's own app session, from this app's origin.
 */
export async function requireRoomAdminInPerson(caller: PageCaller): Promise<string> {
  const { call } = caller;
  if (!caller.accountId || call.actor.via) throw new ApiError("not_granted", ADMIN_REFUSED);
  if (!isHumanAppWrite(call.req) || !isSameOriginCookieWrite(call.req)) throw new ApiError("not_granted", ADMIN_REFUSED);
  if (!(await caller.isRoomAdmin())) throw new ApiError("not_granted", ADMIN_REFUSED);
  return caller.accountId;
}

/** The author of a new version, with the trust its status depends on. */
export async function versionAuthor(caller: PageCaller): Promise<{
  kind: "person" | "agent";
  id: string;
  ownerAccountId: string | null;
  trust: PageAuthorTrust;
}> {
  if (caller.viaPage) throw new ApiError("not_granted", "A page cannot change pages.");
  // A job carries no permission: page versions come from the agent or person directly.
  if (caller.call.actor.via?.kind === "job") throw new ApiError("not_granted", "Pages are not changed through a job.");
  if (caller.agentKey) {
    const ownerAccountId = await store.getAgentOwnerAccountId(caller.agentKey);
    const ownerIsAdmin = ownerAccountId ? await isRoomAdminAccount(caller.call.room.id, ownerAccountId, { outage: "throw" }) : false;
    return { kind: "agent", id: caller.agentKey, ownerAccountId, trust: ownerIsAdmin ? "trusted" : "agent" };
  }
  if (!caller.accountId) throw new ApiError("not_granted", "This caller cannot change pages.");
  return { kind: "person", id: caller.accountId, ownerAccountId: null, trust: (await caller.isRoomAdmin()) ? "trusted" : "participant" };
}

/** The version's author, or the person who owns the agent that wrote it. */
export function isVersionAuthor(caller: PageCaller, version: Pick<store.PageVersionRow, "author_kind" | "author_id" | "author_owner_account_id">): boolean {
  if (caller.agentKey) return version.author_kind === "agent" && version.author_id === caller.agentKey;
  if (!caller.accountId) return false;
  return (version.author_kind === "person" && version.author_id === caller.accountId) || version.author_owner_account_id === caller.accountId;
}

/** Live and superseded versions show to everyone in the room; drafts and pending ones to room admins and their author. */
export async function canSeeVersion(caller: PageCaller, version: store.PageVersionRow): Promise<boolean> {
  if (version.status === "live" || version.status === "superseded") return true;
  return isVersionAuthor(caller, version) || (await caller.isRoomAdmin());
}

// ── The page's HTML and manifest ────────────────────────────────────────

export interface PageHtml {
  html: string;
  sha256: string;
  byteSize: number;
  manifest: PageManifest;
}

const ATTACHMENT_READ_TIMEOUT_MS = 15_000;
const HTML_FILENAME = /\.html?$/i;

/** Reads an attachment's bytes, stopping past `maxBytes`. Injected in tests. */
export type AttachmentReader = (attachment: MessageAttachmentData, maxBytes: number) => Promise<Buffer>;

export const readAttachmentFromStorage: AttachmentReader = async (attachment, maxBytes) => {
  if (!isAttachmentStorageConfigured()) throw new ApiError("source_unavailable", "Attachment storage is not available.");
  let response: Response;
  try {
    response = await fetch(createPresignedAttachmentDownload(attachment), { signal: AbortSignal.timeout(ATTACHMENT_READ_TIMEOUT_MS) });
  } catch (error) {
    throw new ApiError("source_unavailable", "Attachment storage did not answer. Try again shortly.", { cause: error });
  }
  if (!response.ok || !response.body) throw new ApiError("source_unavailable", "Attachment storage did not return the file.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new ApiError("too_large", tooLargeMessage());
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const tooLargeMessage = () => `A page is at most ${PAGE_LIMITS.htmlBytes / (1024 * 1024)} MB of HTML.`;

/** Whether an attachment is HTML a page can be made from. */
export function isHtmlAttachment(attachment: Pick<MessageAttachmentData, "content_type" | "filename">): boolean {
  return /^text\/html\b/i.test(attachment.content_type) || HTML_FILENAME.test(attachment.filename);
}

export function htmlFromBytes(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError("invalid_input", "The page's HTML is not UTF-8 text.");
  }
}

/** Checks the size and reads the manifest. Errors name what the author must change. */
export function preparePageHtml(html: string): PageHtml {
  const byteSize = Buffer.byteLength(html, "utf8");
  if (byteSize > PAGE_LIMITS.htmlBytes) throw new ApiError("too_large", tooLargeMessage());
  if (byteSize === 0) throw new ApiError("invalid_input", "The HTML is empty.");
  const script = extractPageManifest(html);
  if (!script.ok) throw new ApiError("invalid_input", script.message);
  const parsed = parsePageManifest(script.json);
  if (!parsed.ok) {
    throw new ApiError("invalid_input", `The page manifest is not valid: ${parsed.errors.map(({ path, message }) => (path ? `${path}: ${message}` : message)).join("; ")}`);
  }
  if (parsed.manifest.owner !== "room") throw new ApiError("invalid_input", "Only room pages are supported: set \"owner\" to \"room\".");
  return { html, sha256: createHash("sha256").update(html, "utf8").digest("hex"), byteSize, manifest: parsed.manifest };
}

// ── Events ──────────────────────────────────────────────────────────────

/** Tells the room's clients that its pages changed; they read again through /api/v1. */
export function queuePagesInvalidation(roomId: string): void {
  queueRoomResourceInvalidation(roomId, ROOM_RESOURCE_PAGES);
}

// ── Hooks for other API areas ───────────────────────────────────────────

/** Whether the room owns the page or has it pinned: documents in the page scope are reachable only then. */
export async function pageExistsInRoom(roomId: string, pageId: string): Promise<boolean> {
  return Boolean(await store.getRoomPage(roomId, pageId));
}

/** The collections a page version's manifest names, per scope; none for an unknown version. */
export async function pageManifestCollections(pageId: string, version: number): Promise<PageManifest["collections"]> {
  const row = await store.getPageVersion(pageId, version);
  return { ...(row?.manifest.collections ?? {}) };
}

/** The collections a page version's manifest names in one data scope; none for an unknown version. */
export async function pageAllowedCollections(pageId: string, version: number, scope: DataScope): Promise<string[]> {
  const row = await store.getPageVersion(pageId, version);
  return [...(row?.manifest.collections?.[scope] ?? [])];
}

/** The tracker fields a page version's manifest names (`workItemFields`); none for an unknown version. */
export async function pageWorkItemFields(pageId: string, version: number): Promise<string[]> {
  const row = await store.getPageVersion(pageId, version);
  return [...(row?.manifest.workItemFields ?? [])];
}

/** Capabilities a room admin may grant a version: only names its manifest asks for. */
export function grantableCapabilities(manifest: PageManifest, chosen: readonly CapabilityName[]): CapabilityName[] {
  const asked = new Set<string>(manifest.capabilities);
  const outside = chosen.filter((name) => !asked.has(name));
  if (outside.length) {
    throw new ApiError("invalid_input", `The version's manifest does not ask for: ${outside.join(", ")}. Grant only capabilities it asks for.`);
  }
  return [...chosen];
}
