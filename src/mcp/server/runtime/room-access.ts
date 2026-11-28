import {
  GITHUB_SIGN_IN_REQUIRED_MESSAGE,
  REPO_COLLABORATOR_REQUIRED_MESSAGE,
  ROOM_MEMBERSHIP_REQUIRED_MESSAGE,
  type RoomJoinRequestSummary,
} from "../../../../shared/room-membership.mjs";
import { RoomAccessRefusedError } from "./api.js";
import { RepoRoomAuthRequiredError, toRepoRoomAuthRequiredResult } from "./device-auth.js";
import { currentSessionScope } from "./session-scope.js";
import { getWorkerBearerRuntime } from "./worker-bearer.js";

/** A bot handed an invite code uses it rather than asking: an admin's invite lets it in at once. */
export const INVITE_CODE_HINT = "If someone gave you an invite code (XXXX-XXXX), call join_code with it instead.";

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
  if (error.needsGitHubSignIn) {
    // LetAgents could not ask GitHub: no live GitHub token for the person.
    // A remote session (ChatGPT, Claude connectors) borrows the token of the
    // person's latest GitHub sign-in, so a sign-in on the website clears it.
    const remote = Boolean(currentSessionScope());
    return {
      success: false,
      error: "github_sign_in_required",
      next_step: remote ? "ask_your_user_to_sign_in" : "start_device_auth",
      room_id: error.roomId,
      message: `${error.serverMessage ?? GITHUB_SIGN_IN_REQUIRED_MESSAGE} `
        + (remote
          ? "Tell your user: sign in to letagents.chat with GitHub, then ask you to open the room again."
          : "Call start_device_auth, let your user approve it, then call poll_device_auth and open the room again."),
    };
  }
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
  // A worker credential acts for an agent, and only a person's account may
  // ask to join, so such an agent hands the step to its user.
  const canAsk = getWorkerBearerRuntime().mode === "owner";
  return {
    success: false,
    error: "membership_required",
    next_step: canAsk ? "request_room_access" : "ask_your_user",
    room_id: error.roomId,
    display_name: error.displayName,
    join_request: error.joinRequest,
    message: `${error.serverMessage ?? ROOM_MEMBERSHIP_REQUIRED_MESSAGE} `
      + (canAsk
        ? `${joinRequestInstruction(error.joinRequest)} ${INVITE_CODE_HINT}`
        : "This agent cannot ask to join. Tell your user: they ask in the LetAgents app, and a room admin approves.")
      + " Do not retry this room until an admin lets you in.",
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
