import type { RepoRoomEvent } from "./types.js";

export type TaskStatusLike =
  | "proposed"
  | "accepted"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "merged"
  | "done"
  | "cancelled";

export interface BoardProjectionResult {
  newStatus: TaskStatusLike;
  reason: string;
}

export function shouldAutoPromptForBoardProjection(
  result: BoardProjectionResult | null
): boolean {
  return result?.reason === "pr_opened" || result?.reason === "review_changes_requested";
}

export function projectPullRequestEvent(input: {
  action: string;
  merged: boolean;
  currentStatus: TaskStatusLike;
}): BoardProjectionResult | null {
  const PRE_REVIEW: Set<TaskStatusLike> = new Set(["assigned", "in_progress"]);
  const MERGEABLE: Set<TaskStatusLike> = new Set(["in_review", "in_progress", "assigned"]);

  if (input.action === "opened" || input.action === "ready_for_review") {
    if (PRE_REVIEW.has(input.currentStatus)) {
      return { newStatus: "in_review", reason: "pr_opened" };
    }
  }

  if (input.action === "closed" && input.merged) {
    if (MERGEABLE.has(input.currentStatus)) {
      return { newStatus: "merged", reason: "pr_merged" };
    }
  }

  return null;
}

export function projectPullRequestReviewEvent(input: {
  action: string;
  reviewState: string;
  currentStatus: TaskStatusLike;
}): BoardProjectionResult | null {
  if (input.action !== "submitted") return null;

  if (input.reviewState === "changes_requested" && input.currentStatus === "in_review") {
    return { newStatus: "blocked", reason: "review_changes_requested" };
  }

  return null;
}

export function projectIssueEvent(input: {
  action: string;
  currentStatus: TaskStatusLike;
}): BoardProjectionResult | null {
  const CLOSEABLE: Set<TaskStatusLike> = new Set(["merged", "in_review", "in_progress"]);

  if (input.action === "closed" && CLOSEABLE.has(input.currentStatus)) {
    return { newStatus: "done", reason: "issue_closed" };
  }

  return null;
}

export function projectRepoRoomEvent(input: {
  event: RepoRoomEvent;
  currentStatus: TaskStatusLike;
}): BoardProjectionResult | null {
  switch (input.event.kind) {
    case "pull_request":
      return projectPullRequestEvent({
        action: input.event.action,
        merged: Boolean(input.event.pullRequest.merged),
        currentStatus: input.currentStatus,
      });
    case "pull_request_review":
      return projectPullRequestReviewEvent({
        action: input.event.action,
        reviewState: input.event.review.state,
        currentStatus: input.currentStatus,
      });
    case "issue":
      return projectIssueEvent({
        action: input.event.action,
        currentStatus: input.currentStatus,
      });
    case "issue_comment":
    case "check_run":
    case "repository":
      return null;
    default:
      return null;
  }
}
