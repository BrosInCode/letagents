export interface DesktopTaskSummary {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  assigneeAgentKey: string | null;
  createdBy: string | null;
  prUrl: string | null;
  workflowArtifacts: Array<{
    provider: string;
    kind: string;
    id: string | null;
    number: number | null;
    title: string | null;
    url: string | null;
    ref: string | null;
    state: string | null;
  }>;
  workflowRefs: Array<{
    provider: string;
    kind: string;
    label: string;
    url: string;
  }>;
  activeLeases: Array<{
    id: string;
    kind: "work" | "review" | string;
    holderLabel: string | null;
    agentKey: string | null;
    agentSessionId: string | null;
    status: string;
    updatedAt: string | null;
  }>;
  activeLocks: Array<{
    id: string;
    scope: "room" | "task" | string;
    reason: string | null;
    message: string | null;
    createdBy: string | null;
  }>;
  stalePromptState: {
    isStale: boolean;
    reason: string | null;
    staleForMs: number | null;
    muted: boolean;
    mutedBy: string | null;
    mutedAt: string | null;
  } | null;
  createdAt: string | null;
  updatedAt: string;
}

export interface DesktopTaskMutationResult {
  task: DesktopTaskSummary;
}

export interface DesktopTaskLeaseActionInput {
  action: "release" | "handoff";
  lease_id?: string | null;
  target_actor_key?: string | null;
  target_actor_instance_id?: string | null;
  target_agent_session_id?: string | null;
  reason?: string | null;
}

export interface DesktopTaskReviewLeaseActionInput {
  action: "assign" | "claim" | "release";
  lease_id?: string | null;
  target_actor_key?: string | null;
  target_actor_instance_id?: string | null;
  target_agent_session_id?: string | null;
  reason?: string | null;
}

export interface DesktopTaskWorkerActionInput {
  action: "claim" | "start" | "block" | "resume" | "submit_review";
  reason?: string | null;
}

export interface DesktopTaskReviewWorkerActionInput {
  action: "claim" | "release";
  lease_id?: string | null;
  reason?: string | null;
}
