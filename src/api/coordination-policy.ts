import type {
  TaskLeaseKind,
  TaskLeaseStatus,
  TaskLockReason,
  TaskLockScope,
} from "./db.js";

export interface CoordinationActor {
  actorLabel: string | null;
  agentKey: string | null;
  agentInstanceId?: string | null;
}

export interface CoordinationLeaseLike {
  id: string;
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  status: TaskLeaseStatus;
  agent_key: string;
  agent_instance_id: string | null;
  actor_label: string;
  expires_at: string | null;
}

export interface CoordinationLockLike {
  id: string;
  room_id: string;
  task_id: string | null;
  scope: TaskLockScope;
  reason: TaskLockReason;
  message: string | null;
  cleared_at: string | null;
}

export type CoordinationMutationKind =
  | "task_admit"
  | "task_claim"
  | "task_update"
  | "task_complete"
  | "focus_room_open"
  | "focus_room_conclude"
  | "workflow_artifact_attach"
  | "webhook_projection";

export type CoordinationDecisionResult =
  | {
      kind: "allow";
      lease: CoordinationLeaseLike;
    }
  | {
      kind: "deny";
      code:
        | "active_lock"
        | "missing_actor"
        | "missing_lease"
        | "wrong_lease_kind"
        | "wrong_actor";
      reason: string;
      lock?: CoordinationLockLike;
      lease?: CoordinationLeaseLike;
    };

export function isActiveCoordinationLease(
  lease: CoordinationLeaseLike,
  now = new Date()
): boolean {
  if (lease.status !== "active") {
    return false;
  }
  if (!lease.expires_at) {
    return true;
  }
  return Date.parse(lease.expires_at) > now.getTime();
}

export function isActiveCoordinationLock(lock: CoordinationLockLike): boolean {
  return !lock.cleared_at;
}

export function lockAppliesToTask(
  lock: CoordinationLockLike,
  taskId: string | null | undefined
): boolean {
  if (!isActiveCoordinationLock(lock)) {
    return false;
  }
  if (lock.scope === "room") {
    return true;
  }
  return Boolean(taskId && lock.task_id === taskId);
}

export function findApplicableLock(input: {
  locks: readonly CoordinationLockLike[];
  taskId?: string | null;
}): CoordinationLockLike | null {
  return input.locks.find((lock) => lockAppliesToTask(lock, input.taskId)) ?? null;
}

export function leaseMatchesActor(
  lease: CoordinationLeaseLike,
  actor: CoordinationActor
): boolean {
  if (!actor.agentKey || lease.agent_key !== actor.agentKey) {
    return false;
  }
  if (lease.agent_instance_id) {
    return lease.agent_instance_id === (actor.agentInstanceId ?? null);
  }
  return true;
}

export function findActorLease(input: {
  leases: readonly CoordinationLeaseLike[];
  taskId: string;
  kind: TaskLeaseKind;
  actor: CoordinationActor;
  now?: Date;
}): CoordinationLeaseLike | null {
  const now = input.now ?? new Date();
  return input.leases.find((lease) =>
    lease.task_id === input.taskId &&
    lease.kind === input.kind &&
    isActiveCoordinationLease(lease, now) &&
    leaseMatchesActor(lease, input.actor)
  ) ?? null;
}

export function evaluateCoordinationMutation(input: {
  mutation: CoordinationMutationKind;
  taskId: string;
  requiredLeaseKind: TaskLeaseKind;
  actor: CoordinationActor;
  leases: readonly CoordinationLeaseLike[];
  locks: readonly CoordinationLockLike[];
  now?: Date;
}): CoordinationDecisionResult {
  const lock = findApplicableLock({ locks: input.locks, taskId: input.taskId });
  if (lock) {
    return {
      kind: "deny",
      code: "active_lock",
      reason: `Mutation ${input.mutation} is blocked by ${lock.reason} lock ${lock.id}.`,
      lock,
    };
  }

  if (!input.actor.agentKey) {
    return {
      kind: "deny",
      code: "missing_actor",
      reason: `Mutation ${input.mutation} requires an authenticated agent key.`,
    };
  }

  const now = input.now ?? new Date();
  const activeTaskLeases = input.leases.filter((lease) =>
    lease.task_id === input.taskId && isActiveCoordinationLease(lease, now)
  );
  const lease = findActorLease({
    leases: activeTaskLeases,
    taskId: input.taskId,
    kind: input.requiredLeaseKind,
    actor: input.actor,
    now,
  });
  if (lease) {
    return { kind: "allow", lease };
  }

  const sameActorWrongKind = activeTaskLeases.find((lease) =>
    leaseMatchesActor(lease, input.actor)
  );
  if (sameActorWrongKind && sameActorWrongKind.kind !== input.requiredLeaseKind) {
    return {
      kind: "deny",
      code: "wrong_lease_kind",
      reason:
        `Mutation ${input.mutation} requires a ${input.requiredLeaseKind} lease, ` +
        `but actor holds ${sameActorWrongKind.kind} lease ${sameActorWrongKind.id}.`,
      lease: sameActorWrongKind,
    };
  }

  const matchingKindLease = activeTaskLeases.find(
    (lease) => lease.kind === input.requiredLeaseKind
  );
  if (matchingKindLease && !leaseMatchesActor(matchingKindLease, input.actor)) {
    return {
      kind: "deny",
      code: "wrong_actor",
      reason:
        `Mutation ${input.mutation} requires lease ${matchingKindLease.id}, ` +
        "which belongs to a different agent.",
      lease: matchingKindLease,
    };
  }

  return {
    kind: "deny",
    code: "missing_lease",
    reason: `Mutation ${input.mutation} requires an active ${input.requiredLeaseKind} lease.`,
  };
}
