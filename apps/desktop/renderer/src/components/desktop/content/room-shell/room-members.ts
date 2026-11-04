import { REPO_ROOM_USES_GITHUB_ROLES, REPO_ROOM_USES_GITHUB_ROLES_MESSAGE } from "../../../../../../../../shared/room-membership.mjs";
import type { DesktopRoomMembershipFailure, RoomMember } from "../../../../../../electron/ipc-types";
import { compareText } from "../../../../domain/formatters";

/** What the Room settings rail shows for Members; null while the block is hidden. */
export function roomMembersSummary(
  view: "hidden" | "github" | "members" | "left" | "error",
  memberCount: number,
  requestCount: number,
): string | null {
  switch (view) {
    case "hidden":
      return null;
    case "github":
      return "GitHub";
    case "left":
      return "Left";
    case "error":
      return "Error";
    default:
      return requestCount ? `${memberCount} · ${requestCount} waiting` : String(memberCount);
  }
}

/** Admins first, then by name, so the people who can let others in are easy to find. */
export function sortRoomMembers(members: readonly RoomMember[], viewerAccountId: string | null): RoomMember[] {
  return [...members].sort((left, right) =>
    Number(right.role === "admin") - Number(left.role === "admin")
    || Number(right.account_id === viewerAccountId) - Number(left.account_id === viewerAccountId)
    || compareText(left.display_name || left.login, right.display_name || right.login));
}

/** The words for a refused member change. The server's own message wins when it sends one. */
export function roomMembershipErrorMessage(result: DesktopRoomMembershipFailure): string {
  if (result.code === "ROOM_LAST_ADMIN") {
    // An API error with no message carries only its code word, not a sentence.
    return /\s/.test(result.message)
      ? result.message
      : "A room needs at least one admin. Make another member an admin first.";
  }
  if (result.code === REPO_ROOM_USES_GITHUB_ROLES.code) return REPO_ROOM_USES_GITHUB_ROLES_MESSAGE;
  // The plain admin refusal has no code; a coded 403 explains itself.
  if (result.status === 403 && !result.code) return "Only room admins can do this.";
  if (result.status === 429) return "Too many changes. Wait a minute, then try again.";
  if (result.code === "REPO_ACCESS_UNAVAILABLE") return "GitHub is not answering. Try again in a minute.";
  return result.message || "LetAgents could not save the change.";
}
