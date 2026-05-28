import { encodeRoomIdPath } from "../../../room-id.js";
import { apiCall, roomScopedApiCall } from "../../runtime.js";
import type { TaskToolTarget } from "./context.js";

export function taskCollectionRoomPath(roomId: string): string {
  return `/rooms/${encodeRoomIdPath(roomId)}/tasks`;
}

export function taskDetailRoomPath(roomId: string, taskId: string): string {
  return `${taskCollectionRoomPath(roomId)}/${encodeURIComponent(taskId)}`;
}

export function taskCollectionProjectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/tasks`;
}

export function taskDetailProjectPath(projectId: string, taskId: string): string {
  return `${taskCollectionProjectPath(projectId)}/${encodeURIComponent(taskId)}`;
}

export function createTask(target: TaskToolTarget, body: Record<string, unknown>) {
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

export function listTasks(target: TaskToolTarget, queryString: string) {
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

export function patchTask(target: TaskToolTarget, taskId: string, body: Record<string, unknown>) {
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

export function postCanonicalTaskAction<T>(
  roomId: string,
  taskId: string,
  actionPath: "lease-action" | "review-lease-action",
  body: Record<string, unknown>
): Promise<T> {
  return apiCall<T>(`${taskDetailRoomPath(roomId, taskId)}/${actionPath}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
