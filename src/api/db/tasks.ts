import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

import { db } from "./client.js";
import { syncRoomSharedArtifactsForTask } from "./room-shared-artifacts.js";
import { task_leases, tasks } from "./schema.js";
import { clampLimit, nextRoomScopedNumber, parseScopedId } from "./utils.js";
import { toTask } from "./mappers.js";
import { assertConsumeBoardIntentApproval } from "./coordination/board-intents.js";
import { createTaskLeaseRow } from "./coordination/lease-rows.js";
import { resolveTaskAssignmentState, type TaskAssignmentPatch } from "./task-assignment.js";
import { normalizeTaskWorkflowArtifacts, synchronizeTaskWorkflowArtifactsWithPrUrl, type TaskWorkflowArtifact, type TaskWorkflowArtifactMatch } from "../repo-workflow.js";
import type { BoardIntentConsumptionInput, Task, TaskOwnershipState, TaskRow, TaskStatus, TaskWorkLeaseCreationInput } from "./types.js";

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

export async function createTask(
  roomId: string,
  title: string,
  createdBy: string,
  description?: string,
  sourceMessageId?: string,
  options?: { boardIntentApproval?: BoardIntentConsumptionInput | null }
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
    pr_url: null,
    workflow_artifacts: [],
    created_at: now,
    updated_at: now,
  };

  if (options?.boardIntentApproval) {
    await db.transaction(async (tx) => {
      await assertConsumeBoardIntentApproval(options.boardIntentApproval!, tx);
      task.number = await nextRoomScopedNumber("tasks", roomId, tx);
      await tx.insert(tasks).values(task);
    });
  } else {
    task.number = await nextRoomScopedNumber("tasks", roomId);
    await db.insert(tasks).values(task);
  }

  return toTask(task);
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
    notInArray(tasks.status, ["merged", "done", "cancelled"]),
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

export async function findTaskBySourceMessageId(
  roomId: string,
  sourceMessageId: string,
): Promise<Task | undefined> {
  const trimmedSourceMessageId = sourceMessageId.trim();
  if (!trimmedSourceMessageId) return undefined;

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.room_id, roomId),
      eq(tasks.source_message_id, trimmedSourceMessageId),
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
  }
): Promise<Task | null> {
  const task = await getTaskRowById(roomId, taskId);
  if (!task) return null;

  if (updates.status && !isValidTransition(task.status, updates.status)) {
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

  if (options?.boardIntentApproval || options?.workLeaseCreation) {
    await db.transaction(async (tx) => {
      if (options.boardIntentApproval) {
        await assertConsumeBoardIntentApproval(options.boardIntentApproval, tx);
      }
      await writeTaskUpdate(tx);
      await writeWorkLeaseCreation(tx);
    });
  } else {
    await writeTaskUpdate(db);
  }

  await syncRoomSharedArtifactsForTask({
    room_id: roomId,
    task_id: taskId,
    artifacts: newWorkflowArtifacts,
  });

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
