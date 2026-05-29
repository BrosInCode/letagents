import type { Express } from "express";

import {
  clearStaleTaskPromptMute,
  getTaskById,
  getTaskOwnershipState,
  upsertStaleTaskPromptMute,
} from "../../db.js";
import {
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../../http/helpers.js";
import { normalizeRoomId } from "../../rooms/routing.js";
import {
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
} from "../../tasks/ownership.js";
import { resolveOwnerTokenWorkerWriteIdentity } from "./request-identity.js";
import {
  attachTaskDetails,
  isCurrentStalePromptAction,
} from "./task-details.js";
import type { RoomTaskRouteDeps } from "./types.js";

export function registerTaskStalePromptRoutes(
  app: Express,
  deps: RoomTaskRouteDeps
): void {
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
}
