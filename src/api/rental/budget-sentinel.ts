/**
 * Budget Sentinel — decision logic (p2.8 server-side slice).
 *
 * Gates expensive operations against a rental session's LRT budget
 * and the meter's reported confidence. The service is split into
 * pure-function decisions here and DB-backed orchestration in a
 * follow-up slice (routes / reservation persistence land in
 * p2.8b).
 *
 * Responsibilities (§17.13 + §17.14):
 *
 *   • authorize(stepCostLrt, state) → ok | denied
 *       Pre-step authorization. Refuses when:
 *         - state.status is "budget_exhausted"
 *         - effectiveCeiling - alreadyReservedAndUsed < stepCostLrt
 *         - meter snapshot is older than `staleMs` and step cost
 *           exceeds the conservative ceiling
 *   • applyReservation(stepCostLrt, state) → state with bumped reserved
 *   • applyReconciliation(actualCostLrt, reservedCostLrt, state) →
 *       state with reserved decremented and used incremented; also
 *       transitions to "budget_exhausted" when used crosses the
 *       effective ceiling.
 *   • effectiveLrtCeiling(state) — wraps §17.13 stop-threshold table
 *     with the session's `meter_confidence` and any per-session
 *     budget_stop_threshold override.
 *   • isMeterStale(state, nowMs) — staleness window per §17.14.
 *
 * Pure: takes a state snapshot in, returns a decision out + an
 * optional new state to persist. No DB, no HTTP. The
 * DB-orchestrating service that lands next reads
 * `rental_sessions`, holds a per-session advisory lock, calls
 * these functions, persists the new state, and emits the right
 * `budget.*` activity events.
 *
 * Spec refs:
 *   §17.13 confidence-based stop threshold table
 *   §17.14 budget exhaustion + meter staleness
 *   §19.2  rental_sessions LRT / budget fields
 *   §9.4   budget.* activity events
 *
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p2.8 (decision slice).
 */

import {
  STOP_THRESHOLD_BY_CONFIDENCE,
  effectiveLrtCeiling as effectiveCeilingForLimit,
} from "../../shared/rental/lrt.js";
import type { QuotaConfidence } from "../../shared/rental/meter-types.js";

// ---------------------------------------------------------------------------
// State the Sentinel reads. Mirrors the subset of rental_sessions it cares
// about so the function is mockable without a DB.
// ---------------------------------------------------------------------------

export interface BudgetSentinelState {
  /** Session id — informational only, used in activity event payloads. */
  sessionId: string;
  /**
   * Same shape as rental_sessions.status. We only inspect a few
   * values; unknown values fall through as "operational".
   */
  status: string;
  /** LRT limit for the session (rental_sessions.lrt_limit). */
  lrtLimit: number | null;
  /**
   * Per-session override of the confidence-based stop threshold
   * (rental_sessions.budget_stop_threshold, 0..1). When present
   * it overrides the §17.13 default for this session.
   */
  budgetStopThreshold: number | null;
  /** Currently-reserved LRT for in-flight operations. */
  lrtReserved: number;
  /** LRT fully reconciled to actual usage. */
  lrtUsed: number;
  /** Latest meter confidence label (§17.13). */
  meterConfidence: QuotaConfidence | null;
  /**
   * Timestamp of the most recent meter snapshot we accepted via
   * `POST /api/rental/sessions/:id/usage`. ISO-8601 or null when
   * we have not seen one yet (session just started).
   */
  lastMeterAt: string | null;
}

// ---------------------------------------------------------------------------
// Configurable knobs (sane V1 defaults).
// ---------------------------------------------------------------------------

export interface BudgetSentinelOptions {
  /**
   * Meter staleness window (ms). Default 30s — matches the spec
   * §17.14 conservative window. When the latest snapshot is older
   * than this, the Sentinel switches to conservative reservation
   * (denies any step that would exceed `staleCeilingFraction` of
   * the effective ceiling).
   */
  staleMs?: number;
  /**
   * Fraction of the effective ceiling permitted to be reserved
   * while the meter is stale. Default 0.5 — refuse any step that
   * would push us past 50% of the safe ceiling until a fresh
   * snapshot lands.
   */
  staleCeilingFraction?: number;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_STALE_FRACTION = 0.5;

export function resolveOptions(
  options: BudgetSentinelOptions = {},
): Required<BudgetSentinelOptions> {
  return {
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    staleCeilingFraction:
      options.staleCeilingFraction ?? DEFAULT_STALE_FRACTION,
  };
}

// ---------------------------------------------------------------------------
// Decision shape
// ---------------------------------------------------------------------------

export const BUDGET_SENTINEL_REASONS = Object.freeze({
  AUTHORIZED: "authorized",
  STEP_COST_INVALID: "step_cost_invalid",
  NO_LRT_LIMIT: "no_lrt_limit",
  BUDGET_EXHAUSTED: "budget_exhausted",
  CEILING_EXCEEDED: "ceiling_exceeded",
  METER_STALE_CONSERVATIVE: "meter_stale_conservative",
} as const);

export type BudgetSentinelReason =
  (typeof BUDGET_SENTINEL_REASONS)[keyof typeof BUDGET_SENTINEL_REASONS];

export interface AuthorizeDecision {
  allowed: boolean;
  reason: BudgetSentinelReason;
  effectiveCeiling: number;
  reservedAfter: number;
  /** LRT available to reserve right now without exceeding the ceiling. */
  remaining: number;
  meterStale: boolean;
  staleSinceMs: number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The §17.13 stop-threshold table compressed to a `0..1` fraction
 * for the session's reported confidence, OR the per-session
 * override if `budgetStopThreshold` is set.
 */
export function resolveStopThresholdFraction(
  state: BudgetSentinelState,
): number {
  if (
    typeof state.budgetStopThreshold === "number"
    && Number.isFinite(state.budgetStopThreshold)
    && state.budgetStopThreshold > 0
    && state.budgetStopThreshold <= 1
  ) {
    return state.budgetStopThreshold;
  }
  const confidence: QuotaConfidence = state.meterConfidence ?? "unknown";
  return STOP_THRESHOLD_BY_CONFIDENCE[confidence]
    ?? STOP_THRESHOLD_BY_CONFIDENCE.unknown;
}

/**
 * The effective LRT ceiling for this session — `lrtLimit ×
 * stop_threshold`, floored. Mirrors {@link effectiveCeilingForLimit}
 * from the shared LRT primitives but accepts a per-session
 * override too.
 *
 * Returns 0 when there's no `lrtLimit` (caller must treat that
 * as "no budget — deny everything until the listing supplies one").
 */
export function effectiveLrtCeiling(state: BudgetSentinelState): number {
  if (
    typeof state.lrtLimit !== "number"
    || !Number.isFinite(state.lrtLimit)
    || state.lrtLimit <= 0
  ) {
    return 0;
  }
  const override = typeof state.budgetStopThreshold === "number"
    && Number.isFinite(state.budgetStopThreshold)
    && state.budgetStopThreshold > 0
    && state.budgetStopThreshold <= 1;
  if (override) {
    return Math.floor(state.lrtLimit * (state.budgetStopThreshold as number));
  }
  const confidence: QuotaConfidence = state.meterConfidence ?? "unknown";
  return effectiveCeilingForLimit(state.lrtLimit, confidence);
}

/**
 * True when the most recent meter snapshot is older than
 * `options.staleMs`. Treats `lastMeterAt = null` as stale (we
 * haven't seen a snapshot at all yet).
 */
export function isMeterStale(
  state: BudgetSentinelState,
  nowMs: number,
  options: BudgetSentinelOptions = {},
): boolean {
  const opts = resolveOptions(options);
  if (typeof state.lastMeterAt !== "string" || !state.lastMeterAt) return true;
  const lastMs = Date.parse(state.lastMeterAt);
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs > opts.staleMs;
}

/**
 * How long the meter has been stale, in ms. Returns `null` if not
 * stale (fresh snapshot inside the window).
 */
export function staleAgeMs(
  state: BudgetSentinelState,
  nowMs: number,
  options: BudgetSentinelOptions = {},
): number | null {
  if (!isMeterStale(state, nowMs, options)) return null;
  if (typeof state.lastMeterAt !== "string" || !state.lastMeterAt) {
    return Number.POSITIVE_INFINITY;
  }
  const lastMs = Date.parse(state.lastMeterAt);
  if (!Number.isFinite(lastMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - lastMs);
}

// ---------------------------------------------------------------------------
// authorize — pre-step check
// ---------------------------------------------------------------------------

/**
 * Decide whether a step with cost `stepCostLrt` may proceed.
 *
 * Returns an {@link AuthorizeDecision} but does NOT mutate state.
 * The caller (DB-orchestrating service) is responsible for calling
 * {@link applyReservation} on the same state to actually reserve
 * the cost when the decision allows it.
 */
export function authorize(
  stepCostLrt: number,
  state: BudgetSentinelState,
  options: BudgetSentinelOptions = {},
  nowMs: number = Date.now(),
): AuthorizeDecision {
  const opts = resolveOptions(options);
  const ceiling = effectiveLrtCeiling(state);
  const reservedBefore = state.lrtReserved + state.lrtUsed;
  const remaining = Math.max(0, ceiling - reservedBefore);
  const meterStale = isMeterStale(state, nowMs, opts);
  const staleSinceMs = staleAgeMs(state, nowMs, opts);

  const baseDecision = {
    effectiveCeiling: ceiling,
    reservedAfter: reservedBefore,
    remaining,
    meterStale,
    staleSinceMs,
  };

  if (!Number.isFinite(stepCostLrt) || stepCostLrt < 0) {
    return {
      allowed: false,
      reason: BUDGET_SENTINEL_REASONS.STEP_COST_INVALID,
      ...baseDecision,
    };
  }

  if (state.status === "budget_exhausted") {
    return {
      allowed: false,
      reason: BUDGET_SENTINEL_REASONS.BUDGET_EXHAUSTED,
      ...baseDecision,
    };
  }

  if (ceiling <= 0) {
    return {
      allowed: false,
      reason: BUDGET_SENTINEL_REASONS.NO_LRT_LIMIT,
      ...baseDecision,
    };
  }

  if (reservedBefore + stepCostLrt > ceiling) {
    return {
      allowed: false,
      reason: BUDGET_SENTINEL_REASONS.CEILING_EXCEEDED,
      ...baseDecision,
    };
  }

  if (meterStale) {
    // Conservative reserve mode: refuse to push past
    // staleCeilingFraction × ceiling while we have no fresh signal.
    const conservativeCeiling = Math.floor(
      ceiling * opts.staleCeilingFraction,
    );
    if (reservedBefore + stepCostLrt > conservativeCeiling) {
      return {
        allowed: false,
        reason: BUDGET_SENTINEL_REASONS.METER_STALE_CONSERVATIVE,
        ...baseDecision,
      };
    }
  }

  return {
    allowed: true,
    reason: BUDGET_SENTINEL_REASONS.AUTHORIZED,
    ...baseDecision,
    reservedAfter: reservedBefore + stepCostLrt,
  };
}

// ---------------------------------------------------------------------------
// applyReservation / applyReconciliation — pure state transitions
// ---------------------------------------------------------------------------

export interface ReservationResult {
  state: BudgetSentinelState;
  reservedDelta: number;
}

/**
 * Bump `lrtReserved` by `stepCostLrt`. Callers MUST have an
 * `allowed: true` decision from {@link authorize} for this
 * `stepCostLrt`/`state` pair first; the function does not
 * re-validate.
 *
 * Negative or non-finite `stepCostLrt` is treated as zero.
 */
export function applyReservation(
  stepCostLrt: number,
  state: BudgetSentinelState,
): ReservationResult {
  const delta = Number.isFinite(stepCostLrt) && stepCostLrt > 0
    ? stepCostLrt
    : 0;
  return {
    state: { ...state, lrtReserved: state.lrtReserved + delta },
    reservedDelta: delta,
  };
}

export interface ReconciliationResult {
  state: BudgetSentinelState;
  reservedDelta: number;
  usedDelta: number;
  /** True when the reconciliation pushed the session into budget_exhausted. */
  becameExhausted: boolean;
}

/**
 * Reconcile an in-flight reservation into actual usage. Subtracts
 * `reservedCostLrt` from `lrtReserved` (the placeholder) and adds
 * `actualCostLrt` to `lrtUsed` (the real bill).
 *
 * Negative deltas are clamped to zero — a meter that "goes
 * backwards" is treated as a reset, not a refund, mirroring
 * `computeLrt` in the shared module.
 *
 * Sets `status = "budget_exhausted"` when the new `lrtUsed`
 * crosses the effective ceiling.
 */
export function applyReconciliation(
  actualCostLrt: number,
  reservedCostLrt: number,
  state: BudgetSentinelState,
): ReconciliationResult {
  const usedDelta = Number.isFinite(actualCostLrt) && actualCostLrt > 0
    ? actualCostLrt
    : 0;
  const reservedDelta = Number.isFinite(reservedCostLrt) && reservedCostLrt > 0
    ? Math.min(reservedCostLrt, state.lrtReserved)
    : 0;

  const newReserved = Math.max(0, state.lrtReserved - reservedDelta);
  const newUsed = state.lrtUsed + usedDelta;

  let nextStatus = state.status;
  const ceiling = effectiveLrtCeiling(state);
  const becameExhausted =
    ceiling > 0
    && state.status !== "budget_exhausted"
    && newUsed >= ceiling;
  if (becameExhausted) {
    nextStatus = "budget_exhausted";
  }

  return {
    state: {
      ...state,
      status: nextStatus,
      lrtReserved: newReserved,
      lrtUsed: newUsed,
    },
    reservedDelta,
    usedDelta,
    becameExhausted,
  };
}
