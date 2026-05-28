import { findActorLease, isActiveCoordinationLease } from "./leases.js";
import type {
  CoordinationActor,
  CoordinationLeaseLike,
  ReviewLeaseRoutingResult,
} from "./types.js";

export function evaluateReviewLeaseRouting(input: {
  taskId: string;
  actor: CoordinationActor;
  leases: readonly CoordinationLeaseLike[];
  reviewerAgentKeys?: readonly string[];
  now?: Date;
}): ReviewLeaseRoutingResult {
  if (!input.actor.agentKey) {
    return {
      kind: "deny",
      code: "missing_actor",
      reason: "Review lease routing requires an authenticated agent key.",
    };
  }

  if (
    input.reviewerAgentKeys &&
    !input.reviewerAgentKeys.includes(input.actor.agentKey)
  ) {
    return {
      kind: "deny",
      code: "unassigned_reviewer",
      reason: `Agent ${input.actor.agentKey} is not assigned to review ${input.taskId}.`,
    };
  }

  const now = input.now ?? new Date();
  const activeTaskLeases = input.leases.filter((lease) =>
    lease.task_id === input.taskId && isActiveCoordinationLease(lease, now)
  );
  const activeWorkLease =
    activeTaskLeases.find((lease) => lease.kind === "work") ?? null;
  if (activeWorkLease?.agent_key === input.actor.agentKey) {
    return {
      kind: "deny",
      code: "work_lease_holder",
      reason:
        `Agent ${input.actor.agentKey} holds work lease ${activeWorkLease.id} ` +
        `and cannot review ${input.taskId}.`,
      lease: activeWorkLease,
    };
  }

  const existingReviewLease = findActorLease({
    leases: activeTaskLeases,
    taskId: input.taskId,
    kind: "review",
    actor: input.actor,
    now,
  });

  return {
    kind: "allow",
    activeWorkLease,
    existingReviewLease,
  };
}

export function findBoardReviewLeaseForMerge(input: {
  taskId: string;
  leases: readonly CoordinationLeaseLike[];
  now?: Date;
}): CoordinationLeaseLike | null {
  const now = input.now ?? new Date();
  const activeTaskLeases = input.leases.filter((lease) =>
    lease.task_id === input.taskId && isActiveCoordinationLease(lease, now)
  );
  const activeWorkLease =
    activeTaskLeases.find((lease) => lease.kind === "work") ?? null;

  return activeTaskLeases.find((lease) =>
    lease.kind === "review" &&
    (!activeWorkLease || lease.agent_key !== activeWorkLease.agent_key)
  ) ?? null;
}
