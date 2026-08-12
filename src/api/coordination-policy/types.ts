import type {
  TaskLeaseKind,
  TaskLeaseStatus,
  TaskLockReason,
  TaskLockScope,
} from "../db.js";
import type { TaskWorkflowArtifact } from "../repo-workflow.js";

export interface CoordinationActor {
  actorLabel: string | null;
  agentKey: string | null;
  agentInstanceId?: string | null;
  agentSessionId?: string | null;
}

export interface CoordinationLeaseLike {
  id: string;
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  status: TaskLeaseStatus;
  // Monotonic rebind fence (plan §4.5). Present on every persisted lease
  // (default 0). A lease-authorized write captures this and re-validates it
  // under the shared advisory lock so a rebind that advances it invalidates a
  // stale predecessor's in-flight write.
  epoch: number;
  agent_key: string;
  agent_instance_id: string | null;
  agent_session_id?: string | null;
  actor_label: string;
  branch_ref?: string | null;
  pr_url?: string | null;
  output_intent?: string | null;
  expires_at: string | null;
}

export interface CoordinationLockLike {
  id: string;
  room_id: string;
  task_id: string | null;
  scope: TaskLockScope;
  reason: TaskLockReason;
  message: string | null;
  cleared_at: string | null;
}

export interface CoordinationTaskLike {
  id: string;
  room_id: string;
  status?: string | null;
  source_message_id?: string | null;
  pr_url?: string | null;
  workflow_artifacts?: readonly TaskWorkflowArtifact[] | null;
}

export interface CoordinationFocusRoomLike {
  room_id: string;
  focus_key: string | null;
  source_task_id: string | null;
  focus_status: string | null;
}

export interface CoordinationWorkIntent {
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
  branchRef?: string | null;
  prUrl?: string | null;
  outputIntent?: string | null;
  workflowArtifacts?: readonly TaskWorkflowArtifact[] | null;
}

export type CoordinationDuplicateReason =
  | "source_message"
  | "source_task"
  | "focus_room"
  | "pr_url"
  | "workflow_artifact"
  | "lease_branch_ref"
  | "lease_pr_url"
  | "lease_output_intent";

export interface CoordinationDuplicateMatch {
  reason: CoordinationDuplicateReason;
  taskId: string;
  value: string;
  task?: CoordinationTaskLike;
  lease?: CoordinationLeaseLike;
  focusRoom?: CoordinationFocusRoomLike;
  artifact?: TaskWorkflowArtifact;
}

export type CoordinationAdmissionResult =
  | {
      kind: "allow";
      reason: "no_duplicate";
    }
  | {
      kind: "route_to_review";
      reason: string;
      duplicate: CoordinationDuplicateMatch;
    };

export type ReviewLeaseRoutingResult =
  | {
      kind: "allow";
      activeWorkLease: CoordinationLeaseLike | null;
      existingReviewLease: CoordinationLeaseLike | null;
    }
  | {
      kind: "deny";
      code: "missing_actor" | "unassigned_reviewer" | "work_lease_holder";
      reason: string;
      lease?: CoordinationLeaseLike;
    };

export type CoordinationMutationKind =
  | "task_admit"
  | "task_claim"
  | "task_update"
  | "task_complete"
  | "focus_room_open"
  | "focus_room_conclude"
  | "workflow_artifact_attach"
  | "webhook_projection";

export type CoordinationDecisionResult =
  | {
      kind: "allow";
      lease: CoordinationLeaseLike;
    }
  | {
      kind: "deny";
      code:
        | "active_lock"
        | "missing_actor"
        | "missing_lease"
        | "wrong_lease_kind"
        | "wrong_actor"
        | "wrong_workflow_artifact";
      reason: string;
      lock?: CoordinationLockLike;
      lease?: CoordinationLeaseLike;
    };
