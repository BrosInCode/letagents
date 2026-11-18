import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { ACTIVE_AGENT_PRESENCE_WINDOW_MS } from "../../shared/agent-presence.js";
import { FINISHED_JOB_STATES, type JobState } from "../../../shared/api/jobs.mjs";
import { db } from "./client.js";
import { getRecentHumanConversationRecipient } from "./messages/account-agent-routing.js";
import { api_jobs, room_agent_delivery_sessions, room_agent_sessions, type ApiJobRow } from "./schema.js";
import type { MessageCreateTransaction } from "./messages/create/types.js";

export type { ApiJobRow };

// Online worker sessions read for one job; far above any real room.
const MAX_ONLINE_LOOKUP_SESSIONS = 200;
// A message number above any real one: the recent-partner lookup reads the
// messages before it.
const AFTER_EVERY_MESSAGE = 2_147_483_647;
const UNFINISHED_JOB_STATES: JobState[] = ["queued", "no_agent", "running", "needs_input"];

export async function insertApiJob(row: ApiJobRow, executor: Pick<MessageCreateTransaction, "insert"> | typeof db = db): Promise<void> {
  await executor.insert(api_jobs).values(row);
}

export async function getApiJob(roomId: string, id: string): Promise<ApiJobRow | null> {
  const [row] = await db.select().from(api_jobs).where(and(eq(api_jobs.room_id, roomId), eq(api_jobs.id, id))).limit(1);
  return row ?? null;
}

export async function listApiJobs(roomId: string, options: { state?: JobState; limit: number }): Promise<ApiJobRow[]> {
  return db.select().from(api_jobs)
    .where(and(eq(api_jobs.room_id, roomId), options.state ? eq(api_jobs.state, options.state) : undefined))
    .orderBy(desc(api_jobs.created_at), desc(api_jobs.id))
    .limit(options.limit);
}

export type ApiJobChange = Partial<Pick<ApiJobRow, "state" | "progress" | "result" | "error" | "finished_at">>;

/**
 * Applies a change to a job that has not finished, in one statement, so two
 * writers cannot both finish it. Returns the updated row, or null when the
 * job is gone or already finished.
 */
export async function updateUnfinishedApiJob(roomId: string, id: string, change: ApiJobChange, now: string): Promise<ApiJobRow | null> {
  const [row] = await db.update(api_jobs)
    .set({ ...change, updated_at: now })
    .where(and(
      eq(api_jobs.room_id, roomId),
      eq(api_jobs.id, id),
      inArray(api_jobs.state, UNFINISHED_JOB_STATES),
    ))
    .returning();
  return row ?? null;
}

export function isFinishedJobState(state: JobState): boolean {
  return (FINISHED_JOB_STATES as readonly string[]).includes(state);
}

/**
 * The agent keys online in the room now, longest-present first. Online means
 * a worker session whose delivery connection is reachable: open and seen
 * inside the 90 s presence window, or inside its reconnect grace (the test
 * `isAgentDeliverySessionReachable` makes, and routing uses for a mention).
 * An open session alone is not enough: sessions that were never ended stay
 * open long after their agent left. Reachability is filtered here, before the
 * bound, so old silent sessions cannot crowd out a live agent.
 */
export async function listOnlineRoomAgentKeys(roomId: string, nowMs = Date.now()): Promise<string[]> {
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - ACTIVE_AGENT_PRESENCE_WINDOW_MS).toISOString();
  const delivery = room_agent_delivery_sessions;
  const sessions = await db.select({ agent_key: room_agent_sessions.agent_key })
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.room_id, roomId),
      eq(room_agent_sessions.session_kind, "worker"),
      // Routing reaches only sessions that were not ended, so an ended one
      // cannot take a job even while its connection lingers.
      isNull(room_agent_sessions.ended_at),
      sql`EXISTS (
        SELECT 1 FROM ${delivery}
         WHERE ${delivery.room_id} = ${room_agent_sessions.room_id}
           AND ${delivery.delivery_key} = 'agent_session:' || ${room_agent_sessions.session_id}
           AND ((${delivery.active_connection_count} > 0 AND ${delivery.updated_at} >= ${cutoff}::timestamptz)
             OR ${delivery.reconnect_grace_expires_at} >= ${now}::timestamptz)
      )`,
    ))
    .orderBy(asc(room_agent_sessions.created_at), asc(room_agent_sessions.session_id))
    .limit(MAX_ONLINE_LOOKUP_SESSIONS);
  return [...new Set(sessions.map((session) => session.agent_key))];
}

/** The agent this person last talked with in the room (the same rule a large room's unaddressed message uses). */
export async function recentAgentPartnerKey(roomId: string, accountId: string, now: string): Promise<string | null> {
  const recipient = await getRecentHumanConversationRecipient(db, roomId, {
    number: AFTER_EVERY_MESSAGE,
    timestamp: now,
    publisher_account_id: accountId,
  });
  return recipient?.agentKey ?? null;
}
