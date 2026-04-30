import type {
  AgentIdentity,
  Task,
  TaskLeaseKind,
  TaskOwnershipState,
} from "./db.js";
import type { AuthenticatedRequest } from "./http-helpers.js";
import {
  evaluateTaskAdmission,
  evaluateCoordinationMutation,
  findApplicableLock,
  type CoordinationFocusRoomLike,
  type CoordinationLeaseLike,
  type CoordinationLockLike,
  type CoordinationMutationKind,
  type CoordinationTaskLike,
} from "./coordination-policy.js";
import { buildLeasedBranchRef } from "./github-lease-enforcement.js";
import {
  classifyTaskCoordinationMutation,
  getTaskUpdatePrUrlBinding,
  type TaskCoordinationUpdatePatch,
} from "./task-coordination-inputs.js";
import {
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
} from "./task-ownership.js";

export type TaskCoordinationGuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; error: string };

export interface RecordCoordinationDecisionInput {
  roomId: string;
  taskId: string | null;
  mutation: CoordinationMutationKind;
  decision: "allow" | "deny";
  actorLabel: string | null;
  actorKey: string | null;
  actorInstanceId: string | null;
  reason?: string | null;
  leaseId?: string | null;
  lockId?: string | null;
}

export interface TaskCoordinationEnforcementDeps {
  getAgentIdentityByCanonicalKey(
    canonicalKey: string
  ): Promise<Pick<AgentIdentity, "canonical_key" | "owner_account_id"> | null>;
  createCoordinationEvent(input: {
    room_id: string;
    task_id?: string | null;
    event_type: string;
    decision?: "allow" | "deny" | "record";
    actor_label?: string | null;
    actor_key?: string | null;
    actor_instance_id?: string | null;
    reason?: string | null;
    lease_id?: string | null;
    lock_id?: string | null;
  }): Promise<unknown>;
  getActiveTaskLocks(roomId: string, taskId?: string): Promise<CoordinationLockLike[]>;
  getTasks(
    roomId: string,
    statusFilter?: string,
    options?: { limit?: number; after?: string }
  ): Promise<{ tasks: CoordinationTaskLike[]; has_more: boolean }>;
  getFocusRoomsForParent(parentRoomId: string): Promise<CoordinationFocusRoomLike[]>;
  getActiveTaskLeases(roomId: string, taskId?: string): Promise<CoordinationLeaseLike[]>;
  createTaskLease(input: {
    room_id: string;
    task_id: string;
    kind: TaskLeaseKind;
    agent_key: string;
    actor_label: string;
    created_by: string;
    agent_instance_id?: string | null;
    agent_session_id?: string | null;
    branch_ref?: string | null;
    pr_url?: string | null;
    output_intent?: string | null;
    expires_at?: string | null;
  }): Promise<CoordinationLeaseLike>;
  updateTaskLeaseWorkflowRefs(
    roomId: string,
    leaseId: string,
    updates: { branch_ref?: string | null; pr_url?: string | null }
  ): Promise<unknown>;
}

export interface TaskCoordinationMutationInput {
  req: AuthenticatedRequest;
  projectId: string;
  task: Task;
  taskOwnership: TaskOwnershipState;
  updates: TaskCoordinationUpdatePatch;
  forcedMutation?: { mutation: CoordinationMutationKind; leaseKind: TaskLeaseKind };
  actorLabel: string | null;
  actorKey: string | null;
  actorInstanceId: string | null;
  actorSessionId: string | null;
}

function taskIsAssignedToActor(input: {
  taskOwnership: TaskOwnershipState;
  actorLabel: string;
  actorKey: string;
}): boolean {
  const assignedKey = normalizeTaskActorKey(input.taskOwnership.assignee_agent_key);
  if (assignedKey) {
    return assignedKey === input.actorKey;
  }

  return normalizeTaskActorLabel(input.taskOwnership.assignee) === input.actorLabel;
}

export function createTaskCoordinationEnforcement(deps: TaskCoordinationEnforcementDeps) {
  async function validateOwnerTokenTaskActorKey(input: {
    req: AuthenticatedRequest;
    actorKey: string | null;
  }): Promise<{ actorKey: string | null; error: string | null }> {
    const { req, actorKey } = input;

    if (req.authKind !== "owner_token") {
      return {
        actorKey,
        error: null,
      };
    }

    if (!actorKey) {
      return {
        actorKey: null,
        error: "actor_key is required for agent-owned task transitions",
      };
    }

    const actorIdentity = await deps.getAgentIdentityByCanonicalKey(actorKey);
    if (!actorIdentity || actorIdentity.owner_account_id !== req.sessionAccount?.account_id) {
      return {
        actorKey: null,
        error: "actor_key must belong to the authenticated agent owner",
      };
    }

    return {
      actorKey: actorIdentity.canonical_key,
      error: null,
    };
  }

  async function recordCoordinationDecision(
    input: RecordCoordinationDecisionInput
  ): Promise<void> {
    await deps.createCoordinationEvent({
      room_id: input.roomId,
      task_id: input.taskId,
      event_type: input.mutation,
      decision: input.decision,
      actor_label: input.actorLabel,
      actor_key: input.actorKey,
      actor_instance_id: input.actorInstanceId,
      reason: input.reason ?? null,
      lease_id: input.leaseId ?? null,
      lock_id: input.lockId ?? null,
    });
  }

  async function enforceTaskAdmissionCoordination(input: {
    req: AuthenticatedRequest;
    projectId: string;
    title: string;
    sourceMessageId?: string | null;
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
  }): Promise<TaskCoordinationGuardDecision> {
    if (input.req.authKind !== "owner_token") {
      return { kind: "allow" };
    }

    const actorLabel = normalizeTaskActorLabel(input.actorLabel);
    const actorKey = normalizeTaskActorKey(input.actorKey);

    const locks = await deps.getActiveTaskLocks(input.projectId);
    const lock = findApplicableLock({ locks, taskId: null });
    if (lock) {
      await recordCoordinationDecision({
        roomId: input.projectId,
        taskId: null,
        mutation: "task_admit",
        decision: "deny",
        actorLabel,
        actorKey,
        actorInstanceId: input.actorInstanceId,
        reason: `Task admission is blocked by ${lock.reason} lock ${lock.id}.`,
        lockId: lock.id,
      });
      return {
        kind: "deny",
        code: "coordination_active_lock",
        error: `Task admission is blocked by ${lock.reason} lock ${lock.id}.`,
      };
    }

    const [tasks, focusRooms, leases] = await Promise.all([
      deps.getTasks(input.projectId, undefined, { limit: 500 }),
      deps.getFocusRoomsForParent(input.projectId),
      deps.getActiveTaskLeases(input.projectId),
    ]);
    const admission = evaluateTaskAdmission({
      intent: {
        sourceMessageId: input.sourceMessageId,
        outputIntent: input.title,
      },
      tasks: tasks.tasks,
      focusRooms,
      leases,
    });
    if (admission.kind === "route_to_review") {
      await recordCoordinationDecision({
        roomId: input.projectId,
        taskId: null,
        mutation: "task_admit",
        decision: "deny",
        actorLabel,
        actorKey,
        actorInstanceId: input.actorInstanceId,
        reason: admission.reason,
        leaseId: admission.duplicate.lease?.id ?? null,
      });
      return {
        kind: "deny",
        code: "coordination_duplicate_work",
        error: admission.reason,
      };
    }

    return { kind: "allow" };
  }

  async function bindWorkflowArtifactPrUrlIfPresent(
    roomId: string,
    leaseId: string,
    updates: TaskCoordinationUpdatePatch
  ): Promise<void> {
    const prUrl = getTaskUpdatePrUrlBinding(updates);
    if (prUrl === undefined) {
      return;
    }

    await deps.updateTaskLeaseWorkflowRefs(roomId, leaseId, { pr_url: prUrl });
  }

  async function issueWorkLeaseForActor(input: {
    roomId: string;
    taskId: string;
    actorLabel: string;
    actorKey: string;
    actorInstanceId: string | null;
    actorSessionId: string | null;
    mutation: CoordinationMutationKind;
    outputIntent?: string | null;
  }) {
    const lease = await deps.createTaskLease({
      room_id: input.roomId,
      task_id: input.taskId,
      kind: "work",
      agent_key: input.actorKey,
      agent_instance_id: input.actorInstanceId,
      agent_session_id: input.actorSessionId,
      actor_label: input.actorLabel,
      branch_ref: buildLeasedBranchRef({
        taskId: input.taskId,
        agentKey: input.actorKey,
      }),
      created_by: input.actorLabel,
      output_intent: input.outputIntent ?? input.mutation,
    });
    await recordCoordinationDecision({
      roomId: input.roomId,
      taskId: input.taskId,
      mutation: input.mutation,
      decision: "allow",
      actorLabel: input.actorLabel,
      actorKey: input.actorKey,
      actorInstanceId: input.actorInstanceId,
      leaseId: lease.id,
      reason: `Issued ${lease.kind} lease ${lease.id} for ${input.mutation}.`,
    });
    return lease;
  }

  async function enforceTaskCoordinationMutation(
    input: TaskCoordinationMutationInput
  ): Promise<TaskCoordinationGuardDecision> {
    if (input.req.authKind !== "owner_token") {
      return { kind: "allow" };
    }

    const classified = input.forcedMutation
      ? { ...input.forcedMutation, claim: false }
      : classifyTaskCoordinationMutation(input.updates);
    if (!classified) {
      return { kind: "allow" };
    }

    const actorLabel = normalizeTaskActorLabel(input.actorLabel);
    const requestedActorKey = normalizeTaskActorKey(input.actorKey);
    if (!actorLabel || !requestedActorKey) {
      return {
        kind: "deny",
        code: "coordination_missing_actor",
        error: "actor_label and actor_key are required for coordinated task mutations",
      };
    }
    const verified = await validateOwnerTokenTaskActorKey({
      req: input.req,
      actorKey: requestedActorKey,
    });
    if (verified.error || !verified.actorKey) {
      return {
        kind: "deny",
        code: "coordination_invalid_actor",
        error: verified.error ?? "actor_key must belong to the authenticated agent owner",
      };
    }
    const actorKey = verified.actorKey;

    const [leases, locks] = await Promise.all([
      deps.getActiveTaskLeases(input.projectId, input.task.id),
      deps.getActiveTaskLocks(input.projectId, input.task.id),
    ]);
    const decision = evaluateCoordinationMutation({
      mutation: classified.mutation,
      taskId: input.task.id,
      requiredLeaseKind: classified.leaseKind,
      actor: {
        actorLabel,
        agentKey: actorKey,
        agentInstanceId: input.actorInstanceId,
        agentSessionId: input.actorSessionId,
      },
      leases,
      locks,
    });

    if (decision.kind === "allow") {
      await recordCoordinationDecision({
        roomId: input.projectId,
        taskId: input.task.id,
        mutation: classified.mutation,
        decision: "allow",
        actorLabel,
        actorKey,
        actorInstanceId: input.actorInstanceId,
        leaseId: decision.lease.id,
        reason: `Allowed ${classified.mutation} with lease ${decision.lease.id}.`,
      });
      if (classified.mutation === "workflow_artifact_attach") {
        await bindWorkflowArtifactPrUrlIfPresent(input.projectId, decision.lease.id, input.updates);
      }
      return { kind: "allow" };
    }

    if (decision.code === "missing_lease") {
      if (classified.claim && input.task.status === "accepted") {
        const lease = await issueWorkLeaseForActor({
          roomId: input.projectId,
          taskId: input.task.id,
          actorLabel,
          actorKey,
          actorInstanceId: input.actorInstanceId,
          actorSessionId: input.actorSessionId,
          mutation: classified.mutation,
          outputIntent: input.task.title,
        });
        if (classified.mutation === "workflow_artifact_attach") {
          await bindWorkflowArtifactPrUrlIfPresent(input.projectId, lease.id, input.updates);
        }
        return { kind: "allow" };
      }

      if (
        !classified.claim &&
        taskIsAssignedToActor({
          taskOwnership: input.taskOwnership,
          actorLabel,
          actorKey,
        })
      ) {
        const lease = await issueWorkLeaseForActor({
          roomId: input.projectId,
          taskId: input.task.id,
          actorLabel,
          actorKey,
          actorInstanceId: input.actorInstanceId,
          actorSessionId: input.actorSessionId,
          mutation: classified.mutation,
          outputIntent: input.task.title,
        });
        if (classified.mutation === "workflow_artifact_attach") {
          await bindWorkflowArtifactPrUrlIfPresent(input.projectId, lease.id, input.updates);
        }
        return { kind: "allow" };
      }
    }

    await recordCoordinationDecision({
      roomId: input.projectId,
      taskId: input.task.id,
      mutation: classified.mutation,
      decision: "deny",
      actorLabel,
      actorKey,
      actorInstanceId: input.actorInstanceId,
      reason: decision.reason,
      leaseId: decision.lease?.id ?? null,
      lockId: decision.lock?.id ?? null,
    });
    return {
      kind: "deny",
      code: `coordination_${decision.code}`,
      error: decision.reason,
    };
  }

  return {
    validateOwnerTokenTaskActorKey,
    recordCoordinationDecision,
    enforceTaskAdmissionCoordination,
    enforceTaskCoordinationMutation,
  };
}
