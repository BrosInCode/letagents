import { encodeRoomIdPath } from "../../../room-id.js";
import {
  addLocalTask,
  apiCall,
  claimLocalTaskReviewLease,
  getLocalTask,
  isLocalRoomStorageEnabled,
  listLocalTasks,
  releaseLocalTaskReviewLease,
  resolveLocalRoomStorageIdentifiers,
  roomScopedApiCall,
  updateLocalTask,
} from "../../runtime.js";
import type { TaskToolTarget } from "./context.js";

export function taskCollectionRoomPath(roomId: string): string {
  return `/rooms/${encodeRoomIdPath(roomId)}/tasks`;
}

export function taskDetailRoomPath(roomId: string, taskId: string): string {
  return `${taskCollectionRoomPath(roomId)}/${encodeURIComponent(taskId)}`;
}

export function boardSettingsRoomPath(roomId: string): string {
  return `/rooms/${encodeRoomIdPath(roomId)}/board-settings`;
}

export function boardManagersRoomPath(roomId: string): string {
  return `/rooms/${encodeRoomIdPath(roomId)}/board-managers`;
}

export function activeBoardManagerRoomPath(roomId: string): string {
  return `${boardManagersRoomPath(roomId)}/active`;
}

export function boardIntentsRoomPath(roomId: string): string {
  return `/rooms/${encodeRoomIdPath(roomId)}/board-intents`;
}

export function boardIntentDecisionRoomPath(
  roomId: string,
  intentId: string,
  decision: "approve" | "deny"
): string {
  return `${boardIntentsRoomPath(roomId)}/${encodeURIComponent(intentId)}/${decision}`;
}

export function taskCollectionProjectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/tasks`;
}

export function taskDetailProjectPath(projectId: string, taskId: string): string {
  return `${taskCollectionProjectPath(projectId)}/${encodeURIComponent(taskId)}`;
}

function localRoomIdForTarget(target: TaskToolTarget): string | null {
  return target.effectiveRoomId ?? target.roomId ?? target.projectId ?? null;
}

export async function createTask(target: TaskToolTarget, body: Record<string, unknown>) {
  const localRoomId = localRoomIdForTarget(target);
  if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
    const { localRoomId: sqliteRoomId } = await resolveLocalRoomStorageIdentifiers(localRoomId);
    return addLocalTask(sqliteRoomId || localRoomId, {
      title: String(body.title || ""),
      description: typeof body.description === "string" ? body.description : null,
      created_by: typeof body.created_by === "string" ? body.created_by : null,
    });
  }

  return roomScopedApiCall({
    room_id: target.roomId,
    project_id: target.projectId,
    room_path: taskCollectionRoomPath,
    project_path: taskCollectionProjectPath,
    options: {
      method: "POST",
      body: JSON.stringify(body),
    },
  });
}

export async function listTasks(target: TaskToolTarget, queryString: string) {
  const localRoomId = localRoomIdForTarget(target);
  if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
    const { localRoomId: sqliteRoomId } = await resolveLocalRoomStorageIdentifiers(localRoomId);
    const params = new URLSearchParams(queryString);
    return listLocalTasks(sqliteRoomId || localRoomId, {
      status: params.get("status"),
      openOnly: params.get("open") !== "false",
    });
  }

  return roomScopedApiCall<{
    tasks?: Array<{ id?: string }>;
    has_more?: boolean;
  }>({
    room_id: target.roomId,
    project_id: target.projectId,
    room_path: (roomId) => `${taskCollectionRoomPath(roomId)}${queryString ? `?${queryString}` : ""}`,
    project_path: (projectId) => `${taskCollectionProjectPath(projectId)}${queryString ? `?${queryString}` : ""}`,
  });
}

export async function patchTask(target: TaskToolTarget, taskId: string, body: Record<string, unknown>) {
  const localRoomId = localRoomIdForTarget(target);
  if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
    const { localRoomId: sqliteRoomId } = await resolveLocalRoomStorageIdentifiers(localRoomId);
    return updateLocalTask(sqliteRoomId || localRoomId, taskId, body);
  }

  return roomScopedApiCall({
    room_id: target.roomId,
    project_id: target.projectId,
    room_path: (roomId) => taskDetailRoomPath(roomId, taskId),
    project_path: (projectId) => taskDetailProjectPath(projectId, taskId),
    options: {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  });
}

export async function postCanonicalTaskAction<T>(
  roomId: string,
  taskId: string,
  actionPath: "lease-action" | "review-lease-action",
  body: Record<string, unknown>
): Promise<T> {
  if (await isLocalRoomStorageEnabled(roomId)) {
    const { localRoomId } = await resolveLocalRoomStorageIdentifiers(roomId);
    const sqliteRoomId = localRoomId || roomId;
    const action = typeof body.action === "string" ? body.action : "noop";
    const existingTask = await getLocalTask(sqliteRoomId, taskId);
    if (!existingTask) {
      throw new Error("Task not found.");
    }

    if (actionPath === "review-lease-action") {
      if (action === "claim") {
        const result = await claimLocalTaskReviewLease(sqliteRoomId, taskId, {
          holder_label:
            typeof body.actor_label === "string" ? body.actor_label : null,
          agent_key:
            typeof body.actor_key === "string" ? body.actor_key : null,
          agent_session_id:
            typeof body.agent_session_id === "string"
              ? body.agent_session_id
              : null,
        });
        return {
          action,
          task: result.task,
          lease: result.lease,
        } as T;
      }
      if (action === "release") {
        const result = await releaseLocalTaskReviewLease(sqliteRoomId, taskId, {
          lease_id:
            typeof body.lease_id === "string" ? body.lease_id : null,
        });
        return {
          action,
          task: result.task,
          released_lease: result.released_lease,
        } as T;
      }
      return {
        action,
        task: existingTask,
        lease: null,
        released_lease: null,
      } as T;
    }

    if (action === "handoff") {
      const targetActorKey =
        typeof body.target_actor_key === "string" && body.target_actor_key.trim()
          ? body.target_actor_key.trim()
          : null;
      const targetAgentSessionId =
        typeof body.target_agent_session_id === "string" && body.target_agent_session_id.trim()
          ? body.target_agent_session_id.trim()
          : null;
      const targetActorInstanceId =
        typeof body.target_actor_instance_id === "string" && body.target_actor_instance_id.trim()
          ? body.target_actor_instance_id.trim()
          : null;
      const task = targetActorKey
        ? await updateLocalTask(sqliteRoomId, taskId, {
            ...(existingTask.status === "accepted" ? { status: "assigned" } : {}),
            assignee: targetActorKey,
            assignee_agent_key: targetActorKey,
            assignee_agent_instance_id: targetActorInstanceId,
            assignee_agent_session_id: targetAgentSessionId,
          })
        : existingTask;
      return {
        action,
        task,
        released_lease: null,
        new_lease: null,
      } as T;
    }

    if (action === "release") {
      const releasableStatuses = new Set(["assigned", "in_progress", "blocked", "in_review"]);
      const patch: Record<string, unknown> = {
        assignee: null,
        assignee_agent_key: null,
      };
      if (releasableStatuses.has(existingTask.status)) {
        patch.status = "accepted";
        patch.skip_transition_validation = true;
      }
      const task = await updateLocalTask(sqliteRoomId, taskId, patch);
      return {
        action,
        task,
        released_lease: null,
      } as T;
    }

    return {
      action,
      task: existingTask,
      released_lease: null,
    } as T;
  }

  const { cloudRoomId } = await resolveLocalRoomStorageIdentifiers(roomId);
  return apiCall<T>(`${taskDetailRoomPath(cloudRoomId || roomId, taskId)}/${actionPath}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getBoardSettings(roomId: string) {
  return apiCall(boardSettingsRoomPath(roomId));
}

export async function patchBoardSettings(roomId: string, body: Record<string, unknown>) {
  return apiCall(boardSettingsRoomPath(roomId), {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function postBoardManager(roomId: string, body: Record<string, unknown>) {
  return apiCall(boardManagersRoomPath(roomId), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteActiveBoardManager(roomId: string, body: Record<string, unknown>) {
  return apiCall(activeBoardManagerRoomPath(roomId), {
    method: "DELETE",
    body: JSON.stringify(body),
  });
}

export async function getBoardIntents(roomId: string, queryString: string) {
  return apiCall(`${boardIntentsRoomPath(roomId)}${queryString ? `?${queryString}` : ""}`);
}

export async function postBoardIntent(roomId: string, body: Record<string, unknown>) {
  return apiCall(boardIntentsRoomPath(roomId), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function postBoardIntentDecision(
  roomId: string,
  intentId: string,
  decision: "approve" | "deny",
  body: Record<string, unknown>
) {
  return apiCall(boardIntentDecisionRoomPath(roomId, intentId, decision), {
    method: "POST",
    body: JSON.stringify(body),
  });
}
