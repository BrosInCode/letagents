import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
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
      getEntryWithVersion: async (_id, mode = "full") => {
        assert.equal(lockHeld, 1, "entry reads happen inside the manifest lock");
        reads.push(mode);
        return { version: 1, entry: mode === "summary" ? { ...full, activity: full.activity!.slice(-1) } : full };
      },
      replaceEntry: async (_version, entry) => { replaced.push(entry); return { version: 2, entry }; },
    },
    authority: {
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

test("transition rejects stale expectedVersion on real ManifestStore without nested locks or audit writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "letagents-transition-cas-"));
  const store = new ManifestStore(join(dir, "daemon-state.sqlite"));
  try {
    await store.load();
    await store.createEntry({
      id: "agent-1",
      room_id: "room-1",
      display_name: "Agent",
      provider: "codex",
      model: null,
      charter: "Help",
      desired_state: "running",
      observed_state: "absent",
      condition: "none",
      permission_profile_id: "full_access",
      provider_launch_policy: {},
      created_by: "test",
      created_at: "2026-08-26T00:00:00.000Z",
    });
    const auditEvents: Array<{ entry_id: string; to: string }> = [];
    let lockDepth = 0;
    const coordinator = new ManifestTransitionCoordinator({
      store,
      authority: {
        assertCurrent: async () => {},
        serializeMutation: async (operation) => {
          lockDepth += 1;
          assert.equal(lockDepth, 1, "expectedVersion check must never nest serializeMutation");
          try { return await operation(); } finally { lockDepth -= 1; }
        },
        serializeCommit: async (operation) => operation(),
        fenceCommit: async (commit) => commit(),
      },
      audit: { append: async (event) => { auditEvents.push({ entry_id: event.entry_id, to: event.to }); } },
      nowMs: () => 1_000,
    });

    const snapshot = await store.getEntryWithVersion("agent-1");
    assert.ok(snapshot);
    // Simulate a concurrent manifest update after snapshot read.
    await coordinator.updateEntry("agent-1", (current) => ({ ...current, desired_state: "stopped" }));
    const afterConcurrent = await store.getEntryWithVersion("agent-1");
    assert.ok(afterConcurrent);
    assert.notEqual(afterConcurrent.version, snapshot.version);

    await assert.rejects(
      () => coordinator.transition(
        "agent-1",
        "failed",
        "quarantined",
        "stale convergence decision",
        "daemon-convergence",
        undefined,
        snapshot.version,
      ),
      ManifestConflictError,
    );
    const unchanged = await store.getEntryWithVersion("agent-1");
    assert.equal(unchanged?.version, afterConcurrent.version);
    assert.equal(unchanged?.entry.desired_state, "stopped");
    assert.equal(unchanged?.entry.observed_state, "absent");
    assert.deepEqual(auditEvents, [], "a rejected transition appends no audit entry");

    // Matching version commits normally and appends one audit entry.
    await coordinator.transition(
      "agent-1",
      "stopped",
      "none",
      "desired state converged without a live provider",
      "daemon-convergence",
      undefined,
      afterConcurrent.version,
    );
    const committed = await store.getEntryWithVersion("agent-1");
    assert.equal(committed?.entry.observed_state, "stopped");
    assert.equal(committed?.version, afterConcurrent.version + 1);
    assert.deepEqual(auditEvents, [{ entry_id: "agent-1", to: "stopped" }]);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
