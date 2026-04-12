/**
 * Background sweep for rental sessions.
 *
 * Runs every 60 seconds to:
 * 1. Expire sessions past max_duration_minutes
 * 2. Pause sessions with stale heartbeats (>5 min)
 * 3. Expire sessions with dead heartbeats (>15 min)
 * 4. Transition listings to "exhausted" when CU budget is depleted
 */

import { eq, and, sql, lte } from "drizzle-orm";
import { db } from "./db/client.js";
import { rental_listings, rental_sessions } from "./db/schema.js";
import {
  HEARTBEAT_STALE_MS,
  HEARTBEAT_DEAD_MS,
} from "../shared/rental-metering.js";

const SWEEP_INTERVAL_MS = 60_000; // 1 minute

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Expire sessions that have exceeded their max_duration_minutes.
 */
async function expireOverdueSessions(nowISO: string): Promise<number> {
  const result = await db
    .update(rental_sessions)
    .set({
      status: "expired",
      ended_at: nowISO,
      updated_at: nowISO,
    })
    .where(
      and(
        sql`${rental_sessions.status} = 'active'`,
        sql`${rental_sessions.started_at} IS NOT NULL`,
        sql`${rental_sessions.started_at}::timestamptz + (${rental_sessions.max_duration_minutes} || ' minutes')::interval < ${nowISO}::timestamptz`
      )
    )
    .returning({ id: rental_sessions.id });

  return result.length;
}

/**
 * Pause active sessions with stale heartbeats (>5 minutes since last heartbeat).
 * Does NOT pause sessions with no heartbeat at all (they just started).
 */
async function pauseStaleHeartbeatSessions(nowISO: string): Promise<number> {
  const staleThreshold = new Date(Date.now() - HEARTBEAT_STALE_MS).toISOString();

  const result = await db
    .update(rental_sessions)
    .set({
      status: "paused",
      updated_at: nowISO,
    })
    .where(
      and(
        sql`${rental_sessions.status} = 'active'`,
        sql`${rental_sessions.last_heartbeat_at} IS NOT NULL`,
        sql`${rental_sessions.last_heartbeat_at}::timestamptz < ${staleThreshold}::timestamptz`
      )
    )
    .returning({ id: rental_sessions.id });

  return result.length;
}

/**
 * Expire sessions with dead heartbeats (>15 minutes since last heartbeat).
 * Catches both paused-then-abandoned and active-then-dead cases.
 */
async function expireDeadHeartbeatSessions(nowISO: string): Promise<number> {
  const deadThreshold = new Date(Date.now() - HEARTBEAT_DEAD_MS).toISOString();

  const result = await db
    .update(rental_sessions)
    .set({
      status: "expired",
      ended_at: nowISO,
      updated_at: nowISO,
    })
    .where(
      and(
        sql`${rental_sessions.status} IN ('active', 'paused')`,
        sql`${rental_sessions.last_heartbeat_at} IS NOT NULL`,
        sql`${rental_sessions.last_heartbeat_at}::timestamptz < ${deadThreshold}::timestamptz`
      )
    )
    .returning({ id: rental_sessions.id });

  return result.length;
}

/**
 * Transition listings to "exhausted" when their CU budget is fully consumed.
 */
async function exhaustDepletedListings(nowISO: string): Promise<number> {
  const result = await db
    .update(rental_listings)
    .set({
      status: "exhausted",
      updated_at: nowISO,
    })
    .where(
      and(
        sql`${rental_listings.status} = 'active'`,
        sql`${rental_listings.cu_budget_used} >= ${rental_listings.cu_budget_total}`
      )
    )
    .returning({ id: rental_listings.id });

  return result.length;
}

/**
 * Run one sweep cycle.
 */
export async function sweepRentalSessions(): Promise<{
  expired_overdue: number;
  paused_stale: number;
  expired_dead: number;
  exhausted_listings: number;
}> {
  const now = new Date().toISOString();

  const [expired_overdue, paused_stale, expired_dead, exhausted_listings] = await Promise.all([
    expireOverdueSessions(now),
    pauseStaleHeartbeatSessions(now),
    expireDeadHeartbeatSessions(now),
    exhaustDepletedListings(now),
  ]);

  const total = expired_overdue + paused_stale + expired_dead + exhausted_listings;
  if (total > 0) {
    console.log(
      `[rental-sweep] Processed: ${expired_overdue} overdue, ${paused_stale} stale, ${expired_dead} dead, ${exhausted_listings} exhausted listings`
    );
  }

  return { expired_overdue, paused_stale, expired_dead, exhausted_listings };
}

/**
 * Start the background sweep timer.
 */
export function startRentalSweep(): void {
  if (sweepTimer) return; // already running
  console.log("[rental-sweep] Starting background sweep (every 60s)");
  sweepTimer = setInterval(async () => {
    try {
      await sweepRentalSessions();
    } catch (error) {
      console.error("[rental-sweep] Error during sweep:", error);
    }
  }, SWEEP_INTERVAL_MS);
}

/**
 * Stop the background sweep timer.
 */
export function stopRentalSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    console.log("[rental-sweep] Stopped background sweep");
  }
}
