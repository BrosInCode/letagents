import type { Project, Task } from "../../db.js";
import type { FocusGitHubRoutingContext } from "../../focus-room-settings.js";
import {
  formatRepoRoomEventMessage,
  type RepoRoomEvent,
} from "../../repo-workflow.js";
import { emitProjectMessage } from "../../server/events.js";
import {
  emitGitHubEventToAllParentRepoFocusRooms,
  emitTaskAnchoredMessage,
  getFocusRoomForGitHubEventTask,
} from "../../server/room-services.js";
import {
  getProjectForResolvedTask,
  type RepoRoomEventTaskProjection,
} from "./task-projection.js";

export async function emitRepoRoomEventProjectionMessage(input: {
  project: Project;
  roomEvent: RepoRoomEvent;
  linkedTask: Task | undefined;
  taskProjection: RepoRoomEventTaskProjection;
  isolatedFocusRoom: Project | null;
  githubRoutingContext: FocusGitHubRoutingContext;
}): Promise<void> {
  const {
    project,
    roomEvent,
    linkedTask,
    taskProjection,
    isolatedFocusRoom,
    githubRoutingContext,
  } = input;

  const message = formatRepoRoomEventMessage({
    event: roomEvent,
    linkedTaskId: taskProjection.authoritative ? linkedTask?.id ?? null : null,
    redactUntrustedTaskReference: !taskProjection.authoritative && Boolean(linkedTask),
  });
  if (!message) {
    return;
  }

  const linkedFocusRoom = taskProjection.authoritative && linkedTask
    ? await getFocusRoomForGitHubEventTask(project.id, linkedTask)
    : null;
  const linkedTaskProject = await getProjectForResolvedTask(project, linkedTask);
  if (taskProjection.authoritative && linkedTask) {
    await emitTaskAnchoredMessage(linkedTaskProject.id, "github", message, linkedTask, {
      source: "github",
      parent_activity: "GitHub activity",
      parent_event_kind: "major_activity",
      event_kind: "github",
      github_routing_context: githubRoutingContext,
    });
  } else if (linkedTask && isolatedFocusRoom) {
    await emitTaskAnchoredMessage(linkedTaskProject.id, "github", message, linkedTask, {
      source: "github",
      parent_activity: "GitHub activity",
      parent_event_kind: "major_activity",
      event_kind: "github",
      github_routing_context: githubRoutingContext,
    });
  } else {
    await emitProjectMessage(project.id, "github", message, { source: "github" });
  }

  if (!isolatedFocusRoom) {
    await emitGitHubEventToAllParentRepoFocusRooms(project.id, "github", message, {
      excludeRoomIds: linkedFocusRoom ? new Set([linkedFocusRoom.id]) : undefined,
    });
  }
}
