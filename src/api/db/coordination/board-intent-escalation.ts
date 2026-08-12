import { and, asc, count, eq, sql } from "drizzle-orm";

import { db } from "../client.js";
import { board_intents, board_manager_assignments, room_agent_delivery_sessions, room_agent_sessions, room_board_settings } from "../schema.js";
import { toBoardIntent } from "../mappers.js";
import { isAgentDeliverySessionReachable, type RoomAgentSessionKind } from "../../../shared/agent-presence.js";
import type {
  BoardIntent,
  BoardIntentRow,
  BoardManagerAssignmentRow,
  BoardManagerMode,
  RoomBoardSettingsRow,
} from "../types.js";
import { normalizeBoardManagerMode } from "./board-intent-manager.js";

export interface EscalationCandidateBoardIntent {
  intent: BoardIntent;
  manager_mode: BoardManagerMode;
  claimed_check_at?: string | null;
}

/**
 * Pending intents older than the threshold that have not been escalated yet,
 * across all rooms, joined with the room's manager mode. Expiry runs first so
 * intents past their pending TTL never escalate.
 */
export async function listEscalationCandidateBoardIntents(input: {
  now?: number;
  limit?: number;
}): Promise<EscalationCandidateBoardIntent[]> {
  const now = input.now ?? Date.now();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  await db.execute(sql`
    WITH due_expiry AS (
      SELECT ${board_intents.id}
        FROM ${board_intents}
       WHERE ${board_intents.status} IN ('pending', 'approved')
         AND ${board_intents.expires_at} IS NOT NULL
         AND ${board_intents.expires_at} <= ${new Date(now).toISOString()}::timestamptz
       ORDER BY ${board_intents.expires_at}, ${board_intents.id}
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE ${board_intents} AS intent
       SET status = 'expired', updated_at = ${new Date(now).toISOString()}::timestamptz
      FROM due_expiry
     WHERE intent.id = due_expiry.id
  `);
  const retryAt = new Date(now + 60_000).toISOString();
  const claimed = await db.execute<{ id: string; claimed_check_at: string }>(sql`
    WITH due AS (
      SELECT ${board_intents.id}
        FROM ${board_intents}
       WHERE ${board_intents.status} = 'pending'
         AND ${board_intents.escalated_at} IS NULL
         AND (${board_intents.expires_at} IS NULL
           OR ${board_intents.expires_at} > ${new Date(now).toISOString()}::timestamptz)
         AND ${board_intents.escalation_check_at} <= ${new Date(now).toISOString()}::timestamptz
       ORDER BY ${board_intents.escalation_check_at}, ${board_intents.id}
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE ${board_intents} AS intent
       SET escalation_check_at = ${retryAt}::timestamptz
      FROM due
     WHERE intent.id = due.id
    RETURNING intent.id, intent.escalation_check_at AS claimed_check_at
  `);
  if (claimed.rows.length === 0) return [];
  const rows = await db
    .select({ intent: board_intents, manager_mode: room_board_settings.manager_mode })
    .from(board_intents)
    .leftJoin(room_board_settings, eq(room_board_settings.room_id, board_intents.room_id))
    .where(
      and(
        eq(board_intents.status, "pending"),
        sql`${board_intents.id} IN (
          SELECT jsonb_array_elements_text(${JSON.stringify(claimed.rows.map((row) => row.id))}::jsonb)
        )`
      )
    )
    .orderBy(asc(board_intents.created_at));

  const claimById = new Map(claimed.rows.map((row) => [row.id, row.claimed_check_at]));
  return rows.map((row) => ({
    intent: toBoardIntent(row.intent as BoardIntentRow),
    manager_mode: normalizeBoardManagerMode(row.manager_mode),
    claimed_check_at: claimById.get(row.intent.id) ?? null,
  }));
}

export async function rescheduleEscalationCandidateBoardIntent(input: {
  intent_id: string;
  claimed_check_at: string;
  next_check_at: string | null;
}): Promise<void> {
  await db.update(board_intents)
    .set({ escalation_check_at: input.next_check_at })
    .where(and(
      eq(board_intents.id, input.intent_id),
      eq(board_intents.status, "pending"),
      eq(board_intents.escalation_check_at, input.claimed_check_at),
    ));
}

/**
 * Fence the one escalation action an intent ever gets. Succeeds at most once
 * per intent (escalated_at IS NULL AND still pending), so concurrent sweepers
 * cannot double-escalate or double-approve.
 */
export async function claimBoardIntentEscalationTx(
  executor: Pick<typeof db, "update">,
  input: {
    room_id: string;
    intent_id: string;
    escalated_at?: string;
  }
): Promise<boolean> {
  const escalatedAt = input.escalated_at ?? new Date().toISOString();
  const rows = await executor
    .update(board_intents)
    .set({ escalated_at: escalatedAt, updated_at: escalatedAt })
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.id, input.intent_id),
        eq(board_intents.status, "pending"),
        sql`${board_intents.escalated_at} IS NULL`
      )
    )
    .returning({ id: board_intents.id });

  return rows.length > 0;
}

/**
 * Mark an escalated intent as approved by the sweep itself. Also stamps
 * decided_at when the caller has not (the rate-cap window counts on it), so
 * an auto-approved intent always lands inside the cap accounting.
 */
export async function markBoardIntentAutoApprovedTx(
  executor: Pick<typeof db, "update">,
  input: { room_id: string; intent_id: string }
): Promise<void> {
  await executor
    .update(board_intents)
    .set({ auto_approved: true, decided_at: sql`COALESCE(${board_intents.decided_at}, now())` })
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.id, input.intent_id)
      )
    );
}

/** Auto-approvals granted to one proposer in the trailing window (rate-cap input). */
export async function countRecentAutoApprovedIntents(input: {
  room_id: string;
  proposer_actor_key: string;
  windowMs: number;
  now?: number;
}): Promise<number> {
  const now = input.now ?? Date.now();
  const since = new Date(now - input.windowMs).toISOString();
  const [row] = await db
    .select({ value: count() })
    .from(board_intents)
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.proposer_actor_key, input.proposer_actor_key),
        eq(board_intents.auto_approved, true),
        sql`${board_intents.decided_at} IS NOT NULL`,
        sql`${board_intents.decided_at} > ${since}::timestamptz`
      )
    );
  return Number(row?.value ?? 0);
}

export type BoardIntentAutoApprovalIneligibleReason =
  | "manager_reachable"
  | "mode_changed"
  | "rate_capped";

export class BoardIntentAutoApprovalIneligibleError extends Error {
  readonly reason: BoardIntentAutoApprovalIneligibleReason;

  constructor(reason: BoardIntentAutoApprovalIneligibleReason) {
    super(`board intent auto-approval is not eligible: ${reason}`);
    this.name = "BoardIntentAutoApprovalIneligibleError";
    this.reason = reason;
  }
}

/**
 * Time-of-use revalidation for an auto-approval, run INSIDE the escalation
 * transaction. The sweep's earlier checks are only a cheap pre-filter — a
 * manager can reconnect or be assigned, the room can flip to
 * intent_required, or a concurrent sweeper can spend the proposer's rate
 * budget between selection and commit. A per-(room, proposer) advisory
 * transaction lock serializes the cap check across sweepers and replicas.
 * Throws BoardIntentAutoApprovalIneligibleError, rolling the caller's
 * transaction (and its announcement) back.
 */
export async function assertBoardIntentAutoApprovalEligibilityTx(
  executor: Pick<typeof db, "select" | "execute">,
  input: {
    room_id: string;
    proposer_actor_key: string;
    cap_window_ms: number;
    cap_max: number;
    now?: number;
  }
): Promise<void> {
  const now = input.now ?? Date.now();
  const lockKey = `board_intent_auto_approve:${input.room_id}:${input.proposer_actor_key}`;
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

  const [settingsRow] = (await executor
    .select()
    .from(room_board_settings)
    .where(eq(room_board_settings.room_id, input.room_id))
    .limit(1)) as RoomBoardSettingsRow[];
  if (normalizeBoardManagerMode(settingsRow?.manager_mode ?? null) !== "manager_optional") {
    throw new BoardIntentAutoApprovalIneligibleError("mode_changed");
  }

  const [managerRow] = await executor
    .select({ assignment: board_manager_assignments })
    .from(board_manager_assignments)
    .innerJoin(
      room_agent_sessions,
      and(
        eq(room_agent_sessions.room_id, board_manager_assignments.room_id),
        eq(room_agent_sessions.session_id, board_manager_assignments.agent_session_id),
        eq(room_agent_sessions.session_kind, "worker" as RoomAgentSessionKind),
        sql`${room_agent_sessions.ended_at} IS NULL`
      )
    )
    .where(
      and(
        eq(board_manager_assignments.room_id, input.room_id),
        eq(board_manager_assignments.status, "active")
      )
    )
    .limit(1);
  if (managerRow?.assignment) {
    const assignment = managerRow.assignment as BoardManagerAssignmentRow;
    const [deliveryRow] = await executor
      .select()
      .from(room_agent_delivery_sessions)
      .where(
        and(
          eq(room_agent_delivery_sessions.room_id, input.room_id),
          eq(
            room_agent_delivery_sessions.delivery_key,
            `agent_session:${assignment.agent_session_id}`
          )
        )
      )
      .limit(1);
    if (
      deliveryRow
      && isAgentDeliverySessionReachable(
        {
          activeConnectionCount: deliveryRow.active_connection_count,
          updatedAt: deliveryRow.updated_at,
          reconnectGraceExpiresAt: deliveryRow.reconnect_grace_expires_at,
        },
        now
      )
    ) {
      throw new BoardIntentAutoApprovalIneligibleError("manager_reachable");
    }
  }

  const since = new Date(now - input.cap_window_ms).toISOString();
  const [capRow] = await executor
    .select({ value: count() })
    .from(board_intents)
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.proposer_actor_key, input.proposer_actor_key),
        eq(board_intents.auto_approved, true),
        sql`${board_intents.decided_at} IS NOT NULL`,
        sql`${board_intents.decided_at} > ${since}::timestamptz`
      )
    );
  if (Number(capRow?.value ?? 0) >= input.cap_max) {
    throw new BoardIntentAutoApprovalIneligibleError("rate_capped");
  }
}
