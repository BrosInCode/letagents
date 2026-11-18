import { randomUUID } from "node:crypto";

import type { CapabilityName } from "../../../shared/api/capabilities.mjs";
import { createSession } from "../db/auth/account-sessions.js";
import { pool } from "../db/client.js";
import { mintPageGrant, type MintedPageGrant, type PageGrantMinter } from "../v1/page-grants.js";

/**
 * Mints a page grant for a test without a request. Routes must get the
 * minter from requirePageGrantMinter(req), which only an app session passes.
 * Without a `sessionId`, a fresh app session of the account mints it.
 */
export async function mintTestPageGrant(input: {
  accountId: string;
  sessionId?: string;
  roomId: string;
  pageId?: string;
  pageVersion?: number;
  capabilities: readonly CapabilityName[];
}): Promise<MintedPageGrant> {
  const sessionId = input.sessionId ?? (await createTestSession(input.accountId));
  return mintPageGrant({
    minter: testPageGrantMinter(input.accountId, sessionId),
    roomId: input.roomId,
    pageId: input.pageId ?? "page_test",
    pageVersion: input.pageVersion ?? 1,
    capabilities: input.capabilities,
  });
}

export function testPageGrantMinter(accountId: string, sessionId: string): PageGrantMinter {
  return { accountId, sessionId } as PageGrantMinter;
}

/** A signed-in app session for the account; returns its id. */
export async function createTestSession(accountId: string): Promise<string> {
  const session = await createSession(accountId, `page-grant-test-${randomUUID()}`, new Date(Date.now() + 60 * 60_000).toISOString(), null);
  return session.id;
}

/**
 * A page pinned in the room whose live version is `version`, granted these
 * capabilities: what a refresh needs to find before it renews a token.
 */
export async function seedLivePage(input: {
  roomId: string;
  pageId: string;
  version: number;
  capabilities: readonly CapabilityName[];
  createdBy: string;
}): Promise<void> {
  const manifest = { api: 1, title: input.pageId, surfaces: ["room.tab"], capabilities: input.capabilities, workItemFields: [], collections: {}, owner: "room" };
  await pool.query(`INSERT INTO pages (id, owner_kind, owner_room_id, slug, title, current_version, created_by_kind, created_by)
    VALUES ($1, 'room', $2, $1, $1, $3, 'person', $4)`, [input.pageId, input.roomId, input.version, input.createdBy]);
  await pool.query(`INSERT INTO page_versions (page_id, version, html, sha256, byte_size, manifest, author_kind, author_id, status)
    VALUES ($1, $2, '<p></p>', '', 7, $3, 'person', $4, 'live')`, [input.pageId, input.version, JSON.stringify(manifest), input.createdBy]);
  await pool.query("INSERT INTO page_grants (page_id, version, room_id, capabilities) VALUES ($1, $2, $3, $4)",
    [input.pageId, input.version, input.roomId, [...input.capabilities]]);
  await pool.query("INSERT INTO page_placements (page_id, room_id, surface, position) VALUES ($1, $2, 'room.tab', 0)", [input.pageId, input.roomId]);
}
