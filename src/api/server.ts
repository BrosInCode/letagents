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
  getFocusRoomByKey,
  getFocusRoomsForParent,
  getOpenTasks,
  getOrCreateCanonicalRoom,
  getProjectByCode,
  getProjectById,
  insertGitHubRoomEvent,
  getActiveTaskLeases,
  getActiveTaskLocks,
  getTaskById,
  getTaskOwnershipState,
  getTasks,
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
  type OwnerTokenAccount,
  type Project,
  type SessionAccount,
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
  getGitHubInstallationTarget,
  getGitHubRepositoryOwnerLogin,
  type GitHubWebhookPayload,
  type GitHubWebhookRepository,
} from "./github-app.js";
import {
  materializeGitHubWebhookEvent,
  type MaterializedGitHubRoomEvent,
} from "./github-room-events.js";
import {
  buildRepoRoomEventArtifactMatches,
  extractReferencedTaskId,
  formatRepoRoomEventMessage,
  getRepoRoomEventReferenceTexts,
  projectRepoRoomEvent,
  shouldAutoPromptForBoardProjection,
  type RepoPullRequestRef,
  type RepoRoomEvent,
  type TaskWorkflowArtifactMatch,
} from "./repo-workflow.js";
import {
  normalizeFocusRoomSettings,
  shouldPostFocusRoomEventToParent,
  shouldRouteGitHubEventToFocusRoom,
  type FocusGitHubRoutingContext,
  type FocusParentEventKind,
} from "./focus-room-settings.js";
import { selectStaleTaskAutoPrompt } from "./stale-work.js";
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
import { isInviteCode, normalizeRoomId } from "./room-routing.js";
import {
  buildTaskUpdatePatch,
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
} from "./task-ownership.js";
import {
  evaluateTaskAdmission,
  evaluateCoordinationMutation,
  evaluateWorkflowArtifactMutation,
  findApplicableLock,
  type CoordinationDecisionResult,
  type CoordinationMutationKind,
} from "./coordination-policy.js";
import { getAgentPrimaryLabel, parseAgentActorLabel } from "../shared/agent-identity.js";
import {
  buildAgentRoomParticipantKey,
  buildHumanRoomParticipantKey,
} from "../shared/room-participant.js";
import {
  normalizeAgentPromptKind,
  type AgentPromptKind,
} from "../shared/room-agent-prompts.js";
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

const STALE_WORK_PROMPT_COOLDOWN_MS = 15 * 60 * 1000;
const staleWorkPromptTimestamps = new Map<string, number>();

function pruneStaleWorkPromptTimestamps(now: number): void {
  for (const [key, timestamp] of staleWorkPromptTimestamps) {
    if (now - timestamp > STALE_WORK_PROMPT_COOLDOWN_MS) {
      staleWorkPromptTimestamps.delete(key);
    }
  }
}

const messageEvents = new EventEmitter();
const taskEvents = new EventEmitter();

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

function parseOptionalAgentPromptKind(value: unknown): AgentPromptKind | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalizedValue = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (normalizedValue === "join") {
    throw new Error("agent_prompt_kind must be one of: inline, auto");
  }

  const kind = normalizeAgentPromptKind(normalizedValue);
  if (!kind) {
    throw new Error("agent_prompt_kind must be one of: inline, auto");
  }

  return kind;
}

function parseOptionalReplyToMessageId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error("reply_to must be a valid message id");
  }

  const normalized = value.trim();
  if (!/^msg_\d+$/.test(normalized)) {
    throw new Error("reply_to must be a valid message id");
  }

  return normalized;
}

function shouldIncludePromptOnlyMessages(req: express.Request): boolean {
  const value = req.query.include_prompt_only;
  if (typeof value !== "string") {
    return false;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function formatTaskLifecycleStatus(task: {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string | null;
}): string {
  const assigneeLabel = getAgentPrimaryLabel(task.assignee);
  switch (task.status) {
    case "assigned":
      return assigneeLabel
        ? `[status] ${assigneeLabel} claimed ${task.id}: ${task.title}`
        : `[status] ${task.id} moved to assigned: ${task.title}`;
    case "in_progress":
      return assigneeLabel
        ? `[status] ${assigneeLabel} is working on ${task.id}: ${task.title}`
        : `[status] ${task.id} is in progress: ${task.title}`;
    case "blocked":
      return `[status] ${task.id} is blocked: ${task.title}`;
    case "in_review":
      return `[status] ${task.id} is in review: ${task.title}`;
    case "merged":
      return `[status] ${task.id} was merged: ${task.title}`;
    case "done":
      return `[status] ${task.id} is done: ${task.title}`;
    case "cancelled":
      return `[status] ${task.id} was cancelled: ${task.title}`;
    default:
      return `[status] ${task.id} moved to ${task.status}: ${task.title}`;
  }
}

function toRoomResponse(
  project: Project,
  options?: {
    role?: "admin" | "participant" | "anonymous";
    authenticated?: boolean;
  }
): Record<string, unknown> {
  const focusSettings = project.kind === "focus"
    ? normalizeFocusRoomSettings({
        parent_visibility: project.focus_parent_visibility,
        activity_scope: project.focus_activity_scope,
        github_event_routing: project.focus_github_event_routing,
      })
    : null;

  return {
    room_id: project.id,
    name: project.name ?? null,
    display_name: project.display_name,
    code: project.code,
    kind: project.kind,
    parent_room_id: project.parent_room_id,
    focus_key: project.focus_key,
    source_task_id: project.source_task_id,
    focus_status: project.focus_status,
    focus_parent_visibility: focusSettings?.parent_visibility ?? null,
    focus_activity_scope: focusSettings?.activity_scope ?? null,
    focus_github_event_routing: focusSettings?.github_event_routing ?? null,
    focus_settings: focusSettings,
    concluded_at: project.concluded_at,
    conclusion_summary: project.conclusion_summary,
    created_at: project.created_at,
    ...(options?.role ? { role: options.role } : {}),
    ...(options ? { authenticated: Boolean(options.authenticated) } : {}),
  };
}

function formatFocusRoomConclusionMessage(input: {
  focusRoom: Project;
  task?: Task;
  summary: string;
}): string {
  const taskLabel = input.task
    ? `${input.task.id}: ${input.task.title}`
    : input.focusRoom.source_task_id || input.focusRoom.focus_key || input.focusRoom.id;
  return `[status] Focus Room concluded for ${taskLabel}. Result: ${input.summary}`;
}

function formatFocusRoomReference(focusRoom: Project): string {
  const key = focusRoom.focus_key || focusRoom.source_task_id || focusRoom.id;
  return focusRoom.display_name
    ? `${focusRoom.display_name} (${key})`
    : key;
}

function formatFocusRoomAnchorMessage(input: {
  task: { id: string; title: string };
  focusRoom: Project;
  activity: string;
}): string {
  return `[status] ${input.activity} for ${input.task.id}: ${input.task.title} is in Focus Room ${formatFocusRoomReference(input.focusRoom)}.`;
}

function getFocusRoomSettings(focusRoom: Project) {
  return normalizeFocusRoomSettings({
    parent_visibility: focusRoom.focus_parent_visibility,
    activity_scope: focusRoom.focus_activity_scope,
    github_event_routing: focusRoom.focus_github_event_routing,
  });
}

async function getActiveTaskFocusRoom(projectId: string, taskId: string): Promise<Project | null> {
  const project = await getProjectById(projectId);
  if (!project || project.kind === "focus") {
    return null;
  }

  return (await getActiveFocusRoomForTask(project.id, taskId)) ?? null;
}

async function emitTaskAnchoredMessage(
  projectId: string,
  sender: string,
  text: string,
  task: { id: string; title: string },
  options?: {
    source?: string;
    agent_prompt_kind?: AgentPromptKind | null;
    parent_activity?: string;
    parent_event_kind?: FocusParentEventKind;
    event_kind?: "github";
    github_routing_context?: FocusGitHubRoutingContext;
  }
): Promise<Message> {
  const focusRoom = await getActiveTaskFocusRoom(projectId, task.id);
  if (!focusRoom) {
    return emitProjectMessage(projectId, sender, text, {
      source: options?.source,
      agent_prompt_kind: options?.agent_prompt_kind ?? null,
    });
  }

  const focusSettings = getFocusRoomSettings(focusRoom);
  if (
    options?.event_kind === "github" &&
    !shouldRouteGitHubEventToFocusRoom(focusSettings, options.github_routing_context ?? {})
  ) {
    return emitProjectMessage(projectId, sender, text, {
      source: options?.source,
      agent_prompt_kind: options?.agent_prompt_kind ?? null,
    });
  }

  const focusMessage = await emitProjectMessage(focusRoom.id, sender, text, {
    source: options?.source,
    agent_prompt_kind: options?.agent_prompt_kind ?? null,
  });
  if (
    shouldPostFocusRoomEventToParent(
      focusSettings,
      options?.parent_event_kind ?? "major_activity"
    )
  ) {
    await emitProjectMessage(
      projectId,
      "letagents",
      formatFocusRoomAnchorMessage({
        task,
        focusRoom,
        activity: options?.parent_activity ?? "Activity",
      })
    );
  }

  return focusMessage;
}

async function emitGitHubEventToAllParentRepoFocusRooms(
  projectId: string,
  sender: string,
  text: string,
  options?: {
    excludeRoomIds?: Set<string>;
  }
): Promise<void> {
  const focusRooms = await getFocusRoomsForParent(projectId);
  const targetFocusRooms = focusRooms.filter((focusRoom) =>
    focusRoom.focus_status !== "concluded" &&
    !options?.excludeRoomIds?.has(focusRoom.id) &&
    shouldRouteGitHubEventToFocusRoom(getFocusRoomSettings(focusRoom), {
      parent_repo_event: true,
    })
  );

  await Promise.all(
    targetFocusRooms.map((focusRoom) =>
      emitProjectMessage(focusRoom.id, sender, text, { source: "github" })
    )
  );
}

function normalizeParticipantValue(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function getOwnerLabelFromAttribution(ownerAttribution: string | null | undefined): string | null {
  const normalized = normalizeParticipantValue(ownerAttribution);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(.+?)(?:'s|s')?\s+agent$/i);
  return match?.[1]?.trim() || normalized;
}

function isAgentIdentityValue(value: string | null | undefined): boolean {
  const parsed = parseAgentActorLabel(value);
  return Boolean(parsed && (parsed.structured || parsed.owner_attribution || parsed.ide_label));
}

async function rememberHumanRoomParticipant(input: {
  projectId: string;
  sender?: string | null;
  sessionAccount?: SessionAccount | OwnerTokenAccount | null | undefined;
  lastSeenAt?: string | null;
}): Promise<void> {
  const githubLogin = normalizeParticipantValue(input.sessionAccount?.login ?? input.sender);
  const displayName = githubLogin || normalizeParticipantValue(input.sender);
  const participantKey = buildHumanRoomParticipantKey({
    github_login: githubLogin || null,
    display_name: displayName || null,
  });

  if (!participantKey || !displayName) {
    return;
  }

  await upsertRoomParticipant({
    room_id: input.projectId,
    participant_key: participantKey,
    kind: "human",
    github_login: githubLogin || null,
    display_name: displayName,
    last_seen_at: input.lastSeenAt ?? null,
  });
}

async function rememberAgentRoomParticipant(input: {
  projectId: string;
  actorLabel?: string | null;
  agentKey?: string | null;
  displayName?: string | null;
  ownerLabel?: string | null;
  ideLabel?: string | null;
  lastSeenAt?: string | null;
}): Promise<void> {
  const actorLabel = normalizeParticipantValue(input.actorLabel);
  const participantKey = buildAgentRoomParticipantKey(actorLabel);
  if (!actorLabel || !participantKey) {
    return;
  }

  const parsed = parseAgentActorLabel(actorLabel);
  const displayName = normalizeParticipantValue(input.displayName)
    || parsed?.display_name
    || actorLabel;

  await upsertRoomParticipant({
    room_id: input.projectId,
    participant_key: participantKey,
    kind: "agent",
    actor_label: actorLabel,
    agent_key: normalizeParticipantValue(input.agentKey) || null,
    display_name: displayName,
    owner_label: normalizeParticipantValue(input.ownerLabel) || getOwnerLabelFromAttribution(parsed?.owner_attribution),
    ide_label: normalizeParticipantValue(input.ideLabel) || parsed?.ide_label || null,
    last_seen_at: input.lastSeenAt ?? null,
  });
}

async function rememberRoomParticipantFromMessage(input: {
  projectId: string;
  sender: string;
  source: string | undefined;
  sessionAccount?: SessionAccount | OwnerTokenAccount | null | undefined;
  timestamp: string;
}): Promise<void> {
  const normalizedSender = normalizeParticipantValue(input.sender);
  const normalizedSource = normalizeParticipantValue(input.source).toLowerCase();
  if (!normalizedSender) {
    return;
  }

  if (normalizedSource === "agent" || isAgentIdentityValue(normalizedSender)) {
    await rememberAgentRoomParticipant({
      projectId: input.projectId,
      actorLabel: normalizedSender,
      lastSeenAt: input.timestamp,
    });
    return;
  }

  const lowerSender = normalizedSender.toLowerCase();
  if (lowerSender === "letagents" || lowerSender === "system" || lowerSender === "github") {
    return;
  }

  await rememberHumanRoomParticipant({
    projectId: input.projectId,
    sender: normalizedSender,
    sessionAccount: input.sessionAccount,
    lastSeenAt: input.timestamp,
  });
}

async function emitTaskLifecycleStatusMessage(
  projectId: string,
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    assignee: string | null;
  },
  options?: {
    agent_prompt_kind?: AgentPromptKind | null;
  }
): Promise<Message> {
  return emitTaskAnchoredMessage(projectId, "letagents", formatTaskLifecycleStatus(task), task, {
    agent_prompt_kind: options?.agent_prompt_kind ?? null,
    parent_activity: "Task status",
    parent_event_kind: "major_activity",
  });
}

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

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function classifyTaskCoordinationMutation(
  updates: TaskUpdatePatch
): { mutation: CoordinationMutationKind; leaseKind: TaskLeaseKind; claim: boolean } | null {
  if (updates.status === "assigned") {
    return { mutation: "task_claim", leaseKind: "work", claim: true };
  }

  if (updates.status === "in_review") {
    return { mutation: "task_complete", leaseKind: "work", claim: false };
  }

  if (updates.pr_url !== undefined || updates.workflow_artifacts !== undefined) {
    return { mutation: "workflow_artifact_attach", leaseKind: "work", claim: false };
  }

  if (updates.status === "in_progress" || updates.status === "blocked") {
    return { mutation: "task_update", leaseKind: "work", claim: false };
  }

  return null;
}

function getTaskUpdatePrUrlBinding(updates: TaskUpdatePatch): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(updates, "pr_url")) {
    return undefined;
  }

  return updates.pr_url ?? null;
}

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

async function maybeEmitStaleWorkPrompt(projectId: string): Promise<Message | null> {
  const [taskResult, presence] = await Promise.all([
    getOpenTasks(projectId, { limit: 200 }),
    getRoomAgentPresence(projectId, { limit: 50 }),
  ]);

  const prompt = selectStaleTaskAutoPrompt({
    tasks: taskResult.tasks,
    presence,
  });
  if (!prompt) {
    return null;
  }

  const now = Date.now();
  pruneStaleWorkPromptTimestamps(now);

  const cacheKey = `${projectId}:${prompt.cache_key}`;
  const lastPromptAt = staleWorkPromptTimestamps.get(cacheKey);
  if (lastPromptAt && now - lastPromptAt < STALE_WORK_PROMPT_COOLDOWN_MS) {
    return null;
  }

  const message = await emitTaskAnchoredMessage(projectId, "letagents", prompt.prompt_text, prompt.task, {
    agent_prompt_kind: "auto",
    parent_activity: "Stale-work prompt",
    parent_event_kind: "all_activity",
  });
  staleWorkPromptTimestamps.set(cacheKey, now);
  return message;
}

async function isTrustedAgentCreator(projectId: string, createdBy: string): Promise<boolean> {
  const normalizedSender = createdBy.trim().toLowerCase();
  if (!normalizedSender || normalizedSender === "human" || normalizedSender === "letagents") {
    return false;
  }

  return hasMessagesFromSender(projectId, createdBy);
}

function parseFocusRoomLocator(
  roomId: string
): { parentRoomId: string; focusKey: string } | null {
  const marker = "/focus/";
  const index = roomId.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }

  const parentRoomId = roomId.slice(0, index);
  const focusKey = roomId.slice(index + marker.length);
  if (!parentRoomId || !focusKey || focusKey.includes("/")) {
    return null;
  }

  return { parentRoomId, focusKey };
}

function isReservedRoomId(roomId: string): boolean {
  return /^focus_\d+$/.test(roomId);
}

async function resolveRoomOrReply(
  roomId: string,
  res: express.Response,
  { allowCreate }: { allowCreate: boolean } = { allowCreate: false }
): Promise<Project | null> {
  const focusLocator = parseFocusRoomLocator(roomId);
  if (focusLocator) {
    const parentRoomId = await resolveCanonicalRoomRequestId(
      normalizeRoomId(focusLocator.parentRoomId)
    );
    const parent = await getProjectById(parentRoomId);
    if (!parent) {
      res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
      return null;
    }

    const focusRoom = await getFocusRoomByKey(parent.id, focusLocator.focusKey);
    if (!focusRoom) {
      res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
      return null;
    }
    return focusRoom;
  }

  // Handle invite codes (e.g., JA0E-4NYO or JA0E-4NYO-L2QP)
  if (isInviteCode(roomId)) {
    const project = await getProjectByCode(roomId);
    if (!project) {
      res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
      return null;
    }
    return project;
  }

  if (allowCreate) {
    if (isReservedRoomId(roomId)) {
      const found = await getProjectById(roomId);
      if (!found) {
        res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
        return null;
      }
      return found;
    }

    const { room } = await getOrCreateCanonicalRoom(roomId);
    return room;
  }

  const found = await getProjectById(roomId);
  if (!found) {
    res.status(404).json({ error: "Room not found", code: "ROOM_NOT_FOUND" });
    return null;
  }
  return found;
}

async function resolveCanonicalRoomRequestId(roomId: string): Promise<string> {
  if (isInviteCode(roomId)) {
    return roomId;
  }

  const existing = await getProjectById(roomId);
  return existing?.id ?? roomId;
}

function toGitHubWebhookId(value: string | number | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

async function syncGitHubAppInstallationFromPayload(
  payload: GitHubWebhookPayload,
  options?: {
    suspended_at?: string | null;
    uninstalled_at?: string | null;
  }
): Promise<string | null> {
  const installationId = toGitHubWebhookId(payload.installation?.id);
  if (!installationId) {
    return null;
  }

  const target = getGitHubInstallationTarget(payload);
  if (!target?.login) {
    return installationId;
  }

  await upsertGitHubAppInstallation({
    installation_id: installationId,
    target_type: payload.installation?.target_type ?? target.type ?? "Account",
    target_login: target.login,
    target_github_id: toGitHubWebhookId(target.id) ?? installationId,
    repository_selection: payload.installation?.repository_selection ?? "selected",
    permissions: payload.installation?.permissions,
    suspended_at: options?.suspended_at,
    uninstalled_at: options?.uninstalled_at,
  });

  return installationId;
}

async function syncGitHubAppRepositoryFromPayload(
  repository: GitHubWebhookRepository | undefined,
  installationId: string | null
): Promise<{
  installationId: string | null;
  githubRepoId: string | null;
  roomId: string | null;
}> {
  if (!repository) {
    return {
      installationId,
      githubRepoId: null,
      roomId: null,
    };
  }

  const githubRepoId = toGitHubWebhookId(repository.id);
  const roomId = buildGitHubRepoRoomId(repository.full_name);
  const ownerLogin = getGitHubRepositoryOwnerLogin(repository);
  let resolvedInstallationId = installationId;

  if (!resolvedInstallationId) {
    resolvedInstallationId =
      (await getGitHubAppRepositoryByFullName(repository.full_name))?.installation_id ?? null;
  }

  if (resolvedInstallationId && githubRepoId && ownerLogin && repository.name) {
    await upsertGitHubAppRepository({
      github_repo_id: githubRepoId,
      installation_id: resolvedInstallationId,
      owner_login: ownerLogin,
      repo_name: repository.name,
    });

    // Also populate the stable github_repositories mapping
    await upsertGitHubRepositoryLink({
      github_repo_id: githubRepoId,
      room_id: roomId,
      owner_login: ownerLogin,
      repo_name: repository.name,
    });
  }

  return {
    installationId: resolvedInstallationId,
    githubRepoId,
    roomId,
  };
}

interface RepoRoomEventTaskResolution {
  task: Task | undefined;
  matchedByTaskReference: boolean;
  matchedByWorkflowArtifact: boolean;
}

function emptyRepoRoomEventTaskResolution(): RepoRoomEventTaskResolution {
  return {
    task: undefined,
    matchedByTaskReference: false,
    matchedByWorkflowArtifact: false,
  };
}

function taskIdsMatch(left: string | null | undefined, right: string): boolean {
  return Boolean(left && left.toLowerCase() === right.toLowerCase());
}

async function resolveTaskByArtifactsOrReferences(
  project: Project,
  artifactMatches: TaskWorkflowArtifactMatch[],
  ...fallbackTexts: Array<string | null | undefined>
): Promise<RepoRoomEventTaskResolution> {
  const referencedTaskId = extractReferencedTaskId(...fallbackTexts);
  const artifactTask = await findTaskByWorkflowArtifactMatches(project.id, artifactMatches);
  if (artifactTask) {
    return {
      task: artifactTask,
      matchedByTaskReference: taskIdsMatch(referencedTaskId, artifactTask.id),
      matchedByWorkflowArtifact: true,
    };
  }

  if (!referencedTaskId) {
    return emptyRepoRoomEventTaskResolution();
  }

  const task = await getTaskById(project.id, referencedTaskId);
  return {
    task: task ?? undefined,
    matchedByTaskReference: Boolean(task),
    matchedByWorkflowArtifact: false,
  };
}

async function resolveLinkedTaskForRepoRoomEvent(
  project: Project,
  event: RepoRoomEvent
): Promise<RepoRoomEventTaskResolution> {
  const artifactMatches = buildRepoRoomEventArtifactMatches(event);
  const referencedTaskId = extractReferencedTaskId(...getRepoRoomEventReferenceTexts(event));

  if (event.kind === "pull_request") {
    const artifactTask =
      (await findTaskByWorkflowArtifactMatches(project.id, artifactMatches)) ??
      (await findTaskByPrUrl(project.id, event.pullRequest.url));

    if (artifactTask) {
      return {
        task: artifactTask,
        matchedByTaskReference: taskIdsMatch(referencedTaskId, artifactTask.id),
        matchedByWorkflowArtifact: true,
      };
    }

    if (!referencedTaskId) {
      return emptyRepoRoomEventTaskResolution();
    }

    const task = await getTaskById(project.id, referencedTaskId);
    return {
      task: task ?? undefined,
      matchedByTaskReference: Boolean(task),
      matchedByWorkflowArtifact: false,
    };
  }

  return resolveTaskByArtifactsOrReferences(
    project,
    artifactMatches,
    ...getRepoRoomEventReferenceTexts(event)
  );
}

function getPullRequestWorkflowRef(event: RepoRoomEvent): RepoPullRequestRef | null {
  switch (event.kind) {
    case "pull_request":
    case "pull_request_review":
      return event.pullRequest;
    default:
      return null;
  }
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
      await emitProjectMessage(
        project.id,
        "letagents",
        `[status] Ignored unleased GitHub ${event.kind} projection for ${linkedTask.id}: ${decision.reason}`
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

  const persisted = await persistMaterializedGitHubRoomEvent(event, {
    deliveryId: input.deliveryId,
    roomId: project.id,
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
    linkedTask = await maybeAutoCreateTaskForFailedCheckRun(project, linkedTask, roomEvent);
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
        github_routing_context: {
          matched_task_reference: taskResolution.matchedByTaskReference,
          matched_workflow_artifact: taskResolution.matchedByWorkflowArtifact,
        },
      });
    } else {
      await emitProjectMessage(project.id, "github", message, { source: "github" });
    }
    await emitGitHubEventToAllParentRepoFocusRooms(project.id, "github", message, {
      excludeRoomIds: linkedFocusRoom ? new Set([linkedFocusRoom.id]) : undefined,
    });
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
  event: Extract<RepoRoomEvent, { kind: "check_run" }>
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
        const ownerLogin = getGitHubRepositoryOwnerLogin(repository);
        const repositoryId = toGitHubWebhookId(repository.id);
        if (!repositoryId || !ownerLogin || !repository.name) {
          continue;
        }

        await upsertGitHubAppRepository({
          github_repo_id: repositoryId,
          installation_id: syncedInstallationId,
          owner_login: ownerLogin,
          repo_name: repository.name,
        });

        // Also seed the stable github_repositories mapping for migration support
        const repoRoomId = buildGitHubRepoRoomId(repository.full_name);
        await upsertGitHubRepositoryLink({
          github_repo_id: repositoryId,
          room_id: repoRoomId,
          owner_login: ownerLogin,
          repo_name: repository.name,
        });
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

app.listen(PORT, () => {
  console.log(`🚀 Let Agents Chat API running on http://localhost:${PORT}`);
});
