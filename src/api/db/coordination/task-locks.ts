import { and, asc, eq, or, sql } from "drizzle-orm";

import { db } from "../client.js";
import { task_locks } from "../schema.js";
import { toTaskLock } from "../mappers.js";
import { coordinationId } from "../utils.js";
import type { TaskLock, TaskLockReason, TaskLockRow, TaskLockScope } from "../types.js";

export async function createTaskLock(input: {
  room_id: string;
  scope: TaskLockScope;
  reason: TaskLockReason;
  created_by: string;
  task_id?: string | null;
  message?: string | null;
}): Promise<TaskLock> {
  const row: TaskLockRow = {
    id: coordinationId("lock"),
    room_id: input.room_id,
    task_id: input.task_id ?? null,
    scope: input.scope,
    reason: input.reason,
    message: input.message ?? null,
    created_by: input.created_by,
    created_at: new Date().toISOString(),
    cleared_by: null,
    cleared_at: null,
  };

  await db.insert(task_locks).values(row);
  return toTaskLock(row);
}

export async function getActiveTaskLocks(
  roomId: string,
  taskId?: string
): Promise<TaskLock[]> {
  const conditions = [
    eq(task_locks.room_id, roomId),
    sql`${task_locks.cleared_at} IS NULL`,
  ];
  if (taskId) {
    conditions.push(
      or(
        eq(task_locks.scope, "room" as TaskLockScope),
        and(eq(task_locks.scope, "task" as TaskLockScope), eq(task_locks.task_id, taskId))
      )!
    );
  }

  const rows = (await db
    .select()
    .from(task_locks)
    .where(and(...conditions))
    .orderBy(asc(task_locks.created_at))) as TaskLockRow[];

  return rows.map(toTaskLock);
}

export async function clearTaskLock(
  roomId: string,
  lockId: string,
  clearedBy: string
): Promise<TaskLock | null> {
  const [row] = (await db
    .update(task_locks)
    .set({
      cleared_by: clearedBy,
      cleared_at: new Date().toISOString(),
    })
    .where(and(eq(task_locks.room_id, roomId), eq(task_locks.id, lockId)))
    .returning()) as TaskLockRow[];

  return row ? toTaskLock(row) : null;
}
