import { CRASH_LOOP_WINDOW_MS, restartBackoffMs } from "./reconciler-policy.js";
import type { ObservedState, ReconciliationState } from "./types.js";

/**
 * Advances crash-loop bookkeeping exactly once per observed-state transition.
 * The value belongs in the manifest, never only in the reconciler process.
 */
export function advanceReconciliationState(
  previous: ReconciliationState | undefined,
  observedState: ObservedState,
  nowMs: number,
): ReconciliationState {
  const failureTimestamps = (previous?.failure_timestamps_ms ?? []).filter((at) => at >= nowMs - CRASH_LOOP_WINDOW_MS);
  // Stable useful work is the only success signal that clears a crash window.
  // Recovery/starting are transients and must retain preceding failures.
  if (observedState === "idle" || observedState === "working") {
    return { failure_timestamps_ms: [], last_observed_state: observedState, next_restart_at_ms: null, last_failed_action_id: null };
  }
  if (observedState !== "failed" || previous?.last_observed_state === "failed") {
    return {
      failure_timestamps_ms: failureTimestamps,
      last_observed_state: observedState,
      next_restart_at_ms: observedState === "failed" ? previous?.next_restart_at_ms ?? null : null,
      last_failed_action_id: previous?.last_failed_action_id ?? null,
    };
  }
  const nextFailures = [...failureTimestamps, nowMs];
  return {
    failure_timestamps_ms: nextFailures,
    last_observed_state: "failed",
    next_restart_at_ms: nowMs + restartBackoffMs(nextFailures.length),
    last_failed_action_id: null,
  };
}

/** Records a failed provider action exactly once, even if its tick is retried. */
export function recordReconciliationActionFailure(previous: ReconciliationState, actionId: string, nowMs: number): ReconciliationState {
  if (previous.last_failed_action_id === actionId) return previous;
  const failureTimestamps = previous.failure_timestamps_ms.filter((at) => at >= nowMs - CRASH_LOOP_WINDOW_MS);
  const nextFailures = [...failureTimestamps, nowMs];
  return {
    failure_timestamps_ms: nextFailures,
    last_observed_state: "failed",
    next_restart_at_ms: nowMs + restartBackoffMs(nextFailures.length),
    last_failed_action_id: actionId,
  };
}
