import type { EventEmitter } from "events";
import type { Express, Response } from "express";

import {
  assignProjectAdmin,
  clearStaleTaskPromptMute,
  createCoordinationEvent,
  createFocusRoomForTask,
  createTask,
  getActiveTaskLeases,
  getActiveTaskLocks,
  getOpenTasks,
  getStaleTaskPromptMutes,
  getTaskById,
  getTaskOwnershipState,
  getTasks,
  getTasksGitHubArtifactStatus,
  upsertStaleTaskPromptMute,
  updateTask,
  type Project,
  type Task,
  type TaskGitHubArtifactStatus,
  type TaskStatus,
} from "../db.js";
import {
  parseLimit,
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../http-helpers.js";
import { validateTaskWorkflowArtifactsInput } from "../repo-workflow.js";
import { normalizeRoomId } from "../room-routing.js";
import { getTaskStalePromptState } from "../stale-work.js";
import {
  buildTaskUpdatePatch,
  evaluateTaskOwnership,
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
  requiresTaskOwnershipGuard,
} from "../task-ownership.js";
import type { FocusParentBoardWriteIsolationDecision } from "../focus-room-task-write-isolation.js";

type RoomRole = "admin" | "participant" | "anonymous";
type TaskUpdatePatch = ReturnType<typeof buildTaskUpdatePatch>["updates"];
type TaskOwnershipState = NonNullable<Awaited<ReturnType<typeof getTaskOwnershipState>>>;

type TaskCoordinationGuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; error: string };

type TaskAdmissionGuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; error: string };

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
    forcedMutation?: { mutation: "focus_room_open"; leaseKind: "work" };
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
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

    const { title, description, created_by, source_message_id, actor_label, actor_key, actor_instance_id } = req.body as {
      title?: string;
      description?: string;
      created_by?: string;
      source_message_id?: string;
      actor_label?: string;
      actor_key?: string;
      actor_instance_id?: string;
    };

    if (!title || !created_by) {
      res.status(400).json({ error: "title and created_by are required" });
      return;
    }

    const isolation = await deps.enforceFocusParentBoardWriteIsolation({
      req,
      targetProject: project,
    });
    if (isolation.kind === "deny") {
      res.status(409).json({ error: isolation.error, code: isolation.code });
      return;
    }

    const admission = await deps.enforceTaskAdmissionCoordination({
      req,
      projectId: project.id,
      title,
      sourceMessageId: source_message_id ?? null,
      actorLabel: actor_label ?? created_by,
      actorKey: actor_key ?? null,
      actorInstanceId: deps.normalizeOptionalString(actor_instance_id),
    });
    if (admission.kind === "deny") {
      res.status(409).json({ error: admission.error, code: admission.code });
      return;
    }

    const task = await createTask(project.id, title, created_by, description, source_message_id);

    if (req.authKind === "owner_token") {
      await createCoordinationEvent({
        room_id: project.id,
        task_id: task.id,
        event_type: "task_admit",
        decision: "record",
        actor_label: created_by,
        actor_key: normalizeTaskActorKey(actor_key),
        actor_instance_id: deps.normalizeOptionalString(actor_instance_id),
        reason: "Agent-created task requires coordinator acceptance before it is claimable.",
      });
      res.status(201).json({ ...task, room_id: project.id });
      return;
    }

    if (!(await deps.isTrustedAgentCreator(project.id, created_by))) {
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
        actorLabel: normalizeTaskActorLabel(requestBody.actor_label),
        actorKey: normalizeTaskActorKey(requestBody.actor_key),
        actorInstanceId: deps.normalizeOptionalString(requestBody.actor_instance_id),
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

    try {
      const task = await getTaskById(project.id, taskId);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      const requestBody = (req.body ?? {}) as { muted_by?: unknown };
      const mutedBy = deps.normalizeOptionalString(requestBody.muted_by)
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

    try {
      const task = await getTaskById(project.id, taskId);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
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
    const workflow_artifacts = validateTaskWorkflowArtifactsInput(
      requestBody.workflow_artifacts
    );
    const { updates, actorLabel, actorKey } = buildTaskUpdatePatch({
      body: requestBody,
      workflowArtifacts: workflow_artifacts,
    });
    const actorInstanceId = deps.normalizeOptionalString(requestBody.actor_instance_id);

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
