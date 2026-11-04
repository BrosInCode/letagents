import type { DesktopRoomAccess, RoomJoinRequestSummary } from "../../../../../electron/ipc-types";

export type AuthCardState =
  | "loading"
  | "connect"
  | "code"
  | "connected"
  | "forbidden"
  | "membership"
  | "repo_collaborator"
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
    case "membership_required":
      return "membership";
    case "repo_collaborator_required":
      return "repo_collaborator";
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
 * The server's 503 when GitHub gives no answer to a repository role check.
 * It is not a refusal: the person may have a role, so the app checks again.
 * The shared room-membership module does not define this code.
 */
export const REPO_ACCESS_UNAVAILABLE_CODE = "REPO_ACCESS_UNAVAILABLE";

/** The server asks for 30 s (Retry-After) before a new GitHub check; later checks wait longer. */
export const GITHUB_RETRY_BACKOFF_SECONDS: readonly number[] = [30, 60, 120];

export function retryBackoffFor(code: string | null | undefined): readonly number[] {
  return code === REPO_ACCESS_UNAVAILABLE_CODE ? GITHUB_RETRY_BACKOFF_SECONDS : RETRY_BACKOFF_SECONDS;
}

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

/** Statuses where the person is signed in but not let in; a re-check can open the room. */
export function isMembershipRefusal(status: DesktopRoomAccess["status"] | null | undefined): boolean {
  return status === "membership_required" || status === "repo_collaborator_required";
}

/**
 * A focus room's own id, as the server names it to a person who is not a
 * member: `focus_12`, or a room path with a `/focus/` part.
 */
export function isFocusRoomIdentifier(roomIdentifier: string | null | undefined): boolean {
  const id = roomIdentifier?.trim() ?? "";
  return /^focus_\d+$/i.test(id) || /\/focus\/[^/]/i.test(id);
}

export type JoinCardState =
  /**
   * A focus room refused to a non-member: the server names no main room and
   * takes requests only for the main room, so the card asks for its link.
   */
  | { kind: "main_room_only" }
  /** No request yet, or the last one was cancelled: offer "Ask to join". */
  | { kind: "ask"; declined: false }
  /** The last request was declined and its wait is over: offer to ask again. */
  | { kind: "ask"; declined: true }
  | { kind: "pending"; requestId: string; askedAt: string }
  /** Declined, and the person must wait until `retryAt` to ask again. */
  | { kind: "declined"; retryAt: number };

/**
 * What the join card offers for the person's latest request. An approved
 * request that still meets a refusal (removed again since) is a fresh start.
 */
export function resolveJoinCardState(
  joinRequest: RoomJoinRequestSummary | null | undefined,
  now: number,
  mainRoomOnly = false,
): JoinCardState {
  if (mainRoomOnly) return { kind: "main_room_only" };
  if (joinRequest?.state === "pending") {
    return { kind: "pending", requestId: joinRequest.id, askedAt: joinRequest.created_at };
  }
  if (joinRequest?.state === "declined") {
    const retryAt = Date.parse(joinRequest.retry_after || "");
    if (Number.isFinite(retryAt) && retryAt > now) return { kind: "declined", retryAt };
    return { kind: "ask", declined: true };
  }
  return { kind: "ask", declined: false };
}

/** "in 5 min", "in 3 h", "tomorrow at 09:30": when a declined person can ask again. */
export function joinRetryLabel(retryAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((retryAt - now) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 12) return `in ${hours} h`;
  const at = new Date(retryAt);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === new Date(now).toDateString()) return `today at ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `on ${at.toLocaleDateString()} at ${time}`;
}

/** "just now", "5 min ago", "3 h ago": when the person asked to join. */
export function joinAskedLabel(askedAt: string, now: number): string {
  const at = Date.parse(askedAt);
  if (!Number.isFinite(at)) return "earlier";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}
