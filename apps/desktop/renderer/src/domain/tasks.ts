import type { DesktopTaskSummary } from "../../../electron/ipc-types";
import { timestampValue } from "./time";
import { TASK_STATUS_ORDER } from "../../../../../shared/ui/task-status";

export { TASK_STATUS_ORDER };

const statusRanks = new Map<string, number>(
  TASK_STATUS_ORDER.map((status, index) => [status, index + 1])
);

export function sortTasks(tasks: readonly DesktopTaskSummary[]): DesktopTaskSummary[] {
  return [...tasks].sort((left, right) => {
    const statusDelta = (statusRanks.get(left.status) || 999) - (statusRanks.get(right.status) || 999);
    if (statusDelta !== 0) return statusDelta;
    return timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
  });
}

export function sortTasksByUpdated(tasks: readonly DesktopTaskSummary[]): DesktopTaskSummary[] {
  return [...tasks].sort((left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt));
}
