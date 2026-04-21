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

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const createProjectWithName = dbModule?.createProjectWithName;
const createReasoningSession = dbModule?.createReasoningSession;
const appendReasoningSessionUpdate = dbModule?.appendReasoningSessionUpdate;
const getReasoningSessionById = dbModule?.getReasoningSessionById;
const getReasoningSessionUpdates = dbModule?.getReasoningSessionUpdates;
const getReasoningSessions = dbModule?.getReasoningSessions;
const updateReasoningSession = dbModule?.updateReasoningSession;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  if (!pool) {
    throw new Error("DB-backed reasoning session tests require TEST_DB_URL");
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError ?? new Error("database did not become ready in time");
}

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed reasoning session tests require TEST_DB_URL");
  }

  await waitForDatabaseReady();
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder });
}

if (!requiresDatabase) {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.after(async () => {
    await pool?.end();
  });
}

test(
  "createReasoningSession persists an initial session and update",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed reasoning session tests" : false,
  },
  async () => {
    if (!createProjectWithName || !createReasoningSession || !getReasoningSessionById || !getReasoningSessionUpdates) {
      throw new Error("DB-backed reasoning session tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");

    const created = await createReasoningSession({
      room_id: room.id,
      task_id: "task_2",
      anchor_message_id: "msg_70",
      actor_label: "ForestDune | EmmyMay's agent | Agent",
      agent_key: "EmmyMay/forestdune",
      snapshot: {
        summary: "mapping backend data model",
        goal: "ship reasoning sessions",
        status: "working",
      },
    });

    assert.equal(created.session.task_id, "task_2");
    assert.equal(created.session.anchor_message_id, "msg_70");
    assert.equal(created.session.summary, "mapping backend data model");
    assert.equal(created.update.summary, "mapping backend data model");

    const session = await getReasoningSessionById(room.id, created.session.id);
    const updates = await getReasoningSessionUpdates(room.id, created.session.id);

    assert.equal(session?.latest_payload.goal, "ship reasoning sessions");
    assert.equal(session?.status, "working");
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.payload.goal, "ship reasoning sessions");
  }
);

test(
  "appendReasoningSessionUpdate merges sparse patches and updateReasoningSession can close a session",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed reasoning session tests" : false,
  },
  async () => {
    if (
      !createProjectWithName ||
      !createReasoningSession ||
      !appendReasoningSessionUpdate ||
      !getReasoningSessionById ||
      !getReasoningSessions ||
      !updateReasoningSession
    ) {
      throw new Error("DB-backed reasoning session tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const created = await createReasoningSession({
      room_id: room.id,
      actor_label: "ForestDune | EmmyMay's agent | Agent",
      agent_key: "EmmyMay/forestdune",
      snapshot: {
        summary: "starting implementation",
        goal: "persist reasoning history",
        status: "working",
      },
    });

    const appended = await appendReasoningSessionUpdate({
      room_id: room.id,
      session_id: created.session.id,
      snapshot: {
        summary: "checking route registration",
        blocker: "waiting on contract confirmation",
      },
    });

    assert.ok(appended);
    assert.equal(appended?.session.latest_payload.goal, "persist reasoning history");
    assert.equal(appended?.session.latest_payload.blocker, "waiting on contract confirmation");
    assert.equal(appended?.session.status, "working");

    const closedAt = new Date().toISOString();
    const closed = await updateReasoningSession({
      room_id: room.id,
      session_id: created.session.id,
      anchor_message_id: "msg_88",
      closed_at: closedAt,
    });

    assert.equal(closed?.anchor_message_id, "msg_88");
    assert.equal(closed?.closed_at, closedAt);

    const lateUpdate = await appendReasoningSessionUpdate({
      room_id: room.id,
      session_id: created.session.id,
      snapshot: {
        summary: "late update after close",
      },
    });

    assert.equal(lateUpdate?.session.closed_at, closedAt);

    const openSessions = await getReasoningSessions(room.id, { open_only: true });
    const saved = await getReasoningSessionById(room.id, created.session.id);

    assert.equal(openSessions.length, 0);
    assert.equal(saved?.latest_payload.goal, "persist reasoning history");
    assert.equal(saved?.latest_payload.blocker, "waiting on contract confirmation");
    assert.equal(saved?.closed_at, closedAt);
  }
);
