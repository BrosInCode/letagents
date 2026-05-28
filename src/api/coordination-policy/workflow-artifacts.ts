import { findApplicableLock } from "./locks.js";
import { isActiveCoordinationLease } from "./leases.js";
import type {
  CoordinationDecisionResult,
  CoordinationLeaseLike,
  CoordinationLockLike,
  CoordinationMutationKind,
} from "./types.js";

function normalizeWorkflowRef(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function branchRefsMatch(left: string, right: string): boolean {
  return (
    left === right ||
    left === `refs/heads/${right}` ||
    `refs/heads/${left}` === right
  );
}

export function leaseMatchesWorkflowArtifact(input: {
  lease: CoordinationLeaseLike;
  prUrl?: string | null;
  branchRef?: string | null;
}): boolean {
  const prUrl = normalizeWorkflowRef(input.prUrl);
  const branchRef = normalizeWorkflowRef(input.branchRef);
  const leasePrUrl = normalizeWorkflowRef(input.lease.pr_url);
  const leaseBranchRef = normalizeWorkflowRef(input.lease.branch_ref);

  if (prUrl && leasePrUrl && prUrl === leasePrUrl) {
    return true;
  }

  if (branchRef && leaseBranchRef && branchRefsMatch(leaseBranchRef, branchRef)) {
    return true;
  }

  return false;
}

export function findWorkflowArtifactLease(input: {
  leases: readonly CoordinationLeaseLike[];
  taskId: string;
  prUrl?: string | null;
  branchRef?: string | null;
  now?: Date;
}): CoordinationLeaseLike | null {
  const now = input.now ?? new Date();
  return input.leases.find((lease) =>
    lease.task_id === input.taskId &&
    lease.kind === "work" &&
    isActiveCoordinationLease(lease, now) &&
    leaseMatchesWorkflowArtifact({
      lease,
      prUrl: input.prUrl,
      branchRef: input.branchRef,
    })
  ) ?? null;
}

export function evaluateWorkflowArtifactMutation(input: {
  mutation: Extract<CoordinationMutationKind, "workflow_artifact_attach" | "webhook_projection">;
  taskId: string;
  leases: readonly CoordinationLeaseLike[];
  locks: readonly CoordinationLockLike[];
  prUrl?: string | null;
  branchRef?: string | null;
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

  const now = input.now ?? new Date();
  const lease = findWorkflowArtifactLease({
    leases: input.leases,
    taskId: input.taskId,
    prUrl: input.prUrl,
    branchRef: input.branchRef,
    now,
  });
  if (lease) {
    return { kind: "allow", lease };
  }

  const activeWorkLease = input.leases.find((candidate) =>
    candidate.task_id === input.taskId &&
    candidate.kind === "work" &&
    isActiveCoordinationLease(candidate, now)
  );
  if (activeWorkLease) {
    return {
      kind: "deny",
      code: "wrong_workflow_artifact",
      reason:
        `Mutation ${input.mutation} requires a workflow artifact matching ` +
        `active work lease ${activeWorkLease.id}.`,
      lease: activeWorkLease,
    };
  }

  return {
    kind: "deny",
    code: "missing_lease",
    reason: `Mutation ${input.mutation} requires an active work lease matching the workflow artifact.`,
  };
}
