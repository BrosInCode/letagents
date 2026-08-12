import crypto from "crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";

import { db } from "../client.js";
import { board_intents } from "../schema.js";
import { toBoardIntent } from "../mappers.js";
import { coordinationId, hashToken } from "../utils.js";
import type { BoardIntentPayload } from "../../board-intent-payloads.js";
import type { BoardIntent, BoardIntentActionType, BoardIntentRow } from "../types.js";
import { hashBoardIntentPayload, type BoardIntentExecutor } from "./board-intent-approval.js";

export const BOARD_INTENT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const BOARD_INTENT_APPROVAL_TTL_MS = 30 * 60 * 1000;

function approvalToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function defaultPendingIntentExpiresAt(now: Date): string {
  return new Date(now.getTime() + BOARD_INTENT_PENDING_TTL_MS).toISOString();
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
