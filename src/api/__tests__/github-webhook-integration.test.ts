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
const getTasks = dbModule?.getTasks;
const getMessages = dbModule?.getMessages;
const getTaskById = dbModule?.getTaskById;
const updateTask = dbModule?.updateTask;
const createTaskLease = dbModule?.createTaskLease;
const createFocusRoomForTask = dbModule?.createFocusRoomForTask;
const updateFocusRoomSettings = dbModule?.updateFocusRoomSettings;
const getGitHubRoomEvents = dbModule?.getGitHubRoomEvents;

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
  child: ChildProcessWithoutNullStreams,
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
      // keep polling until ready
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

async function startServer(): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
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

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) {
    return true;
  }

  return Promise.race([
    once(child, "exit").then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
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

async function createWorkLeaseForPr(input: {
  roomId: string;
  taskId: string;
  prUrl?: string | null;
  branchRef?: string;
}) {
  if (!createTaskLease) {
    throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
  }

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
  "failed check_run auto-creates and reopens a deduplicated CI task through the real webhook route",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (!createProjectWithName || !getMessages || !getTaskById || !getTasks || !updateTask) {
      throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
    }

    const { child, port } = await startServer();
    t.after(async () => {
      await stopServer(child);
    });

    const room = await createProjectWithName("github.com/brosincode/letagents");

    const firstResult = await postGitHubWebhook({
      port,
      deliveryId: "delivery-check-run-failure-1",
      eventName: "check_run",
      payload: {
        action: "completed",
        repository: buildRepositoryPayload(),
        sender: { login: "github-actions[bot]" },
        check_run: {
          id: 901,
          name: "ci / build",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/BrosInCode/letagents/actions/runs/901",
          app: { name: "GitHub Actions" },
          check_suite: { id: 77 },
        },
      },
    });

    assert.equal(firstResult.status, "processed");

    const firstTaskList = await getTasks(room.id);
    assert.equal(firstTaskList.tasks.length, 1);
    const [createdTask] = firstTaskList.tasks;
    assert.equal(createdTask?.title, "Fix CI: ci / build");
    assert.equal(createdTask?.status, "accepted");
    assert.equal(createdTask?.created_by, "letagents");
    assert.deepEqual(createdTask?.workflow_artifacts, [
      {
        provider: "github",
        kind: "check_run",
        number: 77,
        title: "ci / build",
        state: "failure",
      },
      {
        provider: "github",
        kind: "check_run",
        id: "901",
        title: "ci / build",
        url: "https://github.com/BrosInCode/letagents/actions/runs/901",
        state: "failure",
      },
    ]);

    const firstMessages = (await getMessages(room.id)).messages;
    assert.ok(firstMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes(createdTask.id) &&
      message.text.includes("accepted")
    ));
    assert.ok(firstMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes(createdTask.id) &&
      message.text.includes("ci / build")
    ));

    await updateTask(room.id, createdTask.id, { status: "assigned", assignee: "OliveWolf" });
    await updateTask(room.id, createdTask.id, { status: "in_progress" });
    await updateTask(room.id, createdTask.id, { status: "done" });

    const secondResult = await postGitHubWebhook({
      port,
      deliveryId: "delivery-check-run-failure-2",
      eventName: "check_run",
      payload: {
        action: "completed",
        repository: buildRepositoryPayload(),
        sender: { login: "github-actions[bot]" },
        check_run: {
          id: 902,
          name: "ci / build",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/BrosInCode/letagents/actions/runs/902",
          app: { name: "GitHub Actions" },
          check_suite: { id: 77 },
        },
      },
    });

    assert.equal(secondResult.status, "processed");

    const secondTaskList = await getTasks(room.id);
    assert.equal(secondTaskList.tasks.length, 1);

    const reopenedTask = await getTaskById(room.id, createdTask.id);
    assert.equal(reopenedTask?.status, "accepted");
    assert.equal(reopenedTask?.assignee, null);
    assert.ok(reopenedTask?.workflow_artifacts.some((artifact) =>
      artifact.kind === "check_run" && artifact.number === 77
    ));
    assert.ok(reopenedTask?.workflow_artifacts.some((artifact) =>
      artifact.kind === "check_run" &&
      artifact.id === "902" &&
      artifact.url === "https://github.com/BrosInCode/letagents/actions/runs/902"
    ));

    const finalMessages = (await getMessages(room.id)).messages;
    assert.ok(finalMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes(createdTask.id) &&
      message.text.includes("accepted")
    ));
  }
);

test(
  "pull_request opened transitions an assigned task to in_review through the real webhook route",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (!createProjectWithName || !createTask || !getMessages || !getTaskById || !updateTask || !createTaskLease) {
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
    await createWorkLeaseForPr({
      roomId: room.id,
      taskId: task.id,
      prUrl: pullRequestUrl,
      branchRef: "olive/webhook-coverage",
    });
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
          head: {
            ref: "olive/webhook-coverage",
            sha: "abc123",
          },
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
  "pull_request opened for a focused task is announced in the focus room with parent linkbacks",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (
      !createProjectWithName ||
      !createTask ||
      !getMessages ||
      !getTaskById ||
      !updateTask ||
      !createTaskLease ||
      !createFocusRoomForTask ||
      !updateFocusRoomSettings
    ) {
      throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
    }

    const { child, port } = await startServer();
    t.after(async () => {
      await stopServer(child);
    });

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(room.id, "Focused webhook coverage", "OliveWolf");
    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, { status: "assigned" });
    const focus = await createFocusRoomForTask(room.id, task.id);
    assert.ok(focus);
    await updateFocusRoomSettings(room.id, task.id, {
      parent_visibility: "major_activity",
    });

    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/202";
    await createWorkLeaseForPr({
      roomId: room.id,
      taskId: task.id,
      prUrl: pullRequestUrl,
      branchRef: "olive/focused-webhook-coverage",
    });
    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-focused",
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: buildRepositoryPayload(),
        sender: { login: "octocat" },
        pull_request: {
          number: 202,
          title: `${task.id}: focused webhook integration coverage`,
          body: "covers the focus room routing path",
          html_url: pullRequestUrl,
          head: {
            ref: "olive/focused-webhook-coverage",
            sha: "abc202",
          },
          merged: false,
          user: { login: "octocat" },
        },
      },
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "in_review");
    assert.equal(updatedTask?.pr_url, pullRequestUrl);

    const parentMessages = (await getMessages(room.id)).messages;
    const focusMessages = (await getMessages(focus.room.id)).messages;
    const focusLifecycleMessage = focusMessages.find((message) =>
      message.sender === "letagents" &&
      message.text.includes(`${task.id}`) &&
      message.text.includes("in review")
    );
    assert.ok(focusLifecycleMessage);
    assert.equal(focusLifecycleMessage?.agent_prompt_kind, "auto");
    assert.ok(focusMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #202 opened by octocat") &&
      message.text.includes(task.id)
    ));
    assert.ok(parentMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes("Task status") &&
      message.text.includes("Focus Room") &&
      message.text.includes(task.id)
    ));
    assert.ok(parentMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes("GitHub activity") &&
      message.text.includes("Focus Room") &&
      message.text.includes(task.id)
    ));
    assert.equal(parentMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #202 opened by octocat")
    ), false);
  }
);

test(
  "task-only GitHub routing keeps artifact-only pull requests out of the focus room",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (
      !createProjectWithName ||
      !createTask ||
      !getMessages ||
      !getTaskById ||
      !updateTask ||
      !createTaskLease ||
      !createFocusRoomForTask ||
      !updateFocusRoomSettings
    ) {
      throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
    }

    const { child, port } = await startServer();
    t.after(async () => {
      await stopServer(child);
    });

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/203";
    const task = await createTask(room.id, "Focused artifact-only webhook", "OliveWolf");
    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, { status: "assigned", pr_url: pullRequestUrl });
    const focus = await createFocusRoomForTask(room.id, task.id);
    assert.ok(focus);
    await updateFocusRoomSettings(room.id, task.id, {
      parent_visibility: "major_activity",
      github_event_routing: "task_only",
    });

    await createWorkLeaseForPr({
      roomId: room.id,
      taskId: task.id,
      prUrl: pullRequestUrl,
      branchRef: "olive/artifact-only-webhook",
    });
    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-focused-task-only",
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: buildRepositoryPayload(),
        sender: { login: "octocat" },
        pull_request: {
          number: 203,
          title: "artifact-only focus routing",
          body: "no explicit task reference",
          html_url: pullRequestUrl,
          head: {
            ref: "olive/artifact-only-webhook",
            sha: "abc203",
          },
          merged: false,
          user: { login: "octocat" },
        },
      },
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "in_review");

    const parentMessages = (await getMessages(room.id)).messages;
    const focusMessages = (await getMessages(focus.room.id)).messages;
    assert.ok(parentMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #203 opened by octocat")
    ));
    assert.equal(focusMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #203 opened by octocat")
    ), false);
  }
);

test(
  "hard-isolated focus routing keeps focus-owned pull request events out of the parent room",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (
      !createProjectWithName ||
      !createTask ||
      !getMessages ||
      !getTaskById ||
      !updateTask ||
      !createTaskLease ||
      !createFocusRoomForTask ||
      !updateFocusRoomSettings ||
      !getGitHubRoomEvents
    ) {
      throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
    }

    const { child, port } = await startServer();
    t.after(async () => {
      await stopServer(child);
    });

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(room.id, "Hard-isolated focus webhook", "OliveWolf");
    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, { status: "assigned" });
    const focus = await createFocusRoomForTask(room.id, task.id);
    assert.ok(focus);
    await updateFocusRoomSettings(room.id, task.id, {
      parent_visibility: "major_activity",
      github_event_routing: "focus_owned_only",
    });

    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/204";
    await createWorkLeaseForPr({
      roomId: room.id,
      taskId: task.id,
      prUrl: pullRequestUrl,
      branchRef: "olive/hard-isolated-focus",
    });
    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-hard-isolated-focus",
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: buildRepositoryPayload(),
        sender: { login: "octocat" },
        pull_request: {
          number: 204,
          title: `${task.id}: hard-isolated focus webhook coverage`,
          body: "covers parent suppression for focus-owned workflow events",
          html_url: pullRequestUrl,
          head: {
            ref: "olive/hard-isolated-focus",
            sha: "abc204",
          },
          merged: false,
          user: { login: "octocat" },
        },
      },
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "in_review");
    assert.equal(updatedTask?.pr_url, pullRequestUrl);

    const parentMessages = (await getMessages(room.id)).messages;
    const focusMessages = (await getMessages(focus.room.id)).messages;
    assert.ok(focusMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes(`${task.id}`) &&
      message.text.includes("in review")
    ));
    assert.ok(focusMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #204 opened by octocat") &&
      message.text.includes(task.id)
    ));
    assert.equal(parentMessages.some((message) =>
      message.text.includes(task.id) &&
      (
        message.text.includes("Task status") ||
        message.text.includes("GitHub activity") ||
        message.text.includes("PR #204 opened by octocat")
      )
    ), false);

    const parentEvents = await getGitHubRoomEvents({ room_id: room.id, event_type: "pull_request" });
    const focusEvents = await getGitHubRoomEvents({ room_id: focus.room.id, event_type: "pull_request" });
    assert.equal(parentEvents.events.some((event) => event.github_object_id === "204"), false);
    assert.ok(focusEvents.events.some((event) =>
      event.github_object_id === "204" &&
      event.linked_task_id === task.id
    ));
  }
);

test(
  "hard-isolated focus routing resolves leases owned by the focus room itself",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (
      !createProjectWithName ||
      !createTask ||
      !getMessages ||
      !getTaskById ||
      !updateTask ||
      !createTaskLease ||
      !createFocusRoomForTask ||
      !updateFocusRoomSettings ||
      !getGitHubRoomEvents
    ) {
      throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
    }

    const { child, port } = await startServer();
    t.after(async () => {
      await stopServer(child);
    });

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const parentTask = await createTask(room.id, "Open focus lane", "OliveWolf");
    await updateTask(room.id, parentTask.id, { status: "accepted" });
    await updateTask(room.id, parentTask.id, { status: "assigned" });
    const focus = await createFocusRoomForTask(room.id, parentTask.id);
    assert.ok(focus);
    await updateFocusRoomSettings(room.id, parentTask.id, {
      parent_visibility: "major_activity",
      github_event_routing: "focus_owned_only",
    });

    const focusTask = await createTask(focus.room.id, "Focus-owned implementation", "OliveWolf");
    await updateTask(focus.room.id, focusTask.id, { status: "accepted" });
    await updateTask(focus.room.id, focusTask.id, { status: "assigned" });

    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/205";
    await createWorkLeaseForPr({
      roomId: focus.room.id,
      taskId: focusTask.id,
      prUrl: null,
      branchRef: "olive/focus-owned-branch",
    });

    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-focus-owned-lease",
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: buildRepositoryPayload(),
        sender: { login: "octocat" },
        pull_request: {
          number: 205,
          title: "focus-owned branch without task mention",
          body: "covers focus room owned lease routing",
          html_url: pullRequestUrl,
          head: {
            ref: "olive/focus-owned-branch",
            sha: "abc205",
          },
          merged: false,
          user: { login: "octocat" },
        },
      },
    });

    assert.equal(result.status, "processed");

    const updatedFocusTask = await getTaskById(focus.room.id, focusTask.id);
    assert.equal(updatedFocusTask?.status, "in_review");
    assert.equal(updatedFocusTask?.pr_url, pullRequestUrl);

    const parentMessages = (await getMessages(room.id)).messages;
    const focusMessages = (await getMessages(focus.room.id)).messages;
    assert.equal(parentMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #205 opened by octocat")
    ), false);
    assert.ok(focusMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #205 opened by octocat") &&
      message.text.includes(focusTask.id)
    ));

    const parentEvents = await getGitHubRoomEvents({ room_id: room.id, event_type: "pull_request" });
    const focusEvents = await getGitHubRoomEvents({ room_id: focus.room.id, event_type: "pull_request" });
    assert.equal(parentEvents.events.some((event) => event.github_object_id === "205"), false);
    assert.ok(focusEvents.events.some((event) =>
      event.github_object_id === "205" &&
      event.linked_task_id === focusTask.id
    ));
  }
);

test(
  "all-parent-repo GitHub routing mirrors unlinked repo events into opted-in focus rooms",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (
      !createProjectWithName ||
      !createTask ||
      !getMessages ||
      !createFocusRoomForTask ||
      !updateFocusRoomSettings
    ) {
      throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
    }

    const { child, port } = await startServer();
    t.after(async () => {
      await stopServer(child);
    });

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(room.id, "Watch parent repo events", "OliveWolf");
    const focus = await createFocusRoomForTask(room.id, task.id);
    assert.ok(focus);
    await updateFocusRoomSettings(room.id, task.id, {
      github_event_routing: "all_parent_repo",
    });

    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-repository-renamed-focused",
      eventName: "repository",
      payload: {
        action: "renamed",
        repository: buildRepositoryPayload(),
        changes: {
          repository: {
            name: {
              from: "oldagents",
            },
          },
        },
        sender: { login: "octocat" },
      },
    });

    assert.equal(result.status, "processed");

    const parentMessages = (await getMessages(room.id)).messages;
    const focusMessages = (await getMessages(focus.room.id)).messages;
    assert.ok(parentMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("Repository renamed from BrosInCode/oldagents")
    ));
    assert.ok(focusMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("Repository renamed from BrosInCode/oldagents")
    ));
  }
);

test(
  "pull_request opened with only a task reference is recorded but not projected without a matching lease",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (!createProjectWithName || !createTask || !getMessages || !getTaskById || !updateTask || !createTaskLease) {
      throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
    }

    const { child, port } = await startServer();
    t.after(async () => {
      await stopServer(child);
    });

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const task = await createTask(room.id, "Unleased PR coverage", "OliveWolf");
    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, { status: "assigned" });

    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/299";
    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-unleased",
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: buildRepositoryPayload(),
        sender: { login: "octocat" },
        pull_request: {
          number: 299,
          title: `${task.id}: unauthorized work should not project`,
          body: "mentions the task id but has no active work lease",
          html_url: pullRequestUrl,
          head: {
            ref: "octocat/unleased-work",
            sha: "def456",
          },
          merged: false,
          user: { login: "octocat" },
        },
      },
    });

    assert.equal(result.status, "processed");

    const unchangedTask = await getTaskById(room.id, task.id);
    assert.equal(unchangedTask?.status, "assigned");
    assert.equal(unchangedTask?.pr_url, null);

    const messages = (await getMessages(room.id)).messages;
    assert.ok(messages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes("Ignored unleased GitHub pull_request projection") &&
      message.text.includes(task.id)
    ));
    const githubMessage = messages.find((message) =>
      message.sender === "github" &&
      message.text.includes("PR #299 opened by octocat")
    );
    assert.ok(githubMessage);
    assert.equal(githubMessage?.text.includes(task.id), false);
  }
);

test(
  "pull_request_review changes_requested transitions an in_review task to blocked through the real webhook route",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook integration tests" : false,
  },
  async (t) => {
    if (!createProjectWithName || !createTask || !getMessages || !getTaskById || !updateTask || !createTaskLease) {
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
    await createWorkLeaseForPr({
      roomId: room.id,
      taskId: task.id,
      prUrl: pullRequestUrl,
      branchRef: "olive/review-transition",
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
          head: {
            ref: "olive/review-transition",
            sha: "abc789",
          },
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
    if (!createProjectWithName || !createTask || !getMessages || !getTaskById || !updateTask || !createTaskLease) {
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
    await createWorkLeaseForPr({
      roomId: room.id,
      taskId: task.id,
      prUrl: pullRequestUrl,
      branchRef: "olive/merge-transition",
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
          head: {
            ref: "olive/merge-transition",
            sha: "abc999",
          },
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
