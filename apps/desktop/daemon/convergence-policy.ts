import { CRASH_LOOP_EXIT_LIMIT, CRASH_LOOP_WINDOW_MS } from "./reconciler-policy.js";
import type { DaemonManifestEntry, ObservedState } from "./types.js";

/**
 * Pure, zero-I/O convergence policy helpers shared by
 * `ProviderExecutionCoordinator`. No clocks, timers, filesystem, SQLite,
 * network, or secrets are read here.
 */

// A live generation with no attachable handle resolves on its own once the
// old process exits or answers again. Re-check with capped backoff so the
// agent is not left blocked until some unrelated event wakes it, while a
// runtime that stays unattachable costs one cheap check per half hour.
export const UNATTACHABLE_GENERATION_RECHECK_MS = 60_000;
export const UNATTACHABLE_GENERATION_RECHECK_MAX_MS = 30 * 60_000;
export const WORKSPACE_REPOSITORY_RETRY_MS = 5_000;
export const WORKSPACE_REPOSITORY_RETRY_MAX_MS = 5 * 60_000;

/**
 * How long an ended runtime is left for the turn of its in-flight message to
 * be recorded. A provider reports a failed turn's result moments after the
 * failure; past this the result is not coming and the runtime is retired
 * without it.
 */
export const RETIREMENT_SETTLEMENT_WAIT_MS = 30_000;

/**
 * Maximum consecutive automatic convergence retries after a snapshot-to-commit
 * `ManifestConflictError` before escalating as a named failure instead of
 * looping indefinitely.
 */
export const CONVERGENCE_CONFLICT_RETRY_LIMIT = 5;

export type InboxTurnHead = {
  state: string;
  provider_turn_id: string | null;
  outcome: string | null;
};

/**
 * The inbox head has a turn that may still be running and no result saved for
 * it. A started turn handed back to `pending` counts: a delivery lane that
 * lets go of its turn leaves the row that way while the provider works on.
 */
export function turnInFlight(head: InboxTurnHead | null): boolean {
  return head !== null && (["dispatching", "awaiting_result", "result_recovery"].includes(head.state)
    || (head.state === "pending" && Boolean(head.provider_turn_id) && !head.outcome));
}

/**
 * A reference with no process id names no process (a Cursor lane between
 * turns): there is nothing to prove. A process id with no recorded birth is an
 * incomplete reference: no process can be matched to it, so it is never
 * signalled and never treated as gone.
 */
export function recordedProcessState(
  connection: { pid?: number | null; processIdentity?: string | null } | null | undefined,
): "none" | "exact" | "incomplete" {
  if (!connection || connection.pid === null || connection.pid === undefined) return "none";
  return Number.isSafeInteger(connection.pid) && connection.pid > 0
    && typeof connection.processIdentity === "string" && connection.processIdentity.trim()
    ? "exact" : "incomplete";
}

/** Exponential backoff capped at `maxMs`, with `attempt >= 1` starting at `baseMs`. */
export function computeCappedBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.min(Math.max(0, Math.floor(attempt) - 1), 10);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/** Keep whichever wake-up is sooner so a slow re-check never delays an earlier restart. */
export function shouldReplaceRecoveryDeadline(
  hasExistingTimer: boolean,
  existingDueAtMs: number | undefined,
  candidateDueAtMs: number,
): boolean {
  if (!hasExistingTimer) return true;
  if (existingDueAtMs === undefined) return false;
  return candidateDueAtMs < existingDueAtMs;
}

export type FailedRestartGateDecision =
  | { kind: "quarantine" }
  | { kind: "wait"; delayMs: number }
  | { kind: "allow" };

/** Evaluates crash-loop quarantine and restart backoff for a failed entry. */
export function evaluateFailedRestartGate(
  reconciliation: DaemonManifestEntry["reconciliation"],
  nowMs: number,
): FailedRestartGateDecision {
  const exitsInWindow = (reconciliation?.exit_timestamps_ms ?? [])
    .filter((at) => at >= nowMs - CRASH_LOOP_WINDOW_MS).length;
  if (exitsInWindow >= CRASH_LOOP_EXIT_LIMIT) return { kind: "quarantine" };
  const restartAt = reconciliation?.next_restart_at_ms;
  if (typeof restartAt === "number" && restartAt > nowMs) {
    return { kind: "wait", delayMs: restartAt - nowMs };
  }
  return { kind: "allow" };
}

export type RetirementHoldDecision =
  | { hold: true; deadlineMs?: number; delayMs?: number }
  | { hold: false; deadlineMs?: number };

/** Pure retirement-hold rule for an ended handle with an in-flight turn or room refusal. */
export function evaluateRetirementHold(input: {
  head: InboxTurnHead | null;
  nowMs: number;
  existingDeadlineMs: number | undefined;
  typedHandleEnded: boolean;
  observedState: ObservedState;
  roomRefusesAccess: boolean;
}): RetirementHoldDecision {
  if (turnInFlight(input.head)) {
    const deadlineMs = input.existingDeadlineMs ?? input.nowMs + RETIREMENT_SETTLEMENT_WAIT_MS;
    if (input.nowMs < deadlineMs) {
      return { hold: true, deadlineMs, delayMs: deadlineMs - input.nowMs };
    }
    if (input.typedHandleEnded
      && !["failed", "stopped"].includes(input.observedState)
      && input.roomRefusesAccess) {
      return { hold: true, deadlineMs };
    }
    return { hold: false, deadlineMs };
  }
  if (input.typedHandleEnded
    && !["failed", "stopped"].includes(input.observedState)
    && input.roomRefusesAccess) {
    return { hold: true };
  }
  return { hold: false };
}

/** Returns true while consecutive convergence conflict retries remain within the bound. */
export function shouldScheduleConflictRetry(attempts: number): boolean {
  return attempts > 0 && attempts <= CONVERGENCE_CONFLICT_RETRY_LIMIT;
}
