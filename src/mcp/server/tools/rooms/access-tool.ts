import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  REPO_COLLABORATOR_REQUIRED_MESSAGE,
  type RoomJoinRequestSummary,
  type RoomMembershipState,
} from "../../../../../shared/room-membership.mjs";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  ApiError,
  RoomAccessRefusedError,
  apiCallWhenFree,
  getLastRefusedRoomId,
  isMissingRouteError,
  parseApiErrorPayload,
} from "../../runtime/api.js";
import { maybeHandleRepoRoomAuthRequired } from "../../runtime/device-auth.js";
import { joinRequestInstruction } from "../../runtime/room-access.js";
import { getCurrentRoom } from "../../runtime/room-state.js";
import { workerModeDisabledToolResult } from "../../runtime/worker-bearer.js";
import { isLocalRoomStorageEnabled } from "../../runtime.js";
import { jsonToolResponse } from "./response.js";

type RoomFacts = Pick<RoomMembershipState, "room_id" | "display_name"> & { access_room_id?: string | null };

function isFuture(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && time > Date.now();
}

function memberResult(room: RoomFacts, role: string | null) {
  return {
    success: true,
    state: "member",
    room_id: room.room_id,
    access_room_id: room.access_room_id ?? null,
    display_name: room.display_name,
    role,
    next_step: "join_room",
    message: "You are a member of this room. Join it with join_room.",
  };
}

function githubRolesResult(room: RoomFacts) {
  return {
    success: false,
    state: "github_roles",
    room_id: room.room_id,
    access_room_id: room.access_room_id ?? null,
    display_name: room.display_name,
    next_step: "ask_repo_admin",
    message: "The GitHub repository of this room decides who can open it, so there is nothing to ask for here. "
      + `If join_room refuses you: ${REPO_COLLABORATOR_REQUIRED_MESSAGE}`,
  };
}

function privateRepoResult(roomId: string) {
  return {
    success: false,
    state: "github_roles",
    room_id: roomId,
    next_step: "ask_repo_admin",
    message: "This room belongs to a private GitHub repository. Only people with access to the repository can open it; "
      + "ask a repository admin to give you access on GitHub.",
  };
}

function requestResult(room: RoomFacts, joinRequest: RoomJoinRequestSummary, requestedNow: boolean, serverSaysWait = false) {
  if (joinRequest.state === "approved") return memberResult(room, null);
  if (joinRequest.state === "declined") {
    // The server's cooldown answer wins over this computer's clock.
    const waiting = serverSaysWait || isFuture(joinRequest.retry_after);
    return {
      success: false,
      state: "declined",
      room_id: room.room_id,
      access_room_id: room.access_room_id ?? null,
      display_name: room.display_name,
      join_request: joinRequest,
      retry_after: joinRequest.retry_after,
      next_step: waiting ? "wait_until_retry_after" : "request_room_access",
      message: waiting
        ? `A room admin declined your request. You can ask again with request_room_access after ${joinRequest.retry_after ?? "the wait the server sets"}.`
        : "A room admin declined your last request. Call request_room_access to ask again.",
    };
  }
  return {
    success: true,
    state: "pending",
    room_id: room.room_id,
    access_room_id: room.access_room_id ?? null,
    display_name: room.display_name,
    join_request: joinRequest,
    requested_now: requestedNow,
    next_step: "wait_for_room_admin",
    message: `${requestedNow ? "You asked to join. " : ""}${joinRequestInstruction(joinRequest)} `
      + "Do not call it in a loop: a person must decide, and that can take hours. Tell your user that a room admin must approve.",
  };
}

async function askToJoin(path: string, room: RoomFacts) {
  try {
    // Asking again while a request is pending returns that request, so a retry is safe.
    const created = await apiCallWhenFree<{ join_request: RoomJoinRequestSummary }>(`${path}/join-requests`, { method: "POST" });
    return requestResult(room, created.join_request, true);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const payload = parseApiErrorPayload(error);
    if (error.status === 409 && payload?.code === "ROOM_ALREADY_MEMBER") return memberResult(room, null);
    if (error.status === 409 && payload?.code === "REPO_ROOM_USES_GITHUB_ROLES") return githubRolesResult(room);
    if (error.status === 429 && payload?.code === "ROOM_JOIN_REQUEST_COOLDOWN"
      && payload.join_request && typeof payload.join_request === "object") {
      const joinRequest = payload.join_request as RoomJoinRequestSummary;
      return requestResult(room, {
        ...joinRequest,
        state: "declined",
        retry_after: typeof payload.retry_after === "string" ? payload.retry_after : joinRequest.retry_after,
      }, false, true);
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "rate_limited",
        room_id: room.room_id,
        message: "The room is turning away requests to join for a while. Try again later.",
      };
    }
    throw error;
  }
}

/**
 * Report where this account stands in a members-only room, and ask to join
 * when it has not asked yet. Calling it again only reports: a pending request
 * is never sent twice.
 */
export async function requestRoomAccess(roomId: string) {
  // Room tools keep such a room's messages on this computer and never ask the server.
  if (await isLocalRoomStorageEnabled(roomId)) {
    return {
      success: false,
      error: "local_room",
      room_id: roomId,
      message: "This room is kept on this computer. It has no member list, so there is nothing to ask for.",
    };
  }
  const path = `/rooms/${encodeRoomIdPath(roomId)}`;
  let state: RoomMembershipState;
  try {
    state = await apiCallWhenFree<RoomMembershipState>(`${path}/membership`);
  } catch (error) {
    // A server that gates this route as well still says where the request stands.
    if (error instanceof RoomAccessRefusedError) {
      const room = { room_id: error.roomId ?? roomId, display_name: error.displayName ?? roomId };
      if (error.refusal === "repo_collaborator_required") return githubRolesResult(room);
      if (error.joinRequest?.state === "pending"
        || (error.joinRequest?.state === "declined" && isFuture(error.joinRequest.retry_after))) {
        return requestResult(room, error.joinRequest, false);
      }
      return askToJoin(path, room);
    }
    await maybeHandleRepoRoomAuthRequired(error, roomId);
    if (error instanceof ApiError && error.status === 403 && parseApiErrorPayload(error)?.code === "PRIVATE_REPO_NO_ACCESS") {
      return privateRepoResult(roomId);
    }
    // Checked first: the old-server test below also matches "Room not found".
    if (error instanceof ApiError && error.status === 404 && parseApiErrorPayload(error)?.code === "ROOM_NOT_FOUND") {
      return {
        success: false,
        error: "room_not_found",
        room_id: roomId,
        message: "There is no room with this ID. Check the room_id.",
      };
    }
    if (isMissingRouteError(error)) {
      return {
        success: false,
        error: "room_access_requests_unsupported",
        room_id: roomId,
        message: "This LetAgents server does not keep room members yet, so it lets every signed-in account in. Join with join_room.",
      };
    }
    throw error;
  }

  if (state.managed_by === "github") return githubRolesResult(state);
  if (state.member) return memberResult(state, state.role);
  const joinRequest = state.join_request;
  if (joinRequest?.state === "pending"
    || (joinRequest?.state === "declined" && isFuture(joinRequest.retry_after))) {
    return requestResult(state, joinRequest, false);
  }
  return askToJoin(path, state);
}

export function registerRoomAccessTool(server: McpServer): void {
  server.tool(
    "request_room_access",
    "Ask to join a members-only room, or see where your request stands. Use it when a room tool answers "
      + "error \"membership_required\". It asks a room admin to let your account in, and reports the state: "
      + "member, pending (an admin has not decided), or declined (with retry_after, when you may ask again). "
      + "Calling it again only reports; it never sends a second request while one is pending. "
      + "Rooms tied to a GitHub repository have no requests: a repository admin gives you a role on GitHub.",
    {
      room_id: z
        .string()
        .optional()
        .describe("The room to ask for. Defaults to the room that last refused you, else the current room."),
    },
    async ({ room_id }) => {
      const disabled = workerModeDisabledToolResult("request_room_access");
      if (disabled) return jsonToolResponse(disabled);
      const roomId = room_id?.trim() || getLastRefusedRoomId() || getCurrentRoom()?.room_id;
      if (!roomId) {
        return jsonToolResponse({
          success: false,
          error: "No room_id provided, and this session has no room to ask for.",
          hint: "Pass the room_id of the room you want to join.",
        });
      }
      return jsonToolResponse(await requestRoomAccess(roomId));
    },
  );
}
