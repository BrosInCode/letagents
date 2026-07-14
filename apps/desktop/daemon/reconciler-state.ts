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
  if (observedState !== "failed") {
    return { failure_timestamps_ms: [], last_observed_state: observedState, next_restart_at_ms: null };
  }
  if (previous?.last_observed_state === "failed") {
    return { failure_timestamps_ms: failureTimestamps, last_observed_state: "failed", next_restart_at_ms: previous.next_restart_at_ms };
  }
  const nextFailures = [...failureTimestamps, nowMs];
  return {
    failure_timestamps_ms: nextFailures,
    last_observed_state: "failed",
    next_restart_at_ms: nowMs + restartBackoffMs(nextFailures.length),
  };
}
