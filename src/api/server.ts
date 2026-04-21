import { EventEmitter } from "events";
import express from "express";

import {
  addMessage,
  createCoordinationEvent,
  createTask,
  createTaskLease,
  findTaskByPrUrl,
  findTaskByWorkflowArtifactMatches,
  getAgentIdentityByCanonicalKey,
  getGitHubAppRepositoryByFullName,
  getActiveFocusRoomForTask,
  getFocusRoomsForParent,
  getOpenTasks,
  getProjectById,
  insertGitHubRoomEvent,
  getActiveTaskLeases,
  getActiveTaskLocks,
  getTaskById,
  getTaskOwnershipState,
  getTasks,
  getStaleTaskPromptMutes,
  hasMessagesFromSender,
  markGitHubAppInstallationUninstalled,
  markGitHubAppRepositoryRemoved,
  migrateGitHubRepositoryCanonicalRoom,
  setGitHubAppInstallationSuspended,
  updateGitHubRoomEventLinkedTaskId,
  updateTaskLeaseWorkflowRefs,
  upsertGitHubAppInstallation,
  upsertGitHubAppRepository,
  upsertGitHubRepositoryLink,
  upsertRoomParticipant,
  updateTask,
  getRoomAgentPresence,
  type GitHubWebhookDeliveryStatus,
  type Message,
  type Project,
  type Task,
  type TaskLeaseKind,
  type TaskStatus,
} from "./db.js";
import { getGitHubAppConfig, hasGitHubAppConfig } from "./github-config.js";
import {
  buildGitHubLeaseEnforcementPlan,
  buildLeasedBranchRef,
  publishGitHubLeaseEnforcement,
  resolveGitHubLeaseEnforcementMode,
} from "./github-lease-enforcement.js";
import {
  buildGitHubRepoRoomId,
  getGitHubRepositoryOwnerLogin,
  type GitHubWebhookPayload,
} from "./github-app.js";
import {
  createGitHubAppSync,
  toGitHubWebhookId,
} from "./github-app-sync.js";
import {
  materializeGitHubWebhookEvent,
  type MaterializedGitHubRoomEvent,
} from "./github-room-events.js";
import {
  formatRepoRoomEventMessage,
  projectRepoRoomEvent,
  shouldAutoPromptForBoardProjection,
  type RepoRoomEvent,
} from "./repo-workflow.js";
import {
  createRepoRoomEventTaskResolver,
  emptyRepoRoomEventTaskResolution,
  getPullRequestWorkflowRef,
  toGitHubRoutingContext,
} from "./repo-event-task-resolution.js";
import type { FocusGitHubRoutingContext } from "./focus-room-settings.js";
import {
  formatFocusRoomConclusionMessage,
  toRoomResponse,
} from "./room-formatting.js";
import { createGitHubFocusIsolationResolver } from "./github-focus-isolation.js";
import { createStaleWorkPromptEmitter } from "./stale-work.js";
import {
  buildFailedCheckRunTaskDescription,
  buildFailedCheckRunTaskTitle,
  isFailedCheckRunEvent,
  mergeFailedCheckRunTaskWorkflowArtifacts,
  shouldReopenTaskForFailedCheckRun,
} from "./check-run-autotasks.js";
import {
  getProjectAccessRoomId,
  isRepoBackedProject,
  isRepoBackedRoomId,
  replyRepoRoomAccessDecision,
  requireAdmin,
  requireParticipant,
  resolveGitHubRoomEntryDecision,
  resolveProjectRole,
  resolveRepoRoomAccessDecision,
} from "./room-access.js";
import {
  resolveCanonicalRoomRequestId,
  resolveRoomOrReply,
} from "./room-resolution.js";
import { createRoomParticipantRecorder } from "./room-participants.js";
import {
  buildTaskUpdatePatch,
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
} from "./task-ownership.js";
import {
  classifyTaskCoordinationMutation,
  getTaskUpdatePrUrlBinding,
  normalizeOptionalString,
} from "./task-coordination-inputs.js";
import {
  evaluateTaskAdmission,
  evaluateCoordinationMutation,
  evaluateWorkflowArtifactMutation,
  findApplicableLock,
  type CoordinationDecisionResult,
  type CoordinationMutationKind,
} from "./coordination-policy.js";
import type { AgentPromptKind } from "../shared/room-agent-prompts.js";
import {
  parseOptionalAgentPromptKind,
  parseOptionalReplyToMessageId,
  shouldIncludePromptOnlyMessages,
} from "./message-inputs.js";
import { createTaskActivityMessageEmitters } from "./task-activity-messages.js";
import {
  respondWithError,
  type AuthenticatedRequest,
} from "./http-helpers.js";
import {
  registerHttpMiddleware,
  type HttpMiddlewareDeps,
} from "./http-middleware.js";
import { resolveRequestAuth } from "./request-auth.js";
import { registerWebRoutes } from "./routes/web.js";
import {
  registerAuthRoutes,
  registerGitHubAppCallbackRoute,
} from "./routes/auth.js";
import {
  registerGitHubIntegrationRoutes,
  registerGitHubIntegrationSetupRoute,
} from "./routes/github-integration.js";
import {
  registerLegacyProjectRoutes,
  type LegacyProjectRouteDeps,
} from "./routes/legacy-projects.js";
import {
  registerLegacyProjectMessageRoutes,
  type LegacyProjectMessageRouteDeps,
} from "./routes/legacy-project-messages.js";
import {
  registerLegacyProjectTaskRoutes,
  type LegacyProjectTaskRouteDeps,
} from "./routes/legacy-project-tasks.js";
import {
  registerRoomMessageRoutes,
  type RoomMessageRouteDeps,
} from "./routes/room-messages.js";
import {
  registerRoomPresenceRoutes,
  type RoomPresenceRouteDeps,
} from "./routes/room-presence.js";
import {
  registerRoomFocusRoutes,
  type RoomFocusRouteDeps,
} from "./routes/room-focus.js";
import {
  registerRoomTaskRoutes,
  type RoomTaskRouteDeps,
} from "./routes/room-tasks.js";
import {
  registerRoomEventRoutes,
  type RoomEventRouteDeps,
} from "./routes/room-events.js";
import {
  registerRoomMetadataRoutes,
  type RoomMetadataRouteDeps,
} from "./routes/room-metadata.js";
import {
  registerRoomEntryRoutes,
  type RoomEntryRouteDeps,
} from "./routes/room-entry.js";
import {
  registerRoomJoinRoutes,
  type RoomJoinRouteDeps,
} from "./routes/room-join.js";
import {
  registerGitHubWebhookRoutes,
  type GitHubWebhookRouteDeps,
} from "./routes/github-webhooks.js";
import { registerHealthRoutes } from "./routes/health.js";

interface MessageCreatedEvent {
  projectId: string;
  message: Message;
}

const messageEvents = new EventEmitter();
const taskEvents = new EventEmitter();
const {
  rememberHumanRoomParticipant,
  rememberAgentRoomParticipant,
  rememberRoomParticipantFromMessage,
} = createRoomParticipantRecorder({ upsertRoomParticipant });
const {
  syncGitHubAppInstallationFromPayload,
  syncGitHubAppRepositoryFromPayload,
} = createGitHubAppSync({
  getGitHubAppRepositoryByFullName,
  upsertGitHubAppInstallation,
  upsertGitHubAppRepository,
  upsertGitHubRepositoryLink,
});
const {
  resolveLinkedTaskForRepoRoomEvent,
} = createRepoRoomEventTaskResolver({
  findTaskByWorkflowArtifactMatches,
  findTaskByPrUrl,
  getTaskById,
});

async function emitProjectMessage(
  projectId: string,
  sender: string,
  text: string,
  options?: {
    source?: string;
    agent_prompt_kind?: AgentPromptKind | null;
    reply_to?: string | null;
  }
): Promise<Message> {
  const message = await addMessage(projectId, sender, text, {
    source: options?.source,
    agent_prompt_kind: options?.agent_prompt_kind ?? null,
    reply_to_message_id: options?.reply_to ?? null,
  });
  messageEvents.emit("message:created", { projectId, message } satisfies MessageCreatedEvent);
  return message;
}

const {
  getActiveTaskFocusRoom,
  emitTaskAnchoredMessage,
  emitGitHubEventToAllParentRepoFocusRooms,
  emitTaskLifecycleStatusMessage,
} = createTaskActivityMessageEmitters({
  getProjectById: async (projectId) => (await getProjectById(projectId)) ?? null,
  getActiveFocusRoomForTask: async (projectId, taskId) =>
    (await getActiveFocusRoomForTask(projectId, taskId)) ?? null,
  getFocusRoomsForParent,
  emitProjectMessage,
});
const {
  getHardIsolatedFocusRoomForGitHubEvent,
} = createGitHubFocusIsolationResolver({ getActiveTaskFocusRoom });
const { maybeEmitStaleWorkPrompt } = createStaleWorkPromptEmitter({
  getOpenTasks,
  getRoomAgentPresence,
  getStaleTaskPromptMutes: async (projectId, options) =>
    getStaleTaskPromptMutes(projectId, options.taskIds),
  emitTaskAnchoredMessage,
});

async function validateOwnerTokenTaskActorKey(input: {
  req: AuthenticatedRequest;
  actorKey: string | null;
}): Promise<{ actorKey: string | null; error: string | null }> {
  const { req, actorKey } = input;

  if (req.authKind !== "owner_token") {
    return {
      actorKey,
      error: null,
    };
  }

  if (!actorKey) {
    return {
      actorKey: null,
      error: "actor_key is required for agent-owned task transitions",
    };
  }

  const actorIdentity = await getAgentIdentityByCanonicalKey(actorKey);
  if (!actorIdentity || actorIdentity.owner_account_id !== req.sessionAccount?.account_id) {
    return {
      actorKey: null,
      error: "actor_key must belong to the authenticated agent owner",
    };
  }

  return {
    actorKey: actorIdentity.canonical_key,
    error: null,
  };
}

type TaskUpdatePatch = ReturnType<typeof buildTaskUpdatePatch>["updates"];

type TaskCoordinationGuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; error: string };

async function bindWorkflowArtifactPrUrlIfPresent(
  roomId: string,
  leaseId: string,
  updates: TaskUpdatePatch
): Promise<void> {
  const prUrl = getTaskUpdatePrUrlBinding(updates);
  if (prUrl === undefined) {
    return;
  }

  await updateTaskLeaseWorkflowRefs(roomId, leaseId, { pr_url: prUrl });
}

async function recordCoordinationDecision(input: {
  roomId: string;
  taskId: string | null;
  mutation: CoordinationMutationKind;
  decision: "allow" | "deny";
  actorLabel: string | null;
  actorKey: string | null;
  actorInstanceId: string | null;
  reason?: string | null;
  leaseId?: string | null;
  lockId?: string | null;
}): Promise<void> {
  await createCoordinationEvent({
    room_id: input.roomId,
    task_id: input.taskId,
    event_type: input.mutation,
    decision: input.decision,
    actor_label: input.actorLabel,
    actor_key: input.actorKey,
    actor_instance_id: input.actorInstanceId,
    reason: input.reason ?? null,
    lease_id: input.leaseId ?? null,
    lock_id: input.lockId ?? null,
  });
}

async function enforceTaskAdmissionCoordination(input: {
  req: AuthenticatedRequest;
  projectId: string;
  title: string;
  sourceMessageId?: string | null;
  actorLabel: string | null;
  actorKey: string | null;
  actorInstanceId: string | null;
}): Promise<TaskCoordinationGuardDecision> {
  if (input.req.authKind !== "owner_token") {
    return { kind: "allow" };
  }

  const actorLabel = normalizeTaskActorLabel(input.actorLabel);
  const actorKey = normalizeTaskActorKey(input.actorKey);

  const locks = await getActiveTaskLocks(input.projectId);
  const lock = findApplicableLock({ locks, taskId: null });
  if (lock) {
    await recordCoordinationDecision({
      roomId: input.projectId,
      taskId: null,
      mutation: "task_admit",
      decision: "deny",
      actorLabel,
      actorKey,
      actorInstanceId: input.actorInstanceId,
      reason: `Task admission is blocked by ${lock.reason} lock ${lock.id}.`,
      lockId: lock.id,
    });
    return {
      kind: "deny",
      code: "coordination_active_lock",
      error: `Task admission is blocked by ${lock.reason} lock ${lock.id}.`,
    };
  }

  const [tasks, focusRooms, leases] = await Promise.all([
    getTasks(input.projectId, undefined, { limit: 500 }),
    getFocusRoomsForParent(input.projectId),
    getActiveTaskLeases(input.projectId),
  ]);
  const admission = evaluateTaskAdmission({
    intent: {
      sourceMessageId: input.sourceMessageId,
      outputIntent: input.title,
    },
    tasks: tasks.tasks,
    focusRooms: focusRooms.map((focusRoom) => ({
      room_id: focusRoom.id,
      focus_key: focusRoom.focus_key,
      source_task_id: focusRoom.source_task_id,
      focus_status: focusRoom.focus_status,
    })),
    leases,
  });
  if (admission.kind === "route_to_review") {
    await recordCoordinationDecision({
      roomId: input.projectId,
      taskId: null,
      mutation: "task_admit",
      decision: "deny",
      actorLabel,
      actorKey,
      actorInstanceId: input.actorInstanceId,
      reason: admission.reason,
      leaseId: admission.duplicate.lease?.id ?? null,
    });
    return {
      kind: "deny",
      code: "coordination_duplicate_work",
      error: admission.reason,
    };
  }

  return { kind: "allow" };
}

async function issueWorkLeaseForActor(input: {
  roomId: string;
  taskId: string;
  actorLabel: string;
  actorKey: string;
  actorInstanceId: string | null;
  mutation: CoordinationMutationKind;
  outputIntent?: string | null;
}) {
  const lease = await createTaskLease({
    room_id: input.roomId,
    task_id: input.taskId,
    kind: "work",
    agent_key: input.actorKey,
    agent_instance_id: input.actorInstanceId,
    actor_label: input.actorLabel,
    branch_ref: buildLeasedBranchRef({
      taskId: input.taskId,
      agentKey: input.actorKey,
    }),
    created_by: input.actorLabel,
    output_intent: input.outputIntent ?? input.mutation,
  });
  await recordCoordinationDecision({
    roomId: input.roomId,
    taskId: input.taskId,
    mutation: input.mutation,
    decision: "allow",
    actorLabel: input.actorLabel,
    actorKey: input.actorKey,
    actorInstanceId: input.actorInstanceId,
    leaseId: lease.id,
    reason: `Issued ${lease.kind} lease ${lease.id} for ${input.mutation}.`,
  });
  return lease;
}

function taskIsAssignedToActor(input: {
  taskOwnership: NonNullable<Awaited<ReturnType<typeof getTaskOwnershipState>>>;
  actorLabel: string;
  actorKey: string;
}): boolean {
  const assignedKey = normalizeTaskActorKey(input.taskOwnership.assignee_agent_key);
  if (assignedKey) {
    return assignedKey === input.actorKey;
  }

  return normalizeTaskActorLabel(input.taskOwnership.assignee) === input.actorLabel;
}

async function enforceTaskCoordinationMutation(input: {
  req: AuthenticatedRequest;
  projectId: string;
  task: Task;
  taskOwnership: NonNullable<Awaited<ReturnType<typeof getTaskOwnershipState>>>;
  updates: TaskUpdatePatch;
  forcedMutation?: { mutation: CoordinationMutationKind; leaseKind: TaskLeaseKind };
  actorLabel: string | null;
  actorKey: string | null;
  actorInstanceId: string | null;
}): Promise<TaskCoordinationGuardDecision> {
  if (input.req.authKind !== "owner_token") {
    return { kind: "allow" };
  }

  const classified = input.forcedMutation
    ? { ...input.forcedMutation, claim: false }
    : classifyTaskCoordinationMutation(input.updates);
  if (!classified) {
    return { kind: "allow" };
  }

  const actorLabel = normalizeTaskActorLabel(input.actorLabel);
  const requestedActorKey = normalizeTaskActorKey(input.actorKey);
  if (!actorLabel || !requestedActorKey) {
    return {
      kind: "deny",
      code: "coordination_missing_actor",
      error: "actor_label and actor_key are required for coordinated task mutations",
    };
  }
  const verified = await validateOwnerTokenTaskActorKey({
    req: input.req,
    actorKey: requestedActorKey,
  });
  if (verified.error || !verified.actorKey) {
    return {
      kind: "deny",
      code: "coordination_invalid_actor",
      error: verified.error ?? "actor_key must belong to the authenticated agent owner",
    };
  }
  const actorKey = verified.actorKey;

  const [leases, locks] = await Promise.all([
    getActiveTaskLeases(input.projectId, input.task.id),
    getActiveTaskLocks(input.projectId, input.task.id),
  ]);
  const decision = evaluateCoordinationMutation({
    mutation: classified.mutation,
    taskId: input.task.id,
    requiredLeaseKind: classified.leaseKind,
    actor: {
      actorLabel,
      agentKey: actorKey,
      agentInstanceId: input.actorInstanceId,
    },
    leases,
    locks,
  });

  if (decision.kind === "allow") {
    await recordCoordinationDecision({
      roomId: input.projectId,
      taskId: input.task.id,
      mutation: classified.mutation,
      decision: "allow",
      actorLabel,
      actorKey,
      actorInstanceId: input.actorInstanceId,
      leaseId: decision.lease.id,
      reason: `Allowed ${classified.mutation} with lease ${decision.lease.id}.`,
    });
    if (classified.mutation === "workflow_artifact_attach") {
      await bindWorkflowArtifactPrUrlIfPresent(input.projectId, decision.lease.id, input.updates);
    }
    return { kind: "allow" };
  }

  if (decision.code === "missing_lease") {
    if (classified.claim && input.task.status === "accepted") {
      const lease = await issueWorkLeaseForActor({
        roomId: input.projectId,
        taskId: input.task.id,
        actorLabel,
        actorKey,
        actorInstanceId: input.actorInstanceId,
        mutation: classified.mutation,
        outputIntent: input.task.title,
      });
      if (classified.mutation === "workflow_artifact_attach") {
        await bindWorkflowArtifactPrUrlIfPresent(input.projectId, lease.id, input.updates);
      }
      return { kind: "allow" };
    }

    if (
      !classified.claim &&
      taskIsAssignedToActor({
        taskOwnership: input.taskOwnership,
        actorLabel,
        actorKey,
      })
    ) {
      const lease = await issueWorkLeaseForActor({
        roomId: input.projectId,
        taskId: input.task.id,
        actorLabel,
        actorKey,
        actorInstanceId: input.actorInstanceId,
        mutation: classified.mutation,
        outputIntent: input.task.title,
      });
      if (classified.mutation === "workflow_artifact_attach") {
        await bindWorkflowArtifactPrUrlIfPresent(input.projectId, lease.id, input.updates);
      }
      return { kind: "allow" };
    }
  }

  await recordCoordinationDecision({
    roomId: input.projectId,
    taskId: input.task.id,
    mutation: classified.mutation,
    decision: "deny",
    actorLabel,
    actorKey,
    actorInstanceId: input.actorInstanceId,
    reason: decision.reason,
    leaseId: decision.lease?.id ?? null,
    lockId: decision.lock?.id ?? null,
  });
  return {
    kind: "deny",
    code: `coordination_${decision.code}`,
    error: decision.reason,
  };
}

async function isTrustedAgentCreator(projectId: string, createdBy: string): Promise<boolean> {
  const normalizedSender = createdBy.trim().toLowerCase();
  if (!normalizedSender || normalizedSender === "human" || normalizedSender === "letagents") {
    return false;
  }

  return hasMessagesFromSender(projectId, createdBy);
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

async function persistMaterializedGitHubRoomEvent(
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

async function handleMaterializedGitHubRoomEvent(
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
    linkedTask = await maybeAutoCreateTaskForFailedCheckRun(project, linkedTask, roomEvent, {
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

  const taskProjection = await applyRepoRoomEventToTask(project, linkedTask, roomEvent, {
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
      ? await getActiveTaskFocusRoom(project.id, linkedTask.id)
      : null;
    if (taskProjection.authoritative && linkedTask) {
      await emitTaskAnchoredMessage(project.id, "github", message, linkedTask, {
        source: "github",
        parent_activity: "GitHub activity",
        parent_event_kind: "major_activity",
        event_kind: "github",
        github_routing_context: githubRoutingContext,
      });
    } else if (linkedTask && isolatedFocusRoom) {
      await emitTaskAnchoredMessage(project.id, "github", message, linkedTask, {
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

async function emitGitHubPullRequestEvent(
  project: Project,
  payload: GitHubWebhookPayload,
  deliveryId: string
): Promise<{
  status: Exclude<GitHubWebhookDeliveryStatus, "received">;
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}> {
  const installationId =
    (await syncGitHubAppInstallationFromPayload(payload)) ??
    toGitHubWebhookId(payload.installation?.id);
  const repositorySync = await syncGitHubAppRepositoryFromPayload(payload.repository, installationId);
  const roomId = repositorySync.roomId ?? project.id;

  if (!payload.repository || !payload.pull_request || !payload.action) {
    return {
      status: "ignored",
      installationId: repositorySync.installationId,
      githubRepoId: repositorySync.githubRepoId,
      roomId,
    };
  }

  const materializedEvent = materializeGitHubWebhookEvent("pull_request", payload, deliveryId);
  if (!materializedEvent) {
    return {
      status: "ignored",
      installationId: repositorySync.installationId,
      githubRepoId: repositorySync.githubRepoId,
      roomId,
    };
  }

  return handleMaterializedGitHubRoomEvent(project, materializedEvent, {
    deliveryId,
    installationId: repositorySync.installationId,
    githubRepoId: repositorySync.githubRepoId,
  });
}

async function handleGitHubWebhookEvent(
  eventName: string,
  payload: GitHubWebhookPayload,
  deliveryId: string
): Promise<{
  status: Exclude<GitHubWebhookDeliveryStatus, "received">;
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}> {
  const installationId = toGitHubWebhookId(payload.installation?.id);
  const githubRepoId = toGitHubWebhookId(payload.repository?.id);
  const roomId = payload.repository?.full_name
    ? buildGitHubRepoRoomId(payload.repository.full_name)
    : null;

  if (eventName === "ping") {
    return {
      status: "processed",
      installationId,
      githubRepoId,
      roomId,
    };
  }

  switch (eventName) {
    case "installation": {
      if (!installationId || !payload.action) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      const materializedEvent = materializeGitHubWebhookEvent(eventName, payload, deliveryId);
      const now = new Date().toISOString();
      if (payload.action === "deleted") {
        await markGitHubAppInstallationUninstalled(installationId, now);
        if (materializedEvent) {
          await persistMaterializedGitHubRoomEvent(materializedEvent, {
            deliveryId,
          });
        }
        return {
          status: "processed",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      if (payload.action === "suspend") {
        const syncedInstallationId = await syncGitHubAppInstallationFromPayload(payload, {
          suspended_at: now,
          uninstalled_at: null,
        });
        if (!payload.installation?.account) {
          await setGitHubAppInstallationSuspended(installationId, now);
        }
        if (materializedEvent) {
          await persistMaterializedGitHubRoomEvent(materializedEvent, {
            deliveryId,
          });
        }
        return {
          status: "processed",
          installationId: syncedInstallationId ?? installationId,
          githubRepoId,
          roomId,
        };
      }

      if (payload.action === "unsuspend") {
        const syncedInstallationId = await syncGitHubAppInstallationFromPayload(payload, {
          suspended_at: null,
          uninstalled_at: null,
        });
        if (!payload.installation?.account) {
          await setGitHubAppInstallationSuspended(installationId, null);
        }
        if (syncedInstallationId && materializedEvent) {
          await persistMaterializedGitHubRoomEvent(materializedEvent, {
            deliveryId,
          });
        }
        return {
          status: syncedInstallationId ? "processed" : "ignored",
          installationId: syncedInstallationId ?? installationId,
          githubRepoId,
          roomId,
        };
      }

      const syncedInstallationId = await syncGitHubAppInstallationFromPayload(payload, {
        suspended_at: null,
        uninstalled_at: null,
      });
      if (syncedInstallationId && materializedEvent) {
        await persistMaterializedGitHubRoomEvent(materializedEvent, {
          deliveryId,
        });
      }
      return {
        status: syncedInstallationId ? "processed" : "ignored",
        installationId: syncedInstallationId ?? installationId,
        githubRepoId,
        roomId,
      };
    }

    case "installation_repositories": {
      if (!installationId) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      const syncedInstallationId =
        (await syncGitHubAppInstallationFromPayload(payload, {
          suspended_at: null,
          uninstalled_at: null,
        })) ?? installationId;

      for (const repository of payload.repositories_added ?? []) {
        await syncGitHubAppRepositoryFromPayload(repository, syncedInstallationId);
      }

      for (const repository of payload.repositories_removed ?? []) {
        const repositoryId = toGitHubWebhookId(repository.id);
        if (!repositoryId) {
          continue;
        }

        await markGitHubAppRepositoryRemoved(repositoryId);
      }

      const materializedEvent = materializeGitHubWebhookEvent(eventName, payload, deliveryId);
      if (materializedEvent) {
        await persistMaterializedGitHubRoomEvent(materializedEvent, {
          deliveryId,
        });
      }

      return {
        status: "processed",
        installationId: syncedInstallationId,
        githubRepoId,
        roomId,
      };
    }

    case "pull_request": {
      if (!payload.repository) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      const project = await getProjectById(roomId ?? "");
      if (!project) {
        const repositorySync = await syncGitHubAppRepositoryFromPayload(
          payload.repository,
          (await syncGitHubAppInstallationFromPayload(payload)) ?? installationId
        );
        return {
          status: "ignored",
          installationId: repositorySync.installationId,
          githubRepoId: repositorySync.githubRepoId,
          roomId: repositorySync.roomId,
        };
      }

      return emitGitHubPullRequestEvent(project, payload, deliveryId);
    }

    case "repository": {
      if (!payload.repository || !payload.action) {
        return {
          status: "ignored",
          installationId,
          githubRepoId,
          roomId,
        };
      }

      // Sync installation first (doesn't touch room mapping)
      const syncedInstallationId =
        (await syncGitHubAppInstallationFromPayload(payload)) ?? installationId;

      // For rename/transfer: migrate BEFORE syncing repo records to new path
      if (payload.action === "renamed" || payload.action === "transferred") {
        const currentOwner = getGitHubRepositoryOwnerLogin(payload.repository);
        const currentName = payload.repository.name;
        const currentFullName = payload.repository.full_name;
        const repoId = toGitHubWebhookId(payload.repository.id);

        // Compute the old full_name from changes
        let oldFullName: string | null = null;
        if (payload.action === "renamed" && payload.changes?.repository?.name?.from) {
          const oldName = payload.changes.repository.name.from;
          oldFullName = `${currentOwner}/${oldName}`;
        } else if (payload.action === "transferred" && payload.changes?.owner?.from?.login) {
          const oldOwner = payload.changes.owner.from.login;
          oldFullName = `${oldOwner}/${currentName}`;
        }

        // Migrate the canonical room ID FIRST (before sync updates the mapping)
        let migratedRoom = null;
        if (repoId) {
          migratedRoom = await migrateGitHubRepositoryCanonicalRoom({
            github_repo_id: repoId,
            owner_login: currentOwner,
            repo_name: currentName,
          });
        }

        // NOW sync repo records to the new path (safe because migration already ran)
        const repositorySync = await syncGitHubAppRepositoryFromPayload(
          payload.repository,
          syncedInstallationId
        );

        const repositoryEvent = materializeGitHubWebhookEvent("repository", payload, deliveryId);
        const fallbackRoom =
          migratedRoom ??
          (repositorySync.roomId ? await getProjectById(repositorySync.roomId) : null) ??
          (oldFullName ? await getProjectById(buildGitHubRepoRoomId(oldFullName)) : null);
        if (fallbackRoom && repositoryEvent) {
          await handleMaterializedGitHubRoomEvent(fallbackRoom, repositoryEvent, {
            deliveryId,
            installationId: syncedInstallationId,
            githubRepoId: repositorySync.githubRepoId,
          });
        }

        return {
          status: "processed",
          installationId: syncedInstallationId,
          githubRepoId: repositorySync.githubRepoId,
          roomId: repositorySync.roomId,
        };
      }

      // For non-rename/transfer actions, sync normally
      const repositorySync = await syncGitHubAppRepositoryFromPayload(
        payload.repository,
        syncedInstallationId
      );

      return {
        status: "ignored",
        installationId: syncedInstallationId,
        githubRepoId: repositorySync.githubRepoId,
        roomId: repositorySync.roomId,
      };
    }

    case "issues": {
      const materializedEvent = materializeGitHubWebhookEvent(eventName, payload, deliveryId);
      if (!materializedEvent) {
        return { status: "ignored", installationId, githubRepoId, roomId };
      }
      const project = await getProjectById(roomId ?? "");
      if (!project) {
        return { status: "ignored", installationId, githubRepoId, roomId };
      }
      return handleMaterializedGitHubRoomEvent(project, materializedEvent, {
        deliveryId,
        installationId,
        githubRepoId,
      });
    }

    case "issue_comment": {
      const materializedEvent = materializeGitHubWebhookEvent(eventName, payload, deliveryId);
      if (!materializedEvent) {
        return { status: "ignored", installationId, githubRepoId, roomId };
      }
      const project = await getProjectById(roomId ?? "");
      if (!project) {
        return { status: "ignored", installationId, githubRepoId, roomId };
      }
      return handleMaterializedGitHubRoomEvent(project, materializedEvent, {
        deliveryId,
        installationId,
        githubRepoId,
      });
    }

    case "pull_request_review": {
      const materializedEvent = materializeGitHubWebhookEvent(eventName, payload, deliveryId);
      if (!materializedEvent) {
        return { status: "ignored", installationId, githubRepoId, roomId };
      }
      const project = await getProjectById(roomId ?? "");
      if (!project) {
        return { status: "ignored", installationId, githubRepoId, roomId };
      }
      return handleMaterializedGitHubRoomEvent(project, materializedEvent, {
        deliveryId,
        installationId,
        githubRepoId,
      });
    }

    case "check_run": {
      const materializedEvent = materializeGitHubWebhookEvent(eventName, payload, deliveryId);
      if (!materializedEvent) {
        return { status: "ignored", installationId, githubRepoId, roomId };
      }
      const project = await getProjectById(roomId ?? "");
      if (!project) {
        return { status: "ignored", installationId, githubRepoId, roomId };
      }
      return handleMaterializedGitHubRoomEvent(project, materializedEvent, {
        deliveryId,
        installationId,
        githubRepoId,
      });
    }

    default:
      return {
        status: "ignored",
        installationId,
        githubRepoId,
        roomId,
      };
  }
}

const app = express();

const httpMiddlewareDeps = {
  resolveRequestAuth,
} satisfies HttpMiddlewareDeps;

registerHttpMiddleware(app, httpMiddlewareDeps);

const roomEntryRouteDeps = {
  isRepoBackedRoomId,
  resolveGitHubRoomEntryDecision,
} satisfies RoomEntryRouteDeps;

registerWebRoutes(app);

registerRoomEntryRoutes(app, roomEntryRouteDeps);

const githubIntegrationRouteDeps = {
  resolveCanonicalRoomRequestId,
  resolveRoomOrReply,
  requireAdmin,
  requireParticipant,
  getProjectAccessRoomId,
  isRepoBackedProject,
};

const legacyProjectRouteDeps = {
  resolveRequestAuth,
  resolveCanonicalRoomRequestId,
  isRepoBackedRoomId,
  isRepoBackedProject,
  resolveRepoRoomAccessDecision,
  replyRepoRoomAccessDecision,
  resolveProjectRole,
  requireAdmin,
  rememberHumanRoomParticipant,
} satisfies LegacyProjectRouteDeps;

const legacyProjectMessageRouteDeps = {
  messageEvents,
  resolveCanonicalRoomRequestId,
  requireParticipant,
  parseOptionalAgentPromptKind,
  parseOptionalReplyToMessageId,
  shouldIncludePromptOnlyMessages,
  emitProjectMessage,
  rememberRoomParticipantFromMessage,
} satisfies LegacyProjectMessageRouteDeps;

const legacyProjectTaskRouteDeps = {
  resolveCanonicalRoomRequestId,
  requireAdmin,
  requireParticipant,
  normalizeOptionalString,
  enforceTaskAdmissionCoordination,
  isTrustedAgentCreator,
  emitTaskLifecycleStatusMessage,
  validateOwnerTokenTaskActorKey,
  enforceTaskCoordinationMutation,
} satisfies LegacyProjectTaskRouteDeps;

const roomMessageRouteDeps = {
  messageEvents,
  taskEvents,
  resolveCanonicalRoomRequestId,
  resolveRoomOrReply,
  requireParticipant,
  parseOptionalAgentPromptKind,
  parseOptionalReplyToMessageId,
  shouldIncludePromptOnlyMessages,
  emitProjectMessage,
  rememberRoomParticipantFromMessage,
} satisfies RoomMessageRouteDeps;

const roomPresenceRouteDeps = {
  resolveCanonicalRoomRequestId,
  resolveRoomOrReply,
  requireParticipant,
  rememberAgentRoomParticipant,
  maybeEmitStaleWorkPrompt,
} satisfies RoomPresenceRouteDeps;

const roomFocusRouteDeps = {
  resolveCanonicalRoomRequestId,
  resolveRoomOrReply,
  requireParticipant,
  resolveProjectRole,
  toRoomResponse,
  normalizeOptionalString,
  enforceFocusRoomConclusion: (input) => enforceTaskCoordinationMutation({
    ...input,
    updates: {},
    forcedMutation: { mutation: "focus_room_conclude", leaseKind: "work" },
  }),
  emitProjectMessage,
  formatFocusRoomConclusionMessage,
} satisfies RoomFocusRouteDeps;

const roomTaskRouteDeps = {
  taskEvents,
  resolveCanonicalRoomRequestId,
  resolveRoomOrReply,
  requireAdmin,
  requireParticipant,
  resolveProjectRole,
  toRoomResponse,
  normalizeOptionalString,
  enforceTaskAdmissionCoordination,
  isTrustedAgentCreator,
  emitTaskLifecycleStatusMessage,
  validateOwnerTokenTaskActorKey,
  enforceTaskCoordinationMutation,
  emitProjectMessage,
} satisfies RoomTaskRouteDeps;

const roomEventRouteDeps = {
  resolveCanonicalRoomRequestId,
  resolveRoomOrReply,
  requireParticipant,
  getProjectAccessRoomId,
} satisfies RoomEventRouteDeps;

const roomMetadataRouteDeps = {
  resolveCanonicalRoomRequestId,
  resolveRoomOrReply,
  requireAdmin,
  resolveProjectRole,
  toRoomResponse,
} satisfies RoomMetadataRouteDeps;

const roomJoinRouteDeps = {
  resolveCanonicalRoomRequestId,
  isRepoBackedRoomId,
  resolveRepoRoomAccessDecision,
  replyRepoRoomAccessDecision,
  resolveRoomOrReply,
  getProjectAccessRoomId,
  isRepoBackedProject,
  resolveProjectRole,
  rememberHumanRoomParticipant,
  toRoomResponse,
} satisfies RoomJoinRouteDeps;

const githubWebhookRouteDeps = {
  toGitHubWebhookId,
  handleGitHubWebhookEvent,
} satisfies GitHubWebhookRouteDeps;

registerGitHubIntegrationSetupRoute(app, githubIntegrationRouteDeps);

registerHealthRoutes(app);

registerGitHubAppCallbackRoute(app);

registerGitHubWebhookRoutes(app, githubWebhookRouteDeps);

registerAuthRoutes(app);

registerGitHubIntegrationRoutes(app, githubIntegrationRouteDeps);

registerLegacyProjectRoutes(app, legacyProjectRouteDeps);

registerLegacyProjectMessageRoutes(app, legacyProjectMessageRouteDeps);

registerLegacyProjectTaskRoutes(app, legacyProjectTaskRouteDeps);

// ═══════════════════════════════════════════════════════════════════
// CANONICAL ROOM ROUTES  (/rooms/*room_id/)
//
// These are the primary public API endpoints. All consumers (MCP,
// browser, CI agents) should use these instead of /projects/:id.
//
// Room ID can be:
//   - Invite code:   ABCD-EFGH-IJKL (parsers also accept ABCD-EFGH during transition)
//   - Repo URL: github.com/owner/repo (also accepts https:// prefix,
//               .git suffix, SSH remote format — all normalized)
//
// Error codes used in this section:
//   NOT_AUTHENTICATED      — no credential at all
//   TOKEN_INVALID          — credential present but not valid / revoked
//   PRIVATE_REPO_NO_ACCESS — owner known, but no collaborator access
//   ROOM_NOT_FOUND         — canonical ID does not map to any room
// ═══════════════════════════════════════════════════════════════════

registerRoomJoinRoutes(app, roomJoinRouteDeps);
registerRoomMessageRoutes(app, roomMessageRouteDeps);
registerRoomPresenceRoutes(app, roomPresenceRouteDeps);
registerRoomFocusRoutes(app, roomFocusRouteDeps);
registerRoomTaskRoutes(app, roomTaskRouteDeps);
registerRoomEventRoutes(app, roomEventRouteDeps);
registerRoomMetadataRoutes(app, roomMetadataRouteDeps);

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST;
const listenLabel = HOST || "localhost";
const onListen = () => {
  console.log(`🚀 Let Agents Chat API running on http://${listenLabel}:${PORT}`);
};

if (HOST) {
  app.listen(PORT, HOST, onListen);
} else {
  app.listen(PORT, onListen);
}
