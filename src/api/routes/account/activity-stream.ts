import type { EventEmitter } from "node:events";

import type { Express } from "express";

import { ROOM_JOIN_REQUEST_EVENT } from "../../../../shared/room-join-requests.mjs";
import type { AccountActivityHub, AccountRoomActivity } from "../../account-activity/hub.js";
import type { getAccountRoomsForAccount } from "../../account-room-membership/list.js";
import { getRoomMemberRole } from "../../db/room-members.js";
import { getProjectById } from "../../db/rooms.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { openSseConnection } from "../../http/sse.js";
import { resolveRequestAuth } from "../../request/auth.js";
import { classifyRoomAccess } from "../../rooms/access-decision.js";
import { reauthorizeGitRoomParticipant, roomAccessName } from "../../rooms/access.js";
import { acquireLiveRoomAuthorization, type LiveRoomAuthorizationLease } from "../../rooms/live-authorization.js";
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
  /**
   * The live read re-check of one watched top-level room, as room streams
   * have it. Defaults to the shared lease of live-authorization.ts over the
   * fresh room read decision. Null: the room is gone.
   */
  openRoomAuthorization?(req: AuthenticatedRequest, roomId: string): Promise<LiveRoomAuthorizationLease | null>;
  /** Whether the stream's own credential still names the same account. Defaults to a fresh credential read. */
  credentialStillValid?(req: AuthenticatedRequest): Promise<boolean>;
}

/**
 * The same lease a room stream of this credential holds for the room: a fresh
 * read decision at most once per 60 s while frames flow, at once after a
 * membership end, a GitHub webhook cache clear, a bridge loss or a credential
 * retirement. It has no timer: an idle room costs nothing.
 */
async function openRoomAuthorization(req: AuthenticatedRequest, roomId: string): Promise<LiveRoomAuthorizationLease | null> {
  const project = await getProjectById(roomId);
  if (!project) return null;
  const target = await classifyRoomAccess(project);
  return acquireLiveRoomAuthorization({
    req,
    roomId: project.id,
    accessRoomName: roomAccessName(target),
    authorize: () => reauthorizeGitRoomParticipant(req, project),
  });
}

async function credentialStillValid(req: AuthenticatedRequest): Promise<boolean> {
  const fresh = await resolveRequestAuth(req);
  return fresh.authKind === req.authKind && fresh.account?.account_id === req.sessionAccount?.account_id;
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
    // Each watched room, lower-cased, to the top-level room its access follows
    // (a focus room follows its parent, as the room list decides it).
    const accessRoomOf = new Map<string, string>();
    try {
      const rooms = await deps.getAccountRoomsForAccount(req.sessionAccount.account_id, {
        login: req.sessionAccount.login,
        limit: ACCOUNT_ACTIVITY_ROOM_LIMIT,
      });
      roomIds = rooms.flatMap((room) => [room.room_id, ...room.focus_rooms.map((focus) => focus.room_id)]);
      for (const room of rooms) {
        accessRoomOf.set(room.room_id.toLowerCase(), room.room_id);
        for (const focus of room.focus_rooms) accessRoomOf.set(focus.room_id.toLowerCase(), room.room_id);
      }
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

    // Every frame about a room passes the same live read re-check as a room
    // stream. A room the account can no longer read stops appearing in frames:
    // after at most one lease period (60 s) while frames flow, and before the
    // next frame after an invalidation event (membership ended, a GitHub
    // webhook cache clear, a bridge loss, a credential retirement). The stream
    // stays open for the other rooms; a revoked credential closes it. A
    // refused room is held, with no further checks, until an invalidation
    // event or a reconnect, so a GitHub outage costs no repeated checks.
    const openLease = deps.openRoomAuthorization ?? openRoomAuthorization;
    const checkCredential = deps.credentialStillValid ?? credentialStillValid;
    const leases = new Map<string, Promise<LiveRoomAuthorizationLease | null>>();
    const held = new Set<string>();
    const queues = new Map<string, Promise<void>>();
    const stopListening: Array<() => void> = [];
    connection.addCleanup(() => {
      for (const stop of stopListening.splice(0)) stop();
      for (const lease of leases.values()) void lease.then((value) => value?.release(), () => undefined);
      leases.clear();
    });
    const leaseFor = (accessRoomId: string) => {
      let lease = leases.get(accessRoomId);
      if (!lease) {
        lease = openLease(req, accessRoomId).then((opened) => {
          if (!opened) return null;
          if (connection.closed) { opened.release(); return null; }
          // The lease itself is marked stale at once; the next frame re-checks.
          stopListening.push(opened.onInvalidated(() => { held.delete(accessRoomId); }));
          return opened;
        }, (error: unknown) => {
          // Load the room again on its next frame.
          leases.delete(accessRoomId);
          throw error;
        });
        leases.set(accessRoomId, lease);
      }
      return lease;
    };
    const mayShow = async (roomId: string): Promise<boolean> => {
      const accessRoomId = accessRoomOf.get(roomId.toLowerCase());
      if (!accessRoomId || held.has(accessRoomId) || connection.closed) return false;
      const lease = await leaseFor(accessRoomId);
      if (!lease) return false;
      if (await lease.check()) return !connection.closed;
      held.add(accessRoomId);
      if (!connection.closed && !(await checkCredential(req).catch(() => false))) connection.close();
      return false;
    };
    /** Writes a room's frames in order, each after its room's re-check. */
    const writeAboutRoom = (roomId: string, data: () => string) => {
      const key = accessRoomOf.get(roomId.toLowerCase()) ?? roomId;
      const next = (queues.get(key) ?? Promise.resolve()).then(async () => {
        if (await mayShow(roomId)) await connection.write(data());
      }).catch((error) => {
        console.warn("[account activity] room re-check failed", error);
      });
      queues.set(key, next);
      void next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
    };
    const send = (activity: AccountRoomActivity) => {
      writeAboutRoom(activity.room_id, () => frame("room", activity));
    };
    // This account read a room, here or on another device: its unread count
    // changed. The frame names the room and the newest message read, so a
    // client can tell its own report's echo; it re-reads /account/unread.
    const readerId = req.sessionAccount.account_id;
    const onRead = (event: AccountRoomReadEvent) => {
      if (event.accountId === readerId && watchedRoomIds.has(event.roomId.toLowerCase()) && !connection.closed) {
        writeAboutRoom(event.roomId, () => frame(ACCOUNT_ROOM_READ_STREAM_EVENT, { room_id: event.roomId, last_message_id: event.lastMessageId }));
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
          if (admin && !connection.closed) writeAboutRoom(event.accessRoomId, () => frame(ROOM_JOIN_REQUEST_EVENT, roomJoinRequestStreamPayload(event.accessRoomId, event)));
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
