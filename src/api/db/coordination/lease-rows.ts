import type { TaskLeaseKind, TaskLeaseRow } from "../types.js";
import { coordinationId } from "../utils.js";

export type CreateTaskLeaseRowInput = {
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
};

export function createTaskLeaseRow(
  input: CreateTaskLeaseRowInput,
  now: string
): TaskLeaseRow {
  return {
    id: coordinationId("tl"),
    room_id: input.room_id,
    task_id: input.task_id,
    kind: input.kind,
    status: "active",
    agent_key: input.agent_key,
    agent_instance_id: input.agent_instance_id ?? null,
    agent_session_id: input.agent_session_id ?? null,
    actor_label: input.actor_label,
    epoch: 0,
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
}
