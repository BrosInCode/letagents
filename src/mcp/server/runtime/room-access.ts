import {
  REPO_COLLABORATOR_REQUIRED_MESSAGE,
  ROOM_MEMBERSHIP_REQUIRED_MESSAGE,
  type RoomJoinRequestSummary,
} from "../../../../shared/room-membership.mjs";
import { RoomAccessRefusedError } from "./api.js";
import { RepoRoomAuthRequiredError, toRepoRoomAuthRequiredResult } from "./device-auth.js";

function isFuture(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && time > Date.now();
}

/** What an agent should do next about its own latest request to join. */
export function joinRequestInstruction(joinRequest: RoomJoinRequestSummary | null): string {
  if (joinRequest?.state === "pending") {
    return "Your request to join is waiting for a room admin. Call request_room_access later to see the decision.";
  }
  if (joinRequest?.state === "declined" && isFuture(joinRequest.retry_after)) {
    return `A room admin declined your request. You can ask again with request_room_access after ${joinRequest.retry_after}.`;
  }
  return "Call request_room_access to ask to join. A room admin approves or declines the request.";
}

/**
 * The tool result for a members-only refusal. It tells the agent to stop:
 * every room call fails the same way until an admin lets the account in.
 */
export function toRoomAccessRefusalResult(error: RoomAccessRefusedError): Record<string, unknown> {
  if (error.refusal === "repo_collaborator_required") {
    return {
      success: false,
      error: "repo_collaborator_required",
      next_step: "ask_repo_admin",
      room_id: error.roomId,
      message: `${error.serverMessage ?? REPO_COLLABORATOR_REQUIRED_MESSAGE} `
        + "Do not retry this room until you have a role on the repository.",
    };
  }
  return {
    success: false,
    error: "membership_required",
    next_step: "request_room_access",
    room_id: error.roomId,
    display_name: error.displayName,
    join_request: error.joinRequest,
    message: `${error.serverMessage ?? ROOM_MEMBERSHIP_REQUIRED_MESSAGE} ${joinRequestInstruction(error.joinRequest)} `
      + "Do not retry this room until an admin lets you in.",
  };
}

/**
 * The tool response for an error that says what the agent must do before the
 * room will answer: sign in (device flow), or become a member. Null for any
 * other error.
 */
export function roomAccessToolResponse(error: unknown) {
  const result = error instanceof RoomAccessRefusedError
    ? toRoomAccessRefusalResult(error)
    : error instanceof RepoRoomAuthRequiredError
      ? toRepoRoomAuthRequiredResult(error)
      : null;
  if (!result) return null;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
