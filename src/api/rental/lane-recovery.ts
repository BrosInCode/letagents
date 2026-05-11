/**
 * Lane recovery service — server-side D4 implementation.
 *
 * Detects when the renter's own IDE quota lane has refreshed (D4
 * "resume on own quota refresh" closeout flow) and records the
 * timestamp on the rental session + emits a `lane.recovered`
 * activity event for the rental room.
 *
 * The actual signal source is the desktop meter adapter pipeline:
 * each `POST /api/rental/sessions/:id/usage` call carries a
 * `NativeQuotaSnapshot` for the *provider's* lane. The renter,
 * meanwhile, runs an Antigravity (or Cursor) adapter locally that
 * reports their *own* lane's percent_window separately via a future
 * renter-side endpoint (lands in p2.6). Until p2.6, callers can also
 * invoke this service directly from a renter-side desktop signal.
 *
 * Algorithm (deterministic, idempotent):
 *
 *   1. Look up the rental session by id.
 *   2. Refuse to act unless `renter_lane_exhausted_at` is set
 *      (we only "recover" lanes that were marked exhausted).
 *   3. Refuse to act if `renter_lane_recovered_at` is already set
 *      (idempotent — only record the first recovery).
 *   4. Compare incoming snapshot to the prior renter snapshot.
 *      A recovery requires a positive delta in `percent_remaining`
 *      that crosses {@link LANE_RECOVERY_THRESHOLD}.
 *   5. On match: set `renter_lane_recovered_at = observedAt`, emit
 *      a `lane.recovered` activity event.
 *   6. Return a structured decision so the caller can log/test.
 *
 * Spec refs:
 *   §5.5 (D4 "resume on own quota refresh")
 *   §17.4 (percent-window calibration)
 *   §19.2 (rental_sessions.renter_lane_* fields — added in p1.2)
 *   §9.4 (activity event taxonomy — `lane.exhausted` / `lane.recovered`
 *         added by D4 amendment, see p1.2b taxonomy update)
 *
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p2.5 (server-side D4 slice).
 */

import { LANE_RECOVERED, type RentalActivitySource } from "./activity-event-types.js";

/**
 * Minimum positive delta in `percent_remaining` that counts as a
 * lane refresh. Tuned conservatively: a real Antigravity / Cursor
 * lane reset jumps from ≤0.05 back to ~1.0, so the delta is ≥0.95.
 * 0.5 lets noisy adapters report partial recoveries while still
 * filtering out routine fluctuations.
 *
 * Exported for tests and for tuning per provider in future.
 */
export const LANE_RECOVERY_THRESHOLD = 0.5;

/**
 * A lane snapshot the renter's adapter pipeline produces for the
 * renter's own quota. Server only needs the comparison axes.
 */
export interface RenterLaneSignal {
  sessionId: string;
  provider: string;
  model: string | null;
  percentRemaining: number;
  observedAt: Date;
}

/**
 * Subset of a `rental_sessions` row the lane-recovery decision
 * function reads. Kept narrow so the service is trivially mockable.
 */
export interface RentalSessionLaneView {
  id: string;
  room_id: string | null;
  renter_lane_provider: string | null;
  renter_lane_model: string | null;
  renter_lane_exhausted_at: Date | null;
  renter_lane_recovered_at: Date | null;
}

export interface RenterLaneSnapshotRecord {
  percentRemaining: number;
  observedAt: Date;
}

export interface LaneRecoveryDeps {
  loadSession(sessionId: string): Promise<RentalSessionLaneView | null>;
  /**
   * Return the most recent prior renter snapshot for the session, or
   * null if this is the first one we've seen.
   */
  loadPriorSnapshot(sessionId: string): Promise<RenterLaneSnapshotRecord | null>;
  /**
   * Mark `renter_lane_recovered_at` on the session row. Implementations
   * should be idempotent (e.g. only update when the column is NULL).
   */
  markRecovered(sessionId: string, recoveredAt: Date): Promise<void>;
  /** Append the `lane.recovered` activity event. */
  emitLaneRecoveredEvent(input: {
    sessionId: string;
    roomId: string;
    source: RentalActivitySource;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Reasons the decision function may return alongside `recovered`.
 * Exported so tests + log lines can enumerate them.
 */
export const LANE_RECOVERY_REASONS = Object.freeze({
  RECOVERED: "recovered",
  SESSION_NOT_FOUND: "session_not_found",
  LANE_NOT_EXHAUSTED: "lane_not_marked_exhausted",
  ALREADY_RECOVERED: "already_recovered",
  PROVIDER_MISMATCH: "provider_mismatch",
  MODEL_MISMATCH: "model_mismatch",
  NO_PRIOR_SNAPSHOT: "no_prior_snapshot",
  DELTA_BELOW_THRESHOLD: "delta_below_threshold",
  INVALID_SIGNAL: "invalid_signal",
} as const);

export type LaneRecoveryReason =
  (typeof LANE_RECOVERY_REASONS)[keyof typeof LANE_RECOVERY_REASONS];

export interface LaneRecoveryDecision {
  recovered: boolean;
  reason: LaneRecoveryReason;
  priorPercentRemaining: number | null;
  deltaPercent: number | null;
  recoveredAt: Date | null;
}

function fail(
  reason: LaneRecoveryReason,
  priorPercentRemaining: number | null = null,
  deltaPercent: number | null = null,
): LaneRecoveryDecision {
  return {
    recovered: false,
    reason,
    priorPercentRemaining,
    deltaPercent,
    recoveredAt: null,
  };
}

/**
 * Decide whether an incoming renter lane signal qualifies as a
 * recovery and apply the side-effects via the injected deps.
 *
 * Pure decision logic + side-effects through the deps interface —
 * tests pass fake deps and assert the returned decision plus what
 * was emitted/marked.
 */
export async function applyRenterLaneSignal(
  signal: RenterLaneSignal,
  deps: LaneRecoveryDeps,
): Promise<LaneRecoveryDecision> {
  if (!isValidSignal(signal)) {
    return fail(LANE_RECOVERY_REASONS.INVALID_SIGNAL);
  }

  const session = await deps.loadSession(signal.sessionId);
  if (!session) {
    return fail(LANE_RECOVERY_REASONS.SESSION_NOT_FOUND);
  }

  if (!session.renter_lane_exhausted_at) {
    return fail(LANE_RECOVERY_REASONS.LANE_NOT_EXHAUSTED);
  }

  if (session.renter_lane_recovered_at) {
    return fail(LANE_RECOVERY_REASONS.ALREADY_RECOVERED);
  }

  if (
    session.renter_lane_provider !== null
    && session.renter_lane_provider !== signal.provider
  ) {
    return fail(LANE_RECOVERY_REASONS.PROVIDER_MISMATCH);
  }

  if (
    session.renter_lane_model !== null
    && signal.model !== null
    && session.renter_lane_model !== signal.model
  ) {
    return fail(LANE_RECOVERY_REASONS.MODEL_MISMATCH);
  }

  const prior = await deps.loadPriorSnapshot(signal.sessionId);
  if (!prior) {
    return fail(LANE_RECOVERY_REASONS.NO_PRIOR_SNAPSHOT);
  }

  const delta = signal.percentRemaining - prior.percentRemaining;
  if (delta < LANE_RECOVERY_THRESHOLD) {
    return fail(
      LANE_RECOVERY_REASONS.DELTA_BELOW_THRESHOLD,
      prior.percentRemaining,
      delta,
    );
  }

  await deps.markRecovered(signal.sessionId, signal.observedAt);

  if (session.room_id) {
    await deps.emitLaneRecoveredEvent({
      sessionId: signal.sessionId,
      roomId: session.room_id,
      source: "system",
      payload: {
        event: LANE_RECOVERED,
        provider: signal.provider,
        model: signal.model,
        prior_percent_remaining: prior.percentRemaining,
        new_percent_remaining: signal.percentRemaining,
        delta_percent: delta,
        observed_at: signal.observedAt.toISOString(),
        exhausted_at: session.renter_lane_exhausted_at?.toISOString() ?? null,
      },
    });
  }

  return {
    recovered: true,
    reason: LANE_RECOVERY_REASONS.RECOVERED,
    priorPercentRemaining: prior.percentRemaining,
    deltaPercent: delta,
    recoveredAt: signal.observedAt,
  };
}

function isValidSignal(signal: RenterLaneSignal): boolean {
  if (typeof signal.sessionId !== "string" || !signal.sessionId.trim()) return false;
  if (typeof signal.provider !== "string" || !signal.provider.trim()) return false;
  if (
    typeof signal.percentRemaining !== "number"
    || !Number.isFinite(signal.percentRemaining)
    || signal.percentRemaining < 0
    || signal.percentRemaining > 1
  ) {
    return false;
  }
  if (!(signal.observedAt instanceof Date) || Number.isNaN(signal.observedAt.getTime())) {
    return false;
  }
  return true;
}
