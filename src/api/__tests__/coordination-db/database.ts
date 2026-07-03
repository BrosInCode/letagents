import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

export const testDatabaseUrl = process.env.TEST_DB_URL || process.env.DB_URL;
export const requiresDatabase = !testDatabaseUrl;
export const databaseSkipReason =
  "set TEST_DB_URL or DB_URL to run DB-backed coordination tests";

if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
}

const dbClientModule = testDatabaseUrl ? await import("../../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../../db.js") : null;

export const db = dbClientModule?.db;
export const pool = dbClientModule?.pool;
export const dbApi = {
  assignProjectAdmin: dbModule?.assignProjectAdmin,
  createOwnerToken: dbModule?.createOwnerToken,
  createProjectWithName: dbModule?.createProjectWithName,
  createRoomAgentSession: dbModule?.createRoomAgentSession,
  approveBoardIntent: dbModule?.approveBoardIntent,
  consumeBoardIntentApproval: dbModule?.consumeBoardIntentApproval,
  countBoardIntents: dbModule?.countBoardIntents,
  createBoardIntent: dbModule?.createBoardIntent,
  denyBoardIntent: dbModule?.denyBoardIntent,
  createSession: dbModule?.createSession,
  createTask: dbModule?.createTask,
  createTaskLease: dbModule?.createTaskLease,
  createTaskLock: dbModule?.createTaskLock,
  getActiveTaskLeases: dbModule?.getActiveTaskLeases,
  markRoomAgentDeliveryConnected: dbModule?.markRoomAgentDeliveryConnected,
  registerAgentIdentity: dbModule?.registerAgentIdentity,
  updateTask: dbModule?.updateTask,
  upsertAccount: dbModule?.upsertAccount,
  verifyBoardIntentApproval: dbModule?.verifyBoardIntentApproval,
};

export const databaseTestOptions = {
  concurrency: false,
  skip: requiresDatabase ? databaseSkipReason : false,
};

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  if (!pool) {
    throw new Error(`DB-backed coordination tests require ${databaseSkipReason}`);
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
    throw new Error(`DB-backed coordination tests require ${databaseSkipReason}`);
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
