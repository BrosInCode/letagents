import type { Express, Response } from "express";

import {
  createCoordinationEvent,
  createTask,
  getOpenTasks,
  getProjectById,
  getTaskById,
  getTaskOwnershipState,
  getTasks,
  updateTask,
  type Project,
  type Task,
  type TaskStatus,
} from "../db.js";
import {
  parseLimit,
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../http-helpers.js";
import { validateTaskWorkflowArtifactsInput } from "../repo-workflow.js";
import { normalizeRoomId } from "../room-routing.js";
import {
  buildTaskUpdatePatch,
  evaluateTaskOwnership,
  normalizeTaskActorKey,
  requiresTaskOwnershipGuard,
} from "../task-ownership.js";

type TaskUpdatePatch = ReturnType<typeof buildTaskUpdatePatch>["updates"];

type TaskCoordinationGuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; error: string };

type TaskOwnershipState = NonNullable<Awaited<ReturnType<typeof getTaskOwnershipState>>>;

export interface LegacyProjectTaskRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
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
  normalizeOptionalString(value: unknown): string | null;
  enforceTaskAdmissionCoordination(input: {
    req: AuthenticatedRequest;
    projectId: string;
    title: string;
    sourceMessageId?: string | null;
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
  }): Promise<TaskCoordinationGuardDecision>;
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
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
  }): Promise<TaskCoordinationGuardDecision>;
}

export function registerLegacyProjectTaskRoutes(
  app: Express,
  deps: LegacyProjectTaskRouteDeps
): void {
  app.post("/projects/:id/tasks", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await getProjectById(projectId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

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

    if (!(await deps.requireParticipant(req, res, project))) {
      return;
    }

    const admission = await deps.enforceTaskAdmissionCoordination({
      req,
      projectId,
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

    const task = await createTask(projectId, title, created_by, description, source_message_id);

    if (req.authKind === "owner_token") {
      await createCoordinationEvent({
        room_id: projectId,
        task_id: task.id,
        event_type: "task_admit",
        decision: "record",
        actor_label: created_by,
        actor_key: normalizeTaskActorKey(actor_key),
        actor_instance_id: deps.normalizeOptionalString(actor_instance_id),
        reason: "Agent-created task requires coordinator acceptance before it is claimable.",
      });
      res.status(201).json(task);
      return;
    }

    if (!(await deps.isTrustedAgentCreator(projectId, created_by))) {
      res.status(201).json(task);
      return;
    }

    const acceptedTask = await updateTask(projectId, task.id, { status: "accepted" });
    if (!acceptedTask) {
      res.status(500).json({ error: "Task created but could not be auto-accepted" });
      return;
    }

    await deps.emitTaskLifecycleStatusMessage(projectId, acceptedTask);
    res.status(201).json(acceptedTask);
  });

  app.get("/projects/:id/tasks", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await getProjectById(projectId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) {
      return;
    }

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const open = req.query.open === "true";
    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const after = typeof req.query.after === "string" ? req.query.after : undefined;

    const result = open ? await getOpenTasks(projectId, { limit, after }) : await getTasks(projectId, status, { limit, after });
    res.json({ project_id: projectId, tasks: result.tasks, has_more: result.has_more });
  });

  app.get("/projects/:id/tasks/:taskId", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await getProjectById(projectId);
    const taskId = String(req.params.taskId);
    const task = await getTaskById(projectId, taskId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) {
      return;
    }

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.json(task);
  });

  app.patch("/projects/:id/tasks/:taskId", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const taskId = String(req.params.taskId);
    const task = await getTaskById(projectId, taskId);
    const taskOwnership = await getTaskOwnershipState(projectId, taskId);

    if (!task || !taskOwnership) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const project = await getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) {
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
        if (!(await deps.requireAdmin(req, res, project))) {
          return;
        }
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
        projectId,
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

      const updated = await updateTask(projectId, taskId, updates);
      if (updated && updates.status && updates.status !== task.status) {
        await deps.emitTaskLifecycleStatusMessage(projectId, updated);
      }
      res.json(updated);
    } catch (error) {
      respondWithBadRequest(
        res,
        "PATCH /projects/:id/tasks/:taskId",
        error,
        "Task update could not be completed."
      );
    }
  });
}
