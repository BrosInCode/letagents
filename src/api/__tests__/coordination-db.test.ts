import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
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
const createOwnerToken = dbModule?.createOwnerToken;
const createProjectWithName = dbModule?.createProjectWithName;
const createTask = dbModule?.createTask;
const createTaskLease = dbModule?.createTaskLease;
const createTaskLock = dbModule?.createTaskLock;
const getActiveTaskLeases = dbModule?.getActiveTaskLeases;
const registerAgentIdentity = dbModule?.registerAgentIdentity;
const updateTask = dbModule?.updateTask;
const upsertAccount = dbModule?.upsertAccount;

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

async function waitForServer(
  port: number,
  child: ChildProcessWithoutNullStreams,
  stderrBuffer: () => string
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`coordination test server exited early: ${stderrBuffer()}`.trim());
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

  throw new Error(`coordination test server did not become ready: ${stderrBuffer()}`.trim());
}

async function startApiServer(): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  if (!testDatabaseUrl) {
    throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
  }

  const port = 4100 + Math.floor(Math.random() * 500);
  let stderr = "";

  const child = spawn(tsxBinary, ["src/api/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_URL: testDatabaseUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  await waitForServer(port, child, () => stderr);
  return { child, port };
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(5000)]);

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

test(
  "owner-token task mutations require the active coordination lease before publication",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL or DB_URL to run DB-backed coordination tests" : false,
  },
  async (t) => {
    if (
      !createOwnerToken ||
      !createProjectWithName ||
      !createTask ||
      !createTaskLock ||
      !getActiveTaskLeases ||
      !registerAgentIdentity ||
      !updateTask ||
      !upsertAccount
    ) {
      throw new Error("DB-backed coordination tests require TEST_DB_URL or DB_URL");
    }

    const owner = await upsertAccount({
      provider: "github",
      provider_user_id: "42",
      login: "EmmyMay",
      display_name: "Emmy May",
    });
    const ownerToken = "coordination-route-owner-token";
    await createOwnerToken({
      accountId: owner.id,
      githubUserId: owner.provider_user_id,
      token: ownerToken,
      providerAccessToken: "github-token",
    });
    const otherOwner = await upsertAccount({
      provider: "github",
      provider_user_id: "84",
      login: "OtherOwner",
      display_name: "Other Owner",
    });
    const otherOwnerToken = "coordination-route-other-owner-token";
    await createOwnerToken({
      accountId: otherOwner.id,
      githubUserId: otherOwner.provider_user_id,
      token: otherOwnerToken,
      providerAccessToken: "other-github-token",
    });
    await registerAgentIdentity({
      owner_account_id: owner.id,
      owner_login: owner.login,
      owner_label: owner.display_name ?? owner.login,
      name: "bayotter",
      display_name: "BayOtter",
    });
    await registerAgentIdentity({
      owner_account_id: owner.id,
      owner_login: owner.login,
      owner_label: owner.display_name ?? owner.login,
      name: "dawnwinter",
      display_name: "DawnWinter",
    });

    const room = await createProjectWithName("coordination-api-routes");
    const task = await createTask(room.id, "Publish only with the work lease", "Human");
    await updateTask(room.id, task.id, { status: "accepted" });

    const { child, port } = await startApiServer();
    t.after(async () => {
      await stopChildProcess(child);
    });

    const patchTask = (
      taskId: string,
      body: Record<string, unknown>,
      token = ownerToken
    ) =>
      fetch(
        `http://127.0.0.1:${port}/rooms/${encodeURIComponent(room.id)}/tasks/${encodeURIComponent(taskId)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        }
      );

    const bayActor = {
      actor_label: "BayOtter | Emmy May's agent | Agent",
      actor_key: "EmmyMay/bayotter",
      actor_instance_id: "instance:bayotter-1",
    };
    const dawnActor = {
      actor_label: "DawnWinter | Emmy May's agent | Agent",
      actor_key: "EmmyMay/dawnwinter",
      actor_instance_id: "instance:dawn-1",
    };

    const claim = await patchTask(task.id, {
      status: "assigned",
      assignee: bayActor.actor_label,
      assignee_agent_key: bayActor.actor_key,
      ...bayActor,
    });
    assert.equal(claim.status, 200);

    const activeLeases = await getActiveTaskLeases(room.id, task.id);
    assert.equal(activeLeases.length, 1);
    assert.equal(activeLeases[0]?.agent_key, bayActor.actor_key);
    assert.equal(activeLeases[0]?.output_intent, task.title);

    const spoofedPublish = await patchTask(
      task.id,
      {
        pr_url: "https://github.com/BrosInCode/letagents/pull/998",
        ...bayActor,
      },
      otherOwnerToken
    );
    assert.equal(spoofedPublish.status, 409);
    assert.equal((await spoofedPublish.json()).code, "coordination_invalid_actor");

    const duplicateAdmission = await fetch(
      `http://127.0.0.1:${port}/rooms/${encodeURIComponent(room.id)}/tasks`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          title: task.title,
          created_by: dawnActor.actor_label,
          ...dawnActor,
        }),
      }
    );
    assert.equal(duplicateAdmission.status, 409);
    assert.equal((await duplicateAdmission.json()).code, "coordination_duplicate_work");

    const dawnPublish = await patchTask(task.id, {
      pr_url: "https://github.com/BrosInCode/letagents/pull/999",
      ...dawnActor,
    });
    assert.equal(dawnPublish.status, 409);
    assert.equal((await dawnPublish.json()).code, "coordination_wrong_actor");

    const unclaimedTask = await createTask(room.id, "Leaseless publication is blocked", "Human");
    await updateTask(room.id, unclaimedTask.id, { status: "accepted" });

    const leaselessPublish = await patchTask(unclaimedTask.id, {
      pr_url: "https://github.com/BrosInCode/letagents/pull/1000",
      ...dawnActor,
    });
    assert.equal(leaselessPublish.status, 409);
    assert.equal((await leaselessPublish.json()).code, "coordination_missing_lease");

    await createTaskLock({
      room_id: room.id,
      task_id: task.id,
      scope: "task",
      reason: "human_stop",
      created_by: "Human",
      message: "Human asked the worker to stop.",
    });

    const lockedMove = await patchTask(task.id, {
      status: "in_progress",
      ...bayActor,
    });
    assert.equal(lockedMove.status, 409);
    assert.equal((await lockedMove.json()).code, "coordination_active_lock");

    await createTaskLock({
      room_id: room.id,
      scope: "room",
      reason: "manager_pause",
      created_by: "Human",
      message: "Pause all agent task admission.",
    });

    const blockedAdmission = await fetch(
      `http://127.0.0.1:${port}/rooms/${encodeURIComponent(room.id)}/tasks`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          title: "Admission should wait",
          created_by: bayActor.actor_label,
          ...bayActor,
        }),
      }
    );
    assert.equal(blockedAdmission.status, 409);
    assert.equal((await blockedAdmission.json()).code, "coordination_active_lock");
  }
);
