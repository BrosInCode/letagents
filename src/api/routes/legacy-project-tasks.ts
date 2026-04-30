import type { Express, Response } from "express";

import {
  createCoordinationEvent,
  createTask,
  getOpenTasks,
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
import {
  requireWorkerRequestAgentIdentity,
  type ResolvedRequestAgentIdentity,
} from "../request-agent-identity.js";
import { validateTaskWorkflowArtifactsInput } from "../repo-workflow.js";
import { normalizeRoomId } from "../room-routing.js";
import {
  buildTaskUpdatePatch,
  evaluateTaskOwnership,
  normalizeTaskActorKey,
  requiresTaskOwnershipGuard,
} from "../task-ownership.js";
import type { FocusParentBoardWriteIsolationDecision } from "../focus-room-task-write-isolation.js";

type TaskUpdatePatch = ReturnType<typeof buildTaskUpdatePatch>["updates"];

type TaskCoordinationGuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; error: string };

type TaskOwnershipState = NonNullable<Awaited<ReturnType<typeof getTaskOwnershipState>>>;

type OwnerTokenWorkerWriteIdentity =
  | { kind: "not_owner_token" }
  | { kind: "worker"; identity: ResolvedRequestAgentIdentity }
  | { kind: "responded" };

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

export interface LegacyProjectTaskRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  getProjectById(projectId: string): Promise<Project | undefined>;
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
    actorSessionId: string | null;
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
    actorSessionId: string | null;
  }): Promise<TaskCoordinationGuardDecision>;
  enforceFocusParentBoardWriteIsolation(input: {
    req: AuthenticatedRequest;
    targetProject: Project;
  }): Promise<FocusParentBoardWriteIsolationDecision>;
}

export function registerLegacyProjectTaskRoutes(
  app: Express,
  deps: LegacyProjectTaskRouteDeps
): void {
  app.post("/projects/:id/tasks", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await deps.getProjectById(projectId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    const workerWriteIdentity = await resolveOwnerTokenWorkerWriteIdentity({
      req,
      res,
      room_id: projectId,
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

    if (!(await deps.requireParticipant(req, res, project))) {
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
      projectId,
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

    const task = await createTask(projectId, title, createdBy, description, source_message_id);

    if (req.authKind === "owner_token") {
      await createCoordinationEvent({
        room_id: projectId,
        task_id: task.id,
        event_type: "task_admit",
        decision: "record",
        actor_label: effectiveActorLabel,
        actor_key: normalizeTaskActorKey(effectiveActorKey),
        actor_instance_id: effectiveActorInstanceId,
        reason: "Agent-created task requires coordinator acceptance before it is claimable.",
      });
      res.status(201).json(task);
      return;
    }

    if (!(await deps.isTrustedAgentCreator(projectId, createdBy))) {
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
    const project = await deps.getProjectById(projectId);

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
    const project = await deps.getProjectById(projectId);
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

    const project = await deps.getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) {
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

    const task = await getTaskById(projectId, taskId);
    const taskOwnership = await getTaskOwnershipState(projectId, taskId);

    if (!task || !taskOwnership) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    const workerWriteIdentity = await resolveOwnerTokenWorkerWriteIdentity({
      req,
      res,
      room_id: projectId,
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
    const actorSessionId = workerIdentity?.agent_session_id ?? null;
    if (workerIdentity && updates.assignee === workerIdentity.actor_label && !updates.assignee_agent_key) {
      updates.assignee_agent_key = workerIdentity.agent_key;
    }

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
        actorSessionId,
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
