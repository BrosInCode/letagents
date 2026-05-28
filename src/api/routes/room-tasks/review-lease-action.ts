import type { Express } from "express";

import {
  createCoordinationEvent,
  createTaskLease,
  getActiveRoomAgentSessionsForWorkerIdentity,
  getActiveTaskLeases,
  getAgentIdentityByCanonicalKey,
  getReachableWorkerDeliverySessionForAgentSession,
  getTaskById,
  releaseTaskLease,
} from "../../db.js";
import {
  type AuthenticatedRequest,
} from "../../http-helpers.js";
import { normalizeRoomId } from "../../room-routing.js";
import {
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
} from "../../task-ownership.js";
import {
  evaluateReviewLeaseRouting,
  leaseMatchesActor,
} from "../../coordination-policy/index.js";
import { buildAgentActorLabel } from "../../../shared/agent-identity.js";
import { resolveOwnerTokenWorkerWriteIdentity } from "./request-identity.js";
import { attachTaskDetails } from "./task-details.js";
import {
  getActiveReviewLeaseForActor,
  getActiveReviewLeaseForAgentKey,
  getActiveWorkLease,
  REVIEW_LEASE_ACTIVE_STATUSES,
  targetMatchesWorkLease,
} from "./lease-helpers.js";
import type { RoomTaskRouteDeps } from "./types.js";

type ReviewLeaseActionRequestBody = {
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

export function registerTaskReviewLeaseActionRoute(
  app: Express,
  deps: RoomTaskRouteDeps
): void {
  app.post(/^\/rooms\/(.+)\/tasks\/([^/]+)\/review-lease-action$/, async (req: AuthenticatedRequest, res) => {
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

    const requestBody = (req.body ?? {}) as ReviewLeaseActionRequestBody & Record<string, unknown>;
    const action = deps.normalizeOptionalString(requestBody.action);
    if (!action || !["assign", "claim", "release"].includes(action)) {
      res.status(400).json({ error: "action must be one of: assign, claim, release" });
      return;
    }

    const workerWriteIdentity = await resolveOwnerTokenWorkerWriteIdentity({
      req,
      res,
      room_id: project.id,
      body: requestBody,
    });
    if (workerWriteIdentity.kind === "responded") return;
    const workerIdentity = workerWriteIdentity.kind === "worker" ? workerWriteIdentity.identity : null;

    const leases = await getActiveTaskLeases(project.id, task.id);
    const activeWorkLease = getActiveWorkLease(leases);
    const role = await deps.resolveProjectRole(project, req.sessionAccount);
    const requesterIsAdmin = role === "admin";

    if (action === "release") {
      const requestedLeaseId = deps.normalizeOptionalString(requestBody.lease_id);
      const actorKey = workerIdentity?.agent_key ?? normalizeTaskActorKey(requestBody.actor_key);
      const actorLabel = workerIdentity?.actor_label ?? normalizeTaskActorLabel(requestBody.actor_label);
      const actorInstanceId =
        workerIdentity?.agent_instance_id ?? deps.normalizeOptionalString(requestBody.actor_instance_id);
      const actorSessionId = workerIdentity?.agent_session_id ?? null;
      const reviewLease = requestedLeaseId
        ? leases.find((lease) => lease.id === requestedLeaseId && lease.kind === "review") ?? null
        : getActiveReviewLeaseForActor({
            leases,
            actorKey,
            actorLabel,
            actorInstanceId,
            actorSessionId,
          });

      if (!reviewLease) {
        res.status(404).json({ error: "Active review lease not found" });
        return;
      }
      if (!requesterIsAdmin && !leaseMatchesActor(reviewLease, {
        actorLabel,
        agentKey: actorKey,
        agentInstanceId: actorInstanceId,
        agentSessionId: actorSessionId,
      })) {
        res.status(403).json({
          error: "Only the review lease holder or a room admin can release this review assignment.",
          code: "coordination_review_lease_forbidden",
        });
        return;
      }

      const releasedLease = await releaseTaskLease(project.id, reviewLease.id);
      await createCoordinationEvent({
        room_id: project.id,
        task_id: task.id,
        lease_id: releasedLease?.id ?? reviewLease.id,
        event_type: "task_review_lease_release",
        decision: "record",
        actor_label: actorLabel ?? req.sessionAccount?.login ?? "participant",
        actor_key: actorKey,
        actor_instance_id: actorInstanceId,
        reason: deps.normalizeOptionalString(requestBody.reason)
          ?? `Released review lease ${reviewLease.id} for ${task.id}.`,
      });

      const taskWithDetails = await attachTaskDetails(project.id, task);
      deps.taskEvents.emit("task:updated", { projectId: project.id, task: taskWithDetails });
      res.status(200).json({
        room_id: project.id,
        action,
        task: taskWithDetails,
        released_lease: releasedLease,
      });
      return;
    }

    if (!REVIEW_LEASE_ACTIVE_STATUSES.has(task.status)) {
      res.status(409).json({
        error: `Cannot assign review authority while task is ${task.status}. Move the task to in_review first.`,
        code: "coordination_invalid_task_status",
      });
      return;
    }

    let targetActorKey: string | null = null;
    let targetActorLabel: string | null = null;
    let targetActorInstanceId: string | null = null;
    let targetAgentSessionId: string | null = null;

    if (action === "claim") {
      if (!workerIdentity) {
        res.status(403).json({
          error: "Registered worker session is required to claim review authority.",
          code: "coordination_worker_required",
        });
        return;
      }

      const routing = evaluateReviewLeaseRouting({
        taskId: task.id,
        actor: {
          actorLabel: workerIdentity.actor_label,
          agentKey: workerIdentity.agent_key,
          agentInstanceId: workerIdentity.agent_instance_id,
          agentSessionId: workerIdentity.agent_session_id,
        },
        leases,
      });
      if (routing.kind === "deny") {
        res.status(409).json({ error: routing.reason, code: `coordination_${routing.code}` });
        return;
      }
      if (routing.existingReviewLease) {
        const taskWithDetails = await attachTaskDetails(project.id, task);
        res.status(200).json({
          room_id: project.id,
          action,
          task: taskWithDetails,
          lease: routing.existingReviewLease,
        });
        return;
      }

      targetActorKey = workerIdentity.agent_key;
      targetActorLabel = workerIdentity.actor_label;
      targetActorInstanceId = workerIdentity.agent_instance_id;
      targetAgentSessionId = workerIdentity.agent_session_id;
    } else {
      if (!requesterIsAdmin) {
        res.status(403).json({
          error: "Only room admins can assign review authority to another worker.",
          code: "coordination_review_assignment_admin_required",
        });
        return;
      }

      targetActorKey = normalizeTaskActorKey(requestBody.target_actor_key);
      targetActorInstanceId = deps.normalizeOptionalString(requestBody.target_actor_instance_id);
      targetAgentSessionId = deps.normalizeOptionalString(requestBody.target_agent_session_id);
      if (!targetActorKey) {
        res.status(400).json({ error: "target_actor_key is required for review assignment" });
        return;
      }

      const targetIdentity = await getAgentIdentityByCanonicalKey(targetActorKey);
      if (!targetIdentity) {
        res.status(404).json({ error: `Unknown target actor_key ${targetActorKey}` });
        return;
      }

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

    if (!targetActorKey || !targetActorLabel) {
      res.status(500).json({ error: "Review assignment target could not be resolved" });
      return;
    }

    if (targetMatchesWorkLease({
      lease: activeWorkLease,
      targetActorKey,
    })) {
      res.status(409).json({
        error: "The active work lease holder cannot also hold review authority for the same task.",
        code: "coordination_work_lease_holder",
      });
      return;
    }

    const existingReviewLease = getActiveReviewLeaseForAgentKey(leases, targetActorKey);
    if (existingReviewLease) {
      const taskWithDetails = await attachTaskDetails(project.id, task);
      res.status(200).json({
        room_id: project.id,
        action,
        task: taskWithDetails,
        lease: existingReviewLease,
      });
      return;
    }

    const reviewLease = await createTaskLease({
      room_id: project.id,
      task_id: task.id,
      kind: "review",
      agent_key: targetActorKey,
      agent_instance_id: targetActorInstanceId,
      agent_session_id: targetAgentSessionId,
      actor_label: targetActorLabel,
      branch_ref: activeWorkLease?.branch_ref ?? null,
      pr_url: activeWorkLease?.pr_url ?? task.pr_url ?? null,
      created_by: workerIdentity?.actor_label ?? req.sessionAccount?.login ?? "participant",
      output_intent: `Review ${task.id}: ${task.title}`,
    });

    await createCoordinationEvent({
      room_id: project.id,
      task_id: task.id,
      lease_id: reviewLease.id,
      event_type: action === "claim" ? "task_review_lease_claim" : "task_review_lease_assign",
      decision: "record",
      actor_label: workerIdentity?.actor_label ?? req.sessionAccount?.login ?? "participant",
      actor_key: workerIdentity?.agent_key ?? null,
      actor_instance_id: workerIdentity?.agent_instance_id ?? null,
      reason: deps.normalizeOptionalString(requestBody.reason)
        ?? `${targetActorLabel} assigned review authority for ${task.id}.`,
    });

    const taskWithDetails = await attachTaskDetails(project.id, task);
    deps.taskEvents.emit("task:updated", { projectId: project.id, task: taskWithDetails });
    res.status(200).json({
      room_id: project.id,
      action,
      task: taskWithDetails,
      lease: reviewLease,
    });
  });
}
