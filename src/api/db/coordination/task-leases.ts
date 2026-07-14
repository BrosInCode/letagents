import { and, asc, eq, lte, sql } from "drizzle-orm";

import { db } from "../client.js";
import { task_leases } from "../schema.js";
import { toTaskLease } from "../mappers.js";
import type { TaskLease, TaskLeaseKind, TaskLeaseRow, TaskLeaseStatus } from "../types.js";
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

// Fetch a single lease by id regardless of status. Used by grant-authenticated
// routes to check a supervisor grant's room+agent scope against the target lease
// before acting on it.
export async function getTaskLeaseById(leaseId: string): Promise<TaskLease | null> {
  const [row] = (await db
    .select()
    .from(task_leases)
    .where(eq(task_leases.id, leaseId))
    .limit(1)) as TaskLeaseRow[];
  return row ? toTaskLease(row) : null;
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
  leaseId: string,
  // Optional fence (plan §4.5). Release is a lease-authorized destructive write;
  // when the caller passes the lease identity it observed, the CAS + the shared
  // task_lease:<id> advisory lock linearize it against a concurrent rebind or
  // release so a stale predecessor's release becomes a no-op (returns null)
  // instead of acting on state that moved under it. Review leases are
  // non-rebindable so their epoch is a static 0 consistency assertion; the
  // status=active guard alone also closes the read-then-release TOCTOU.
  fence?: {
    kind?: TaskLeaseKind;
    expected_epoch?: number;
    expected_agent_session_id?: string | null;
  }
): Promise<TaskLease | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task_lease:${leaseId}`}, 0))`
    );
    const [row] = (await tx
      .update(task_leases)
      .set({
        status: "released",
        updated_at: new Date().toISOString(),
      })
      .where(and(
        eq(task_leases.room_id, roomId),
        eq(task_leases.id, leaseId),
        eq(task_leases.status, "active" as TaskLeaseStatus),
        ...(fence?.kind ? [eq(task_leases.kind, fence.kind)] : []),
        ...(typeof fence?.expected_epoch === "number"
          ? [eq(task_leases.epoch, fence.expected_epoch)]
          : []),
        ...(typeof fence?.expected_agent_session_id === "string" && fence.expected_agent_session_id
          ? [eq(task_leases.agent_session_id, fence.expected_agent_session_id)]
          : []),
      ))
      .returning()) as TaskLeaseRow[];

    return row ? toTaskLease(row) : null;
  });
}

export async function updateTaskLeaseWorkflowRefs(
  roomId: string,
  leaseId: string,
  updates: {
    branch_ref?: string | null;
    pr_url?: string | null;
  },
  executor: Pick<typeof db, "update"> = db
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

  const [row] = (await executor
    .update(task_leases)
    .set(patch)
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)))
    .returning()) as TaskLeaseRow[];

  return row ? toTaskLease(row) : null;
}
