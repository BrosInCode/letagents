import type { Project, Task } from "./db.js";
import {
  shouldHardIsolateGitHubEventToFocusRoom,
  type FocusGitHubRoutingContext,
} from "./focus-room-settings.js";
import { getFocusRoomSettings } from "./room-formatting.js";

export interface GitHubFocusIsolationDeps {
  getActiveTaskFocusRoom(projectId: string, taskId: string): Promise<Project | null>;
  getProjectById?(projectId: string): Promise<Project | null>;
}

export function createGitHubFocusIsolationResolver(deps: GitHubFocusIsolationDeps) {
  async function getFocusRoomForGitHubEventTask(
    projectId: string,
    linkedTask: Pick<Task, "id" | "room_id"> | undefined
  ): Promise<Project | null> {
    if (!linkedTask) {
      return null;
    }

    if (linkedTask.room_id && linkedTask.room_id !== projectId) {
      const taskRoom = await deps.getProjectById?.(linkedTask.room_id);
      if (
        taskRoom?.kind === "focus" &&
        taskRoom.parent_room_id === projectId &&
        taskRoom.focus_status !== "concluded"
      ) {
        return taskRoom;
      }
      return null;
    }

    return (await deps.getActiveTaskFocusRoom(projectId, linkedTask.id)) ?? null;
  }

  async function getHardIsolatedFocusRoomForGitHubEvent(
    projectId: string,
    linkedTask: Pick<Task, "id" | "room_id"> | undefined,
    githubRoutingContext: FocusGitHubRoutingContext
  ): Promise<Project | null> {
    const focusRoom = await getFocusRoomForGitHubEventTask(projectId, linkedTask);
    if (!focusRoom) {
      return null;
    }

    return shouldHardIsolateGitHubEventToFocusRoom(
      getFocusRoomSettings(focusRoom),
      githubRoutingContext
    )
      ? focusRoom
      : null;
  }

  return {
    getFocusRoomForGitHubEventTask,
    getHardIsolatedFocusRoomForGitHubEvent,
  };
}
