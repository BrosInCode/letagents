import type {
  AgentIdentity,
  Task,
  BoardIntentActionType,
  BoardIntentConsumptionInput,
  LeaseFence,
  TaskLeaseKind,
  TaskOwnershipState,
  TaskWorkLeaseCreationInput,
} from "../db.js";
import {
  boardIntentPayloadForTaskCreate,
  boardIntentPayloadForTaskMutation,
  type BoardIntentPayload,
} from "../board-intent-payloads.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import {
  evaluateTaskAdmission,
  evaluateCoordinationMutation,
  findApplicableLock,
  type CoordinationFocusRoomLike,
  type CoordinationLeaseLike,
  type CoordinationLockLike,
  type CoordinationMutationKind,
  type CoordinationTaskLike,
} from "../coordination-policy.js";
import { buildLeasedBranchRef } from "../github/lease-enforcement.js";
import {
  classifyTaskCoordinationMutation,
  getTaskUpdatePrUrlBinding,
  type TaskCoordinationUpdatePatch,
} from "./coordination-inputs.js";
import {
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
} from "./ownership.js";

export type TaskCoordinationGuardDecision =
  | {
      kind: "allow";
      boardIntentApproval?: BoardIntentConsumptionInput | null;
      workLeaseCreation?: TaskWorkLeaseCreationInput | null;
      // Rebind fence (plan §4.5) for the write path. Populated when the caller's
      // authority to mutate derives from holding a session-bound WORK lease, so
      // the guarded write re-validates the lease identity+epoch under the shared
      // advisory lock and a rebound-away predecessor's stale write aborts. Null
      // for owner/admin, lease-creation, and sessionless (pre-supervisor) leases
      // — those the rebind path never touches.
      leaseFence?: LeaseFence | null;
    }
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
  updateTaskLeaseWorkflowRefs(
    roomId: string,
    leaseId: string,
    updates: { branch_ref?: string | null; pr_url?: string | null }
  ): Promise<unknown>;
  shouldRequireBoardIntent(input: { room_id: string }): Promise<boolean>;
  verifyBoardIntentApproval(input: {
    room_id: string;
    action_type: BoardIntentActionType;
    payload: BoardIntentPayload;
    intent_id?: string | null;
    approval_token?: string | null;
  }): Promise<
    | { kind: "allow"; intent?: { id: string } }
    | { kind: "deny"; code: string; error: string }
  >;
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
  boardIntentId?: string | null;
  boardApprovalToken?: string | null;
}

type TaskCoordinationDenyDecision = Extract<TaskCoordinationGuardDecision, { kind: "deny" }>;
type TaskCoordinationAllowDecision = Extract<TaskCoordinationGuardDecision, { kind: "allow" }>;

export interface TaskAdmissionPreconditionInput {
  projectId: string;
  title: string;
  sourceMessageId?: string | null;
  actorLabel: string | null;
  actorKey: string | null;
  actorInstanceId: string | null;
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
  function allowDecision(input: {
    boardIntentApproval?: BoardIntentConsumptionInput | null;
    workLeaseCreation?: TaskWorkLeaseCreationInput | null;
    leaseFence?: LeaseFence | null;
  } = {}): TaskCoordinationAllowDecision {
    return {
      kind: "allow",
      ...(input.boardIntentApproval ? { boardIntentApproval: input.boardIntentApproval } : {}),
      ...(input.workLeaseCreation ? { workLeaseCreation: input.workLeaseCreation } : {}),
      ...(input.leaseFence ? { leaseFence: input.leaseFence } : {}),
    };
  }

  // Build a rebind fence from a held lease, or null when fencing does not apply.
  // Only SESSION-BOUND WORK leases are fenced: the rebind path (§4.5) never
  // moves review leases or sessionless (pre-supervisor, actor_key-authorized)
  // leases, so there is no stale-predecessor hazard to guard for those. This is
  // rebind SAFETY, not authorization — it never turns an allow into a deny.
  function leaseFenceFor(lease: CoordinationLeaseLike | null | undefined): LeaseFence | null {
    if (!lease || lease.kind !== "work" || lease.status !== "active" || !lease.agent_session_id) {
      return null;
    }
    return {
      lease_id: lease.id,
      room_id: lease.room_id,
      task_id: lease.task_id,
      kind: "work",
      expected_epoch: lease.epoch,
      agent_session_id: lease.agent_session_id,
    };
  }

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

  async function recordIntentDenial(input: {
    roomId: string;
    taskId: string | null;
    mutation: CoordinationMutationKind;
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
    decision: TaskCoordinationDenyDecision;
  }): Promise<TaskCoordinationDenyDecision> {
    await recordCoordinationDecision({
      roomId: input.roomId,
      taskId: input.taskId,
      mutation: input.mutation,
      decision: "deny",
      actorLabel: input.actorLabel,
      actorKey: input.actorKey,
      actorInstanceId: input.actorInstanceId,
      reason: input.decision.error,
    });
    return input.decision;
  }

  async function enforceTaskAdmissionCoordination(input: {
    req: AuthenticatedRequest;
    projectId: string;
    title: string;
    description?: string | null;
    sourceMessageId?: string | null;
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
    actorSessionId?: string | null;
    boardIntentId?: string | null;
    boardApprovalToken?: string | null;
  }): Promise<TaskCoordinationGuardDecision> {
    if (input.req.authKind !== "owner_token") {
      return { kind: "allow" };
    }

    const precondition = await enforceTaskAdmissionPreconditions(input);
    if (precondition.kind === "deny") {
      return precondition;
    }

    const actorLabel = normalizeTaskActorLabel(input.actorLabel);
    const actorKey = normalizeTaskActorKey(input.actorKey);

    const intentDecision = await enforceBoardIntentForAgentAction({
      roomId: input.projectId,
      actionType: "task_create",
      payload: boardIntentPayloadForTaskCreate({
        title: input.title,
        description: input.description ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
      }),
      actorLabel,
      actorKey,
      actorInstanceId: input.actorInstanceId,
      actorSessionId: input.actorSessionId ?? null,
      intentId: input.boardIntentId,
      approvalToken: input.boardApprovalToken,
    });
    if (intentDecision.kind === "deny") {
      return recordIntentDenial({
        roomId: input.projectId,
        taskId: null,
        mutation: "task_admit",
        actorLabel,
        actorKey,
        actorInstanceId: input.actorInstanceId,
        decision: intentDecision,
      });
    }

    return intentDecision;
  }

  async function enforceTaskAdmissionPreconditions(
    input: TaskAdmissionPreconditionInput
  ): Promise<TaskCoordinationGuardDecision> {
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

    return allowDecision();
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

  async function prepareWorkLeaseForActor(input: {
    roomId: string;
    taskId: string;
    actorLabel: string;
    actorKey: string;
    actorInstanceId: string | null;
    actorSessionId: string | null;
    mutation: CoordinationMutationKind;
    outputIntent?: string | null;
    prUrl?: string | null;
  }): Promise<TaskWorkLeaseCreationInput> {
    const leaseInput: TaskWorkLeaseCreationInput = {
      agent_key: input.actorKey,
      agent_instance_id: input.actorInstanceId,
      actor_label: input.actorLabel,
      branch_ref: buildLeasedBranchRef({
        taskId: input.taskId,
        agentKey: input.actorKey,
      }),
      created_by: input.actorLabel,
      output_intent: input.outputIntent ?? input.mutation,
    };
    if (input.prUrl !== undefined) {
      leaseInput.pr_url = input.prUrl;
    }
    if (input.actorSessionId) {
      leaseInput.agent_session_id = input.actorSessionId;
    }

    await recordCoordinationDecision({
      roomId: input.roomId,
      taskId: input.taskId,
      mutation: input.mutation,
      decision: "allow",
      actorLabel: input.actorLabel,
      actorKey: input.actorKey,
      actorInstanceId: input.actorInstanceId,
      reason: `Allowed ${input.mutation}; work lease will be issued with the task update.`,
    });
    return leaseInput;
  }

  function boardIntentActionForMutation(
    updates: TaskCoordinationUpdatePatch
  ): BoardIntentActionType | null {
    if (updates.status === "assigned") return "task_claim";
    if (updates.status === "merged" || updates.status === "done" || updates.status === "cancelled") {
      return "task_close";
    }
    if (updates.status === "accepted") return "task_override";
    return null;
  }

  async function enforceBoardIntentForAgentAction(input: {
    roomId: string;
    actionType: BoardIntentActionType;
    payload: BoardIntentPayload;
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
    actorSessionId: string | null;
    intentId?: string | null;
    approvalToken?: string | null;
  }): Promise<TaskCoordinationGuardDecision> {
    if (!input.actorKey && !input.actorSessionId) {
      return { kind: "allow" };
    }
    const requiresIntent = await deps.shouldRequireBoardIntent({ room_id: input.roomId });
    if (!requiresIntent) {
      return { kind: "allow" };
    }
    const approval = await deps.verifyBoardIntentApproval({
      room_id: input.roomId,
      action_type: input.actionType,
      payload: input.payload,
      intent_id: input.intentId,
      approval_token: input.approvalToken,
    });
    if (approval.kind === "deny") {
      return {
        kind: "deny",
        code: approval.code,
        error: approval.error,
      };
    }
    if (!approval.intent?.id) {
      return { kind: "allow" };
    }
    return {
      kind: "allow",
      boardIntentApproval: {
        room_id: input.roomId,
        action_type: input.actionType,
        payload: input.payload,
        intent_id: approval.intent.id,
        approval_token: input.approvalToken,
      },
    };
  }

  async function enforceTaskCoordinationMutation(
    input: TaskCoordinationMutationInput
  ): Promise<TaskCoordinationGuardDecision> {
    // The work-lease fence applies ONLY to authenticated worker (agent_session)
    // writes. Anonymous / human-session / other non-owner_token requests are
    // NOT lease principals and must not be reclassified as work-lease traffic —
    // check agent_session explicitly, not "!== owner_token".
    if (input.req.authKind === "agent_session") {
      // agent_session (worker-bearer) writes. Only WORK-lease-scoped mutations
      // are holder-scoped: claim creates a fresh lease, review mutations ride a
      // non-rebindable review lease, and unclassified updates aren't lease-bound.
      const workerClassified = input.forcedMutation
        ? { ...input.forcedMutation, claim: false }
        : classifyTaskCoordinationMutation(input.updates);
      if (!workerClassified || workerClassified.leaseKind !== "work" || workerClassified.claim) {
        return { kind: "allow" };
      }
      // A work-lease-scoped worker mutation MUST be performed by the CURRENT
      // holder of the task's active work lease. We capture the lease's identity
      // and epoch and bind the fence to the CALLER's session. Rebind safety
      // (§4.5), not orthogonal authz: the earlier "fence only when the caller
      // still holds it" downgraded a rebound-away predecessor to an unfenced
      // allow (the exact bypass) — so missing/moved/stale must 409, never
      // reclassify to ordinary no-lease traffic.
      // Resolve the task's active work lease FIRST. If there is none, or its
      // holder session differs from the authenticated worker session (moved by
      // rebind, sessionless, or another worker's), deny outright — never build a
      // fence from a caller-filtered lookup that returned nothing.
      const sessionId = input.actorSessionId;
      const workerLeases = await deps.getActiveTaskLeases(input.projectId, input.task.id);
      const activeWorkLease = workerLeases.find(
        (lease) => lease.kind === "work" && lease.status === "active"
      );
      if (!activeWorkLease || !sessionId || activeWorkLease.agent_session_id !== sessionId) {
        return {
          kind: "deny",
          code: "coordination_work_lease_required",
          error: "This task mutation requires holding the task's active work lease.",
        };
      }
      // Matches now — capture the lease's OWN full tuple; the in-tx shared lock
      // revalidates it, so a rebind that commits between here and the write
      // (lookup-before-rebind) still fails the fence and 409s.
      return {
        kind: "allow",
        leaseFence: {
          lease_id: activeWorkLease.id,
          room_id: input.projectId,
          task_id: input.task.id,
          kind: "work",
          expected_epoch: activeWorkLease.epoch,
          agent_session_id: activeWorkLease.agent_session_id,
        },
      };
    }

    // Non-owner, non-worker requests (anonymous / human session / other) are not
    // lease principals — preserve their prior behavior, no coordination fence.
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

    const intentActionType = boardIntentActionForMutation(input.updates);
    const intentDecision = intentActionType
      ? await enforceBoardIntentForAgentAction({
          roomId: input.projectId,
          actionType: intentActionType,
          payload: boardIntentPayloadForTaskMutation({
            taskId: input.task.id,
            status: input.updates.status ?? null,
            assignee: "assignee" in input.updates ? input.updates.assignee as string | null | undefined : undefined,
            assigneeAgentKey: "assignee_agent_key" in input.updates ? input.updates.assignee_agent_key as string | null | undefined : undefined,
            prUrl: input.updates.pr_url,
          }),
          actorLabel,
          actorKey,
          actorInstanceId: input.actorInstanceId,
          actorSessionId: input.actorSessionId,
          intentId: input.boardIntentId,
          approvalToken: input.boardApprovalToken,
        })
      : { kind: "allow" as const };
    const boardIntentApproval = intentDecision.kind === "allow"
      ? intentDecision.boardIntentApproval
      : undefined;

    if (decision.kind === "allow") {
      if (intentDecision.kind === "deny") {
        return recordIntentDenial({
          roomId: input.projectId,
          taskId: input.task.id,
          mutation: classified.mutation,
          actorLabel,
          actorKey,
          actorInstanceId: input.actorInstanceId,
          decision: intentDecision,
        });
      }
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
      // Fence the write on the authorizing lease when it is session-bound
      // (rebind safety, §4.5). Sessionless owner-token leases yield null and
      // stay on the unfenced path the rebind never touches.
      const fence = leaseFenceFor(decision.lease);
      // When fenced, the lease pr_url ref bind is folded into updateTask's fenced
      // tx (msg_565) so it commits atomically with the task + artifact writes;
      // only the unfenced (sessionless) path binds here, pre-tx, as before.
      if (classified.mutation === "workflow_artifact_attach" && !fence) {
        await bindWorkflowArtifactPrUrlIfPresent(input.projectId, decision.lease.id, input.updates);
      }
      return allowDecision({ boardIntentApproval, leaseFence: fence });
    }

    if (decision.code === "missing_lease") {
      if (classified.claim && input.task.status === "accepted") {
        if (intentDecision.kind === "deny") {
          return recordIntentDenial({
            roomId: input.projectId,
            taskId: input.task.id,
            mutation: classified.mutation,
            actorLabel,
            actorKey,
            actorInstanceId: input.actorInstanceId,
            decision: intentDecision,
          });
        }
        const workLeaseCreation = await prepareWorkLeaseForActor({
          roomId: input.projectId,
          taskId: input.task.id,
          actorLabel,
          actorKey,
          actorInstanceId: input.actorInstanceId,
          actorSessionId: input.actorSessionId,
          mutation: classified.mutation,
          outputIntent: input.task.title,
          prUrl: getTaskUpdatePrUrlBinding(input.updates),
        });
        return allowDecision({ boardIntentApproval, workLeaseCreation });
      }

      if (
        !classified.claim &&
        taskIsAssignedToActor({
          taskOwnership: input.taskOwnership,
          actorLabel,
          actorKey,
        })
      ) {
        if (intentDecision.kind === "deny") {
          return recordIntentDenial({
            roomId: input.projectId,
            taskId: input.task.id,
            mutation: classified.mutation,
            actorLabel,
            actorKey,
            actorInstanceId: input.actorInstanceId,
            decision: intentDecision,
          });
        }
        const workLeaseCreation = await prepareWorkLeaseForActor({
          roomId: input.projectId,
          taskId: input.task.id,
          actorLabel,
          actorKey,
          actorInstanceId: input.actorInstanceId,
          actorSessionId: input.actorSessionId,
          mutation: classified.mutation,
          outputIntent: input.task.title,
          prUrl: getTaskUpdatePrUrlBinding(input.updates),
        });
        return allowDecision({ boardIntentApproval, workLeaseCreation });
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
    enforceTaskAdmissionPreconditions,
    enforceTaskCoordinationMutation,
  };
}
