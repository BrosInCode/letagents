import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import { FINISHED_JOB_STATES, type JobState } from "../../../shared/api/jobs.mjs";
import { db } from "./client.js";
import { getSessionConnections } from "./messages/session-connections.js";
import { getRecentHumanConversationRecipient } from "./messages/account-agent-routing.js";
import { api_jobs, room_agent_sessions, type ApiJobRow } from "./schema.js";
import type { MessageCreateTransaction } from "./messages/create/types.js";

export type { ApiJobRow };

// The same bound message routing uses for one room's worker sessions.
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
 * a worker session whose delivery connection is reachable inside the 90 s
 * presence window (or its reconnect grace), the same test message routing
 * uses for a mention. An open session alone is not enough: sessions that
 * were never ended stay open long after their agent left.
 */
export async function listOnlineRoomAgentKeys(roomId: string, nowMs = Date.now()): Promise<string[]> {
  const sessions = await db.select({ session_id: room_agent_sessions.session_id, agent_key: room_agent_sessions.agent_key })
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.room_id, roomId),
      eq(room_agent_sessions.session_kind, "worker"),
      // Routing reaches only sessions that were not ended, so an ended one
      // cannot take a job even while its connection lingers.
      isNull(room_agent_sessions.ended_at),
    ))
    .orderBy(asc(room_agent_sessions.created_at), asc(room_agent_sessions.session_id))
    .limit(MAX_ONLINE_LOOKUP_SESSIONS);
  const { reachable } = await getSessionConnections(db, roomId, sessions.map((session) => session.session_id), nowMs);
  const keys: string[] = [];
  for (const session of sessions) {
    if (reachable.has(session.session_id) && !keys.includes(session.agent_key)) keys.push(session.agent_key);
  }
  return keys;
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
