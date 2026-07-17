import { CRASH_LOOP_WINDOW_MS, restartBackoffMs } from "./reconciler-policy.js";
import type { ObservedState, ReconciliationState } from "./types.js";

const MAX_ACTION_IDS = 32;

function liveExits(previous: ReconciliationState | undefined, nowMs: number): number[] {
  return (previous?.exit_timestamps_ms ?? []).filter((at) => at >= nowMs - CRASH_LOOP_WINDOW_MS);
}

function completed(previous: ReconciliationState | undefined, actionId?: string): string[] {
  const ids = previous?.completed_action_ids ?? [];
  return actionId ? [...ids.filter((id) => id !== actionId), actionId].slice(-MAX_ACTION_IDS) : ids;
}

/**
 * Updates observation bookkeeping. Only terminal failed edges enter the
 * quarantine window; recovery/health observations never erase that history.
 */
export function advanceReconciliationState(
  previous: ReconciliationState | undefined,
  observedState: ObservedState,
  nowMs: number,
): ReconciliationState {
  const exits = liveExits(previous, nowMs);
  if (observedState === "idle" || observedState === "working") {
    return { exit_timestamps_ms: exits, consecutive_action_failures: 0, last_observed_state: observedState, next_restart_at_ms: null, completed_action_ids: completed(previous), last_action_sequence: previous?.last_action_sequence ?? 0, pending_action: previous?.pending_action ?? null, last_terminal: previous?.last_terminal };
  }
  if (observedState !== "failed" || previous?.last_observed_state === "failed") {
    return { exit_timestamps_ms: exits, consecutive_action_failures: previous?.consecutive_action_failures ?? 0, last_observed_state: observedState, next_restart_at_ms: previous?.next_restart_at_ms ?? null, completed_action_ids: completed(previous), last_action_sequence: previous?.last_action_sequence ?? 0, pending_action: previous?.pending_action ?? null, last_terminal: previous?.last_terminal };
  }
  const failures = (previous?.consecutive_action_failures ?? 0) + 1;
  return {
    exit_timestamps_ms: [...exits, nowMs],
    consecutive_action_failures: failures,
    last_observed_state: "failed",
    next_restart_at_ms: nowMs + restartBackoffMs(failures),
    completed_action_ids: completed(previous),
    last_action_sequence: previous?.last_action_sequence ?? 0,
    pending_action: previous?.pending_action ?? null,
    last_terminal: previous?.last_terminal,
  };
}

export function beginReconciliationAction(previous: ReconciliationState, action: NonNullable<ReconciliationState["pending_action"]>): ReconciliationState {
  if (previous.completed_action_ids.includes(action.id)) throw new Error(`replayed reconciliation action: ${action.id}`);
  if (action.sequence <= previous.last_action_sequence) throw new Error(`stale reconciliation action sequence: ${action.sequence}`);
  if (previous.pending_action && previous.pending_action.id !== action.id) throw new Error(`unresolved reconciliation action: ${previous.pending_action.id}`);
  return { ...previous, last_action_sequence: action.sequence, pending_action: action };
}

/** Records a failed provider action exactly once, with bounded replay memory. */
export function recordReconciliationActionFailure(previous: ReconciliationState, actionId: string, nowMs: number): ReconciliationState {
  if (previous.completed_action_ids.includes(actionId)) return previous;
  const failures = previous.consecutive_action_failures + 1;
  return {
    ...previous,
    last_observed_state: "failed",
    consecutive_action_failures: failures,
    next_restart_at_ms: nowMs + restartBackoffMs(failures),
    completed_action_ids: completed(previous, actionId),
    pending_action: null,
  };
}

export function completeReconciliationAction(previous: ReconciliationState, actionId: string): ReconciliationState {
  return { ...previous, consecutive_action_failures: 0, next_restart_at_ms: null, completed_action_ids: completed(previous, actionId), pending_action: null };
}

/** Persist an orthogonal human control id without disturbing reconciler work. */
export function rememberCompletedControlAction(previous: ReconciliationState, actionId: string): ReconciliationState {
  return { ...previous, completed_action_ids: completed(previous, actionId) };
}
