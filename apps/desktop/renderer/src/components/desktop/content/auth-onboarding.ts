import type { DesktopRoomAccess } from "../../../../../electron/ipc-types";

export type AuthCardState =
  | "loading"
  | "connect"
  | "code"
  | "connected"
  | "forbidden"
  | "missing"
  | "unavailable";

export interface AuthCardStateInput {
  /** A room snapshot is still being fetched, so no verdict has arrived yet. */
  snapshotPending: boolean;
  status: DesktopRoomAccess["status"];
  hasPendingAuth: boolean;
  authenticated: boolean;
}

export interface AuthSnapshotPendingInput {
  rootLoading: boolean;
  selectedLoading: boolean;
  hasSnapshot: boolean;
}

/**
 * Root-room loading starts before selectedSnapshotLoading does. Treat either
 * request as pending until a snapshot exists so startup never flashes a false
 * unavailable verdict.
 */
export function isAuthSnapshotPending(input: AuthSnapshotPendingInput): boolean {
  return !input.hasSnapshot && (input.rootLoading || input.selectedLoading);
}

/**
 * Which card the gate shows. A snapshot still in flight is not a verdict, so it
 * always resolves to loading — this is what keeps the ordinary launch race from
 * rendering as "This room didn't load".
 */
export function resolveAuthCardState(input: AuthCardStateInput): AuthCardState {
  if (input.snapshotPending) return "loading";
  switch (input.status) {
    case "missing_room":
      return "missing";
    case "forbidden":
      return "forbidden";
    case "unavailable":
      return "unavailable";
    case "auth_required":
      if (input.hasPendingAuth) return "code";
      return input.authenticated ? "connected" : "connect";
    default:
      return "loading";
  }
}

export const RETRY_BACKOFF_SECONDS: readonly number[] = [8, 15, 30];

/**
 * Absolute retry deadline for a backoff step, as a timestamp. Absolute rather
 * than a tick count because throttled or occluded windows batch timers, and a
 * decrement-per-tick countdown silently stalls when that happens.
 */
export function retryDeadlineAt(
  now: number,
  step: number,
  backoff: readonly number[] = RETRY_BACKOFF_SECONDS,
): number {
  const index = Math.min(Math.max(step, 0), backoff.length - 1);
  return now + backoff[index] * 1000;
}

/** Whole seconds left until the deadline, or null when no retry is scheduled. */
export function retrySecondsLeft(now: number, deadline: number): number | null {
  if (deadline === 0) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Next backoff step, clamped at the longest interval. */
export function nextRetryStep(
  step: number,
  backoff: readonly number[] = RETRY_BACKOFF_SECONDS,
): number {
  return Math.min(step + 1, backoff.length - 1);
}
