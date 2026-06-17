import type {
  DesktopTaskCreateInput,
  DesktopTaskLeaseActionInput,
  DesktopTaskMutationResult,
  DesktopTaskReviewLeaseActionInput,
  DesktopTaskReviewWorkerActionInput,
  DesktopTaskWorkerActionInput,
} from "../../ipc-types.js";
import {
  buildReviewWorkerActionBody,
  buildWorkerActionPatch,
  getCurrentLocalWorkerSession,
  readLetAgentsLocalState,
} from "../../board-task-actions.js";
import { apiFetch } from "../auth.js";
import { getLetAgentsLocalStatePath } from "../paths.js";
import {
  addLocalTask,
  claimLocalTaskReviewLease,
  cloudRoomIdentifierForStorage,
  localRoomIdentifierForStorage,
  releaseLocalTaskReviewLease,
  resolveLocalAwareRoomStorageMode,
  updateLocalTask,
} from "./local-store.js";
import {
  mapDesktopTaskSummaryPayload,
  type DesktopTaskSummaryPayload,
} from "./tasks/mappers.js";

export { mapDesktopTaskSummaryPayload, type DesktopTaskSummaryPayload };

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
      rawTask as DesktopTaskSummaryPayload,
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
  input: DesktopTaskCreateInput,
): Promise<DesktopTaskMutationResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedTitle = input.title.trim();
  const trimmedDescription = input.description?.trim() || null;
  if (!trimmedRoomIdentifier)
    throw new Error("Choose a room before adding a task.");
  if (!trimmedTitle) throw new Error("Task title is required.");
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    return {
      task: await addLocalTask(localRoomIdentifier, {
        title: trimmedTitle,
        description: trimmedDescription,
        createdBy: "human",
      }),
    };
  }
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/tasks`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify(
        withDesktopHumanTaskBody({
          title: trimmedTitle,
          description: trimmedDescription,
          created_by: "human",
        }),
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
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    return {
      task: await updateLocalTask(localRoomIdentifier, taskId.trim(), {
        status: updates.status,
        assignee: updates.assignee,
        prUrl: updates.pr_url,
      }),
    };
  }
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/tasks/${encodeURIComponent(taskId)}`,
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
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    const nextStatus =
      input.action === "release"
        ? "accepted"
        : undefined;
    return {
      task: await updateLocalTask(localRoomIdentifier, taskId.trim(), {
        status: nextStatus,
        validateStatus: nextStatus ? false : undefined,
      }),
    };
  }
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/tasks/${encodeURIComponent(taskId)}/lease-action`,
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
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    if (input.action === "release") {
      const result = await releaseLocalTaskReviewLease(
        localRoomIdentifier,
        taskId.trim(),
        { leaseId: input.lease_id },
      );
      return { task: result.task };
    }
    const result = await claimLocalTaskReviewLease(
      localRoomIdentifier,
      taskId.trim(),
      {
        holderLabel: input.target_actor_key || "Local reviewer",
        agentKey: input.target_actor_key || null,
        agentSessionId: input.target_agent_session_id || null,
        leaseId: input.lease_id,
      },
    );
    return {
      task: result.task,
    };
  }
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/tasks/${encodeURIComponent(taskId)}/review-lease-action`,
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
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    const session = getCurrentLocalWorkerSession(
      readLetAgentsLocalState(getLetAgentsLocalStatePath()),
      localRoomIdentifier,
    );
    const actor = session?.display_name || session?.agent_key || "Local agent";
    const nextStatus =
      input.action === "claim"
        ? "assigned"
        : input.action === "start"
          ? "in_progress"
          : input.action === "submit_review"
            ? "in_review"
            : input.action === "block"
              ? "blocked"
              : undefined;
    return {
      task: await updateLocalTask(localRoomIdentifier, taskId.trim(), {
        status: nextStatus,
        assignee: input.action === "claim" ? actor : undefined,
      }),
    };
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const session = getCurrentLocalWorkerSession(
    readLetAgentsLocalState(getLetAgentsLocalStatePath()),
    cloudRoomIdentifier,
  );
  if (!session?.session_id || !session.session_token) {
    throw new Error(
      "No registered local worker session is available for this room.",
    );
  }

  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/tasks/${encodeURIComponent(taskId)}`,
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
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    const localRoomIdentifier = localRoomIdentifierForStorage(
      storage,
      trimmedRoomIdentifier,
    );
    const session = getCurrentLocalWorkerSession(
      readLetAgentsLocalState(getLetAgentsLocalStatePath()),
      localRoomIdentifier,
    );
    if (input.action === "release") {
      const result = await releaseLocalTaskReviewLease(
        localRoomIdentifier,
        taskId.trim(),
        { leaseId: input.lease_id },
      );
      return { task: result.task };
    }
    const result = await claimLocalTaskReviewLease(
      localRoomIdentifier,
      taskId.trim(),
      {
        holderLabel: session?.display_name || session?.agent_key || "Local reviewer",
        agentKey: session?.agent_key || null,
        agentSessionId: session?.session_id || null,
      },
    );
    return {
      task: result.task,
    };
  }

  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );
  const session = getCurrentLocalWorkerSession(
    readLetAgentsLocalState(getLetAgentsLocalStatePath()),
    cloudRoomIdentifier,
  );
  if (!session?.session_id || !session.session_token) {
    throw new Error(
      "No registered local worker session is available for this room.",
    );
  }

  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/tasks/${encodeURIComponent(taskId)}/review-lease-action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildReviewWorkerActionBody(session, input)),
    },
  );
  return mapDesktopTaskMutationResult(data);
}
