export const OPEN_TASK_STATUSES = new Set([
  "proposed",
  "accepted",
  "assigned",
  "in_progress",
  "blocked",
  "in_review",
]);

export const COMPLETED_TASK_STATUSES = new Set(["merged", "done"]);
export const INACTIVE_REASONING_STATUSES = new Set(["completed", "done", "dismissed", "closed"]);
export const RECENT_SIGNAL_WINDOW_MS = 15 * 60 * 1000;
