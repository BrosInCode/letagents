import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { RoomAgentSessionKind } from "../../../shared/agent-presence.js";
import { normalizeBoardManagerFailoverMode } from "../../../shared/board-manager-failover.js";
import { db } from "../client.js";
import { toBoardManagerAssignment, toRoomAgentDeliverySession } from "../mappers.js";
import {
  board_manager_assignments,
  room_agent_delivery_sessions,
  room_agent_sessions,
  room_board_settings,
} from "../schema.js";
import { coordinationId } from "../utils.js";
import type {
  BoardManagerAssignment,
  BoardManagerAssignmentRow,
  RoomAgentDeliverySessionRow,
  RoomAgentSessionRow,
} from "../types.js";
import type { LivenessAnnouncementCandidate } from "../presence/offline-announcements.js";
import { lockRoomAgentDeliveryKeysTx } from "../presence/delivery.js";
import { inferBoardManagerRuntimeSource } from "./board-intents.js";

/** db or the message-create transaction — failover must commit atomically with its announcement. */
export type BoardManagerFailoverExecutor = Pick<typeof db, "select" | "update" | "insert" | "execute">;

/** Serialize a failover with every delivery mutation for both actors. */
export async function lockBoardManagerFailoverDeliveryKeysTx(
  executor: BoardManagerFailoverExecutor,
  input: { room_id: string; dead_agent_session_id: string; successor_agent_session_id: string },
): Promise<void> {
  const sessionIds = [input.dead_agent_session_id, input.successor_agent_session_id];
  // Auth retirement owns session -> delivery in this order. Share-lock both
  // session rows first so an in-flight end must settle before failover reads
  // ended_at, and so failover never inverts that production lock order.
  await executor.select({ session_id: room_agent_sessions.session_id })
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.room_id, input.room_id),
      inArray(room_agent_sessions.session_id, sessionIds),
    ))
    .orderBy(asc(room_agent_sessions.session_id))
    .for("share");
  await lockRoomAgentDeliveryKeysTx(executor, [
    { room_id: input.room_id, delivery_key: `agent_session:${input.dead_agent_session_id}` },
    { room_id: input.room_id, delivery_key: `agent_session:${input.successor_agent_session_id}` },
  ]);
}

export interface ActiveBoardManagerAssignmentCandidate {
  assignment: BoardManagerAssignment;
  /** Set when the manager's worker session was ended deliberately. */
  agent_session_ended_at: string | null;
  claimed_check_at?: string | null;
  /** Batched with the due claim so the sweeper does not re-read per room. */
  manager_failover?: ReturnType<typeof normalizeBoardManagerFailoverMode>;
  /** Undefined is reserved for injected/legacy deps; null is authoritative no-row. */
  delivery_candidate?: LivenessAnnouncementCandidate | null;
  /** Ranked once for the whole claimed page; avoids per-room/session N+1s. */
  successor_candidates?: Array<{
    candidate: import("../types.js").BoardManagerCandidate;
    connection_state: "live" | "grace" | "none";
  }>;
}

/** Every room's active Board Manager assignment, joined with session liveness. */
export async function listActiveBoardManagerAssignments(options?: { now?: number; limit?: number }): Promise<
  ActiveBoardManagerAssignmentCandidate[]
> {
  const now = new Date(options?.now ?? Date.now()).toISOString();
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
  const retryAt = new Date(Date.parse(now) + 60_000).toISOString();
  const claimed = await db.execute<{ id: string; claimed_check_at: string }>(sql`
    WITH due AS (
      SELECT ${board_manager_assignments.id}
        FROM ${board_manager_assignments}
       WHERE ${board_manager_assignments.status} = 'active'
         AND ${board_manager_assignments.stall_check_at} <= ${now}::timestamptz
       ORDER BY ${board_manager_assignments.stall_check_at}, ${board_manager_assignments.id}
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE ${board_manager_assignments} AS assignment
       SET stall_check_at = ${retryAt}::timestamptz
      FROM due
     WHERE assignment.id = due.id
    RETURNING assignment.id, assignment.stall_check_at AS claimed_check_at
  `);
  if (claimed.rows.length === 0) return [];
  const rows = await db
    .select({
      assignment: board_manager_assignments,
      agent_session_ended_at: room_agent_sessions.ended_at,
      supervisor_managed: sql<boolean>`EXISTS (
        SELECT 1 FROM supervisor_host_grants AS supervisor
         WHERE supervisor.grant_id = ${room_agent_sessions.supervisor_grant_id}
           AND supervisor.revoked_at IS NULL
           AND supervisor.expires_at > ${now}::timestamptz
      )`,
      manager_failover: room_board_settings.manager_failover,
      delivery: room_agent_delivery_sessions,
      runtime_last_active_at: sql<string | null>`(
        SELECT max(GREATEST(observation.last_observed_at,
          COALESCE(observation.last_tool_call_at, observation.last_observed_at)))
          FROM room_agent_liveness_observations AS observation
         WHERE observation.room_id = ${board_manager_assignments.room_id}
           AND observation.agent_session_id = ${board_manager_assignments.agent_session_id}
           AND observation.source = 'native_harness'
      )`,
    })
    .from(board_manager_assignments)
    .leftJoin(
      room_agent_sessions,
      and(
        eq(room_agent_sessions.room_id, board_manager_assignments.room_id),
        eq(room_agent_sessions.session_id, board_manager_assignments.agent_session_id)
      )
    )
    .leftJoin(
      room_board_settings,
      eq(room_board_settings.room_id, board_manager_assignments.room_id),
    )
    .leftJoin(
      room_agent_delivery_sessions,
      and(
        eq(room_agent_delivery_sessions.room_id, board_manager_assignments.room_id),
        sql`${room_agent_delivery_sessions.delivery_key} = 'agent_session:' || ${board_manager_assignments.agent_session_id}`,
      ),
    )
    .where(and(
      eq(board_manager_assignments.status, "active"),
      sql`${board_manager_assignments.id} IN (
        SELECT jsonb_array_elements_text(${JSON.stringify(claimed.rows.map((row) => row.id))}::jsonb)
      )`,
    ));

  const claimById = new Map(claimed.rows.map((row) => [row.id, row.claimed_check_at]));
  const candidateRows = await db.execute<{
    room_id: string;
    agent_session_id: string;
    agent_key: string;
    actor_label: string;
    display_name: string;
    runtime: string;
    ide_label: string | null;
    liveness_capability: string | null;
    tool_bridge_id: string | null;
    last_seen_at: string;
    connection_state: "live" | "grace" | "none";
  }>(sql`
    WITH selected_room AS (
      SELECT value->>0 AS room_id, value->>1 AS active_session_id
        FROM jsonb_array_elements(${JSON.stringify(rows.map((row) => [
          row.assignment.room_id,
          row.assignment.agent_session_id,
        ]))}::jsonb)
    ), candidate AS (
      SELECT session.room_id, session.session_id AS agent_session_id,
             session.agent_key, session.actor_label, session.display_name,
             session.runtime, session.ide_label, session.liveness_capability,
             session.tool_bridge_id, session.last_seen_at,
             selected_room.active_session_id,
             CASE
               WHEN delivery.active_connection_count > 0
                AND delivery.updated_at >= ${now}::timestamptz - interval '90 seconds' THEN 'live'
               WHEN delivery.reconnect_grace_expires_at >= ${now}::timestamptz THEN 'grace'
               ELSE 'none'
             END AS connection_state
        FROM room_agent_sessions AS session
        JOIN selected_room ON selected_room.room_id = session.room_id
        LEFT JOIN room_agent_delivery_sessions AS delivery
          ON delivery.room_id = session.room_id
         AND delivery.delivery_key = 'agent_session:' || session.session_id
       WHERE session.session_kind = 'worker' AND session.ended_at IS NULL
    ), ranked AS (
      SELECT candidate.*,
             row_number() OVER (
               PARTITION BY room_id
               ORDER BY CASE connection_state WHEN 'live' THEN 0 WHEN 'grace' THEN 1 ELSE 2 END,
                        last_seen_at DESC, agent_session_id
             ) AS rank
        FROM candidate
    )
    SELECT room_id, agent_session_id, agent_key, actor_label, display_name,
           runtime, ide_label, liveness_capability, tool_bridge_id,
           last_seen_at, connection_state
      FROM ranked
     WHERE rank <= 20
     ORDER BY room_id, rank
  `);
  const candidatesByRoom = new Map<string, ActiveBoardManagerAssignmentCandidate["successor_candidates"]>();
  const candidateStateBySession = new Map(candidateRows.rows.map((row) => [
    `${row.room_id}\u001f${row.agent_session_id}`,
    row.connection_state,
  ]));
  const activeSessionByRoom = new Map(rows.map((row) => [
    row.assignment.room_id,
    row.assignment.agent_session_id,
  ]));
  for (const row of candidateRows.rows) {
    const entries = candidatesByRoom.get(row.room_id) ?? [];
    entries.push({
      candidate: {
        agent_session_id: row.agent_session_id,
        agent_key: row.agent_key,
        actor_label: row.actor_label,
        display_name: row.display_name,
        runtime: row.runtime,
        runtime_source: inferBoardManagerRuntimeSource(row),
        last_seen_at: row.last_seen_at,
        is_active_manager: row.agent_session_id === activeSessionByRoom.get(row.room_id),
      },
      connection_state: row.connection_state,
    });
    candidatesByRoom.set(row.room_id, entries);
  }
  return rows.map((row) => {
    const delivery = row.delivery
      ? toRoomAgentDeliverySession(row.delivery as RoomAgentDeliverySessionRow)
      : null;
    const state = candidateStateBySession.get(
      `${row.assignment.room_id}\u001f${row.assignment.agent_session_id}`,
    );
    const effectiveDelivery = delivery && state === "none"
      ? { ...delivery, active_connection_count: 0, reconnect_grace_expires_at: null }
      : delivery;
    return {
      assignment: toBoardManagerAssignment(row.assignment as BoardManagerAssignmentRow),
      agent_session_ended_at: row.agent_session_ended_at ?? null,
      claimed_check_at: claimById.get(row.assignment.id) ?? null,
      manager_failover: normalizeBoardManagerFailoverMode(row.manager_failover),
      delivery_candidate: effectiveDelivery ? {
        session: effectiveDelivery,
        agent_session_ended_at: row.agent_session_ended_at ?? null,
        supervisor_managed: Boolean(row.supervisor_managed),
        runtime_last_active_at: row.runtime_last_active_at ?? null,
        native_last_active_at: row.runtime_last_active_at ?? null,
      } : null,
      successor_candidates: candidatesByRoom.get(row.assignment.room_id) ?? [],
    };
  });
}

export async function rescheduleActiveBoardManagerAssignment(input: {
  assignment_id: string;
  claimed_check_at: string;
  next_check_at: string | null;
}): Promise<void> {
  await db.update(board_manager_assignments)
    .set({ stall_check_at: input.next_check_at })
    .where(and(
      eq(board_manager_assignments.id, input.assignment_id),
      eq(board_manager_assignments.status, "active"),
      eq(board_manager_assignments.stall_check_at, input.claimed_check_at),
    ));
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
    /** Automatic failover must still own the exact due claim it evaluated. */
    claimed_check_at?: string | null;
    /** Recheck the dead manager's delivery inside the release transaction. */
    require_unreachable_delivery?: boolean;
  }
): Promise<BoardManagerAssignment | null> {
  if (input.require_unreachable_delivery && !input.claimed_check_at) return null;
  if (input.require_unreachable_delivery) {
    const [assignment] = await executor.select({
      room_id: board_manager_assignments.room_id,
      agent_session_id: board_manager_assignments.agent_session_id,
    }).from(board_manager_assignments).where(and(
      eq(board_manager_assignments.id, input.assignment_id),
      eq(board_manager_assignments.status, "active"),
      eq(board_manager_assignments.stall_check_at, input.claimed_check_at!),
    )).limit(1);
    if (!assignment) return null;
    await executor.select({ session_id: room_agent_sessions.session_id })
      .from(room_agent_sessions)
      .where(and(
        eq(room_agent_sessions.room_id, assignment.room_id),
        eq(room_agent_sessions.session_id, assignment.agent_session_id),
      ))
      .for("share")
      .limit(1);
    await lockRoomAgentDeliveryKeysTx(executor, [{
      room_id: assignment.room_id,
      delivery_key: `agent_session:${assignment.agent_session_id}`,
    }]);
  }
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
        eq(board_manager_assignments.status, "active"),
        input.claimed_check_at
          ? eq(board_manager_assignments.stall_check_at, input.claimed_check_at)
          : undefined,
        input.require_unreachable_delivery
          ? sql`(
              EXISTS (
                SELECT 1
                  FROM ${room_agent_sessions} AS manager_session
                 WHERE manager_session.room_id = ${board_manager_assignments.room_id}
                   AND manager_session.session_id = ${board_manager_assignments.agent_session_id}
                   AND manager_session.ended_at IS NOT NULL
              )
              OR EXISTS (
                SELECT 1
                  FROM ${room_agent_delivery_sessions} AS manager_delivery
                 WHERE manager_delivery.room_id = ${board_manager_assignments.room_id}
                   AND manager_delivery.agent_session_id = ${board_manager_assignments.agent_session_id}
                   AND manager_delivery.session_kind = 'worker'
                   AND EXISTS (
                     SELECT 1 FROM ${room_agent_sessions} AS manager_session
                      WHERE manager_session.session_id = manager_delivery.agent_session_id
                        AND NOT EXISTS (
                          SELECT 1 FROM supervisor_host_grants AS supervisor
                           WHERE supervisor.grant_id = manager_session.supervisor_grant_id
                             AND supervisor.revoked_at IS NULL
                             AND supervisor.expires_at > ${now}::timestamptz
                        )
                   )
                   AND NOT (
                     (manager_delivery.active_connection_count > 0
                       AND manager_delivery.updated_at >= ${now}::timestamptz - interval '90 seconds')
                     OR manager_delivery.reconnect_grace_expires_at >= ${now}::timestamptz
                   )
              )
            )`
          : undefined,
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
    /** Automatic failover may promote only a still-reachable successor. */
    require_reachable_delivery?: boolean;
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
        sql`${room_agent_sessions.ended_at} IS NULL`,
      )
    )
    .for("share")
    .limit(1)) as RoomAgentSessionRow[];
  if (!session) return null;
  if (input.require_reachable_delivery) {
    await lockRoomAgentDeliveryKeysTx(executor, [{
      room_id: input.room_id,
      delivery_key: `agent_session:${input.agent_session_id}`,
    }]);
  }
  if (input.require_reachable_delivery) {
    const [reachable] = await executor.select({ session_id: room_agent_delivery_sessions.agent_session_id })
      .from(room_agent_delivery_sessions)
      .where(and(
        eq(room_agent_delivery_sessions.room_id, input.room_id),
        eq(room_agent_delivery_sessions.agent_session_id, input.agent_session_id),
        eq(room_agent_delivery_sessions.session_kind, "worker"),
        sql`(
          (${room_agent_delivery_sessions.active_connection_count} > 0
            AND ${room_agent_delivery_sessions.updated_at} >= now() - interval '90 seconds')
          OR ${room_agent_delivery_sessions.reconnect_grace_expires_at} >= now()
        )`,
      ))
      .limit(1);
    if (!reachable) return null;
  }

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
