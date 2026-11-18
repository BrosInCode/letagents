import { randomUUID } from "node:crypto";

import { isGrantableCapabilityName, type CapabilityName } from "../../../../shared/api/capabilities.mjs";
import { ApiError } from "../../../../shared/api/core.mjs";
import {
  approvePageVersion,
  createPage,
  deletePage,
  getPage,
  getPageDocument,
  grantPage,
  listPageDiagnostics,
  listPages,
  PAGE_LIMITS,
  pinPage,
  publishPageVersion,
  reportPageDiagnostics,
  setCurrentPageVersion,
  unpinPage,
  type PageAuthor,
  type PageDetail,
  type PageSource,
} from "../../../../shared/api/pages.mjs";
import * as store from "../../db/pages.js";
import { getMessageAttachment } from "../../db/messages/attachments.js";
import { inTransaction } from "../../db/room-members.js";
import { isAppSession } from "../../request/app-session.js";
import type { ApiCallContext } from "../context.js";
import { mintPageGrant, requirePageGrantMinter, revokePageGrants } from "../page-grants.js";
import {
  canSeeVersion,
  decideVersionStatus,
  grantableCapabilities,
  htmlFromBytes,
  isHtmlAttachment,
  isVersionAuthor,
  pageCaller,
  preparePageHtml,
  queuePagesInvalidation,
  readAttachmentFromStorage,
  requireRoomAdminInPerson,
  versionAuthor,
  type AttachmentReader,
  type PageCaller,
  type PageHtml,
} from "../pages.js";
import { defineRoute, withStatus, type ApiRoute } from "../route.js";

export interface PagesRouteDeps {
  /** Reads an HTML attachment's bytes from attachment storage. */
  readAttachment?: AttachmentReader;
}

const PAGE_NOT_FOUND = "No page with this id in this room.";
/** What others see of a page that has no live version and no version they may see. */
const UNTITLED = "Untitled";

// Routes for the methods in shared/api/pages.mjs, made with defineRoute.
// Every route finds the page through the room in the URL (store.getRoomPage
// and store.lockRoomPage), so another room's page id is not_found.
export function createPagesRoutes(deps: PagesRouteDeps = {}): readonly ApiRoute[] {
  const readAttachment = deps.readAttachment ?? readAttachmentFromStorage;

  const loadHtml = async (input: { html?: string; source?: PageSource }, call: ApiCallContext): Promise<PageHtml & { source: PageSource | null }> => {
    if (input.html !== undefined) return { ...preparePageHtml(input.html), source: null };
    const source = input.source!;
    const attachment = await getMessageAttachment(call.room.id, source.messageId, source.attachmentId);
    if (!attachment) throw new ApiError("not_found", "No attachment with this id on a message in this room.");
    if (!isHtmlAttachment(attachment)) throw new ApiError("invalid_input", "A page is made from an HTML file (.html).");
    if (attachment.byte_size > PAGE_LIMITS.htmlBytes) throw new ApiError("too_large", "A page is at most 2 MB of HTML.");
    const bytes = await readAttachment(attachment, PAGE_LIMITS.htmlBytes);
    return { ...preparePageHtml(htmlFromBytes(bytes)), source };
  };

  return [
    defineRoute(listPages, async ({ surface }, { room }) => ({
      pages: (await store.listRoomPages(room.id, surface)).map((page) => ({ id: page.id, title: page.title, version: page.current_version! })),
    })),

    defineRoute(getPageDocument, async ({ pageId, version }, call) => {
      const page = await requirePage(call, pageId);
      const wanted = version ?? page.current_version;
      if (wanted === null) throw new ApiError("not_found", "This page has no live version yet.");
      const row = await store.getPageVersion(page.id, wanted);
      // A version the caller may not see is not there for them.
      if (!row || !(await canSeeVersion(pageCaller(call), row))) throw new ApiError("not_found", "No such version of this page.");
      const html = await store.getPageVersionHtml(page.id, row.version);
      if (html === null) throw new ApiError("not_found", "No such version of this page.");
      return { page: { id: page.id, title: row.manifest.title, version: row.version }, html };
    }),

    defineRoute(getPage, async ({ pageId }, call) => pageDetail(pageCaller(call), await requirePage(call, pageId))),

    defineRoute(createPage, async (input, call) => {
      const caller = pageCaller(call);
      const author = await versionAuthor(caller);
      const content = await loadHtml(input, call);
      const status = decideVersionStatus({ draft: input.draft, trust: author.trust, granted: [], requested: content.manifest.capabilities });
      const pageId = `page_${randomUUID().replace(/-/g, "")}`;
      await inTransaction(async (client) => {
        await store.lockRoomPages(client, call.room.id);
        // Live pages count against the room; pages still waiting count
        // against their author, so nobody can fill the room with them.
        if (status === "live") await requireLivePageRoom(client, call.room.id);
        else if ((await store.countAuthorUnlivedPages(client, call.room.id, author)) >= PAGE_LIMITS.unlivedPagesPerAuthor) {
          throw new ApiError("conflict", `You have ${PAGE_LIMITS.unlivedPagesPerAuthor} pages here that are not live yet. Wait for approval or ask a room admin to delete one.`);
        }
        const slug = await pickSlug(client, call.room.id, input.slug, content.manifest.title);
        await store.insertRoomPage(client, {
          id: pageId, roomId: call.room.id, slug, title: content.manifest.title, createdByKind: author.kind, createdBy: author.id,
        });
        const version = await store.insertPageVersion(client, newVersion(pageId, content, author, status));
        // Live at once only when it asks for nothing: there is no grant to keep.
        if (status === "live") await goLive(client, call.room.id, pageId, version, content, null);
      });
      queuePagesInvalidation(call.room.id);
      return withStatus(201, await pageDetail(caller, (await store.getRoomPage(call.room.id, pageId))!));
    }),

    defineRoute(publishPageVersion, async (input, call) => {
      const caller = pageCaller(call);
      const author = await versionAuthor(caller);
      const content = await loadHtml(input, call);
      const published = await inTransaction(async (client) => {
        const page = await store.lockRoomPage(client, call.room.id, input.pageId);
        if (!page) throw new ApiError("not_found", PAGE_NOT_FOUND);
        if (page.owner_room_id !== call.room.id) throw new ApiError("not_granted", "Change this page in the room that owns it.");
        const current = page.current_version ? await store.getPageGrant(page.id, page.current_version, call.room.id, client) : null;
        const status = decideVersionStatus({
          draft: input.draft, trust: author.trust, granted: current?.capabilities ?? [], requested: content.manifest.capabilities,
        });
        if (status !== "live") await makeRoomForUnpublished(client, page.id, author);
        const version = await store.insertPageVersion(client, newVersion(page.id, content, author, status));
        // Same or fewer capabilities: the admin who granted the live version
        // granted these too, so the record keeps their name.
        if (status === "live") await goLive(client, call.room.id, page.id, version, content, current?.approved_by ?? null);
        else await store.touchPage(client, page.id);
        return status;
      });
      // Bearers of the replaced version run old code; viewers open the new one.
      if (published === "live") await revokePageGrants({ pageId: input.pageId, roomId: call.room.id });
      queuePagesInvalidation(call.room.id);
      return withStatus(201, await pageDetail(caller, await requirePage(call, input.pageId)));
    }),

    defineRoute(pinPage, async ({ pageId, surface, position }, call) => {
      const caller = pageCaller(call);
      const accountId = await requireRoomAdminInPerson(caller);
      await inTransaction(async (client) => {
        await store.lockRoomPages(client, call.room.id);
        const page = await store.lockRoomPage(client, call.room.id, pageId);
        if (!page) throw new ApiError("not_found", PAGE_NOT_FOUND);
        const live = page.current_version ? await store.getPageVersion(page.id, page.current_version, client) : null;
        if (!live) throw new ApiError("conflict", "This page has no live version to pin yet.");
        if (!live.manifest.surfaces.includes(surface)) {
          throw new ApiError("conflict", `The live version's manifest does not list the "${surface}" surface.`);
        }
        const order = (await store.listSurfacePlacements(client, call.room.id, surface)).map((row) => row.page_id);
        const pinned = order.includes(page.id);
        if (!pinned && order.length >= PAGE_LIMITS.placementsPerSurface) {
          throw new ApiError("conflict", `At most ${PAGE_LIMITS.placementsPerSurface} pages can be pinned here. Unpin one first.`);
        }
        const rest = order.filter((id) => id !== page.id);
        rest.splice(Math.min(position ?? rest.length, rest.length), 0, page.id);
        await store.writeSurfacePlacements(client, {
          roomId: call.room.id, surface, pageIds: rest, newPageId: pinned ? null : page.id, pinnedBy: accountId,
        });
      });
      queuePagesInvalidation(call.room.id);
      return pageDetail(caller, await requirePage(call, pageId));
    }),

    defineRoute(unpinPage, async ({ pageId, surface }, call) => {
      const caller = pageCaller(call);
      await requireRoomAdminInPerson(caller);
      await inTransaction(async (client) => {
        await store.lockRoomPages(client, call.room.id);
        const page = await store.lockRoomPage(client, call.room.id, pageId);
        if (!page) throw new ApiError("not_found", PAGE_NOT_FOUND);
        const order = (await store.listSurfacePlacements(client, call.room.id, surface)).map((row) => row.page_id);
        await store.writeSurfacePlacements(client, {
          roomId: call.room.id, surface, pageIds: order.filter((id) => id !== page.id), newPageId: null, pinnedBy: null,
        });
      });
      await revokePageGrants({ pageId, roomId: call.room.id });
      queuePagesInvalidation(call.room.id);
      const page = await store.getRoomPage(call.room.id, pageId);
      if (!page) throw new ApiError("not_found", PAGE_NOT_FOUND);
      return pageDetail(caller, page);
    }),

    defineRoute(approvePageVersion, async ({ pageId, version, capabilities }, call) => {
      const caller = pageCaller(call);
      const accountId = await requireRoomAdminInPerson(caller);
      await inTransaction(async (client) => {
        await store.lockRoomPages(client, call.room.id);
        const page = await store.lockRoomPage(client, call.room.id, pageId);
        if (!page) throw new ApiError("not_found", PAGE_NOT_FOUND);
        const row = await store.getPageVersion(page.id, version, client);
        if (!row) throw new ApiError("not_found", "No such version of this page.");
        if (page.current_version === null && row.status === "pending_approval") await requireLivePageRoom(client, call.room.id);
        if (row.status === "draft") throw new ApiError("conflict", "This version is a draft. Publish it before approving it.");
        if (row.status === "superseded") throw new ApiError("conflict", "This version was replaced. Use pages.setCurrent to bring it back.");
        const granted = grantableCapabilities(row.manifest, capabilities);
        await store.upsertPageGrant(client, { pageId: page.id, version: row.version, roomId: call.room.id, capabilities: granted, approvedBy: accountId });
        if (row.status === "pending_approval") {
          await store.setPageCurrentVersion(client, page.id, row.version, row.manifest.title);
          await store.pruneSupersededVersions(client, page.id, PAGE_LIMITS.supersededVersionsKept);
        }
      });
      // Bearers carry the capabilities they were minted with; viewers mint again.
      await revokePageGrants({ pageId, roomId: call.room.id });
      queuePagesInvalidation(call.room.id);
      return pageDetail(caller, await requirePage(call, pageId));
    }),

    defineRoute(setCurrentPageVersion, async ({ pageId, version }, call) => {
      const caller = pageCaller(call);
      await requireRoomAdminInPerson(caller);
      const changed = await inTransaction(async (client) => {
        const page = await store.lockRoomPage(client, call.room.id, pageId);
        if (!page) throw new ApiError("not_found", PAGE_NOT_FOUND);
        if (page.current_version === version) return false;
        const row = await store.getPageVersion(page.id, version, client);
        if (!row) throw new ApiError("not_found", "No such version of this page.");
        if (row.status !== "superseded") throw new ApiError("conflict", "Only a version that was live before can be made live again.");
        await store.setPageCurrentVersion(client, page.id, row.version, row.manifest.title);
        return true;
      });
      if (changed) {
        await revokePageGrants({ pageId, roomId: call.room.id });
        queuePagesInvalidation(call.room.id);
      }
      return pageDetail(caller, await requirePage(call, pageId));
    }),

    defineRoute(deletePage, async ({ pageId }, call) => {
      await requireRoomAdminInPerson(pageCaller(call));
      const deleted = await inTransaction((client) => store.deleteRoomPage(client, call.room.id, pageId));
      if (!deleted) throw new ApiError("not_found", PAGE_NOT_FOUND);
      await revokePageGrants({ pageId });
      queuePagesInvalidation(call.room.id);
      return { id: pageId, deleted: true as const };
    }),

    defineRoute(grantPage, async ({ pageId, version }, call) => {
      // A grant acts for the person, so only their own app sign-in makes one:
      // no agent, no page or job, no owner token.
      if (call.actor.principal.kind !== "person" || call.actor.via) {
        throw new ApiError("not_granted", "Only a person signed in to the LetAgents app can open a page.");
      }
      const minter = requirePageGrantMinter(call.req);
      let before = await openablePage(call, pageId);
      // The app shows one version's HTML; a grant for another version would mix them.
      const notShown = () => new ApiError("conflict", `Version ${version} of this page is no longer live. Open it again.`);
      if (version !== undefined && before.version !== version) throw notShown();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const minted = await mintPageGrant({
          minter, roomId: call.room.id, pageId, pageVersion: before.version, capabilities: before.capabilities,
        });
        // An approve, roll back or update between the read and the mint
        // revoked the page's grants before this one existed: read again.
        const after = await openablePage(call, pageId);
        if (after.version === before.version && sameCapabilities(after.capabilities, before.capabilities)) {
          return withStatus(201, { token: minted.token, expiresAt: minted.expiresAt, capabilities: [...before.capabilities] });
        }
        await revokePageGrants({ grantId: minted.grantId });
        before = after;
        if (version !== undefined && before.version !== version) throw notShown();
      }
      throw new ApiError("conflict", "The page changed while it was opening. Open it again.");
    }),

    defineRoute(reportPageDiagnostics, async ({ pageId, version, entries }, call) => {
      const { actor } = call;
      // The app reports with the person's own app session, or the page
      // version itself through its grant; nobody reports for another version.
      const fromPage = actor.via?.kind === "page" && actor.via.id === pageId && actor.via.version === version;
      const fromApp = !actor.via && isAppSession(call.req);
      if (actor.principal.kind !== "person" || !call.account || !(fromPage || fromApp)) {
        throw new ApiError("not_granted", "Only the LetAgents app showing this page version can report its diagnostics.");
      }
      const page = await requirePage(call, pageId);
      const row = await store.getPageVersion(page.id, version);
      if (!row || !(await canSeeVersion(pageCaller(call), row))) throw new ApiError("not_found", "No such version of this page.");
      const now = Date.now();
      await store.insertPageDiagnostics({
        pageId: page.id,
        version,
        // A time in the future is the reporter's clock; it would hold the entry on top.
        entries: entries.map((entry) => ({ ...entry, at: new Date(Math.min(entry.at ? Date.parse(entry.at) : now, now)).toISOString() })),
        reporterKind: fromPage ? "page" : "person",
        reporterAccountId: call.account.account_id,
        keep: PAGE_LIMITS.diagnosticsPerVersion,
      });
      return { accepted: entries.length };
    }),

    defineRoute(listPageDiagnostics, async ({ pageId, version, limit }, call) => {
      const caller = pageCaller(call);
      const page = await requirePage(call, pageId);
      const wanted = version ?? page.current_version;
      if (wanted === null) throw new ApiError("not_found", "This page has no live version yet.");
      const row = await store.getPageVersion(page.id, wanted);
      if (!row || !(await canSeeVersion(caller, row))) throw new ApiError("not_found", "No such version of this page.");
      if (!caller.agentKey && !isVersionAuthor(caller, row) && !(await caller.isRoomAdmin())) {
        throw new ApiError("not_granted", "Only room admins, the version's author and agents in the room read its diagnostics.");
      }
      const rows = await store.listPageDiagnostics(page.id, row.version, limit);
      return { entries: rows.map((entry) => ({ version: entry.version, kind: entry.kind as never, message: entry.message, at: entry.at.toISOString() })) };
    }),
  ];
}

export const routes: readonly ApiRoute[] = createPagesRoutes();

async function requirePage(call: ApiCallContext, pageId: string): Promise<store.PageRow> {
  const page = await store.getRoomPage(call.room.id, pageId);
  if (!page) throw new ApiError("not_found", PAGE_NOT_FOUND);
  return page;
}

/** The live version of a page pinned in this room, and what it was granted here. */
async function openablePage(call: ApiCallContext, pageId: string): Promise<{ version: number; capabilities: CapabilityName[] }> {
  const page = await requirePage(call, pageId);
  if (!(await store.listPagePlacements(page.id, call.room.id)).length) throw new ApiError("not_found", "This page is not pinned in this room.");
  if (page.current_version === null) throw new ApiError("not_found", "This page has no live version yet.");
  const grant = await store.getPageGrant(page.id, page.current_version, call.room.id);
  return { version: page.current_version, capabilities: (grant?.capabilities ?? []).filter(isGrantableCapabilityName) };
}

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name) => right.includes(name));
}

async function requireLivePageRoom(client: Parameters<typeof store.touchPage>[0], roomId: string): Promise<void> {
  if ((await store.countRoomLivePages(client, roomId)) >= PAGE_LIMITS.livePagesPerRoom) {
    throw new ApiError("conflict", `A room holds at most ${PAGE_LIMITS.livePagesPerRoom} live pages. Delete one first.`);
  }
}

/**
 * Drafts and waiting versions are bounded per page and per author. At the
 * author's limit the author's oldest one makes way, so an agent iterating
 * on a page is never stuck; at the page's limit nobody adds more.
 */
async function makeRoomForUnpublished(
  client: Parameters<typeof store.touchPage>[0],
  pageId: string,
  author: { kind: "person" | "agent"; id: string },
): Promise<void> {
  const waiting = await store.listUnpublishedVersions(client, pageId);
  const own = waiting.filter((row) => row.author_kind === author.kind && row.author_id === author.id);
  if (own.length >= PAGE_LIMITS.unpublishedVersionsPerAuthor) {
    await store.deletePageVersion(client, pageId, own[0]!.version);
    return;
  }
  if (waiting.length >= PAGE_LIMITS.unpublishedVersionsPerPage) {
    throw new ApiError("conflict", `This page has ${PAGE_LIMITS.unpublishedVersionsPerPage} drafts and versions waiting for approval. A room admin must approve some first.`);
  }
}

function newVersion(
  pageId: string,
  content: PageHtml & { source: PageSource | null },
  author: { kind: "person" | "agent"; id: string; ownerAccountId: string | null },
  status: store.NewPageVersion["status"],
): store.NewPageVersion {
  return {
    pageId,
    html: content.html,
    sha256: content.sha256,
    byteSize: content.byteSize,
    manifest: content.manifest,
    authorKind: author.kind,
    authorId: author.id,
    authorOwnerAccountId: author.ownerAccountId,
    sourceMessageId: content.source?.messageId ?? null,
    sourceAttachmentId: content.source?.attachmentId ?? null,
    status,
  };
}

/** A version that went live by the version rules: current now, granted what it asks for (no more than before). */
async function goLive(
  client: Parameters<typeof store.touchPage>[0],
  roomId: string,
  pageId: string,
  version: number,
  content: PageHtml,
  approvedBy: string | null,
): Promise<void> {
  await store.setPageCurrentVersion(client, pageId, version, content.manifest.title);
  await store.upsertPageGrant(client, { pageId, version, roomId, capabilities: content.manifest.capabilities, approvedBy });
  await store.pruneSupersededVersions(client, pageId, PAGE_LIMITS.supersededVersionsKept);
}

async function pickSlug(client: Parameters<typeof store.touchPage>[0], roomId: string, asked: string | undefined, title: string): Promise<string> {
  if (asked) {
    if ((await store.roomSlugsLike(client, roomId, asked)).has(asked)) throw new ApiError("conflict", "Another page in this room has this slug.");
    return asked;
  }
  const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "page";
  const taken = await store.roomSlugsLike(client, roomId, base);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function toAuthor(row: store.PageVersionRow): PageAuthor {
  return { kind: row.author_kind, id: row.author_id, ownerAccountId: row.author_owner_account_id };
}

async function pageDetail(caller: PageCaller, page: store.PageRow): Promise<PageDetail> {
  const roomId = caller.call.room.id;
  const [all, placements] = await Promise.all([store.listPageVersions(page.id), store.listPagePlacements(page.id, roomId)]);
  const current = all.find((row) => row.version === page.current_version) ?? null;
  const grant = current ? await store.getPageGrant(page.id, current.version, roomId) : null;
  const versions: store.PageVersionRow[] = [];
  for (const row of all) if (await canSeeVersion(caller, row)) versions.push(row);
  // Until a version goes live the title and slug come from a draft or a
  // waiting version, which only its author and room admins may read.
  const hidden = page.current_version === null && versions.length === 0;
  return {
    id: page.id,
    title: hidden ? UNTITLED : page.title,
    slug: hidden ? "untitled" : page.slug,
    owner: { kind: page.owner_kind, id: (page.owner_room_id ?? page.owner_org_id)! },
    currentVersion: page.current_version,
    updatedBy: current ? toAuthor(current) : null,
    placements: placements.map((row) => ({
      surface: row.surface, position: row.position, pinnedBy: row.pinned_by, createdAt: row.created_at.toISOString(),
    })),
    grant: grant
      ? { version: grant.version, capabilities: grant.capabilities, approvedBy: grant.approved_by, approvedAt: grant.approved_at.toISOString() }
      : null,
    manifest: current
      ? {
        capabilities: current.manifest.capabilities,
        surfaces: current.manifest.surfaces,
        collections: current.manifest.collections ?? {},
        workItemFields: current.manifest.workItemFields ?? [],
      }
      : null,
    versions: versions.map((row) => ({
      version: row.version,
      status: row.status,
      sha256: row.sha256,
      byteSize: row.byte_size,
      author: toAuthor(row),
      source: row.source_message_id && row.source_attachment_id ? { messageId: row.source_message_id, attachmentId: row.source_attachment_id } : null,
      capabilities: row.manifest.capabilities,
      surfaces: row.manifest.surfaces,
      createdAt: row.created_at.toISOString(),
    })),
    createdAt: page.created_at.toISOString(),
    updatedAt: page.updated_at.toISOString(),
  };
}
