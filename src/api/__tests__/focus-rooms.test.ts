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
const createTask = dbModule?.createTask;
const createFocusRoomForTask = dbModule?.createFocusRoomForTask;
const getFocusRoomByKey = dbModule?.getFocusRoomByKey;
const getFocusRoomsForParent = dbModule?.getFocusRoomsForParent;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  if (!pool) {
    throw new Error("DB-backed focus room tests require TEST_DB_URL");
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
    throw new Error("DB-backed focus room tests require TEST_DB_URL");
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
  "createFocusRoomForTask opens one active focus room per parent task",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed focus room tests" : false,
  },
  async () => {
    if (
      !createProjectWithName ||
      !createTask ||
      !createFocusRoomForTask ||
      !getFocusRoomByKey ||
      !getFocusRoomsForParent
    ) {
      throw new Error("DB-backed focus room tests require TEST_DB_URL");
    }

    const parent = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(parent.id, "Wire Focus Rooms backend", "FoxSage");

    const first = await createFocusRoomForTask(parent.id, task.id);
    assert.ok(first);
    assert.equal(first.created, true);
    assert.equal(first.room.kind, "focus");
    assert.equal(first.room.parent_room_id, parent.id);
    assert.equal(first.room.focus_key, task.id);
    assert.equal(first.room.source_task_id, task.id);
    assert.equal(first.room.focus_status, "active");
    assert.match(first.room.id, /^focus_\d+$/);

    const second = await createFocusRoomForTask(parent.id, task.id);
    assert.ok(second);
    assert.equal(second.created, false);
    assert.equal(second.room.id, first.room.id);

    const focusRooms = await getFocusRoomsForParent(parent.id);
    assert.equal(focusRooms.length, 1);
    assert.equal(focusRooms[0]?.id, first.room.id);

    const byKey = await getFocusRoomByKey(parent.id, task.id);
    assert.equal(byKey?.id, first.room.id);
  }
);

test(
  "createFocusRoomForTask rejects nesting focus rooms",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed focus room tests" : false,
  },
  async () => {
    if (!createProjectWithName || !createTask || !createFocusRoomForTask) {
      throw new Error("DB-backed focus room tests require TEST_DB_URL");
    }

    const parent = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(parent.id, "Wire Focus Rooms backend", "FoxSage");
    const focus = await createFocusRoomForTask(parent.id, task.id);
    assert.ok(focus);

    await assert.rejects(
      () => createFocusRoomForTask(focus.room.id, task.id),
      /Focus rooms can only be opened from a main room/
    );
  }
);
