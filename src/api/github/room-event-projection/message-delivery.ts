import { githubRoomChatEventKind } from "../../../../shared/room-settings.mjs";
import type { Project, Task } from "../../db.js";
import type { loadGitHubRoomChatEventKinds } from "../../db/room-settings.js";
import type { FocusGitHubRoutingContext } from "../../focus-rooms/settings.js";
import { createGitHubChatEventGate } from "./chat-event-gate.js";
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
  loadChatEventKinds?: typeof loadGitHubRoomChatEventKinds;
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

  const gate = createGitHubChatEventGate({
    eventKind: githubRoomChatEventKind(roomEvent),
    repoRoomId: project.id,
    load: input.loadChatEventKinds,
  });
  const postToEventRoom = async (clientMessageIdSuffix: string): Promise<void> => {
    if (!await gate.accepts(eventProject)) return;
    await emitProjectMessage(eventProject.id, "github", message, {
      source: "github",
      client_message_id: messageIdBase ? `${messageIdBase}:${clientMessageIdSuffix}` : null,
    });
  };

  const linkedFocusRoom = taskProjection.authoritative && linkedTask
    ? await getFocusRoomForGitHubEventTask(project.id, linkedTask)
    : null;
  const linkedTaskProject = await getProjectForResolvedTask(project, linkedTask);
  const anchorsToTask = Boolean(linkedTask) && (taskProjection.authoritative || Boolean(isolatedFocusRoom));
  if (linkedTask && anchorsToTask) {
    const idPrefix = taskProjection.authoritative ? "task-event" : "isolated-task-event";
    // The task's messages land in its focus room when it has one, so the
    // emitter asks the gate about the room it is about to post to.
    await emitTaskAnchoredMessage(linkedTaskProject.id, "github", message, linkedTask, {
      source: "github",
      parent_activity: "GitHub activity",
      parent_event_kind: "major_activity",
      event_kind: "github",
      github_routing_context: githubRoutingContext,
      client_message_id: messageIdBase ? `${messageIdBase}:${idPrefix}` : null,
      parent_client_message_id: messageIdBase ? `${messageIdBase}:${idPrefix}-anchor` : null,
      shouldDeliverToRoom: gate.accepts,
    });
    if (eventProject.id !== linkedTaskProject.id) {
      await postToEventRoom("event-room");
    }
  } else {
    await postToEventRoom("event-room");
  }

  if (!isolatedFocusRoom && eventProject.id === project.id) {
    await emitGitHubEventToAllParentRepoFocusRooms(project.id, "github", message, {
      excludeRoomIds: linkedFocusRoom ? new Set([linkedFocusRoom.id]) : undefined,
      client_message_id_base: messageIdBase,
      filterRooms: gate.filter,
    });
  }
}
