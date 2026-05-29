import {
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
import { maybeAutoCreateTaskForFailedCheckRun } from "./room-event-projection/failed-check-run.js";
import { emitRepoRoomEventProjectionMessage } from "./room-event-projection/message-delivery.js";
import { persistMaterializedGitHubRoomEvent } from "./room-event-projection/persistence.js";
import {
  applyRepoRoomEventToTask,
  getProjectForResolvedTask,
} from "./room-event-projection/task-projection.js";
import { resolveLinkedTaskForRepoRoomEvent } from "./room-event-projection/task-resolver.js";

export { persistMaterializedGitHubRoomEvent } from "./room-event-projection/persistence.js";

export async function handleMaterializedGitHubRoomEvent(
  project: Project,
  event: MaterializedGitHubRoomEvent,
  input: {
    deliveryId: string;
    installationId: string | null;
    githubRepoId: string | null;
  }
): Promise<{
  status: Exclude<GitHubWebhookDeliveryStatus, "received">;
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}> {
  const roomEvent = event.roomEvent;
  let taskResolution = roomEvent
    ? await resolveLinkedTaskForRepoRoomEvent(project, roomEvent)
    : emptyRepoRoomEventTaskResolution();
  let linkedTask = taskResolution.task;
  const githubRoutingContext = toGitHubRoutingContext(taskResolution);
  const isolatedFocusRoom = await getHardIsolatedFocusRoomForGitHubEvent(
    project.id,
    linkedTask,
    githubRoutingContext
  );

  const persisted = await persistMaterializedGitHubRoomEvent(event, {
    deliveryId: input.deliveryId,
    roomId: isolatedFocusRoom?.id ?? project.id,
    linkedTaskId: linkedTask?.id ?? null,
  });

  if (persisted.duplicate) {
    return {
      status: "processed",
      installationId: input.installationId,
      githubRepoId: input.githubRepoId,
      roomId: project.id,
    };
  }

  if (!roomEvent) {
    return {
      status: "processed",
      installationId: input.installationId,
      githubRepoId: input.githubRepoId,
      roomId: project.id,
    };
  }

  if (roomEvent.kind === "check_run") {
    const taskProject = await getProjectForResolvedTask(project, linkedTask);
    linkedTask = await maybeAutoCreateTaskForFailedCheckRun(taskProject, linkedTask, roomEvent, {
      githubRoutingContext,
    });
    if (linkedTask) {
      taskResolution = {
        ...taskResolution,
        task: linkedTask,
      };
      await updateGitHubRoomEventLinkedTaskId(event.idempotency_key, linkedTask.id);
    }
  }

  const taskProject = await getProjectForResolvedTask(project, linkedTask);
  const taskProjection = await applyRepoRoomEventToTask(taskProject, linkedTask, roomEvent, {
    installationId: input.installationId,
    githubRoutingContext,
  });
  if (!taskProjection.authoritative && linkedTask) {
    await updateGitHubRoomEventLinkedTaskId(event.idempotency_key, null);
  }
  linkedTask = taskProjection.task;

  await emitRepoRoomEventProjectionMessage({
    project,
    roomEvent,
    linkedTask,
    taskProjection,
    isolatedFocusRoom,
    githubRoutingContext,
  });

  return {
    status: "processed",
    installationId: input.installationId,
    githubRepoId: input.githubRepoId,
    roomId: project.id,
  };
}
