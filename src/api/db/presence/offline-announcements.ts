import { and, eq, gte, isNull, or, sql } from "drizzle-orm";

import { db } from "../client.js";
import { toRoomAgentDeliverySession } from "../mappers.js";
import { room_agent_delivery_sessions, room_agent_sessions } from "../schema.js";
import type { RoomAgentDeliverySession, RoomAgentDeliverySessionRow } from "../types.js";

export interface LivenessAnnouncementCandidate {
  session: RoomAgentDeliverySession;
  /** Set when the linked worker session was ended deliberately (clean exit). */
  agent_session_ended_at: string | null;
}

/**
 * Worker delivery sessions that may need an offline or recovery announcement.
 * The coarse cut is recency: any row touched (connected, heartbeated, or
 * disconnected) within `withinMs` is a candidate; long-dead rows never
 * re-enter the announcement pipeline. Fine-grained reachability and epoch
 * checks happen in the liveness sweeper.
 */
export async function listLivenessAnnouncementCandidates(options?: {
  withinMs?: number;
  now?: number;
}): Promise<LivenessAnnouncementCandidate[]> {
  const now = options?.now ?? Date.now();
  const cutoff = new Date(now - (options?.withinMs ?? 60 * 60 * 1000)).toISOString();

  const rows = await db
    .select({
      session: room_agent_delivery_sessions,
      agent_session_ended_at: room_agent_sessions.ended_at,
    })
    .from(room_agent_delivery_sessions)
    .leftJoin(
      room_agent_sessions,
      eq(room_agent_sessions.session_id, room_agent_delivery_sessions.agent_session_id)
    )
    .where(
      and(
        eq(room_agent_delivery_sessions.session_kind, "worker"),
        gte(room_agent_delivery_sessions.updated_at, cutoff),
        or(
          // Not yet announced for the current disconnect epoch.
          isNull(room_agent_delivery_sessions.offline_announced_at),
          sql`${room_agent_delivery_sessions.offline_announced_at} < ${room_agent_delivery_sessions.last_disconnected_at}`,
          // Announced offline without a matching recovery announcement yet.
          isNull(room_agent_delivery_sessions.recovery_announced_at),
          sql`${room_agent_delivery_sessions.recovery_announced_at} < ${room_agent_delivery_sessions.offline_announced_at}`
        )
      )
    );

  return rows.map((row) => ({
    session: toRoomAgentDeliverySession(row.session as RoomAgentDeliverySessionRow),
    agent_session_ended_at: row.agent_session_ended_at ?? null,
  }));
}

/**
 * Claim the offline announcement for one disconnect epoch. Optimistic guard on
 * the previously read marker value makes this exactly-once across concurrent
 * sweepers and server restarts.
 */
export async function markAgentOfflineAnnounced(input: {
  room_id: string;
  delivery_key: string;
  expected_offline_announced_at: string | null;
  announced_at?: string;
}): Promise<boolean> {
  const announcedAt = input.announced_at ?? new Date().toISOString();
  const rows = await db
    .update(room_agent_delivery_sessions)
    .set({ offline_announced_at: announcedAt })
    .where(
      and(
        eq(room_agent_delivery_sessions.room_id, input.room_id),
        eq(room_agent_delivery_sessions.delivery_key, input.delivery_key),
        sql`${room_agent_delivery_sessions.offline_announced_at} IS NOT DISTINCT FROM ${input.expected_offline_announced_at}::timestamptz`
      )
    )
    .returning({ delivery_key: room_agent_delivery_sessions.delivery_key });

  return rows.length > 0;
}

/** Claim the recovery announcement matching a prior offline announcement. */
export async function markAgentRecoveryAnnounced(input: {
  room_id: string;
  delivery_key: string;
  expected_recovery_announced_at: string | null;
  announced_at?: string;
}): Promise<boolean> {
  const announcedAt = input.announced_at ?? new Date().toISOString();
  const rows = await db
    .update(room_agent_delivery_sessions)
    .set({ recovery_announced_at: announcedAt })
    .where(
      and(
        eq(room_agent_delivery_sessions.room_id, input.room_id),
        eq(room_agent_delivery_sessions.delivery_key, input.delivery_key),
        sql`${room_agent_delivery_sessions.recovery_announced_at} IS NOT DISTINCT FROM ${input.expected_recovery_announced_at}::timestamptz`
      )
    )
    .returning({ delivery_key: room_agent_delivery_sessions.delivery_key });

  return rows.length > 0;
}
