/**
 * "Retry, or return the existing room, on a duplicate key" paths. Drizzle
 * 0.45 wraps a database error, so the SQLSTATE is on `error.cause`; before
 * this fix the duplicate-key check read `error.code`, never matched, and a
 * concurrent create answered 500.
 *
 * Each race is made deterministic: a second session inserts the same room in
 * an open transaction, the create under test reaches its own insert and waits
 * on the unique index, and the second session then commits.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Response } from "express";
import { Pool } from "pg";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
// utils.ts loads the database client, which reads DB_URL at import time.
const {
  findPgError,
  isDeletedRoomInsertError,
  isUniqueConstraintError,
  MAX_ROOM_CREATE_ATTEMPTS,
  pgErrorCode,
  RoomDeletedError,
} = await import("../db/utils.js");
const client = url ? await import("../db/client.js") : null;
const db = url ? await import("../db.js") : null;
const roomsDb = url ? await import("../db/rooms.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const resolution = url ? await import("../rooms/resolution.js") : null;
const gitRouting = url ? await import("../github/git-room-routing.js") : null;
const legacy = url ? await import("../routes/legacy/projects.js") : null;
const options = { skip: !url ? "Set TEST_DB_URL for PostgreSQL integration tests." : false };

if (url) {
  test.before(async () => { await migrate(client!.db, { migrationsFolder: resolve("drizzle") }); });
  test.after(async () => { await client!.pool.end(); });
}

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let sequence = 0;
const unique = (label: string) => `${label}-${suffix}-${++sequence}`;

async function storedOrigin(roomId: string): Promise<string | null> {
  const result = await client!.pool.query<{ origin: string | null }>("SELECT origin FROM rooms WHERE id = $1", [roomId]);
  assert.equal(result.rowCount, 1, `room ${roomId} exists`);
  return result.rows[0]!.origin;
}

function fakeResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res;
}

/** Run `insert` in an open transaction on another connection; commit it once `waiter` waits on it. */
async function raceAgainstUncommittedInsert<T>(
  insert: { sql: string; params: unknown[] },
  waiter: () => Promise<T>,
): Promise<T> {
  const holder = new Pool({ connectionString: url, max: 1 });
  const other = await holder.connect();
  try {
    await other.query("BEGIN");
    await other.query(insert.sql, insert.params);
    const pending = waiter();
    // Wait until the create under test is blocked on the unique index.
    for (let i = 0; i < 100; i += 1) {
      const waiting = await client!.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
      );
      if (waiting.rowCount) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    await other.query("COMMIT");
    return await pending;
  } finally {
    await other.query("ROLLBACK").catch(() => undefined);
    other.release();
    await holder.end();
  }
}

// ── The helpers ───────────────────────────────────────────────────────────

test("the error helpers read the SQLSTATE through the cause chain, with a bounded depth", () => {
  const pg = { code: "23505", constraint: "rooms_pkey", message: "duplicate key" };
  assert.equal(isUniqueConstraintError(pg), true);
  assert.equal(isUniqueConstraintError({ message: "Failed query", cause: pg }), true);
  assert.equal(isUniqueConstraintError({ cause: { cause: { cause: pg } } }), true);
  let deep: unknown = pg;
  for (let i = 0; i < 6; i += 1) deep = { cause: deep };
  assert.equal(isUniqueConstraintError(deep), false, "more than five causes deep");
  assert.equal(isUniqueConstraintError({ code: "ERR_INVALID_ARG", cause: pg }), true, "a Node error code is not a SQLSTATE");
  assert.equal(isUniqueConstraintError({ code: "23514" }), false);
  assert.equal(isUniqueConstraintError(null), false);
  assert.equal(isUniqueConstraintError("23505"), false);
  assert.equal(pgErrorCode({ cause: { code: "55P03" } }), "55P03");
  assert.equal(findPgError({ cause: pg }), pg);

  const deleted = { cause: { code: "23514", message: "This room was permanently deleted." } };
  assert.equal(isDeletedRoomInsertError(deleted), true);
  assert.equal(isDeletedRoomInsertError({ cause: { code: "23514", message: "violates check constraint rooms_kind_check" } }), false);
});

test("a real Drizzle duplicate-key error is recognised", options, async () => {
  const id = unique("dup");
  const row = { id, display_name: "x", created_at: new Date().toISOString() };
  await client!.db.insert(schema!.rooms).values(row);
  const error = await client!.db.insert(schema!.rooms).values(row).then(() => null, (caught: unknown) => caught);
  assert.equal((error as { code?: string }).code, undefined, "Drizzle's own error has no code");
  assert.equal(isUniqueConstraintError(error), true);
});

// ── Races ─────────────────────────────────────────────────────────────────

test("two joins that create the same named room: both get the one room, no 500", options, async () => {
  const name = unique("race-named");
  const res = fakeResponse();
  const joined = await raceAgainstUncommittedInsert(
    // The other request is a server create too: it stores the origin.
    { sql: "INSERT INTO rooms (id, display_name, origin, created_at) VALUES ($1, 'Other', 'named', now())", params: [name] },
    () => resolution!.resolveRoomOrReply(name, res as unknown as Response, { allowCreate: true }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(joined?.id, name);
  assert.equal(joined?.display_name, "Other", "the room the other join created");
  assert.equal((await client!.pool.query("SELECT 1 FROM rooms WHERE id = $1", [name])).rowCount, 1);
  assert.equal(await storedOrigin(name), "named");

  // And plain concurrency: ten joins at once, one room.
  const many = unique("race-many");
  const results = await Promise.all(Array.from({ length: 10 }, () => {
    const each = fakeResponse();
    return resolution!.resolveRoomOrReply(many, each as unknown as Response, { allowCreate: true })
      .then((room) => ({ room, status: each.statusCode }));
  }));
  assert.deepEqual([...new Set(results.map((result) => `${result.status} ${result.room?.id}`))], [`200 ${many}`]);
  assert.equal(await storedOrigin(many), "named");
});

test("two creations of the same branch room: both get the one room", options, async () => {
  const parent = await db!.createProjectWithName(`github.com/${unique("race-branch")}/app`);
  const focusKey = gitRouting!.buildGitHubRefFocusKey({ refType: "branch", refName: "feature/race" });
  const otherId = await roomsDb!.buildFocusRoomId();
  const result = await raceAgainstUncommittedInsert(
    {
      sql: `INSERT INTO rooms (id, display_name, kind, origin, parent_room_id, focus_key, focus_status, created_at)
            VALUES ($1, 'Branch', 'focus', 'focus', $2, $3, 'active', now())`,
      params: [otherId, parent.id, focusKey],
    },
    () => db!.getOrCreateGitChildRoom({ parentRoomId: parent.id, focusKey }),
  );
  assert.deepEqual({ id: result.room.id, created: result.created }, { id: otherId, created: false });
  const rows = await client!.pool.query("SELECT id, origin FROM rooms WHERE parent_room_id = $1 AND focus_key = $2", [parent.id, focusKey]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0]!.origin, "focus");
  // The retried attempt left no stray row behind under the next focus id.
  assert.equal((await client!.pool.query("SELECT 1 FROM rooms WHERE parent_room_id = $1", [parent.id])).rowCount, 1);
});

test("two creations of a task's focus room: both get the one room", options, async () => {
  const parent = await db!.createProjectWithName(unique("race-task"));
  const task = await db!.createTask(parent.id, "Race", "Human");
  const otherId = await roomsDb!.buildFocusRoomId();
  const result = await raceAgainstUncommittedInsert(
    {
      sql: `INSERT INTO rooms (id, display_name, kind, origin, parent_room_id, focus_key, source_task_id, focus_status, created_at)
            VALUES ($1, 'Task room', 'focus', 'focus', $2, $3, $3, 'active', now())`,
      params: [otherId, parent.id, task.id],
    },
    () => db!.createFocusRoomForTask(parent.id, task.id),
  );
  assert.deepEqual({ id: result?.room.id, created: result?.created }, { id: otherId, created: false });
  assert.equal(await storedOrigin(otherId), "focus");
});

test("createProject tries another code after a collision or a deleted code, a bounded number of times", options, async () => {
  const taken = (await db!.createProject()).id;
  const deletedCode = `${unique("DEL").slice(-4).toUpperCase().replace(/[^A-Z0-9]/g, "Z").padStart(4, "Z")}-ZZZZ-ZZZZ`;
  await client!.pool.query("INSERT INTO deleted_rooms (room_id) VALUES ($1) ON CONFLICT DO NOTHING", [deletedCode]);
  const fresh = `F${Math.random().toString(36).slice(2, 5).toUpperCase().padEnd(3, "0")}-ZZZZ-ZZZZ`;

  const codes = [taken, deletedCode, fresh];
  const created = await roomsDb!.createProject({}, () => codes.shift()!);
  assert.equal(created.id, fresh);
  assert.equal(await storedOrigin(fresh), "join_code", "the retried attempt stores its origin");
  assert.equal(codes.length, 0, "it tried the taken code and the deleted code first");

  let calls = 0;
  await assert.rejects(
    () => roomsDb!.createProject({}, () => { calls += 1; return taken; }),
    new RegExp(`No free join code after ${MAX_ROOM_CREATE_ATTEMPTS} attempts`),
  );
  assert.equal(calls, MAX_ROOM_CREATE_ATTEMPTS);
});

// ── A permanently deleted room: 410, never 500 ────────────────────────────

test("creating a room whose id was permanently deleted answers 410, not 500", options, async () => {
  const deletedName = unique("gone");
  const deletedRepo = `github.com/${unique("gone-repo")}/app`;
  await client!.pool.query("INSERT INTO deleted_rooms (room_id) VALUES ($1), ($2)", [deletedName, deletedRepo]);

  await assert.rejects(() => roomsDb!.getOrCreateCanonicalRoom(deletedName), (error: unknown) =>
    error instanceof RoomDeletedError && error.roomId === deletedName && error.status === 410);

  // A branch locator under a deleted repository room: the parent create is refused.
  const focusKey = gitRouting!.buildGitHubRefFocusKey({ refType: "branch", refName: "main-ish" });
  const res = fakeResponse();
  const room = await resolution!.resolveRoomOrReply(`${deletedRepo}/focus/${focusKey}`, res as unknown as Response, { allowCreate: true });
  assert.equal(room, null);
  assert.equal(res.statusCode, 410);
  assert.deepEqual(res.body, { error: "Room was permanently deleted.", code: "ROOM_DELETED", room_id: deletedRepo });

  // The legacy create route.
  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const app = { get() {}, patch() {}, post(path: string, candidate: typeof handler) { if (path === "/projects/room/:name") handler = candidate; } };
  legacy!.registerLegacyProjectRoutes(app as never, {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    isRepoBackedRoomId: () => false,
  } as never);
  const legacyRes = fakeResponse();
  await handler!({ params: { name: encodeURIComponent(deletedName) }, sessionAccount: { account_id: "acct" } }, legacyRes);
  assert.equal(legacyRes.statusCode, 410);
  assert.deepEqual(legacyRes.body, { error: "Room was permanently deleted.", code: "ROOM_DELETED", room_id: deletedName });
  assert.equal((await client!.pool.query("SELECT 1 FROM rooms WHERE id = ANY($1)", [[deletedName, deletedRepo]])).rowCount, 0);
});
