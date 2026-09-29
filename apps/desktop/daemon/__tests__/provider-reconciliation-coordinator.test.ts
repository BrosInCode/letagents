import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderActionHandle,
  ProviderActionPort,
} from "../provider-action-port.js";
import {
  ProviderReconciliationCoordinator,
  type DaemonReconcileInput,
} from "../provider-reconciliation-coordinator.js";
import type { DaemonManifestEntry } from "../types.js";

const handle = (pid: number, state: ProviderActionHandle["observedState"]): ProviderActionHandle => ({
  workAttemptId: "attempt-1",
  pid,
  providerContinuationId: `continuation-${pid}`,
  observedState: state,
});

const manifestEntry = (): DaemonManifestEntry => ({
  id: "agent-1",
  room_id: "room-1",
  display_name: "Agent",
  provider: "codex",
  model: null,
  charter: "Help",
  desired_state: "running",
  observed_state: "failed",
  condition: "none",
  permission_profile_id: "supervised",
  created_by: "test",
  created_at: "2026-08-26T00:00:00.000Z",
  work_attempt_id: "attempt-1",
});

const reconcileInput = (current: ProviderActionHandle): DaemonReconcileInput => ({
  reconciliationActionId: "action-1",
  reconciliationActionSequence: 1,
  workAttemptId: "attempt-1",
  spawn: {
    workAttemptId: "attempt-1",
    roomId: "room-1",
    cwd: "/tmp/work",
    launchPolicy: {},
  },
  handle: current,
  resumeFrom: null,
  nowMs: 1_000,
  lastPollAtMs: null,
  addressedMessagesWaiting: 0,
  pokeIgnored: false,
  activeLease: false,
  fencedRebindProven: false,
});

function provider(overrides: Partial<ProviderActionPort> = {}): ProviderActionPort {
  return {
    capabilities: async () => ({
      resume: false,
      midTurnInjection: false,
      transcriptAccess: false,
      permissionPromptBridging: false,
      survivesRestart: false,
    }),
    spawn: async () => handle(2, "working"),
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => handle(2, "working"),
    poke: async () => {},
    stop: async (current) => ({
      endedAt: "2026-08-26T00:00:00.000Z",
      exitCode: 0,
      signal: null,
      terminalCause: "stopped",
      providerContinuationId: current.providerContinuationId,
    }),
    onExit: async () => () => {},
    ...overrides,
  };
}

test("pending ambiguous native actions hold before any redispatch", async () => {
  let entry = manifestEntry();
  entry = {
    ...entry,
    reconciliation: {
      exit_timestamps_ms: [],
      consecutive_action_failures: 0,
      last_observed_state: "failed",
      next_restart_at_ms: null,
      last_action_sequence: 3,
      pending_action: {
        id: "pending-3",
        sequence: 3,
        kind: "restart_fresh",
        recorded_at_ms: 900,
      },
      completed_action_ids: [],
    },
  };
  let spawns = 0;
  const transitions: string[] = [];
  const coordinator = new ProviderReconciliationCoordinator({
    provider: provider({
      attachAction: async () => ({ state: "ambiguous", reason: "native receipt missing" }),
      spawn: async () => { spawns += 1; return handle(2, "working"); },
    }),
    store: {
      getEntry: async () => entry,
      load: async () => ({ entries: [entry] }),
      replaceEntriesBatch: async (_generation, entries) => {
        entry = entries[0]!;
        return { generation: 2 };
      },
    },
    authority: {
      assertCurrent: async () => {},
      currentManifestGeneration: () => 1,
      acceptManifestGeneration: () => {},
      fenceCommit: async (commit) => { await commit(); },
      serializeManifest: async (operation) => operation(),
    },
    serializeEntry: async (_entryId, operation) => operation(),
    transitionOnce: async (_entryId, observed, condition, cause, _actor, reconciliation) => {
      transitions.push(cause);
      entry = { ...entry, observed_state: observed, condition, reconciliation };
    },
    terminalPayload: (terminal, actor) => ({
      ended_at: terminal.endedAt,
      exit_code: terminal.exitCode,
      signal: terminal.signal,
      stdio_archive_ref: null,
      stdio_tail: "",
      terminal_cause: terminal.terminalCause,
      actor,
      generation: 1,
      provider_continuation_id: terminal.providerContinuationId,
    }),
    observeProviderExit: async () => {},
    recordSchedulerFailure: async () => {},
    nowMs: () => 1_000,
  });

  const result = await coordinator.reconcile("agent-1", reconcileInput(handle(1, "failed")), 5_000);
  assert.equal(result.disposition, "held");
  assert.equal(result.decision.action, "hold_coordination");
  assert.equal(spawns, 0);
  assert.deepEqual(transitions, ["pending provider action ambiguous: native receipt missing"]);
});

test("replacement listener failure retains the predecessor and retries the promoted handle without redispatch", async () => {
  let entry: DaemonManifestEntry = {
    ...manifestEntry(),
    reconciliation: {
      exit_timestamps_ms: [500],
      consecutive_action_failures: 1,
      last_observed_state: "failed",
      next_restart_at_ms: null,
      completed_action_ids: [],
      last_action_sequence: 0,
      pending_action: null,
    },
  };
  let generation = 1;
  let spawnCalls = 0;
  let replacementListenerCalls = 0;
  let predecessorDisposed = 0;
  let replacementDisposed = 0;
  const schedulerErrors: string[] = [];
  let intervalCallback: (() => void) | null = null;
  const initial = handle(1, "failed");
  const replacement = handle(2, "working");
  const coordinator = new ProviderReconciliationCoordinator({
    provider: provider({
      spawn: async () => { spawnCalls += 1; return replacement; },
      onExit: async (installed) => {
        if (installed.pid === 1) return () => { predecessorDisposed += 1; };
        replacementListenerCalls += 1;
        if (replacementListenerCalls === 1) throw new Error("bridge unavailable");
        return () => { replacementDisposed += 1; };
      },
    }),
    store: {
      getEntry: async () => entry,
      load: async () => ({ entries: [entry] }),
      replaceEntriesBatch: async (_expected, entries) => {
        entry = entries[0]!;
        generation += 1;
        return { generation };
      },
    },
    authority: {
      assertCurrent: async () => {},
      currentManifestGeneration: () => generation,
      acceptManifestGeneration: (next) => { generation = next; },
      fenceCommit: async (commit) => { await commit(); },
      serializeManifest: async (operation) => operation(),
    },
    serializeEntry: async (_entryId, operation) => operation(),
    transitionOnce: async (_entryId, observed, condition, _cause, _actor, reconciliation) => {
      entry = { ...entry, observed_state: observed, condition, reconciliation };
    },
    terminalPayload: (terminal, actor) => ({
      ended_at: terminal.endedAt,
      exit_code: terminal.exitCode,
      signal: terminal.signal,
      stdio_archive_ref: null,
      stdio_tail: "",
      terminal_cause: terminal.terminalCause,
      actor,
      generation: 1,
      provider_continuation_id: terminal.providerContinuationId,
    }),
    observeProviderExit: async () => {},
    recordSchedulerFailure: async (_entryId, error) => {
      schedulerErrors.push(error instanceof Error ? error.message : String(error));
    },
    nowMs: () => 1_000,
    setInterval: ((callback: () => void) => {
      intervalCallback = callback;
      return { unref() {} };
    }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });

  const dispose = await coordinator.schedule(
    "agent-1",
    initial,
    () => reconcileInput(initial),
    5_000,
    60_000,
  );
  assert.equal(spawnCalls, 1);
  assert.equal(replacementListenerCalls, 1);
  assert.equal(predecessorDisposed, 0, "failed replacement registration keeps the old listener");
  assert.deepEqual(schedulerErrors, ["bridge unavailable"]);

  intervalCallback!();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacementListenerCalls, 2, "the promoted replacement listener is retried");
  assert.equal(spawnCalls, 1, "listener retry never launches another provider");
  assert.equal(predecessorDisposed, 1, "old listener is retired only after replacement succeeds");

  await dispose();
  assert.equal(replacementDisposed, 1);
});

function cleanupHarness(input: {
  entryIds: string[];
  onExit: ProviderActionPort["onExit"];
  observeProviderExit?: () => Promise<void>;
}) {
  let generation = 1;
  const entries = new Map<string, DaemonManifestEntry>(input.entryIds.map((id) => [id, {
    ...manifestEntry(),
    id,
    observed_state: "working" as const,
  }]));
  const coordinator = new ProviderReconciliationCoordinator({
    provider: provider({ onExit: input.onExit }),
    store: {
      getEntry: async (entryId) => entries.get(entryId),
      load: async () => ({ entries: [...entries.values()] }),
      replaceEntriesBatch: async (_expected, replacements) => {
        for (const replacement of replacements) entries.set(replacement.id, replacement);
        generation += 1;
        return { generation };
      },
    },
    authority: {
      assertCurrent: async () => {},
      currentManifestGeneration: () => generation,
      acceptManifestGeneration: (next) => { generation = next; },
      fenceCommit: async (commit) => { await commit(); },
      serializeManifest: async (operation) => operation(),
    },
    serializeEntry: async (_entryId, operation) => operation(),
    transitionOnce: async (entryId, observed, condition, _cause, _actor, reconciliation) => {
      const current = entries.get(entryId)!;
      entries.set(entryId, { ...current, observed_state: observed, condition, reconciliation });
    },
    terminalPayload: (value, actor) => ({
      ended_at: value.endedAt,
      exit_code: value.exitCode,
      signal: value.signal,
      stdio_archive_ref: null,
      stdio_tail: "",
      terminal_cause: value.terminalCause,
      actor,
      generation: 1,
      provider_continuation_id: value.providerContinuationId,
    }),
    observeProviderExit: async () => { await input.observeProviderExit?.(); },
    recordSchedulerFailure: async () => {},
    nowMs: () => 1_000,
    setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  });
  return coordinator;
}

test("disposeAll snapshots reservations and waits for admitted provider-exit callbacks", async () => {
  let listener: ((value: ReturnType<typeof terminalForTest>) => void) | null = null;
  let releaseCallback!: () => void;
  const callbackBlocked = new Promise<void>((resolve) => { releaseCallback = resolve; });
  const coordinator = cleanupHarness({
    entryIds: ["agent-a"],
    onExit: async (_handle, nextListener) => {
      listener = nextListener;
      return () => {};
    },
    observeProviderExit: async () => callbackBlocked,
  });
  const current = handle(10, "working");
  await coordinator.schedule(
    "agent-a",
    current,
    () => reconcileInput(current),
    5_000,
    60_000,
  );
  listener!(terminalForTest(current));
  await new Promise((resolve) => setImmediate(resolve));

  let disposed = false;
  const disposal = coordinator.disposeAll().then(() => { disposed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, false, "normal stop drains the admitted callback before stores close");
  releaseCallback();
  await disposal;
  assert.equal(disposed, true);
});

test("disposeAll invokes every scheduled disposer when one unsubscribe throws", async () => {
  const unsubscribed: string[] = [];
  const coordinator = cleanupHarness({
    entryIds: ["agent-a", "agent-b"],
    onExit: async (current) => () => {
      unsubscribed.push(String(current.pid));
      if (current.pid === 10) throw new Error("first unsubscribe failed");
    },
  });
  for (const [entryId, pid] of [["agent-a", 10], ["agent-b", 20]] as const) {
    const current = handle(pid, "working");
    await coordinator.schedule(
      entryId,
      current,
      () => reconcileInput(current),
      5_000,
      60_000,
    );
  }

  await assert.rejects(() => coordinator.disposeAll(), /first unsubscribe failed/);
  assert.deepEqual(unsubscribed, ["10", "20"]);
});

function terminalForTest(current: ProviderActionHandle) {
  return {
    endedAt: "2026-08-26T00:00:00.000Z",
    exitCode: 0,
    signal: null,
    terminalCause: "stopped" as const,
    providerContinuationId: current.providerContinuationId,
  };
}
