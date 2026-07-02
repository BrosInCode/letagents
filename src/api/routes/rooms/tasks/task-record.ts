import type { Express } from "express";

import {
  BoardIntentApprovalConsumptionError,
  getActiveTaskLeases,
  getTaskById,
  getTaskOwnershipState,
  updateTask,
  type TaskStatus,
} from "../../../db.js";
import {
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../../../http/helpers.js";
import { validateTaskWorkflowArtifactsInput } from "../../../repo-workflow.js";
import { normalizeRoomId } from "../../../rooms/routing.js";
import {
  buildTaskUpdatePatch,
  evaluateTaskOwnership,
  normalizeTaskActorKey,
  requiresTaskOwnershipGuard,
} from "../../../tasks/ownership.js";
import { findBoardReviewLeaseForMerge } from "../../../coordination-policy.js";
import { resolveOwnerTokenWorkerWriteIdentity } from "./request-identity.js";
import { attachTaskDetails } from "./task-details.js";
import type { RoomTaskRouteDeps } from "./types.js";

export function registerTaskRecordRoutes(
  app: Express,
  deps: RoomTaskRouteDeps
): void {
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

      const isReviewChangeRequest = updates.status === "blocked" && task.status === "in_review";
      const reviewDecisionOnly =
        isReviewChangeRequest &&
        updates.assignee === undefined &&
        updates.assignee_agent_key === undefined &&
        updates.pr_url === undefined &&
        updates.workflow_artifacts === undefined;

      if (isReviewChangeRequest && !reviewDecisionOnly) {
        res.status(409).json({
          error: "Requesting changes can only update task status. Work metadata requires the active work lease.",
          code: "coordination_review_decision_only",
        });
        return;
      }

      if (isReviewChangeRequest && req.authKind !== "owner_token") {
        res.status(403).json({
          error: "Registered review worker session is required to request changes.",
          code: "coordination_review_worker_required",
        });
        return;
      }

      let verifiedActorKey = actorKey;
      if (
        requiresTaskOwnershipGuard({
          authKind: req.authKind,
          requestedStatus: updates.status,
          requestedAssignee: updates.assignee,
          requestedAssigneeAgentKey: updates.assignee_agent_key,
        }) &&
        !reviewDecisionOnly
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

      if (!reviewDecisionOnly) {
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
      }

      if (updates.status === "merged" && task.status === "in_review") {
        const reviewLease = findBoardReviewLeaseForMerge({
          taskId: task.id,
          leases: await getActiveTaskLeases(project.id, task.id),
        });
        if (!reviewLease) {
          res.status(409).json({
            error: "Assign a board reviewer separate from the active work holder before marking this task merged.",
            code: "coordination_board_review_required",
          });
          return;
        }
      }

      const forcedReviewMutation =
        isReviewChangeRequest
          ? { mutation: "task_update" as const, leaseKind: "review" as const }
          : undefined;

      const coordination = await deps.enforceTaskCoordinationMutation({
        req,
        projectId: project.id,
        task,
        taskOwnership,
        updates,
        forcedMutation: forcedReviewMutation,
        actorLabel,
        actorKey: verifiedActorKey,
        actorInstanceId,
        actorSessionId: workerIdentity?.agent_session_id ?? null,
        boardIntentId: deps.normalizeOptionalString(requestBody.board_intent_id),
        boardApprovalToken: deps.normalizeOptionalString(requestBody.board_approval_token),
      });
      if (coordination.kind === "deny") {
        res.status(409).json({ error: coordination.error, code: coordination.code });
        return;
      }

      const updated = await updateTask(
        project.id,
        taskId,
        updates,
        { boardIntentApproval: coordination.boardIntentApproval ?? null }
      );
      if (updated && updates.status && updates.status !== task.status) {
        await deps.emitTaskLifecycleStatusMessage(project.id, updated);
      }

      if (updated) {
        await deps.ensureTaskGitRoomForActiveWorkLease?.({
          parentRoomId: project.id,
          taskId: updated.id,
        });
        const taskWithDetails = await attachTaskDetails(project.id, updated);
        deps.taskEvents.emit("task:updated", { projectId: project.id, task: taskWithDetails });
        res.json({ ...taskWithDetails, room_id: project.id });
      } else {
        res.status(404).json({ error: "Task not found" });
      }
    } catch (error) {
      if (error instanceof BoardIntentApprovalConsumptionError) {
        res.status(409).json({ error: error.message, code: error.code });
        return;
      }
      respondWithBadRequest(
        res,
        "PATCH /rooms/:room_id/tasks/:task_id",
        error,
        "Task update could not be completed."
      );
    }
  });
}
