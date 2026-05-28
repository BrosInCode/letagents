import type { CoordinationLockLike } from "./types.js";

export function isActiveCoordinationLock(lock: CoordinationLockLike): boolean {
  return !lock.cleared_at;
}

export function lockAppliesToTask(
  lock: CoordinationLockLike,
  taskId: string | null | undefined
): boolean {
  if (!isActiveCoordinationLock(lock)) {
    return false;
  }
  if (lock.scope === "room") {
    return true;
  }
  return Boolean(taskId && lock.task_id === taskId);
}

export function findApplicableLock(input: {
  locks: readonly CoordinationLockLike[];
  taskId?: string | null;
}): CoordinationLockLike | null {
  return input.locks.find((lock) => lockAppliesToTask(lock, input.taskId)) ?? null;
}
