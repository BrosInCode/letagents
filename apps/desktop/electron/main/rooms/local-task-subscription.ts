import { setTimeout as delay } from "node:timers/promises";
import { requestLocalBoard } from "../../../../../shared/local-board-owner.mjs";
import type { DesktopTaskSummary } from "../../ipc-types.js";
import { localChatDatabasePath } from "../chat-storage/settings.js";

async function waitForBoardStartup(): Promise<void> {
  const { supervisorDaemonClient } = await import("../supervisor-daemon.js");
  await supervisorDaemonClient.waitForStartup();
}

export async function requestDesktopBoardMutation<T>(operation: string, args: unknown[]): Promise<T> {
  await waitForBoardStartup();
  return requestLocalBoard<T>("mutate", { domain: "desktop", operation, args, databasePath: localChatDatabasePath });
}

/** A healthy subscription waits on a task change, without an idle timeout. */
export async function subscribeLocalTasks(
  roomId: string,
  signal: AbortSignal,
  onTasks: (tasks: DesktopTaskSummary[]) => void,
  onError: (error: unknown) => void,
): Promise<void> {
  let generation = 0;
  let revision = -1;
  let retryDelay = 250;
  let reportedFailure = false;
  while (!signal.aborted) {
    try {
      await waitForBoardStartup();
      if (signal.aborted) return;
      const next = await requestLocalBoard<{ generation: number; revision: number; tasks: DesktopTaskSummary[] }>(
        "watch", { roomId, generation, revision }, { signal, timeoutMs: 0 });
      if (signal.aborted) return;
      if (!Number.isSafeInteger(next.generation) || next.generation < 1
        || !Number.isSafeInteger(next.revision) || next.revision < 0 || !Array.isArray(next.tasks)) {
        throw new Error("The board service returned an invalid update.");
      }
      onTasks(next.tasks);
      generation = next.generation;
      revision = next.revision;
      retryDelay = 250;
      reportedFailure = false;
    } catch (error) {
      if (signal.aborted) return;
      if (!reportedFailure) onError(error);
      reportedFailure = true;
      // Fault-only reconnect, canceled on room switch. Healthy rooms never
      // schedule this timer or make another request until something changes.
      await delay(retryDelay, undefined, { signal }).catch(() => undefined);
      retryDelay = Math.min(retryDelay * 2, 30_000);
      generation = 0;
      revision = -1;
    }
  }
}
