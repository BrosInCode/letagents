import type { PoolClient } from "pg";

import type { PageManifest, PageSurface } from "../../../shared/api/manifest.mjs";
import type { PageVersionStatus } from "../../../shared/api/pages.mjs";
import { pool } from "./client.js";

// The store behind the pages.* API methods (shared/api/pages.mjs). It knows
// rows and order; who may do what is decided before it is called
// (src/api/v1/pages.ts). Every lookup of a page by id names the room too.

type Queryable = Pick<PoolClient, "query">;

export interface PageRow {
  id: string;
  owner_kind: "room" | "org";
  owner_room_id: string | null;
  owner_org_id: string | null;
  slug: string;
  title: string;
  current_version: number | null;
  created_by_kind: "person" | "agent";
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface PageVersionRow {
  page_id: string;
  version: number;
  sha256: string;
  byte_size: number;
  manifest: PageManifest;
  author_kind: "person" | "agent";
  author_id: string;
  author_owner_account_id: string | null;
  source_message_id: string | null;
  source_attachment_id: string | null;
  status: PageVersionStatus;
  created_at: Date;
}

export interface PagePlacementRow {
  page_id: string;
  room_id: string;
  surface: PageSurface;
  position: number;
  pinned_by: string | null;
  created_at: Date;
}

export interface PageGrantRow {
  page_id: string;
  version: number;
  room_id: string;
  capabilities: string[];
  approved_by: string | null;
  approved_at: Date;
}

export interface PageDiagnosticRow {
  version: number;
  kind: string;
  message: string;
  at: Date;
}

const PAGE_COLUMNS = "p.id, p.owner_kind, p.owner_room_id, p.owner_org_id, p.slug, p.title, p.current_version, p.created_by_kind, p.created_by, p.created_at, p.updated_at";
const VERSION_COLUMNS = "page_id, version, sha256, byte_size, manifest, author_kind, author_id, author_owner_account_id, source_message_id, source_attachment_id, status, created_at";
// A page belongs to a room when the room owns it or it is pinned there.
const IN_ROOM = "(p.owner_room_id = $1 OR EXISTS (SELECT 1 FROM page_placements pl WHERE pl.page_id = p.id AND pl.room_id = $1))";

export async function getRoomPage(roomId: string, pageId: string, client: Queryable = pool): Promise<PageRow | null> {
  const { rows } = await client.query<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages p WHERE ${IN_ROOM} AND p.id = $2`, [roomId, pageId]);
  return rows[0] ?? null;
}

/** The same lookup, holding the page row until the transaction ends: version numbers and status changes are made one at a time. */
export async function lockRoomPage(client: Queryable, roomId: string, pageId: string): Promise<PageRow | null> {
  const { rows } = await client.query<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages p WHERE ${IN_ROOM} AND p.id = $2 FOR UPDATE OF p`, [roomId, pageId]);
  return rows[0] ?? null;
}

/** Page creation and pinning in one room run one at a time, so the room's caps and slugs stay exact. */
export async function lockRoomPages(client: Queryable, roomId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('letagents:pages:' || $1))", [roomId]);
}

/** Pages with a live version: pinned on `surface` in pin order, or (no surface) every page in the room in creation order. */
export async function listRoomPages(roomId: string, surface?: PageSurface): Promise<Pick<PageRow, "id" | "title" | "current_version">[]> {
  if (surface) {
    const { rows } = await pool.query<Pick<PageRow, "id" | "title" | "current_version">>(
      `SELECT p.id, p.title, p.current_version FROM page_placements pl JOIN pages p ON p.id = pl.page_id
        WHERE pl.room_id = $1 AND pl.surface = $2 AND p.current_version IS NOT NULL
        ORDER BY pl.position, pl.created_at, p.id`,
      [roomId, surface],
    );
    return rows;
  }
  const { rows } = await pool.query<Pick<PageRow, "id" | "title" | "current_version">>(
    `SELECT p.id, p.title, p.current_version FROM pages p WHERE ${IN_ROOM} AND p.current_version IS NOT NULL ORDER BY p.created_at, p.id`,
    [roomId],
  );
  return rows;
}

/** Pages the room owns that have a live version. */
export async function countRoomLivePages(client: Queryable, roomId: string): Promise<number> {
  const { rows } = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM pages WHERE owner_room_id = $1 AND current_version IS NOT NULL", [roomId]);
  return rows[0]!.count;
}

/** Pages in the room that one author made and that have no live version yet. */
export async function countAuthorUnlivedPages(client: Queryable, roomId: string, author: { kind: "person" | "agent"; id: string }): Promise<number> {
  const { rows } = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pages
      WHERE owner_room_id = $1 AND current_version IS NULL AND created_by_kind = $2 AND created_by = $3`,
    [roomId, author.kind, author.id],
  );
  return rows[0]!.count;
}

/** A page's drafts and versions waiting for approval, oldest first. The caller holds the page row lock. */
export async function listUnpublishedVersions(client: Queryable, pageId: string): Promise<Pick<PageVersionRow, "version" | "author_kind" | "author_id">[]> {
  const { rows } = await client.query<Pick<PageVersionRow, "version" | "author_kind" | "author_id">>(
    "SELECT version, author_kind, author_id FROM page_versions WHERE page_id = $1 AND status IN ('draft', 'pending_approval') ORDER BY version",
    [pageId],
  );
  return rows;
}

export async function deletePageVersion(client: Queryable, pageId: string, version: number): Promise<void> {
  await client.query("DELETE FROM page_versions WHERE page_id = $1 AND version = $2 AND status IN ('draft', 'pending_approval')", [pageId, version]);
}

/** Slugs in the room equal to `base` or `base-<n>`, to pick a free one. */
export async function roomSlugsLike(client: Queryable, roomId: string, base: string): Promise<Set<string>> {
  const { rows } = await client.query<{ slug: string }>(
    "SELECT slug FROM pages WHERE owner_room_id = $1 AND (slug = $2 OR slug LIKE $3)",
    [roomId, base, `${base}-%`],
  );
  return new Set(rows.map((row) => row.slug));
}

export async function insertRoomPage(client: Queryable, input: {
  id: string;
  roomId: string;
  slug: string;
  title: string;
  createdByKind: "person" | "agent";
  createdBy: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO pages (id, owner_kind, owner_room_id, slug, title, current_version, created_by_kind, created_by)
      VALUES ($1, 'room', $2, $3, $4, NULL, $5, $6)`,
    [input.id, input.roomId, input.slug, input.title, input.createdByKind, input.createdBy],
  );
}

export interface NewPageVersion {
  pageId: string;
  html: string;
  sha256: string;
  byteSize: number;
  manifest: PageManifest;
  authorKind: "person" | "agent";
  authorId: string;
  authorOwnerAccountId: string | null;
  sourceMessageId: string | null;
  sourceAttachmentId: string | null;
  status: Exclude<PageVersionStatus, "superseded">;
}

/** Adds the next version number. The caller holds the page row lock. */
export async function insertPageVersion(client: Queryable, input: NewPageVersion): Promise<number> {
  const { rows } = await client.query<{ version: number }>(
    `INSERT INTO page_versions (page_id, version, html, sha256, byte_size, manifest, author_kind, author_id,
        author_owner_account_id, source_message_id, source_attachment_id, status)
      SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11 FROM page_versions WHERE page_id = $1
      RETURNING version`,
    [input.pageId, input.html, input.sha256, input.byteSize, JSON.stringify(input.manifest), input.authorKind, input.authorId,
      input.authorOwnerAccountId, input.sourceMessageId, input.sourceAttachmentId, input.status],
  );
  return rows[0]!.version;
}

/** Newest first, without the HTML. */
export async function listPageVersions(pageId: string, client: Queryable = pool): Promise<PageVersionRow[]> {
  const { rows } = await client.query<PageVersionRow>(`SELECT ${VERSION_COLUMNS} FROM page_versions WHERE page_id = $1 ORDER BY version DESC`, [pageId]);
  return rows;
}

export async function getPageVersion(pageId: string, version: number, client: Queryable = pool): Promise<PageVersionRow | null> {
  const { rows } = await client.query<PageVersionRow>(`SELECT ${VERSION_COLUMNS} FROM page_versions WHERE page_id = $1 AND version = $2`, [pageId, version]);
  return rows[0] ?? null;
}

export async function getPageVersionHtml(pageId: string, version: number): Promise<string | null> {
  const { rows } = await pool.query<{ html: string }>("SELECT html FROM page_versions WHERE page_id = $1 AND version = $2", [pageId, version]);
  return rows[0]?.html ?? null;
}

/**
 * Makes `version` the page's one live version: the live one before it becomes
 * superseded, and the page takes the new version's title.
 */
export async function setPageCurrentVersion(client: Queryable, pageId: string, version: number, title: string): Promise<void> {
  await client.query("UPDATE page_versions SET status = 'superseded' WHERE page_id = $1 AND status = 'live' AND version <> $2", [pageId, version]);
  await client.query("UPDATE page_versions SET status = 'live' WHERE page_id = $1 AND version = $2", [pageId, version]);
  await client.query("UPDATE pages SET current_version = $2, title = $3, updated_at = now() WHERE id = $1", [pageId, version, title]);
}

export async function touchPage(client: Queryable, pageId: string): Promise<void> {
  await client.query("UPDATE pages SET updated_at = now() WHERE id = $1", [pageId]);
}

/** Deletes superseded versions beyond the newest `keep`; the live version, drafts and pending ones stay. */
export async function pruneSupersededVersions(client: Queryable, pageId: string, keep: number): Promise<void> {
  await client.query(
    `DELETE FROM page_versions WHERE page_id = $1 AND status = 'superseded' AND version NOT IN (
      SELECT version FROM page_versions WHERE page_id = $1 AND status = 'superseded' ORDER BY version DESC LIMIT $2)`,
    [pageId, keep],
  );
}

export async function getPageGrant(pageId: string, version: number, roomId: string, client: Queryable = pool): Promise<PageGrantRow | null> {
  const { rows } = await client.query<PageGrantRow>(
    "SELECT page_id, version, room_id, capabilities, approved_by, approved_at FROM page_grants WHERE page_id = $1 AND version = $2 AND room_id = $3",
    [pageId, version, roomId],
  );
  return rows[0] ?? null;
}

export async function upsertPageGrant(client: Queryable, input: {
  pageId: string;
  version: number;
  roomId: string;
  capabilities: readonly string[];
  approvedBy: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO page_grants (page_id, version, room_id, capabilities, approved_by, approved_at) VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (page_id, version, room_id) DO UPDATE SET capabilities = EXCLUDED.capabilities, approved_by = EXCLUDED.approved_by, approved_at = now()`,
    [input.pageId, input.version, input.roomId, [...input.capabilities], input.approvedBy],
  );
}

export async function listPagePlacements(pageId: string, roomId: string, client: Queryable = pool): Promise<PagePlacementRow[]> {
  const { rows } = await client.query<PagePlacementRow>(
    "SELECT page_id, room_id, surface, position, pinned_by, created_at FROM page_placements WHERE page_id = $1 AND room_id = $2 ORDER BY surface",
    [pageId, roomId],
  );
  return rows;
}

/** The pages pinned on one surface of a room, in order. */
export async function listSurfacePlacements(client: Queryable, roomId: string, surface: PageSurface): Promise<PagePlacementRow[]> {
  const { rows } = await client.query<PagePlacementRow>(
    `SELECT page_id, room_id, surface, position, pinned_by, created_at FROM page_placements
      WHERE room_id = $1 AND surface = $2 ORDER BY position, created_at, page_id`,
    [roomId, surface],
  );
  return rows;
}

/**
 * Writes the surface's order as given (0, 1, 2, …). `pinnedBy` is set on a
 * new placement only; an existing one keeps who pinned it.
 */
export async function writeSurfacePlacements(client: Queryable, input: {
  roomId: string;
  surface: PageSurface;
  pageIds: readonly string[];
  newPageId: string | null;
  pinnedBy: string | null;
}): Promise<void> {
  await client.query(
    `DELETE FROM page_placements WHERE room_id = $1 AND surface = $2 AND NOT (page_id = ANY($3::text[]))`,
    [input.roomId, input.surface, [...input.pageIds]],
  );
  for (const [position, pageId] of input.pageIds.entries()) {
    await client.query(
      `INSERT INTO page_placements (page_id, room_id, surface, position, pinned_by) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (page_id, room_id, surface) DO UPDATE SET position = EXCLUDED.position`,
      [pageId, input.roomId, input.surface, position, pageId === input.newPageId ? input.pinnedBy : null],
    );
  }
}

export async function deleteRoomPage(client: Queryable, roomId: string, pageId: string): Promise<boolean> {
  const { rowCount } = await client.query("DELETE FROM pages WHERE id = $1 AND owner_room_id = $2", [pageId, roomId]);
  return (rowCount ?? 0) > 0;
}

/** Adds entries and keeps only the newest `keep` for the version. */
export async function insertPageDiagnostics(input: {
  pageId: string;
  version: number;
  entries: readonly { kind: string; message: string; at: string }[];
  /** `page` when the page reported through its own grant; `person` when the app did with the person's session. */
  reporterKind: "person" | "page";
  reporterAccountId: string;
  keep: number;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO page_diagnostics (page_id, version, kind, message, at, reporter_kind, reporter_account_id)
        SELECT $1, $2, entry.kind, entry.message, entry.at, $4, $5
          FROM jsonb_to_recordset($3::jsonb) AS entry(kind text, message text, at timestamptz)`,
      [input.pageId, input.version, JSON.stringify(input.entries), input.reporterKind, input.reporterAccountId],
    );
    await client.query(
      `DELETE FROM page_diagnostics WHERE page_id = $1 AND version = $2 AND id < (
        SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM page_diagnostics WHERE page_id = $1 AND version = $2 ORDER BY id DESC LIMIT $3) AS newest)`,
      [input.pageId, input.version, input.keep],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Newest first. */
export async function listPageDiagnostics(pageId: string, version: number, limit: number): Promise<PageDiagnosticRow[]> {
  const { rows } = await pool.query<PageDiagnosticRow>(
    "SELECT version, kind, message, at FROM page_diagnostics WHERE page_id = $1 AND version = $2 ORDER BY id DESC LIMIT $3",
    [pageId, version, limit],
  );
  return rows;
}

/** The account that owns an agent (its key is the agents table's canonical key); null when unknown. */
export async function getAgentOwnerAccountId(agentKey: string): Promise<string | null> {
  const { rows } = await pool.query<{ owner_account_id: string }>("SELECT owner_account_id FROM agents WHERE canonical_key = $1", [agentKey]);
  return rows[0]?.owner_account_id ?? null;
}
