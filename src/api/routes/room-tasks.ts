import type { EventEmitter } from "events";
import type { Express, Response } from "express";

import {
  assignProjectAdmin,
  applyTaskWorkLeaseAction,
  clearStaleTaskPromptMute,
  createCoordinationEvent,
  createFocusRoomForTask,
  createTask,
  getActiveTaskLeases,
  getActiveTaskLocks,
  getActiveRoomAgentSessionsForWorkerIdentity,
  getAgentIdentityByCanonicalKey,
  getOpenTasks,
  getReachableWorkerDeliverySessionForAgentSession,
  getStaleTaskPromptMutes,
  getTaskById,
  getTaskOwnershipState,
  getTasks,
  getTasksGitHubArtifactStatus,
  upsertStaleTaskPromptMute,
  updateTask,
  type Project,
  type Task,
  type TaskLease,
  type TaskGitHubArtifactStatus,
  type TaskStatus,
} from "../db.js";
import { buildLeasedBranchRef } from "../github-lease-enforcement.js";
import {
  parseLimit,
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../http-helpers.js";
import {
  requireWorkerRequestAgentIdentity,
  type ResolvedRequestAgentIdentity,
} from "../request-agent-identity.js";
import { validateTaskWorkflowArtifactsInput } from "../repo-workflow.js";
import { normalizeRoomId } from "../room-routing.js";
import { getTaskStalePromptState } from "../stale-work.js";
import {
  buildTaskUpdatePatch,
  evaluateTaskOwnership,
  normalizeTaskActorInstanceId,
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
  requiresTaskOwnershipGuard,
} from "../task-ownership.js";
import { findApplicableLock, leaseMatchesActor } from "../coordination-policy.js";
import type { FocusParentBoardWriteIsolationDecision } from "../focus-room-task-write-isolation.js";
import { buildAgentActorLabel } from "../../shared/agent-identity.js";

type RoomRole = "admin" | "participant" | "anonymous";
type TaskUpdatePatch = ReturnType<typeof buildTaskUpdatePatch>["updates"];
type TaskOwnershipState = NonNullable<Awaited<ReturnType<typeof getTaskOwnershipState>>>;

type TaskCoordinationGuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; error: string };

type TaskAdmissionGuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; error: string };

type OwnerTokenWorkerWriteIdentity =
  | { kind: "not_owner_token" }
  | { kind: "worker"; identity: ResolvedRequestAgentIdentity }
  | { kind: "responded" };

type LeaseActionRequestBody = {
  action?: string;
  lease_id?: string;
  reason?: string;
  actor_label?: string;
  actor_key?: string;
  actor_instance_id?: string;
  target_actor_key?: string;
  target_actor_instance_id?: string;
  target_agent_session_id?: string;
};

const LEASE_RECOVERY_ACTIVE_STATUSES = new Set<TaskStatus>([
  "assigned",
  "in_progress",
  "blocked",
  "in_review",
]);

export interface RoomTaskRouteDeps {
  taskEvents: EventEmitter;
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(
    roomId: string,
    res: Response,
    options?: { allowCreate: boolean }
  ): Promise<Project | null>;
  requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  resolveProjectRole(
    project: Project,
    sessionAccount: AuthenticatedRequest["sessionAccount"]
  ): Promise<RoomRole>;
  toRoomResponse(
    project: Project,
    options?: {
      role?: RoomRole;
      authenticated?: boolean;
    }
  ): Record<string, unknown>;
  normalizeOptionalString(value: unknown): string | null;
  enforceTaskAdmissionCoordination(input: {
    req: AuthenticatedRequest;
    projectId: string;
    title: string;
    sourceMessageId?: string | null;
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
    actorSessionId: string | null;
  }): Promise<TaskAdmissionGuardDecision>;
  isTrustedAgentCreator(projectId: string, createdBy: string): Promise<boolean>;
  emitTaskLifecycleStatusMessage(
    projectId: string,
    task: {
      id: string;
      title: string;
      status: TaskStatus;
      assignee: string | null;
    }
  ): Promise<unknown>;
  validateOwnerTokenTaskActorKey(input: {
    req: AuthenticatedRequest;
    actorKey: string | null;
  }): Promise<{ actorKey: string | null; error: string | null }>;
  enforceTaskCoordinationMutation(input: {
    req: AuthenticatedRequest;
    projectId: string;
    task: Task;
    taskOwnership: TaskOwnershipState;
    updates: TaskUpdatePatch;
    forcedMutation?: { mutation: "focus_room_open" | "task_update"; leaseKind: "work" };
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
    actorSessionId: string | null;
  }): Promise<TaskCoordinationGuardDecision>;
  enforceFocusParentBoardWriteIsolation(input: {
    req: AuthenticatedRequest;
    targetProject: Project;
  }): Promise<FocusParentBoardWriteIsolationDecision>;
  emitProjectMessage(projectId: string, sender: string, text: string): Promise<unknown>;
}

async function attachTaskDetails(projectId: string, task: Task) {
  const [leases, locks, stalePromptMutes] = await Promise.all([
    getActiveTaskLeases(projectId),
    getActiveTaskLocks(projectId),
    getStaleTaskPromptMutes(projectId, [task.id]),
  ]);
  const stalePromptMute = stalePromptMutes[0] ?? null;
  return {
    ...task,
    stale_prompt_state: getTaskStalePromptState({
      task,
      mute: stalePromptMute,
    }),
    active_leases: leases.filter((lease) => lease.task_id === task.id),
    active_locks: locks.filter((lock) => lock.task_id === task.id || lock.scope === "room"),
  };
}

async function attachTaskListDetails(projectId: string, tasks: Task[]) {
  const [leases, locks, stalePromptMutes] = await Promise.all([
    getActiveTaskLeases(projectId),
    getActiveTaskLocks(projectId),
    tasks.length > 0 ? getStaleTaskPromptMutes(projectId, tasks.map((task) => task.id)) : Promise.resolve([]),
  ]);
  const stalePromptMuteByTaskId = new Map(
    stalePromptMutes.map((mute) => [mute.task_id, mute] as const)
  );
  return tasks.map((task) => ({
    ...task,
    stale_prompt_state: getTaskStalePromptState({
      task,
      mute: stalePromptMuteByTaskId.get(task.id) ?? null,
    }),
    active_leases: leases.filter((lease) => lease.task_id === task.id),
    active_locks: locks.filter((lock) => lock.task_id === task.id || lock.scope === "room"),
  }));
}

export function isCurrentStalePromptAction(input: {
  taskUpdatedAt: string;
  promptTimestamp: string | null | undefined;
}): boolean {
  const taskUpdatedAtMs = Date.parse(input.taskUpdatedAt);
  const promptTimestampMs = Date.parse(input.promptTimestamp ?? "");
  if (!Number.isFinite(taskUpdatedAtMs) || !Number.isFinite(promptTimestampMs)) {
    return false;
  }

  return taskUpdatedAtMs <= promptTimestampMs;
}

function getActiveWorkLease(leases: readonly TaskLease[]): TaskLease | null {
  return leases.find((lease) => lease.kind === "work") ?? null;
}

async function resolveOwnerTokenWorkerWriteIdentity(input: {
  req: AuthenticatedRequest;
  res: Response;
  room_id: string;
  body: Record<string, unknown>;
}): Promise<OwnerTokenWorkerWriteIdentity> {
  if (input.req.authKind !== "owner_token") {
    return { kind: "not_owner_token" };
  }

  const result = await requireWorkerRequestAgentIdentity({
    req: input.req,
    body: input.body,
    room_id: input.room_id,
  });
  if (!result.ok) {
    input.res.status(result.status).json({ error: result.error });
    return { kind: "responded" };
  }

  return { kind: "worker", identity: result.identity };
}

export function registerRoomTaskRoutes(
  app: Express,
  deps: RoomTaskRouteDeps
): void {
  app.get(/^\/rooms\/(.+)\/tasks$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const open = req.query.open === "true";
    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const result = open ? await getOpenTasks(project.id, { limit, after }) : await getTasks(project.id, status, { limit, after });

    const tasksWithDetails = await attachTaskListDetails(project.id, result.tasks);

    res.json({ room_id: project.id, tasks: tasksWithDetails, has_more: result.has_more });
  });

  app.post(/^\/rooms\/(.+)\/tasks$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res, { allowCreate: false });
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const isolation = await deps.enforceFocusParentBoardWriteIsolation({
      req,
      targetProject: project,
    });
    if (isolation.kind === "deny") {
      res.status(409).json({ error: isolation.error, code: isolation.code });
      return;
    }

    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    const workerWriteIdentity = await resolveOwnerTokenWorkerWriteIdentity({
      req,
      res,
      room_id: project.id,
      body: requestBody,
    });
    if (workerWriteIdentity.kind === "responded") return;
    const workerIdentity = workerWriteIdentity.kind === "worker" ? workerWriteIdentity.identity : null;

    const { title, description, created_by, source_message_id, actor_label, actor_key, actor_instance_id } = requestBody as {
      title?: string;
      description?: string;
      created_by?: string;
      source_message_id?: string;
      actor_label?: string;
      actor_key?: string;
      actor_instance_id?: string;
    };

    const createdBy = workerIdentity?.actor_label ?? created_by ?? null;
    const effectiveActorLabel = workerIdentity?.actor_label ?? actor_label ?? createdBy;
    const effectiveActorKey = workerIdentity?.agent_key ?? actor_key ?? null;
    const effectiveActorInstanceId = workerIdentity?.agent_instance_id ?? deps.normalizeOptionalString(actor_instance_id);
    const effectiveActorSessionId = workerIdentity?.agent_session_id ?? null;

    if (!title || !createdBy) {
      res.status(400).json({ error: "title and created_by are required" });
      return;
    }

    const admission = await deps.enforceTaskAdmissionCoordination({
      req,
      projectId: project.id,
      title,
      sourceMessageId: source_message_id ?? null,
      actorLabel: effectiveActorLabel,
      actorKey: effectiveActorKey,
      actorInstanceId: effectiveActorInstanceId,
      actorSessionId: effectiveActorSessionId,
    });
    if (admission.kind === "deny") {
      res.status(409).json({ error: admission.error, code: admission.code });
      return;
    }

    const task = await createTask(project.id, title, createdBy, description, source_message_id);

    if (req.authKind === "owner_token") {
      await createCoordinationEvent({
        room_id: project.id,
        task_id: task.id,
        event_type: "task_admit",
        decision: "record",
        actor_label: effectiveActorLabel,
        actor_key: normalizeTaskActorKey(effectiveActorKey),
        actor_instance_id: effectiveActorInstanceId,
        reason: "Agent-created task requires coordinator acceptance before it is claimable.",
      });
      res.status(201).json({ ...task, room_id: project.id });
      return;
    }

    if (!(await deps.isTrustedAgentCreator(project.id, createdBy))) {
      res.status(201).json({ ...task, room_id: project.id });
      return;
    }

    const acceptedTask = await updateTask(project.id, task.id, { status: "accepted" });
    if (!acceptedTask) {
      res.status(500).json({ error: "Task created but could not be auto-accepted" });
      return;
    }

    await deps.emitTaskLifecycleStatusMessage(project.id, acceptedTask);

    const taskWithDetails = await attachTaskDetails(project.id, acceptedTask);

    deps.taskEvents.emit("task:updated", { projectId: project.id, task: taskWithDetails });
    res.status(201).json({ ...taskWithDetails, room_id: project.id });
  });

  app.post(/^\/rooms\/(.+)\/tasks\/([^/]+)\/focus-room$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const taskId = (req.params as Record<string, string>)[1] ?? "";

    const project = await deps.resolveRoomOrReply(roomId, res, { allowCreate: false });
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const isolation = await deps.enforceFocusParentBoardWriteIsolation({
      req,
      targetProject: project,
    });
    if (isolation.kind === "deny") {
      res.status(409).json({ error: isolation.error, code: isolation.code });
      return;
    }

    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    const workerWriteIdentity = await resolveOwnerTokenWorkerWriteIdentity({
      req,
      res,
      room_id: project.id,
      body: requestBody,
    });
    if (workerWriteIdentity.kind === "responded") return;
    const workerIdentity = workerWriteIdentity.kind === "worker" ? workerWriteIdentity.identity : null;
    const { display_name } = requestBody as { display_name?: string };
    try {
      const task = await getTaskById(project.id, taskId);
      const taskOwnership = await getTaskOwnershipState(project.id, taskId);
      if (!task || !taskOwnership) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      const coordination = await deps.enforceTaskCoordinationMutation({
        req,
        projectId: project.id,
        task,
        taskOwnership,
        updates: {},
        forcedMutation: { mutation: "focus_room_open", leaseKind: "work" },
        actorLabel: workerIdentity?.actor_label ?? normalizeTaskActorLabel(requestBody.actor_label),
        actorKey: workerIdentity?.agent_key ?? normalizeTaskActorKey(requestBody.actor_key),
        actorInstanceId: workerIdentity?.agent_instance_id ?? deps.normalizeOptionalString(requestBody.actor_instance_id),
        actorSessionId: workerIdentity?.agent_session_id ?? null,
      });
      if (coordination.kind === "deny") {
        res.status(409).json({ error: coordination.error, code: coordination.code });
        return;
      }

      const result = await createFocusRoomForTask(project.id, taskId, {
        displayName: display_name,
      });
      if (!result) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      if (result.created && req.sessionAccount) {
        await assignProjectAdmin(result.room.id, req.sessionAccount.account_id);
      }

      if (result.created) {
        await deps.emitProjectMessage(
          project.id,
          "letagents",
          `[status] Focus Room opened for ${result.task.id}: ${result.task.title}`
        );
      }

      const role = await deps.resolveProjectRole(result.room, req.sessionAccount);
      res.status(result.created ? 201 : 200).json({
        room_id: project.id,
        task_id: result.task.id,
        created: result.created,
        focus_room: deps.toRoomResponse(result.room, {
          role,
          authenticated: Boolean(req.sessionAccount),
        }),
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "POST /rooms/:room_id/tasks/:task_id/focus-room",
        error,
        "Focus Room could not be opened."
      );
    }
  });

  app.post(/^\/rooms\/(.+)\/tasks\/([^/]+)\/stale-prompt-mute$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const taskId = (req.params as Record<string, string>)[1] ?? "";

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const isolation = await deps.enforceFocusParentBoardWriteIsolation({
      req,
      targetProject: project,
    });
    if (isolation.kind === "deny") {
      res.status(409).json({ error: isolation.error, code: isolation.code });
      return;
    }

    try {
      const task = await getTaskById(project.id, taskId);
      const taskOwnership = await getTaskOwnershipState(project.id, taskId);
      if (!task || !taskOwnership) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      const requestBody = (req.body ?? {}) as Record<string, unknown>;
      const workerWriteIdentity = await resolveOwnerTokenWorkerWriteIdentity({
        req,
        res,
        room_id: project.id,
        body: requestBody,
      });
      if (workerWriteIdentity.kind === "responded") return;
      const workerIdentity = workerWriteIdentity.kind === "worker" ? workerWriteIdentity.identity : null;
      const promptTimestamp = deps.normalizeOptionalString(requestBody.prompt_timestamp);
      if (!isCurrentStalePromptAction({ taskUpdatedAt: task.updated_at, promptTimestamp })) {
        const taskWithDetails = await attachTaskDetails(project.id, task);
        res.status(409).json({
          ...taskWithDetails,
          room_id: project.id,
          error: "This stale prompt is outdated because the task changed after it was posted.",
          code: "STALE_PROMPT_OUTDATED",
        });
        return;
      }

      const coordination = await deps.enforceTaskCoordinationMutation({
        req,
        projectId: project.id,
        task,
        taskOwnership,
        updates: {},
        forcedMutation: { mutation: "task_update", leaseKind: "work" },
        actorLabel: workerIdentity?.actor_label ?? normalizeTaskActorLabel(requestBody.actor_label),
        actorKey: workerIdentity?.agent_key ?? normalizeTaskActorKey(requestBody.actor_key),
        actorInstanceId: workerIdentity?.agent_instance_id ?? deps.normalizeOptionalString(requestBody.actor_instance_id),
        actorSessionId: workerIdentity?.agent_session_id ?? null,
      });
      if (coordination.kind === "deny") {
        res.status(409).json({ error: coordination.error, code: coordination.code });
        return;
      }

      const mutedBy = workerIdentity?.actor_label
        ?? deps.normalizeOptionalString(requestBody.muted_by)
        ?? req.sessionAccount?.display_name
        ?? req.sessionAccount?.login
        ?? "participant";

      await upsertStaleTaskPromptMute({
        room_id: project.id,
        task_id: task.id,
        task_updated_at: task.updated_at,
        muted_by: mutedBy,
      });

      const taskWithDetails = await attachTaskDetails(project.id, task);
      deps.taskEvents.emit("task:updated", { projectId: project.id, task: taskWithDetails });
      res.status(200).json({ ...taskWithDetails, room_id: project.id });
    } catch (error) {
      respondWithBadRequest(
        res,
        "POST /rooms/:room_id/tasks/:task_id/stale-prompt-mute",
        error,
        "Stale prompt mute could not be updated."
      );
    }
  });

  app.delete(/^\/rooms\/(.+)\/tasks\/([^/]+)\/stale-prompt-mute$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const taskId = (req.params as Record<string, string>)[1] ?? "";

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const isolation = await deps.enforceFocusParentBoardWriteIsolation({
      req,
      targetProject: project,
    });
    if (isolation.kind === "deny") {
      res.status(409).json({ error: isolation.error, code: isolation.code });
      return;
    }

    try {
      const task = await getTaskById(project.id, taskId);
      const taskOwnership = await getTaskOwnershipState(project.id, taskId);
      if (!task || !taskOwnership) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      const requestBody = (req.body ?? {}) as Record<string, unknown>;
      const workerWriteIdentity = await resolveOwnerTokenWorkerWriteIdentity({
        req,
        res,
        room_id: project.id,
        body: requestBody,
      });
      if (workerWriteIdentity.kind === "responded") return;
      const workerIdentity = workerWriteIdentity.kind === "worker" ? workerWriteIdentity.identity : null;
      const promptTimestamp = deps.normalizeOptionalString(requestBody.prompt_timestamp);
      if (!isCurrentStalePromptAction({ taskUpdatedAt: task.updated_at, promptTimestamp })) {
        const taskWithDetails = await attachTaskDetails(project.id, task);
        res.status(409).json({
          ...taskWithDetails,
          room_id: project.id,
          error: "This stale prompt is outdated because the task changed after it was posted.",
          code: "STALE_PROMPT_OUTDATED",
        });
        return;
      }

      const coordination = await deps.enforceTaskCoordinationMutation({
        req,
        projectId: project.id,
        task,
        taskOwnership,
        updates: {},
        forcedMutation: { mutation: "task_update", leaseKind: "work" },
        actorLabel: workerIdentity?.actor_label ?? normalizeTaskActorLabel(requestBody.actor_label),
        actorKey: workerIdentity?.agent_key ?? normalizeTaskActorKey(requestBody.actor_key),
        actorInstanceId: workerIdentity?.agent_instance_id ?? deps.normalizeOptionalString(requestBody.actor_instance_id),
        actorSessionId: workerIdentity?.agent_session_id ?? null,
      });
      if (coordination.kind === "deny") {
        res.status(409).json({ error: coordination.error, code: coordination.code });
        return;
      }

      await clearStaleTaskPromptMute(project.id, task.id);

      const taskWithDetails = await attachTaskDetails(project.id, task);
      deps.taskEvents.emit("task:updated", { projectId: project.id, task: taskWithDetails });
      res.status(200).json({ ...taskWithDetails, room_id: project.id });
    } catch (error) {
      respondWithBadRequest(
        res,
        "DELETE /rooms/:room_id/tasks/:task_id/stale-prompt-mute",
        error,
        "Stale prompt mute could not be cleared."
      );
    }
  });

  app.post(/^\/rooms\/(.+)\/tasks\/([^/]+)\/lease-action$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const taskId = (req.params as Record<string, string>)[1] ?? "";

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const isolation = await deps.enforceFocusParentBoardWriteIsolation({
      req,
      targetProject: project,
    });
    if (isolation.kind === "deny") {
      res.status(409).json({ error: isolation.error, code: isolation.code });
      return;
    }

    const task = await getTaskById(project.id, taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const requestBody = (req.body ?? {}) as LeaseActionRequestBody;
    const workerWriteIdentity = await resolveOwnerTokenWorkerWriteIdentity({
      req,
      res,
      room_id: project.id,
      body: requestBody as Record<string, unknown>,
    });
    if (workerWriteIdentity.kind === "responded") return;
    const workerIdentity = workerWriteIdentity.kind === "worker" ? workerWriteIdentity.identity : null;
    const action =
      requestBody.action === "handoff"
        ? "handoff"
        : requestBody.action === "release"
          ? "release"
          : null;
    if (!action) {
      res.status(400).json({ error: "action must be 'release' or 'handoff'" });
      return;
    }

    const actorLabel = workerIdentity?.actor_label
      ?? normalizeTaskActorLabel(requestBody.actor_label)
      ?? req.sessionAccount?.display_name
      ?? req.sessionAccount?.login
      ?? null;
    const actorInstanceId = workerIdentity?.agent_instance_id ?? normalizeTaskActorInstanceId(requestBody.actor_instance_id);
    const actorSessionId = workerIdentity?.agent_session_id ?? null;
    let actorKey: string | null = workerIdentity?.agent_key ?? null;
    if (req.authKind === "owner_token" && !workerIdentity) {
      const actorValidation = await deps.validateOwnerTokenTaskActorKey({
        req,
        actorKey: normalizeTaskActorKey(requestBody.actor_key),
      });
      if (actorValidation.error) {
        res.status(409).json({ error: actorValidation.error });
        return;
      }
      actorKey = actorValidation.actorKey;
    }

    const [leases, locks] = await Promise.all([
      getActiveTaskLeases(project.id, task.id),
      getActiveTaskLocks(project.id, task.id),
    ]);
    const activeWorkLease = getActiveWorkLease(leases);
    if (!activeWorkLease) {
      res.status(409).json({
        error: "No active work lease exists for this task",
        code: "coordination_missing_lease",
      });
      return;
    }

    if (requestBody.lease_id && requestBody.lease_id.trim() !== activeWorkLease.id) {
      res.status(409).json({
        error: `Lease ${requestBody.lease_id} is no longer the active work lease for this task`,
        code: "coordination_stale_lease_reference",
      });
      return;
    }

    const requesterIsLeaseHolder = req.authKind === "owner_token" && leaseMatchesActor(activeWorkLease, {
      actorLabel,
      agentKey: actorKey,
      agentInstanceId: actorInstanceId,
      agentSessionId: actorSessionId,
    });
    if (!requesterIsLeaseHolder) {
      if (!(await deps.requireAdmin(req, res, project))) return;
    }

    const targetActorKeyRaw = normalizeTaskActorKey(requestBody.target_actor_key);
    let targetActorKey: string | null = null;
    let targetActorInstanceId: string | null = null;
    let targetAgentSessionId: string | null = null;
    let targetActorLabel: string | null = null;
    if (action === "handoff") {
      if (!targetActorKeyRaw) {
        res.status(400).json({ error: "target_actor_key is required for handoff" });
        return;
      }

      if (req.authKind === "owner_token") {
        const targetValidation = await deps.validateOwnerTokenTaskActorKey({
          req,
          actorKey: targetActorKeyRaw,
        });
        if (targetValidation.error) {
          res.status(409).json({ error: targetValidation.error });
          return;
        }
        targetActorKey = targetValidation.actorKey ?? targetActorKeyRaw;
      } else {
        targetActorKey = targetActorKeyRaw;
      }
      const targetIdentity = await getAgentIdentityByCanonicalKey(targetActorKey);
      if (!targetIdentity) {
        res.status(404).json({ error: `Unknown target actor_key ${targetActorKey}` });
        return;
      }

      targetActorInstanceId = normalizeTaskActorInstanceId(requestBody.target_actor_instance_id);
      targetAgentSessionId = normalizeTaskActorLabel(requestBody.target_agent_session_id);
      const activeTargetSessions = await getActiveRoomAgentSessionsForWorkerIdentity({
        room_id: project.id,
        agent_key: targetActorKey,
      });
      let targetSessionRequiredReason: string | null = null;
      const selectedTargetSession = targetAgentSessionId
        ? activeTargetSessions.find((session) => session.session_id === targetAgentSessionId) ?? null
        : targetActorInstanceId
          ? (() => {
              const matchingSessions = activeTargetSessions.filter(
                (session) => session.agent_instance_id === targetActorInstanceId
              );
              if (matchingSessions.length > 1) {
                targetSessionRequiredReason =
                  `Multiple active worker sessions exist for target actor_key ${targetActorKey} and target_actor_instance_id ${targetActorInstanceId}; target_agent_session_id is required`;
                return null;
              }
              return matchingSessions[0] ?? null;
            })()
          : activeTargetSessions.length === 1
            ? activeTargetSessions[0] ?? null
            : null;

      if (!selectedTargetSession) {
        res.status(409).json({
          error: targetSessionRequiredReason ?? (targetAgentSessionId
            ? `No active worker session exists for target actor_key ${targetActorKey} and target_agent_session_id ${targetAgentSessionId}`
            : targetActorInstanceId
              ? `No active worker session exists for target actor_key ${targetActorKey} and target_actor_instance_id ${targetActorInstanceId}`
              : activeTargetSessions.length > 1
                ? `Multiple active worker sessions exist for target actor_key ${targetActorKey}; target_agent_session_id is required`
                : `No active worker session exists for target actor_key ${targetActorKey}`),
          code: "coordination_target_session_required",
        });
        return;
      }

      const selectedDeliverySession = await getReachableWorkerDeliverySessionForAgentSession({
        room_id: project.id,
        agent_session_id: selectedTargetSession.session_id,
      });
      if (!selectedDeliverySession) {
        res.status(409).json({
          error: `Target worker session ${selectedTargetSession.session_id} is not reachable in this room`,
          code: "coordination_target_session_unreachable",
        });
        return;
      }

      targetActorInstanceId = selectedTargetSession.agent_instance_id;
      targetAgentSessionId = selectedTargetSession.session_id;
      targetActorLabel = selectedTargetSession.actor_label || buildAgentActorLabel({
        display_name: targetIdentity.display_name,
        owner_label: targetIdentity.owner_label,
      });
    }

    try {
      if (action === "handoff" && !LEASE_RECOVERY_ACTIVE_STATUSES.has(task.status)) {
        res.status(409).json({
          error: `Cannot hand off a task in ${task.status} status`,
          code: "coordination_invalid_task_status",
        });
        return;
      }
      if (action === "handoff") {
        const lock = findApplicableLock({ locks, taskId: task.id });
        if (lock) {
          res.status(409).json({
            error: `Task handoff is blocked by ${lock.reason} lock ${lock.id}.`,
            code: "coordination_active_lock",
          });
          return;
        }
      }

      const dispositionReason =
        deps.normalizeOptionalString(requestBody.reason)
        ?? (action === "handoff"
          ? `Lease ${activeWorkLease.id} handed off for ${task.id}.`
          : `Lease ${activeWorkLease.id} released for ${task.id}.`);
      const leaseActionUpdates =
        action === "handoff"
          ? {
              status: "assigned" as const,
              assignee: targetActorLabel,
              assignee_agent_key: targetActorKey,
            }
          : LEASE_RECOVERY_ACTIVE_STATUSES.has(task.status)
            ? {
                status: "accepted" as const,
                assignee: null,
                assignee_agent_key: null,
              }
            : {};

      const leaseActionResult = await applyTaskWorkLeaseAction({
        room_id: project.id,
        task_id: task.id,
        active_lease_id: activeWorkLease.id,
        disposition_status: requesterIsLeaseHolder ? "released" : "revoked",
        disposition_reason: dispositionReason,
        task_updates: leaseActionUpdates,
        new_lease: action === "handoff" && targetActorKey && targetActorLabel
          ? {
              agent_key: targetActorKey,
              agent_instance_id: targetActorInstanceId,
              agent_session_id: targetAgentSessionId,
              actor_label: targetActorLabel,
              branch_ref: activeWorkLease.branch_ref ?? buildLeasedBranchRef({
                taskId: task.id,
                agentKey: targetActorKey,
              }),
              pr_url: activeWorkLease.pr_url ?? task.pr_url ?? null,
              created_by: actorLabel ?? req.sessionAccount?.login ?? "participant",
              output_intent: task.title,
            }
          : null,
      });

      if (leaseActionResult.conflict === "task_not_found") {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      if (leaseActionResult.conflict === "lease_not_active") {
        res.status(409).json({
          error: `Work lease ${activeWorkLease.id} is no longer active`,
          code: "coordination_stale_lease",
        });
        return;
      }
      if (leaseActionResult.conflict === "target_unreachable") {
        res.status(409).json({
          error: targetAgentSessionId
            ? `Target worker session ${targetAgentSessionId} is not reachable in this room`
            : "Target worker session is not reachable in this room",
          code: "coordination_target_session_unreachable",
        });
        return;
      }
      if (!leaseActionResult.task || !leaseActionResult.released_lease) {
        res.status(500).json({ error: "Lease action did not return an updated task and lease" });
        return;
      }

      const nextTask = leaseActionResult.task;
      const releasedLease = leaseActionResult.released_lease;
      const newLease = leaseActionResult.new_lease;
      if (nextTask.status !== task.status) {
        await deps.emitTaskLifecycleStatusMessage(project.id, nextTask);
      }

      await createCoordinationEvent({
        room_id: project.id,
        task_id: task.id,
        lease_id: newLease?.id ?? releasedLease?.id ?? activeWorkLease.id,
        event_type: action === "handoff" ? "task_lease_handoff" : "task_lease_release",
        decision: "record",
        actor_label: actorLabel,
        actor_key: actorKey,
        actor_instance_id: actorInstanceId,
        reason: dispositionReason,
        metadata: {
          action,
          previous_lease_id: activeWorkLease.id,
          previous_lease_status: releasedLease?.status ?? activeWorkLease.status,
          previous_agent_key: activeWorkLease.agent_key,
          target_actor_key: targetActorKey,
          target_actor_label: targetActorLabel,
          new_lease_id: newLease?.id ?? null,
          previous_task_status: task.status,
          next_task_status: nextTask.status,
        },
      });

      const taskWithDetails = await attachTaskDetails(project.id, nextTask);
      deps.taskEvents.emit("task:updated", { projectId: project.id, task: taskWithDetails });
      res.status(200).json({
        room_id: project.id,
        action,
        task: taskWithDetails,
        released_lease: releasedLease,
        new_lease: newLease,
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "POST /rooms/:room_id/tasks/:task_id/lease-action",
        error,
        "Task lease action could not be completed."
      );
    }
  });

  /**
   * GET /rooms/:room/tasks/github-status
   * Returns GitHub artifact status for all tasks in a room that have linked events.
   */
  app.get(/^(?:\/api)?\/rooms\/(.+)\/tasks\/github-status$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const statusMap = await getTasksGitHubArtifactStatus(project.id);

    const statuses: Record<string, TaskGitHubArtifactStatus> = {};
    for (const [taskId, status] of statusMap) {
      statuses[taskId] = status;
    }

    res.json({
      room_id: project.id,
      statuses,
    });
  });

  app.get(/^\/rooms\/(.+)\/tasks\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const taskId = (req.params as Record<string, string>)[1] ?? "";

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const task = await getTaskById(project.id, taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const taskWithDetails = await attachTaskDetails(project.id, task);

    res.json({ ...taskWithDetails, room_id: project.id });
  });

  app.patch(/^\/rooms\/(.+)\/tasks\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const taskId = (req.params as Record<string, string>)[1] ?? "";

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const isolation = await deps.enforceFocusParentBoardWriteIsolation({
      req,
      targetProject: project,
    });
    if (isolation.kind === "deny") {
      res.status(409).json({ error: isolation.error, code: isolation.code });
      return;
    }

    const task = await getTaskById(project.id, taskId);
    const taskOwnership = await getTaskOwnershipState(project.id, taskId);
    if (!task || !taskOwnership) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    const workerWriteIdentity = await resolveOwnerTokenWorkerWriteIdentity({
      req,
      res,
      room_id: project.id,
      body: requestBody,
    });
    if (workerWriteIdentity.kind === "responded") return;
    const workerIdentity = workerWriteIdentity.kind === "worker" ? workerWriteIdentity.identity : null;
    const workflow_artifacts = validateTaskWorkflowArtifactsInput(
      requestBody.workflow_artifacts
    );
    const patch = buildTaskUpdatePatch({
      body: requestBody,
      workflowArtifacts: workflow_artifacts,
    });
    const { updates } = patch;
    const actorLabel = workerIdentity?.actor_label ?? patch.actorLabel;
    const actorKey = workerIdentity?.agent_key ?? patch.actorKey;
    const actorInstanceId = workerIdentity?.agent_instance_id ?? deps.normalizeOptionalString(requestBody.actor_instance_id);
    if (workerIdentity && updates.assignee === workerIdentity.actor_label && !updates.assignee_agent_key) {
      updates.assignee_agent_key = workerIdentity.agent_key;
    }

    try {
      const adminOnlyStatuses = new Set<TaskStatus>(["accepted", "cancelled", "merged", "done"]);
      if (updates.status && adminOnlyStatuses.has(updates.status)) {
        if (!(await deps.requireAdmin(req, res, project))) return;
      }

      let verifiedActorKey = actorKey;
      if (
        requiresTaskOwnershipGuard({
          authKind: req.authKind,
          requestedStatus: updates.status,
          requestedAssignee: updates.assignee,
          requestedAssigneeAgentKey: updates.assignee_agent_key,
        })
      ) {
        const actorValidation = await deps.validateOwnerTokenTaskActorKey({
          req,
          actorKey,
        });
        if (actorValidation.error) {
          res.status(409).json({ error: actorValidation.error });
          return;
        }
        verifiedActorKey = actorValidation.actorKey;
      }

      const ownership = evaluateTaskOwnership({
        authKind: req.authKind,
        currentStatus: taskOwnership.status,
        currentAssignee: taskOwnership.assignee,
        currentAssigneeAgentKey: taskOwnership.assignee_agent_key,
        requestedStatus: updates.status,
        requestedAssignee: updates.assignee,
        requestedAssigneeAgentKey: updates.assignee_agent_key,
        actorLabel,
        actorKey: verifiedActorKey,
      });
      if (ownership.kind === "deny") {
        res.status(409).json({ error: ownership.error });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(ownership, "assigneeAgentKey")) {
        updates.assignee_agent_key = ownership.assigneeAgentKey;
      }

      const coordination = await deps.enforceTaskCoordinationMutation({
        req,
        projectId: project.id,
        task,
        taskOwnership,
        updates,
        actorLabel,
        actorKey: verifiedActorKey,
        actorInstanceId,
        actorSessionId: workerIdentity?.agent_session_id ?? null,
      });
      if (coordination.kind === "deny") {
        res.status(409).json({ error: coordination.error, code: coordination.code });
        return;
      }

      const updated = await updateTask(project.id, taskId, updates);
      if (updated && updates.status && updates.status !== task.status) {
        await deps.emitTaskLifecycleStatusMessage(project.id, updated);
      }

      if (updated) {
        const taskWithDetails = await attachTaskDetails(project.id, updated);
        deps.taskEvents.emit("task:updated", { projectId: project.id, task: taskWithDetails });
        res.json({ ...taskWithDetails, room_id: project.id });
      } else {
        res.status(404).json({ error: "Task not found" });
      }
    } catch (error) {
      respondWithBadRequest(
        res,
        "PATCH /rooms/:room_id/tasks/:task_id",
        error,
        "Task update could not be completed."
      );
    }
  });
}
