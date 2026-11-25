import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ManifestConflictError, ManifestStore, type ManifestTransitionCommit } from "../manifest-store.js";
import { ManifestTransitionCoordinator } from "../manifest-transition-coordinator.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";
import { fixture } from "./helpers/daemon-fixture.js";

function activityEvent(sequence: number): DaemonActivityEvent {
  return {
    observed_at: "2026-10-19T00:00:00.000Z", sequence, provider: "codex", kind: "tool", method: "item/x",
    summary: `summary-${sequence}`, status: "working",
    payload: { sequence, detail: `payload-${sequence}-${"x".repeat(256)}` },
    payload_truncated: false, payload_redacted: false,
    durable_payload_ref: null,
  } as DaemonActivityEvent;
}

function harness() {
  const full = { id: "agent-1", room_id: "room-1", desired_state: "running", observed_state: "working",
    condition: "none", activity: [activityEvent(1), activityEvent(2), activityEvent(3)] } as unknown as DaemonManifestEntry;
  const reads: string[] = [];
  const replaced: DaemonManifestEntry[] = [];
  const transitions: ManifestTransitionCommit[] = [];
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
      commitTransition: async (_version, input) => { transitions.push(input); return { version: 2 }; },
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
  return { coordinator, reads, replaced, transitions, full };
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
  const { coordinator, reads, replaced, transitions, full } = harness();
  Object.assign(full, { provider: "cursor", observed_state: "starting" });
  await coordinator.transition("agent-1", "idle", "none", "reattached durable provider handle", "daemon-convergence");
  assert.deepEqual(reads, ["summary"]);
  assert.deepEqual(replaced, []);
  assert.equal(typeof transitions.at(-1)?.readyReachedAt, "string");
});

test("Cursor keeps its first ready stamp, and is not stamped while blocked", async () => {
  const stamped = harness();
  Object.assign(stamped.full, { provider: "cursor", observed_state: "working", ready_reached_at: "2026-10-31T09:54:58.000Z" });
  await stamped.coordinator.transition("agent-1", "idle", "none", "turn ended", "daemon-provider");
  assert.equal(stamped.transitions.at(-1)?.readyReachedAt, "2026-10-31T09:54:58.000Z");

  const blocked = harness();
  Object.assign(blocked.full, { provider: "cursor", observed_state: "starting" });
  await blocked.coordinator.transition("agent-1", "idle", "coordination_blocked", "no binding", "daemon-convergence");
  assert.equal(blocked.transitions.at(-1)?.readyReachedAt, undefined);
});

test("another provider is left to its runtime fact", async () => {
  const { coordinator, transitions, full } = harness();
  Object.assign(full, { provider: "codex", observed_state: "starting" });
  await coordinator.transition("agent-1", "idle", "none", "reattached durable provider handle", "daemon-convergence");
  assert.equal(transitions.at(-1)?.readyReachedAt, undefined);
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
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transitionOnce persists via targeted SQL without reading or modifying stored activity payloads", async () => {
  const env = await fixture();
  const store = new ManifestStore(join(env.root, "daemon.sqlite"));
  try {
    const richActivity = Array.from({ length: 24 }, (_, index) => activityEvent(index + 1));
    const seedEntry = {
      id: "agent-rich",
      room_id: "room-1",
      display_name: "RichAgent",
      provider: "cursor",
      model: null,
      charter: "test",
      desired_state: "running",
      observed_state: "starting",
      condition: "none",
      permission_profile_id: null,
      created_by: "test",
      created_at: "2026-01-01T00:00:00.000Z",
      activity: richActivity,
      reconciliation: {
        exit_timestamps_ms: [10_000],
        consecutive_action_failures: 1,
        last_observed_state: "starting",
        next_restart_at_ms: 20_000,
        completed_action_ids: ["act-1"],
        last_action_sequence: 1,
        pending_action: { id: "act-2", sequence: 2, kind: "poke" as const, recorded_at_ms: 12_000 },
      },
    } as DaemonManifestEntry;
    const saved = await store.write([seedEntry]);
    const initialVersion = saved.versions["agent-rich"]!;
    const beforeWatch = await store.loadForStateWatch();
    assert.equal(beforeWatch.entries[0]!.observed_state, "starting");

    const getEntryWithVersionCalls: string[] = [];
    let replaceCalls = 0;
    let fenceCalls = 0;
    const audits: Array<{ from: string; to: string; generation: number }> = [];
    const coordinator = new ManifestTransitionCoordinator({
      store: {
        getEntry: (id, mode) => store.getEntry(id, mode),
        getEntryWithVersion: (id, mode) => {
          getEntryWithVersionCalls.push(mode ?? "full");
          return store.getEntryWithVersion(id, mode);
        },
        replaceEntry: async (...args) => {
          replaceCalls += 1;
          return store.replaceEntry(...args);
        },
        commitTransition: (...args) => store.commitTransition(...args),
      },
      authority: {
        assertCurrent: async () => {},
        serializeMutation: (operation) => operation(),
        serializeCommit: (operation) => operation(),
        fenceCommit: async (commit) => { fenceCalls += 1; await commit(); },
      },
      audit: {
        append: async (event) => { audits.push({ from: event.from, to: event.to, generation: event.generation }); },
      },
      nowMs: () => 50_000,
    });

    const terminal = {
      ended_at: "2026-10-19T00:05:00.000Z",
      exit_code: 1,
      signal: "SIGTERM",
      stdio_archive_ref: null,
      stdio_tail: "crash tail",
      terminal_cause: "crashed",
      actor: "provider",
      generation: 2,
      provider_continuation_id: "thread-1",
    };
    await coordinator.transitionOnce(
      "agent-rich",
      "failed",
      "quarantined",
      "provider crashed",
      "daemon-convergence",
      {
        exit_timestamps_ms: [10_000, 50_000],
        consecutive_action_failures: 2,
        last_observed_state: "failed",
        next_restart_at_ms: 90_000,
        completed_action_ids: ["act-1", "act-2"],
        last_action_sequence: 2,
        pending_action: null,
        last_terminal: terminal,
      },
      undefined,
      terminal,
    );

    assert.deepEqual(getEntryWithVersionCalls, ["summary"]);
    assert.equal(replaceCalls, 0);
    assert.equal(fenceCalls, 1);
    assert.deepEqual(audits, [{ from: "starting", to: "failed", generation: initialVersion + 1 }]);

    const afterFull = await store.getEntry("agent-rich", "full");
    assert.ok(afterFull);
    assert.equal(afterFull.observed_state, "failed");
    assert.equal(afterFull.condition, "quarantined");
    assert.equal(afterFull.last_error, "provider crashed");
    assert.equal(afterFull.ready_reached_at, undefined);
    assert.deepEqual(afterFull.activity, richActivity, "all 24 stored activity events and payloads must remain 100% intact");
    assert.deepEqual(afterFull.reconciliation, {
      exit_timestamps_ms: [10_000, 50_000],
      consecutive_action_failures: 2,
      last_observed_state: "failed",
      next_restart_at_ms: 90_000,
      completed_action_ids: ["act-1", "act-2"],
      last_action_sequence: 2,
      pending_action: null,
      last_terminal: terminal,
    });
    assert.equal(afterFull.reconciliation_notices?.length, 1);
    assert.equal(afterFull.reconciliation_notices?.[0]?.kind, "quarantine_death");
    assert.deepEqual(afterFull.reconciliation_notices?.[0]?.terminal, terminal);

    // State watch must observe the version bump from the targeted SQL update.
    const afterWatch = await store.loadForStateWatch();
    assert.equal(afterWatch.entries[0]!.observed_state, "failed");
    assert.equal(afterWatch.entries[0]!.condition, "quarantined");

    // Reaching idle on Cursor sets ready_reached_at via targeted agents update.
    await coordinator.transition("agent-rich", "idle", "none", "recovered", "daemon-convergence");
    const afterIdleLoaded = await store.getEntryWithVersion("agent-rich", "full");
    const afterIdle = afterIdleLoaded?.entry;
    assert.equal(afterIdle?.observed_state, "idle");
    assert.equal(afterIdle?.condition, "none");
    assert.equal(afterIdle?.last_error ?? null, null);
    assert.equal(typeof afterIdle?.ready_reached_at, "string");
    assert.deepEqual(afterIdle?.activity, richActivity);

    // Per-agent version mismatch fails closed with ManifestConflictError.
    await assert.rejects(
      store.commitTransition(afterIdleLoaded!.version - 1, {
        agentId: "agent-rich",
        observedState: "stopped",
        condition: "none",
        lastError: null,
        reconciliation: afterIdle!.reconciliation!,
        reconciliationNotices: afterIdle!.reconciliation_notices ?? [],
      }),
      ManifestConflictError,
    );

    // Even with invalid activity payload JSON in SQLite, transitionOnce never reads or rewrites activity_events.
    const raw = new DatabaseSync(join(env.root, "daemon.sqlite"));
    try {
      raw.prepare("UPDATE activity_events SET payload_json = 'invalid-json' WHERE agent_id = ?").run("agent-rich");
    } finally {
      raw.close();
    }
    await coordinator.transition("agent-rich", "stopped", "none", "stopped cleanly", "daemon-convergence");
    assert.equal((await store.getEntry("agent-rich", "summary"))?.observed_state, "stopped");
  } finally {
    await store.close();
    await env.cleanup();
  }
});
