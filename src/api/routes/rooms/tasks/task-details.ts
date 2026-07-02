import {
  getActiveTaskLeases,
  getActiveTaskLocks,
  getStaleTaskPromptMutes,
  type Task,
  type TaskLease,
} from "../../../db.js";
import { getTaskStalePromptState } from "../../../tasks/stale-work.js";

function ageMsSince(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : null;
}

function getTaskBoardStalePromptState(input: {
  task: Task;
  leases: TaskLease[];
  mute?: Parameters<typeof getTaskStalePromptState>[0]["mute"];
}) {
  const promptState = getTaskStalePromptState({
    task: input.task,
    mute: input.mute,
  });
  const workLease = input.leases.find((lease) => lease.task_id === input.task.id && lease.kind === "work");
  if ((input.task.status === "accepted" || input.task.status === "merged") && workLease) {
    return {
      ...promptState,
      is_stale: true,
      reason: `${input.task.status}_with_work_lease`,
      stale_for_ms: ageMsSince(workLease.updated_at || workLease.created_at),
    };
  }
  if (["assigned", "in_progress", "blocked"].includes(input.task.status) && !workLease) {
    return {
      ...promptState,
      is_stale: true,
      reason: "missing_work_lease",
      stale_for_ms: ageMsSince(input.task.updated_at),
    };
  }
  return promptState;
}

export async function attachTaskDetails(projectId: string, task: Task) {
  const [leases, locks, stalePromptMutes] = await Promise.all([
    getActiveTaskLeases(projectId),
    getActiveTaskLocks(projectId),
    getStaleTaskPromptMutes(projectId, [task.id]),
  ]);
  const stalePromptMute = stalePromptMutes[0] ?? null;
  const taskLeases = leases.filter((lease) => lease.task_id === task.id);
  return {
    ...task,
    stale_prompt_state: getTaskBoardStalePromptState({
      task,
      leases: taskLeases,
      mute: stalePromptMute,
    }),
    active_leases: taskLeases,
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
    stale_prompt_state: getTaskBoardStalePromptState({
      task,
      leases,
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
