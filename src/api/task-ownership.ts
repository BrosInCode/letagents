import type { TaskStatus } from "./db.js";
import type { TaskWorkflowArtifact } from "./repo-workflow.js";

type RequestAuthKind = "session" | "owner_token" | null | undefined;

const AGENT_OWNED_TASK_STATUSES = new Set<TaskStatus>([
  "assigned",
  "in_progress",
  "blocked",
  "in_review",
]);

export function normalizeTaskActorLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeTaskActorKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeTaskActorInstanceId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function buildTaskUpdatePatch(input: {
  body: Record<string, unknown>;
  workflowArtifacts?: TaskWorkflowArtifact[];
}): {
  updates: {
    status?: TaskStatus;
    assignee?: string | null;
    assignee_agent_key?: string | null;
    pr_url?: string;
    workflow_artifacts?: TaskWorkflowArtifact[];
  };
  actorLabel: string | null;
  actorKey: string | null;
} {
  const { body, workflowArtifacts } = input;
  const updates: {
    status?: TaskStatus;
    assignee?: string | null;
    assignee_agent_key?: string | null;
    pr_url?: string;
    workflow_artifacts?: TaskWorkflowArtifact[];
  } = {};

  if (typeof body.status === "string") {
    updates.status = body.status as TaskStatus;
  }

  if (Object.prototype.hasOwnProperty.call(body, "assignee")) {
    if (body.assignee === null || body.assignee === undefined || body.assignee === "") {
      updates.assignee = null;
    } else if (typeof body.assignee === "string") {
      updates.assignee = body.assignee.trim() || null;
    } else {
      throw new Error("assignee must be a string or null");
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "assignee_agent_key")) {
    if (
      body.assignee_agent_key === null ||
      body.assignee_agent_key === undefined ||
      body.assignee_agent_key === ""
    ) {
      updates.assignee_agent_key = null;
    } else if (typeof body.assignee_agent_key === "string") {
      updates.assignee_agent_key = body.assignee_agent_key.trim() || null;
    } else {
      throw new Error("assignee_agent_key must be a string or null");
    }
  }

  if (typeof body.pr_url === "string") {
    updates.pr_url = body.pr_url;
  }

  if (Object.prototype.hasOwnProperty.call(body, "workflow_artifacts")) {
    updates.workflow_artifacts = workflowArtifacts ?? [];
  }

  return {
    updates,
    actorLabel: normalizeTaskActorLabel(body.actor_label),
    actorKey: normalizeTaskActorKey(body.actor_key),
  };
}

export function requiresTaskOwnershipGuard(input: {
  authKind: RequestAuthKind;
  requestedStatus?: TaskStatus;
  requestedAssignee?: string | null;
  requestedAssigneeAgentKey?: string | null;
}): boolean {
  const { authKind, requestedStatus, requestedAssignee, requestedAssigneeAgentKey } = input;
  if (authKind !== "owner_token") {
    return false;
  }

  return Boolean(
    (requestedStatus && AGENT_OWNED_TASK_STATUSES.has(requestedStatus)) ||
      requestedAssignee !== undefined ||
      requestedAssigneeAgentKey !== undefined
  );
}

export function evaluateTaskOwnership(input: {
  authKind: RequestAuthKind;
  currentStatus: TaskStatus;
  currentAssignee: string | null;
  currentAssigneeAgentKey: string | null;
  requestedStatus?: TaskStatus;
  requestedAssignee?: string | null;
  requestedAssigneeAgentKey?: string | null;
  actorLabel?: string | null;
  actorKey?: string | null;
}):
  | {
      kind: "allow";
      assigneeAgentKey?: string | null;
    }
  | {
      kind: "deny";
      error: string;
    } {
  const {
    authKind,
    currentAssignee,
    currentAssigneeAgentKey,
    requestedStatus,
    requestedAssignee,
    requestedAssigneeAgentKey,
    actorLabel,
    actorKey,
  } = input;

  if (
    !requiresTaskOwnershipGuard({
      authKind,
      requestedStatus,
      requestedAssignee,
      requestedAssigneeAgentKey,
    })
  ) {
    return { kind: "allow" };
  }

  const normalizedActorLabel = normalizeTaskActorLabel(actorLabel);
  if (!normalizedActorLabel) {
    return { kind: "deny", error: "actor_label is required for agent-owned task transitions" };
  }

  const normalizedActorKey = normalizeTaskActorKey(actorKey);
  if (!normalizedActorKey) {
    return { kind: "deny", error: "actor_key is required for agent-owned task transitions" };
  }

  if (requestedStatus === "assigned") {
    if (
      normalizeTaskActorLabel(requestedAssignee) !== normalizedActorLabel ||
      normalizeTaskActorKey(requestedAssigneeAgentKey) !== normalizedActorKey
    ) {
      return {
        kind: "deny",
        error: "Agents can only claim tasks for themselves",
      };
    }

    return {
      kind: "allow",
      assigneeAgentKey: normalizedActorKey,
    };
  }

  if (requestedAssignee !== undefined || requestedAssigneeAgentKey !== undefined) {
    return {
      kind: "deny",
      error: "Agents cannot reassign a task after claim",
    };
  }

  if (normalizeTaskActorKey(currentAssigneeAgentKey) === normalizedActorKey) {
    return { kind: "allow" };
  }

  if (
    !currentAssigneeAgentKey &&
    normalizeTaskActorLabel(currentAssignee) === normalizedActorLabel
  ) {
    return {
      kind: "allow",
      assigneeAgentKey: normalizedActorKey,
    };
  }

  return {
    kind: "deny",
    error: `Only the assigned agent can move this task to ${requestedStatus}`,
  };
}

export function getTaskOwnershipError(
  input: Parameters<typeof evaluateTaskOwnership>[0]
): string | null {
  const decision = evaluateTaskOwnership(input);
  return decision.kind === "deny" ? decision.error : null;
}
