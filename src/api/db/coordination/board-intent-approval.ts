import crypto from "crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "../client.js";
import { board_intents, board_manager_assignments, room_agent_sessions, room_board_settings } from "../schema.js";
import { toBoardIntent } from "../mappers.js";
import { hashToken } from "../utils.js";
import type { BoardIntentPayload } from "../../board-intent-payloads.js";
import type { BoardIntent, BoardIntentActionType, BoardIntentRow } from "../types.js";
import { getActiveBoardManager, getRoomBoardSettings } from "./board-intent-manager.js";

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
  /** Internal only: derived from authenticated worker authority, never request payload. */
  trusted_worker?: { agent_session_id: string; agent_key: string };
  /** The task as the consumer sees it (under its row lock when consuming). */
  task_state?: { status: string; assignee_agent_key: string | null };
  now?: Date;
}

export type BoardIntentExecutor = Pick<typeof db, "select" | "update">;

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

// A manager's approval carries the manager's authority (a person's has none
// recorded): the approving assignment must still be the room's live manager,
const approvingAssignmentLive = sql`(${board_intents.approved_manager_assignment_id} IS NULL OR EXISTS (
  SELECT 1 FROM ${board_manager_assignments}
  JOIN ${room_agent_sessions} ON ${room_agent_sessions.session_id} = ${board_manager_assignments.agent_session_id}
    AND ${room_agent_sessions.room_id} = ${board_manager_assignments.room_id}
    AND ${room_agent_sessions.ended_at} IS NULL
  WHERE ${board_manager_assignments.id} = ${board_intents.approved_manager_assignment_id}
    AND ${board_manager_assignments.status} = 'active'))`;

// and the room's manager mode must still be on. Checked when the approval is
// used, so an approval that lands just after a switch to off cannot be used.
const approvingManagerModeOn = sql`(${board_intents.approved_manager_assignment_id} IS NULL OR NOT EXISTS (
  SELECT 1 FROM ${room_board_settings}
  WHERE ${room_board_settings.room_id} = ${board_intents.room_id}
    AND ${room_board_settings.manager_mode} = 'off'))`;

function approvedTaskStateMatches(taskState: NonNullable<BoardIntentConsumptionInput["task_state"]>) {
  return sql`(${board_intents.approved_task_status} IS NULL OR (
    ${board_intents.approved_task_status} = ${taskState.status}
    AND ${board_intents.approved_task_assignee_agent_key} IS NOT DISTINCT FROM ${taskState.assignee_agent_key}))`;
}

export async function verifyBoardIntentApproval(input: BoardIntentConsumptionInput, executor: BoardIntentExecutor = db): Promise<BoardIntentApprovalDecision> {
  const intentId = input.intent_id?.trim();
  const token = input.approval_token?.trim();
  const worker = input.trusted_worker;
  const workerBound = Boolean(worker?.agent_session_id?.trim() && worker.agent_key?.trim());
  if (!intentId || (!token && !workerBound)) {
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
  if (token ? !row.approval_token_hash || hashToken(token) !== row.approval_token_hash
    : row.proposer_agent_session_id !== worker!.agent_session_id || row.proposer_actor_key !== worker!.agent_key) {
    return {
      kind: "deny",
      code: token ? "board_intent_token_invalid" : "board_intent_worker_mismatch",
      error: token ? "Board intent approval token is invalid." : "Board intent approval belongs to a different worker session.",
    };
  }
  // Only an intent registered by an authenticated worker session can be
  // carried out by that session; body-supplied proposer fields prove nothing.
  // Claims keep their explicit legacy follow-up for unverified registrations.
  if (!token && input.action_type !== "task_claim"
    && !(row as typeof board_intents.$inferSelect).proposer_worker_auth_kind) {
    return {
      kind: "deny",
      code: "board_intent_worker_unverified",
      error: "Board intent was not registered by an authenticated worker session.",
    };
  }
  if (input.task_state && row.approved_task_status !== null
    && (row.approved_task_status !== input.task_state.status
      || row.approved_task_assignee_agent_key !== (input.task_state.assignee_agent_key ?? null))) {
    return {
      kind: "deny",
      code: "board_intent_task_changed",
      error: `The task changed after board intent ${intentId} was approved; request approval again.`,
    };
  }
  if (row.approved_manager_assignment_id) {
    const [authority] = await executor
      .select({
        assignment_live: sql<boolean>`${approvingAssignmentLive}`,
        mode_on: sql<boolean>`${approvingManagerModeOn}`,
      })
      .from(board_intents)
      .where(eq(board_intents.id, row.id))
      .limit(1);
    if (!authority?.assignment_live) {
      return {
        kind: "deny",
        code: "board_intent_manager_changed",
        error: `The Board Manager who approved board intent ${intentId} is no longer assigned; request approval again.`,
      };
    }
    if (!authority.mode_on) {
      return {
        kind: "deny",
        code: "board_manager_mode_off",
        error: `Board Manager mode is off, so the manager's approval of board intent ${intentId} no longer applies.`,
      };
    }
  }

  return { kind: "allow", intent: toBoardIntent(row) };
}

export async function consumeBoardIntentApproval(
  input: BoardIntentConsumptionInput,
  executor: BoardIntentExecutor = db
): Promise<BoardIntentApprovalDecision> {
  const intentId = input.intent_id?.trim();
  const token = input.approval_token?.trim();
  const worker = input.trusted_worker;
  const workerBound = Boolean(worker?.agent_session_id?.trim() && worker.agent_key?.trim());
  if (!intentId || (!token && !workerBound)) {
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
        ...(token ? [eq(board_intents.approval_token_hash, hashToken(token))] : [
          eq(board_intents.proposer_agent_session_id, worker!.agent_session_id),
          eq(board_intents.proposer_actor_key, worker!.agent_key),
          ...(input.action_type === "task_claim" ? [] : [isNotNull(board_intents.proposer_worker_auth_kind)]),
        ]),
        sql`(${board_intents.expires_at} IS NULL OR ${board_intents.expires_at} > ${now}::timestamptz)`,
        ...(input.task_state ? [approvedTaskStateMatches(input.task_state)] : []),
        approvingAssignmentLive,
        approvingManagerModeOn
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
