import { readonly, shallowRef } from "vue";
import type {
  DesktopAccountRoomJoinRequest,
  DesktopRoomJoinRequestDecision,
  DesktopRoomMembershipResult,
  RoomJoinRequestSummary,
} from "../../../electron/ipc-types";
import {
  createJoinRequestSoundGate,
  type RoomJoinRequestEvent,
} from "../../../../../shared/room-join-requests.mjs";
import { desktopIpc } from "../ipc/index.js";

/** What a new request asks of the app: a sound now, or not (the window is hidden and one played a moment ago). */
export interface JoinRequestArrival {
  request: DesktopAccountRoomJoinRequest;
  playSound: boolean;
}

/**
 * Pending requests to join the rooms where this account is an admin, for the
 * Inbox and for the banner at the top of each room. The server streams a new
 * request to its admins the moment it arrives (the room stream of an open room,
 * and the account activity stream for every room) and streams the answer too;
 * the list is also read again when the window gains focus, when Needs you
 * refreshes and when a room's settings open. A request that was waiting before
 * the app looked is not news: only a streamed arrival plays a sound or raises a
 * notification, once per request.
 */
function createRoomJoinRequests() {
  const items = shallowRef<readonly DesktopAccountRoomJoinRequest[]>([]);
  const error = shallowRef("");
  /** Requests whose banner the person closed; a decided request is gone anyway. */
  const dismissed = shallowRef<ReadonlySet<string>>(new Set());
  const gate = createJoinRequestSoundGate();
  const arrivalListeners = new Set<(arrival: JoinRequestArrival) => void>();
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
      // Requests that were already waiting are a baseline, not an alert.
      for (const item of result.joinRequests) gate.remember(item.id);
      items.value = result.joinRequests;
      error.value = "";
    } else if (result.status === 401) {
      items.value = [];
      error.value = "";
    } else {
      error.value = result.message || "Join requests could not be checked.";
    }
  }

  /**
   * A `join_request` frame from the server. A new pending request joins the
   * list and is announced; an answered or cancelled one leaves it.
   */
  function receive(event: RoomJoinRequestEvent): void {
    const request = event.request;
    if (request.state !== "pending") {
      forget(request.id);
      return;
    }
    if (items.value.some((item) => item.id === request.id)) return;
    latest += 1;
    items.value = [...items.value, request];
    const hidden = typeof document !== "undefined" && document.hidden;
    const arrival: JoinRequestArrival = { request, playSound: gate.shouldPlay(request.id, hidden) };
    for (const listener of arrivalListeners) {
      try { listener(arrival); } catch (cause) { console.warn("[join requests] arrival listener failed", cause); }
    }
  }

  /** Called for every request that arrives live; returns the unsubscribe. */
  function onArrival(listener: (arrival: JoinRequestArrival) => void): () => void {
    arrivalListeners.add(listener);
    return () => { arrivalListeners.delete(listener); };
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

  /** Closes the banner for these requests; they stay in the Inbox. */
  function dismiss(requestIds: readonly string[]): void {
    const next = new Set(dismissed.value);
    for (const id of requestIds) next.add(id);
    dismissed.value = next;
  }

  function reset(): void {
    latest += 1;
    items.value = [];
    error.value = "";
    dismissed.value = new Set();
    gate.reset();
  }

  return { items: readonly(items), error: readonly(error), dismissed: readonly(dismissed), refresh, receive, onArrival, decide, forget, dismiss, reset };
}

export const roomJoinRequests = createRoomJoinRequests();
