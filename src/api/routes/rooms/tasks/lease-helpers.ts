import type { TaskLease, TaskStatus } from "../../../db.js";
import { leaseMatchesActor } from "../../../coordination-policy.js";

export const LEASE_RECOVERY_ACTIVE_STATUSES = new Set<TaskStatus>([
  "assigned",
  "in_progress",
  "blocked",
  "in_review",
]);

export const REVIEW_LEASE_ACTIVE_STATUSES = new Set<TaskStatus>([
  "in_review",
  "blocked",
]);

export function getActiveWorkLease(leases: readonly TaskLease[]): TaskLease | null {
  return leases.find((lease) => lease.kind === "work") ?? null;
}

export function getActiveReviewLeaseForActor(input: {
  leases: readonly TaskLease[];
  actorKey: string | null;
  actorInstanceId?: string | null;
  actorSessionId?: string | null;
  actorLabel?: string | null;
}): TaskLease | null {
  if (!input.actorKey) return null;
  return input.leases.find((lease) =>
    lease.kind === "review" &&
    leaseMatchesActor(lease, {
      actorLabel: input.actorLabel ?? null,
      agentKey: input.actorKey,
      agentInstanceId: input.actorInstanceId ?? null,
      agentSessionId: input.actorSessionId ?? null,
    })
  ) ?? null;
}

export function getActiveReviewLeaseForAgentKey(
  leases: readonly TaskLease[],
  agentKey: string
): TaskLease | null {
  return leases.find((lease) =>
    lease.kind === "review" && lease.agent_key === agentKey
  ) ?? null;
}

export function targetMatchesWorkLease(input: {
  lease: TaskLease | null;
  targetActorKey: string;
}): boolean {
  const lease = input.lease;
  if (!lease || lease.agent_key !== input.targetActorKey) return false;
  return true;
}
