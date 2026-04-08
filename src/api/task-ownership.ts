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

export function buildTaskUpdatePatch(input: {
  body: Record<string, unknown>;
  workflowArtifacts?: TaskWorkflowArtifact[];
}): {
  updates: {
    status?: TaskStatus;
    assignee?: string | null;
    pr_url?: string;
    workflow_artifacts?: TaskWorkflowArtifact[];
  };
  actorLabel: string | null;
} {
  const { body, workflowArtifacts } = input;
  const updates: {
    status?: TaskStatus;
    assignee?: string | null;
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

  if (typeof body.pr_url === "string") {
    updates.pr_url = body.pr_url;
  }

  if (Object.prototype.hasOwnProperty.call(body, "workflow_artifacts")) {
    updates.workflow_artifacts = workflowArtifacts ?? [];
  }

  return {
    updates,
    actorLabel: normalizeTaskActorLabel(body.actor_label),
  };
}

export function getTaskOwnershipError(input: {
  authKind: RequestAuthKind;
  currentStatus: TaskStatus;
  currentAssignee: string | null;
  requestedStatus?: TaskStatus;
  requestedAssignee?: string | null;
  actorLabel?: string | null;
}): string | null {
  const {
    authKind,
    currentAssignee,
    requestedStatus,
    requestedAssignee,
    actorLabel,
  } = input;

  if (authKind !== "owner_token" || !requestedStatus || !AGENT_OWNED_TASK_STATUSES.has(requestedStatus)) {
    return null;
  }

  const normalizedActorLabel = normalizeTaskActorLabel(actorLabel);
  if (!normalizedActorLabel) {
    return "actor_label is required for agent-owned task transitions";
  }

  if (requestedStatus === "assigned") {
    if (normalizeTaskActorLabel(requestedAssignee) !== normalizedActorLabel) {
      return "Agents can only claim tasks for themselves";
    }
    return null;
  }

  if (normalizeTaskActorLabel(currentAssignee) !== normalizedActorLabel) {
    return `Only the assigned agent can move this task to ${requestedStatus}`;
  }

  const normalizedRequestedAssignee = normalizeTaskActorLabel(requestedAssignee);
  if (normalizedRequestedAssignee && normalizedRequestedAssignee !== normalizedActorLabel) {
    return `Agents cannot reassign a task while moving it to ${requestedStatus}`;
  }

  return null;
}
