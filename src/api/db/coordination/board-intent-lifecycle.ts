import crypto from "crypto";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";

import { db } from "../client.js";
import { board_intents, task_leases, tasks } from "../schema.js";
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
  /** Internal only; supplied by authenticated registration, never copied from the request body. */
  proposer_worker_auth_kind?: "bearer" | "session_token" | null;
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
    approved_task_status: null,
    approved_task_assignee_agent_key: null,
    approved_manager_assignment_id: null,
    created_at: now,
    updated_at: now,
  };

  const proposerWorkerAuthKind = input.proposer_worker_auth_kind ?? null;
  const [created] = (await db
    .insert(board_intents)
    .values({ ...row, proposer_worker_auth_kind: proposerWorkerAuthKind })
    // A retry returns the same proposer's pending request. Another proposer,
    // or the same claimed identity with different provenance, gets its own.
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
        eq(board_intents.status, "pending"),
        sql`${board_intents.proposer_agent_session_id} IS NOT DISTINCT FROM ${row.proposer_agent_session_id}`,
        sql`${board_intents.proposer_actor_key} IS NOT DISTINCT FROM ${row.proposer_actor_key}`,
        sql`${board_intents.proposer_worker_auth_kind} IS NOT DISTINCT FROM ${proposerWorkerAuthKind}`
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
  /** The approving Board Manager's assignment; omitted when a person approves. */
  manager_assignment_id?: string | null;
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
      // Record the task as approved, read in the same statement, so the
      // approval can be refused later if the task has changed since.
      approved_task_status: sql`(SELECT ${tasks.status}::text FROM ${tasks}
        WHERE ${tasks.room_id} = ${board_intents.room_id}
          AND 'task_' || ${tasks.number} = ${board_intents.payload}->>'task_id')`,
      approved_task_assignee_agent_key: sql`(SELECT ${tasks.assignee_agent_key} FROM ${tasks}
        WHERE ${tasks.room_id} = ${board_intents.room_id}
          AND 'task_' || ${tasks.number} = ${board_intents.payload}->>'task_id')`,
      approved_manager_assignment_id: input.manager_assignment_id ?? null,
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

const TASK_PROGRESS_RANK: Record<string, number> = {
  proposed: 0,
  accepted: 1,
  assigned: 2,
  in_progress: 3,
  blocked: 3,
  in_review: 4,
  merged: 5,
};

// From a closed status a task can only take these steps; anything else
// needs a reopen first.
const CLOSED_STATUS_NEXT_STEPS: Record<string, string[]> = {
  merged: ["done", "accepted"],
  done: ["accepted"],
  cancelled: ["accepted"],
};

type SupersedeTaskState = { id: string; status: string; assignee_agent_key: string | null };

// Why an open intent no longer applies to its task, or null while it still does.
function boardIntentSupersedeReason(
  intent: Pick<BoardIntentRow, "action_type" | "payload" | "proposer_actor_key" | "status" | "decision_by">,
  task: SupersedeTaskState,
  activeWorkLeaseId: string | null,
  taskChanged: boolean
): string | null {
  if (intent.action_type === "task_create") return null;
  // An approval was granted for the task as it stood. Once the task's status
  // or assignee changes it must not be replayable, for example after a reopen.
  if (intent.status === "approved" && taskChanged) {
    return `Superseded: ${task.id} moved to ${task.status} after ${intent.decision_by ?? "the manager"} approved it.`;
  }
  const action = typeof intent.payload.action === "string" ? intent.payload.action : null;
  if (action) {
    // Lease release/handoff intents are bound to the lease they name.
    const leaseId = typeof intent.payload.lease_id === "string" ? intent.payload.lease_id : null;
    return leaseId && leaseId !== activeWorkLeaseId
      ? `Superseded: the work lease it names is no longer active on ${task.id}.`
      : null;
  }
  const target = typeof intent.payload.status === "string" ? intent.payload.status : null;
  if (!target || intent.status === "approved") return null;
  const moved = `Superseded: ${task.id} moved to ${task.status}.`;
  if (intent.action_type === "task_claim") {
    // A claim can still run on an accepted task or recover the proposer's own assignment.
    return task.status !== "accepted"
      && !(task.status === "assigned" && task.assignee_agent_key === intent.proposer_actor_key)
      ? moved : null;
  }
  // Reopening stays possible from every later state until the task is accepted.
  if (target === "accepted") return task.status === "accepted" ? moved : null;
  if (task.status === target) return moved;
  const closedNextSteps = CLOSED_STATUS_NEXT_STEPS[task.status];
  if (closedNextSteps) return closedNextSteps.includes(target) ? null : moved;
  return (TASK_PROGRESS_RANK[task.status] ?? -1) > (TASK_PROGRESS_RANK[target] ?? Number.POSITIVE_INFINITY)
    ? moved : null;
}

/**
 * Resolve open intents that a task change carried out, passed or made
 * impossible: pending requests managers would otherwise still be asked to
 * decide, and approvals that must not be replayed against a changed task.
 */
export async function supersedeBoardIntentsForTask(input: {
  room_id: string;
  task: SupersedeTaskState;
  /** The task's status or assignee changed (not only its work lease). */
  task_changed: boolean;
  now?: Date;
}, executor: BoardIntentExecutor = db): Promise<BoardIntent[]> {
  const open = (await executor
    .select()
    .from(board_intents)
    .where(
      and(
        eq(board_intents.room_id, input.room_id),
        inArray(board_intents.status, ["pending", "approved"]),
        sql`${board_intents.payload}->>'task_id' = ${input.task.id}`
      )
    )) as BoardIntentRow[];
  if (open.length === 0) return [];
  const [activeWorkLease] = open.some((row) => typeof row.payload.action === "string")
    ? await executor
      .select({ id: task_leases.id })
      .from(task_leases)
      .where(and(eq(task_leases.room_id, input.room_id), eq(task_leases.task_id, input.task.id),
        eq(task_leases.kind, "work"), eq(task_leases.status, "active")))
      .limit(1)
    : [];

  const now = (input.now ?? new Date()).toISOString();
  const superseded: BoardIntent[] = [];
  for (const row of open) {
    const reason = boardIntentSupersedeReason(row, input.task, activeWorkLease?.id ?? null, input.task_changed);
    if (!reason) continue;
    const [updated] = (await executor
      .update(board_intents)
      .set({ status: "superseded", decision_by: "LetAgents", decision_reason: reason, decided_at: now, updated_at: now })
      .where(and(eq(board_intents.room_id, input.room_id), eq(board_intents.id, row.id), eq(board_intents.status, row.status)))
      .returning()) as BoardIntentRow[];
    if (updated) superseded.push(toBoardIntent(updated));
  }
  return superseded;
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
