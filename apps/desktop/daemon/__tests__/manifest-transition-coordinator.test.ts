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

test("expectedVersion CAS on real SQLite ManifestStore rejects stale transitions under one lock without writing state or audit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "letagents-transition-cas-"));
  const store = new ManifestStore(join(dir, "manifest.sqlite"));
  try {
    await store.initialize();
    await store.createEntry({
      id: "agent-cas",
      room_id: "room-1",
      display_name: "Agent CAS",
      provider: "codex",
      model: null,
      charter: "Help",
      desired_state: "running",
      observed_state: "absent",
      condition: "none",
      permission_profile_id: "full_access",
      provider_launch_policy: {},
      created_by: "test",
      created_at: "2026-10-19T00:00:00.000Z",
      workspace_path: "/tmp/work",
    });

    const auditEvents: Array<{ from: string; to: string; generation: number }> = [];
    let lockDepth = 0;
    let maxLockDepth = 0;
    const coordinator = new ManifestTransitionCoordinator({
      store,
      authority: {
        assertCurrent: async () => {},
        serializeMutation: async (operation) => {
          lockDepth += 1;
          maxLockDepth = Math.max(maxLockDepth, lockDepth);
          assert.equal(lockDepth, 1, "expectedVersion CAS must not nest manifest mutation locks");
          try { return await operation(); } finally { lockDepth -= 1; }
        },
        serializeCommit: async (operation) => operation(),
        fenceCommit: async (commit) => commit(),
      },
      audit: {
        append: async (event) => {
          auditEvents.push({ from: event.from, to: event.to, generation: event.generation });
        },
      },
      nowMs: () => 1_000,
    });

    const initial = await store.getEntryWithVersion("agent-cas");
    assert.ok(initial);
    // Simulate a concurrent writer advancing the row's version.
    await store.replaceEntry(
      initial.version,
      { ...initial.entry, observed_state: "starting" },
      async (commit) => commit(),
    );

    await assert.rejects(
      coordinator.transition(
        "agent-cas",
        "failed",
        "coordination_blocked",
        "stale transition must not commit",
        "daemon-convergence",
        undefined,
        initial.version,
      ),
      (error: unknown) => error instanceof ManifestConflictError
        && error.message.includes(`version ${initial.version + 1} does not match expected ${initial.version}`),
    );

    const afterConflict = await store.getEntryWithVersion("agent-cas");
    assert.equal(afterConflict?.version, initial.version + 1);
    assert.equal(afterConflict?.entry.observed_state, "starting");
    assert.equal(afterConflict?.entry.condition, "none");
    assert.equal(auditEvents.length, 0, "conflicted transition must not emit audit entries");

    // Retrying with the fresh version succeeds cleanly under one lock.
    await coordinator.transition(
      "agent-cas",
      "idle",
      "none",
      "fresh snapshot commit",
      "daemon-convergence",
      undefined,
      afterConflict!.version,
    );

    const afterSuccess = await store.getEntryWithVersion("agent-cas");
    assert.equal(afterSuccess?.version, initial.version + 2);
    assert.equal(afterSuccess?.entry.observed_state, "idle");
    assert.equal(auditEvents.length, 1);
    assert.equal(maxLockDepth, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
