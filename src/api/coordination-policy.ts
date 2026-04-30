import type {
  TaskLeaseKind,
  TaskLeaseStatus,
  TaskLockReason,
  TaskLockScope,
} from "./db.js";
import {
  normalizeTaskWorkflowArtifacts,
  type TaskWorkflowArtifact,
} from "./repo-workflow.js";

export interface CoordinationActor {
  actorLabel: string | null;
  agentKey: string | null;
  agentInstanceId?: string | null;
  agentSessionId?: string | null;
}

export interface CoordinationLeaseLike {
  id: string;
  room_id: string;
  task_id: string;
  kind: TaskLeaseKind;
  status: TaskLeaseStatus;
  agent_key: string;
  agent_instance_id: string | null;
  agent_session_id?: string | null;
  actor_label: string;
  branch_ref?: string | null;
  pr_url?: string | null;
  output_intent?: string | null;
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

export interface CoordinationTaskLike {
  id: string;
  room_id: string;
  status?: string | null;
  source_message_id?: string | null;
  pr_url?: string | null;
  workflow_artifacts?: readonly TaskWorkflowArtifact[] | null;
}

export interface CoordinationFocusRoomLike {
  room_id: string;
  focus_key: string | null;
  source_task_id: string | null;
  focus_status: string | null;
}

export interface CoordinationWorkIntent {
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
  branchRef?: string | null;
  prUrl?: string | null;
  outputIntent?: string | null;
  workflowArtifacts?: readonly TaskWorkflowArtifact[] | null;
}

export type CoordinationDuplicateReason =
  | "source_message"
  | "source_task"
  | "focus_room"
  | "pr_url"
  | "workflow_artifact"
  | "lease_branch_ref"
  | "lease_pr_url"
  | "lease_output_intent";

export interface CoordinationDuplicateMatch {
  reason: CoordinationDuplicateReason;
  taskId: string;
  value: string;
  task?: CoordinationTaskLike;
  lease?: CoordinationLeaseLike;
  focusRoom?: CoordinationFocusRoomLike;
  artifact?: TaskWorkflowArtifact;
}

export type CoordinationAdmissionResult =
  | {
      kind: "allow";
      reason: "no_duplicate";
    }
  | {
      kind: "route_to_review";
      reason: string;
      duplicate: CoordinationDuplicateMatch;
    };

export type ReviewLeaseRoutingResult =
  | {
      kind: "allow";
      activeWorkLease: CoordinationLeaseLike | null;
      existingReviewLease: CoordinationLeaseLike | null;
    }
  | {
      kind: "deny";
      code: "missing_actor" | "unassigned_reviewer" | "work_lease_holder";
      reason: string;
      lease?: CoordinationLeaseLike;
    };

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
        | "wrong_actor"
        | "wrong_workflow_artifact";
      reason: string;
      lock?: CoordinationLockLike;
      lease?: CoordinationLeaseLike;
    };

function normalizeIdentity(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeUrlIdentity(value: string | null | undefined): string | null {
  const normalized = normalizeIdentity(value);
  return normalized ? normalized.replace(/\/+$/, "") : null;
}

function isOpenCoordinationTask(task: CoordinationTaskLike): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

function taskWorkflowArtifacts(
  task: CoordinationTaskLike
): TaskWorkflowArtifact[] {
  return normalizeTaskWorkflowArtifacts({
    artifacts: task.workflow_artifacts ? [...task.workflow_artifacts] : [],
    prUrl: task.pr_url ?? null,
  });
}

function intentWorkflowArtifacts(intent: CoordinationWorkIntent): TaskWorkflowArtifact[] {
  return normalizeTaskWorkflowArtifacts({
    artifacts: intent.workflowArtifacts ? [...intent.workflowArtifacts] : [],
    prUrl: intent.prUrl ?? null,
  });
}

function leaseWorkflowArtifacts(lease: CoordinationLeaseLike): TaskWorkflowArtifact[] {
  return normalizeTaskWorkflowArtifacts({
    artifacts: [],
    prUrl: lease.pr_url ?? null,
  });
}

function artifactIdentityValues(artifact: TaskWorkflowArtifact): string[] {
  const values: string[] = [];
  const url = normalizeUrlIdentity(artifact.url);
  if (url) {
    values.push(`url:${url}`);
  }
  if (artifact.id) {
    values.push(`${artifact.provider}:${artifact.kind}:id:${artifact.id}`);
  }
  if (artifact.number !== undefined && artifact.number !== null) {
    values.push(`${artifact.provider}:${artifact.kind}:number:${artifact.number}`);
  }
  if (artifact.ref) {
    values.push(`${artifact.provider}:${artifact.kind}:ref:${artifact.ref}`);
  }
  return values;
}

function artifactsShareIdentity(
  left: TaskWorkflowArtifact,
  right: TaskWorkflowArtifact
): string | null {
  const rightValues = new Set(artifactIdentityValues(right));
  return artifactIdentityValues(left).find((value) => rightValues.has(value)) ?? null;
}

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

export function findDuplicateCoordinationIntent(input: {
  intent: CoordinationWorkIntent;
  tasks: readonly CoordinationTaskLike[];
  focusRooms?: readonly CoordinationFocusRoomLike[];
  leases?: readonly CoordinationLeaseLike[];
  now?: Date;
}): CoordinationDuplicateMatch | null {
  const openTasks = input.tasks.filter(isOpenCoordinationTask);
  const taskById = new Map(openTasks.map((task) => [task.id, task]));
  const sourceMessageId = normalizeIdentity(input.intent.sourceMessageId);
  if (sourceMessageId) {
    const task = openTasks.find(
      (candidate) => normalizeIdentity(candidate.source_message_id) === sourceMessageId
    );
    if (task) {
      return {
        reason: "source_message",
        taskId: task.id,
        value: sourceMessageId,
        task,
      };
    }
  }

  const sourceTaskId = normalizeIdentity(input.intent.sourceTaskId);
  if (sourceTaskId && taskById.has(sourceTaskId)) {
    return {
      reason: "source_task",
      taskId: sourceTaskId,
      value: sourceTaskId,
      task: taskById.get(sourceTaskId),
    };
  }

  if (sourceTaskId) {
    const focusRoom = input.focusRooms?.find(
      (room) =>
        room.focus_status !== "concluded" &&
        normalizeIdentity(room.source_task_id) === sourceTaskId
    );
    if (focusRoom) {
      return {
        reason: "focus_room",
        taskId: sourceTaskId,
        value: focusRoom.room_id,
        task: taskById.get(sourceTaskId),
        focusRoom,
      };
    }
  }

  const prUrl = normalizeUrlIdentity(input.intent.prUrl);
  if (prUrl) {
    for (const task of openTasks) {
      if (normalizeUrlIdentity(task.pr_url) === prUrl) {
        return {
          reason: "pr_url",
          taskId: task.id,
          value: prUrl,
          task,
        };
      }
    }
  }

  const intentArtifacts = intentWorkflowArtifacts(input.intent);
  if (intentArtifacts.length > 0) {
    for (const task of openTasks) {
      for (const taskArtifact of taskWorkflowArtifacts(task)) {
        for (const intentArtifact of intentArtifacts) {
          const value = artifactsShareIdentity(intentArtifact, taskArtifact);
          if (value) {
            return {
              reason: "workflow_artifact",
              taskId: task.id,
              value,
              task,
              artifact: taskArtifact,
            };
          }
        }
      }
    }
  }

  const now = input.now ?? new Date();
  const activeLeases = (input.leases ?? []).filter((lease) =>
    isActiveCoordinationLease(lease, now)
  );
  const branchRef = normalizeIdentity(input.intent.branchRef);
  if (branchRef) {
    const lease = activeLeases.find(
      (candidate) => normalizeIdentity(candidate.branch_ref) === branchRef
    );
    if (lease) {
      return {
        reason: "lease_branch_ref",
        taskId: lease.task_id,
        value: branchRef,
        lease,
        task: taskById.get(lease.task_id),
      };
    }
  }

  if (prUrl) {
    const lease = activeLeases.find(
      (candidate) => normalizeUrlIdentity(candidate.pr_url) === prUrl
    );
    if (lease) {
      return {
        reason: "lease_pr_url",
        taskId: lease.task_id,
        value: prUrl,
        lease,
        task: taskById.get(lease.task_id),
      };
    }
  }

  if (intentArtifacts.length > 0) {
    for (const lease of activeLeases) {
      for (const leaseArtifact of leaseWorkflowArtifacts(lease)) {
        for (const intentArtifact of intentArtifacts) {
          const value = artifactsShareIdentity(intentArtifact, leaseArtifact);
          if (value) {
            return {
              reason: "lease_pr_url",
              taskId: lease.task_id,
              value,
              lease,
              task: taskById.get(lease.task_id),
              artifact: leaseArtifact,
            };
          }
        }
      }
    }
  }

  const outputIntent = normalizeIdentity(input.intent.outputIntent);
  if (outputIntent) {
    const lease = activeLeases.find(
      (candidate) => normalizeIdentity(candidate.output_intent) === outputIntent
    );
    if (lease) {
      return {
        reason: "lease_output_intent",
        taskId: lease.task_id,
        value: outputIntent,
        lease,
        task: taskById.get(lease.task_id),
      };
    }
  }

  return null;
}

export function evaluateTaskAdmission(input: {
  intent: CoordinationWorkIntent;
  tasks: readonly CoordinationTaskLike[];
  focusRooms?: readonly CoordinationFocusRoomLike[];
  leases?: readonly CoordinationLeaseLike[];
  now?: Date;
}): CoordinationAdmissionResult {
  const duplicate = findDuplicateCoordinationIntent(input);
  if (!duplicate) {
    return {
      kind: "allow",
      reason: "no_duplicate",
    };
  }

  return {
    kind: "route_to_review",
    duplicate,
    reason:
      `Duplicate work intent matched ${duplicate.reason} on ${duplicate.taskId}; ` +
      "route the actor to review the existing work instead of creating a new implementation lane.",
  };
}

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
