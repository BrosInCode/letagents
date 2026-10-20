import type { DesktopSupervisorDaemonStatus } from "../../ipc-types.js";
import { SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION } from "./constants.js";

export const STATE_WATCH_RETRY_BASE_MS = 1_000;
export const STATE_WATCH_RETRY_MAX_MS = 30_000;

export function supervisorStateWatchRetryDelay(failureCount: number): number {
  const boundedFailureCount = Math.max(1, Math.min(31, Math.trunc(failureCount)));
  return Math.min(
    STATE_WATCH_RETRY_MAX_MS,
    STATE_WATCH_RETRY_BASE_MS * (2 ** (boundedFailureCount - 1)),
  );
}

export function supervisorStateWatchAcceptsStatus(
  status: Pick<DesktopSupervisorDaemonStatus, "implementationVersion">,
): boolean {
  return status.implementationVersion === SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION;
}
