import type {
  DesktopTaskLeaseActionInput,
  DesktopTaskMutationResult,
  DesktopTaskReviewLeaseActionInput,
  DesktopTaskReviewWorkerActionInput,
  DesktopTaskWorkerActionInput,
  DesktopTaskSummary,
} from "../../ipc-types.js";
import {
  buildReviewWorkerActionBody,
  buildWorkerActionPatch,
  getCurrentLocalWorkerSession,
  readLetAgentsLocalState,
} from "../../board-task-actions.js";
import { apiFetch } from "../auth.js";
import { letagentsLocalStatePath } from "../paths.js";

export function mapDesktopTaskSummaryPayload(task: {
  id: string;
  title?: string;
  description?: string | null;
  status?: string;
  assignee?: string | null;
  assignee_agent_key?: string | null;
  created_by?: string | null;
  pr_url?: string | null;
  workflow_artifacts?: Array<{
    provider?: string | null;
    kind?: string | null;
    id?: string | null;
    number?: number | null;
    title?: string | null;
    url?: string | null;
    ref?: string | null;
    state?: string | null;
  }> | null;
  workflow_refs?: Array<{
    provider?: string;
    kind?: string;
    label?: string;
    url?: string;
  }> | null;
  active_leases?: Array<{
    id?: string;
    kind?: string;
    holder_label?: string | null;
    agent_label?: string | null;
    agent_key?: string | null;
    agent_session_id?: string | null;
    status?: string;
    updated_at?: string | null;
  }> | null;
  active_locks?: Array<{
    id?: string;
    scope?: string;
    reason?: string | null;
    message?: string | null;
    created_by?: string | null;
  }> | null;
  stale_prompt_state?: {
    is_stale?: boolean | null;
    reason?: string | null;
    stale_for_ms?: number | null;
    muted?: boolean | null;
    muted_by?: string | null;
    muted_at?: string | null;
  } | null;
  created_at?: string | null;
  updated_at?: string;
  updatedAt?: string;
}): DesktopTaskSummary {
  return {
    id: task.id,
    title: task.title || task.id,
    description: task.description || null,
    status: task.status || "proposed",
    assignee: task.assignee || null,
    assigneeAgentKey: task.assignee_agent_key || null,
    createdBy: task.created_by || null,
    prUrl: task.pr_url || null,
    workflowArtifacts: (task.workflow_artifacts || []).map((artifact) => ({
      provider: artifact.provider || "unknown",
      kind: artifact.kind || "artifact",
      id: artifact.id || null,
      number: artifact.number ?? null,
      title: artifact.title || null,
      url: artifact.url || null,
      ref: artifact.ref || null,
      state: artifact.state || null,
    })),
    workflowRefs: (task.workflow_refs || [])
      .map((ref) => ({
        provider: ref.provider || "unknown",
        kind: ref.kind || "artifact",
        label: ref.label || ref.url || "Workflow",
        url: ref.url || "",
      }))
      .filter((ref) => Boolean(ref.url)),
    activeLeases: (task.active_leases || [])
      .map((lease) => ({
        id: lease.id || "",
        kind: lease.kind || "work",
        holderLabel: lease.holder_label || lease.agent_label || null,
        agentKey: lease.agent_key || null,
        agentSessionId: lease.agent_session_id || null,
        status: lease.status || "active",
        updatedAt: lease.updated_at || null,
      }))
      .filter((lease) => Boolean(lease.id)),
    activeLocks: (task.active_locks || [])
      .map((lock) => ({
        id: lock.id || "",
        scope: lock.scope || "task",
        reason: lock.reason || null,
        message: lock.message || null,
        createdBy: lock.created_by || null,
      }))
      .filter((lock) => Boolean(lock.id)),
    stalePromptState: task.stale_prompt_state
      ? {
          isStale: Boolean(task.stale_prompt_state.is_stale),
          reason: task.stale_prompt_state.reason || null,
          staleForMs: task.stale_prompt_state.stale_for_ms ?? null,
          muted: Boolean(task.stale_prompt_state.muted),
          mutedBy: task.stale_prompt_state.muted_by || null,
          mutedAt: task.stale_prompt_state.muted_at || null,
        }
      : null,
    createdAt: task.created_at || null,
    updatedAt: task.updated_at || task.updatedAt || new Date().toISOString(),
  };
}

function mapDesktopTaskMutationResult(data: {
  task?: unknown;
  id?: unknown;
}): DesktopTaskMutationResult {
  const rawTask =
    data.task && typeof data.task === "object"
      ? data.task
      : data.id
        ? data
        : null;
  if (
    !rawTask ||
    typeof rawTask !== "object" ||
    typeof (rawTask as { id?: unknown }).id !== "string"
  ) {
    throw new Error("Task response was incomplete.");
  }
  return {
    task: mapDesktopTaskSummaryPayload(
      rawTask as Parameters<typeof mapDesktopTaskSummaryPayload>[0],
    ),
  };
}

function withDesktopHumanTaskBody<T extends object>(
  body: T,
): T & { desktop_human_client: true } {
  return {
    ...body,
    desktop_human_client: true,
  };
}

export async function addDesktopRoomTask(
  roomIdentifier: string,
  title: string,
): Promise<DesktopTaskMutationResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedTitle = title.trim();
  if (!trimmedRoomIdentifier)
    throw new Error("Choose a room before adding a task.");
  if (!trimmedTitle) throw new Error("Task title is required.");
  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/tasks`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify(
        withDesktopHumanTaskBody({ title: trimmedTitle, created_by: "human" }),
      ),
    },
  );
  return mapDesktopTaskMutationResult(data);
}

export async function updateDesktopRoomTask(
  roomIdentifier: string,
  taskId: string,
  updates: {
    status?: string;
    assignee?: string | null;
    pr_url?: string | null;
  },
): Promise<DesktopTaskMutationResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier)
    throw new Error("Choose a room before updating a task.");
  if (!taskId.trim()) throw new Error("Task id is required.");
  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify(withDesktopHumanTaskBody(updates)),
    },
  );
  return mapDesktopTaskMutationResult(data);
}

export async function updateDesktopRoomTaskLease(
  roomIdentifier: string,
  taskId: string,
  input: DesktopTaskLeaseActionInput,
): Promise<DesktopTaskMutationResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier)
    throw new Error("Choose a room before updating a task lease.");
  if (!taskId.trim()) throw new Error("Task id is required.");
  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/tasks/${encodeURIComponent(taskId)}/lease-action`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify(withDesktopHumanTaskBody(input)),
    },
  );
  return mapDesktopTaskMutationResult(data);
}

export async function updateDesktopRoomTaskReviewLease(
  roomIdentifier: string,
  taskId: string,
  input: DesktopTaskReviewLeaseActionInput,
): Promise<DesktopTaskMutationResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier)
    throw new Error("Choose a room before updating review authority.");
  if (!taskId.trim()) throw new Error("Task id is required.");
  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/tasks/${encodeURIComponent(taskId)}/review-lease-action`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify(withDesktopHumanTaskBody(input)),
    },
  );
  return mapDesktopTaskMutationResult(data);
}

export async function runDesktopRoomTaskWorkerAction(
  roomIdentifier: string,
  taskId: string,
  input: DesktopTaskWorkerActionInput,
): Promise<DesktopTaskMutationResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier)
    throw new Error("Choose a room before updating a task.");
  if (!taskId.trim()) throw new Error("Task id is required.");

  const session = getCurrentLocalWorkerSession(
    readLetAgentsLocalState(letagentsLocalStatePath),
    trimmedRoomIdentifier,
  );
  if (!session?.session_id || !session.session_token) {
    throw new Error(
      "No registered local worker session is available for this room.",
    );
  }

  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildWorkerActionPatch(taskId, session, input)),
    },
  );
  return mapDesktopTaskMutationResult(data);
}

export async function runDesktopRoomTaskReviewWorkerAction(
  roomIdentifier: string,
  taskId: string,
  input: DesktopTaskReviewWorkerActionInput,
): Promise<DesktopTaskMutationResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier)
    throw new Error("Choose a room before updating review authority.");
  if (!taskId.trim()) throw new Error("Task id is required.");

  const session = getCurrentLocalWorkerSession(
    readLetAgentsLocalState(letagentsLocalStatePath),
    trimmedRoomIdentifier,
  );
  if (!session?.session_id || !session.session_token) {
    throw new Error(
      "No registered local worker session is available for this room.",
    );
  }

  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/tasks/${encodeURIComponent(taskId)}/review-lease-action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildReviewWorkerActionBody(session, input)),
    },
  );
  return mapDesktopTaskMutationResult(data);
}
