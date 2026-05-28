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
        label: "Lease overrides owner",
        badge: "Mismatch",
        detail: `Assigned to ${owner}, but execution authority is held by ${holder || "another worker"}. Release the lane if this is stale.`,
      };
    }
    return {
      state: "held",
      label: "Lane held",
      badge: "Lane held",
      detail: `${holder || "A worker"} has active execution authority for this task.`,
    };
  }
  return {
    state: "missing",
    label: "No active lease",
    badge: "Missing",
    detail: task.assignee
      ? "The task has an owner but no active work lease recorded."
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
      detail: "Move the task to review before assigning board review authority.",
    };
  }
  if (conflicts.length) {
    return {
      state: "conflict",
      label: "Reviewer conflicts with work holder",
      badge: "Conflict",
      detail: "At least one reviewer also matches the active work lease. Assign a different worker before treating the board review as valid.",
    };
  }
  if (reviews.length) {
    return {
      state: "assigned",
      label: "Reviewer assigned",
      badge: "Assigned",
      detail: "A separate worker has board review authority for this task.",
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
