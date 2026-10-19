import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

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

/** A live worker session of the agent in the room: only one can share the agent's turn. */
async function worker(roomId: string, agentKey: string, instanceId = `instance_${agentKey}`): Promise<string> {
  const db = store();
  const now = new Date().toISOString();
  await dbClientModule!.pool.query(
    "INSERT INTO accounts (id, provider, provider_user_id, login, display_name, avatar_url, created_at, updated_at) VALUES ('owner_live', 'github', 'owner_live', 'owner_live', 'Owner', NULL, $1, $1) ON CONFLICT (id) DO NOTHING",
    [now],
  );
  const session = await db.createRoomAgentSession({
    room_id: roomId, session_kind: "worker", runtime: "test", actor_label: `${agentKey} ${instanceId}`,
    agent_key: agentKey, agent_instance_id: instanceId, display_name: `${agentKey} ${instanceId}`,
    owner_account_id: "owner_live", owner_label: "Owner", ide_label: "Agent",
  });
  return session.session_id;
}

test("a room keeps one live session per agent, and reasoning reads never include it", { concurrency: false, skip }, async () => {
  const db = store();
  const room = await db.createProjectWithName("live-room");
  const adaWorker = await worker(room.id, "agent_ada");
  const boWorker = await worker(room.id, "agent_bo");
  const first = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", agent_session_id: adaWorker, snapshot: snapshot("Ran a shell command") });
  assert.equal(first.session.kind, "live");
  assert.equal(first.session.anchor_message_id, "msg_7");
  assert.deepEqual(first.removed_session_ids, []);
  // An update row keeps the line and the status, never the turn's entries.
  assert.deepEqual(first.update.payload, { summary: "Ran a shell command", status: "working" });

  const other = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Bo | Claude", agent_key: "agent_bo", agent_session_id: boWorker, snapshot: snapshot("Edited a file") });
  const second = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", agent_session_id: adaWorker, snapshot: snapshot("Read a file") });
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
  const adaWorker = await worker(room.id, "agent_ada");
  const created = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", agent_session_id: adaWorker, snapshot: snapshot("Ran a shell command") });
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
  const adaWorker = await worker(room.id, "agent_ada");
  const boWorker = await worker(room.id, "agent_bo");
  const ada = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", agent_session_id: adaWorker, snapshot: snapshot("Ran a shell command") });
  const bo = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Bo | Claude", agent_key: "agent_bo", agent_session_id: boWorker, snapshot: snapshot("Edited a file") });
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
  const adaWorker = await worker(room.id, "agent_ada");
  const starts = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", agent_session_id: adaWorker, snapshot: snapshot(`Start ${index}`) })));
  const live = await db.getReasoningSessions(room.id, { open_only: true, kind: "live" });
  assert.equal(live.length, 1, "every start replaced the one before it");
  assert.ok(starts.some((start) => start.session.id === live[0]!.id));
});

test("only a live worker session of the agent can start its live session", { concurrency: false, skip }, async () => {
  const db = store();
  const room = await db.createProjectWithName("live-worker-room");
  const adaWorker = await worker(room.id, "agent_ada");
  const boWorker = await worker(room.id, "agent_bo");
  await assert.rejects(
    db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", agent_session_id: boWorker, snapshot: snapshot("Borrowed session") }),
    db.LiveActivityWorkerEndedError,
  );
  const turn = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", agent_session_id: adaWorker, snapshot: snapshot("Ran a shell command") });
  // A restart in the same room keeps the turn for the next session.
  await db.endRoomAgentSession({ session_id: adaWorker, room_id: room.id, restarting: true });
  assert.deepEqual((await db.getReasoningSessions(room.id, { open_only: true, kind: "live" })).map((row) => row.id), [turn.session.id]);
  // The ended session cannot start another turn.
  await assert.rejects(
    db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", agent_session_id: adaWorker, snapshot: snapshot("Late start") }),
    db.LiveActivityWorkerEndedError,
  );
  assert.deepEqual((await db.getReasoningSessions(room.id, { open_only: true, kind: "live" })).map((row) => row.id), [turn.session.id]);
});

test("only the end of a worker session removes the agent's turn", { concurrency: false, skip }, async () => {
  const db = store();
  const room = await db.createProjectWithName("live-controller-end-room");
  const adaWorker = await worker(room.id, "agent_ada");
  const turn = await db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", agent_session_id: adaWorker, snapshot: snapshot("Ran a shell command") });
  await db.endRoomAgentSession({ session_id: adaWorker, room_id: room.id, restarting: true });
  // Before the next worker mints, another kind of session with the agent's key ends.
  const controller = await db.createRoomAgentSession({
    room_id: room.id, session_kind: "controller", runtime: "test", actor_label: "agent_ada controller",
    agent_key: "agent_ada", agent_instance_id: "controller_ada", display_name: "agent_ada controller",
    owner_account_id: "owner_live", owner_label: "Owner", ide_label: "Agent",
  });
  await db.endRoomAgentSession({ session_id: controller.session_id, room_id: room.id });
  assert.deepEqual((await db.getReasoningSessions(room.id, { open_only: true, kind: "live" })).map((row) => row.id), [turn.session.id]);
});

test("a start waiting while the worker session ends does not bring the turn back", { concurrency: false, skip }, async () => {
  const db = store();
  const room = await db.createProjectWithName("live-end-race-room");
  const adaWorker = await worker(room.id, "agent_ada");
  // Hold what the end holds: the agent's live-activity lock, and the session ended but not committed.
  const ending = await dbClientModule!.pool.connect();
  try {
    await ending.query("BEGIN");
    await ending.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["live_activity", room.id, "agent_ada"])]);
    await ending.query("UPDATE room_agent_sessions SET ended_at = now() WHERE session_id = $1", [adaWorker]);
    let settled = false;
    const start = db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", agent_session_id: adaWorker, snapshot: snapshot("In flight") })
      .finally(() => { settled = true; });
    start.catch(() => undefined);
    await delay(200);
    assert.equal(settled, false, "the start waits for the end");
    await ending.query("COMMIT");
    await assert.rejects(start, db.LiveActivityWorkerEndedError);
  } finally {
    ending.release();
  }
  assert.deepEqual(await db.getReasoningSessions(room.id, { open_only: true, kind: "live" }), []);
});

test("the agent's two sessions ending together leave no turn behind", { concurrency: false, skip }, async () => {
  const db = store();
  const room = await db.createProjectWithName("live-double-end-room");
  const first = await worker(room.id, "agent_ada", "instance_one");
  const second = await worker(room.id, "agent_ada", "instance_two");
  await db.createLiveActivitySession({ room_id: room.id, actor_label: "Ada | Codex", agent_key: "agent_ada", agent_session_id: second, snapshot: snapshot("Ran a shell command") });
  // The end of `first`, not yet committed, holds the lock: it still sees `second` live and keeps the turn.
  const ending = await dbClientModule!.pool.connect();
  try {
    await ending.query("BEGIN");
    await ending.query("UPDATE room_agent_sessions SET ended_at = now() WHERE session_id = $1", [first]);
    await ending.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["live_activity", room.id, "agent_ada"])]);
    const endSecond = db.endRoomAgentSession({ session_id: second, room_id: room.id });
    endSecond.catch(() => undefined);
    await delay(200);
    await ending.query("COMMIT");
    // The end of `second` waited for the lock, so it sees `first` ended and removes the turn.
    assert.ok(await endSecond);
  } finally {
    ending.release();
  }
  assert.deepEqual(await db.getReasoningSessions(room.id, { open_only: true, kind: "live" }), []);
});
