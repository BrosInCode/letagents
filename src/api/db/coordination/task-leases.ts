import { and, asc, eq, lte, sql } from "drizzle-orm";

import { db } from "../client.js";
import { task_leases } from "../schema.js";
import { toTaskLease } from "../mappers.js";
import type { TaskLease, TaskLeaseRow, TaskLeaseStatus } from "../types.js";
import { createTaskLeaseRow, type CreateTaskLeaseRowInput } from "./lease-rows.js";

export async function expireStaleTaskLeases(
  roomId: string,
  at: Date = new Date()
): Promise<number> {
  const now = at.toISOString();
  const expired = await db
    .update(task_leases)
    .set({
      status: "expired",
      updated_at: now,
    })
    .where(
      and(
        eq(task_leases.room_id, roomId),
        eq(task_leases.status, "active" as TaskLeaseStatus),
        sql`${task_leases.expires_at} IS NOT NULL`,
        lte(task_leases.expires_at, now)
      )
    )
    .returning({ id: task_leases.id });

  return expired.length;
}

export async function createTaskLease(
  input: CreateTaskLeaseRowInput
): Promise<TaskLease> {
  const now = new Date().toISOString();
  await expireStaleTaskLeases(input.room_id, new Date(now));
  const row = createTaskLeaseRow(input, now);

  await db.insert(task_leases).values(row);
  return toTaskLease(row);
}

export async function getActiveTaskLeases(
  roomId: string,
  taskId?: string
): Promise<TaskLease[]> {
  const now = new Date().toISOString();
  await expireStaleTaskLeases(roomId, new Date(now));
  const conditions = [
    eq(task_leases.room_id, roomId),
    eq(task_leases.status, "active" as TaskLeaseStatus),
    sql`(${task_leases.expires_at} IS NULL OR ${task_leases.expires_at} > ${now})`,
  ];
  if (taskId) {
    conditions.push(eq(task_leases.task_id, taskId));
  }

  const rows = (await db
    .select()
    .from(task_leases)
    .where(and(...conditions))
    .orderBy(asc(task_leases.created_at))) as TaskLeaseRow[];

  return rows.map(toTaskLease);
}

export async function revokeTaskLease(
  roomId: string,
  leaseId: string,
  revokedReason: string
): Promise<TaskLease | null> {
  const [row] = (await db
    .update(task_leases)
    .set({
      status: "revoked",
      revoked_reason: revokedReason,
      updated_at: new Date().toISOString(),
    })
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)))
    .returning()) as TaskLeaseRow[];

  return row ? toTaskLease(row) : null;
}

export async function releaseTaskLease(
  roomId: string,
  leaseId: string
): Promise<TaskLease | null> {
  const [row] = (await db
    .update(task_leases)
    .set({
      status: "released",
      updated_at: new Date().toISOString(),
    })
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)))
    .returning()) as TaskLeaseRow[];

  return row ? toTaskLease(row) : null;
}

export async function updateTaskLeaseWorkflowRefs(
  roomId: string,
  leaseId: string,
  updates: {
    branch_ref?: string | null;
    pr_url?: string | null;
  }
): Promise<TaskLease | null> {
  const patch: {
    branch_ref?: string | null;
    pr_url?: string | null;
    updated_at: string;
  } = {
    updated_at: new Date().toISOString(),
  };
  if ("branch_ref" in updates) {
    patch.branch_ref = updates.branch_ref ?? null;
  }
  if ("pr_url" in updates) {
    patch.pr_url = updates.pr_url ?? null;
  }

  const [row] = (await db
    .update(task_leases)
    .set(patch)
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)))
    .returning()) as TaskLeaseRow[];

  return row ? toTaskLease(row) : null;
}
