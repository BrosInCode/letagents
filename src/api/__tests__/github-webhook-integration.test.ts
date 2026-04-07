import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
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
const getMessages = dbModule?.getMessages;
const getTaskById = dbModule?.getTaskById;
const updateTask = dbModule?.updateTask;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");
const webhookSecret = "test-webhook-secret";
const tsxBinary = path.resolve(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx"
);

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

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
  }

  await waitForDatabaseReady();
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder });
}

async function waitForServer(port: number, child: ChildProcessWithoutNullStreams, stderrBuffer: () => string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`webhook test server exited early: ${stderrBuffer()}`.trim());
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling until ready
    }

    await sleep(250);
  }

  throw new Error(`webhook test server did not become ready: ${stderrBuffer()}`.trim());
}

async function startServer(): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  if (!testDatabaseUrl) {
    throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
  }

  const port = 3400 + Math.floor(Math.random() * 500);
  let stderr = "";

  const child = spawn(tsxBinary, ["src/api/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_URL: testDatabaseUrl,
      PORT: String(port),
      GITHUB_WEBHOOK_SECRET: webhookSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  await waitForServer(port, child, () => stderr);
  return { child, port };
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    sleep(5000),
  ]);

  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function createWebhookSignature(rawBody: string): string {
  return `sha256=${crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
}

async function postGitHubWebhook(input: {
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

function buildRepositoryPayload() {
  return {
    id: 4242,
    full_name: "BrosInCode/letagents",
    name: "letagents",
    owner: {
      login: "BrosInCode",
    },
  };
}

test.beforeEach(async () => {
  if (!requiresDatabase) {
    await resetDatabase();
  }
});

if (!requiresDatabase) {
  test.after(async () => {
    await pool?.end();
  });
}

test(
  "pull_request opened transitions an assigned task to in_review through the real webhook route",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (!createProjectWithName || !createTask || !getMessages || !getTaskById || !updateTask) {
      throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
    }

    const { child, port } = await startServer();
    t.after(async () => {
      await stopServer(child);
    });

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(room.id, "Webhook coverage", "OliveWolf");
    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, { status: "assigned" });

    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/201";
    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened",
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: buildRepositoryPayload(),
        sender: { login: "octocat" },
        pull_request: {
          number: 201,
          title: `${task.id}: add webhook integration coverage`,
          body: "covers the end-to-end route",
          html_url: pullRequestUrl,
          merged: false,
          user: { login: "octocat" },
        },
      },
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "in_review");
    assert.equal(updatedTask?.pr_url, pullRequestUrl);

    const messages = (await getMessages(room.id)).messages;
    const lifecycleMessage = messages.find((message) =>
      message.sender === "letagents" &&
      message.text.includes(`${task.id}`) &&
      message.text.includes("in review")
    );
    assert.ok(lifecycleMessage);
    assert.equal(lifecycleMessage?.agent_prompt_kind, "auto");
    assert.ok(messages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #201 opened by octocat") &&
      message.text.includes(task.id)
    ));
  }
);

test(
  "pull_request_review changes_requested transitions an in_review task to blocked through the real webhook route",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (!createProjectWithName || !createTask || !getMessages || !getTaskById || !updateTask) {
      throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
    }

    const { child, port } = await startServer();
    t.after(async () => {
      await stopServer(child);
    });

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(room.id, "Review transition coverage", "OliveWolf");
    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/202";
    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, { status: "assigned" });
    await updateTask(room.id, task.id, { status: "in_progress" });
    await updateTask(room.id, task.id, {
      status: "in_review",
      pr_url: pullRequestUrl,
    });

    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-review",
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        repository: buildRepositoryPayload(),
        sender: { login: "reviewer" },
        pull_request: {
          number: 202,
          title: `${task.id}: review integration coverage`,
          body: "exercise real review transitions",
          html_url: pullRequestUrl,
        },
        review: {
          id: 88,
          state: "changes_requested",
          html_url: `${pullRequestUrl}#pullrequestreview-88`,
        },
      },
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "blocked");

    const messages = (await getMessages(room.id)).messages;
    const lifecycleMessage = messages.find((message) =>
      message.sender === "letagents" &&
      message.text.includes(`${task.id}`) &&
      message.text.includes("blocked")
    );
    assert.ok(lifecycleMessage);
    assert.equal(lifecycleMessage?.agent_prompt_kind, "auto");
    assert.ok(messages.some((message) =>
      message.sender === "github" &&
      message.text.includes("reviewer requested changes on PR #202") &&
      message.text.includes(task.id)
    ));
  }
);

test(
  "pull_request merged transitions an in_review task to merged through the real webhook route",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (!createProjectWithName || !createTask || !getMessages || !getTaskById || !updateTask) {
      throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
    }

    const { child, port } = await startServer();
    t.after(async () => {
      await stopServer(child);
    });

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(room.id, "Merge transition coverage", "OliveWolf");
    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/203";
    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, { status: "assigned" });
    await updateTask(room.id, task.id, { status: "in_progress" });
    await updateTask(room.id, task.id, {
      status: "in_review",
      pr_url: pullRequestUrl,
    });

    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-merged",
      eventName: "pull_request",
      payload: {
        action: "closed",
        repository: buildRepositoryPayload(),
        sender: { login: "octomerger" },
        pull_request: {
          number: 203,
          title: `${task.id}: merge integration coverage`,
          body: "exercise real merge transitions",
          html_url: pullRequestUrl,
          merged: true,
          merged_by: { login: "octomerger" },
          user: { login: "octocat" },
        },
      },
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "merged");
    assert.equal(updatedTask?.pr_url, pullRequestUrl);

    const messages = (await getMessages(room.id)).messages;
    const lifecycleMessage = messages.find((message) =>
      message.sender === "letagents" &&
      message.text.includes(`${task.id}`) &&
      message.text.includes("was merged")
    );
    assert.ok(lifecycleMessage);
    assert.equal(lifecycleMessage?.agent_prompt_kind, null);
    assert.ok(messages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #203 was merged by octomerger") &&
      message.text.includes(task.id)
    ));
  }
);
