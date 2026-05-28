import type { TaskLeaseKind } from "../db.js";
import type {
  CoordinationActor,
  CoordinationLeaseLike,
} from "./types.js";

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

export function leaseMatchesActor(
  lease: CoordinationLeaseLike,
  actor: CoordinationActor
): boolean {
  if (!actor.agentKey || lease.agent_key !== actor.agentKey) {
    return false;
  }
  if (lease.agent_session_id) {
    return lease.agent_session_id === (actor.agentSessionId ?? null);
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
