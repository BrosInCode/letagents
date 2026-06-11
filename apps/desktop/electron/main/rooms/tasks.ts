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
import { letagentsLocalStatePath } from "../paths.js";
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
  const data = await apiFetch<{ task?: unknown; id?: unknown }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/tasks`,
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
