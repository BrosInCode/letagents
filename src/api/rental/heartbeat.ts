/**
 * Rental Heartbeat / Liveness Service — p1.5
 *
 * Implements §18.3: provider agent liveness monitoring during active
 * rental sessions.
 *
 * Responsibilities:
 *   recordHeartbeat  — accepts a heartbeat from the provider agent,
 *                      transitions provisioning→active on first beat,
 *                      updates heartbeat_count + last_heartbeat_at.
 *   getLivenessStatus — evaluates the current liveness state of a
 *                       session based on last_heartbeat_at.
 *   checkStaleSessions — finds sessions that should transition to
 *                        stale or expired based on heartbeat timeouts.
 *   expireSession      — transitions a session to expired state.
 *
 * Heartbeat timing (§18.3, tunable):
 *   - heartbeat every 30 seconds
 *   - mark stale after 2 minutes (120s)
 *   - show disconnected after 5 minutes (300s)
 *   - expire after 15 minutes (900s)
 *
 * Spec §18.2, §18.3.
 */

import { isValidTransition } from "./session-state-machine.js";
import {
  SESSION_STARTED,
  AGENT_HEARTBEAT,
} from "./activity-event-types.js";

// ===== Constants =====

/** Heartbeat timing thresholds (seconds). */
export const HEARTBEAT_THRESHOLDS = {
  /** Expected interval between heartbeats. */
  interval: 30,
  /** Mark session as stale after this many seconds without heartbeat. */
  staleAfter: 120,
  /** Show disconnected warning after this many seconds. */
  disconnectedAfter: 300,
  /** Expire session after this many seconds without heartbeat. */
  expireAfter: 900,
} as const;

/** Liveness states for display/API. */
export type LivenessStatus = "healthy" | "stale" | "disconnected" | "expired" | "unknown";

// ===== Types =====

export interface HeartbeatResult {
  /** Whether the heartbeat was accepted. */
  ok: boolean;
  /** Updated session status (may change from provisioning→active). */
  status: string;
  /** Updated heartbeat count. */
  heartbeatCount: number;
  /** Whether this heartbeat triggered a status transition. */
  transitioned: boolean;
  /** Error message if heartbeat was rejected. */
  error?: string;
}

export interface LivenessInfo {
  sessionId: string;
  status: LivenessStatus;
  lastHeartbeatAt: Date | null;
  heartbeatCount: number;
  /** Seconds since last heartbeat (null if no heartbeat received). */
  secondsSinceLastHeartbeat: number | null;
  sessionStatus: string;
}

export interface StaleSessionInfo {
  sessionId: string;
  sessionStatus: string;
  lastHeartbeatAt: Date | null;
  secondsSinceLastHeartbeat: number;
  shouldTransitionTo: "stale" | "expired";
}

// ===== Dependency injection interface =====

/** Minimal session shape used by heartbeat logic (decoupled from drizzle schema). */
export interface SessionRecord {
  id: string;
  provider_account_id: string;
  status: string;
  room_id: string | null;
  heartbeat_count: number;
  last_heartbeat_at: Date | null;
  started_at: Date | null;
}

export interface HeartbeatDeps {
  getSession: (sessionId: string) => Promise<SessionRecord | null>;
  updateSession: (
    sessionId: string,
    data: Record<string, unknown>
  ) => Promise<SessionRecord | null>;
  findStaleSessions?: (staleThreshold: Date) => Promise<SessionRecord[]>;
  emitActivityEvent?: (
    sessionId: string,
    roomId: string,
    eventType: string,
    source: string,
    payload: Record<string, unknown>
  ) => Promise<void>;
}

/**
 * Create default DB-backed deps. Lazily imported to avoid
 * module-level DB connection (enables test isolation).
 */
export async function createDefaultDeps(): Promise<HeartbeatDeps> {
  const { eq, and, lt, inArray } = await import("drizzle-orm");
  const { db } = await import("../db/client.js");
  const { rental_sessions } = await import("../db/schema.js");

  return {
    async getSession(sessionId: string) {
      const [session] = await db
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, sessionId));
      return (session as unknown as SessionRecord) ?? null;
    },

    async updateSession(sessionId, data) {
      const [updated] = await db
        .update(rental_sessions)
        .set({ ...data, updated_at: new Date() } as Record<string, unknown>)
        .where(eq(rental_sessions.id, sessionId))
        .returning();
      return (updated as unknown as SessionRecord) ?? null;
    },

    async findStaleSessions(staleThreshold: Date) {
      const rows = await db
        .select()
        .from(rental_sessions)
        .where(
          and(
            inArray(rental_sessions.status, ["active", "stale"]),
            lt(rental_sessions.last_heartbeat_at, staleThreshold)
          )
        );
      return rows as unknown as SessionRecord[];
    },
  };
}

// ===== Service functions =====

/**
 * Record a heartbeat from the provider agent.
 *
 * Behavior:
 * - If session is "provisioning", transition to "active" on first heartbeat.
 * - If session is "active" or "stale", update heartbeat and (for stale) recover to active.
 * - If session is in any terminal state, reject the heartbeat.
 * - Increments heartbeat_count and updates last_heartbeat_at.
 */
export async function recordHeartbeat(
  sessionId: string,
  accountId: string,
  deps: HeartbeatDeps
): Promise<HeartbeatResult> {
  const session = await deps.getSession(sessionId);

  if (!session) {
    return { ok: false, status: "unknown", heartbeatCount: 0, transitioned: false, error: "session_not_found" };
  }

  // Only the provider agent can heartbeat
  if (session.provider_account_id !== accountId) {
    return { ok: false, status: session.status, heartbeatCount: session.heartbeat_count ?? 0, transitioned: false, error: "not_provider" };
  }

  const currentStatus = session.status;
  const now = new Date();
  let transitioned = false;
  let newStatus = currentStatus;

  // Determine target status
  if (currentStatus === "provisioning") {
    // First heartbeat transitions to active
    if (isValidTransition("provisioning", "active")) {
      newStatus = "active";
      transitioned = true;
    }
  } else if (currentStatus === "stale") {
    // Heartbeat recovers from stale
    if (isValidTransition("stale", "active")) {
      newStatus = "active";
      transitioned = true;
    }
  } else if (currentStatus === "active" || currentStatus === "blocked") {
    // Normal heartbeat, keep current status
    newStatus = currentStatus;
  } else {
    // Terminal or incompatible state — reject
    return {
      ok: false,
      status: currentStatus,
      heartbeatCount: session.heartbeat_count ?? 0,
      transitioned: false,
      error: `invalid_status: cannot heartbeat in ${currentStatus} state`,
    };
  }

  const currentCount = session.heartbeat_count ?? 0;
  const newCount = currentCount + 1;

  const updateData: Record<string, unknown> = {
    heartbeat_count: newCount,
    last_heartbeat_at: now,
  };
  if (transitioned) {
    updateData.status = newStatus;
    if (newStatus === "active" && !session.started_at) {
      updateData.started_at = now;
    }
  }

  const updated = await deps.updateSession(sessionId, updateData);

  if (!updated) {
    return { ok: false, status: currentStatus, heartbeatCount: currentCount, transitioned: false, error: "update_failed" };
  }

  // Emit activity event if transitioned
  if (transitioned && deps.emitActivityEvent && session.room_id) {
    try {
      await deps.emitActivityEvent(
        sessionId,
        session.room_id,
        currentStatus === "provisioning" ? SESSION_STARTED : AGENT_HEARTBEAT,
        "system",
        {
          from: currentStatus,
          to: newStatus,
          heartbeat_count: newCount,
        }
      );
    } catch {
      // Don't fail the heartbeat if event emission fails
    }
  }

  return {
    ok: true,
    status: newStatus,
    heartbeatCount: newCount,
    transitioned,
  };
}

/**
 * Get the current liveness status of a session.
 *
 * Uses the thresholds from §18.3:
 *   - healthy: last heartbeat within staleAfter
 *   - stale: last heartbeat between staleAfter and disconnectedAfter
 *   - disconnected: last heartbeat between disconnectedAfter and expireAfter
 *   - expired: last heartbeat beyond expireAfter
 *   - unknown: no heartbeat received yet
 */
export function getLivenessStatus(
  session: {
    id: string;
    status: string;
    heartbeat_count: number | null;
    last_heartbeat_at: Date | null;
  },
  now: Date = new Date()
): LivenessInfo {
  const heartbeatCount = session.heartbeat_count ?? 0;
  const lastHeartbeatAt = session.last_heartbeat_at
    ? (session.last_heartbeat_at instanceof Date ? session.last_heartbeat_at : new Date(session.last_heartbeat_at as string))
    : null;

  if (!lastHeartbeatAt || heartbeatCount === 0) {
    return {
      sessionId: session.id,
      status: "unknown",
      lastHeartbeatAt: null,
      heartbeatCount: 0,
      secondsSinceLastHeartbeat: null,
      sessionStatus: session.status,
    };
  }

  const secondsSince = Math.floor((now.getTime() - lastHeartbeatAt.getTime()) / 1000);
  let livenessStatus: LivenessStatus;

  if (secondsSince <= HEARTBEAT_THRESHOLDS.staleAfter) {
    livenessStatus = "healthy";
  } else if (secondsSince <= HEARTBEAT_THRESHOLDS.disconnectedAfter) {
    livenessStatus = "stale";
  } else if (secondsSince <= HEARTBEAT_THRESHOLDS.expireAfter) {
    livenessStatus = "disconnected";
  } else {
    livenessStatus = "expired";
  }

  return {
    sessionId: session.id,
    status: livenessStatus,
    lastHeartbeatAt,
    heartbeatCount,
    secondsSinceLastHeartbeat: secondsSince,
    sessionStatus: session.status,
  };
}

/**
 * Find sessions that should transition to stale or expired.
 *
 * Scans active/stale sessions and checks heartbeat freshness.
 * Returns a list of sessions that need state transitions.
 */
export async function checkStaleSessions(
  deps: HeartbeatDeps
): Promise<StaleSessionInfo[]> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - HEARTBEAT_THRESHOLDS.staleAfter * 1000);
  const expireThreshold = new Date(now.getTime() - HEARTBEAT_THRESHOLDS.expireAfter * 1000);

  if (!deps.findStaleSessions) {
    throw new Error("findStaleSessions not implemented in deps");
  }

  const activeSessions = await deps.findStaleSessions(staleThreshold);

  const results: StaleSessionInfo[] = [];

  for (const session of activeSessions) {
    const lastBeat = session.last_heartbeat_at
      ? (session.last_heartbeat_at instanceof Date ? session.last_heartbeat_at : new Date(session.last_heartbeat_at as string))
      : null;

    if (!lastBeat) continue;

    const secondsSince = Math.floor((now.getTime() - lastBeat.getTime()) / 1000);

    if (lastBeat < expireThreshold) {
      results.push({
        sessionId: session.id,
        sessionStatus: session.status,
        lastHeartbeatAt: lastBeat,
        secondsSinceLastHeartbeat: secondsSince,
        shouldTransitionTo: "expired",
      });
    } else if (session.status === "active" && lastBeat < staleThreshold) {
      results.push({
        sessionId: session.id,
        sessionStatus: session.status,
        lastHeartbeatAt: lastBeat,
        secondsSinceLastHeartbeat: secondsSince,
        shouldTransitionTo: "stale",
      });
    }
  }

  return results;
}

/**
 * Transition a session to expired state.
 *
 * Only valid from active or stale states per §18.2.
 */
export async function expireSession(
  sessionId: string,
  reason: string = "heartbeat_timeout",
  deps: HeartbeatDeps
): Promise<{ ok: boolean; error?: string }> {
  const session = await deps.getSession(sessionId);
  if (!session) {
    return { ok: false, error: "session_not_found" };
  }

  if (!isValidTransition(session.status, "expired")) {
    return { ok: false, error: `cannot_expire: current status is ${session.status}` };
  }

  const updated = await deps.updateSession(sessionId, {
    status: "expired",
    ended_at: new Date(),
  });

  if (!updated) {
    return { ok: false, error: "update_failed" };
  }

  // Note: no §9.4 taxonomy event for heartbeat-based expiry.
  // The session.cancelled event is reserved for explicit renter/provider
  // cancellation. Once the taxonomy is extended with a session.expired
  // event, emit it here.

  return { ok: true };
}

/**
 * Mark a session as stale.
 *
 * Only valid from active state per §18.2.
 */
export async function markSessionStale(
  sessionId: string,
  deps: HeartbeatDeps
): Promise<{ ok: boolean; error?: string }> {
  const session = await deps.getSession(sessionId);
  if (!session) {
    return { ok: false, error: "session_not_found" };
  }

  if (!isValidTransition(session.status, "stale")) {
    return { ok: false, error: `cannot_mark_stale: current status is ${session.status}` };
  }

  const updated = await deps.updateSession(sessionId, {
    status: "stale",
  });

  if (!updated) {
    return { ok: false, error: "update_failed" };
  }

  // Note: no §9.4 taxonomy event for session liveness staleness.
  // budget.meter_stale is budget-specific. Once the taxonomy is
  // extended with a session.stale event, emit it here.

  return { ok: true };
}
