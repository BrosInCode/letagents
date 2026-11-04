import { readonly, shallowRef } from "vue";
import type {
  DesktopAccountRoomJoinRequest,
  DesktopRoomJoinRequestDecision,
  DesktopRoomMembershipResult,
  RoomJoinRequestSummary,
} from "../../../electron/ipc-types";
import { desktopIpc } from "../ipc/index.js";

/**
 * Pending requests to join the rooms where this account is an admin, for the
 * Inbox. The server sends no live update for a new request, so the list is
 * read again when the window gains focus, when Needs you refreshes (the Inbox
 * opening, and its existing one-minute check) and when a room's settings open.
 */
function createRoomJoinRequests() {
  const items = shallowRef<readonly DesktopAccountRoomJoinRequest[]>([]);
  const error = shallowRef("");
  // Only the newest read may land; a decision made here discards older reads.
  let latest = 0;

  async function refresh(): Promise<void> {
    const request = ++latest;
    let result: DesktopRoomMembershipResult<{ joinRequests: DesktopAccountRoomJoinRequest[] }> | undefined;
    try {
      result = await desktopIpc.roomMembers?.listAccountJoinRequests();
    } catch (cause) {
      if (request === latest) error.value = cause instanceof Error ? cause.message : "Join requests could not be checked.";
      return;
    }
    if (request !== latest || !result) return;
    if (result.ok) {
      items.value = result.joinRequests;
      error.value = "";
    } else if (result.status === 401) {
      items.value = [];
      error.value = "";
    } else {
      error.value = result.message || "Join requests could not be checked.";
    }
  }

  async function decide(
    joinRequest: Pick<DesktopAccountRoomJoinRequest, "id" | "room_id">,
    decision: Exclude<DesktopRoomJoinRequestDecision, "cancel">,
  ): Promise<DesktopRoomMembershipResult<{ joinRequest: RoomJoinRequestSummary }>> {
    const result = await desktopIpc.roomMembers.decideJoinRequest(joinRequest.room_id, joinRequest.id, decision);
    // A request another admin decided first is no longer waiting either.
    if (result.ok || result.code === "ROOM_JOIN_REQUEST_NOT_PENDING") forget(joinRequest.id);
    void refresh();
    return result;
  }

  /** Drops a request decided somewhere else in the app, such as room settings. */
  function forget(requestId: string): void {
    latest += 1;
    items.value = items.value.filter((item) => item.id !== requestId);
  }

  function reset(): void {
    latest += 1;
    items.value = [];
    error.value = "";
  }

  return { items: readonly(items), error: readonly(error), refresh, decide, forget, reset };
}

export const roomJoinRequests = createRoomJoinRequests();
