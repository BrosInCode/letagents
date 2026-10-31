import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ActivityWriteBatcher, ACTIVITY_BATCH_MAX_EVENTS, commitActivityBatch, isSingleEventActivityError } from "../activity-write-batcher.js";
import { sanitizeDaemonActivityEvent } from "../credential-redaction.js";
import { DaemonAuthority } from "../daemon-authority.js";
import { schedulerErrorDetail } from "../daemon-error-policy.js";
import { ManifestAdministrationCoordinator } from "../manifest-administration-coordinator.js";
import { projectDaemonCreateRequestReplayParameters } from "../manifest-entry-projection.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { DaemonFenceLostError } from "../singleton.js";
import { deriveProviderConfigurationSnapshot } from "../provider-configuration.js";
import { supervisedPermissionProfilesForProvider } from "../supervised-permission-profiles.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";

function agent(id: string): DaemonManifestEntry {
  return {
    id, room_id: "room_1", display_name: `Agent ${id}`, provider: "codex", model: "gpt-5.6-codex",
    charter: "Work on the room's tasks.", desired_state: "running", observed_state: "idle",
    condition: "none", last_error: null, permission_profile_id: "workspace-write",
    provider_launch_policy: { deliveryMode: "mcp_polling" }, created_by: "user_1",
    created_at: "2026-10-19T00:00:00.000Z", source_repo_path: "/repo", workspace_path: `/worktrees/${id}`,
    work_attempt_id: `attempt_${id}`,
    provider_ref: {
      work_attempt_id: `attempt_${id}`, provider_continuation_id: `thread_${id}`,
      provider_connection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: null },
      execution_generation_id: `run_${id}`,
    },
    workplace_liveness: { state: "reachable", observed_at: "2026-10-19T00:01:00.000Z", detail: null },
    native_liveness: { state: "unknown", observed_at: null, detail: null },
    activity: [],
  } as DaemonManifestEntry;
}

function event(sequence: number, status: DaemonActivityEvent["status"] = "working"): DaemonActivityEvent {
  return {
    observed_at: new Date(1_800_000_000_000 + sequence).toISOString(), sequence, provider: "codex", kind: "tool",
    method: "item/commandExecution", summary: `step ${sequence}`, status, payload: { step: sequence },
    payload_truncated: false, payload_redacted: false, durable_payload_ref: null,
  };
}

/** Real store, real authority lanes and coordinator; the batch timer is driven by hand. */
async function harness(options: {
  closeTimeoutMs?: number;
  retryBudgetMs?: number;
  now?: () => number;
  /** Runs before each commit attempt; may wait or throw. */
  beforeCommit?: (items: readonly { agentId: string; event: DaemonActivityEvent }[]) => Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "letagents-activity-batch-"));
  const path = join(root, "daemon-state.sqlite");
  const store = new ManifestStore(path);
  const written = await store.write(0, [agent("a"), agent("b")]);
  const notifications: number[] = [];
  const commits: number[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const diagnostics: { error: unknown; dropped: number }[] = [];
  let fenced = false;
  let lost = false;
  const authority = new DaemonAuthority({
    assertCurrent: async () => { if (lost) throw new Error("singleton lost"); },
    isHandoffScheduled: () => fenced,
    notifyStateChanged: () => notifications.push(Date.now()),
  }, written.generation);
  const batcher = new ActivityWriteBatcher({
    serialize: (operation) => authority.serializeManifestMutationWithoutFlush(operation),
    commit: async (items) => {
      await options.beforeCommit?.(items);
      commits.push(items.length);
      // The same commit main.ts makes, with the ordinary fence.
      const next = await commitActivityBatch({ store, items, expectedGeneration: authority.generation,
        fence: (commit) => authority.fenceDaemonCommit(commit), mayWrite: (agentId) => batcher.mayWrite(agentId) });
      authority.generation = next.generation;
    },
    diagnostic: (error, dropped) => diagnostics.push({ error, dropped }),
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => { (handle as { cleared: boolean }).cleared = true; },
    ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
    ...(options.retryBudgetMs === undefined ? {} : { retryBudgetMs: options.retryBudgetMs }),
    ...(options.now ? { now: options.now } : {}),
  });
  authority.setPendingWriteFlush(() => batcher.flushInLane());
  const coordinator = new ManifestAdministrationCoordinator({
    store,
    authority: {
      serialize: (operation) => authority.serializeManifestMutation(operation),
      assertCurrent: async () => {},
      currentDaemonGeneration: () => 7,
      currentManifestGeneration: () => authority.generation,
      acceptManifestGeneration: (generation) => { authority.generation = generation; },
      fenceCommit: (commit) => authority.fenceDaemonCommit(commit),
    },
    policies: {
      projectCreateReplayParameters: projectDaemonCreateRequestReplayParameters,
      deriveProviderConfiguration: deriveProviderConfigurationSnapshot,
      permissionProfilesForProvider: supervisedPermissionProfilesForProvider,
      sanitizeActivity: sanitizeDaemonActivityEvent,
      safeErrorDetail: schedulerErrorDetail,
    },
    convergence: { request: () => {} },
    activity: {
      serializeAdmission: (operation) => batcher.serializeAdmission(operation),
      pendingState: (entryId) => batcher.pendingState(entryId),
      admit: (item) => batcher.admit(item),
    },
  });
  /** Fires the batch window timer that is due now, as the event loop would. */
  const fireWindow = async () => {
    const timer = timers.find((candidate) => !candidate.cleared && candidate.ms !== (options.closeTimeoutMs ?? 2_000));
    assert.ok(timer, "a batch window timer is scheduled");
    timer.cleared = true;
    timer.callback();
    await authority.serializeManifestMutationWithoutFlush(async () => undefined);
  };
  const committedActivity = (agentId: string) => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare("SELECT sequence, summary FROM activity_events WHERE agent_id=? ORDER BY sort_order").all(agentId)
        .map((row) => Number(row.sequence));
    } finally { database.close(); }
  };
  return {
    store, authority, batcher, coordinator, notifications, commits, timers, diagnostics, fireWindow, committedActivity,
    fence: () => { fenced = true; },
    lose: () => { lost = true; },
    cleanup: async () => { await batcher.close(); await store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("many events from several agents share one commit and one notification", async () => {
  const h = await harness();
  try {
    const startGeneration = h.authority.generation;
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      await h.coordinator.appendNativeActivity("a", event(sequence), false);
      await h.coordinator.appendNativeActivity("b", event(sequence), true);
    }
    assert.deepEqual(h.commits, [], "nothing commits inside the window");
    assert.deepEqual(h.committedActivity("a"), []);
    assert.equal(h.notifications.length, 0, "no notification before the commit");
    await h.fireWindow();
    assert.deepEqual(h.commits, [20]);
    assert.equal(h.notifications.length, 1, "one notification, after the commit");
    assert.equal(h.authority.generation, startGeneration + 1, "one generation per batch");
    assert.deepEqual(h.committedActivity("a"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(h.committedActivity("b"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const a = await h.store.getEntry("a");
    assert.equal(a?.observed_state, "working", "the runtime update of the newest event is applied");
    assert.equal(a?.native_liveness?.detail, "step 10");
    const b = await h.store.getEntry("b");
    assert.equal(b?.observed_state, "idle", "activity-only events leave the runtime state alone");
  } finally { await h.cleanup(); }
});

test("the batch window timer does not keep the process alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-activity-batch-ref-"));
  let handle: ReturnType<typeof setTimeout> | undefined;
  const batcher = new ActivityWriteBatcher({
    serialize: (operation) => operation(),
    commit: async () => {},
    setTimeout: (callback, ms) => (handle = setTimeout(callback, ms)),
  });
  try {
    batcher.admit({ agentId: "a", event: event(1), runtimeUpdate: null, limit: 200 });
    assert.ok(handle);
    assert.equal(handle.hasRef(), false);
  } finally { await batcher.close(); await rm(root, { recursive: true, force: true }); }
});

test("sequences stay unique and increasing against pending events", async () => {
  const h = await harness();
  try {
    await h.coordinator.appendNativeActivity("a", event(5), false);
    await assert.rejects(h.coordinator.appendNativeActivity("a", event(5), false), /not newer than 5/);
    await assert.rejects(h.coordinator.appendNativeActivity("a", event(3), false), /not newer than 5/);
    // A stream event whose position was taken meanwhile goes after the newest pending one.
    await h.coordinator.appendNativeActivity("a", event(4), false, "after_latest");
    await h.coordinator.appendNativeActivity("a", event(9), false);
    await h.fireWindow();
    assert.deepEqual(h.committedActivity("a"), [5, 6, 9]);
    // Committed events are checked as before.
    await assert.rejects(h.coordinator.appendNativeActivity("a", event(9), false), /not newer than 9/);
  } finally { await h.cleanup(); }
});

test("a blocked event keeps the newest pending runtime state", async () => {
  const h = await harness();
  try {
    await h.coordinator.appendNativeActivity("a", event(1, "working"), false);
    await h.coordinator.appendNativeActivity("a", event(2, "blocked"), false);
    await h.fireWindow();
    assert.equal((await h.store.getEntry("a"))?.observed_state, "working");
  } finally { await h.cleanup(); }
});

test("a full batch is written at once, and no transaction holds more than the maximum", async () => {
  const h = await harness();
  try {
    const total = ACTIVITY_BATCH_MAX_EVENTS * 2 + 5;
    for (let sequence = 1; sequence <= total; sequence += 1) {
      await h.coordinator.appendNativeActivity("a", event(sequence), true);
    }
    await h.authority.serializeManifestMutationWithoutFlush(async () => undefined);
    assert.ok(h.commits.every((size) => size <= ACTIVITY_BATCH_MAX_EVENTS), `batches ${h.commits.join(",")}`);
    assert.ok(h.commits.length >= 2, "full batches did not wait for the window");
    await h.batcher.flush();
    assert.equal(h.commits.reduce((sum, size) => sum + size, 0), total);
    const committed = h.committedActivity("a");
    assert.deepEqual(committed, Array.from({ length: total }, (_, index) => index + 1));
  } finally { await h.cleanup(); }
});

test("every other manifest mutation writes pending activity first", async () => {
  const h = await harness();
  try {
    await h.coordinator.appendNativeActivity("a", event(1, "working"), false);
    await h.coordinator.appendNativeActivity("a", event(2, "working"), false);
    // A load-then-write mutation, like a lifecycle transition, sees both
    // events committed and orders after them: its state wins.
    await h.authority.serializeManifestMutation(async () => {
      assert.deepEqual(h.committedActivity("a"), [1, 2], "flushed before the mutation ran");
      const manifest = await h.store.load();
      const next = await h.store.write(h.authority.generation,
        manifest.entries.map((candidate) => candidate.id === "a" ? { ...candidate, observed_state: "failed" } : candidate),
        (commit) => h.authority.fenceDaemonCommit(commit));
      h.authority.generation = next.generation;
    });
    assert.deepEqual(h.commits, [2]);
    const a = await h.store.getEntry("a");
    assert.equal(a?.observed_state, "failed");
    assert.deepEqual(a?.activity?.map((item) => item.sequence), [1, 2], "the full write kept the flushed events");
    // The window timer was cancelled by that flush and writes nothing more.
    for (const timer of h.timers.filter((candidate) => !candidate.cleared)) timer.callback();
    await h.authority.serializeManifestMutationWithoutFlush(async () => undefined);
    assert.deepEqual(h.commits, [2]);
  } finally { await h.cleanup(); }
});

test("the provider stream's own reads see its pending events", async () => {
  const h = await harness();
  try {
    await h.coordinator.appendNativeActivity("a", event(1, "working"), false);
    const committed = await h.store.getEntry("a");
    assert.deepEqual(committed?.activity, [], "other readers see committed state only");
    const overlaid = h.batcher.overlay(committed);
    assert.deepEqual(overlaid?.activity?.map((item) => item.sequence), [1]);
    assert.equal(overlaid?.observed_state, "working");
    assert.equal(overlaid?.native_liveness?.state, "active");
    await h.fireWindow();
    const after = h.batcher.overlay(await h.store.getEntry("a"));
    assert.deepEqual(after?.activity?.map((item) => item.sequence), [1], "no duplicate once committed");
  } finally { await h.cleanup(); }
});

test("close writes pending events, then refuses new ones and never writes again", async () => {
  const h = await harness();
  try {
    await h.coordinator.appendNativeActivity("a", event(1), false);
    await h.coordinator.appendNativeActivity("b", event(1), false);
    await h.batcher.close();
    assert.deepEqual(h.commits, [2]);
    assert.deepEqual(h.committedActivity("a"), [1]);
    await assert.rejects(h.coordinator.appendNativeActivity("a", event(2), false), /closed/);
    // A stale window timer firing after close writes nothing.
    for (const timer of h.timers) timer.callback();
    await h.batcher.flush();
    await h.authority.serializeManifestMutation(async () => undefined);
    assert.deepEqual(h.commits, [2]);
    assert.deepEqual(h.diagnostics, []);
  } finally { await h.cleanup(); }
});

test("close gives up when the manifest lane stays busy, and the late flush writes nothing", async () => {
  const h = await harness({ closeTimeoutMs: 25 });
  let releaseLane!: () => void;
  try {
    await h.coordinator.appendNativeActivity("a", event(1), false);
    const busy = h.authority.serializeManifestMutationWithoutFlush(() => new Promise<void>((resolve) => { releaseLane = resolve; }));
    const closing = h.batcher.close();
    const closeTimer = h.timers.find((timer) => timer.ms === 25);
    assert.ok(closeTimer);
    closeTimer.callback();
    await closing;
    assert.equal(h.diagnostics.at(-1)?.dropped, 1);
    releaseLane();
    await busy;
    await h.authority.serializeManifestMutationWithoutFlush(async () => undefined);
    assert.deepEqual(h.commits, [], "nothing is written after close");
    assert.deepEqual(h.committedActivity("a"), []);
  } finally { releaseLane?.(); await h.cleanup(); }
});

test("a batch whose commit is fenced is dropped without failing the mutation that flushed it", async () => {
  const h = await harness();
  try {
    await h.coordinator.appendNativeActivity("a", event(1), false);
    h.fence();
    const result = await h.authority.serializeManifestMutation(async () => "ran");
    assert.equal(result, "ran");
    assert.equal(h.diagnostics.length, 1);
    assert.equal(h.diagnostics[0]!.dropped, 1);
    assert.deepEqual(h.committedActivity("a"), [], "nothing is written after authority is fenced");
    assert.equal(h.notifications.length, 0);
  } finally { await h.cleanup(); }
});

test("a batch skips an entry removed before the flush instead of failing the others", async () => {
  const h = await harness();
  try {
    const items = [
      { agentId: "a", event: event(1), runtimeUpdate: null, limit: 200 },
      { agentId: "gone", event: event(1), runtimeUpdate: null, limit: 200 },
      { agentId: "b", event: event(1), runtimeUpdate: null, limit: 200 },
    ];
    const result = await h.store.recordActivityBatch(h.authority.generation, items);
    h.authority.generation = result.generation;
    assert.deepEqual({ written: result.written, skipped: result.skipped }, { written: 2, skipped: 1 });
    assert.deepEqual(h.committedActivity("a"), [1]);
    assert.deepEqual(h.committedActivity("b"), [1]);
  } finally { await h.cleanup(); }
});

test("a window flush after authority is lost drops the batch and never rejects", async () => {
  const h = await harness();
  try {
    await h.coordinator.appendNativeActivity("a", event(1), false);
    h.lose();
    const timer = h.timers.find((candidate) => !candidate.cleared);
    assert.ok(timer);
    timer.callback();
    await h.batcher.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.batcher.size, 0);
    assert.equal(h.diagnostics.at(-1)?.dropped, 1);
    assert.deepEqual(h.commits, []);
    assert.deepEqual(h.committedActivity("a"), []);
  } finally { await h.cleanup(); }
});

function sqliteError(errcode: number, errstr: string): Error {
  return Object.assign(new Error(errstr), { code: "ERR_SQLITE_ERROR", errcode, errstr });
}

test("a failed batch is retried event by event, so one bad event costs only itself", async () => {
  let failBatches = true;
  const h = await harness({
    beforeCommit: async (items) => {
      // A batch-wide failure caused by one event's content (a constraint), and
      // that event failing again on its own.
      if (failBatches && items.length > 1) throw sqliteError(1555, "UNIQUE constraint failed");
      if (items.some((item) => item.agentId === "b" && item.event.sequence === 2)) throw sqliteError(275, "CHECK constraint failed");
    },
  });
  try {
    await h.coordinator.appendNativeActivity("a", event(1), false);
    await h.coordinator.appendNativeActivity("b", event(1), false);
    await h.coordinator.appendNativeActivity("b", event(2), false);
    await h.coordinator.appendNativeActivity("a", event(2), false);
    await h.fireWindow();
    assert.deepEqual(h.commits, [1, 1, 1], "each event retried once on its own; the bad one never reached the store");
    assert.deepEqual(h.committedActivity("a"), [1, 2]);
    assert.deepEqual(h.committedActivity("b"), [1]);
    assert.equal(h.diagnostics.length, 1);
    assert.equal(h.diagnostics[0]!.dropped, 1);
    assert.match(String(h.diagnostics[0]!.error), /constraint failed/);
    failBatches = false;
  } finally { await h.cleanup(); }
});

test("close waits for a batch already in flight inside another mutation", async () => {
  let releaseCommit!: () => void;
  let commitStarted!: () => void;
  const started = new Promise<void>((resolve) => { commitStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const h = await harness({ beforeCommit: async () => { commitStarted(); await gate; } });
  try {
    await h.coordinator.appendNativeActivity("a", event(1), false);
    // Another mutation flushes first; its batch is now in flight and nothing is pending.
    const mutation = h.authority.serializeManifestMutation(async () => "done");
    await started;
    assert.equal(h.batcher.size, 1);
    let closed = false;
    const closing = h.batcher.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false, "close does not return while the batch is in flight");
    releaseCommit();
    await closing;
    assert.equal(await mutation, "done");
    assert.deepEqual(h.committedActivity("a"), [1], "the in-flight batch committed before close returned");
    assert.deepEqual(h.diagnostics, []);
  } finally { releaseCommit?.(); await h.cleanup(); }
});

test("only failures that belong to one event are retried event by event", () => {
  assert.equal(isSingleEventActivityError(sqliteError(1555, "UNIQUE constraint failed")), true);
  assert.equal(isSingleEventActivityError(sqliteError(18, "string or blob too big")), true);
  assert.equal(isSingleEventActivityError(new TypeError("Do not know how to serialize a BigInt")), true);
  assert.equal(isSingleEventActivityError(sqliteError(5, "database is locked")), false);
  assert.equal(isSingleEventActivityError(sqliteError(517, "database is locked")), false);
  assert.equal(isSingleEventActivityError(sqliteError(10, "disk I/O error")), false);
  assert.equal(isSingleEventActivityError(new ManifestConflictError("Manifest generation 9 does not match expected 8.")), false);
  assert.equal(isSingleEventActivityError(new DaemonFenceLostError("fence lost")), false);
});

for (const [name, failure] of [
  ["a busy database", () => sqliteError(5, "database is locked")],
  ["a generation conflict", () => new ManifestConflictError("Manifest generation 9 does not match expected 8.")],
] as const) {
  test(`${name} drops the batch at once, with no per-event retry`, async () => {
    let attempts = 0;
    const h = await harness({ beforeCommit: async () => { attempts += 1; throw failure(); } });
    try {
      for (let sequence = 1; sequence <= 10; sequence += 1) await h.coordinator.appendNativeActivity("a", event(sequence), false);
      const started = Date.now();
      await h.fireWindow();
      assert.equal(attempts, 1, "one attempt for the whole batch");
      assert.ok(Date.now() - started < 1_000, "the lane is released quickly");
      assert.deepEqual(h.diagnostics.map((entry) => entry.dropped), [10]);
      assert.deepEqual(h.committedActivity("a"), []);
      // The lane is free for the next mutation.
      assert.equal(await h.authority.serializeManifestMutation(async () => "next"), "next");
    } finally { await h.cleanup(); }
  });
}

test("the per-event retry stops when its time budget is spent", async () => {
  let clock = 0;
  let attempts = 0;
  const h = await harness({
    retryBudgetMs: 250,
    now: () => clock,
    beforeCommit: async () => { attempts += 1; clock += 100; throw sqliteError(1555, "UNIQUE constraint failed"); },
  });
  try {
    for (let sequence = 1; sequence <= 10; sequence += 1) await h.coordinator.appendNativeActivity("a", event(sequence), false);
    await h.fireWindow();
    assert.ok(attempts <= 5, `attempts ${attempts}`);
    assert.equal(h.diagnostics.reduce((sum, entry) => sum + entry.dropped, 0), 10, "every event is accounted for");
  } finally { await h.cleanup(); }
});

test("activity of an entry whose provider birth was checkpointed is never written after it", async () => {
  const h = await harness();
  try {
    await h.coordinator.appendNativeActivity("a", event(1, "working"), false);
    await h.coordinator.appendNativeActivity("b", event(1, "working"), false);
    // An in-flight batch skips the entry inside its transaction too.
    const result = await h.store.recordActivityBatch(h.authority.generation,
      [{ agentId: "a", event: event(5), runtimeUpdate: null, limit: 200 }], undefined, () => false);
    h.authority.generation = result.generation;
    assert.equal(result.skipped, 1);
    h.batcher.retireEntry("a");
    assert.equal(h.batcher.mayWrite("a"), false);
    assert.equal(h.batcher.pendingState("a"), null, "its pending events are dropped");
    await h.fireWindow();
    assert.deepEqual(h.committedActivity("a"), []);
    assert.deepEqual(h.committedActivity("b"), [1], "other entries are unaffected");
  } finally { await h.cleanup(); }
});
