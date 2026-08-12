import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../client.js";
import { board_intents } from "../schema.js";
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
