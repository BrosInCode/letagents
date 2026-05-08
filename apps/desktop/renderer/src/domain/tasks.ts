import type { DesktopTaskSummary } from "../../../electron/ipc-types";
import { timestampValue } from "./time";

const statusRanks: Record<string, number> = {
  proposed: 1,
  accepted: 2,
  assigned: 3,
  in_progress: 4,
  blocked: 5,
  in_review: 6,
  merged: 7,
  done: 8,
  cancelled: 9,
};

export function sortTasks(tasks: readonly DesktopTaskSummary[]): DesktopTaskSummary[] {
  return [...tasks].sort((left, right) => {
    const statusDelta = (statusRanks[left.status] || 999) - (statusRanks[right.status] || 999);
    if (statusDelta !== 0) return statusDelta;
    return timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
  });
}

export function sortTasksByUpdated(tasks: readonly DesktopTaskSummary[]): DesktopTaskSummary[] {
  return [...tasks].sort((left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt));
}
