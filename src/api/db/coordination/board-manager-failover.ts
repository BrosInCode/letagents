import { and, eq, sql } from "drizzle-orm";

import type { RoomAgentSessionKind } from "../../../shared/agent-presence.js";
import { db } from "../client.js";
import { toBoardManagerAssignment } from "../mappers.js";
import { board_manager_assignments, room_agent_sessions } from "../schema.js";
import { coordinationId } from "../utils.js";
import type {
  BoardManagerAssignment,
  BoardManagerAssignmentRow,
  RoomAgentSessionRow,
} from "../types.js";
import { inferBoardManagerRuntimeSource } from "./board-intents.js";

/** db or the message-create transaction — failover must commit atomically with its announcement. */
export type BoardManagerFailoverExecutor = Pick<typeof db, "select" | "update" | "insert">;

export interface ActiveBoardManagerAssignmentCandidate {
  assignment: BoardManagerAssignment;
  /** Set when the manager's worker session was ended deliberately. */
  agent_session_ended_at: string | null;
}

/** Every room's active Board Manager assignment, joined with session liveness. */
export async function listActiveBoardManagerAssignments(): Promise<
  ActiveBoardManagerAssignmentCandidate[]
> {
  const rows = await db
    .select({
      assignment: board_manager_assignments,
      agent_session_ended_at: room_agent_sessions.ended_at,
    })
    .from(board_manager_assignments)
    .leftJoin(
      room_agent_sessions,
      and(
        eq(room_agent_sessions.room_id, board_manager_assignments.room_id),
        eq(room_agent_sessions.session_id, board_manager_assignments.agent_session_id)
      )
    )
    .where(eq(board_manager_assignments.status, "active"));

  return rows.map((row) => ({
    assignment: toBoardManagerAssignment(row.assignment as BoardManagerAssignmentRow),
    agent_session_ended_at: row.agent_session_ended_at ?? null,
  }));
}

/**
 * Fenced release of one specific assignment: succeeds at most once, so
 * concurrent sweepers (or a racing human reassignment) cannot double-run a
 * failover. Returns null when the fence loses.
 */
export async function releaseBoardManagerAssignmentTx(
  executor: BoardManagerFailoverExecutor,
  input: {
    assignment_id: string;
    released_by: string;
    reason: string;
  }
): Promise<BoardManagerAssignment | null> {
  const now = new Date().toISOString();
  const [row] = (await executor
    .update(board_manager_assignments)
    .set({
      status: "released",
      released_by: input.released_by,
      release_reason: input.reason,
      released_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(board_manager_assignments.id, input.assignment_id),
        eq(board_manager_assignments.status, "active")
      )
    )
    .returning()) as BoardManagerAssignmentRow[];

  return row ? toBoardManagerAssignment(row) : null;
}

/**
 * Promote a live worker session to Board Manager. Validates the session
 * inside the same executor so a successor that ended between selection and
 * commit aborts the transaction instead of installing a dead manager.
 */
export async function promoteBoardManagerTx(
  executor: BoardManagerFailoverExecutor,
  input: {
    room_id: string;
    agent_session_id: string;
    assigned_by: string;
  }
): Promise<BoardManagerAssignment | null> {
  const [session] = (await executor
    .select()
    .from(room_agent_sessions)
    .where(
      and(
        eq(room_agent_sessions.room_id, input.room_id),
        eq(room_agent_sessions.session_id, input.agent_session_id),
        eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
        sql`${room_agent_sessions.ended_at} IS NULL`
      )
    )
    .limit(1)) as RoomAgentSessionRow[];
  if (!session) return null;

  const now = new Date().toISOString();
  const [row] = (await executor
    .insert(board_manager_assignments)
    .values({
      id: coordinationId("bm"),
      room_id: input.room_id,
      agent_session_id: session.session_id,
      agent_key: session.agent_key,
      actor_label: session.actor_label,
      runtime_source: inferBoardManagerRuntimeSource(session),
      assigned_by: input.assigned_by,
      status: "active",
      last_heartbeat_at: session.last_seen_at,
      released_by: null,
      release_reason: null,
      released_at: null,
      created_at: now,
      updated_at: now,
    })
    .returning()) as BoardManagerAssignmentRow[];

  return row ? toBoardManagerAssignment(row) : null;
}
