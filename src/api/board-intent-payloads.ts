export interface BoardIntentPayload {
  [key: string]: unknown;
}

export function boardIntentPayloadForTaskCreate(input: {
  title: string;
  description?: string | null;
  sourceMessageId?: string | null;
}): BoardIntentPayload {
  return {
    title: input.title.trim(),
    description: input.description?.trim() || null,
    source_message_id: input.sourceMessageId?.trim() || null,
  };
}

export function boardIntentPayloadForTaskMutation(input: {
  taskId: string;
  status?: string | null;
  assignee?: string | null;
  assigneeAgentKey?: string | null;
  prUrl?: string | null;
}): BoardIntentPayload {
  return {
    task_id: input.taskId,
    status: input.status ?? null,
    assignee: input.assignee ?? null,
    assignee_agent_key: input.assigneeAgentKey ?? null,
    pr_url: input.prUrl ?? null,
  };
}

export function boardIntentPayloadForLeaseAction(input: {
  taskId: string;
  action: "release" | "handoff";
  leaseId?: string | null;
  targetActorKey?: string | null;
  targetAgentSessionId?: string | null;
}): BoardIntentPayload {
  return {
    task_id: input.taskId,
    action: input.action,
    lease_id: input.leaseId ?? null,
    target_actor_key: input.targetActorKey ?? null,
    target_agent_session_id: input.targetAgentSessionId ?? null,
  };
}
