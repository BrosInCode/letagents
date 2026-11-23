import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRecoveryTimerBookkeeping,
  computeCappedBackoffMs,
  CRASH_LOOP_QUARANTINE_CAUSE,
  CURSOR_ATTACH_IN_PROGRESS_CAUSE,
  CURSOR_ATTACH_RETRY_MS,
  CURSOR_BLOCKED_DELIVERY_FALLBACK_CAUSE,
  decide,
  detachConvergenceBookkeeping,
  INCOMPLETE_PROCESS_REF_ERROR,
  initialVolatileConvergeBookkeeping,
  projectPersistedConvergeControl,
  recordedProcessState,
  RETIREMENT_SETTLEMENT_WAIT_MS,
  STOPPED_WITHOUT_PROVIDER_CAUSE,
  turnInFlight,
  UNATTACHABLE_GENERATION_CAUSE,
  UNATTACHABLE_GENERATION_RECHECK_MAX_MS,
  UNATTACHABLE_GENERATION_RECHECK_MS,
  UNPROVEN_PREDECESSOR_CAUSE,
  WORKSPACE_REPOSITORY_RETRY_MAX_MS,
  WORKSPACE_REPOSITORY_RETRY_MS,
  type ConvergeState,
  type PersistedConvergeControl,
  type VolatileConvergeBookkeeping,
} from "../convergence-decision.js";
import { CRASH_LOOP_WINDOW_MS } from "../reconciler-policy.js";
import { advanceReconciliationState } from "../reconciler-state.js";
import type { DaemonManifestEntry } from "../types.js";

function makePersisted(
  overrides: Partial<PersistedConvergeControl> = {},
): PersistedConvergeControl {
  return {
    agentId: "agent-1",
    roomId: "room-1",
    provider: "codex",
    deliveryMode: "daemon_inbox",
    desiredState: "running",
    observedState: "absent",
    condition: "none",
    lastError: null,
    workAttemptId: "attempt-1",
    providerRef: null,
    hasPendingTurnControl: false,
    turnControlWorkAttemptMatches: false,
    reconciliation: {
      exitTimestampsMs: [],
      nextRestartAtMs: null,
    },
    isRental: false,
    ...overrides,
  };
}

function makeState(
  persistedOverrides: Partial<PersistedConvergeControl> = {},
  volatileOverrides: Partial<VolatileConvergeBookkeeping> = {},
): ConvergeState {
  return {
    persisted: makePersisted(persistedOverrides),
    volatile: {
      ...initialVolatileConvergeBookkeeping(),
      ...volatileOverrides,
    },
  };
}

test("pure helpers: recordedProcessState, turnInFlight, backoff, projection, and bookkeeping resets", () => {
  assert.equal(recordedProcessState(null), "none");
  assert.equal(recordedProcessState(undefined), "none");
  assert.equal(recordedProcessState({ pid: null, processIdentity: null }), "none");
  assert.equal(recordedProcessState({ pid: 4242, processIdentity: "birth-4242" }), "exact");
  assert.equal(recordedProcessState({ pid: 4242, processIdentity: null }), "incomplete");
  assert.equal(recordedProcessState({ pid: 4242, processIdentity: "  " }), "incomplete");
  assert.equal(recordedProcessState({ pid: 0, processIdentity: "birth-0" }), "incomplete");
  assert.equal(recordedProcessState({ pid: -5, processIdentity: "birth-neg" }), "incomplete");

  const started = { provider_turn_id: "turn-1", outcome: null };
  const untouched = { provider_turn_id: null, outcome: null };
  for (const [label, head, expected] of [
    ["dispatching", { state: "dispatching", ...started }, true],
    ["dispatching without turn id", { state: "dispatching", ...untouched }, true],
    ["awaiting_result", { state: "awaiting_result", ...started }, true],
    ["result_recovery", { state: "result_recovery", ...started }, true],
    ["pending with started turn", { state: "pending", ...started }, true],
    ["pending untouched", { state: "pending", ...untouched }, false],
    ["pending with saved result", { state: "pending", provider_turn_id: "turn-1", outcome: "reply" }, false],
    ["publishing", { state: "publishing", provider_turn_id: "turn-1", outcome: "reply" }, false],
    ["blocked", { state: "blocked", ...started }, false],
    ["retryable", { state: "retryable", ...untouched }, false],
    ["empty inbox", null, false],
  ] as const) {
    assert.equal(turnInFlight(head), expected, label);
  }

  assert.equal(computeCappedBackoffMs(1, WORKSPACE_REPOSITORY_RETRY_MS, WORKSPACE_REPOSITORY_RETRY_MAX_MS), 5_000);
  assert.equal(computeCappedBackoffMs(7, WORKSPACE_REPOSITORY_RETRY_MS, WORKSPACE_REPOSITORY_RETRY_MAX_MS), 300_000);
  assert.equal(computeCappedBackoffMs(6, UNATTACHABLE_GENERATION_RECHECK_MS, UNATTACHABLE_GENERATION_RECHECK_MAX_MS), 1_800_000);

  const entry: DaemonManifestEntry = {
    id: "supervised_rental_1",
    room_id: "room-1",
    display_name: "Rental",
    provider: "cursor",
    model: null,
    charter: "secret-free-charter",
    desired_state: "running",
    observed_state: "idle",
    condition: "none",
    permission_profile_id: "read_only",
    provider_launch_policy: {},
    created_by: "test",
    created_at: "2026-08-26T00:00:00.000Z",
    work_attempt_id: "attempt-1",
    activity: [{
      observed_at: "2026-08-26T00:00:01.000Z",
      sequence: 1,
      provider: "cursor",
      kind: "launch_notice",
      method: "workspace_boundary",
      summary: "notice",
      status: "idle",
      payload: {},
      payload_truncated: false,
      payload_redacted: false,
      durable_payload_ref: null,
    }],
  };
  const projected = projectPersistedConvergeControl(entry);
  assert.equal(projected.isRental, true);
  assert.equal("activity" in projected, false);
  assert.equal("charter" in projected, false);

  const populated: VolatileConvergeBookkeeping = {
    failedLaunchAdmissionKey: "sha256-digest",
    unattachableRechecks: 3,
    workspaceRepositoryRetries: 4,
    recoveryDueAtMs: 50_000,
    retirementDeadline: { handleToken: 9, dueAtMs: 80_000 },
  };
  assert.deepEqual(clearRecoveryTimerBookkeeping(populated), {
    failedLaunchAdmissionKey: "sha256-digest",
    unattachableRechecks: 0,
    workspaceRepositoryRetries: 0,
    recoveryDueAtMs: null,
    retirementDeadline: { handleToken: 9, dueAtMs: 80_000 },
  });
  assert.deepEqual(detachConvergenceBookkeeping(populated), {
    failedLaunchAdmissionKey: null,
    unattachableRechecks: 3,
    workspaceRepositoryRetries: 4,
    recoveryDueAtMs: 50_000,
    retirementDeadline: { handleToken: 9, dueAtMs: 80_000 },
  });
});

test("running gate enforces crash-loop limit, restart backoff, and quarantine without clocks or timers", () => {
  // Five failed endings within window: first 4 wait for backoff then proceed; 5th quarantines.
  let nowMs = 10_000_000;
  let reconciliation: DaemonManifestEntry["reconciliation"] = undefined;
  let volatile = initialVolatileConvergeBookkeeping();

  for (let ending = 1; ending <= 5; ending += 1) {
    reconciliation = advanceReconciliationState(reconciliation, "failed", nowMs);
    const failedState: ConvergeState = {
      persisted: makePersisted({
        observedState: "failed",
        reconciliation: {
          exitTimestampsMs: [...reconciliation.exit_timestamps_ms],
          nextRestartAtMs: reconciliation.next_restart_at_ms ?? null,
        },
      }),
      volatile,
    };

    const beforeBackoff = decide(failedState, {
      kind: "running_gate_checked",
      nowMs,
      requiresGrant: false,
      hasGrant: true,
      grantFresh: true,
      hasMatchingInboxCursor: true,
    });
    if (ending < 5) {
      assert.equal(beforeBackoff.transition, undefined);
      assert.equal(beforeBackoff.commands.length, 1);
      assert.equal(beforeBackoff.commands[0]?.kind, "schedule_recovery");
      volatile = { ...beforeBackoff.volatile, recoveryDueAtMs: null };

      nowMs += 10_000;
      const afterBackoff = decide(
        { persisted: failedState.persisted, volatile },
        {
          kind: "running_gate_checked",
          nowMs,
          requiresGrant: false,
          hasGrant: true,
          grantFresh: true,
          hasMatchingInboxCursor: true,
        },
      );
      assert.deepEqual(afterBackoff.commands, [{ kind: "proceed_running" }]);
      reconciliation = advanceReconciliationState(reconciliation, "idle", nowMs);
      volatile = afterBackoff.volatile;
    } else {
      assert.deepEqual(beforeBackoff.transition, {
        observedState: "failed",
        condition: "quarantined",
        cause: CRASH_LOOP_QUARANTINE_CAUSE,
        actor: "daemon-convergence",
      });
      assert.deepEqual(beforeBackoff.commands, []);
    }
  }

  // Once quarantined, later ticks do nothing even after waiting.
  const quarantined = decide(
    makeState({ observedState: "failed", condition: "quarantined" }),
    {
      kind: "running_gate_checked",
      nowMs: nowMs + 60_000,
      requiresGrant: false,
      hasGrant: true,
      grantFresh: true,
      hasMatchingInboxCursor: true,
    },
  );
  assert.equal(quarantined.transition, undefined);
  assert.deepEqual(quarantined.commands, []);

  // Cursor protocol-error crash loop also quarantines on 5 exits in window.
  const cursorNow = 20_000_000;
  let cursorRec: DaemonManifestEntry["reconciliation"] = undefined;
  for (let i = 0; i < 5; i += 1) {
    cursorRec = advanceReconciliationState(
      advanceReconciliationState(cursorRec, "idle", cursorNow - 60_000 + i),
      "failed",
      cursorNow - 60_000 + i,
    );
  }
  const cursorDecision = decide(
    makeState({
      provider: "cursor",
      observedState: "failed",
      reconciliation: {
        exitTimestampsMs: [...cursorRec!.exit_timestamps_ms],
        nextRestartAtMs: cursorRec!.next_restart_at_ms ?? null,
      },
    }),
    {
      kind: "running_gate_checked",
      nowMs: cursorNow,
      requiresGrant: false,
      hasGrant: true,
      grantFresh: true,
      hasMatchingInboxCursor: true,
    },
  );
  assert.equal(cursorDecision.transition?.condition, "quarantined");
  assert.deepEqual(cursorDecision.commands, []);

  // Exits older than CRASH_LOOP_WINDOW_MS age out and allow restart.
  const agedOut = decide(
    makeState({
      observedState: "failed",
      reconciliation: {
        exitTimestampsMs: [1_000, 2_000, 3_000, 4_000, 5_000],
        nextRestartAtMs: 10_000,
      },
    }),
    {
      kind: "running_gate_checked",
      nowMs: 5_000 + CRASH_LOOP_WINDOW_MS + 1,
      requiresGrant: false,
      hasGrant: true,
      grantFresh: true,
      hasMatchingInboxCursor: true,
    },
  );
  assert.equal(agedOut.transition, undefined);
  assert.deepEqual(agedOut.commands, [{ kind: "proceed_running" }]);
});

test("ended runtime retirement waits for in-flight turn or bounded deadline per handle token", () => {
  for (const [typed, entryState] of [
    [true, "working"],
    [true, "failed"],
    [false, "working"],
  ] as const) {
    for (const ending of ["recorded", "expired"] as const) {
      const label = `typed=${typed} entry=${entryState} ending=${ending}`;
      let nowMs = 10_000_000;
      let persisted = makePersisted({
        observedState: entryState,
        providerRef: {
          workAttemptId: "attempt-1",
          executionGenerationId: "generation-1",
          providerContinuationId: "continuation-1",
          providerConnectionKind: "codex_app_server",
          recordedProcessState: "exact",
          hasProviderConnection: true,
        },
      });
      let volatile = initialVolatileConvergeBookkeeping();

      const first = decide({ persisted, volatile }, {
        kind: "attached_handle_evaluated",
        nowMs,
        handleToken: 1,
        handleObservedState: "failed",
        typed,
        requiresGrant: true,
        inboxHead: { state: "awaiting_result", provider_turn_id: "turn-1", outcome: null },
        roomRefusesAccess: false,
      });
      assert.equal(first.commands.some((c) => c.kind === "fence_terminal_handle"), false, `${label}: held while turn in flight`);
      assert.deepEqual(first.commands, [{
        kind: "schedule_recovery",
        delayMs: RETIREMENT_SETTLEMENT_WAIT_MS,
        dueAtMs: nowMs + RETIREMENT_SETTLEMENT_WAIT_MS,
        replaceExisting: false,
      }], `${label}: schedules bounded wait`);
      if (first.transition) {
        assert.equal(typed, false);
        persisted = { ...persisted, observedState: first.transition.observedState };
      }
      volatile = first.volatile;

      // Pass inside the wait extends nothing.
      nowMs += RETIREMENT_SETTLEMENT_WAIT_MS - 1;
      const mid = decide({ persisted, volatile }, {
        kind: "attached_handle_evaluated",
        nowMs,
        handleToken: 1,
        handleObservedState: "failed",
        typed,
        requiresGrant: true,
        inboxHead: { state: "awaiting_result", provider_turn_id: "turn-1", outcome: null },
        roomRefusesAccess: false,
      });
      assert.equal(mid.commands.some((c) => c.kind === "fence_terminal_handle"), false, `${label}: still held`);
      assert.equal(mid.volatile.retirementDeadline?.dueAtMs, 10_000_000 + RETIREMENT_SETTLEMENT_WAIT_MS);
      volatile = mid.volatile;

      const finalHead = ending === "recorded"
        ? { state: "pending", provider_turn_id: null, outcome: null }
        : { state: "awaiting_result", provider_turn_id: "turn-1", outcome: null };
      if (ending === "expired") nowMs += 1;
      const retired = decide({ persisted, volatile }, {
        kind: "attached_handle_evaluated",
        nowMs,
        handleToken: 1,
        handleObservedState: "failed",
        typed,
        requiresGrant: true,
        inboxHead: finalHead,
        roomRefusesAccess: false,
      });
      assert.deepEqual(retired.commands, [{
        kind: "fence_terminal_handle",
        actionId: "manifest:agent-1:reattached-terminal:generation-1",
      }], `${label}: retires once recorded or expired`);
    }
  }

  // Per-handle token: replacement runtime gets its own fresh wait, not the expired predecessor's.
  let nowMs = 10_000_000;
  const persisted = makePersisted({ observedState: "working" });
  const h1Start = decide({ persisted, volatile: initialVolatileConvergeBookkeeping() }, {
    kind: "attached_handle_evaluated",
    nowMs,
    handleToken: 1,
    handleObservedState: "failed",
    typed: true,
    requiresGrant: true,
    inboxHead: { state: "dispatching", provider_turn_id: "turn-1", outcome: null },
    roomRefusesAccess: false,
  });
  nowMs += RETIREMENT_SETTLEMENT_WAIT_MS;
  const h1End = decide({ persisted, volatile: h1Start.volatile }, {
    kind: "attached_handle_evaluated",
    nowMs,
    handleToken: 1,
    handleObservedState: "failed",
    typed: true,
    requiresGrant: true,
    inboxHead: { state: "dispatching", provider_turn_id: "turn-1", outcome: null },
    roomRefusesAccess: false,
  });
  assert.equal(h1End.commands[0]?.kind, "fence_terminal_handle");

  nowMs += 10 * RETIREMENT_SETTLEMENT_WAIT_MS;
  const h2Start = decide({ persisted, volatile: { ...h1End.volatile, recoveryDueAtMs: null } }, {
    kind: "attached_handle_evaluated",
    nowMs,
    handleToken: 2,
    handleObservedState: "failed",
    typed: true,
    requiresGrant: true,
    inboxHead: { state: "dispatching", provider_turn_id: "turn-2", outcome: null },
    roomRefusesAccess: false,
  });
  assert.equal(h2Start.commands[0]?.kind, "schedule_recovery");
  assert.equal(h2Start.volatile.retirementDeadline?.handleToken, 2);
  assert.equal(h2Start.volatile.retirementDeadline?.dueAtMs, nowMs + RETIREMENT_SETTLEMENT_WAIT_MS);

  nowMs += RETIREMENT_SETTLEMENT_WAIT_MS;
  const h2End = decide({ persisted, volatile: h2Start.volatile }, {
    kind: "attached_handle_evaluated",
    nowMs,
    handleToken: 2,
    handleObservedState: "failed",
    typed: true,
    requiresGrant: true,
    inboxHead: { state: "dispatching", provider_turn_id: "turn-2", outcome: null },
    roomRefusesAccess: false,
  });
  assert.equal(h2End.commands[0]?.kind, "fence_terminal_handle");
});

test("attached handle room-refusal hold and healthy typed lanes", () => {
  // Room refusal holds retirement when typed handle ended while entry is still working.
  const held = decide(makeState({ observedState: "working" }), {
    kind: "attached_handle_evaluated",
    nowMs: 1_000,
    handleToken: 1,
    handleObservedState: "failed",
    typed: true,
    requiresGrant: true,
    inboxHead: null,
    roomRefusesAccess: true,
  });
  assert.deepEqual(held.commands, []);

  // Entry itself already failed: room refusal does not hold replacement.
  const entryEnded = decide(makeState({ observedState: "failed" }), {
    kind: "attached_handle_evaluated",
    nowMs: 1_000,
    handleToken: 1,
    handleObservedState: "failed",
    typed: true,
    requiresGrant: true,
    inboxHead: null,
    roomRefusesAccess: true,
  });
  assert.equal(entryEnded.commands[0]?.kind, "fence_terminal_handle");

  // Failed Cursor handle on typed lane is owned by its exit path, never fenced here.
  const cursorFailed = decide(makeState({ provider: "cursor", observedState: "working" }), {
    kind: "attached_handle_evaluated",
    nowMs: 1_000,
    handleToken: 1,
    handleObservedState: "failed",
    typed: true,
    requiresGrant: true,
    inboxHead: null,
    roomRefusesAccess: false,
  });
  assert.deepEqual(cursorFailed.commands, [{ kind: "ensure_delivery_and_archive" }]);
});

test("unattachable live generation backs off from 60s to 30m with exactly one durable transition", () => {
  let persisted = makePersisted({ observedState: "absent", condition: "none", lastError: null });
  let volatile = initialVolatileConvergeBookkeeping();
  const delays: number[] = [];
  let transitions = 0;

  for (let pass = 0; pass < 7; pass += 1) {
    const decision = decide({ persisted, volatile: { ...volatile, recoveryDueAtMs: null } }, {
      kind: "launch_preconditions_checked",
      nowMs: 1_000 + pass * 1_000,
      hasActiveExecution: true,
      inboxHeadBlocked: false,
      inboxHeadLastError: null,
      predecessorHasTerminalWithoutWitness: false,
      predecessorExactStopAvailable: false,
    });
    if (decision.transition) {
      transitions += 1;
      persisted = {
        ...persisted,
        observedState: decision.transition.observedState,
        condition: decision.transition.condition,
        lastError: decision.transition.cause,
      };
    }
    const sched = decision.commands.find((c) => c.kind === "schedule_recovery");
    assert.ok(sched && sched.kind === "schedule_recovery");
    delays.push(sched.delayMs);
    volatile = decision.volatile;
  }

  assert.equal(transitions, 1);
  assert.equal(persisted.condition, "coordination_blocked");
  assert.equal(persisted.lastError, UNATTACHABLE_GENERATION_CAUSE);
  assert.deepEqual(delays, [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
});

test("room-only workspace retries back off 5s..300s and reset after success or Stop", () => {
  let volatile = initialVolatileConvergeBookkeeping();
  const persisted = makePersisted({ observedState: "absent", condition: "none" });
  const delays: number[] = [];
  let lastCause = "";

  for (let i = 0; i < 9; i += 1) {
    const d = decide({ persisted, volatile: { ...volatile, recoveryDueAtMs: null } }, {
      kind: "workspace_repository_checked",
      nowMs: 1_000,
      outcome: "failed",
      errorMessage: "EACCES",
    });
    assert.equal(d.transition?.observedState, "failed");
    assert.equal(d.transition?.condition, "coordination_blocked");
    lastCause = d.transition!.cause;
    const sched = d.commands.find((c) => c.kind === "schedule_recovery");
    assert.ok(sched && sched.kind === "schedule_recovery");
    delays.push(sched.delayMs);
    volatile = d.volatile;
  }
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  assert.equal(lastCause, "Could not prepare the agent's room-only workspace (EACCES). Retrying in 300 seconds.");

  // Success resets retry count and transitions to starting.
  const ok = decide({ persisted, volatile: { ...volatile, recoveryDueAtMs: null } }, {
    kind: "workspace_repository_checked",
    nowMs: 2_000,
    outcome: "ok",
  });
  assert.equal(ok.volatile.workspaceRepositoryRetries, 0);
  assert.equal(ok.transition?.observedState, "starting");
  assert.deepEqual(ok.commands, [{ kind: "proceed_spawn" }]);

  // Next failure starts again at 5s.
  const afterOkFail = decide({ persisted, volatile: { ...ok.volatile, recoveryDueAtMs: null } }, {
    kind: "workspace_repository_checked",
    nowMs: 3_000,
    outcome: "failed",
    errorMessage: "EROFS",
  });
  assert.equal(afterOkFail.commands[0]?.kind === "schedule_recovery" && afterOkFail.commands[0].delayMs, 5_000);
  assert.equal(
    afterOkFail.transition?.cause,
    "Could not prepare the agent's room-only workspace (EROFS). Retrying in 5 seconds.",
  );

  // Stop clears workspace retry counter back to 0.
  const stopped = decide(
    { persisted: makePersisted({ desiredState: "stopped" }), volatile: afterOkFail.volatile },
    { kind: "request_arrived", requestKind: "owned" },
  );
  assert.equal(stopped.volatile.workspaceRepositoryRetries, 0);
  const afterStopFail = decide({ persisted, volatile: { ...stopped.volatile, recoveryDueAtMs: null } }, {
    kind: "workspace_repository_checked",
    nowMs: 4_000,
    outcome: "failed",
    errorMessage: "EACCES",
  });
  assert.equal(afterStopFail.commands[0]?.kind === "schedule_recovery" && afterStopFail.commands[0].delayMs, 5_000);
});

test("earliest recovery deadline coalescing: sooner replaces later, later never replaces sooner", () => {
  const persisted = makePersisted();
  const s1 = decide(
    { persisted, volatile: initialVolatileConvergeBookkeeping() },
    { kind: "recovery_schedule_requested", nowMs: 1_000, delayMs: 60_000, hasPendingTimer: false },
  );
  assert.deepEqual(s1.commands, [{
    kind: "schedule_recovery",
    delayMs: 60_000,
    dueAtMs: 61_000,
    replaceExisting: false,
  }]);

  const s2 = decide(
    { persisted, volatile: s1.volatile },
    { kind: "recovery_schedule_requested", nowMs: 1_000, delayMs: 5_000, hasPendingTimer: true },
  );
  assert.deepEqual(s2.commands, [{
    kind: "schedule_recovery",
    delayMs: 5_000,
    dueAtMs: 6_000,
    replaceExisting: true,
  }]);

  const s3 = decide(
    { persisted, volatile: s2.volatile },
    { kind: "recovery_schedule_requested", nowMs: 1_000, delayMs: 60_000, hasPendingTimer: true },
  );
  assert.deepEqual(s3.commands, []);
  assert.equal(s3.volatile.recoveryDueAtMs, 6_000);

  const fired = decide({ persisted, volatile: s3.volatile }, { kind: "recovery_timer_fired" });
  assert.equal(fired.volatile.recoveryDueAtMs, null);
});

test("rehydration suppression, Cursor attach_in_progress, rental quarantine, capabilities, predecessor, and stop rules", () => {
  // Rehydration suppression with matching opaque digest vs owned clear vs changed digest.
  const failed = decide(makeState(), { kind: "launch_failed", admissionKey: "digest-a" });
  assert.equal(failed.volatile.failedLaunchAdmissionKey, "digest-a");
  assert.deepEqual(
    decide({ persisted: makePersisted(), volatile: failed.volatile }, {
      kind: "rehydration_admission_checked",
      requestKind: "rehydration",
      admissionKey: "digest-a",
    }).commands,
    [],
  );
  assert.deepEqual(
    decide({ persisted: makePersisted(), volatile: failed.volatile }, {
      kind: "rehydration_admission_checked",
      requestKind: "rehydration",
      admissionKey: "digest-b",
    }).commands,
    [{ kind: "proceed_launch_setup" }],
  );
  const ownedClear = decide(
    { persisted: makePersisted(), volatile: failed.volatile },
    { kind: "request_arrived", requestKind: "owned" },
  );
  assert.equal(ownedClear.volatile.failedLaunchAdmissionKey, null);

  // Cursor attach_in_progress schedules 250ms retry with recovering transition.
  const cursorAttach = decide(makeState({ provider: "cursor" }), {
    kind: "attach_in_progress",
    nowMs: 5_000,
  });
  assert.deepEqual(cursorAttach.transition, {
    observedState: "recovering",
    condition: "none",
    cause: CURSOR_ATTACH_IN_PROGRESS_CAUSE,
    actor: "daemon-convergence",
  });
  assert.deepEqual(cursorAttach.commands, [{
    kind: "schedule_recovery",
    delayMs: CURSOR_ATTACH_RETRY_MS,
    dueAtMs: 5_250,
    replaceExisting: false,
  }]);

  // Rental permission rejection commits quarantine transition + stop_delivery command.
  const rentalRejected = decide(makeState({ isRental: true }), {
    kind: "rental_permission_rejected",
    reason: "Unsafe rental profile",
  });
  assert.equal(rentalRejected.transition?.condition, "quarantined");
  assert.deepEqual(rentalRejected.commands, [{ kind: "stop_delivery" }]);

  // Cursor blocked inbox head on resumable lane blocks recovery with fallback cause.
  const cursorBlocked = decide(
    makeState({
      provider: "cursor",
      providerRef: {
        workAttemptId: "attempt-1",
        executionGenerationId: "gen-1",
        providerContinuationId: "cont-1",
        providerConnectionKind: "cursor_cli",
        recordedProcessState: "none",
        hasProviderConnection: true,
      },
    }),
    {
      kind: "launch_preconditions_checked",
      nowMs: 1_000,
      hasActiveExecution: false,
      inboxHeadBlocked: true,
      inboxHeadLastError: null,
      predecessorHasTerminalWithoutWitness: false,
      predecessorExactStopAvailable: false,
    },
  );
  assert.equal(cursorBlocked.transition?.cause, CURSOR_BLOCKED_DELIVERY_FALLBACK_CAUSE);
  assert.deepEqual(cursorBlocked.commands, []);

  // Unproven predecessor with incomplete ref blocks without retiring; exact ref retires; failure backs off.
  const incompletePred = decide(
    makeState({
      providerRef: {
        workAttemptId: "attempt-1",
        executionGenerationId: "gen-1",
        providerContinuationId: "cont-1",
        providerConnectionKind: "codex_app_server",
        recordedProcessState: "incomplete",
        hasProviderConnection: true,
      },
    }),
    {
      kind: "launch_preconditions_checked",
      nowMs: 1_000,
      hasActiveExecution: false,
      inboxHeadBlocked: false,
      inboxHeadLastError: null,
      predecessorHasTerminalWithoutWitness: true,
      predecessorExactStopAvailable: false,
    },
  );
  assert.equal(incompletePred.transition?.cause, UNPROVEN_PREDECESSOR_CAUSE);
  assert.equal(incompletePred.commands[0]?.kind, "log_unproven_predecessor");
  assert.equal(incompletePred.commands[0]?.kind === "log_unproven_predecessor" && incompletePred.commands[0].message, INCOMPLETE_PROCESS_REF_ERROR);
  assert.equal(incompletePred.commands[1]?.kind, "schedule_recovery");

  const exactPred = decide(
    makeState({
      providerRef: {
        workAttemptId: "attempt-1",
        executionGenerationId: "gen-1",
        providerContinuationId: "cont-1",
        providerConnectionKind: "codex_app_server",
        recordedProcessState: "exact",
        hasProviderConnection: true,
      },
    }),
    {
      kind: "launch_preconditions_checked",
      nowMs: 1_000,
      hasActiveExecution: false,
      inboxHeadBlocked: false,
      inboxHeadLastError: null,
      predecessorHasTerminalWithoutWitness: true,
      predecessorExactStopAvailable: true,
    },
  );
  assert.deepEqual(exactPred.commands, [{ kind: "retire_unproven_predecessor" }]);

  // Unsupported delivery mode transitions to failed/coordination_blocked.
  const unsupported = decide(makeState({ deliveryMode: "daemon_inbox" }), {
    kind: "capabilities_evaluated",
    supportedDeliveryModes: ["mcp_polling"],
    supportsResume: false,
    providerLabel: "Codex",
  });
  assert.equal(unsupported.transition?.observedState, "failed");
  assert.equal(unsupported.transition?.condition, "coordination_blocked");
  assert.equal(unsupported.transition?.cause, "Codex does not support daemon_inbox room delivery.");

  // Stop rules: incomplete ended generation fails closed; settled-at-target skips stopping transition; no provider converges cleanly.
  const stopIncomplete = decide(
    makeState({
      desiredState: "stopped",
      providerRef: {
        workAttemptId: "attempt-1",
        executionGenerationId: "gen-1",
        providerContinuationId: "cont-1",
        providerConnectionKind: "codex_app_server",
        recordedProcessState: "incomplete",
        hasProviderConnection: true,
      },
    }),
    {
      kind: "stop_requested",
      hasLiveHandle: false,
      exitSettling: false,
      hasStopRefCapability: true,
      hasExactProcessStopCapability: true,
      executionTerminal: "unwitnessed",
    },
  );
  assert.deepEqual(stopIncomplete.commands, [{ kind: "fail_stop", errorMessage: INCOMPLETE_PROCESS_REF_ERROR }]);

  const stopSettled = decide(
    makeState({ desiredState: "stopped", observedState: "stopped", condition: "none" }),
    { kind: "stop_unattached_exact_ref_prepared", alreadySettledTerminal: true },
  );
  assert.equal(stopSettled.transition, undefined);
  assert.deepEqual(stopSettled.commands, [{ kind: "execute_stop_ref", settledAtTarget: true }]);

  const stopNoProvider = decide(
    makeState({ desiredState: "paused", observedState: "idle" }),
    {
      kind: "stop_requested",
      hasLiveHandle: false,
      exitSettling: false,
      hasStopRefCapability: false,
      hasExactProcessStopCapability: false,
      executionTerminal: "none",
    },
  );
  assert.deepEqual(stopNoProvider.transition, {
    observedState: "paused",
    condition: "none",
    cause: STOPPED_WITHOUT_PROVIDER_CAUSE,
    actor: "daemon-convergence",
  });
  assert.deepEqual(stopNoProvider.commands, []);
});
