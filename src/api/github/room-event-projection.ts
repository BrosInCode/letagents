import {
  createTask,
  findTaskByPrUrl,
  findTaskByWorkflowArtifactMatches,
  getActiveTaskLeases,
  getActiveTaskLocks,
  getFocusRoomsForParent,
  getProjectById,
  getTaskById,
  insertGitHubRoomEvent,
  updateGitHubRoomEventLinkedTaskId,
  updateTask,
  updateTaskLeaseWorkflowRefs,
  type GitHubWebhookDeliveryStatus,
  type Project,
  type Task,
  type TaskStatus,
} from "../db.js";
import { getGitHubAppConfig } from "../github-config.js";
import {
  buildGitHubLeaseEnforcementPlan,
  publishGitHubLeaseEnforcement,
  resolveGitHubLeaseEnforcementMode,
} from "../github-lease-enforcement.js";
import type { MaterializedGitHubRoomEvent } from "../github-room-events.js";
import {
  formatRepoRoomEventMessage,
  projectRepoRoomEvent,
  shouldAutoPromptForBoardProjection,
  type RepoRoomEvent,
} from "../repo-workflow.js";
import {
  createRepoRoomEventTaskResolver,
  emptyRepoRoomEventTaskResolution,
  getPullRequestWorkflowRef,
  toGitHubRoutingContext,
} from "../repo-event-task-resolution.js";
import type { FocusGitHubRoutingContext } from "../focus-room-settings.js";
import {
  buildFailedCheckRunTaskDescription,
  buildFailedCheckRunTaskTitle,
  isFailedCheckRunEvent,
  mergeFailedCheckRunTaskWorkflowArtifacts,
  shouldReopenTaskForFailedCheckRun,
} from "../check-run-autotasks.js";
import {
  evaluateWorkflowArtifactMutation,
  leaseMatchesWorkflowArtifact,
  type CoordinationDecisionResult,
} from "../coordination-policy/index.js";
import { emitProjectMessage } from "../server/events.js";
import {
  emitGitHubEventToAllParentRepoFocusRooms,
  emitTaskAnchoredMessage,
  emitTaskLifecycleStatusMessage,
  getFocusRoomForGitHubEventTask,
  getHardIsolatedFocusRoomForGitHubEvent,
  recordCoordinationDecision,
} from "../server/room-services.js";

const { resolveLinkedTaskForRepoRoomEvent } = createRepoRoomEventTaskResolver({
  findTaskByWorkflowArtifactMatches,
  findTaskByPrUrl,
  findTaskByActiveWorkflowLease: async (projectId, workflow) => {
    const findTaskInRoom = async (roomId: string): Promise<Task | undefined> => {
      const leases = await getActiveTaskLeases(roomId);
      const lease = leases.find((candidate) =>
        candidate.kind === "work" &&
        leaseMatchesWorkflowArtifact({
          lease: candidate,
          prUrl: workflow.prUrl,
          branchRef: workflow.branchRef,
        })
      );
      return lease ? getTaskById(roomId, lease.task_id) : undefined;
    };

    const parentTask = await findTaskInRoom(projectId);
    if (parentTask) {
      return parentTask;
    }

    const focusRooms = await getFocusRoomsForParent(projectId);
    for (const focusRoom of focusRooms) {
      if (focusRoom.focus_status === "concluded") {
        continue;
      }
      const focusTask = await findTaskInRoom(focusRoom.id);
      if (focusTask) {
        return focusTask;
      }
    }

    return undefined;
  },
  getTaskById,
});

async function getProjectForResolvedTask(
  fallbackProject: Project,
  linkedTask: Pick<Task, "room_id"> | undefined
): Promise<Project> {
  if (!linkedTask || linkedTask.room_id === fallbackProject.id) {
    return fallbackProject;
  }

  return (await getProjectById(linkedTask.room_id)) ?? fallbackProject;
}

async function maybePublishGitHubLeaseEnforcement(input: {
  project: Project;
  event: RepoRoomEvent;
  linkedTask: Task;
  decision: CoordinationDecisionResult;
  installationId: string | null;
}): Promise<void> {
  if (input.event.provider !== "github" || input.event.kind !== "pull_request") {
    return;
  }

  const plan = buildGitHubLeaseEnforcementPlan({
    action: input.event.action,
    linkedTaskId: input.linkedTask.id,
    pullRequest: input.event.pullRequest,
    decision: input.decision,
    mode: resolveGitHubLeaseEnforcementMode(),
  });
  if (!plan) {
    return;
  }

  try {
    const config = await getGitHubAppConfig();
    await publishGitHubLeaseEnforcement({
      config,
      installationId: input.installationId,
      repositoryFullName: input.event.repositoryFullName,
      pullRequestNumber: input.event.pullRequest.number,
      plan,
      detailsUrl: `${config.baseUrl}/in/${input.project.id}`,
    });
  } catch (error) {
    console.warn(
      "[github] failed to publish letagents-lease enforcement",
      error instanceof Error ? error.message : error
    );
  }
}

async function applyRepoRoomEventToTask(
  project: Project,
  linkedTask: Task | undefined,
  event: RepoRoomEvent,
  input: {
    installationId: string | null;
    githubRoutingContext: FocusGitHubRoutingContext;
  }
): Promise<{
  task: Task | undefined;
  authoritative: boolean;
}> {
  if (!linkedTask) {
    return { task: undefined, authoritative: false };
  }

  const pullRequest = getPullRequestWorkflowRef(event);
  if (pullRequest) {
    const [leases, locks] = await Promise.all([
      getActiveTaskLeases(project.id, linkedTask.id),
      getActiveTaskLocks(project.id, linkedTask.id),
    ]);
    const decision = evaluateWorkflowArtifactMutation({
      mutation: "webhook_projection",
      taskId: linkedTask.id,
      prUrl: pullRequest.url,
      branchRef: pullRequest.headRef,
      leases,
      locks,
    });

    await recordCoordinationDecision({
      roomId: project.id,
      taskId: linkedTask.id,
      mutation: "webhook_projection",
      decision: decision.kind,
      actorLabel: event.senderLogin ? `github:${event.senderLogin}` : "github",
      actorKey: null,
      actorInstanceId: null,
      reason: decision.kind === "deny"
        ? decision.reason
        : `Allowed webhook_projection with lease ${decision.lease.id}.`,
      leaseId: decision.kind === "allow"
        ? decision.lease.id
        : decision.lease?.id ?? null,
      lockId: decision.kind === "deny" ? decision.lock?.id ?? null : null,
    });

    await maybePublishGitHubLeaseEnforcement({
      project,
      event,
      linkedTask,
      decision,
      installationId: input.installationId,
    });

    if (decision.kind === "deny") {
      await emitTaskAnchoredMessage(
        project.id,
        "letagents",
        `[status] Ignored unleased GitHub ${event.kind} projection for ${linkedTask.id}: ${decision.reason}`,
        linkedTask,
        {
          parent_activity: "GitHub projection",
          parent_event_kind: "major_activity",
          event_kind: "github",
          github_routing_context: input.githubRoutingContext,
        }
      );
      return { task: linkedTask, authoritative: false };
    }

    await updateTaskLeaseWorkflowRefs(project.id, decision.lease.id, {
      pr_url: pullRequest.url,
      ...(pullRequest.headRef ? { branch_ref: pullRequest.headRef } : {}),
    });
  }

  const updates: { status?: TaskStatus; pr_url?: string } = {};
  if (event.kind === "pull_request" && linkedTask.pr_url !== event.pullRequest.url) {
    updates.pr_url = event.pullRequest.url;
  }

  const projectedTaskState = projectRepoRoomEvent({
    event,
    currentStatus: linkedTask.status,
  });

  if (projectedTaskState) {
    updates.status = projectedTaskState.newStatus as TaskStatus;
    if (event.kind === "pull_request") {
      updates.pr_url = event.pullRequest.url;
    }
  }

  if (!updates.status && !updates.pr_url) {
    return { task: linkedTask, authoritative: true };
  }

  const nextTask = await updateTask(project.id, linkedTask.id, updates);
  if (nextTask) {
    if (updates.status) {
      await emitTaskLifecycleStatusMessage(project.id, nextTask, {
        agent_prompt_kind: shouldAutoPromptForBoardProjection(projectedTaskState)
          ? "auto"
          : null,
        event_kind: "github",
        github_routing_context: input.githubRoutingContext,
      });
    }
    return { task: nextTask, authoritative: true };
  }

  return { task: linkedTask, authoritative: true };
}

export async function persistMaterializedGitHubRoomEvent(
  event: MaterializedGitHubRoomEvent,
  input: {
    deliveryId: string;
    roomId?: string | null;
    linkedTaskId?: string | null;
  }
): Promise<{ duplicate: boolean }> {
  const { duplicate } = await insertGitHubRoomEvent({
    room_id: input.roomId ?? null,
    delivery_id: input.deliveryId,
    event_type: event.event_type,
    action: event.action,
    idempotency_key: event.idempotency_key,
    github_object_id: event.github_object_id,
    github_object_url: event.github_object_url,
    title: event.title,
    state: event.state,
    actor_login: event.actor_login,
    metadata: event.metadata,
    linked_task_id: input.linkedTaskId ?? null,
  });

  return { duplicate };
}

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

  const message = formatRepoRoomEventMessage({
    event: roomEvent,
    linkedTaskId: taskProjection.authoritative ? linkedTask?.id ?? null : null,
    redactUntrustedTaskReference: !taskProjection.authoritative && Boolean(linkedTask),
  });
  if (message) {
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

  return {
    status: "processed",
    installationId: input.installationId,
    githubRepoId: input.githubRepoId,
    roomId: project.id,
  };
}

async function maybeAutoCreateTaskForFailedCheckRun(
  project: Project,
  linkedTask: Task | undefined,
  event: Extract<RepoRoomEvent, { kind: "check_run" }>,
  options?: {
    githubRoutingContext?: FocusGitHubRoutingContext;
  }
): Promise<Task | undefined> {
  if (!isFailedCheckRunEvent(event)) {
    return linkedTask;
  }

  const workflowArtifacts = mergeFailedCheckRunTaskWorkflowArtifacts(
    linkedTask?.workflow_artifacts ?? [],
    event
  );

  if (linkedTask) {
    if (shouldReopenTaskForFailedCheckRun(linkedTask)) {
      const reopenedTask = await updateTask(project.id, linkedTask.id, {
        status: "accepted",
        assignee: null,
        workflow_artifacts: workflowArtifacts,
      });
      if (reopenedTask) {
        await emitTaskLifecycleStatusMessage(project.id, reopenedTask, {
          agent_prompt_kind: "auto",
          event_kind: "github",
          github_routing_context: options?.githubRoutingContext,
        });
        return reopenedTask;
      }
      return linkedTask;
    }

    const artifactsChanged =
      JSON.stringify(workflowArtifacts) !== JSON.stringify(linkedTask.workflow_artifacts);
    if (!artifactsChanged) {
      return linkedTask;
    }

    return (
      (await updateTask(project.id, linkedTask.id, {
        workflow_artifacts: workflowArtifacts,
      })) ?? linkedTask
    );
  }

  const task = await createTask(
    project.id,
    buildFailedCheckRunTaskTitle(event),
    "letagents",
    buildFailedCheckRunTaskDescription(event)
  );

  const acceptedTask = await updateTask(project.id, task.id, {
    status: "accepted",
    workflow_artifacts: workflowArtifacts,
  });
  if (acceptedTask) {
    await emitTaskLifecycleStatusMessage(project.id, acceptedTask, {
      agent_prompt_kind: "auto",
    });
    return acceptedTask;
  }

  return task;
}
