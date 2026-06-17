import type { Express } from "express";

import {
  createCoordinationEvent,
  createTask,
  findTaskBySourceMessageId,
  getOpenTasks,
  getTasks,
  updateTask,
} from "../../../db.js";
import { parseLimit, type AuthenticatedRequest } from "../../../http/helpers.js";
import { normalizeRoomId } from "../../../rooms/routing.js";
import { normalizeTaskActorKey } from "../../../tasks/ownership.js";
import {
  isDesktopHumanWrite,
  resolveOwnerTokenWorkerWriteIdentity,
} from "./request-identity.js";
import { attachTaskDetails, attachTaskListDetails } from "./task-details.js";
import type { RoomTaskRouteDeps } from "./types.js";

export function registerTaskListAndCreateRoutes(
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

    const { title, description, created_by, source_message_id, actor_label, actor_key, actor_instance_id, client_task_id } = requestBody as {
      title?: string;
      description?: string;
      created_by?: string;
      source_message_id?: string;
      actor_label?: string;
      actor_key?: string;
      actor_instance_id?: string;
      client_task_id?: string;
    };

    const createdBy = workerIdentity?.actor_label ?? created_by ?? null;
    const effectiveActorLabel = workerIdentity?.actor_label ?? actor_label ?? createdBy;
    const effectiveActorKey = workerIdentity?.agent_key ?? actor_key ?? null;
    const effectiveActorInstanceId = workerIdentity?.agent_instance_id ?? deps.normalizeOptionalString(actor_instance_id);
    const effectiveActorSessionId = workerIdentity?.agent_session_id ?? null;
    const clientTaskId = deps.normalizeOptionalString(client_task_id);
    const sourceMessageId = clientTaskId ?? deps.normalizeOptionalString(source_message_id) ?? null;

    if (!title || !createdBy) {
      res.status(400).json({ error: "title and created_by are required" });
      return;
    }

    if (clientTaskId) {
      const existingTask = await findTaskBySourceMessageId(project.id, clientTaskId);
      if (existingTask) {
        const taskWithDetails = await attachTaskDetails(project.id, existingTask);
        res.status(200).json({ ...taskWithDetails, room_id: project.id, idempotent: true });
        return;
      }
    }

    const admission = await deps.enforceTaskAdmissionCoordination({
      req,
      projectId: project.id,
      title,
      sourceMessageId,
      actorLabel: effectiveActorLabel,
      actorKey: effectiveActorKey,
      actorInstanceId: effectiveActorInstanceId,
      actorSessionId: effectiveActorSessionId,
    });
    if (admission.kind === "deny") {
      res.status(409).json({ error: admission.error, code: admission.code });
      return;
    }

    let task: Awaited<ReturnType<typeof createTask>>;
    try {
      task = await createTask(project.id, title, createdBy, description, sourceMessageId ?? undefined);
    } catch (error) {
      if (sourceMessageId) {
        const existingTask = await findTaskBySourceMessageId(project.id, sourceMessageId);
        if (existingTask) {
          const taskWithDetails = await attachTaskDetails(project.id, existingTask);
          res.status(200).json({ ...taskWithDetails, room_id: project.id, idempotent: true });
          return;
        }
      }
      throw error;
    }

    if (req.authKind === "owner_token" && !isDesktopHumanWrite(req, requestBody)) {
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
}
