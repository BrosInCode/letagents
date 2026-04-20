import type { Project, Task } from "./db.js";
import {
  shouldHardIsolateGitHubEventToFocusRoom,
  type FocusGitHubRoutingContext,
} from "./focus-room-settings.js";
import { getFocusRoomSettings } from "./room-formatting.js";

export interface GitHubFocusIsolationDeps {
  getActiveTaskFocusRoom(projectId: string, taskId: string): Promise<Project | null>;
}

export function createGitHubFocusIsolationResolver(deps: GitHubFocusIsolationDeps) {
  async function getHardIsolatedFocusRoomForGitHubEvent(
    projectId: string,
    linkedTask: Pick<Task, "id"> | undefined,
    githubRoutingContext: FocusGitHubRoutingContext
  ): Promise<Project | null> {
    if (!linkedTask) {
      return null;
    }

    const focusRoom = await deps.getActiveTaskFocusRoom(projectId, linkedTask.id);
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
    getHardIsolatedFocusRoomForGitHubEvent,
  };
}
