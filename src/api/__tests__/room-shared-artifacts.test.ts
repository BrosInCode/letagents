import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PR_URL, TASK_BRANCH } from "./git-room-test-helpers.js";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
} else {
  process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = await import("../db.js");

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const {
  buildRoomSharedArtifactIdentityKey,
  createProjectWithName,
  getRoomSharedArtifactByIdentityKey,
  getRoomSharedArtifacts,
  linkRoomSharedArtifactToTask,
  preserveManualRoomSharedArtifactInput,
  syncRoomSharedArtifactsForTask,
  upsertRoomSharedArtifact,
} = dbModule;
const migrationsFolder = path.resolve(process.cwd(), "drizzle");

function pullRequestArtifact(overrides: Record<string, unknown> = {}) {
  return {
    provider: "github",
    kind: "pull_request",
    url: PR_URL,
    ...overrides,
  };
}

function existingPullRequestArtifact(overrides: Record<string, unknown> = {}) {
  return {
    artifact_id: "PR_kwDOExample",
    artifact_number: 42,
    title: "Add Git Rooms",
    url: PR_URL,
    ref: TASK_BRANCH,
    state: "open",
    source: "github_event",
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  if (!pool) {
    throw new Error("DB-backed room shared artifact tests require TEST_DB_URL");
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
    throw new Error("DB-backed room shared artifact tests require TEST_DB_URL");
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

test("buildRoomSharedArtifactIdentityKey prefers durable artifact identifiers", () => {
  assert.equal(
    buildRoomSharedArtifactIdentityKey({
      provider: "github",
      kind: "pull_request",
      url: PR_URL,
      number: 42,
      ref: TASK_BRANCH,
    }),
    `github:pull_request:url:${PR_URL}`
  );

  assert.equal(
    buildRoomSharedArtifactIdentityKey({
      provider: "github",
      kind: "branch",
      ref: TASK_BRANCH,
    }),
    `github:branch:ref:${TASK_BRANCH}`
  );
});

test("preserveManualRoomSharedArtifactInput does not downgrade richer existing artifacts", () => {
  const result = preserveManualRoomSharedArtifactInput({
    source: "manual",
    artifact: pullRequestArtifact(),
    existing: existingPullRequestArtifact(),
  });

  assert.equal(result.source, "github_event");
  assert.deepEqual(result.artifact, {
    provider: "github",
    kind: "pull_request",
    id: "PR_kwDOExample",
    number: 42,
    title: "Add Git Rooms",
    url: PR_URL,
    ref: TASK_BRANCH,
    state: "open",
  });
});

test("preserveManualRoomSharedArtifactInput does not downgrade existing manual artifacts", () => {
  const result = preserveManualRoomSharedArtifactInput({
    source: "github_event",
    artifact: pullRequestArtifact({
      title: "Automated PR title",
    }),
    existing: existingPullRequestArtifact({
      artifact_id: "manual-pr",
      title: "Curated PR title",
      ref: "manual/ref",
      state: "accepted",
      source: "manual",
    }),
  });

  assert.equal(result.source, "manual");
  assert.deepEqual(result.artifact, {
    provider: "github",
    kind: "pull_request",
    id: "manual-pr",
    number: 42,
    title: "Curated PR title",
    url: PR_URL,
    ref: "manual/ref",
    state: "accepted",
  });
});

test("preserveManualRoomSharedArtifactInput preserves existing fields when automation omits them", () => {
  const result = preserveManualRoomSharedArtifactInput({
    source: "github_event",
    artifact: pullRequestArtifact({
      title: "Review on PR",
    }),
    existing: existingPullRequestArtifact({
      artifact_id: null,
      title: "task_42: Git Rooms",
    }),
  });

  assert.equal(result.source, "github_event");
  assert.deepEqual(result.artifact, {
    provider: "github",
    kind: "pull_request",
    id: undefined,
    number: 42,
    title: "Review on PR",
    url: PR_URL,
    ref: TASK_BRANCH,
    state: "open",
  });
});

test(
  "getRoomSharedArtifacts applies task filter before limiting and returns all linked task IDs",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room shared artifact tests" : false,
  },
  async () => {
    if (
      !createProjectWithName ||
      !getRoomSharedArtifacts ||
      !linkRoomSharedArtifactToTask ||
      !upsertRoomSharedArtifact
    ) {
      throw new Error("DB-backed room shared artifact tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");
    await upsertRoomSharedArtifact({
      room_id: room.id,
      artifact: {
        provider: "github",
        kind: "branch",
        ref: "aaa-unrelated",
        title: "Unrelated branch",
      },
      source: "manual",
    });
    const targetArtifact = await upsertRoomSharedArtifact({
      room_id: room.id,
      artifact: {
        provider: "github",
        kind: "pull_request",
        number: 42,
        title: "Visible linked PR",
      },
      source: "manual",
    });
    await linkRoomSharedArtifactToTask({
      room_id: room.id,
      artifact_identity_key: targetArtifact.identity_key,
      task_id: "task_7",
      source: "manual",
    });
    await linkRoomSharedArtifactToTask({
      room_id: room.id,
      artifact_identity_key: targetArtifact.identity_key,
      task_id: "task_9",
      source: "manual",
    });

    const artifacts = await getRoomSharedArtifacts({
      room_id: room.id,
      task_id: "task_7",
      limit: 1,
    });

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.identity_key, targetArtifact.identity_key);
    assert.deepEqual(artifacts[0]?.linked_task_ids, ["task_7", "task_9"]);
  }
);

test(
  "manual artifact publish preserves richer existing webhook metadata",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room shared artifact tests" : false,
  },
  async () => {
    if (
      !createProjectWithName ||
      !getRoomSharedArtifactByIdentityKey ||
      !upsertRoomSharedArtifact
    ) {
      throw new Error("DB-backed room shared artifact tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const webhookArtifact = await upsertRoomSharedArtifact({
      room_id: room.id,
      artifact: {
        provider: "github",
        kind: "pull_request",
        id: "PR_kwDOExample",
        number: 42,
        title: "Add Git Rooms",
        url: PR_URL,
        ref: TASK_BRANCH,
        state: "open",
      },
      source: "github_event",
    });

    const manualArtifact = await upsertRoomSharedArtifact({
      room_id: room.id,
      artifact: {
        provider: "github",
        kind: "pull_request",
        url: PR_URL,
      },
      source: "manual",
    });
    const hydrated = await getRoomSharedArtifactByIdentityKey({
      room_id: room.id,
      identity_key: webhookArtifact.identity_key,
    });

    assert.equal(manualArtifact.identity_key, webhookArtifact.identity_key);
    assert.equal(hydrated?.source, "github_event");
    assert.equal(hydrated?.artifact_id, "PR_kwDOExample");
    assert.equal(hydrated?.artifact_number, 42);
    assert.equal(hydrated?.title, "Add Git Rooms");
    assert.equal(hydrated?.ref, TASK_BRANCH);
    assert.equal(hydrated?.state, "open");
  }
);

test(
  "workflow artifact sync preserves manual and webhook task links",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room shared artifact tests" : false,
  },
  async () => {
    if (
      !createProjectWithName ||
      !getRoomSharedArtifacts ||
      !linkRoomSharedArtifactToTask ||
      !syncRoomSharedArtifactsForTask ||
      !upsertRoomSharedArtifact
    ) {
      throw new Error("DB-backed room shared artifact tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const manualArtifact = await upsertRoomSharedArtifact({
      room_id: room.id,
      artifact: {
        provider: "github",
        kind: "branch",
        ref: "manual/review",
        title: "Manual review branch",
      },
      source: "manual",
    });
    const webhookArtifact = await upsertRoomSharedArtifact({
      room_id: room.id,
      artifact: {
        provider: "github",
        kind: "pull_request",
        number: 42,
        title: "Webhook PR",
      },
      source: "github_event",
    });
    const workflowArtifact = await upsertRoomSharedArtifact({
      room_id: room.id,
      artifact: {
        provider: "github",
        kind: "pull_request",
        number: 77,
        title: "Stale workflow PR",
      },
      source: "task_workflow_artifact",
    });

    await linkRoomSharedArtifactToTask({
      room_id: room.id,
      artifact_identity_key: manualArtifact.identity_key,
      task_id: "task_4",
      source: "manual",
    });
    await linkRoomSharedArtifactToTask({
      room_id: room.id,
      artifact_identity_key: webhookArtifact.identity_key,
      task_id: "task_4",
      source: "github_event",
    });
    await linkRoomSharedArtifactToTask({
      room_id: room.id,
      artifact_identity_key: workflowArtifact.identity_key,
      task_id: "task_4",
      source: "task_workflow_artifact",
    });

    await syncRoomSharedArtifactsForTask({
      room_id: room.id,
      task_id: "task_4",
      artifacts: [],
    });

    const artifacts = await getRoomSharedArtifacts({
      room_id: room.id,
      task_id: "task_4",
    });

    assert.deepEqual(
      artifacts.map((artifact) => artifact.identity_key).sort(),
      [
        manualArtifact.identity_key,
        webhookArtifact.identity_key,
      ].sort()
    );
  }
);
