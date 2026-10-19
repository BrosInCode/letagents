import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const reasoningModule = testDatabaseUrl ? await import("../db/reasoning.js") : null;
const skip = requiresDatabase ? "set TEST_DB_URL to run DB-backed live activity tests" : false;

async function resetDatabase(): Promise<void> {
  const db = dbClientModule?.db;
  const pool = dbClientModule?.pool;
  if (!db || !pool) throw new Error("DB-backed live activity tests require TEST_DB_URL");
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

test.beforeEach(async () => {
  if (!requiresDatabase) await resetDatabase();
});

if (!requiresDatabase) {
  test.after(async () => {
    await dbClientModule?.pool.end();
  });
}

function snapshot(summary: string, overrides: Record<string, unknown> = {}) {
  return {
    summary,
    status: "working" as const,
    live: {
      version: 1 as const,
      state: "working" as const,
      started_at: "2026-10-18T10:00:00.000Z",
      ended_at: null,
      request_message_id: "msg_7",
      omitted_earlier: false,
      entries: [{ kind: "action" as const, id: "e1", headline: summary, status: "completed" as const, tool: "shell" as const, count: 1 }],
      ...overrides,
    },
  };
}

function store() {
  if (!dbModule || !reasoningModule) throw new Error("DB-backed live activity tests require TEST_DB_URL");
  return { ...dbModule, ...reasoningModule };
}

test("a room keeps one live session per agent, and reasoning reads never include it", { concurrency: false, skip }, async () => {
  const db = store();
  const room = await db.createProjectWithName("live-room");
  const first = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", snapshot: snapshot("Ran a shell command") });
  assert.equal(first.session.kind, "live");
  assert.equal(first.session.anchor_message_id, "msg_7");
  assert.deepEqual(first.removed_session_ids, []);
  // An update row keeps the line and the status, never the turn's entries.
  assert.deepEqual(first.update.payload, { summary: "Ran a shell command", status: "working" });

  const other = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Bo | Claude", agent_key: "agent_bo", snapshot: snapshot("Edited a file") });
  const second = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", snapshot: snapshot("Read a file") });
  assert.deepEqual(second.removed_session_ids, [first.session.id]);
  assert.equal(await db.getReasoningSessionById(room.id, first.session.id), undefined);

  const reasoning = await db.createReasoningSession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", snapshot: { summary: "Plan" } });
  assert.deepEqual((await db.getReasoningSessions(room.id, { open_only: true })).map((row) => row.id), [reasoning.session.id]);
  assert.deepEqual(new Set((await db.getReasoningSessions(room.id, { open_only: true, kind: "live" })).map((row) => row.id)), new Set([other.session.id, second.session.id]));
  assert.deepEqual(await db.getRoomReasoningSessionCountsByActor(room.id), [{ actor_label: "Ada | Codex", count: 1 }]);

  // A live session changes only through its own snapshots.
  assert.equal(await db.appendReasoningSessionUpdate({ room_id: room.id, session_id: second.session.id, snapshot: { summary: "Injected" } }), null);
  assert.equal(await db.updateReasoningSession({ room_id: room.id, session_id: second.session.id, closed_at: new Date().toISOString() }), undefined);
});

test("a live session takes snapshots only from its own agent and caps its update rows", { concurrency: false, skip }, async () => {
  const db = store();
  const room = await db.createProjectWithName("live-cap-room");
  const created = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", snapshot: snapshot("Ran a shell command") });
  assert.equal(await db.updateLiveActivitySession({ room_id: room.id, session_id: created.session.id, agent_key: "agent_bo", snapshot: snapshot("Hijack") }), null);

  let lastWithRow = 0;
  for (let index = 2; index <= db.LIVE_ACTIVITY_UPDATE_ROWS_PER_SESSION + 5; index += 1) {
    const result = await db.updateLiveActivitySession({
      room_id: room.id,
      session_id: created.session.id,
      agent_key: "agent_ada",
      snapshot: snapshot(`Step ${index}`, { request_message_id: "msg_8" }),
    });
    assert.ok(result);
    if (result.update) lastWithRow = index;
  }
  assert.equal(lastWithRow, db.LIVE_ACTIVITY_UPDATE_ROWS_PER_SESSION);
  const updates = await db.getReasoningSessionUpdates(room.id, created.session.id, { limit: 500 });
  assert.equal(updates.length, db.LIVE_ACTIVITY_UPDATE_ROWS_PER_SESSION);
  const latest = await db.getReasoningSessionById(room.id, created.session.id);
  // The session still carries the newest snapshot after the rows stop.
  assert.equal(latest?.summary, `Step ${db.LIVE_ACTIVITY_UPDATE_ROWS_PER_SESSION + 5}`);
  assert.equal(latest?.anchor_message_id, "msg_8");
  assert.equal(latest?.latest_payload.live?.request_message_id, "msg_8");
});

test("withdrawal and retention remove live sessions with their update rows", { concurrency: false, skip }, async () => {
  const db = store();
  const pool = dbClientModule!.pool;
  const room = await db.createProjectWithName("live-withdraw-room");
  const ada = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", snapshot: snapshot("Ran a shell command") });
  const bo = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Bo | Claude", agent_key: "agent_bo", snapshot: snapshot("Edited a file") });
  const reasoning = await db.createReasoningSession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", snapshot: { summary: "Plan" } });

  assert.deepEqual(await db.deleteLiveActivitySessions({ room_id: room.id, agent_key: "agent_ada" }), [ada.session.id]);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM reasoning_session_updates WHERE session_id = $1", [ada.session.id])).rows[0].count, 0);
  assert.ok(await db.getReasoningSessionById(room.id, reasoning.session.id), "a reasoning session is not live activity");

  await pool.query("UPDATE reasoning_sessions SET updated_at = now() - interval '2 days' WHERE id = ANY($1)", [[bo.session.id, reasoning.session.id]]);
  const removed = await db.deleteStaleLiveActivitySessions({ updated_before: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), limit: 10 });
  assert.deepEqual(removed, [{ id: bo.session.id, room_id: room.id }]);
  assert.ok(await db.getReasoningSessionById(room.id, reasoning.session.id), "retention keeps reasoning sessions");
});

test("concurrent starts of one agent's turn leave one live session", { concurrency: false, skip }, async () => {
  const db = store();
  const room = await db.createProjectWithName("live-race-room");
  const starts = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", snapshot: snapshot(`Start ${index}`) })));
  const live = await db.getReasoningSessions(room.id, { open_only: true, kind: "live" });
  assert.equal(live.length, 1, "every start replaced the one before it");
  assert.ok(starts.some((start) => start.session.id === live[0]!.id));
});
