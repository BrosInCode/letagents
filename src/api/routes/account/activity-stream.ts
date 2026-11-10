import type { EventEmitter } from "node:events";

import type { Express } from "express";

import { ROOM_JOIN_REQUEST_EVENT } from "../../../../shared/room-join-requests.mjs";
import type { AccountActivityHub, AccountRoomActivity } from "../../account-activity/hub.js";
import type { getAccountRoomsForAccount } from "../../account-room-membership/list.js";
import { getRoomMemberRole } from "../../db/room-members.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { openSseConnection } from "../../http/sse.js";
import {
  ROOM_JOIN_REQUEST_CHANGED,
  readRoomJoinRequestChangedEvent,
  roomJoinRequestEvents,
  roomJoinRequestStreamPayload,
} from "../../rooms/join-request-events.js";
import { roomMembershipInvalidationEvents } from "../../rooms/membership-events.js";
import { roomEventBridgeLossEvents } from "../../server/bridged-emitter.js";
import { ACCOUNT_ROOM_READ, ACCOUNT_ROOM_READ_STREAM_EVENT, accountReadEvents, type AccountRoomReadEvent } from "../../account-unread/read-events.js";

export interface AccountActivityStreamDeps {
  hub: AccountActivityHub;
  getAccountRoomsForAccount: typeof getAccountRoomsForAccount;
  /** Someone asked to join a room, or the request was answered. Defaults to the server's emitter. */
  joinRequestEvents?: EventEmitter;
  /** Whether the account is an admin of the room right now. Defaults to the members store. */
  isRoomAdmin?(accountId: string, roomId: string): Promise<boolean>;
}

async function isRoomAdminInStore(accountId: string, roomId: string): Promise<boolean> {
  return (await getRoomMemberRole(roomId, accountId)) === "admin";
}

/** The room list is capped at this many rooms, and so is the stream. */
const ACCOUNT_ACTIVITY_ROOM_LIMIT = 100;

/**
 * One stream per account for the sidebar: which rooms have agents working in
 * them and each room's latest message. It covers exactly the rooms
 * /account/rooms lists, and carries nothing a member cannot already see in
 * that room. A client reconnects after it joins or leaves a room to watch the
 * new set; every connection starts with a full snapshot, so nothing replays.
 */
export function registerAccountActivityStreamRoute(app: Express, deps: AccountActivityStreamDeps): void {
  app.get("/account/activity/stream", async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount || (req.authKind !== "session" && req.authKind !== "owner_token")) {
      res.status(401).json({ error: "Room activity requires a signed-in account." });
      return;
    }
    let roomIds: string[];
    try {
      const rooms = await deps.getAccountRoomsForAccount(req.sessionAccount.account_id, {
        login: req.sessionAccount.login,
        limit: ACCOUNT_ACTIVITY_ROOM_LIMIT,
      });
      roomIds = rooms.flatMap((room) => [room.room_id, ...room.focus_rooms.map((focus) => focus.room_id)]);
    } catch (error) {
      console.error("[account activity] could not list rooms", error);
      res.status(500).json({ error: "Room activity could not be loaded. Please retry." });
      return;
    }

    const connection = openSseConnection(req, res, `account activity ${req.sessionAccount.account_id}`);
    // A person removed from a room stops seeing its activity now. Closing the
    // stream makes the client reconnect and watch its new room list.
    const login = req.sessionAccount.login.trim().toLowerCase();
    const watchedRoomIds = new Set(roomIds.map((roomId) => roomId.toLowerCase()));
    const onMembershipEnded = (payload: unknown) => {
      const ended = payload && typeof payload === "object" ? payload as { roomId?: unknown; login?: unknown } : {};
      if (ended.login === login && typeof ended.roomId === "string" && watchedRoomIds.has(ended.roomId)) connection.close();
    };
    roomMembershipInvalidationEvents.on("invalidate", onMembershipEnded);
    connection.addCleanup(() => { roomMembershipInvalidationEvents.off("invalidate", onMembershipEnded); });
    // A lost cross-instance frame may have been such a removal: reconnect and
    // read the room list again, as the room streams recheck on a loss.
    const onBridgeLoss = (payload: unknown) => {
      const reason = payload && typeof payload === "object" ? (payload as { reason?: unknown }).reason : null;
      if (reason === "uninterested_reference" || reason === "listener_connected_boundary") return;
      connection.close();
    };
    roomEventBridgeLossEvents.on("loss", onBridgeLoss);
    connection.addCleanup(() => { roomEventBridgeLossEvents.off("loss", onBridgeLoss); });
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const send = (activity: AccountRoomActivity) => {
      void connection.write(frame("room", activity));
    };
    // This account read a room, here or on another device: its unread count
    // changed. The frame names the room and the newest message read, so a
    // client can tell its own report's echo; it re-reads /account/unread.
    const readerId = req.sessionAccount.account_id;
    const onRead = (event: AccountRoomReadEvent) => {
      if (event.accountId === readerId && watchedRoomIds.has(event.roomId.toLowerCase()) && !connection.closed) {
        void connection.write(frame(ACCOUNT_ROOM_READ_STREAM_EVENT, { room_id: event.roomId, last_message_id: event.lastMessageId }));
      }
    };
    accountReadEvents.on(ACCOUNT_ROOM_READ, onRead);
    connection.addCleanup(() => { accountReadEvents.off(ACCOUNT_ROOM_READ, onRead); });
    // A request to join one of this person's rooms reaches them here even when
    // that room is not open, so the desktop can alert them at once. It names
    // the person who asked, so the role is checked for every event, and only
    // a signed-in app (never an owner token) receives it.
    if (req.authKind === "session") {
      const accountId = req.sessionAccount.account_id;
      const joinRequestEvents = deps.joinRequestEvents ?? roomJoinRequestEvents;
      const isRoomAdmin = deps.isRoomAdmin ?? isRoomAdminInStore;
      const onJoinRequest = (payload: unknown) => {
        const event = readRoomJoinRequestChangedEvent(payload);
        // The event is published once per room under the access room; one frame is enough here.
        if (!event || event.projectId !== event.accessRoomId || !watchedRoomIds.has(event.accessRoomId.toLowerCase())) return;
        void isRoomAdmin(accountId, event.accessRoomId).then((admin) => {
          if (admin && !connection.closed) void connection.write(frame(ROOM_JOIN_REQUEST_EVENT, roomJoinRequestStreamPayload(event.accessRoomId, event)));
        }).catch((error) => {
          console.warn("[account activity] join request role check failed", error);
        });
      };
      joinRequestEvents.on(ROOM_JOIN_REQUEST_CHANGED, onJoinRequest);
      connection.addCleanup(() => { joinRequestEvents.off(ROOM_JOIN_REQUEST_CHANGED, onJoinRequest); });
    }
    try {
      const watch = await deps.hub.watch(roomIds, send);
      connection.addCleanup(() => watch.close());
      if (connection.closed) return;
      await connection.write(frame("snapshot", { rooms: watch.snapshot }));
    } catch (error) {
      console.error("[account activity] could not start the stream", error);
      connection.close();
    }
  });
}
