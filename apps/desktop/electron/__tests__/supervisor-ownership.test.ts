import assert from "node:assert/strict";
import test from "node:test";

import {
  describeSupervisorLaneConflict,
  launchLegacyWithOwnership,
  transferSupervisorOwnership,
} from "../main/supervisor-ownership.js";

test("lane conflict distinguishes a blocked startup from a healthy existing owner", () => {
  assert.equal(
    describeSupervisorLaneConflict({
      displayName: "Codex supervised agent",
      provider: "codex",
      observedState: "recovering",
      condition: "coordination_blocked",
      lastError: "provider restart_fresh failed: invalid placeholder continuation",
    }),
    "Codex supervised agent already reserved this room's supervised codex lane, but startup is recovering (coordination_blocked). Cause: provider restart_fresh failed: invalid placeholder continuation. If the supervised runtime recovery card appears below, choose Stop before creating a replacement.",
  );
  assert.equal(
    describeSupervisorLaneConflict({
      displayName: "Codex supervised agent",
      provider: "codex",
      observedState: "working",
      condition: "none",
    }),
    "Codex supervised agent already owns this room's supervised codex lane. Use that agent, or stop it before creating a replacement.",
  );
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
