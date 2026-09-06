import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import { db } from "./client.js";
import { syncRoomSharedArtifactsForTask } from "./room-shared-artifacts.js";
import { task_leases, tasks } from "./schema.js";
import { clampLimit, formatTaskId, nextRoomScopedNumber, parseScopedId, type RoomSequenceExecutor } from "./utils.js";
import { toTask } from "./mappers.js";
import {
  approveBoardIntent,
  assertConsumeBoardIntentApproval,
  getBoardIntent,
  markBoardIntentTaskResult,
} from "./coordination/board-intents.js";
import { createTaskLeaseRow } from "./coordination/lease-rows.js";
import { updateTaskLeaseWorkflowRefs } from "./coordination/task-leases.js";
import { acquireLeaseFenceTx, LeaseFenceStaleError, type LeaseFence } from "./coordination/lease-rebind.js";
import { resolveTaskAssignmentState, type TaskAssignmentPatch } from "./task-assignment.js";
import { normalizeTaskWorkflowArtifacts, synchronizeTaskWorkflowArtifactsWithPrUrl, type TaskWorkflowArtifact, type TaskWorkflowArtifactMatch } from "../repo-workflow.js";
import type { BoardIntent, BoardIntentConsumptionInput, BoardIntentPayload, Task, TaskOwnershipState, TaskRow, TaskStatus, TaskWorkLeaseCreationInput } from "./types.js";

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  proposed: ["accepted", "cancelled"],
  accepted: ["assigned", "cancelled"],
  assigned: ["in_progress", "in_review", "cancelled"],
  in_progress: ["blocked", "in_review", "done", "cancelled"],
  blocked: ["in_progress", "in_review", "cancelled"],
  in_review: ["merged", "in_progress", "blocked", "done", "cancelled"],
  merged: ["done", "accepted"],
  done: ["accepted"],
  cancelled: ["accepted"],
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

function optionalPayloadString(payload: BoardIntentPayload, key: string): string | null {
  const value = payload[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeTaskCreateBoardIntentPayload(payload: BoardIntentPayload): {
  title: string;
  description?: string | null;
  sourceMessageId?: string | null;
} | null {
  const title = optionalPayloadString(payload, "title");
  if (!title) return null;
  return {
    title,
    description: optionalPayloadString(payload, "description"),
    sourceMessageId: optionalPayloadString(payload, "source_message_id"),
  };
}

export async function getTasksForRooms(roomIds: readonly string[]): Promise<Task[]> {
  if (roomIds.length === 0) {
    return [];
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.room_id, [...roomIds]))
    .orderBy(desc(tasks.updated_at), asc(tasks.number));

  return (rows as TaskRow[]).map(toTask);
}

async function insertTaskRow(
  roomId: string,
  title: string,
  createdBy: string,
  description?: string,
  sourceMessageId?: string,
  executor: RoomSequenceExecutor = db,
  options?: { boardIntentApproval?: BoardIntentConsumptionInput | null; clientTaskId?: string | null }
): Promise<Task> {
  const now = new Date().toISOString();
  const task: TaskRow = {
    room_id: roomId,
    number: 0,
    title,
    description: description ?? null,
    status: "proposed",
    assignee: null,
    assignee_agent_key: null,
    created_by: createdBy,
    source_message_id: sourceMessageId ?? null,
    client_task_id: options?.clientTaskId ?? (options?.boardIntentApproval?.intent_id ? `board-intent:${options.boardIntentApproval.intent_id}` : null),
    pr_url: null,
    workflow_artifacts: [],
    created_at: now,
    updated_at: now,
  };

  if (options?.boardIntentApproval) {
    await assertConsumeBoardIntentApproval(options.boardIntentApproval, executor);
  }

  task.number = await nextRoomScopedNumber("tasks", roomId, executor);
  await executor.insert(tasks).values(task);

  if (
    options?.boardIntentApproval?.action_type === "task_create"
    && options.boardIntentApproval.intent_id
  ) {
    await markBoardIntentTaskResult({
      room_id: roomId,
      intent_id: options.boardIntentApproval.intent_id,
      task_id: formatTaskId(task.number),
    }, executor);
  }

  return toTask(task);
}

/**
 * Move a freshly created (proposed) task straight to accepted so agents can
 * claim it — the escalation path's whole point is unblocking claims without
 * an admin. Runs on the caller's executor so it commits with the escalation.
 */
export async function acceptProposedTaskTx(
  executor: Pick<typeof db, "update">,
  input: { room_id: string; task_id: string }
): Promise<boolean> {
  const taskNumber = parseScopedId(input.task_id, "task");
  if (!taskNumber) return false;

  const now = new Date().toISOString();
  const rows = await executor
    .update(tasks)
    .set({ status: "accepted", updated_at: now })
    .where(
      and(
        eq(tasks.room_id, input.room_id),
        eq(tasks.number, taskNumber),
        eq(tasks.status, "proposed")
      )
    )
    .returning({ number: tasks.number });

  return rows.length > 0;
}

export async function createTask(
  roomId: string,
  title: string,
  createdBy: string,
  description?: string,
  sourceMessageId?: string,
  options?: { boardIntentApproval?: BoardIntentConsumptionInput | null; clientTaskId?: string | null }
): Promise<Task> {
  if (options?.boardIntentApproval) {
    return db.transaction((tx) =>
      insertTaskRow(roomId, title, createdBy, description, sourceMessageId, tx, options)
    );
  }

  return insertTaskRow(roomId, title, createdBy, description, sourceMessageId, db, options);
}

export async function approveTaskCreateBoardIntent(input: {
  room_id: string;
  intent_id: string;
  decision_by: string;
  reason?: string | null;
  now?: Date;
}, executor?: Parameters<Parameters<(typeof db)["transaction"]>[0]>[0]): Promise<{ intent: BoardIntent; approval_token: string; task: Task } | null> {
  // Callers already inside a transaction (e.g. an announcement's message
  // hook) pass their executor so approval + task creation join it.
  const run = async (tx: NonNullable<typeof executor>) => {
    const existing = await getBoardIntent({
      room_id: input.room_id,
      intent_id: input.intent_id,
    }, tx);
    if (!existing || existing.action_type !== "task_create") {
      return null;
    }

    const approved = await approveBoardIntent(input, tx);
    if (!approved) return null;

    const payload = normalizeTaskCreateBoardIntentPayload(approved.intent.payload);
    if (!payload) {
      throw new Error(`Board intent ${input.intent_id} has an invalid task creation payload.`);
    }

    const task = await insertTaskRow(
      input.room_id,
      payload.title,
      approved.intent.proposer_actor_label ?? input.decision_by,
      payload.description ?? undefined,
      payload.sourceMessageId ?? undefined,
      tx,
      {
        boardIntentApproval: {
          room_id: input.room_id,
          action_type: "task_create",
          payload: approved.intent.payload,
          intent_id: approved.intent.id,
          approval_token: approved.approval_token,
          now: input.now,
        },
      }
    );

    const intent = await getBoardIntent({
      room_id: input.room_id,
      intent_id: approved.intent.id,
    }, tx);
    return {
      intent: intent ?? { ...approved.intent, status: "used", task_id: task.id },
      approval_token: approved.approval_token,
      task,
    };
  };

  return executor ? run(executor) : db.transaction(run);
}

export async function getTasks(
  roomId: string,
  statusFilter?: string,
  options?: { limit?: number; after?: string }
): Promise<{ tasks: Task[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const afterNumber = options?.after ? parseScopedId(options.after, "task") : null;

  const conditions = [eq(tasks.room_id, roomId)];
  if (statusFilter) conditions.push(eq(tasks.status, statusFilter as TaskStatus));
  if (afterNumber) conditions.push(sql`${tasks.number} > ${afterNumber}`);

  const query = db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.number))
    .limit(limit + 1);

  const rows = (await query) as TaskRow[];
  const has_more = rows.length > limit;
  const bounded = has_more ? rows.slice(0, limit) : rows;
  return { tasks: bounded.map(toTask), has_more };
}

export async function getOpenTasks(
  roomId: string,
  options?: { limit?: number; after?: string }
): Promise<{ tasks: Task[]; has_more: boolean }> {
  const limit = clampLimit(options?.limit);
  const afterNumber = options?.after ? parseScopedId(options.after, "task") : null;

  const conditions = [
    eq(tasks.room_id, roomId),
    notInArray(tasks.status, ["done", "cancelled"]),
  ];
  if (afterNumber) conditions.push(sql`${tasks.number} > ${afterNumber}`);

  const rows = (await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.number))
    .limit(limit + 1)) as TaskRow[];

  const has_more = rows.length > limit;
  const bounded = has_more ? rows.slice(0, limit) : rows;
  return { tasks: bounded.map(toTask), has_more };
}

export async function getTaskRowById(roomId: string, taskId: string): Promise<TaskRow | undefined> {
  const taskNumber = parseScopedId(taskId, "task");
  if (!taskNumber) {
    return undefined;
  }

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.room_id, roomId), eq(tasks.number, taskNumber)))
    .limit(1);

  return task as TaskRow | undefined;
}

export async function getTaskById(roomId: string, taskId: string): Promise<Task | undefined> {
  const task = await getTaskRowById(roomId, taskId);
  return task ? toTask(task) : undefined;
}

export async function getTaskOwnershipState(
  roomId: string,
  taskId: string
): Promise<TaskOwnershipState | undefined> {
  const task = await getTaskRowById(roomId, taskId);
  if (!task) {
    return undefined;
  }

  return {
    status: task.status,
    assignee: task.assignee,
    assignee_agent_key: task.assignee_agent_key,
  };
}

export async function findTaskByPrUrl(roomId: string, prUrl: string): Promise<Task | undefined> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.room_id, roomId), eq(tasks.pr_url, prUrl)))
    .orderBy(asc(tasks.number))
    .limit(1);

  return task ? toTask(task as TaskRow) : undefined;
}

export async function findTaskByClientId(roomId: string, clientTaskId: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(and(
    eq(tasks.room_id, roomId), eq(tasks.client_task_id, clientTaskId),
  )).limit(1);
  return row ? toTask(row) : null;
}

export async function findTaskBySourceMessageId(
  roomId: string,
  sourceMessageId: string,
  options?: { legacyOnly?: boolean },
): Promise<Task | undefined> {
  const trimmedSourceMessageId = sourceMessageId.trim();
  if (!trimmedSourceMessageId) return undefined;

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.room_id, roomId),
      eq(tasks.source_message_id, trimmedSourceMessageId),
      options?.legacyOnly ? sql`${tasks.client_task_id} IS NULL` : undefined,
    ))
    .orderBy(asc(tasks.number))
    .limit(1);

  return task ? toTask(task as TaskRow) : undefined;
}

export function hasTaskWorkflowArtifactMatchIdentifier(match: TaskWorkflowArtifactMatch): boolean {
  return (
    Boolean(match.url) ||
    Boolean(match.id) ||
    Boolean(match.ref) ||
    Boolean(match.title) ||
    (match.number !== undefined && match.number !== null)
  );
}

export function toTaskWorkflowArtifactMatchJson(match: TaskWorkflowArtifactMatch): string {
  const artifact: Record<string, string | number> = {
    provider: match.provider,
    kind: match.kind,
  };

  if (match.id) {
    artifact.id = match.id;
  }

  if (match.number !== undefined && match.number !== null) {
    artifact.number = match.number;
  }

  if (match.title) {
    artifact.title = match.title;
  }

  if (match.url) {
    artifact.url = match.url;
  }

  if (match.ref) {
    artifact.ref = match.ref;
  }

  return JSON.stringify([artifact]);
}

export async function findTaskByWorkflowArtifactMatches(
  roomId: string,
  matches: TaskWorkflowArtifactMatch[]
): Promise<Task | undefined> {
  for (const match of matches) {
    if (!hasTaskWorkflowArtifactMatchIdentifier(match)) {
      continue;
    }

    const [task] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.room_id, roomId),
          sql`${tasks.workflow_artifacts} @> ${toTaskWorkflowArtifactMatchJson(match)}::jsonb`
        )
      )
      .orderBy(asc(tasks.number))
      .limit(1);

    if (task) {
      return toTask(task as TaskRow);
    }
  }

  return undefined;
}

export async function updateTask(
  roomId: string,
  taskId: string,
  updates: {
    status?: TaskStatus;
    assignee?: string | null;
    assignee_agent_key?: string | null;
    pr_url?: string;
    workflow_artifacts?: TaskWorkflowArtifact[];
  },
  options?: {
    boardIntentApproval?: BoardIntentConsumptionInput | null;
    workLeaseCreation?: TaskWorkLeaseCreationInput | null;
    // When the caller's authority to mutate this task derives from holding a
    // work lease, the observed lease identity is fenced INSIDE the write tx
    // (plan §4.5): the shared advisory lock + full-tuple re-validation runs
    // atomically with the UPDATE, so a rebind that commits between the route's
    // lease read and this write makes the fence stale and the write throws
    // LeaseFenceStaleError instead of a stale predecessor overwriting the
    // successor's task state. Absent for owner/admin or lease-creation writes.
    leaseFence?: LeaseFence | null;
  }
): Promise<Task | null> {
  const task = await getTaskRowById(roomId, taskId);
  if (!task) return null;

  const retryingOwnClaim = task.status === "assigned" && updates.status === "assigned"
    && Boolean(task.assignee_agent_key)
    && updates.assignee_agent_key === task.assignee_agent_key
    && updates.assignee === task.assignee
    && Boolean(options?.leaseFence?.agent_session_id
      || (options?.workLeaseCreation?.agent_session_id
        && options.workLeaseCreation.agent_key === task.assignee_agent_key));
  if (options?.workLeaseCreation && updates.status === "assigned"
    && task.status !== "accepted" && !retryingOwnClaim) {
    throw new LeaseFenceStaleError();
  }
  if (updates.status && !isValidTransition(task.status, updates.status) && !retryingOwnClaim) {
    throw new Error(
      `Invalid transition: ${task.status} → ${updates.status}. ` +
        `Allowed: ${VALID_TRANSITIONS[task.status].join(", ") || "none"}`
    );
  }

  const taskNumber = parseScopedId(taskId, "task");
  if (!taskNumber) {
    return null;
  }

  const assignment = resolveTaskAssignmentState(task, updates);
  const newPrUrl = updates.pr_url ?? task.pr_url;
  const newWorkflowArtifacts = updates.workflow_artifacts
    ? normalizeTaskWorkflowArtifacts({
        artifacts: updates.workflow_artifacts,
        prUrl: newPrUrl,
      })
    : synchronizeTaskWorkflowArtifactsWithPrUrl({
        artifacts: task.workflow_artifacts,
        previousPrUrl: task.pr_url,
        nextPrUrl: newPrUrl,
      });
  const now = new Date().toISOString();

  const writeTaskUpdate = async (executor: Pick<typeof db, "update">) => {
    await executor
      .update(tasks)
      .set({
        status: assignment.status,
        assignee: assignment.assignee,
        assignee_agent_key: assignment.assignee_agent_key,
        pr_url: newPrUrl,
        workflow_artifacts: newWorkflowArtifacts,
        updated_at: now,
      })
      .where(and(eq(tasks.room_id, roomId), eq(tasks.number, taskNumber)));
  };

  const writeWorkLeaseCreation = async (executor: Pick<typeof db, "insert">) => {
    if (!options?.workLeaseCreation) {
      return;
    }
    await executor.insert(task_leases).values(
      createTaskLeaseRow(
        {
          ...options.workLeaseCreation,
          room_id: roomId,
          task_id: taskId,
          kind: "work",
        },
        now
      )
    );
  };

  // All lease-scoped side effects (the fenced lease's pr_url ref bind + the
  // shared-artifact upsert/link/prune) run through one executor so that, on the
  // fenced path, they commit or roll back ATOMICALLY with the task write under
  // acquireLeaseFenceTx (plan §4.5). No base-client writes leak out of the tx.
  const writeArtifactSideEffects = async (
    executor: Parameters<typeof syncRoomSharedArtifactsForTask>[1] &
      Parameters<typeof updateTaskLeaseWorkflowRefs>[3]
  ) => {
    if (options?.leaseFence && updates.pr_url !== undefined) {
      await updateTaskLeaseWorkflowRefs(
        roomId,
        options.leaseFence.lease_id,
        { pr_url: updates.pr_url ?? null },
        executor
      );
    }
    await syncRoomSharedArtifactsForTask(
      { room_id: roomId, task_id: taskId, artifacts: newWorkflowArtifacts },
      executor
    );
  };

  if (options?.boardIntentApproval || options?.workLeaseCreation || options?.leaseFence) {
    await db.transaction(async (tx) => {
      // Fence FIRST, under the shared lease advisory lock, so the whole write
      // linearizes against a concurrent rebind. A stale fence aborts the tx
      // before any task state changes.
      if (options.leaseFence) {
        const held = await acquireLeaseFenceTx(tx, options.leaseFence);
        if (!held) throw new LeaseFenceStaleError();
      }
      if (options.workLeaseCreation || retryingOwnClaim) {
        // Serialize fresh/recovery claims on the task row. A concurrent claim
        // must not overwrite the winning assignee or mint a second work lease.
        const [current] = await tx.select().from(tasks)
          .where(and(eq(tasks.room_id, roomId), eq(tasks.number, taskNumber)))
          .for("update");
        if (!current || current.status !== task.status
          || current.assignee !== task.assignee
          || current.assignee_agent_key !== task.assignee_agent_key
          || current.updated_at !== task.updated_at
          || current.pr_url !== task.pr_url
          || JSON.stringify(current.workflow_artifacts) !== JSON.stringify(task.workflow_artifacts)) {
          throw new LeaseFenceStaleError();
        }
        if (options.workLeaseCreation) {
          const [existingWork] = await tx.select({ id: task_leases.id }).from(task_leases)
            .where(and(eq(task_leases.room_id, roomId), eq(task_leases.task_id, taskId),
              eq(task_leases.kind, "work"), eq(task_leases.status, "active")))
            .limit(1);
          if (existingWork) throw new LeaseFenceStaleError();
        }
      }
      if (options.boardIntentApproval) {
        await assertConsumeBoardIntentApproval(options.boardIntentApproval, tx);
      }
      await writeTaskUpdate(tx);
      await writeWorkLeaseCreation(tx);
      // Fenced path: refs + artifact sync inside the same fenced tx.
      if (options.leaseFence) {
        await writeArtifactSideEffects(tx);
      }
    });
    // Non-fenced tx (board-intent / lease-creation only): the lease ref bind is
    // still performed by enforcement; sync outside the tx as before.
    if (!options?.leaseFence) {
      await writeArtifactSideEffects(db);
    }
  } else {
    await writeTaskUpdate(db);
    await writeArtifactSideEffects(db);
  }

  return toTask({
    ...task,
    status: assignment.status,
    assignee: assignment.assignee,
    assignee_agent_key: assignment.assignee_agent_key,
    pr_url: newPrUrl,
    workflow_artifacts: newWorkflowArtifacts,
    updated_at: now,
  });
}

export async function setTaskAssignmentStateForLeaseAction(
  roomId: string,
  taskId: string,
  updates: TaskAssignmentPatch
): Promise<Task | null> {
  const task = await getTaskRowById(roomId, taskId);
  if (!task) return null;

  const taskNumber = parseScopedId(taskId, "task");
  if (!taskNumber) {
    return null;
  }

  const assignment = resolveTaskAssignmentState(task, updates);
  const now = new Date().toISOString();

  await db
    .update(tasks)
    .set({
      status: assignment.status,
      assignee: assignment.assignee,
      assignee_agent_key: assignment.assignee_agent_key,
      updated_at: now,
    })
    .where(and(eq(tasks.room_id, roomId), eq(tasks.number, taskNumber)));

  return toTask({
    ...task,
    status: assignment.status,
    assignee: assignment.assignee,
    assignee_agent_key: assignment.assignee_agent_key,
    updated_at: now,
  });
}
