/**
 * Quota Lease orchestrator — DB-backed wrapper around the pure
 * decision logic in `quota-lease.ts` (p2.9b).
 *
 * This module wires the §17.8 "one active rental per quota lane"
 * enforcement into the rental_sessions row + activity emitter,
 * without yet plumbing into `sessions.accept` / `sessions.cancel`.
 * A separate follow-up (p2.9c) flips the call-sites so existing
 * accept/decline/cancel/complete routes call into here.
 *
 * Why split this slice from the call-site wiring:
 *   • This PR can land without modifying the high-traffic
 *     `sessions.ts` + `rental-provider.ts` route files, where
 *     other agents are in-flight on adjacent code.
 *   • Tests stay focused: orchestration logic over an injected
 *     DB-shaped interface, no real DB needed.
 *
 * Behavior:
 *   acquireLease(input, deps)
 *     1. Load active leases for the lane via deps.loadActiveLeasesForLane.
 *     2. Decide via `canCreateLease` (pure).
 *     3. If denied (lane_locked / invalid_lane): return decision verbatim.
 *     4. If allowed (available / same_session):
 *          a. Build a fresh lease via `createLease`.
 *          b. Persist via deps.persistSessionLease (idempotent under
 *             same_session re-entry — caller can replay).
 *          c. Emit a `SESSION_LEASE_CREATED` activity event.
 *
 *   releaseSessionLease(sessionId, reason, deps)
 *     1. Load the current lease via deps.loadSessionLease.
 *     2. If absent or already released: return { released: false }.
 *     3. releaseLease → persist → emit activity event for the
 *        release reason.
 *
 * Spec refs:
 *   §17.8 one active rental per quota lane
 *   §19.2 rental_sessions.quota_lease jsonb (set/cleared here)
 *   §9.4  session.lease_created activity event
 *
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p2.9 (orchestration slice).
 */

import {
  SESSION_LEASE_CREATED,
  SESSION_TEARDOWN_COMPLETED,
  type RentalActivitySource,
} from "./activity-event-types.js";
import {
  QUOTA_LEASE_REASONS,
  canCreateLease,
  createLease,
  releaseLease,
  type QuotaLane,
  type QuotaLease,
  type QuotaLeaseReason,
  type QuotaLeaseSnapshot,
} from "./quota-lease.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface QuotaLeaseOrchestratorDeps {
  /**
   * Return all rental_sessions whose `quota_lease` is non-null AND
   * whose `quota_lease.lane` matches `lane.provider` + `lane.model`.
   * Caller is responsible for filtering out released leases so the
   * orchestrator gets an actively-held set.
   *
   * Implementations typically run:
   *   SELECT id, quota_lease
   *     FROM rental_sessions
   *    WHERE quota_lease IS NOT NULL
   *      AND quota_lease->>'releasedAt' IS NULL
   *      AND quota_lease->'lane'->>'provider' = $1
   *      AND quota_lease->'lane'->>'model'    IS NOT DISTINCT FROM $2
   */
  loadActiveLeasesForLane(lane: QuotaLane): Promise<QuotaLease[]>;
  /**
   * Return the lease persisted on `rental_sessions.quota_lease` for
   * this session, or null when none is set.
   */
  loadSessionLease(sessionId: string): Promise<QuotaLease | null>;
  /**
   * Persist a lease to `rental_sessions.quota_lease`. Implementations
   * MUST set this column atomically per-session.
   */
  persistSessionLease(sessionId: string, lease: QuotaLease): Promise<void>;
  /**
   * Append a `session.lease_created` / `session.teardown_completed`
   * activity event. Caller provides the session's room_id since the
   * orchestrator doesn't read sessions itself.
   */
  emitLeaseEvent(input: {
    sessionId: string;
    roomId: string;
    eventType:
      | typeof SESSION_LEASE_CREATED
      | typeof SESSION_TEARDOWN_COMPLETED;
    source: RentalActivitySource;
    payload: Record<string, unknown>;
  }): Promise<void>;
  /** Inject a clock for deterministic tests. */
  now(): string;
}

// ---------------------------------------------------------------------------
// acquireLease
// ---------------------------------------------------------------------------

export interface AcquireLeaseInput {
  sessionId: string;
  /** The session's room id — required for the activity event. */
  roomId: string;
  lane: QuotaLane;
  snapshot: QuotaLeaseSnapshot;
}

export interface AcquireLeaseSuccess {
  ok: true;
  reason:
    | typeof QUOTA_LEASE_REASONS.AVAILABLE
    | typeof QUOTA_LEASE_REASONS.SAME_SESSION;
  lease: QuotaLease;
  conflictingSessionId: null;
}

export interface AcquireLeaseFailure {
  ok: false;
  reason: QuotaLeaseReason;
  lease: null;
  conflictingSessionId: string | null;
}

export type AcquireLeaseResult = AcquireLeaseSuccess | AcquireLeaseFailure;

export async function acquireLease(
  input: AcquireLeaseInput,
  deps: QuotaLeaseOrchestratorDeps,
): Promise<AcquireLeaseResult> {
  const active = await deps.loadActiveLeasesForLane(input.lane);
  const decision = canCreateLease(active, input.lane, input.sessionId);

  if (!decision.allowed) {
    return {
      ok: false,
      reason: decision.reason,
      lease: null,
      conflictingSessionId: decision.heldBy,
    };
  }

  const lease = createLease({
    sessionId: input.sessionId,
    lane: input.lane,
    snapshot: input.snapshot,
    nowIso: deps.now(),
  });

  await deps.persistSessionLease(input.sessionId, lease);

  // Only emit the activity event when a fresh lease is created
  // (i.e. `available`). `same_session` re-entry is idempotent and
  // should not double-emit; we still persist (to refresh the
  // lastRefreshedAt) but skip the event.
  if (decision.reason === QUOTA_LEASE_REASONS.AVAILABLE) {
    await deps.emitLeaseEvent({
      sessionId: input.sessionId,
      roomId: input.roomId,
      eventType: SESSION_LEASE_CREATED,
      source: "system",
      payload: {
        lane: {
          provider: input.lane.provider,
          model: input.lane.model,
          quota_lane_id: input.lane.quotaLaneId,
        },
        locked_at: lease.lockedAt,
        snapshot_confidence: input.snapshot.confidence,
        snapshot_unit: input.snapshot.nativeUnit,
        snapshot_remaining: input.snapshot.nativeRemaining,
      },
    });
  }

  // canCreateLease only returns AVAILABLE or SAME_SESSION when
  // allowed=true, but the static type on decision.reason is the
  // wider QuotaLeaseReason union. Narrow explicitly so the success
  // arm of AcquireLeaseResult stays type-safe.
  const allowedReason: AcquireLeaseSuccess["reason"] =
    decision.reason === QUOTA_LEASE_REASONS.SAME_SESSION
      ? QUOTA_LEASE_REASONS.SAME_SESSION
      : QUOTA_LEASE_REASONS.AVAILABLE;

  return {
    ok: true,
    reason: allowedReason,
    lease,
    conflictingSessionId: null,
  };
}

// ---------------------------------------------------------------------------
// releaseSessionLease
// ---------------------------------------------------------------------------

export interface ReleaseLeaseInput {
  sessionId: string;
  roomId: string;
  reason: string;
}

export interface ReleaseSessionLeaseResult {
  released: boolean;
  lease: QuotaLease | null;
}

export async function releaseSessionLease(
  input: ReleaseLeaseInput,
  deps: QuotaLeaseOrchestratorDeps,
): Promise<ReleaseSessionLeaseResult> {
  const current = await deps.loadSessionLease(input.sessionId);
  if (!current) {
    return { released: false, lease: null };
  }
  const { lease, changed } = releaseLease(current, input.reason, deps.now());
  if (!changed) {
    return { released: false, lease: current };
  }
  await deps.persistSessionLease(input.sessionId, lease);
  await deps.emitLeaseEvent({
    sessionId: input.sessionId,
    roomId: input.roomId,
    eventType: SESSION_TEARDOWN_COMPLETED,
    source: "system",
    payload: {
      reason: input.reason,
      lane: {
        provider: lease.lane.provider,
        model: lease.lane.model,
        quota_lane_id: lease.lane.quotaLaneId,
      },
      locked_at: lease.lockedAt,
      released_at: lease.releasedAt,
      last_refreshed_at: lease.lastRefreshedAt,
    },
  });
  return { released: true, lease };
}
