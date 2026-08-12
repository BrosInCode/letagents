import crypto from "crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";

import { db } from "../client.js";
import { board_intents, board_manager_assignments, room_agent_delivery_sessions, room_agent_sessions, room_board_settings } from "../schema.js";
import { toBoardIntent, toBoardManagerAssignment, toRoomBoardSettings } from "../mappers.js";
import { coordinationId, hashToken } from "../utils.js";
import {
  boardIntentPayloadForLeaseAction,
  boardIntentPayloadForTaskCreate,
  boardIntentPayloadForTaskMutation,
  type BoardIntentPayload,
} from "../../board-intent-payloads.js";
import { isAgentDeliverySessionReachable, type RoomAgentSessionKind } from "../../../shared/agent-presence.js";
import { DEFAULT_BOARD_MANAGER_FAILOVER } from "../../../shared/board-manager-failover.js";
import type {
  BoardIntent,
  BoardIntentActionType,
  BoardIntentRow,
  BoardManagerAssignment,
  BoardManagerFailoverMode,
  BoardManagerRuntimeSource,
  BoardManagerAssignmentRow,
  BoardManagerMode,
  RoomAgentSessionRow,
  RoomBoardSettings,
  RoomBoardSettingsRow,
} from "../types.js";

export const DEFAULT_BOARD_MANAGER_MODE: BoardManagerMode = "manager_optional";
export const BOARD_INTENT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const BOARD_INTENT_APPROVAL_TTL_MS = 30 * 60 * 1000;

export interface BoardIntentApprovalCheck {
  kind: "allow";
  intent?: BoardIntent;
}

export interface BoardIntentApprovalDenial {
  kind: "deny";
  code: string;
  error: string;
}

export type BoardIntentApprovalDecision =
  | BoardIntentApprovalCheck
  | BoardIntentApprovalDenial;

export interface BoardIntentConsumptionInput {
  room_id: string;
  action_type: BoardIntentActionType;
  payload: BoardIntentPayload;
  intent_id?: string | null;
  approval_token?: string | null;
  now?: Date;
}

type BoardIntentExecutor = Pick<typeof db, "select" | "update">;

export class BoardIntentApprovalConsumptionError extends Error {
  readonly code: string;
  readonly decision: BoardIntentApprovalDenial;

  constructor(decision: BoardIntentApprovalDenial) {
    super(decision.error);
    this.name = "BoardIntentApprovalConsumptionError";
    this.code = decision.code;
    this.decision = decision;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashBoardIntentPayload(payload: BoardIntentPayload): string {
  return crypto.createHash("sha256").update(stableJson(payload)).digest("hex");
}

function approvalToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function defaultPendingIntentExpiresAt(now: Date): string {
  return new Date(now.getTime() + BOARD_INTENT_PENDING_TTL_MS).toISOString();
}

function isValidBoardManagerMode(value: string): value is BoardManagerMode {
  return value === "off" || value === "manager_optional" || value === "intent_required";
}

function isValidRuntimeSource(value: string): value is BoardManagerRuntimeSource {
  return value === "desktop_managed" || value === "open_model" || value === "external" || value === "unknown";
}

export function normalizeBoardManagerMode(value: string | null | undefined): BoardManagerMode {
  const normalized = value?.trim();
  return normalized && isValidBoardManagerMode(normalized)
    ? normalized
    : DEFAULT_BOARD_MANAGER_MODE;
}

export function normalizeBoardManagerRuntimeSource(
  value: string | null | undefined
): BoardManagerRuntimeSource {
  const normalized = value?.trim();
  return normalized && isValidRuntimeSource(normalized) ? normalized : "unknown";
}

export {
  boardIntentPayloadForLeaseAction,
  boardIntentPayloadForTaskCreate,
  boardIntentPayloadForTaskMutation,
};

export async function getRoomBoardSettings(roomId: string): Promise<RoomBoardSettings> {
  const [row] = (await db
    .select()
    .from(room_board_settings)
    .where(eq(room_board_settings.room_id, roomId))
    .limit(1)) as RoomBoardSettingsRow[];

  if (row) return toRoomBoardSettings(row);
  const now = new Date().toISOString();
  return {
    room_id: roomId,
    manager_mode: DEFAULT_BOARD_MANAGER_MODE,
    manager_failover: DEFAULT_BOARD_MANAGER_FAILOVER,
    stall_nudged_at: null,
    updated_by: null,
    created_at: now,
    updated_at: now,
  };
}

export async function setRoomBoardManagerMode(input: {
  room_id: string;
  manager_mode: BoardManagerMode;
  manager_failover?: BoardManagerFailoverMode | null;
  updated_by: string;
}): Promise<RoomBoardSettings> {
  const now = new Date().toISOString();
  const failoverUpdate = input.manager_failover ? { manager_failover: input.manager_failover } : {};
  const [row] = (await db
    .insert(room_board_settings)
    .values({
      room_id: input.room_id,
      manager_mode: input.manager_mode,
      manager_failover: input.manager_failover ?? DEFAULT_BOARD_MANAGER_FAILOVER,
      updated_by: input.updated_by,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: room_board_settings.room_id,
      set: {
        manager_mode: input.manager_mode,
        ...failoverUpdate,
        updated_by: input.updated_by,
        updated_at: now,
      },
    })
    .returning()) as RoomBoardSettingsRow[];

  const settings = toRoomBoardSettings(row);
  const { recordBoardManagerModeChangedEvent } = await import("./board-governance.js");
  await recordBoardManagerModeChangedEvent({
    room_id: input.room_id,
    updated_by: input.updated_by,
    manager_mode: input.manager_mode,
  });
  return settings;
}

export async function getActiveBoardManager(
  roomId: string
): Promise<BoardManagerAssignment | null> {
  const [row] = await db
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
        eq(board_manager_assignments.room_id, roomId),
        eq(board_manager_assignments.status, "active")
      )
    )
    .orderBy(asc(board_manager_assignments.created_at))
    .limit(1);

  return row?.assignment
    ? toBoardManagerAssignment(row.assignment as BoardManagerAssignmentRow)
    : null;
}

export function inferBoardManagerRuntimeSource(
  session: {
    runtime: string;
    ide_label: string | null;
    liveness_capability: string | null;
    tool_bridge_id: string | null;
  }
): BoardManagerRuntimeSource {
  const signal = [
    session.runtime,
    session.ide_label,
    session.liveness_capability,
    session.tool_bridge_id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (
    signal.includes("open-model")
    || signal.includes("open_model")
    || signal.includes("open model")
    || signal.includes("letagents_open_model")
  ) {
    return "open_model";
  }
  return "desktop_managed";
}

export async function assignBoardManager(input: {
  room_id: string;
  agent_session_id: string;
  assigned_by: string;
  runtime_source?: BoardManagerRuntimeSource | null;
}): Promise<BoardManagerAssignment | null> {
  const [session] = (await db
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
  const replacedRows = (await db
    .update(board_manager_assignments)
    .set({
      status: "released",
      released_by: input.assigned_by,
      release_reason: "Replaced by a new Board Manager assignment.",
      released_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(board_manager_assignments.room_id, input.room_id),
        eq(board_manager_assignments.status, "active")
      )
    )
    .returning()) as BoardManagerAssignmentRow[];

  const runtimeSource = input.runtime_source ?? inferBoardManagerRuntimeSource(session);
  const [row] = (await db
    .insert(board_manager_assignments)
    .values({
      id: coordinationId("bm"),
      room_id: input.room_id,
      agent_session_id: session.session_id,
      agent_key: session.agent_key,
      actor_label: session.actor_label,
      runtime_source: runtimeSource,
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

  const assignment = toBoardManagerAssignment(row);
  const { recordBoardManagerAssignedEvent, recordBoardManagerReleasedEvent } = await import("./board-governance.js");
  for (const replacedRow of replacedRows) {
    await recordBoardManagerReleasedEvent({
      room_id: input.room_id,
      released_by: input.assigned_by,
      manager: toBoardManagerAssignment(replacedRow),
      reason: "Replaced by a new Board Manager assignment.",
    });
  }
  await recordBoardManagerAssignedEvent({
    room_id: input.room_id,
    assigned_by: input.assigned_by,
    manager: assignment,
  });
  return assignment;
}

export async function releaseBoardManager(input: {
  room_id: string;
  released_by: string;
  reason?: string | null;
}): Promise<BoardManagerAssignment | null> {
  const now = new Date().toISOString();
  const [row] = (await db
    .update(board_manager_assignments)
    .set({
      status: "released",
      released_by: input.released_by,
      release_reason: input.reason ?? "Board Manager released.",
      released_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(board_manager_assignments.room_id, input.room_id),
        eq(board_manager_assignments.status, "active")
      )
    )
    .returning()) as BoardManagerAssignmentRow[];

  if (!row) return null;
  const assignment = toBoardManagerAssignment(row);
  const { recordBoardManagerReleasedEvent } = await import("./board-governance.js");
  await recordBoardManagerReleasedEvent({
    room_id: input.room_id,
    released_by: input.released_by,
    manager: assignment,
    reason: input.reason,
  });
  return assignment;
}

export async function createBoardIntent(input: {
  room_id: string;
  action_type: BoardIntentActionType;
  payload: BoardIntentPayload;
  task_id?: string | null;
  proposer_actor_label?: string | null;
  proposer_actor_key?: string | null;
  proposer_actor_instance_id?: string | null;
  proposer_agent_session_id?: string | null;
  expires_at?: string | null;
  now?: Date;
}): Promise<BoardIntent> {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  await expireBoardIntents({ room_id: input.room_id, now: nowDate });

  const row: BoardIntentRow = {
    id: coordinationId("bi"),
    room_id: input.room_id,
    task_id: input.task_id ?? null,
    action_type: input.action_type,
    payload: input.payload,
    payload_hash: hashBoardIntentPayload(input.payload),
    status: "pending",
    proposer_actor_label: input.proposer_actor_label ?? null,
    proposer_actor_key: input.proposer_actor_key ?? null,
    proposer_actor_instance_id: input.proposer_actor_instance_id ?? null,
    proposer_agent_session_id: input.proposer_agent_session_id ?? null,
    decision_by: null,
    decision_reason: null,
    approval_token_hash: null,
    decided_at: null,
    expires_at: input.expires_at ?? defaultPendingIntentExpiresAt(nowDate),
    escalated_at: null,
    escalation_check_at: new Date(nowDate.getTime() + 10 * 60_000).toISOString(),
    auto_approved: false,
    created_at: now,
    updated_at: now,
  };

  const [created] = (await db
    .insert(board_intents)
    .values(row)
    .onConflictDoNothing()
    .returning()) as BoardIntentRow[];

  if (created) return toBoardIntent(created);

  const [existing] = (await db
    .select()
    .from(board_intents)
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.action_type, input.action_type),
        eq(board_intents.payload_hash, row.payload_hash),
        eq(board_intents.status, "pending")
      )
    )
    .limit(1)) as BoardIntentRow[];
  if (!existing) {
    throw new Error("Board intent could not be created.");
  }
  return toBoardIntent(existing);
}

export async function listBoardIntents(input: {
  room_id: string;
  status?: string | null;
  limit?: number;
}): Promise<BoardIntent[]> {
  await expireBoardIntents({ room_id: input.room_id });

  const conditions = [eq(board_intents.room_id, input.room_id)];
  if (input.status) {
    conditions.push(eq(board_intents.status, input.status));
  }
  const rows = (await db
    .select()
    .from(board_intents)
    .where(and(...conditions))
    .orderBy(asc(board_intents.created_at))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500))) as BoardIntentRow[];

  return rows.map(toBoardIntent);
}

export async function getBoardIntent(input: {
  room_id: string;
  intent_id: string;
}, executor: BoardIntentExecutor = db): Promise<BoardIntent | null> {
  const [row] = (await executor
    .select()
    .from(board_intents)
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.id, input.intent_id)
      )
    )
    .limit(1)) as BoardIntentRow[];

  return row ? toBoardIntent(row) : null;
}

export async function countBoardIntents(input: {
  room_id: string;
  status?: string | null;
}): Promise<number> {
  await expireBoardIntents({ room_id: input.room_id });

  const conditions = [eq(board_intents.room_id, input.room_id)];
  if (input.status) {
    conditions.push(eq(board_intents.status, input.status));
  }
  const [row] = await db
    .select({ value: count() })
    .from(board_intents)
    .where(and(...conditions));
  return Number(row?.value ?? 0);
}

export async function approveBoardIntent(input: {
  room_id: string;
  intent_id: string;
  decision_by: string;
  reason?: string | null;
  now?: Date;
}, executor: BoardIntentExecutor = db): Promise<{ intent: BoardIntent; approval_token: string } | null> {
  const token = approvalToken();
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + BOARD_INTENT_APPROVAL_TTL_MS).toISOString();
  await expireBoardIntents({ room_id: input.room_id, now: nowDate }, executor);

  const [row] = (await executor
    .update(board_intents)
    .set({
      status: "approved",
      decision_by: input.decision_by,
      decision_reason: input.reason ?? null,
      approval_token_hash: hashToken(token),
      decided_at: now,
      expires_at: expiresAt,
      updated_at: now,
    })
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.id, input.intent_id),
        eq(board_intents.status, "pending"),
        sql`(${board_intents.expires_at} IS NULL OR ${board_intents.expires_at} > ${now}::timestamptz)`
      )
    )
    .returning()) as BoardIntentRow[];

  return row ? { intent: toBoardIntent(row), approval_token: token } : null;
}

export async function markBoardIntentTaskResult(input: {
  room_id: string;
  intent_id: string;
  task_id: string;
}, executor: BoardIntentExecutor = db): Promise<BoardIntent | null> {
  const now = new Date().toISOString();
  const [row] = (await executor
    .update(board_intents)
    .set({
      task_id: input.task_id,
      updated_at: now,
    })
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.id, input.intent_id)
      )
    )
    .returning()) as BoardIntentRow[];

  return row ? toBoardIntent(row) : null;
}

export async function denyBoardIntent(input: {
  room_id: string;
  intent_id: string;
  decision_by: string;
  reason?: string | null;
  now?: Date;
}): Promise<BoardIntent | null> {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  await expireBoardIntents({ room_id: input.room_id, now: nowDate });

  const [row] = (await db
    .update(board_intents)
    .set({
      status: "denied",
      decision_by: input.decision_by,
      decision_reason: input.reason ?? null,
      decided_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.id, input.intent_id),
        eq(board_intents.status, "pending"),
        sql`(${board_intents.expires_at} IS NULL OR ${board_intents.expires_at} > ${now}::timestamptz)`
      )
    )
    .returning()) as BoardIntentRow[];

  return row ? toBoardIntent(row) : null;
}

export async function expireBoardIntents(input: {
  room_id?: string | null;
  now?: Date;
} = {}, executor: Pick<typeof db, "update"> = db): Promise<number> {
  const now = (input.now ?? new Date()).toISOString();
  const conditions = [
    sql`${board_intents.status} IN ('pending', 'approved')`,
    sql`${board_intents.expires_at} IS NOT NULL`,
    sql`${board_intents.expires_at} <= ${now}::timestamptz`,
  ];
  if (input.room_id) {
    conditions.push(eq(board_intents.room_id, input.room_id));
  }

  const rows = await executor
    .update(board_intents)
    .set({
      status: "expired",
      updated_at: now,
    })
    .where(and(...conditions))
    .returning({ id: board_intents.id });

  return rows.length;
}

export async function verifyBoardIntentApproval(input: {
  room_id: string;
  action_type: BoardIntentActionType;
  payload: BoardIntentPayload;
  intent_id?: string | null;
  approval_token?: string | null;
  now?: Date;
}, executor: BoardIntentExecutor = db): Promise<BoardIntentApprovalDecision> {
  const intentId = input.intent_id?.trim();
  const token = input.approval_token?.trim();
  if (!intentId || !token) {
    return {
      kind: "deny",
      code: "board_intent_required",
      error: "Board Manager approval is required for this board action.",
    };
  }

  const [row] = (await executor
    .select()
    .from(board_intents)
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.id, intentId)
      )
    )
    .limit(1)) as BoardIntentRow[];
  if (!row) {
    return {
      kind: "deny",
      code: "board_intent_not_found",
      error: "Board intent approval was not found.",
    };
  }
  if (row.status === "expired") {
    return {
      kind: "deny",
      code: "board_intent_expired",
      error: row.approval_token_hash
        ? `Board intent ${intentId} approval has expired.`
        : `Board intent ${intentId} has expired.`,
    };
  }
  if (row.status !== "approved") {
    return {
      kind: "deny",
      code: "board_intent_not_approved",
      error: `Board intent ${intentId} is ${row.status}, not approved.`,
    };
  }
  if (row.action_type !== input.action_type) {
    return {
      kind: "deny",
      code: "board_intent_action_mismatch",
      error: `Board intent ${intentId} does not approve ${input.action_type}.`,
    };
  }
  if (row.payload_hash !== hashBoardIntentPayload(input.payload)) {
    return {
      kind: "deny",
      code: "board_intent_payload_mismatch",
      error: "Board intent approval does not match this action payload.",
    };
  }
  if (row.expires_at && Date.parse(row.expires_at) <= (input.now ?? new Date()).getTime()) {
    return {
      kind: "deny",
      code: "board_intent_expired",
      error: `Board intent ${intentId} approval has expired.`,
    };
  }
  if (!row.approval_token_hash || hashToken(token) !== row.approval_token_hash) {
    return {
      kind: "deny",
      code: "board_intent_token_invalid",
      error: "Board intent approval token is invalid.",
    };
  }

  return { kind: "allow", intent: toBoardIntent(row) };
}

export async function consumeBoardIntentApproval(
  input: BoardIntentConsumptionInput,
  executor: BoardIntentExecutor = db
): Promise<BoardIntentApprovalDecision> {
  const intentId = input.intent_id?.trim();
  const token = input.approval_token?.trim();
  if (!intentId || !token) {
    return {
      kind: "deny",
      code: "board_intent_required",
      error: "Board Manager approval is required for this board action.",
    };
  }

  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const [row] = (await executor
    .update(board_intents)
    .set({
      status: "used",
      updated_at: now,
    })
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.id, intentId),
        eq(board_intents.status, "approved"),
        eq(board_intents.action_type, input.action_type),
        eq(board_intents.payload_hash, hashBoardIntentPayload(input.payload)),
        eq(board_intents.approval_token_hash, hashToken(token)),
        sql`(${board_intents.expires_at} IS NULL OR ${board_intents.expires_at} > ${now}::timestamptz)`
      )
    )
    .returning()) as BoardIntentRow[];

  if (row) {
    return { kind: "allow", intent: toBoardIntent(row) };
  }

  return verifyBoardIntentApproval(input, executor);
}

export async function assertConsumeBoardIntentApproval(
  input: BoardIntentConsumptionInput,
  executor: BoardIntentExecutor = db
): Promise<BoardIntent | null> {
  const decision = await consumeBoardIntentApproval(input, executor);
  if (decision.kind === "deny") {
    throw new BoardIntentApprovalConsumptionError(decision);
  }
  return decision.intent ?? null;
}

export async function shouldRequireBoardIntent(input: {
  room_id: string;
}): Promise<boolean> {
  const settings = await getRoomBoardSettings(input.room_id);
  if (settings.manager_mode === "off") return false;
  if (settings.manager_mode === "intent_required") return true;
  return Boolean(await getActiveBoardManager(input.room_id));
}

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
