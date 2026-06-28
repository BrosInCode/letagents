import type { Project, Task } from "../../db.js";
import type { FocusGitHubRoutingContext } from "../../focus-rooms/settings.js";
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
  eventProject: Project;
  roomEvent: RepoRoomEvent;
  linkedTask: Task | undefined;
  taskProjection: RepoRoomEventTaskProjection;
  isolatedFocusRoom: Project | null;
  githubRoutingContext: FocusGitHubRoutingContext;
  messageIdBase?: string | null;
}): Promise<void> {
  const {
    project,
    eventProject,
    roomEvent,
    linkedTask,
    taskProjection,
    isolatedFocusRoom,
    githubRoutingContext,
    messageIdBase,
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
      client_message_id: messageIdBase ? `${messageIdBase}:task-event` : null,
      parent_client_message_id: messageIdBase ? `${messageIdBase}:task-event-anchor` : null,
    });
    if (eventProject.id !== linkedTaskProject.id) {
      await emitProjectMessage(eventProject.id, "github", message, {
        source: "github",
        client_message_id: messageIdBase ? `${messageIdBase}:event-room` : null,
      });
    }
  } else if (linkedTask && isolatedFocusRoom) {
    await emitTaskAnchoredMessage(linkedTaskProject.id, "github", message, linkedTask, {
      source: "github",
      parent_activity: "GitHub activity",
      parent_event_kind: "major_activity",
      event_kind: "github",
      github_routing_context: githubRoutingContext,
      client_message_id: messageIdBase ? `${messageIdBase}:isolated-task-event` : null,
      parent_client_message_id: messageIdBase ? `${messageIdBase}:isolated-task-event-anchor` : null,
    });
    if (eventProject.id !== linkedTaskProject.id) {
      await emitProjectMessage(eventProject.id, "github", message, {
        source: "github",
        client_message_id: messageIdBase ? `${messageIdBase}:event-room` : null,
      });
    }
  } else {
    await emitProjectMessage(eventProject.id, "github", message, {
      source: "github",
      client_message_id: messageIdBase ? `${messageIdBase}:event-room` : null,
    });
  }

  if (!isolatedFocusRoom && eventProject.id === project.id) {
    await emitGitHubEventToAllParentRepoFocusRooms(project.id, "github", message, {
      excludeRoomIds: linkedFocusRoom ? new Set([linkedFocusRoom.id]) : undefined,
      client_message_id_base: messageIdBase,
    });
  }
}
