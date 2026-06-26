import type { DesktopTaskSummary } from "../../../../../../electron/ipc-types";
import { compactPerson, normalizeActor } from "./formatters";
import type { AuthorityPanelState, ReviewPanelState, TaskLease } from "./types";

const LEASE_AUTHORITY_STATUSES = new Set(["assigned", "in_progress", "blocked", "in_review"]);

export function workflowRefs(task: DesktopTaskSummary): DesktopTaskSummary["workflowRefs"] {
  return task.workflowRefs.length
    ? task.workflowRefs
    : task.prUrl
      ? [{ provider: "github", kind: "pull_request", label: "PR", url: task.prUrl }]
      : [];
}

export function workLease(task: DesktopTaskSummary): TaskLease | null {
  return task.activeLeases.find((lease) => lease.kind === "work") || null;
}

export function reviewLeases(task: DesktopTaskSummary): TaskLease[] {
  return task.activeLeases.filter((lease) => lease.kind === "review");
}

export function secondaryLeases(task: DesktopTaskSummary): TaskLease[] {
  return task.activeLeases.filter((lease) => lease.kind !== "work" && lease.kind !== "review");
}

export function shouldShowAuthority(task: DesktopTaskSummary): boolean {
  return Boolean(workLease(task) || task.assignee || LEASE_AUTHORITY_STATUSES.has(task.status));
}

export function executionAuthorityState(task: DesktopTaskSummary): AuthorityPanelState {
  const lease = workLease(task);
  if (lease) {
    const owner = compactPerson(task.assignee);
    const holder = compactPerson(lease.holderLabel || lease.agentKey);
    if (owner && task.assigneeAgentKey && lease.agentKey && normalizeActor(task.assigneeAgentKey) !== normalizeActor(lease.agentKey)) {
      return {
        state: "mismatch",
        label: "Different worker is active",
        badge: "Check owner",
        detail: `Assigned to ${owner}, but ${holder || "another worker"} is currently allowed to work on it. Release the worker if this is stale.`,
      };
    }
    return {
      state: "held",
      label: "Work in progress",
      badge: "Active",
      detail: `${holder || "A worker"} can update this task right now.`,
    };
  }
  return {
    state: "missing",
    label: "No one is working on this now",
    badge: "Unclaimed",
    detail: task.assignee
      ? "The task has an owner, but no active worker is attached right now."
      : "No worker owns this task yet.",
  };
}

export function shouldShowReviewPanel(task: DesktopTaskSummary): boolean {
  return ["in_review", "blocked"].includes(task.status) || reviewLeases(task).length > 0;
}

export function reviewPanelState(task: DesktopTaskSummary): ReviewPanelState {
  const work = workLease(task);
  const reviews = reviewLeases(task);
  const conflicts = reviews.filter((review) => review.agentKey && review.agentKey === work?.agentKey);
  if (!shouldShowReviewPanel(task)) {
    return {
      state: "idle",
      label: "Review not active",
      badge: "Idle",
      detail: "Move the task to review before assigning a reviewer.",
    };
  }
  if (conflicts.length) {
    return {
      state: "conflict",
      label: "Reviewer is also the worker",
      badge: "Conflict",
      detail: "The reviewer also appears to be the active worker. Assign someone else before treating this as reviewed.",
    };
  }
  if (reviews.length) {
    return {
      state: "assigned",
      label: "Reviewer assigned",
      badge: "Assigned",
      detail: "A separate teammate or agent is assigned to review this task.",
    };
  }
  return {
    state: "missing",
    label: "Review unassigned",
    badge: "Needed",
    detail: "This task is waiting for an explicit LetAgents reviewer.",
  };
}

export function reviewSummary(task: DesktopTaskSummary): string {
  const reviews = reviewLeases(task);
  return reviews.length
    ? reviews.map((lease) => compactPerson(lease.holderLabel || lease.agentKey) || "Reviewer").join(", ")
    : "Not claimed";
}
