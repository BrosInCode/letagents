import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Response } from "express";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import("../db/client.js") : null;
const db = url ? await import("../db.js") : null;
const roomsDb = url ? await import("../db/rooms.js") : null;
const resolution = url ? await import("../rooms/resolution.js") : null;
const gitRouting = url ? await import("../github/git-room-routing.js") : null;
const rental = url ? await import("../rental/room-projection.js") : null;
const options = { skip: !url ? "Set TEST_DB_URL for PostgreSQL integration tests." : false };

test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let sequence = 0;
const unique = (label: string) => `${label}-${suffix}-${++sequence}`;

function fakeResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res;
}

/** Insert a focus row directly, as an older code path or a race could leave it. */
async function insertFocusRow(input: {
  parentRoomId: string;
  focusKey: string;
  archivedAt: string | null;
  createdAt: string;
}): Promise<string> {
  const id = await roomsDb!.buildFocusRoomId();
  await client!.pool.query(
    `INSERT INTO rooms (id, display_name, kind, parent_room_id, focus_key, focus_status, focus_archived_at, created_at)
     VALUES ($1, $2, 'focus', $3, $4, 'active', $5, $6)`,
    [id, `Row ${id}`, input.parentRoomId, input.focusKey, input.archivedAt, input.createdAt],
  );
  return id;
}

test("one active branch room: every lookup returns it", options, async () => {
  const parent = await db!.createProjectWithName(`github.com/${unique("lookup-active")}/app`);
  const focusKey = gitRouting!.buildGitHubRefFocusKey({ refType: "branch", refName: "feature/one" });
  const { room } = await db!.getOrCreateGitChildRoom({ parentRoomId: parent.id, focusKey });

  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey))?.id, room.id);
  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey, { includeArchived: true }))?.id, room.id);
  assert.equal((await db!.getGitChildRoom({ parentRoomId: parent.id, focusKey }))?.id, room.id);
});

test("one archived branch room: a read returns 404, a join returns the archived room", options, async () => {
  const parent = await db!.createProjectWithName(`github.com/${unique("lookup-archived")}/app`);
  const focusKey = gitRouting!.buildGitHubRefFocusKey({ refType: "branch", refName: "feature/two" });
  const { room } = await db!.getOrCreateGitChildRoom({ parentRoomId: parent.id, focusKey });
  assert.equal((await db!.archiveFocusRoom(parent.id, focusKey))?.archived, true);
  const locator = `${parent.id}/focus/${focusKey}`;

  assert.equal(await db!.getFocusRoomByKey(parent.id, focusKey), undefined);
  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey, { includeArchived: true }))?.id, room.id);
  assert.equal((await db!.getGitChildRoom({ parentRoomId: parent.id, focusKey }))?.id, room.id);

  // Read (GET-style resolution): 404.
  assert.equal(await resolution!.resolveExistingRoomRequest(locator), undefined);
  const readRes = fakeResponse();
  assert.equal(await resolution!.resolveRoomOrReply(locator, readRes as unknown as Response), null);
  assert.equal(readRes.statusCode, 404);

  // Join (allowCreate): the archived room, still archived.
  const joinRes = fakeResponse();
  const joined = await resolution!.resolveRoomOrReply(locator, joinRes as unknown as Response, { allowCreate: true });
  assert.equal(joined?.id, room.id);
  assert.ok(joined?.focus_archived_at);
  assert.equal(joinRes.statusCode, 200);
});

test("an active row and older archived rows with one key: lookups that include archived rows return the active row", options, async () => {
  const parent = await db!.createProjectWithName(unique("lookup-mixed"));
  const focusKey = unique("task");
  const archivedOld = await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
  await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-02-02T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z" });
  const active = await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: null, createdAt: "2026-03-01T00:00:00.000Z" });
  assert.notEqual(archivedOld, active);

  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey))?.id, active);
  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey, { includeArchived: true }))?.id, active);
  assert.equal((await db!.getGitChildRoom({ parentRoomId: parent.id, focusKey }))?.id, active);
  // Activating finds the active row and leaves it alone (no unique-index clash).
  assert.deepEqual(
    { id: (await db!.activateFocusRoom(parent.id, focusKey))?.room.id, activated: false },
    { id: active, activated: false },
  );
});

test("only archived rows with one key: lookups return the newest archived row", options, async () => {
  const parent = await db!.createProjectWithName(unique("lookup-archived-only"));
  const focusKey = unique("task");
  await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
  const newest = await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-03-02T00:00:00.000Z", createdAt: "2026-03-01T00:00:00.000Z" });
  await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-02-02T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z" });

  assert.equal(await db!.getFocusRoomByKey(parent.id, focusKey), undefined);
  assert.equal((await db!.getFocusRoomByKey(parent.id, focusKey, { includeArchived: true }))?.id, newest);
  assert.equal((await db!.getGitChildRoom({ parentRoomId: parent.id, focusKey }))?.id, newest);
  // The archive route's "already archived" answer is the most recently
  // archived row (staging returned the first row read, usually the oldest).
  assert.deepEqual(await db!.archiveFocusRoom(parent.id, focusKey).then((r) => ({ id: r?.room.id, archived: r?.archived })), { id: newest, archived: false });
});

test("rental provisioning reuses an existing room with its key, archived or not", options, async () => {
  const parent = await db!.createProjectWithName(unique("lookup-rental"));
  const now = new Date().toISOString();
  const renter = unique("renter");
  const provider = unique("provider");
  const listing = unique("listing");
  const sessionId = unique("session");
  await client!.pool.query(
    `INSERT INTO accounts (id, provider, provider_user_id, login, created_at, updated_at)
     VALUES ($1, 'github', $1, $1, $3, $3), ($2, 'github', $2, $2, $3, $3)`,
    [renter, provider, now],
  );
  await client!.pool.query(
    `INSERT INTO rental_listings (id, provider_account_id, display_name, ide_kind) VALUES ($1, $2, 'Provider', 'codex')`,
    [listing, provider],
  );
  await client!.pool.query(
    `INSERT INTO rental_sessions (id, listing_id, renter_account_id, provider_account_id, target_room_id, task_title, task_prompt, status)
     VALUES ($1, $2, $3, $4, $5, 'Task', 'Prompt', 'accepted')`,
    [sessionId, listing, renter, provider, parent.id],
  );
  const focusKey = `rental:${sessionId}`;
  await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
  const newest = await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-02-02T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z" });

  const provisioned = await rental!.provisionRentalRoom({ sessionId, parentRoomId: parent.id, providerDisplayName: "Provider" });
  assert.equal(provisioned.roomId, newest);
});

test("archiving a live room next to an older archived one: a retry answers with the room just archived", options, async () => {
  const parent = await db!.createProjectWithName(unique("lookup-archive-retry"));
  const focusKey = unique("task");
  await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" });
  const live = await insertFocusRow({ parentRoomId: parent.id, focusKey, archivedAt: null, createdAt: "2026-02-01T00:00:00.000Z" });

  const first = await db!.archiveFocusRoom(parent.id, focusKey);
  assert.deepEqual({ id: first?.room.id, archived: first?.archived }, { id: live, archived: true });
  const retry = await db!.archiveFocusRoom(parent.id, focusKey);
  assert.deepEqual({ id: retry?.room.id, archived: retry?.archived }, { id: live, archived: false });
});
