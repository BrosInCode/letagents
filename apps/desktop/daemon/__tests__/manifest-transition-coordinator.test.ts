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

test("an update without the declaration still reads the full entry once", async () => {
  const { coordinator, reads, replaced } = harness();
  await coordinator.updateEntry("agent-1", (current) => current);
  assert.deepEqual(reads, ["full"]);
  assert.deepEqual(replaced, []);
});
