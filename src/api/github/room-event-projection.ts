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
import type { JevLinkPullRequestInput } from "../connectors/jev-link.js";
import type { Task } from "../db/types.js";
import type { RepoRoomEvent } from "../repo-workflow/types.js";
import {
  getDefaultTrackerRuleEngine,
  type TrackerRuleRepoEventInput,
  type TrackerRuleRepoEventResult,
} from "../connectors/rules/engine.js";

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
  runTrackerRulesForRepoEvent: (input: TrackerRuleRepoEventInput) => Promise<TrackerRuleRepoEventResult>;
  /** PR6: ask Jev to link a pull request that reached no card. Runs after the webhook answers; never throws. */
  linkPullRequestWithJev: (input: JevLinkPullRequestInput) => void;
  /** PR6: ask Jev about a linked pull request closed without a merge. Runs after the webhook answers; never throws. */
  proposeForClosedPullRequestWithJev: (input: { task: Task; event: RepoRoomEvent; linkConfirmed: boolean }) => void;
}

export function githubProjectionMessageIdBase(event: Pick<GitHubRoomEvent, "semantic_id" | "idempotency_key">): string {
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
  runTrackerRulesForRepoEvent: async (input) => (await getDefaultTrackerRuleEngine()).runForRepoEvent(input),
  // Jev can take up to 10 s, so the webhook does not wait for it. A lost
  // question (a crash) changes nothing: Jev never writes on its own.
  linkPullRequestWithJev: (input) => {
    void import("../connectors/jev/runtime.js")
      .then(({ getDefaultJevLinkService }) => getDefaultJevLinkService().linkPullRequest(input))
      .catch((error) => console.warn("[jev tracker] link failed:", error instanceof Error ? error.name : "unknown"));
  },
  proposeForClosedPullRequestWithJev: (input) => {
    void import("../connectors/jev/runtime.js")
      .then(({ proposeForClosedPullRequestDefault }) => proposeForClosedPullRequestDefault(input))
      .catch((error) => console.warn("[jev tracker] exception failed:", error instanceof Error ? error.name : "unknown"));
  },
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
  const routingEvent = event.routingEvent ?? roomEvent;
  let taskResolution = routingEvent
    ? await deps.resolveLinkedTaskForRepoRoomEvent(project, routingEvent)
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
    deps.emitGitHubRoomEventUpdate(eventProject.id, persisted.event);
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
    matchedByTicketKey: taskResolution.matchedByTicketKey === true,
    ...(taskResolution.jevLink ? { jevLink: taskResolution.jevLink } : {}),
  });
  if (!taskProjection.authoritative && linkedTask) {
    await deps.updateGitHubRoomEventLinkedTaskId(persisted.event.idempotency_key, null);
  }
  linkedTask = taskProjection.task;

  // Ticket connectors PR5: a card with a ticket runs its connection's rules
  // when the event reached it through a confirmed link (the ticket key; the
  // engine checks). A card the projection did not accept (a lock, or a lease
  // on another branch) runs none.
  if (taskProjection.authoritative && linkedTask?.external_ref) {
    await deps.runTrackerRulesForRepoEvent({
      deliveryId: input.deliveryId,
      storedEvent: persisted.event,
      eventRoomId: eventProject.id,
      roomEvent,
      task: linkedTask,
      matchedByTicketKey: taskResolution.matchedByTicketKey === true,
      linkConfirmedByPerson: taskResolution.jevLink === "jev_confirmed",
    });
    // PR6: a pull request on the card by its key or an accepted Jev link
    // closed without a merge: Jev proposes what happened, in the room.
    if (roomEvent.kind === "pull_request" && roomEvent.action === "closed" && roomEvent.pullRequest.merged !== true) {
      deps.proposeForClosedPullRequestWithJev({
        task: linkedTask,
        event: roomEvent,
        linkConfirmed: taskResolution.matchedByTicketKey === true || taskResolution.jevLink === "jev_confirmed",
      });
    }
  }

  // PR6: a pull request that names no ticket and reached no card. The service
  // checks the room's Jev switch before anything else; a room without it
  // makes no Jev call.
  if (!taskResolution.task && roomEvent.kind === "pull_request") {
    deps.linkPullRequestWithJev({
      roomId: project.id,
      event: roomEvent,
      storedEvent: persisted.event,
      installationId: input.installationId,
    });
  }

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
