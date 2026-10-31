import assert from "node:assert/strict";
import test from "node:test";

import { ManifestTransitionCoordinator } from "../manifest-transition-coordinator.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";

function activityEvent(sequence: number): DaemonActivityEvent {
  return {
    observed_at: "2026-10-19T00:00:00.000Z", sequence, provider: "codex", kind: "tool", method: "item/x",
    summary: "x", status: "working", payload: { sequence }, payload_truncated: false, payload_redacted: false,
    durable_payload_ref: null,
  } as DaemonActivityEvent;
}

function harness() {
  const full = { id: "agent-1", room_id: "room-1", desired_state: "running", observed_state: "working",
    condition: "none", activity: [activityEvent(1), activityEvent(2), activityEvent(3)] } as unknown as DaemonManifestEntry;
  const reads: string[] = [];
  const replaced: DaemonManifestEntry[] = [];
  let lockHeld = 0;
  const coordinator = new ManifestTransitionCoordinator({
    store: {
      getEntry: async (_id, mode = "full") => {
        assert.equal(lockHeld, 1, "entry reads happen inside the manifest lock");
        reads.push(mode);
        return mode === "summary" ? { ...full, activity: full.activity!.slice(-1) } : full;
      },
      replaceEntry: async (_generation, entry) => { replaced.push(entry); return { generation: 2, entry }; },
    },
    authority: {
      currentManifestGeneration: () => 1,
      acceptManifestGeneration: () => {},
      assertCurrent: async () => {},
      serializeMutation: async (operation) => { lockHeld += 1; try { return await operation(); } finally { lockHeld -= 1; } },
      serializeCommit: async (operation) => operation(),
      fenceCommit: async (commit) => commit(),
    },
    audit: { append: async () => {} },
    nowMs: () => 0,
  });
  return { coordinator, reads, replaced, full };
}

test("an update that declares it reads no activity and changes nothing reads only the summary entry", async () => {
  const { coordinator, reads, replaced } = harness();
  const result = await coordinator.updateEntry("agent-1", (current) => current, undefined, { readsNoActivity: true });
  assert.deepEqual(reads, ["summary"]);
  assert.deepEqual(replaced, []);
  assert.equal(result.id, "agent-1");
});

test("an update that declares it reads no activity and changes the entry writes from the full entry", async () => {
  const { coordinator, reads, replaced, full } = harness();
  await coordinator.updateEntry("agent-1", (current) => ({ ...current, observed_state: "idle" }), undefined, { readsNoActivity: true });
  assert.deepEqual(reads, ["summary", "full"]);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]!.observed_state, "idle");
  assert.deepEqual(replaced[0]!.activity, full.activity, "the committed write keeps every stored event");
});

test("an update that declares it reads no activity fails at once when it reads activity", async () => {
  const { coordinator, replaced } = harness();
  await assert.rejects(
    coordinator.updateEntry("agent-1", (current) => (current.activity?.length ? current : { ...current, observed_state: "idle" }),
      undefined, { readsNoActivity: true }),
    /readsNoActivity read the entry's activity/,
  );
  assert.deepEqual(replaced, []);
});

test("an update that declares it reads no activity may spread the entry", async () => {
  const { coordinator, replaced, full } = harness();
  await coordinator.updateEntry("agent-1", (current) => ({ ...current, observed_state: "idle" }), undefined, { readsNoActivity: true });
  assert.deepEqual(replaced[0]!.activity, full.activity);
});

test("an update without the declaration still reads the full entry once", async () => {
  const { coordinator, reads, replaced } = harness();
  await coordinator.updateEntry("agent-1", (current) => current);
  assert.deepEqual(reads, ["full"]);
  assert.deepEqual(replaced, []);
});

test("a Cursor agent that reaches idle after its launch is stamped ready, because no runtime fact can do it", async () => {
  const { coordinator, replaced, full } = harness();
  Object.assign(full, { provider: "cursor", observed_state: "starting" });
  await coordinator.transition("agent-1", "idle", "none", "reattached durable provider handle", "daemon-convergence");
  assert.equal(typeof replaced.at(-1)?.ready_reached_at, "string");
});

test("Cursor keeps its first ready stamp, and is not stamped while blocked", async () => {
  const stamped = harness();
  Object.assign(stamped.full, { provider: "cursor", observed_state: "working", ready_reached_at: "2026-10-31T09:54:58.000Z" });
  await stamped.coordinator.transition("agent-1", "idle", "none", "turn ended", "daemon-provider");
  assert.equal(stamped.replaced.at(-1)?.ready_reached_at, "2026-10-31T09:54:58.000Z");

  const blocked = harness();
  Object.assign(blocked.full, { provider: "cursor", observed_state: "starting" });
  await blocked.coordinator.transition("agent-1", "idle", "coordination_blocked", "no binding", "daemon-convergence");
  assert.equal(blocked.replaced.at(-1)?.ready_reached_at, undefined);
});

test("another provider is left to its runtime fact", async () => {
  const { coordinator, replaced, full } = harness();
  Object.assign(full, { provider: "codex", observed_state: "starting" });
  await coordinator.transition("agent-1", "idle", "none", "reattached durable provider handle", "daemon-convergence");
  assert.equal(replaced.at(-1)?.ready_reached_at, undefined);
});
