/**
 * Quota Lease — decision logic for §17.8 "one active rental per
 * quota lane" enforcement (p2.9 server-side slice).
 *
 * A rental session leases the provider's quota lane (the
 * provider+model combo whose tokens / credits get spent) for the
 * duration of the rental. The lease is the in-memory + DB
 * representation of "this provider+model is currently rented out
 * to this session". The Sentinel (#379) tracks LRT budget; the
 * lease tracks the *lane* itself so two concurrent rentals can't
 * burn the same quota source.
 *
 * Responsibilities:
 *
 *   • createLease(input)             — build a fresh lease object
 *   • laneKey(provider, model)       — canonical key used to index
 *                                       active leases server-side
 *   • canCreateLease(active, lane)   — returns ok/locked decision
 *   • refreshLease(lease, snapshot)  — bump last_refreshed_at +
 *                                       latest snapshot
 *   • releaseLease(lease, reason)    — mark released_at + reason
 *   • materiallyChanged(prev, next)  — §7.5 material-change
 *                                       detection between two
 *                                       lease snapshots, so the
 *                                       session can flag
 *                                       re-confirmation when the
 *                                       lane state shifted under
 *                                       the renter
 *
 * Pure: tests pass deterministic input and assert decisions.
 * DB orchestration (read/write rental_sessions.quota_lease,
 * acquire advisory locks) lives in a follow-up p2.9b slice.
 *
 * Spec refs:
 *   §7.5 material change ⇒ re-confirmation
 *   §17.8 one active rental per quota lane
 *   §19.2 rental_sessions.quota_lease jsonb column
 *
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p2.9 (decision slice).
 */

import type { QuotaConfidence } from "../../shared/rental/meter-types.js";

// ---------------------------------------------------------------------------
// Lease shape — persisted as rental_sessions.quota_lease jsonb
// ---------------------------------------------------------------------------

/**
 * The lane the lease holds. provider + model uniquely identify a
 * quota source on the provider's account; `quotaLaneId` is the
 * provider's own label (e.g. Antigravity's `lane_id`) and lets us
 * disambiguate two models under the same vendor that share a quota.
 */
export interface QuotaLane {
  provider: string;
  model: string | null;
  quotaLaneId: string | null;
}

export interface QuotaLeaseSnapshot {
  /** Native meter unit at lease time (tokens / percent_window / …). */
  nativeUnit: string | null;
  /** Native remaining at lease time, if observable. */
  nativeRemaining: number | null;
  /** Reset timestamp the IDE reported, if any. */
  nativeResetAt: string | null;
  /** Meter confidence at the moment of lease. */
  confidence: QuotaConfidence;
  /** ISO timestamp the snapshot was observed. */
  observedAt: string;
}

export interface QuotaLease {
  sessionId: string;
  lane: QuotaLane;
  lockedAt: string;
  lastRefreshedAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  snapshot: QuotaLeaseSnapshot;
}

// ---------------------------------------------------------------------------
// Canonical lane key
// ---------------------------------------------------------------------------

/**
 * Canonical key used to index active leases. Mirrors the same
 * shape the desktop renter trigger classifier uses to scope
 * failure buffers, so the two layers can talk about "the same
 * lane" without ambiguity.
 */
export function laneKey(provider: string, model: string | null): string {
  return `${provider}::${model ?? ""}`;
}

export function laneKeyOf(lane: QuotaLane): string {
  return laneKey(lane.provider, lane.model);
}

// ---------------------------------------------------------------------------
// Create lease (pure)
// ---------------------------------------------------------------------------

export interface CreateLeaseInput {
  sessionId: string;
  lane: QuotaLane;
  snapshot: QuotaLeaseSnapshot;
  /** Clock override for tests. */
  nowIso?: string;
}

export function createLease(input: CreateLeaseInput): QuotaLease {
  const nowIso = input.nowIso ?? new Date().toISOString();
  return {
    sessionId: input.sessionId,
    lane: { ...input.lane },
    lockedAt: nowIso,
    lastRefreshedAt: nowIso,
    releasedAt: null,
    releaseReason: null,
    snapshot: { ...input.snapshot },
  };
}

// ---------------------------------------------------------------------------
// Lease decisions
// ---------------------------------------------------------------------------

export const QUOTA_LEASE_REASONS = Object.freeze({
  AVAILABLE: "available",
  LANE_LOCKED: "lane_locked",
  INVALID_LANE: "invalid_lane",
  ALREADY_RELEASED: "already_released",
  SAME_SESSION: "same_session",
} as const);

export type QuotaLeaseReason =
  (typeof QUOTA_LEASE_REASONS)[keyof typeof QUOTA_LEASE_REASONS];

export interface CanCreateLeaseDecision {
  allowed: boolean;
  reason: QuotaLeaseReason;
  /** The session id currently holding the lane, if locked. */
  heldBy: string | null;
}

/**
 * Decide whether a new lease can be created for `lane` given the
 * currently-active leases. A lane with an active (not-released)
 * lease is locked. The caller passes an array because the
 * DB-orchestrating layer reads ALL active rental_sessions for
 * that lane in one query and feeds them in.
 *
 * Re-entry guard: if the lane is already held by `sessionId`,
 * returns `same_session` rather than `lane_locked` so a retry
 * after a transient failure can be idempotent.
 */
export function canCreateLease(
  active: ReadonlyArray<QuotaLease>,
  lane: QuotaLane,
  sessionId: string,
): CanCreateLeaseDecision {
  if (
    typeof lane.provider !== "string"
    || !lane.provider.trim()
  ) {
    return {
      allowed: false,
      reason: QUOTA_LEASE_REASONS.INVALID_LANE,
      heldBy: null,
    };
  }

  const key = laneKeyOf(lane);
  for (const lease of active) {
    if (lease.releasedAt) continue;
    if (laneKeyOf(lease.lane) !== key) continue;
    if (lease.sessionId === sessionId) {
      return {
        allowed: true,
        reason: QUOTA_LEASE_REASONS.SAME_SESSION,
        heldBy: lease.sessionId,
      };
    }
    return {
      allowed: false,
      reason: QUOTA_LEASE_REASONS.LANE_LOCKED,
      heldBy: lease.sessionId,
    };
  }

  return {
    allowed: true,
    reason: QUOTA_LEASE_REASONS.AVAILABLE,
    heldBy: null,
  };
}

// ---------------------------------------------------------------------------
// Refresh / release (pure transitions)
// ---------------------------------------------------------------------------

export function refreshLease(
  lease: QuotaLease,
  snapshot: QuotaLeaseSnapshot,
  nowIso: string = new Date().toISOString(),
): QuotaLease {
  return {
    ...lease,
    lastRefreshedAt: nowIso,
    snapshot: { ...snapshot },
  };
}

export interface ReleaseLeaseResult {
  lease: QuotaLease;
  /** True iff this release actually changed the lease (idempotent guard). */
  changed: boolean;
}

export function releaseLease(
  lease: QuotaLease,
  reason: string,
  nowIso: string = new Date().toISOString(),
): ReleaseLeaseResult {
  if (lease.releasedAt) {
    return { lease, changed: false };
  }
  return {
    lease: {
      ...lease,
      releasedAt: nowIso,
      releaseReason: reason,
    },
    changed: true,
  };
}

// ---------------------------------------------------------------------------
// Material-change detection (§7.5)
// ---------------------------------------------------------------------------

/**
 * Codify what counts as a "material change" between two lease
 * snapshots, per spec §7.5. When the lane state shifted under the
 * renter in a way that invalidates earlier assumptions, the
 * session-management layer flags the rental as needing
 * re-confirmation.
 *
 * Material changes (any one is enough):
 *   1. provider changed
 *   2. model changed
 *   3. quotaLaneId changed
 *   4. confidence downgraded by ≥ 2 levels on the
 *      §17.13 confidence ladder
 *   5. nativeRemaining dropped by ≥ MATERIAL_DROP_FRACTION
 *      of the previous remaining (default 50%) when both readings
 *      are numeric on the same unit
 *   6. nativeResetAt moved (the lane reset) — the renter must
 *      re-confirm because their cost ceiling resets too
 */
export const MATERIAL_DROP_FRACTION = 0.5;

const CONFIDENCE_LADDER: readonly QuotaConfidence[] = [
  "unknown",
  "weak_estimate",
  "estimated",
  "calibrated",
  "derived",
  "local_exact",
  "official_exact",
];

function confidenceIndex(c: QuotaConfidence): number {
  const idx = CONFIDENCE_LADDER.indexOf(c);
  return idx === -1 ? 0 : idx;
}

export interface MaterialChange {
  changed: boolean;
  reasons: string[];
}

export function materiallyChanged(
  prev: QuotaLease,
  next: QuotaLease,
): MaterialChange {
  const reasons: string[] = [];

  if (prev.lane.provider !== next.lane.provider) reasons.push("provider_changed");
  if (prev.lane.model !== next.lane.model) reasons.push("model_changed");
  if (prev.lane.quotaLaneId !== next.lane.quotaLaneId) {
    reasons.push("quota_lane_id_changed");
  }

  const prevConfIdx = confidenceIndex(prev.snapshot.confidence);
  const nextConfIdx = confidenceIndex(next.snapshot.confidence);
  if (prevConfIdx - nextConfIdx >= 2) {
    reasons.push("confidence_downgraded");
  }

  if (
    prev.snapshot.nativeUnit
    && next.snapshot.nativeUnit
    && prev.snapshot.nativeUnit === next.snapshot.nativeUnit
    && typeof prev.snapshot.nativeRemaining === "number"
    && typeof next.snapshot.nativeRemaining === "number"
    && prev.snapshot.nativeRemaining > 0
  ) {
    const drop = (prev.snapshot.nativeRemaining - next.snapshot.nativeRemaining)
      / prev.snapshot.nativeRemaining;
    if (drop >= MATERIAL_DROP_FRACTION) {
      reasons.push("native_remaining_dropped");
    }
  }

  if (prev.snapshot.nativeResetAt !== next.snapshot.nativeResetAt) {
    // null → string OR string → different-string both count.
    // null → null is a no-op (no reset known on either side).
    if (prev.snapshot.nativeResetAt || next.snapshot.nativeResetAt) {
      reasons.push("native_reset_at_changed");
    }
  }

  return { changed: reasons.length > 0, reasons };
}
