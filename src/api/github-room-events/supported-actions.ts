export const SUPPORTED_PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
  "converted_to_draft",
  "closed",
]);

export const SUPPORTED_ISSUE_ACTIONS = new Set(["opened", "reopened", "closed"]);
export const SUPPORTED_ISSUE_COMMENT_ACTIONS = new Set(["created"]);
export const SUPPORTED_PULL_REQUEST_REVIEW_ACTIONS = new Set(["submitted", "dismissed"]);
export const SUPPORTED_CHECK_RUN_ACTIONS = new Set(["completed"]);
export const SUPPORTED_REPOSITORY_ACTIONS = new Set(["renamed", "transferred"]);
export const SUPPORTED_INSTALLATION_REPOSITORY_ACTIONS = new Set(["added", "removed"]);
