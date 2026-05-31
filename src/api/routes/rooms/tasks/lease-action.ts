import type { Express } from "express";

import {
  applyTaskWorkLeaseAction,
  createCoordinationEvent,
  getActiveRoomAgentSessionsForWorkerIdentity,
  getActiveTaskLeases,
  getActiveTaskLocks,
  getAgentIdentityByCanonicalKey,
  getReachableWorkerDeliverySessionForAgentSession,
  getTaskById,
} from "../../../db.js";
import { buildLeasedBranchRef } from "../../../github/lease-enforcement.js";
import {
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../../../http/helpers.js";
import { normalizeRoomId } from "../../../rooms/routing.js";
import {
  normalizeTaskActorInstanceId,
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
} from "../../../tasks/ownership.js";
import {
  findApplicableLock,
  leaseMatchesActor,
} from "../../../coordination-policy.js";
import { buildAgentActorLabel } from "../../../../shared/agent-identity.js";
import { isDesktopHumanWrite, resolveOwnerTokenWorkerWriteIdentity } from "./request-identity.js";
import { attachTaskDetails } from "./task-details.js";
import { getActiveWorkLease, LEASE_RECOVERY_ACTIVE_STATUSES } from "./lease-helpers.js";
import type { RoomTaskRouteDeps } from "./types.js";

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

export function registerTaskLeaseActionRoute(
  app: Express,
  deps: RoomTaskRouteDeps
): void {
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
    const desktopHumanWrite = isDesktopHumanWrite(req, requestBody as Record<string, unknown>);
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
    if (req.authKind === "owner_token" && !workerIdentity && !desktopHumanWrite) {
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

      if (req.authKind === "owner_token" && !desktopHumanWrite) {
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
}
