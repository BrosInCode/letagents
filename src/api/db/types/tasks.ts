import type { CoordinationEventMetadata } from "../schema.js";
import type { TaskWorkflowArtifact, TaskWorkflowRef } from "../../repo-workflow.js";

export type TaskStatus =
  | "proposed"
  | "accepted"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "merged"
  | "done"
  | "cancelled";

export type TaskLeaseKind = "work" | "review";

export type TaskLeaseStatus = "active" | "released" | "revoked" | "expired";

export type TaskLockScope = "room" | "task";

export type TaskLockReason = "human_stop" | "duplicate" | "manager_pause" | "revoked" | "policy";

export type CoordinationDecision = "allow" | "deny" | "record";

export interface Task {
  id: string;
  room_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  assignee_agent_key: string | null;
  created_by: string;
  source_message_id: string | null;
  pr_url: string | null;
  workflow_artifacts: TaskWorkflowArtifact[];
  workflow_refs: TaskWorkflowRef[];
  created_at: string;
  updated_at: string;
  stale_prompt_state?: TaskStalePromptState | null;
  active_leases?: TaskLease[];
  active_locks?: TaskLock[];
}

export interface TaskStalePromptState {
  is_stale: boolean;
  reason: string | null;
  stale_for_ms: number | null;
  muted: boolean;
  muted_by: string | null;
  muted_at: string | null;
}

export interface TaskLease {
  id: string;
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  status: TaskLeaseStatus;
  agent_key: string;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  actor_label: string;
  branch_ref: string | null;
  pr_url: string | null;
  output_intent: string | null;
  expires_at: string | null;
  last_heartbeat_at: string | null;
  revoked_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TaskLock {
  id: string;
  room_id: string;
  task_id: string | null;
  scope: TaskLockScope;
  reason: TaskLockReason;
  message: string | null;
  created_by: string;
  created_at: string;
  cleared_by: string | null;
  cleared_at: string | null;
}

export interface StaleTaskPromptMute {
  room_id: string;
  task_id: string;
  task_updated_at: string;
  muted_by: string;
  created_at: string;
  updated_at: string;
}

export interface CoordinationEvent {
  id: string;
  room_id: string;
  task_id: string | null;
  lease_id: string | null;
  lock_id: string | null;
  event_type: string;
  decision: CoordinationDecision;
  actor_label: string | null;
  actor_key: string | null;
  actor_instance_id: string | null;
  reason: string | null;
  metadata: CoordinationEventMetadata | null;
  created_at: string;
}

export interface TaskOwnershipState {
  status: TaskStatus;
  assignee: string | null;
  assignee_agent_key: string | null;
}

export type TaskWorkLeaseActionConflict = "task_not_found" | "lease_not_active" | "target_unreachable";

export interface TaskRow {
  room_id: string;
  number: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  assignee_agent_key: string | null;
  created_by: string;
  source_message_id: string | null;
  pr_url: string | null;
  workflow_artifacts: TaskWorkflowArtifact[];
  created_at: string;
  updated_at: string;
}

export interface TaskLeaseRow {
  id: string;
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  status: TaskLeaseStatus;
  agent_key: string;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  actor_label: string;
  branch_ref: string | null;
  pr_url: string | null;
  output_intent: string | null;
  expires_at: string | null;
  last_heartbeat_at: string | null;
  revoked_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface StaleTaskPromptMuteRow {
  room_id: string;
  task_id: string;
  task_updated_at: string;
  muted_by: string;
  created_at: string;
  updated_at: string;
}

export interface TaskLockRow {
  id: string;
  room_id: string;
  task_id: string | null;
  scope: TaskLockScope;
  reason: TaskLockReason;
  message: string | null;
  created_by: string;
  created_at: string;
  cleared_by: string | null;
  cleared_at: string | null;
}

export interface CoordinationEventRow {
  id: string;
  room_id: string;
  task_id: string | null;
  lease_id: string | null;
  lock_id: string | null;
  event_type: string;
  decision: CoordinationDecision;
  actor_label: string | null;
  actor_key: string | null;
  actor_instance_id: string | null;
  reason: string | null;
  metadata: CoordinationEventMetadata | null;
  created_at: string;
}
