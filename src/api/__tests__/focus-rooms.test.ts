import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
const concludeFocusRoom = dbModule?.concludeFocusRoom;
const createProjectWithName = dbModule?.createProjectWithName;
const createTask = dbModule?.createTask;
const createFocusRoomForTask = dbModule?.createFocusRoomForTask;
const getFocusRoomByKey = dbModule?.getFocusRoomByKey;
const getFocusRoomsForParent = dbModule?.getFocusRoomsForParent;
const getMessages = dbModule?.getMessages;
const updateFocusRoomSettings = dbModule?.updateFocusRoomSettings;
const updateTask = dbModule?.updateTask;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");
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

async function waitForServer(
  port: number,
  child: ChildProcessWithoutNullStreams,
  stderrBuffer: () => string
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`focus room test server exited early: ${stderrBuffer()}`.trim());
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

  throw new Error(`focus room test server did not become ready: ${stderrBuffer()}`.trim());
}

async function startApiServer(): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  if (!testDatabaseUrl) {
    throw new Error("DB-backed focus room tests require TEST_DB_URL");
  }

  const port = 4100 + Math.floor(Math.random() * 500);
  let stderr = "";

  const child = spawn(tsxBinary, ["src/api/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_URL: testDatabaseUrl,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  child.stdout.resume();

  await waitForServer(port, child, () => stderr);
  return { child, port };
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
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
    assert.equal(first.room.focus_parent_visibility, "summary_only");
    assert.equal(first.room.focus_activity_scope, "task_and_branch");
    assert.equal(first.room.focus_github_event_routing, "task_and_branch");
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
  "updateFocusRoomSettings persists focus visibility controls",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed focus room tests" : false,
  },
  async () => {
    if (!createProjectWithName || !createTask || !createFocusRoomForTask || !updateFocusRoomSettings) {
      throw new Error("DB-backed focus room tests require TEST_DB_URL");
    }

    const parent = await createProjectWithName("focus-settings-db");
    const task = await createTask(parent.id, "Tune Focus Room settings", "ThicketOlive");
    const focus = await createFocusRoomForTask(parent.id, task.id);
    assert.ok(focus);

    const updated = await updateFocusRoomSettings(parent.id, task.id, {
      parent_visibility: "major_activity",
      activity_scope: "task_only",
      github_event_routing: "off",
    });

    assert.equal(updated?.focus_parent_visibility, "major_activity");
    assert.equal(updated?.focus_activity_scope, "task_only");
    assert.equal(updated?.focus_github_event_routing, "off");
  }
);

test(
  "concludeFocusRoom persists summary and is idempotent",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed focus room tests" : false,
  },
  async () => {
    if (!createProjectWithName || !createTask || !createFocusRoomForTask || !concludeFocusRoom || !getFocusRoomByKey) {
      throw new Error("DB-backed focus room tests require TEST_DB_URL");
    }

    const parent = await createProjectWithName("focus-results-db");
    const task = await createTask(parent.id, "Share Focus Room results", "FoxSage");
    const focus = await createFocusRoomForTask(parent.id, task.id);
    assert.ok(focus);

    const concluded = await concludeFocusRoom(parent.id, task.id, "Result summary");
    assert.ok(concluded);
    assert.equal(concluded.updated, true);
    assert.equal(concluded.task?.id, task.id);
    assert.equal(concluded.room.focus_status, "concluded");
    assert.equal(concluded.room.conclusion_summary, "Result summary");
    assert.ok(concluded.room.concluded_at);

    const stored = await getFocusRoomByKey(parent.id, task.id);
    assert.equal(stored?.focus_status, "concluded");
    assert.equal(stored?.conclusion_summary, "Result summary");

    const repeated = await concludeFocusRoom(parent.id, task.id, "Different summary");
    assert.ok(repeated);
    assert.equal(repeated.updated, false);
    assert.equal(repeated.room.conclusion_summary, "Result summary");
  }
);

test(
  "focus room conclude route emits one parent result message",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed focus room tests" : false,
  },
  async (t) => {
    if (!createProjectWithName || !createTask || !createFocusRoomForTask || !getMessages) {
      throw new Error("DB-backed focus room tests require TEST_DB_URL");
    }

    const parent = await createProjectWithName("focus-results-api");
    const task = await createTask(parent.id, "Share Focus Room results", "FoxSage");
    const focus = await createFocusRoomForTask(parent.id, task.id);
    assert.ok(focus);

    const { child, port } = await startApiServer();
    t.after(async () => {
      await stopChildProcess(child);
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/rooms/${encodeURIComponent(parent.id)}/focus/${encodeURIComponent(task.id)}/conclude`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Result summary" }),
      }
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.shared, true);
    assert.equal(payload.focus_room.focus_status, "concluded");
    assert.equal(payload.focus_room.conclusion_summary, "Result summary");
    assert.equal(payload.message.text, `[status] Focus Room concluded for ${task.id}: ${task.title}. Result: Result summary`);

    const messages = (await getMessages(parent.id)).messages;
    assert.equal(
      messages.filter((message) => message.text.includes("Focus Room concluded")).length,
      1
    );

    const repeated = await fetch(
      `http://127.0.0.1:${port}/rooms/${encodeURIComponent(parent.id)}/focus/${encodeURIComponent(task.id)}/conclude`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Result summary again" }),
      }
    );

    assert.equal(repeated.status, 200);
    const repeatedPayload = await repeated.json();
    assert.equal(repeatedPayload.shared, false);
    assert.equal(repeatedPayload.message, null);

    const messagesAfterRepeat = (await getMessages(parent.id)).messages;
    assert.equal(
      messagesAfterRepeat.filter((message) => message.text.includes("Focus Room concluded")).length,
      1
    );
  }
);

test(
  "ad-hoc focus room route opens a room from an intent title",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed focus room tests" : false,
  },
  async (t) => {
    if (!createProjectWithName || !getFocusRoomByKey || !getMessages) {
      throw new Error("DB-backed focus room tests require TEST_DB_URL");
    }

    const parent = await createProjectWithName("focus-adhoc-route-api");

    const { child, port } = await startApiServer();
    t.after(async () => {
      await stopChildProcess(child);
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/rooms/${encodeURIComponent(parent.id)}/focus-rooms`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Investigate branch room flow" }),
      }
    );

    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.room_id, parent.id);
    assert.equal(payload.created, true);
    assert.equal(payload.focus_room.kind, "focus");
    assert.equal(payload.focus_room.parent_room_id, parent.id);
    assert.equal(payload.focus_room.source_task_id, null);
    assert.equal(payload.focus_room.display_name, "Focus: Investigate branch room flow");
    assert.match(payload.focus_room.focus_key, /^focus-investigate-branch-room-flow-[a-f0-9]{8}$/);

    const stored = await getFocusRoomByKey(parent.id, payload.focus_room.focus_key);
    assert.equal(stored?.id, payload.focus_room.room_id);

    const joinResponse = await fetch(
      `http://127.0.0.1:${port}/rooms/${encodeURIComponent(`${parent.id}/focus/${payload.focus_room.focus_key}`)}/join`,
      { method: "POST" }
    );
    assert.equal(joinResponse.status, 200);
    const joined = await joinResponse.json();
    assert.equal(joined.room_id, payload.focus_room.room_id);
    assert.equal(joined.kind, "focus");

    const messages = (await getMessages(parent.id)).messages;
    assert.ok(messages.some((message) =>
      message.sender === "letagents" &&
      message.text === "[status] Focus Room opened: Focus: Investigate branch room flow"
    ));
  }
);

test(
  "focus room conclude route respects silent parent visibility",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed focus room tests" : false,
  },
  async (t) => {
    if (!createProjectWithName || !createTask || !createFocusRoomForTask || !getMessages || !updateFocusRoomSettings) {
      throw new Error("DB-backed focus room tests require TEST_DB_URL");
    }

    const parent = await createProjectWithName("focus-silent-result-api");
    const task = await createTask(parent.id, "Keep result in Focus Room", "ThicketOlive");
    const focus = await createFocusRoomForTask(parent.id, task.id);
    assert.ok(focus);
    await updateFocusRoomSettings(parent.id, task.id, {
      parent_visibility: "silent",
    });

    const { child, port } = await startApiServer();
    t.after(async () => {
      await stopChildProcess(child);
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/rooms/${encodeURIComponent(parent.id)}/focus/${encodeURIComponent(task.id)}/conclude`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Private result" }),
      }
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.shared, true);
    assert.equal(payload.message, null);

    const messages = (await getMessages(parent.id)).messages;
    assert.equal(
      messages.filter((message) => message.text.includes("Focus Room concluded")).length,
      0
    );
  }
);

test(
  "parent task lifecycle status is anchored in the active focus room",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed focus room tests" : false,
  },
  async (t) => {
    if (
      !createProjectWithName ||
      !createTask ||
      !createFocusRoomForTask ||
      !getMessages ||
      !updateFocusRoomSettings ||
      !updateTask
    ) {
      throw new Error("DB-backed focus room tests require TEST_DB_URL");
    }

    const parent = await createProjectWithName("focus-lifecycle-route-api");
    const task = await createTask(parent.id, "Route task lifecycle", "StoneCloud");
    await updateTask(parent.id, task.id, { status: "accepted" });
    await updateTask(parent.id, task.id, { status: "assigned", assignee: "StoneCloud" });
    const focus = await createFocusRoomForTask(parent.id, task.id);
    assert.ok(focus);
    await updateFocusRoomSettings(parent.id, task.id, {
      parent_visibility: "major_activity",
    });

    const { child, port } = await startApiServer();
    t.after(async () => {
      await stopChildProcess(child);
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/rooms/${encodeURIComponent(parent.id)}/tasks/${encodeURIComponent(task.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      }
    );

    assert.equal(response.status, 200);

    const parentMessages = (await getMessages(parent.id)).messages;
    const focusMessages = (await getMessages(focus.room.id)).messages;
    const focusedLifecycleMessage = `StoneCloud is working on ${task.id}: Route task lifecycle`;
    assert.ok(focusMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes(focusedLifecycleMessage)
    ));
    assert.ok(parentMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes("Task status") &&
      message.text.includes("Focus Room") &&
      message.text.includes(task.id)
    ));
    assert.equal(parentMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes(focusedLifecycleMessage)
    ), false);
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
