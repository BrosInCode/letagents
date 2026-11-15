import type { RoomJoinRequestSummary } from "../../../../shared/room-membership.mjs";
import { ApiError, apiCallWhenFree, isMissingRouteError, parseApiErrorPayload, rememberRefusedRoomId } from "./api.js";
import { maybeHandleRepoRoomAuthRequired } from "./device-auth.js";
import { joinRequestInstruction } from "./room-access.js";
import { getWorkerBearerRuntime } from "./worker-bearer.js";

/**
 * What a one-use invite code did for this account. "admitted": the account is
 * a member and the caller joins the room. "not_found": no invite has this
 * code, so it may be a room's own old XXXX-XXXX code. Every other answer is
 * final and carries the tool result to return.
 */
export type RoomInviteRedemption =
  | { kind: "admitted"; roomId: string; displayName: string | null; joinedNow: boolean }
  | { kind: "not_found"; result: Record<string, unknown> }
  | { kind: "answered"; result: Record<string, unknown> };

const ASK_FOR_A_NEW_ONE = "Do not retry this code. Tell your user to ask the person who invited them for a new invite.";

function refusal(error: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { success: false, error, next_step: "ask_for_new_invite", ...extra, message };
}

/**
 * Uses an invite code for this account (the person signed in to this MCP
 * client). A worker credential acts for an agent, and only a person's account
 * may join, so such an agent hands the code to its user.
 */
export async function redeemRoomInviteCode(code: string): Promise<RoomInviteRedemption> {
  if (getWorkerBearerRuntime().mode !== "owner") {
    return {
      kind: "answered",
      result: {
        success: false,
        error: "person_required",
        next_step: "ask_your_user",
        message: "This agent cannot use an invite code. Tell your user: they connect LetAgents to their own bot "
          + "or MCP client, sign in, and use the code there.",
      },
    };
  }
  let answer: Record<string, unknown>;
  try {
    answer = await apiCallWhenFree<Record<string, unknown>>("/invites/redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // Not signed in yet: start the device flow, as every other join does.
    await maybeHandleRepoRoomAuthRequired(error, code);
    // A server from before invites: the code can only be a room's own code.
    if (isMissingRouteError(error)) {
      return { kind: "not_found", result: refusal("invite_not_found", `This invite code is not valid. ${ASK_FOR_A_NEW_ONE}`) };
    }
    const payload = parseApiErrorPayload(error) ?? {};
    const serverMessage = typeof payload.error === "string" ? payload.error : null;
    switch (payload.code) {
      case "INVITE_NOT_FOUND":
        return {
          kind: "not_found",
          result: refusal("invite_not_found", `${serverMessage ?? "This invite code is not valid."} ${ASK_FOR_A_NEW_ONE}`),
        };
      case "INVITE_USED":
        return { kind: "answered", result: refusal("invite_used", `${serverMessage ?? "This invite code was already used."} ${ASK_FOR_A_NEW_ONE}`) };
      case "INVITE_CANCELLED":
        return { kind: "answered", result: refusal("invite_cancelled", `${serverMessage ?? "This invite was cancelled."} ${ASK_FOR_A_NEW_ONE}`) };
      case "INVITE_EXPIRED":
        return { kind: "answered", result: refusal("invite_expired", `${serverMessage ?? "This invite code has ended."} ${ASK_FOR_A_NEW_ONE}`) };
      case "INVITE_MAKER_LEFT":
        return { kind: "answered", result: refusal("invite_maker_left", `${serverMessage ?? "This invite no longer works."} ${ASK_FOR_A_NEW_ONE}`) };
      case "INVITE_REPO_ROOM":
        return {
          kind: "answered",
          result: refusal("invite_repo_room", `${serverMessage ?? "This invite is for a Git Room, which takes no invites."} ${ASK_FOR_A_NEW_ONE}`),
        };
      case "PERSON_REQUIRED":
        return {
          kind: "answered",
          result: {
            success: false,
            error: "person_required",
            next_step: "ask_your_user",
            message: `${serverMessage ?? "An agent cannot use an invite code."} Tell your user to use the code from their own MCP client.`,
          },
        };
      case "ROOM_JOIN_REQUEST_COOLDOWN": {
        const joinRequest = (payload.join_request && typeof payload.join_request === "object"
          ? payload.join_request
          : null) as RoomJoinRequestSummary | null;
        const retryAfter = typeof payload.retry_after === "string" ? payload.retry_after : joinRequest?.retry_after ?? null;
        return {
          kind: "answered",
          result: {
            success: false,
            state: "declined",
            room_id: typeof payload.room_id === "string" ? payload.room_id : null,
            join_request: joinRequest,
            retry_after: retryAfter,
            next_step: "wait_until_retry_after",
            message: `A room admin declined your last request to join this room. The invite was not used. `
              + `You can ask again with request_room_access after ${retryAfter ?? "the wait the server sets"}.`,
          },
        };
      }
      case "RATE_LIMITED":
        return {
          kind: "answered",
          result: {
            success: false,
            error: "rate_limited",
            message: `${serverMessage ?? "Too many invite codes tried."} Wait ten minutes before you try the code again.`,
          },
        };
      default:
        throw error;
    }
  }

  const roomId = typeof answer.room_id === "string" ? answer.room_id : "";
  const displayName = typeof answer.display_name === "string" ? answer.display_name : null;
  if (answer.outcome === "admitted" && roomId) {
    return { kind: "admitted", roomId, displayName, joinedNow: answer.joined === true };
  }
  if (answer.outcome === "requested" && roomId) {
    const joinRequest = (answer.join_request && typeof answer.join_request === "object"
      ? answer.join_request
      : null) as RoomJoinRequestSummary | null;
    // request_room_access with no room_id now asks about this room.
    rememberRefusedRoomId(roomId);
    return {
      kind: "answered",
      result: {
        success: true,
        state: "pending",
        room_id: roomId,
        display_name: displayName,
        join_request: joinRequest,
        next_step: "wait_for_room_admin",
        message: "The invite asked a room admin to let you in: the person who made it is a member, not an admin. "
          + `${joinRequestInstruction(joinRequest)} Do not call it in a loop: a person must decide, and that can take hours. `
          + "Tell your user that a room admin must approve.",
      },
    };
  }
  throw new Error("The server answered the invite code in a form this client does not know.");
}
