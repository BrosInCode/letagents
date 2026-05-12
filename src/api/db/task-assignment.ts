import type { TaskRow, TaskStatus } from "./types.js";

export interface TaskAssignmentPatch {
  status?: TaskStatus;
  assignee?: string | null;
  assignee_agent_key?: string | null;
}

export function resolveTaskAssignmentState(
  task: Pick<TaskRow, "status" | "assignee" | "assignee_agent_key">,
  updates: TaskAssignmentPatch
): Pick<TaskRow, "status" | "assignee" | "assignee_agent_key"> {
  const hasAssigneeUpdate = Object.prototype.hasOwnProperty.call(updates, "assignee");
  const hasAssigneeAgentKeyUpdate = Object.prototype.hasOwnProperty.call(
    updates,
    "assignee_agent_key"
  );

  return {
    status: updates.status ?? task.status,
    assignee: hasAssigneeUpdate ? updates.assignee ?? null : task.assignee,
    assignee_agent_key: hasAssigneeUpdate
      ? hasAssigneeAgentKeyUpdate
        ? updates.assignee_agent_key ?? null
        : null
      : hasAssigneeAgentKeyUpdate
        ? updates.assignee_agent_key ?? null
        : task.assignee_agent_key,
  };
}
