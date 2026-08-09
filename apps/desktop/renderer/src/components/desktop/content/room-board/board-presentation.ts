import type { DesktopTaskSummary, WorkerSnapshot } from "../../../../../../electron/ipc-types";
import { TASK_STATUS_ORDER } from "../../../../domain/tasks";
import { taskMatchesLocalWorker } from "./board-workers";
import { readableStatus } from "./formatters";
import { reviewLeases, shouldShowReviewPanel, workLease } from "./task-state";
import type { TaskGroup } from "./types";

export type BoardFilter = "open" | "mine" | "unclaimed" | "needs-review" | "closeout";

export type BoardEmptyStateAction =
  | "clear-search"
  | "show-open"
  | "show-closeout"
  | "add-task";

export interface BoardEmptyState {
  title: string;
  description: string;
  actionLabel: string;
  action: BoardEmptyStateAction;
  testId?: string;
}

export const ACTIVE_BOARD_STATUSES = TASK_STATUS_ORDER.slice(0, 6);
export const CLOSEOUT_BOARD_STATUSES = TASK_STATUS_ORDER.slice(6);

export const BOARD_FILTERS: ReadonlyArray<{ id: BoardFilter; label: string }> = [
  { id: "open", label: "Open" },
  { id: "mine", label: "Local agent" },
  { id: "unclaimed", label: "Unclaimed" },
  { id: "needs-review", label: "Needs review" },
  { id: "closeout", label: "Closeout" },
];

export function isBoardFilter(value: string): value is BoardFilter {
  return BOARD_FILTERS.some((filter) => filter.id === value);
}

export function taskIsUnclaimed(task: DesktopTaskSummary): boolean {
  return ["proposed", "accepted"].includes(task.status)
    && !task.assignee
    && !workLease(task);
}

export function taskNeedsReview(task: DesktopTaskSummary): boolean {
  return task.status === "in_review"
    || (shouldShowReviewPanel(task) && reviewLeases(task).length === 0);
}

export function taskMatchesBoardFilter(
  task: DesktopTaskSummary,
  filter: BoardFilter,
  localWorker: WorkerSnapshot | null
): boolean {
  if (filter === "closeout") return CLOSEOUT_BOARD_STATUSES.includes(task.status as typeof CLOSEOUT_BOARD_STATUSES[number]);
  if (!ACTIVE_BOARD_STATUSES.includes(task.status as typeof ACTIVE_BOARD_STATUSES[number])) return false;
  if (filter === "mine") return taskMatchesLocalWorker(task, localWorker);
  if (filter === "unclaimed") return taskIsUnclaimed(task);
  if (filter === "needs-review") return taskNeedsReview(task);
  return true;
}

export function taskMatchesBoardSearch(
  task: DesktopTaskSummary,
  searchQuery: string
): boolean {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    task.id,
    task.title,
    task.description || "",
    task.status,
    task.assignee || "",
    task.assigneeAgentKey || "",
    task.createdBy || "",
    ...task.workflowRefs.map((ref) => `${ref.provider} ${ref.kind} ${ref.label}`),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

export function boardFilterCount(
  tasks: DesktopTaskSummary[],
  filter: BoardFilter,
  localWorker: WorkerSnapshot | null
): number {
  return tasks.filter((task) => taskMatchesBoardFilter(task, filter, localWorker)).length;
}

export function visibleBoardGroups(input: {
  tasks: DesktopTaskSummary[];
  filter: BoardFilter;
  searchQuery: string;
  localWorker: WorkerSnapshot | null;
}): TaskGroup[] {
  const statuses = input.filter === "closeout"
    ? CLOSEOUT_BOARD_STATUSES
    : ACTIVE_BOARD_STATUSES;
  const tasks = input.tasks.filter((task) =>
    taskMatchesBoardFilter(task, input.filter, input.localWorker)
    && taskMatchesBoardSearch(task, input.searchQuery)
  );
  return statuses.map((status) => ({
    status,
    label: readableStatus(status),
    tasks: tasks.filter((task) => task.status === status),
  }));
}

export function boardEmptyState(input: {
  taskCount: number;
  hasSearchQuery: boolean;
  filter: BoardFilter;
  closeoutTaskCount: number;
}): BoardEmptyState {
  if (input.taskCount === 0) {
    return {
      title: "No tasks yet",
      description: "Create the first task here so a teammate or agent can pick it up.",
      actionLabel: "Add first task",
      action: "add-task",
      testId: "room-board-empty",
    };
  }
  if (input.hasSearchQuery) {
    return {
      title: "No tasks match this search",
      description: "Try another title, task id, owner, or external link.",
      actionLabel: "Clear search",
      action: "clear-search",
    };
  }
  if (input.filter === "mine") {
    return {
      title: "No tasks for the local agent",
      description: "Tasks assigned to the agent running from this desktop will appear here.",
      actionLabel: "Show open tasks",
      action: "show-open",
    };
  }
  if (input.filter === "unclaimed") {
    return {
      title: "No unclaimed tasks",
      description: "Proposed or accepted tasks without an owner will appear here.",
      actionLabel: "Show open tasks",
      action: "show-open",
    };
  }
  if (input.filter === "needs-review") {
    return {
      title: "Nothing needs review",
      description: "Tasks waiting for review or blocked follow-up will appear here.",
      actionLabel: "Show open tasks",
      action: "show-open",
    };
  }
  if (input.filter === "closeout") {
    return {
      title: "No closeout tasks",
      description: "Merged, done, and cancelled tasks will appear here for final closeout.",
      actionLabel: "Show open tasks",
      action: "show-open",
    };
  }
  return input.closeoutTaskCount > 0
    ? {
      title: "No open tasks",
      description: "All tasks in this room are in closeout right now. Switch to Closeout to finish or audit them.",
      actionLabel: "Show closeout",
      action: "show-closeout",
    }
    : {
      title: "No open tasks",
      description: "Create a task when there is new work to hand off to a teammate or agent.",
      actionLabel: "Add task",
      action: "add-task",
    };
}

export function deriveTaskTitle(title: string, description: string): string {
  const explicitTitle = title.trim();
  if (explicitTitle) return explicitTitle;
  const firstLine = description
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean) || "Untitled task";
  return firstLine.length > 96
    ? `${firstLine.slice(0, 93).trimEnd()}...`
    : firstLine;
}
