import { and, eq, sql } from "drizzle-orm";

import { db } from "../client.js";
import { toRoomAgentDeliverySession } from "../mappers.js";
import { room_agent_delivery_sessions, room_agent_sessions } from "../schema.js";
import type { RoomAgentDeliverySession, RoomAgentDeliverySessionRow } from "../types.js";

export interface LivenessAnnouncementCandidate {
  session: RoomAgentDeliverySession;
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

/** Fresh single-row read of a worker's delivery state and runtime evidence. */
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
