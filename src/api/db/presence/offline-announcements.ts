import { and, eq, gte } from "drizzle-orm";

import { db } from "../client.js";
import { toRoomAgentDeliverySession } from "../mappers.js";
import { room_agent_delivery_sessions, room_agent_sessions } from "../schema.js";
import type { RoomAgentDeliverySession, RoomAgentDeliverySessionRow } from "../types.js";

export interface LivenessAnnouncementCandidate {
  session: RoomAgentDeliverySession;
  /** Set when the linked worker session was ended deliberately (clean exit). */
  agent_session_ended_at: string | null;
}

const candidateSelection = {
  session: room_agent_delivery_sessions,
  agent_session_ended_at: room_agent_sessions.ended_at,
};

function toCandidate(row: {
  session: typeof room_agent_delivery_sessions.$inferSelect;
  agent_session_ended_at: string | null;
}): LivenessAnnouncementCandidate {
  return {
    session: toRoomAgentDeliverySession(row.session as RoomAgentDeliverySessionRow),
    agent_session_ended_at: row.agent_session_ended_at ?? null,
  };
}

/**
 * Worker delivery sessions that may need an offline or recovery announcement.
 * The only cut here is recency: any worker row touched (connected,
 * heartbeated, or disconnected) within `withinMs` is a candidate, so
 * long-dead rows never re-enter the announcement pipeline. All transition
 * logic — reachability, announcement epochs, recovery matching — lives in the
 * liveness sweeper, deliberately NOT in this query: filtering on announcement
 * markers here has already hidden a real case once (a dead-socket death after
 * a recovery, where last_disconnected_at is NULL).
 */
export async function listLivenessAnnouncementCandidates(options?: {
  withinMs?: number;
  now?: number;
}): Promise<LivenessAnnouncementCandidate[]> {
  const now = options?.now ?? Date.now();
  const cutoff = new Date(now - (options?.withinMs ?? 60 * 60 * 1000)).toISOString();

  const rows = await db
    .select(candidateSelection)
    .from(room_agent_delivery_sessions)
    .leftJoin(
      room_agent_sessions,
      eq(room_agent_sessions.session_id, room_agent_delivery_sessions.agent_session_id)
    )
    .where(
      and(
        eq(room_agent_delivery_sessions.session_kind, "worker"),
        gte(room_agent_delivery_sessions.updated_at, cutoff)
      )
    );

  return rows.map(toCandidate);
}

/** Fresh single-row re-read used to revalidate a transition just before emitting. */
export async function getLivenessAnnouncementCandidate(input: {
  room_id: string;
  delivery_key: string;
}): Promise<LivenessAnnouncementCandidate | null> {
  const [row] = await db
    .select(candidateSelection)
    .from(room_agent_delivery_sessions)
    .leftJoin(
      room_agent_sessions,
      eq(room_agent_sessions.session_id, room_agent_delivery_sessions.agent_session_id)
    )
    .where(
      and(
        eq(room_agent_delivery_sessions.room_id, input.room_id),
        eq(room_agent_delivery_sessions.delivery_key, input.delivery_key)
      )
    )
    .limit(1);

  return row ? toCandidate(row) : null;
}

/** db or the message-create transaction — markers must commit atomically with their message. */
export type OfflineAnnouncementExecutor = Pick<typeof db, "update">;

/**
 * Record that the offline announcement for the current outage was posted.
 * Pass the message-create transaction as the executor so the marker commits
 * atomically with the room message: neither an orphaned message (announced
 * but never marked) nor a silent marker (marked but never announced) can
 * exist after any crash or failure ordering.
 */
export async function markAgentOfflineAnnounced(
  input: {
    room_id: string;
    delivery_key: string;
    announced_at?: string;
  },
  executor: OfflineAnnouncementExecutor = db
): Promise<boolean> {
  const announcedAt = input.announced_at ?? new Date().toISOString();
  const rows = await executor
    .update(room_agent_delivery_sessions)
    .set({ offline_announced_at: announcedAt })
    .where(
      and(
        eq(room_agent_delivery_sessions.room_id, input.room_id),
        eq(room_agent_delivery_sessions.delivery_key, input.delivery_key)
      )
    )
    .returning({ delivery_key: room_agent_delivery_sessions.delivery_key });

  return rows.length > 0;
}

/** Record that the recovery announcement matching a prior outage was posted. */
export async function markAgentRecoveryAnnounced(
  input: {
    room_id: string;
    delivery_key: string;
    announced_at?: string;
  },
  executor: OfflineAnnouncementExecutor = db
): Promise<boolean> {
  const announcedAt = input.announced_at ?? new Date().toISOString();
  const rows = await executor
    .update(room_agent_delivery_sessions)
    .set({ recovery_announced_at: announcedAt })
    .where(
      and(
        eq(room_agent_delivery_sessions.room_id, input.room_id),
        eq(room_agent_delivery_sessions.delivery_key, input.delivery_key)
      )
    )
    .returning({ delivery_key: room_agent_delivery_sessions.delivery_key });

  return rows.length > 0;
}
