import assert from "node:assert/strict";
import test from "node:test";

import {
  CONVERGENCE_CONFLICT_RETRY_LIMIT,
  RETIREMENT_SETTLEMENT_WAIT_MS,
  UNATTACHABLE_GENERATION_RECHECK_MAX_MS,
  UNATTACHABLE_GENERATION_RECHECK_MS,
  WORKSPACE_REPOSITORY_RETRY_MAX_MS,
  WORKSPACE_REPOSITORY_RETRY_MS,
  computeCappedBackoffMs,
  evaluateFailedRestartGate,
  evaluateRetirementHold,
  recordedProcessState,
  shouldReplaceRecoveryDeadline,
  shouldScheduleConflictRetry,
  turnInFlight,
} from "../convergence-policy.js";
import { CRASH_LOOP_EXIT_LIMIT, CRASH_LOOP_WINDOW_MS } from "../reconciler-policy.js";
import { advanceReconciliationState } from "../reconciler-state.js";

test("turnInFlight identifies active, recovering, and pending-with-turn heads only", () => {
  assert.equal(turnInFlight(null), false);
  assert.equal(turnInFlight({ state: "pending", provider_turn_id: null, outcome: null }), false);
  assert.equal(turnInFlight({ state: "pending", provider_turn_id: "turn-1", outcome: null }), true);
  assert.equal(turnInFlight({ state: "pending", provider_turn_id: "turn-1", outcome: "reply" }), false);
  assert.equal(turnInFlight({ state: "dispatching", provider_turn_id: null, outcome: null }), true);
  assert.equal(turnInFlight({ state: "awaiting_result", provider_turn_id: "turn-1", outcome: null }), true);
  assert.equal(turnInFlight({ state: "result_recovery", provider_turn_id: "turn-1", outcome: null }), true);
  assert.equal(turnInFlight({ state: "acknowledged", provider_turn_id: "turn-1", outcome: "reply" }), false);
});

test("recordedProcessState distinguishes none, exact, and incomplete process references", () => {
  assert.equal(recordedProcessState(null), "none");
  assert.equal(recordedProcessState(undefined), "none");
  assert.equal(recordedProcessState({ pid: null, processIdentity: null }), "none");
  assert.equal(recordedProcessState({ pid: 4242, processIdentity: "birth-4242" }), "exact");
  assert.equal(recordedProcessState({ pid: 4242, processIdentity: null }), "incomplete");
  assert.equal(recordedProcessState({ pid: 4242, processIdentity: "   " }), "incomplete");
  assert.equal(recordedProcessState({ pid: 0, processIdentity: "birth-0" }), "incomplete");
});

test("computeCappedBackoffMs doubles per attempt and respects caps", () => {
  assert.equal(
    computeCappedBackoffMs(1, WORKSPACE_REPOSITORY_RETRY_MS, WORKSPACE_REPOSITORY_RETRY_MAX_MS),
    5_000,
  );
  assert.equal(
    computeCappedBackoffMs(2, WORKSPACE_REPOSITORY_RETRY_MS, WORKSPACE_REPOSITORY_RETRY_MAX_MS),
    10_000,
  );
  assert.equal(
    computeCappedBackoffMs(3, WORKSPACE_REPOSITORY_RETRY_MS, WORKSPACE_REPOSITORY_RETRY_MAX_MS),
    20_000,
  );
  assert.equal(
    computeCappedBackoffMs(10, WORKSPACE_REPOSITORY_RETRY_MS, WORKSPACE_REPOSITORY_RETRY_MAX_MS),
    WORKSPACE_REPOSITORY_RETRY_MAX_MS,
  );
  assert.equal(
    computeCappedBackoffMs(1, UNATTACHABLE_GENERATION_RECHECK_MS, UNATTACHABLE_GENERATION_RECHECK_MAX_MS),
    60_000,
  );
  assert.equal(
    computeCappedBackoffMs(12, UNATTACHABLE_GENERATION_RECHECK_MS, UNATTACHABLE_GENERATION_RECHECK_MAX_MS),
    UNATTACHABLE_GENERATION_RECHECK_MAX_MS,
  );
});

test("shouldReplaceRecoveryDeadline replaces later timers with sooner ones and never the reverse", () => {
  assert.equal(shouldReplaceRecoveryDeadline(false, undefined, 10_000), true);
  assert.equal(shouldReplaceRecoveryDeadline(true, undefined, 10_000), false);
  assert.equal(shouldReplaceRecoveryDeadline(true, 10_000, 15_000), false);
  assert.equal(shouldReplaceRecoveryDeadline(true, 10_000, 10_000), false);
  assert.equal(shouldReplaceRecoveryDeadline(true, 10_000, 5_000), true);
});

test("evaluateFailedRestartGate enforces backoff windows and crash-loop quarantine without clocks", () => {
  let rec = undefined;
  let now = 10_000;
  for (let i = 1; i < CRASH_LOOP_EXIT_LIMIT; i += 1) {
    rec = advanceReconciliationState(rec, "idle", now);
    rec = advanceReconciliationState(rec, "failed", now);
    const duringBackoff = evaluateFailedRestartGate(rec, now);
    assert.equal(duringBackoff.kind, "wait");
    assert.ok(duringBackoff.delayMs > 0);
    const afterBackoff = evaluateFailedRestartGate(rec, now + duringBackoff.delayMs);
    assert.deepEqual(afterBackoff, { kind: "allow" });
    now += duringBackoff.delayMs;
  }
  rec = advanceReconciliationState(rec, "idle", now);
  rec = advanceReconciliationState(rec, "failed", now);
  assert.deepEqual(evaluateFailedRestartGate(rec, now), { kind: "quarantine" });
  assert.deepEqual(
    evaluateFailedRestartGate(rec, now + CRASH_LOOP_WINDOW_MS + 1),
    { kind: "allow" },
  );
});

test("evaluateRetirementHold bounds in-flight turn waits and honors room-refusal holds", () => {
  const inFlight = { state: "awaiting_result", provider_turn_id: "turn-1", outcome: null };
  const first = evaluateRetirementHold({
    head: inFlight,
    nowMs: 1_000,
    existingDeadlineMs: undefined,
    typedHandleEnded: true,
    observedState: "working",
    roomRefusesAccess: false,
  });
  assert.deepEqual(first, {
    hold: true,
    deadlineMs: 1_000 + RETIREMENT_SETTLEMENT_WAIT_MS,
    delayMs: RETIREMENT_SETTLEMENT_WAIT_MS,
  });

  const beforeExpiry = evaluateRetirementHold({
    head: inFlight,
    nowMs: 11_000,
    existingDeadlineMs: first.deadlineMs,
    typedHandleEnded: true,
    observedState: "working",
    roomRefusesAccess: false,
  });
  assert.deepEqual(beforeExpiry, {
    hold: true,
    deadlineMs: first.deadlineMs,
    delayMs: RETIREMENT_SETTLEMENT_WAIT_MS - 10_000,
  });

  const expired = evaluateRetirementHold({
    head: inFlight,
    nowMs: 1_000 + RETIREMENT_SETTLEMENT_WAIT_MS,
    existingDeadlineMs: first.deadlineMs,
    typedHandleEnded: true,
    observedState: "working",
    roomRefusesAccess: false,
  });
  assert.deepEqual(expired, { hold: false, deadlineMs: first.deadlineMs });

  const heldByRoomRefusal = evaluateRetirementHold({
    head: null,
    nowMs: 1_000,
    existingDeadlineMs: undefined,
    typedHandleEnded: true,
    observedState: "idle",
    roomRefusesAccess: true,
  });
  assert.deepEqual(heldByRoomRefusal, { hold: true });

  const failedEntryNotHeld = evaluateRetirementHold({
    head: null,
    nowMs: 1_000,
    existingDeadlineMs: undefined,
    typedHandleEnded: true,
    observedState: "failed",
    roomRefusesAccess: true,
  });
  assert.deepEqual(failedEntryNotHeld, { hold: false });
});

test("shouldScheduleConflictRetry enforces the bounded retry limit", () => {
  assert.equal(shouldScheduleConflictRetry(0), false);
  for (let attempt = 1; attempt <= CONVERGENCE_CONFLICT_RETRY_LIMIT; attempt += 1) {
    assert.equal(shouldScheduleConflictRetry(attempt), true);
  }
  assert.equal(shouldScheduleConflictRetry(CONVERGENCE_CONFLICT_RETRY_LIMIT + 1), false);
});
