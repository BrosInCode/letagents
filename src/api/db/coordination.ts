import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { ACTIVE_AGENT_DELIVERY_WINDOW_MS, type RoomAgentSessionKind } from "../../shared/agent-presence.js";
import type { CoordinationEventMetadata } from "./schema.js";
import { db } from "./client.js";
import { coordination_events, room_agent_delivery_sessions, stale_task_prompt_mutes, task_leases, task_locks, tasks } from "./schema.js";
import { coordinationId, parseScopedId } from "./utils.js";
import { toCoordinationEvent, toStaleTaskPromptMute, toTask, toTaskLease, toTaskLock } from "./mappers.js";
import { resolveTaskAssignmentState, type TaskAssignmentPatch } from "./task-assignment.js";
import type { CoordinationDecision, CoordinationEvent, CoordinationEventRow, StaleTaskPromptMute, StaleTaskPromptMuteRow, Task, TaskLease, TaskLeaseKind, TaskLeaseRow, TaskLeaseStatus, TaskLock, TaskLockReason, TaskLockRow, TaskLockScope, TaskRow, TaskStatus, TaskWorkLeaseActionConflict } from "./types.js";

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

export async function createTaskLease(input: {
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  agent_key: string;
  actor_label: string;
  created_by: string;
  agent_instance_id?: string | null;
  agent_session_id?: string | null;
  branch_ref?: string | null;
  pr_url?: string | null;
  output_intent?: string | null;
  expires_at?: string | null;
}): Promise<TaskLease> {
  const now = new Date().toISOString();
  await expireStaleTaskLeases(input.room_id, new Date(now));
  const row: TaskLeaseRow = {
    id: coordinationId("tl"),
    room_id: input.room_id,
    task_id: input.task_id,
    kind: input.kind,
    status: "active",
    agent_key: input.agent_key,
    agent_instance_id: input.agent_instance_id ?? null,
    agent_session_id: input.agent_session_id ?? null,
    actor_label: input.actor_label,
    branch_ref: input.branch_ref ?? null,
    pr_url: input.pr_url ?? null,
    output_intent: input.output_intent ?? null,
    expires_at: input.expires_at ?? null,
    last_heartbeat_at: now,
    revoked_reason: null,
    created_by: input.created_by,
    created_at: now,
    updated_at: now,
  };

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

export async function upsertStaleTaskPromptMute(input: {
  room_id: string;
  task_id: string;
  task_updated_at: string;
  muted_by: string;
}): Promise<StaleTaskPromptMute> {
  const now = new Date().toISOString();
  const [row] = (await db
    .insert(stale_task_prompt_mutes)
    .values({
      room_id: input.room_id,
      task_id: input.task_id,
      task_updated_at: input.task_updated_at,
      muted_by: input.muted_by,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [stale_task_prompt_mutes.room_id, stale_task_prompt_mutes.task_id],
      set: {
        task_updated_at: input.task_updated_at,
        muted_by: input.muted_by,
        updated_at: now,
      },
    })
    .returning()) as StaleTaskPromptMuteRow[];

  return toStaleTaskPromptMute(row);
}

export async function getStaleTaskPromptMutes(
  roomId: string,
  taskIds?: readonly string[]
): Promise<StaleTaskPromptMute[]> {
  const conditions = [eq(stale_task_prompt_mutes.room_id, roomId)];
  if (taskIds && taskIds.length > 0) {
    conditions.push(inArray(stale_task_prompt_mutes.task_id, [...taskIds]));
  }

  const rows = (await db
    .select()
    .from(stale_task_prompt_mutes)
    .where(and(...conditions))
    .orderBy(asc(stale_task_prompt_mutes.updated_at))) as StaleTaskPromptMuteRow[];

  return rows.map(toStaleTaskPromptMute);
}

export async function clearStaleTaskPromptMute(
  roomId: string,
  taskId: string
): Promise<boolean> {
  const deleted = await db
    .delete(stale_task_prompt_mutes)
    .where(and(eq(stale_task_prompt_mutes.room_id, roomId), eq(stale_task_prompt_mutes.task_id, taskId)))
    .returning({ task_id: stale_task_prompt_mutes.task_id });

  return deleted.length > 0;
}

export async function revokeTaskLease(
  roomId: string,
  leaseId: string,
  revokedReason: string
): Promise<TaskLease | null> {
  const now = new Date().toISOString();
  await db
    .update(task_leases)
    .set({
      status: "revoked",
      revoked_reason: revokedReason,
      updated_at: now,
    })
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)));

  const [row] = (await db
    .select()
    .from(task_leases)
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)))
    .limit(1)) as TaskLeaseRow[];

  return row ? toTaskLease(row) : null;
}

export async function releaseTaskLease(
  roomId: string,
  leaseId: string
): Promise<TaskLease | null> {
  const now = new Date().toISOString();
  await db
    .update(task_leases)
    .set({
      status: "released",
      updated_at: now,
    })
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)));

  const [row] = (await db
    .select()
    .from(task_leases)
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)))
    .limit(1)) as TaskLeaseRow[];

  return row ? toTaskLease(row) : null;
}

export async function applyTaskWorkLeaseAction(input: {
  room_id: string;
  task_id: string;
  active_lease_id: string;
  disposition_status: "released" | "revoked";
  disposition_reason?: string | null;
  task_updates: TaskAssignmentPatch;
  new_lease?: {
    agent_key: string;
    actor_label: string;
    created_by: string;
    agent_instance_id?: string | null;
    agent_session_id?: string | null;
    branch_ref?: string | null;
    pr_url?: string | null;
    output_intent?: string | null;
    expires_at?: string | null;
  } | null;
}): Promise<{
  task: Task | null;
  released_lease: TaskLease | null;
  new_lease: TaskLease | null;
  conflict: TaskWorkLeaseActionConflict | null;
}> {
  const taskNumber = parseScopedId(input.task_id, "task");
  if (!taskNumber) {
    return {
      task: null,
      released_lease: null,
      new_lease: null,
      conflict: "task_not_found",
    };
  }

  const now = new Date().toISOString();
  const deliveryFreshCutoff = new Date(
    Date.parse(now) - ACTIVE_AGENT_DELIVERY_WINDOW_MS
  ).toISOString();
  return db.transaction(async (tx) => {
    const [taskRow] = (await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.room_id, input.room_id), eq(tasks.number, taskNumber)))
      .limit(1)) as TaskRow[];

    if (!taskRow) {
      return {
        task: null,
        released_lease: null,
        new_lease: null,
        conflict: "task_not_found" as const,
      };
    }

    if (input.new_lease?.agent_session_id) {
      const [reachableTargetDeliveryRow] = await tx
        .update(room_agent_delivery_sessions)
        .set({
          updated_at: sql`${room_agent_delivery_sessions.updated_at}`,
        })
        .where(
          and(
            eq(room_agent_delivery_sessions.room_id, input.room_id),
            eq(room_agent_delivery_sessions.agent_session_id, input.new_lease.agent_session_id),
            eq(room_agent_delivery_sessions.session_kind, "worker" as RoomAgentSessionKind),
            or(
              and(
                sql`${room_agent_delivery_sessions.active_connection_count} > 0`,
                sql`${room_agent_delivery_sessions.updated_at} >= ${deliveryFreshCutoff}::timestamptz`
              ),
              sql`${room_agent_delivery_sessions.reconnect_grace_expires_at} >= ${now}::timestamptz`
            )
          )
        )
        .returning({ delivery_key: room_agent_delivery_sessions.delivery_key });

      if (!reachableTargetDeliveryRow) {
        return {
          task: null,
          released_lease: null,
          new_lease: null,
          conflict: "target_unreachable" as const,
        };
      }
    }

    await tx
      .update(task_leases)
      .set({
        status: "expired",
        updated_at: now,
      })
      .where(
        and(
          eq(task_leases.room_id, input.room_id),
          eq(task_leases.status, "active" as TaskLeaseStatus),
          sql`${task_leases.expires_at} IS NOT NULL`,
          lte(task_leases.expires_at, now)
        )
      );

    const [releasedLeaseRow] = (await tx
      .update(task_leases)
      .set({
        status: input.disposition_status,
        revoked_reason: input.disposition_status === "revoked"
          ? input.disposition_reason ?? null
          : null,
        updated_at: now,
      })
      .where(
        and(
          eq(task_leases.room_id, input.room_id),
          eq(task_leases.task_id, input.task_id),
          eq(task_leases.id, input.active_lease_id),
          eq(task_leases.kind, "work" as TaskLeaseKind),
          eq(task_leases.status, "active" as TaskLeaseStatus),
          sql`(${task_leases.expires_at} IS NULL OR ${task_leases.expires_at} > ${now})`
        )
      )
      .returning()) as TaskLeaseRow[];

    if (!releasedLeaseRow) {
      return {
        task: null,
        released_lease: null,
        new_lease: null,
        conflict: "lease_not_active" as const,
      };
    }

    const assignment = resolveTaskAssignmentState(taskRow, input.task_updates);

    const [updatedTaskRow] = (await tx
      .update(tasks)
      .set({
        status: assignment.status,
        assignee: assignment.assignee,
        assignee_agent_key: assignment.assignee_agent_key,
        updated_at: now,
      })
      .where(and(eq(tasks.room_id, input.room_id), eq(tasks.number, taskNumber)))
      .returning()) as TaskRow[];

    if (!updatedTaskRow) {
      return {
        task: null,
        released_lease: null,
        new_lease: null,
        conflict: "task_not_found" as const,
      };
    }

    let newLeaseRow: TaskLeaseRow | null = null;
    if (input.new_lease) {
      const row: TaskLeaseRow = {
        id: coordinationId("tl"),
        room_id: input.room_id,
        task_id: input.task_id,
        kind: "work",
        status: "active",
        agent_key: input.new_lease.agent_key,
        agent_instance_id: input.new_lease.agent_instance_id ?? null,
        agent_session_id: input.new_lease.agent_session_id ?? null,
        actor_label: input.new_lease.actor_label,
        branch_ref: input.new_lease.branch_ref ?? null,
        pr_url: input.new_lease.pr_url ?? null,
        output_intent: input.new_lease.output_intent ?? null,
        expires_at: input.new_lease.expires_at ?? null,
        last_heartbeat_at: now,
        revoked_reason: null,
        created_by: input.new_lease.created_by,
        created_at: now,
        updated_at: now,
      };
      const [createdLeaseRow] = (await tx
        .insert(task_leases)
        .values(row)
        .returning()) as TaskLeaseRow[];
      newLeaseRow = createdLeaseRow ?? null;
    }

    return {
      task: toTask(updatedTaskRow),
      released_lease: toTaskLease(releasedLeaseRow),
      new_lease: newLeaseRow ? toTaskLease(newLeaseRow) : null,
      conflict: null,
    };
  });
}

export async function updateTaskLeaseWorkflowRefs(
  roomId: string,
  leaseId: string,
  updates: {
    branch_ref?: string | null;
    pr_url?: string | null;
  }
): Promise<TaskLease | null> {
  const now = new Date().toISOString();
  const patch: {
    branch_ref?: string | null;
    pr_url?: string | null;
    updated_at: string;
  } = {
    updated_at: now,
  };
  if (Object.prototype.hasOwnProperty.call(updates, "branch_ref")) {
    patch.branch_ref = updates.branch_ref ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "pr_url")) {
    patch.pr_url = updates.pr_url ?? null;
  }

  await db
    .update(task_leases)
    .set(patch)
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)));

  const [row] = (await db
    .select()
    .from(task_leases)
    .where(and(eq(task_leases.room_id, roomId), eq(task_leases.id, leaseId)))
    .limit(1)) as TaskLeaseRow[];

  return row ? toTaskLease(row) : null;
}

export async function createTaskLock(input: {
  room_id: string;
  scope: TaskLockScope;
  reason: TaskLockReason;
  created_by: string;
  task_id?: string | null;
  message?: string | null;
}): Promise<TaskLock> {
  const now = new Date().toISOString();
  const row: TaskLockRow = {
    id: coordinationId("lock"),
    room_id: input.room_id,
    task_id: input.task_id ?? null,
    scope: input.scope,
    reason: input.reason,
    message: input.message ?? null,
    created_by: input.created_by,
    created_at: now,
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
  const now = new Date().toISOString();
  await db
    .update(task_locks)
    .set({
      cleared_by: clearedBy,
      cleared_at: now,
    })
    .where(and(eq(task_locks.room_id, roomId), eq(task_locks.id, lockId)));

  const [row] = (await db
    .select()
    .from(task_locks)
    .where(and(eq(task_locks.room_id, roomId), eq(task_locks.id, lockId)))
    .limit(1)) as TaskLockRow[];

  return row ? toTaskLock(row) : null;
}

export async function createCoordinationEvent(input: {
  room_id: string;
  event_type: string;
  decision?: CoordinationDecision;
  task_id?: string | null;
  lease_id?: string | null;
  lock_id?: string | null;
  actor_label?: string | null;
  actor_key?: string | null;
  actor_instance_id?: string | null;
  reason?: string | null;
  metadata?: CoordinationEventMetadata | null;
}): Promise<CoordinationEvent> {
  const row: CoordinationEventRow = {
    id: coordinationId("ce"),
    room_id: input.room_id,
    task_id: input.task_id ?? null,
    lease_id: input.lease_id ?? null,
    lock_id: input.lock_id ?? null,
    event_type: input.event_type,
    decision: input.decision ?? "record",
    actor_label: input.actor_label ?? null,
    actor_key: input.actor_key ?? null,
    actor_instance_id: input.actor_instance_id ?? null,
    reason: input.reason ?? null,
    metadata: input.metadata ?? null,
    created_at: new Date().toISOString(),
  };

  await db.insert(coordination_events).values(row);
  return toCoordinationEvent(row);
}
