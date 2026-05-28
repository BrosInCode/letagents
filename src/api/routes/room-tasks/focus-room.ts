import type { Express } from "express";

import {
  assignProjectAdmin,
  createFocusRoomForTask,
  getTaskById,
  getTaskOwnershipState,
} from "../../db.js";
import {
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../../http-helpers.js";
import { normalizeRoomId } from "../../room-routing.js";
import {
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
} from "../../task-ownership.js";
import { resolveOwnerTokenWorkerWriteIdentity } from "./request-identity.js";
import type { RoomTaskRouteDeps } from "./types.js";

export function registerTaskFocusRoomRoute(
  app: Express,
  deps: RoomTaskRouteDeps
): void {
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
}
