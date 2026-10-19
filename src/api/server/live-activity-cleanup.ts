import { deleteStaleLiveActivitySessions } from "../db/reasoning.js";
import { reasoningEvents } from "./events.js";

/** Cadence of the stale live-session sweep. */
export const LIVE_ACTIVITY_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
/**
 * How long a live session is kept after its last snapshot. A working agent's
 * desktop replaces the session every turn and refreshes it every few seconds,
 * and the end of the agent's last worker session in the room removes it, so
 * only an agent whose desktop stopped publishing (its owner's computer is
 * off, a withdrawal could not reach the server, a restart never came back)
 * keeps one this long.
 */
export const LIVE_ACTIVITY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const LIVE_ACTIVITY_CLEANUP_BATCH = 100;
export const MAX_LIVE_ACTIVITY_CLEANUP_BATCHES_PER_TICK = 5;

export interface LiveActivityCleanupDeps {
  now(): number;
  deleteStale(input: { updated_before: string; limit: number }): Promise<Array<{ id: string; room_id: string }>>;
  removed(input: { room_id: string; session_id: string }): void;
}

/** Tell a room that live sessions are gone, so its members stop showing them. */
export function announceLiveActivityRemoved(input: { room_id: string; session_ids: readonly string[] }): void {
  for (const sessionId of input.session_ids) {
    reasoningEvents.emit("reasoning:removed", { projectId: input.room_id, session_id: sessionId, kind: "live" });
  }
}

const defaultDeps: LiveActivityCleanupDeps = {
  now: () => Date.now(),
  deleteStale: deleteStaleLiveActivitySessions,
  removed: ({ room_id, session_id }) => announceLiveActivityRemoved({ room_id, session_ids: [session_id] }),
};

/**
 * Remove live sessions whose last snapshot is older than the retention, in
 * bounded batches, and tell each room so its members stop showing them.
 */
export async function cleanupStaleLiveActivityOnce(
  deps: LiveActivityCleanupDeps = defaultDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ deleted: number }> {
  const updatedBefore = new Date(deps.now() - LIVE_ACTIVITY_RETENTION_MS).toISOString();
  let deleted = 0;
  for (let batch = 0; batch < MAX_LIVE_ACTIVITY_CLEANUP_BATCHES_PER_TICK && !signal.aborted; batch++) {
    const removed = await deps.deleteStale({ updated_before: updatedBefore, limit: LIVE_ACTIVITY_CLEANUP_BATCH });
    for (const session of removed) deps.removed({ room_id: session.room_id, session_id: session.id });
    deleted += removed.length;
    if (removed.length < LIVE_ACTIVITY_CLEANUP_BATCH) break;
  }
  return { deleted };
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let cleanupPromise: Promise<void> | null = null;
let cleanupAbort: AbortController | null = null;

export function startLiveActivityCleanup(): void {
  if (cleanupTimer) return;
  const abort = new AbortController();
  cleanupAbort = abort;
  const tick = async () => {
    if (cleanupPromise || abort.signal.aborted) return;
    const pending = cleanupStaleLiveActivityOnce(defaultDeps, abort.signal)
      .then(() => undefined, (error: unknown) => {
        console.error("Stale live activity cleanup failed:", error);
      })
      .finally(() => {
        if (cleanupPromise === pending) cleanupPromise = null;
      });
    cleanupPromise = pending;
    await pending;
  };
  cleanupTimer = setInterval(() => void tick(), LIVE_ACTIVITY_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

/** Stop the timer; a running sweep finishes its current batch. */
export async function stopLiveActivityCleanup(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  cleanupAbort?.abort();
  cleanupAbort = null;
  await cleanupPromise;
}
