import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
export const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
}

type DbClientModule = typeof import("../../db/client.js");
type DbModule = typeof import("../../db.js");

const dbClientModule: DbClientModule | null = testDatabaseUrl ? await import("../../db/client.js") : null;
const dbModule: DbModule | null = testDatabaseUrl ? await import("../../db.js") : null;

const db = dbClientModule?.db;
export const pool = dbClientModule?.pool;

export type WebhookDbHelpers = Pick<
  DbModule,
  | "createProjectWithName"
  | "createTask"
  | "getTasks"
  | "getMessages"
  | "getTaskById"
  | "updateTask"
  | "createTaskLease"
  | "createFocusRoomForTask"
  | "updateFocusRoomSettings"
  | "getGitHubRoomEvents"
>;

const dbHelpers: WebhookDbHelpers | null = dbModule
  ? {
      createProjectWithName: dbModule.createProjectWithName,
      createTask: dbModule.createTask,
      getTasks: dbModule.getTasks,
      getMessages: dbModule.getMessages,
      getTaskById: dbModule.getTaskById,
      updateTask: dbModule.updateTask,
      createTaskLease: dbModule.createTaskLease,
      createFocusRoomForTask: dbModule.createFocusRoomForTask,
      updateFocusRoomSettings: dbModule.updateFocusRoomSettings,
      getGitHubRoomEvents: dbModule.getGitHubRoomEvents,
    }
  : null;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");
const webhookSecret = "test-webhook-secret";
const tsxBinary = path.resolve(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx"
);

export function requireWebhookDbHelpers(): WebhookDbHelpers {
  if (!dbHelpers) {
    throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
  }

  return dbHelpers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  if (!pool) {
    throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
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

export async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
  }

  await waitForDatabaseReady();
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder });
}

function formatServerDiagnostics(input: {
  stdout: string;
  stderr: string;
  readinessError?: string;
}): string {
  const diagnostics = [
    input.readinessError ? `last readiness error: ${input.readinessError}` : "",
    input.stdout ? `stdout:\n${input.stdout}` : "",
    input.stderr ? `stderr:\n${input.stderr}` : "",
  ].filter(Boolean);

  return diagnostics.length > 0 ? `\n${diagnostics.join("\n")}` : "";
}

async function waitForServer(
  port: number,
  child: ChildProcess,
  diagnostics: () => { stdout: string; stderr: string }
): Promise<void> {
  let lastReadinessError: string | undefined;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `webhook test server exited early with code ${child.exitCode ?? "null"} signal ${child.signalCode ?? "null"}` +
          formatServerDiagnostics(diagnostics())
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        return;
      }
      lastReadinessError = `health returned ${response.status}`;
    } catch (error) {
      lastReadinessError = error instanceof Error ? error.message : String(error);
    }

    await sleep(250);
  }

  throw new Error(
    "webhook test server did not become ready" +
      formatServerDiagnostics({
        ...diagnostics(),
        readinessError: lastReadinessError,
      })
  );
}

export async function startServer(): Promise<{ child: ChildProcess; port: number }> {
  if (!testDatabaseUrl) {
    throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
  }

  const port = 3400 + Math.floor(Math.random() * 500);
  let stdout = "";
  let stderr = "";

  const child = spawn(tsxBinary, ["src/api/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_URL: testDatabaseUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
      GITHUB_WEBHOOK_SECRET: webhookSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(port, child, () => ({ stdout, stderr }));
  } catch (error) {
    await stopServer(child);
    throw error;
  }

  return { child, port };
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) {
    return true;
  }

  return Promise.race([
    once(child, "exit").then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
}

export async function stopServer(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) {
    return;
  }

  child.kill("SIGTERM");
  const exitedAfterSigterm = await waitForChildExit(child, 5000);

  if (!exitedAfterSigterm && !childHasExited(child)) {
    child.kill("SIGKILL");
    await waitForChildExit(child, 5000);
  }
}

function createWebhookSignature(rawBody: string): string {
  return `sha256=${crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
}

export async function postGitHubWebhook(input: {
  port: number;
  deliveryId: string;
  eventName: string;
  payload: Record<string, unknown>;
}): Promise<{ ok: boolean; status: string }> {
  const rawBody = JSON.stringify(input.payload);
  const response = await fetch(`http://127.0.0.1:${input.port}/webhooks/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": input.deliveryId,
      "X-GitHub-Event": input.eventName,
      "X-Hub-Signature-256": createWebhookSignature(rawBody),
    },
    body: rawBody,
  });

  const body = await response.json();
  assert.equal(response.status, 202);
  return body;
}

export function buildRepositoryPayload() {
  return {
    id: 4242,
    full_name: "BrosInCode/letagents",
    name: "letagents",
    owner: {
      login: "BrosInCode",
    },
  };
}

export async function createWorkLeaseForPr(input: {
  roomId: string;
  taskId: string;
  prUrl?: string | null;
  branchRef?: string;
}) {
  const { createTaskLease } = requireWebhookDbHelpers();

  return createTaskLease({
    room_id: input.roomId,
    task_id: input.taskId,
    kind: "work",
    agent_key: "EmmyMay/olivewolf",
    actor_label: "OliveWolf | EmmyMay's agent | Agent",
    created_by: "test",
    pr_url: input.prUrl ?? null,
    branch_ref: input.branchRef ?? null,
  });
}
