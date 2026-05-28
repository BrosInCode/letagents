import {
  artifactsShareIdentity,
  intentWorkflowArtifacts,
  isOpenCoordinationTask,
  leaseWorkflowArtifacts,
  normalizeIdentity,
  normalizeUrlIdentity,
  taskWorkflowArtifacts,
} from "./identity.js";
import { isActiveCoordinationLease } from "./leases.js";
import type {
  CoordinationAdmissionResult,
  CoordinationDuplicateMatch,
  CoordinationFocusRoomLike,
  CoordinationLeaseLike,
  CoordinationTaskLike,
  CoordinationWorkIntent,
} from "./types.js";

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
