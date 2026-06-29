import type { EventEmitter } from "events";
import crypto from "crypto";

import {
  type GitHubRoomEvent,
  type RoomSharedArtifact,
  updateGitHubRoomEventLinkedTaskId,
  type GitHubWebhookDeliveryStatus,
  type Project,
} from "../db.js";
import type { MaterializedGitHubRoomEvent } from "./room-events.js";
import {
  emptyRepoRoomEventTaskResolution,
  toGitHubRoutingContext,
} from "./repo-event-task-resolution.js";
import { getHardIsolatedFocusRoomForGitHubEvent } from "../server/room-services.js";
import { applyGitHubRefRoomLifecycle } from "./git-room-lifecycle.js";
import { syncRoomSharedArtifactsForGitHubRoomEvent } from "./room-event-artifacts.js";
import { maybeAutoCreateTaskForFailedCheckRun } from "./room-event-projection/failed-check-run.js";
import { emitRepoRoomEventProjectionMessage } from "./room-event-projection/message-delivery.js";
import { persistMaterializedGitHubRoomEvent } from "./room-event-projection/persistence.js";
import {
  applyRepoRoomEventToTask,
  getProjectForResolvedTask,
} from "./room-event-projection/task-projection.js";
import { resolveLinkedTaskForRepoRoomEvent } from "./room-event-projection/task-resolver.js";
import { artifactEvents, githubRoomEvents } from "../server/events.js";

export { persistMaterializedGitHubRoomEvent } from "./room-event-projection/persistence.js";

export interface GitHubRoomEventProjectionDeps {
  resolveLinkedTaskForRepoRoomEvent: typeof resolveLinkedTaskForRepoRoomEvent;
  getHardIsolatedFocusRoomForGitHubEvent: typeof getHardIsolatedFocusRoomForGitHubEvent;
  persistMaterializedGitHubRoomEvent: typeof persistMaterializedGitHubRoomEvent;
  getProjectForResolvedTask: typeof getProjectForResolvedTask;
  maybeAutoCreateTaskForFailedCheckRun: typeof maybeAutoCreateTaskForFailedCheckRun;
  updateGitHubRoomEventLinkedTaskId: typeof updateGitHubRoomEventLinkedTaskId;
  applyRepoRoomEventToTask: typeof applyRepoRoomEventToTask;
  syncRoomSharedArtifactsForGitHubRoomEvent: typeof syncRoomSharedArtifactsForGitHubRoomEvent;
  emitRoomArtifactUpdateEvents: typeof emitRoomArtifactUpdateEvents;
  emitGitHubRoomEventUpdate: typeof emitGitHubRoomEventUpdate;
  emitRepoRoomEventProjectionMessage: typeof emitRepoRoomEventProjectionMessage;
  applyGitHubRefRoomLifecycle: typeof applyGitHubRefRoomLifecycle;
}

function githubProjectionMessageIdBase(event: Pick<GitHubRoomEvent, "semantic_id" | "idempotency_key">): string {
  const digest = crypto
    .createHash("sha256")
    .update(event.semantic_id ?? event.idempotency_key)
    .digest("hex");
  return `github-event:${digest}`;
}

export function emitRoomArtifactUpdateEvents(
  projectId: string,
  artifacts: RoomSharedArtifact[],
  events: EventEmitter = artifactEvents
): void {
  for (const artifact of artifacts) {
    events.emit("artifact:updated", {
      projectId,
      artifact,
    });
  }
}

export function emitGitHubRoomEventUpdate(
  projectId: string,
  event: GitHubRoomEvent,
  events: EventEmitter = githubRoomEvents
): void {
  events.emit("github_event:updated", {
    projectId,
    event,
  });
}

const defaultGitHubRoomEventProjectionDeps: GitHubRoomEventProjectionDeps = {
  resolveLinkedTaskForRepoRoomEvent,
  getHardIsolatedFocusRoomForGitHubEvent,
  persistMaterializedGitHubRoomEvent,
  getProjectForResolvedTask,
  maybeAutoCreateTaskForFailedCheckRun,
  updateGitHubRoomEventLinkedTaskId,
  applyRepoRoomEventToTask,
  syncRoomSharedArtifactsForGitHubRoomEvent,
  emitRoomArtifactUpdateEvents,
  emitGitHubRoomEventUpdate,
  emitRepoRoomEventProjectionMessage,
  applyGitHubRefRoomLifecycle,
};

export async function handleMaterializedGitHubRoomEvent(
  project: Project,
  event: MaterializedGitHubRoomEvent,
  input: {
    deliveryId: string;
    installationId: string | null;
    githubRepoId: string | null;
    eventProject?: Project | null;
    retryFailedDelivery?: boolean;
    deps?: Partial<GitHubRoomEventProjectionDeps>;
  }
): Promise<{
  status: Exclude<GitHubWebhookDeliveryStatus, "received">;
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}> {
  const deps = {
    ...defaultGitHubRoomEventProjectionDeps,
    ...input.deps,
  };
  const roomEvent = event.roomEvent;
  let taskResolution = roomEvent
    ? await deps.resolveLinkedTaskForRepoRoomEvent(project, roomEvent)
    : emptyRepoRoomEventTaskResolution();
  let linkedTask = taskResolution.task;
  const githubRoutingContext = toGitHubRoutingContext(taskResolution);
  const isolatedFocusRoom = await deps.getHardIsolatedFocusRoomForGitHubEvent(
    project.id,
    linkedTask,
    githubRoutingContext
  );
  const refRoomProject = input.eventProject ?? null;
  const eventProject = isolatedFocusRoom ?? refRoomProject ?? project;

  const persisted = await deps.persistMaterializedGitHubRoomEvent(event, {
    deliveryId: input.deliveryId,
    roomId: eventProject.id,
    linkedTaskId: linkedTask?.id ?? null,
  });

  if (persisted.duplicate && !input.retryFailedDelivery) {
    return {
      status: "processed",
      installationId: input.installationId,
      githubRepoId: input.githubRepoId,
      roomId: eventProject.id,
    };
  }

  if (!roomEvent) {
    return {
      status: "processed",
      installationId: input.installationId,
      githubRepoId: input.githubRepoId,
      roomId: eventProject.id,
    };
  }

  const messageIdBase = githubProjectionMessageIdBase(persisted.event);

  if (roomEvent.kind === "check_run") {
    const taskProject = await deps.getProjectForResolvedTask(project, linkedTask);
    linkedTask = await deps.maybeAutoCreateTaskForFailedCheckRun(taskProject, linkedTask, roomEvent, {
      githubRoutingContext,
    });
    if (linkedTask) {
      taskResolution = {
        ...taskResolution,
        task: linkedTask,
      };
      await deps.updateGitHubRoomEventLinkedTaskId(persisted.event.idempotency_key, linkedTask.id);
    }
  }

  const taskProject = await deps.getProjectForResolvedTask(project, linkedTask);
  const taskProjection = await deps.applyRepoRoomEventToTask(taskProject, linkedTask, roomEvent, {
    installationId: input.installationId,
    githubRoutingContext,
    messageIdBase,
  });
  if (!taskProjection.authoritative && linkedTask) {
    await deps.updateGitHubRoomEventLinkedTaskId(persisted.event.idempotency_key, null);
  }
  linkedTask = taskProjection.task;

  const syncedArtifacts = await deps.syncRoomSharedArtifactsForGitHubRoomEvent({
    room_id: eventProject.id,
    event,
    linked_task_id: taskProjection.authoritative ? linkedTask?.id ?? null : null,
  });
  deps.emitRoomArtifactUpdateEvents(eventProject.id, syncedArtifacts);
  deps.emitGitHubRoomEventUpdate(eventProject.id, {
    ...persisted.event,
    linked_task_id: taskProjection.authoritative ? linkedTask?.id ?? null : null,
  });

  await deps.emitRepoRoomEventProjectionMessage({
    project,
    eventProject,
    roomEvent,
    linkedTask,
    taskProjection,
    isolatedFocusRoom,
    githubRoutingContext,
    messageIdBase,
  });

  await deps.applyGitHubRefRoomLifecycle(
    refRoomProject ?? eventProject,
    event,
    undefined,
    {
      eventOrderAt: persisted.event.event_order_at,
      activationEventRoomIds: [eventProject.id],
    }
  );

  return {
    status: "processed",
    installationId: input.installationId,
    githubRepoId: input.githubRepoId,
    roomId: eventProject.id,
  };
}
