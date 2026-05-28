import type {
  DesktopActivityEntry,
  DesktopTaskSummary,
} from "../../../../../../electron/ipc-types";
import { sortTasksByUpdated } from "../../../../domain/tasks";

export function mergeTasks(...taskLists: DesktopTaskSummary[][]): DesktopTaskSummary[] {
  const merged = new Map<string, DesktopTaskSummary>();
  for (const task of taskLists.flat()) {
    merged.set(task.id, task);
  }
  return sortTasksByUpdated([...merged.values()]);
}

export function activityTasksToDesktopTasks(tasks: DesktopActivityEntry["currentTasks"]): DesktopTaskSummary[] {
  return tasks.map((task) => ({
    ...task,
    description: null,
    assignee: null,
    assigneeAgentKey: null,
    createdBy: null,
    prUrl: null,
    workflowArtifacts: [],
    activeLeases: [],
    activeLocks: [],
    stalePromptState: null,
    createdAt: null,
    updatedAt: task.updatedAt || "",
  }));
}
