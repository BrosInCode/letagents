import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL || process.env.DB_URL;
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
const createTaskLease = dbModule?.createTaskLease;
const getActiveTaskLeases = dbModule?.getActiveTaskLeases;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  if (!pool) {
    throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
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
    throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
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
  "createTaskLease expires stale active leases before inserting a replacement lease",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL or DB_URL to run DB-backed coordination tests" : false,
  },
  async () => {
    if (!createProjectWithName || !createTask || !createTaskLease || !getActiveTaskLeases) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const now = Date.now();
    const expiredAt = new Date(now - 60_000).toISOString();
    const replacementExpiresAt = new Date(now + 60 * 60_000).toISOString();

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(room.id, "Lease expiry coverage", "StoneCloud");

    const expired = await createTaskLease({
      room_id: room.id,
      task_id: task.id,
      kind: "work",
      agent_key: "EmmyMay/bayotter",
      agent_instance_id: "instance:old",
      actor_label: "BayOtter | EmmyMay's agent | Agent",
      created_by: "StoneCloud | EmmyMay's agent | Agent",
      expires_at: expiredAt,
    });

    const replacement = await createTaskLease({
      room_id: room.id,
      task_id: task.id,
      kind: "work",
      agent_key: "EmmyMay/stonecloud",
      agent_instance_id: "instance:new",
      actor_label: "StoneCloud | EmmyMay's agent | Agent",
      created_by: "StoneCloud | EmmyMay's agent | Agent",
      expires_at: replacementExpiresAt,
    });

    const activeLeases = await getActiveTaskLeases(room.id, task.id);
    assert.equal(activeLeases.length, 1);
    assert.equal(activeLeases[0].id, replacement.id);
    assert.notEqual(activeLeases[0].id, expired.id);
  }
);
