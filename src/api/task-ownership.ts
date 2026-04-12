import { parseAgentActorLabel } from "../shared/agent-identity.js";
import type { AgentIdentity, TaskStatus } from "./db.js";
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

function normalizeTaskIdentityPart(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized || null;
}

function getOwnerLabelFromAttribution(ownerAttribution: string | null | undefined): string | null {
  const normalized = normalizeTaskIdentityPart(ownerAttribution);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(.+?)(?:'s|s')?\s+agent$/i);
  return match?.[1]?.trim() || normalized;
}

function filterOwnerAgentMatches(input: {
  ownerAgents: Array<Pick<AgentIdentity, "canonical_key" | "name" | "display_name" | "owner_label">>;
  matchField: "display_name" | "name";
  actorDisplayName: string;
  ownerLabel: string | null;
}): Array<Pick<AgentIdentity, "canonical_key" | "name" | "display_name" | "owner_label">> {
  const { ownerAgents, matchField, actorDisplayName, ownerLabel } = input;

  return ownerAgents.filter((agent) => {
    if (normalizeTaskIdentityPart(agent[matchField]) !== actorDisplayName) {
      return false;
    }

    if (!ownerLabel) {
      return true;
    }

    return normalizeTaskIdentityPart(agent.owner_label) === ownerLabel;
  });
}

export function inferTaskActorKeyFromOwnerAgents(input: {
  actorLabel?: string | null;
  ownerAgents: Array<Pick<AgentIdentity, "canonical_key" | "name" | "display_name" | "owner_label">>;
}): string | null {
  const parsed = parseAgentActorLabel(input.actorLabel);
  const actorDisplayName = normalizeTaskIdentityPart(parsed?.display_name);
  if (!actorDisplayName) {
    return null;
  }

  const ownerLabel = getOwnerLabelFromAttribution(parsed?.owner_attribution);
  const displayNameMatches = filterOwnerAgentMatches({
    ownerAgents: input.ownerAgents,
    matchField: "display_name",
    actorDisplayName,
    ownerLabel,
  });
  if (displayNameMatches.length === 1) {
    return displayNameMatches[0].canonical_key;
  }
  if (displayNameMatches.length > 1) {
    return null;
  }

  const nameMatches = filterOwnerAgentMatches({
    ownerAgents: input.ownerAgents,
    matchField: "name",
    actorDisplayName,
    ownerLabel,
  });
  return nameMatches.length === 1 ? nameMatches[0].canonical_key : null;
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
