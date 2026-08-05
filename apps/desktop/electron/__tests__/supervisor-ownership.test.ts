import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  launchLegacyWithOwnership,
  transferSupervisorOwnership,
} from "../main/supervisor-ownership.js";

const ipcSource = readFileSync(fileURLToPath(new URL("../main/ipc.ts", import.meta.url)), "utf8");

test("supervisor list projects canonical agent keys for renderer mention routing", () => {
  const listHandler = ipcSource.slice(
    ipcSource.indexOf('"desktop:supervisor:list-agents"'),
    ipcSource.indexOf('"desktop:supervisor:create-agent"'),
  );
  assert.match(listHandler, /readDesktopSupervisorGrantAgentKeysForEntries/);
  assert.match(listHandler, /agentKey:/);
});

test("supervisor creation admits available Cursor profiles before claiming durable ownership", () => {
  const createHandler = ipcSource.slice(
    ipcSource.indexOf('"desktop:supervisor:create-agent"'),
    ipcSource.indexOf('"desktop:supervisor:resume-ownership-transfer"'),
  );
  assert.match(createHandler, /provider !== "cursor"/);
  assert.doesNotMatch(createHandler, /provider === "cursor" && input\.permissionProfileId !== "read_only"/);
  assert.match(createHandler, /assertManagedAgentPermissionProfileAvailable\(provider, input\.permissionProfileId\)/);
  assert.ok(
    createHandler.indexOf("assertManagedAgentPermissionProfileAvailable")
      < createHandler.indexOf("createPausedAndInstall"),
    "permission admission must fail before a durable ownership claim or legacy teardown",
  );
});

test("paused launch recovery reuses guarded ownership without requiring a user Claude MCP install", () => {
  const resumeHandler = ipcSource.slice(
    ipcSource.indexOf('"desktop:supervisor:resume-ownership-transfer"'),
    ipcSource.indexOf('"desktop:supervisor:set-desired-state"'),
  );
  assert.match(resumeHandler, /transferSupervisorOwnership\(/);
  assert.match(resumeHandler, /listDesktopManagedAgentSessions\(entry\.roomId\)/);
  assert.match(resumeHandler, /stopDesktopManagedAgent/);
  assert.match(resumeHandler, /compareAndSetDesiredState\(manifest\.id, "paused", "running"\)/);
  assert.match(resumeHandler, /supervisorGrantCoordinator\.prepareEntryForActivation\(entry\)/);
  assert.doesNotMatch(resumeHandler, /refreshInstalledLetAgentsMcpServerAuth/);
});

test("explicit provider recovery prepares authority without entering activation semantics", () => {
  const recoveryHandler = ipcSource.slice(
    ipcSource.indexOf('"desktop:supervisor:recover-agent-runtime"'),
    ipcSource.indexOf('"desktop:supervisor:control-turn"'),
  );
  assert.match(recoveryHandler, /prepareEntryForRuntimeRecovery\(entry\)/);
  assert.doesNotMatch(recoveryHandler, /prepareEntryForActivation\(entry\)/);
  assert.match(recoveryHandler, /recoverAgentRuntime\(entry\.id\)/);
});

test("supervisor ownership claims before legacy teardown and activates last", async () => {
  const order: string[] = [];
  const result = await transferSupervisorOwnership({
    claim: async () => { order.push("claim"); return { id: "supervised_1" }; },
    listLegacy: () => ["legacy_a", "legacy_b"],
    stopLegacy: async (owner) => { order.push(`stop:${owner}`); },
    activate: async (manifest) => { order.push("activate"); return manifest; },
    rollback: async () => { order.push("rollback"); },
  });
  assert.equal(result.id, "supervised_1");
  assert.deepEqual(order, ["claim", "stop:legacy_a", "stop:legacy_b", "activate"]);
});

test("supervisor ownership rolls back its durable claim when legacy teardown fails", async () => {
  const order: string[] = [];
  await assert.rejects(() => transferSupervisorOwnership({
    claim: async () => { order.push("claim"); return { id: "supervised_2" }; },
    listLegacy: () => ["legacy_a"],
    stopLegacy: async () => { order.push("stop"); throw new Error("teardown failed"); },
    activate: async (manifest) => { order.push("activate"); return manifest; },
    rollback: async () => { order.push("rollback"); },
  }), /teardown failed/);
  assert.deepEqual(order, ["claim", "stop", "rollback"]);
});

test("supervisor ownership preserves teardown and rollback failures", async () => {
  const order: string[] = [];
  const teardownError = new Error("teardown failed");
  const rollbackError = new Error("rollback failed");
  await assert.rejects(() => transferSupervisorOwnership({
    claim: async () => { order.push("claim"); return { id: "supervised_3" }; },
    listLegacy: () => ["legacy_a"],
    stopLegacy: async () => { order.push("stop"); throw teardownError; },
    activate: async (manifest) => { order.push("activate"); return manifest; },
    rollback: async () => { order.push("rollback"); throw rollbackError; },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /could not be rolled back/);
    assert.deepEqual(error.errors, [teardownError, rollbackError]);
    return true;
  });
  assert.deepEqual(order, ["claim", "stop", "rollback"]);
});

test("legacy launch holds its reservation across a barrier so a supervised claimant cannot spawn", async () => {
  let laneOwner: "legacy" | "supervised" | null = null;
  let spawnCount = 0;
  let releaseStart!: () => void;
  let reservationHeld!: () => void;
  const startBarrier = new Promise<void>((resolve) => { releaseStart = resolve; });
  const reserved = new Promise<void>((resolve) => { reservationHeld = resolve; });

  const legacy = launchLegacyWithOwnership({
    reserve: async () => {
      if (laneOwner) throw new Error("lane owned");
      laneOwner = "legacy";
      reservationHeld();
    },
    start: async () => {
      await startBarrier;
      spawnCount += 1;
      return { sessionId: "legacy_session" };
    },
    activate: async () => {},
    stop: async () => { spawnCount -= 1; },
    release: async () => { laneOwner = null; },
  });
  await reserved;
  await assert.rejects(async () => {
    if (laneOwner) throw new Error("lane owned");
    laneOwner = "supervised";
  }, /lane owned/);
  releaseStart();
  assert.equal((await legacy).sessionId, "legacy_session");
  assert.equal(spawnCount, 1);
  assert.equal(laneOwner, "legacy");
});

test("a supervised-first claim rejects legacy before runtime spawn", async () => {
  let laneOwner: "legacy" | "supervised" | null = "supervised";
  let spawnCount = 0;
  await assert.rejects(() => launchLegacyWithOwnership({
    reserve: async () => {
      if (laneOwner) throw new Error("lane owned");
      laneOwner = "legacy";
    },
    start: async () => { spawnCount += 1; return { sessionId: "impossible" }; },
    activate: async () => {},
    stop: async () => { spawnCount -= 1; },
    release: async () => { laneOwner = null; },
  }), /lane owned/);
  assert.equal(spawnCount, 0);
  assert.equal(laneOwner, "supervised");
});

test("post-spawn activation failure stops the legacy engine before releasing its lane", async () => {
  const order: string[] = [];
  await assert.rejects(() => launchLegacyWithOwnership({
    reserve: async () => { order.push("reserve"); },
    start: async () => { order.push("spawn"); return { sessionId: "legacy_session" }; },
    activate: async () => { order.push("activate"); throw new Error("activation failed"); },
    stop: async () => { order.push("stop"); },
    release: async () => { order.push("release"); },
  }), /activation failed/);
  assert.deepEqual(order, ["reserve", "spawn", "activate", "stop", "release"]);
});

test("a pre-spawn failure preserves both the start and reservation release failures", async () => {
  const order: string[] = [];
  const startError = new Error("spawn failed");
  const releaseError = new Error("release failed");
  await assert.rejects(() => launchLegacyWithOwnership({
    reserve: async () => { order.push("reserve"); },
    start: async () => { order.push("spawn"); throw startError; },
    activate: async () => { order.push("activate"); },
    stop: async () => { order.push("stop"); },
    release: async () => { order.push("release"); throw releaseError; },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /before spawn/);
    assert.deepEqual(error.errors, [startError, releaseError]);
    return true;
  });
  assert.deepEqual(order, ["reserve", "spawn", "release"]);
});

test("a post-spawn failure preserves both activation and reservation release failures", async () => {
  const order: string[] = [];
  const activationError = new Error("activation failed");
  const releaseError = new Error("release failed");
  await assert.rejects(() => launchLegacyWithOwnership({
    reserve: async () => { order.push("reserve"); },
    start: async () => { order.push("spawn"); return { sessionId: "legacy_session" }; },
    activate: async () => { order.push("activate"); throw activationError; },
    stop: async () => { order.push("stop"); },
    release: async () => { order.push("release"); throw releaseError; },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /after spawn cleanup/);
    assert.deepEqual(error.errors, [activationError, releaseError]);
    return true;
  });
  assert.deepEqual(order, ["reserve", "spawn", "activate", "stop", "release"]);
});
