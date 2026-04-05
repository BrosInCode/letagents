import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { buildTaskWorkflowArtifactMatches } from "../repo-workflow.js";

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
const findTaskByWorkflowArtifactMatches = dbModule?.findTaskByWorkflowArtifactMatches;
const updateTask = dbModule?.updateTask;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  if (!pool) {
    throw new Error("DB-backed workflow lookup tests require TEST_DB_URL or DB_URL");
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
    throw new Error("DB-backed workflow lookup tests require TEST_DB_URL or DB_URL");
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
  "findTaskByWorkflowArtifactMatches resolves persisted issue, pull request, and check run artifacts",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL or DB_URL to run DB-backed workflow lookup tests" : false,
  },
  async () => {
    if (!createProjectWithName || !createTask || !updateTask || !findTaskByWorkflowArtifactMatches) {
      throw new Error("DB-backed workflow lookup tests require TEST_DB_URL or DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(
      room.id,
      "Resolve provider events from persisted artifacts",
      "OakGranite"
    );

    await updateTask(room.id, task.id, {
      workflow_artifacts: [
        {
          provider: "github",
          kind: "issue",
          number: 45,
          url: "https://github.com/BrosInCode/letagents/issues/45",
        },
        {
          provider: "github",
          kind: "pull_request",
          number: 123,
          url: "https://github.com/BrosInCode/letagents/pull/123",
        },
        {
          provider: "github",
          kind: "check_run",
          id: "9001",
          title: "ci / build",
          url: "https://github.com/BrosInCode/letagents/actions/runs/9001",
        },
      ],
    });

    assert.equal(
      (
        await findTaskByWorkflowArtifactMatches(
          room.id,
          buildTaskWorkflowArtifactMatches({
            provider: "github",
            kind: "issue",
            url: "https://github.com/BrosInCode/letagents/issues/45",
            number: 45,
          })
        )
      )?.id,
      task.id
    );

    assert.equal(
      (
        await findTaskByWorkflowArtifactMatches(
          room.id,
          buildTaskWorkflowArtifactMatches({
            provider: "github",
            kind: "pull_request",
            url: "https://github.com/BrosInCode/letagents/pull/123",
            number: 123,
          })
        )
      )?.id,
      task.id
    );

    assert.equal(
      (
        await findTaskByWorkflowArtifactMatches(
          room.id,
          buildTaskWorkflowArtifactMatches({
            provider: "github",
            kind: "check_run",
            id: "9001",
            title: "ci / build",
            url: "https://github.com/BrosInCode/letagents/actions/runs/9001",
          })
        )
      )?.id,
      task.id
    );
  }
);
