import { and, eq, lte, or, sql } from "drizzle-orm";

import {
  ACTIVE_AGENT_DELIVERY_WINDOW_MS,
  type RoomAgentSessionKind,
} from "../../../shared/agent-presence.js";
import { db } from "../client.js";
import { room_agent_delivery_sessions, task_leases, tasks } from "../schema.js";
import { toTask, toTaskLease } from "../mappers.js";
import {
  resolveTaskAssignmentState,
  type TaskAssignmentPatch,
} from "../task-assignment.js";
import type {
  Task,
  TaskLease,
  TaskLeaseKind,
  TaskLeaseRow,
  TaskLeaseStatus,
  TaskRow,
  TaskWorkLeaseActionConflict,
} from "../types.js";
import { parseScopedId } from "../utils.js";
import { createTaskLeaseRow } from "./lease-rows.js";

type TaskWorkLeaseActionResult = {
  task: Task | null;
  released_lease: TaskLease | null;
  new_lease: TaskLease | null;
  conflict: TaskWorkLeaseActionConflict | null;
};

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
}): Promise<TaskWorkLeaseActionResult> {
  const taskNumber = parseScopedId(input.task_id, "task");
  if (!taskNumber) {
    return actionConflict("task_not_found");
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
      return actionConflict("task_not_found");
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
        return actionConflict("target_unreachable");
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
      return actionConflict("lease_not_active");
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
      return actionConflict("task_not_found");
    }

    let newLeaseRow: TaskLeaseRow | null = null;
    if (input.new_lease) {
      const row = createTaskLeaseRow(
        {
          ...input.new_lease,
          room_id: input.room_id,
          task_id: input.task_id,
          kind: "work",
        },
        now
      );
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

function actionConflict(conflict: TaskWorkLeaseActionConflict): TaskWorkLeaseActionResult {
  return {
    task: null,
    released_lease: null,
    new_lease: null,
    conflict,
  };
}
