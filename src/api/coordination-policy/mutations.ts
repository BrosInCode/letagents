import type { TaskLeaseKind } from "../db.js";
import { findApplicableLock } from "./locks.js";
import {
  findActorLease,
  isActiveCoordinationLease,
  leaseMatchesActor,
} from "./leases.js";
import type {
  CoordinationActor,
  CoordinationDecisionResult,
  CoordinationLeaseLike,
  CoordinationLockLike,
  CoordinationMutationKind,
} from "./types.js";

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
