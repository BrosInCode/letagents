import { and, eq, sql } from "drizzle-orm";

import { db } from "../client.js";
import { toRoomAgentDeliverySession } from "../mappers.js";
import { room_agent_delivery_sessions, room_agent_sessions } from "../schema.js";
import type { RoomAgentDeliverySession, RoomAgentDeliverySessionRow } from "../types.js";

export interface LivenessAnnouncementCandidate {
  session: RoomAgentDeliverySession;
  /** Exact retry timestamp installed by the SKIP LOCKED claim. */
  claimed_check_at?: string | null;
  /** Set when the linked worker session was ended deliberately (clean exit). */
  agent_session_ended_at: string | null;
  /**
   * Supervisor-grant workers are daemon-owned. Their recoverable lifecycle is
   * surfaced through the daemon inspector/inbox rather than room chat.
   */
  supervisor_managed?: boolean;
  /**
   * Freshest runtime evidence (tool call or supervisor observation) from the
   * liveness-observation ledger, or null for agents that report none — a
   * silent message channel with a recently active runtime is an agent busy
   * working, not a death.
   */
  runtime_last_active_at: string | null;
  /** Native harness axis only; never inferred from MCP/tool traffic. */
  native_last_active_at?: string | null;
}

const runtimeLastActiveAt = sql<string | null>`(
  SELECT max(GREATEST(o.last_observed_at, COALESCE(o.last_tool_call_at, o.last_observed_at)))
  FROM room_agent_liveness_observations o
  WHERE o.room_id = ${room_agent_delivery_sessions.room_id}
    AND o.agent_session_id = ${room_agent_delivery_sessions.agent_session_id}
    AND o.source = 'native_harness'
)`;

const candidateSelection = {
  session: room_agent_delivery_sessions,
  agent_session_ended_at: room_agent_sessions.ended_at,
  supervisor_managed: sql<boolean>`${room_agent_sessions.supervisor_grant_id} IS NOT NULL`,
  runtime_last_active_at: runtimeLastActiveAt,
  native_last_active_at: runtimeLastActiveAt,
};

function toCandidate(row: {
  session: typeof room_agent_delivery_sessions.$inferSelect;
  agent_session_ended_at: string | null;
  supervisor_managed: boolean;
  runtime_last_active_at: string | null;
  native_last_active_at: string | null;
}): LivenessAnnouncementCandidate {
  return {
    session: toRoomAgentDeliverySession(row.session as RoomAgentDeliverySessionRow),
    agent_session_ended_at: row.agent_session_ended_at ?? null,
    supervisor_managed: Boolean(row.supervisor_managed),
    runtime_last_active_at: row.runtime_last_active_at ?? null,
    native_last_active_at: row.native_last_active_at ?? null,
  };
}

/**
 * Atomically claim a bounded page of due worker delivery sessions. The due
 * index replaces the former scan of every row touched in the last hour;
 * transition semantics remain in the sweeper and a claim is retryable after
 * one minute if its worker crashes before evaluation completes.
 */
export async function listLivenessAnnouncementCandidates(options?: {
  now?: number;
  limit?: number;
}): Promise<LivenessAnnouncementCandidate[]> {
  const now = options?.now ?? Date.now();
  const limit = Math.min(Math.max(options?.limit ?? 250, 1), 1_000);
  const retryAt = new Date(now + 60_000).toISOString();
  const dueRows = await db.execute<{
    room_id: string;
    delivery_key: string;
    claimed_check_at: string | null;
    eligible: boolean;
  }>(sql`
    WITH due AS (
      SELECT ${room_agent_delivery_sessions.room_id}, ${room_agent_delivery_sessions.delivery_key},
             ${room_agent_delivery_sessions.updated_at} >= ${new Date(now - 60 * 60_000).toISOString()}::timestamptz AS eligible
        FROM ${room_agent_delivery_sessions}
       WHERE ${room_agent_delivery_sessions.session_kind} = 'worker'
         AND ${room_agent_delivery_sessions.next_liveness_check_at} <= ${new Date(now).toISOString()}::timestamptz
       ORDER BY ${room_agent_delivery_sessions.next_liveness_check_at},
                ${room_agent_delivery_sessions.room_id}, ${room_agent_delivery_sessions.delivery_key}
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE ${room_agent_delivery_sessions} AS delivery
       SET next_liveness_check_at = CASE WHEN due.eligible
         THEN ${retryAt}::timestamptz ELSE NULL END
      FROM due
     WHERE delivery.room_id = due.room_id
       AND delivery.delivery_key = due.delivery_key
    RETURNING delivery.room_id, delivery.delivery_key,
              delivery.next_liveness_check_at AS claimed_check_at,
              due.eligible
  `);
  const eligibleRows = dueRows.rows.filter((row) => row.eligible && row.claimed_check_at !== null);
  if (eligibleRows.length === 0) return [];
  const rows = await db
    .select(candidateSelection)
    .from(room_agent_delivery_sessions)
    .leftJoin(room_agent_sessions, eq(room_agent_sessions.session_id, room_agent_delivery_sessions.agent_session_id))
    .where(sql`(${room_agent_delivery_sessions.room_id}, ${room_agent_delivery_sessions.delivery_key}) IN (
      SELECT value->>0, value->>1
        FROM jsonb_array_elements(${JSON.stringify(eligibleRows.map((row) => [row.room_id, row.delivery_key]))}::jsonb)
    )`);

  const claimByKey = new Map(eligibleRows.map((row) => [
    `${row.room_id}\u001f${row.delivery_key}`,
    row.claimed_check_at,
  ]));
  return rows.map((row) => ({
    ...toCandidate(row),
    claimed_check_at: claimByKey.get(`${row.session.room_id}\u001f${row.session.delivery_key}`) ?? null,
  }));
}

/** Persist the next semantic check after a claimed candidate produced no transition. */
export async function rescheduleLivenessAnnouncementCandidate(input: {
  room_id: string;
  delivery_key: string;
  claimed_check_at: string;
  next_check_at: string | null;
}): Promise<void> {
  await db.update(room_agent_delivery_sessions)
    .set({ next_liveness_check_at: input.next_check_at })
    .where(and(
      eq(room_agent_delivery_sessions.room_id, input.room_id),
      eq(room_agent_delivery_sessions.delivery_key, input.delivery_key),
      eq(room_agent_delivery_sessions.next_liveness_check_at, input.claimed_check_at),
    ));
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
