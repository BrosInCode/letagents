import {
  getActiveTaskLeases,
  getActiveTaskLocks,
  getStaleTaskPromptMutes,
  type Task,
} from "../../db.js";
import { getTaskStalePromptState } from "../../tasks/stale-work.js";

export async function attachTaskDetails(projectId: string, task: Task) {
  const [leases, locks, stalePromptMutes] = await Promise.all([
    getActiveTaskLeases(projectId),
    getActiveTaskLocks(projectId),
    getStaleTaskPromptMutes(projectId, [task.id]),
  ]);
  const stalePromptMute = stalePromptMutes[0] ?? null;
  return {
    ...task,
    stale_prompt_state: getTaskStalePromptState({
      task,
      mute: stalePromptMute,
    }),
    active_leases: leases.filter((lease) => lease.task_id === task.id),
    active_locks: locks.filter((lock) => lock.task_id === task.id || lock.scope === "room"),
  };
}

export async function attachTaskListDetails(projectId: string, tasks: Task[]) {
  const [leases, locks, stalePromptMutes] = await Promise.all([
    getActiveTaskLeases(projectId),
    getActiveTaskLocks(projectId),
    tasks.length > 0 ? getStaleTaskPromptMutes(projectId, tasks.map((task) => task.id)) : Promise.resolve([]),
  ]);
  const stalePromptMuteByTaskId = new Map(
    stalePromptMutes.map((mute) => [mute.task_id, mute] as const)
  );
  return tasks.map((task) => ({
    ...task,
    stale_prompt_state: getTaskStalePromptState({
      task,
      mute: stalePromptMuteByTaskId.get(task.id) ?? null,
    }),
    active_leases: leases.filter((lease) => lease.task_id === task.id),
    active_locks: locks.filter((lock) => lock.task_id === task.id || lock.scope === "room"),
  }));
}

export function isCurrentStalePromptAction(input: {
  taskUpdatedAt: string;
  promptTimestamp: string | null | undefined;
}): boolean {
  const taskUpdatedAtMs = Date.parse(input.taskUpdatedAt);
  const promptTimestampMs = Date.parse(input.promptTimestamp ?? "");
  if (!Number.isFinite(taskUpdatedAtMs) || !Number.isFinite(promptTimestampMs)) {
    return false;
  }

  return taskUpdatedAtMs <= promptTimestampMs;
}
