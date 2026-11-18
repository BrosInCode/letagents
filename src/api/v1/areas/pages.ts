import { randomUUID } from "node:crypto";

import { isCapabilityName } from "../../../../shared/api/capabilities.mjs";
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
import { pageGrantsUnavailable, type PageGrantsPort } from "../page-grants-port.js";
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
  /** Mints and revokes page_grant bearers. */
  grants?: PageGrantsPort;
  /** Reads an HTML attachment's bytes from attachment storage. */
  readAttachment?: AttachmentReader;
}

const PAGE_NOT_FOUND = "No page with this id in this room.";

// Routes for the methods in shared/api/pages.mjs, made with defineRoute.
// Every route finds the page through the room in the URL (store.getRoomPage
// and store.lockRoomPage), so another room's page id is not_found.
export function createPagesRoutes(deps: PagesRouteDeps = {}): readonly ApiRoute[] {
  const grants = deps.grants ?? pageGrantsUnavailable;
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
        if ((await store.countRoomOwnedPages(client, call.room.id)) >= PAGE_LIMITS.pagesPerRoom) {
          throw new ApiError("conflict", `A room holds at most ${PAGE_LIMITS.pagesPerRoom} pages. Delete one first.`);
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
      await inTransaction(async (client) => {
        const page = await store.lockRoomPage(client, call.room.id, input.pageId);
        if (!page) throw new ApiError("not_found", PAGE_NOT_FOUND);
        if (page.owner_room_id !== call.room.id) throw new ApiError("not_granted", "Change this page in the room that owns it.");
        const current = page.current_version ? await store.getPageGrant(page.id, page.current_version, call.room.id, client) : null;
        const status = decideVersionStatus({
          draft: input.draft, trust: author.trust, granted: current?.capabilities ?? [], requested: content.manifest.capabilities,
        });
        const version = await store.insertPageVersion(client, newVersion(page.id, content, author, status));
        // Same or fewer capabilities: the admin who granted the live version
        // granted these too, so the record keeps their name.
        if (status === "live") await goLive(client, call.room.id, page.id, version, content, current?.approved_by ?? null);
        else await store.touchPage(client, page.id);
      });
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
      await grants.revokePageGrants({ pageId, roomId: call.room.id });
      queuePagesInvalidation(call.room.id);
      const page = await store.getRoomPage(call.room.id, pageId);
      if (!page) throw new ApiError("not_found", PAGE_NOT_FOUND);
      return pageDetail(caller, page);
    }),

    defineRoute(approvePageVersion, async ({ pageId, version, capabilities }, call) => {
      const caller = pageCaller(call);
      const accountId = await requireRoomAdminInPerson(caller);
      await inTransaction(async (client) => {
        const page = await store.lockRoomPage(client, call.room.id, pageId);
        if (!page) throw new ApiError("not_found", PAGE_NOT_FOUND);
        const row = await store.getPageVersion(page.id, version, client);
        if (!row) throw new ApiError("not_found", "No such version of this page.");
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
      await grants.revokePageGrants({ pageId, roomId: call.room.id });
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
        await grants.revokePageGrants({ pageId, roomId: call.room.id });
        queuePagesInvalidation(call.room.id);
      }
      return pageDetail(caller, await requirePage(call, pageId));
    }),

    defineRoute(deletePage, async ({ pageId }, call) => {
      await requireRoomAdminInPerson(pageCaller(call));
      const deleted = await inTransaction((client) => store.deleteRoomPage(client, call.room.id, pageId));
      if (!deleted) throw new ApiError("not_found", PAGE_NOT_FOUND);
      await grants.revokePageGrants({ pageId });
      queuePagesInvalidation(call.room.id);
      return { id: pageId, deleted: true as const };
    }),

    defineRoute(grantPage, async ({ pageId }, call) => {
      const caller = pageCaller(call);
      // A grant acts for the person, so only their own app sign-in makes one:
      // no agent, no page grant, no owner token.
      if (!caller.accountId || call.actor.via || !isAppSession(call.req)) {
        throw new ApiError("not_granted", "Only a person signed in to the LetAgents app can open a page.");
      }
      const page = await requirePage(call, pageId);
      const placements = await store.listPagePlacements(page.id, call.room.id);
      if (!placements.length) throw new ApiError("not_found", "This page is not pinned in this room.");
      if (page.current_version === null) throw new ApiError("not_found", "This page has no live version yet.");
      const grant = await store.getPageGrant(page.id, page.current_version, call.room.id);
      const capabilities = (grant?.capabilities ?? []).filter(isCapabilityName);
      const minted = await grants.mintPageGrant({
        req: call.req, accountId: caller.accountId, roomId: call.room.id, pageId: page.id, pageVersion: page.current_version, capabilities,
      });
      return withStatus(201, {
        token: minted.token,
        grantId: minted.grantId,
        expiresAt: minted.expiresAt,
        page: { id: page.id, title: page.title, version: page.current_version },
        capabilities,
      });
    }),

    defineRoute(reportPageDiagnostics, async ({ pageId, version, entries }, call) => {
      const caller = pageCaller(call);
      // The app showing the page reports, as the viewer or through the page's own grant.
      if (!caller.accountId && caller.viaPage !== pageId) throw new ApiError("not_granted", "Only the app showing this page can report its diagnostics.");
      const page = await requirePage(call, pageId);
      const row = await store.getPageVersion(page.id, version);
      if (!row || !(await canSeeVersion(caller, row))) throw new ApiError("not_found", "No such version of this page.");
      const now = Date.now();
      await store.insertPageDiagnostics({
        pageId: page.id,
        version,
        // A time in the future is the reporter's clock; it would hold the entry on top.
        entries: entries.map((entry) => ({ ...entry, at: new Date(Math.min(entry.at ? Date.parse(entry.at) : now, now)).toISOString() })),
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
      if (!row) throw new ApiError("not_found", "No such version of this page.");
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
  return {
    id: page.id,
    title: page.title,
    slug: page.slug,
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
