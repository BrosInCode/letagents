import type { EventEmitter } from "node:events";

import type { Express } from "express";

import { ROOM_JOIN_REQUEST_EVENT } from "../../../../shared/room-join-requests.mjs";
import { ROOM_MENTION_EVENT } from "../../../../shared/room-mention-events.mjs";
import type { AccountActivityHub, AccountRoomActivity } from "../../account-activity/hub.js";
import type { getAccountRoomsForAccount } from "../../account-room-membership/list.js";
import { getRoomMemberRole } from "../../db/room-members.js";
import { getProjectById } from "../../db/rooms.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { openSseConnection } from "../../http/sse.js";
import { resolveRequestAuth } from "../../request/auth.js";
import { GitHubAccessUnavailableError, REPO_ACCESS_REFRESH_AFTER_MS } from "../../github/repo-access.js";
import { classifyRoomAccess, decideRoomRead, roomAccessPrincipal } from "../../rooms/access-decision.js";
import { roomAccessName } from "../../rooms/access.js";
import { acquireLiveRoomAuthorization, type LiveRoomAuthorizationLease } from "../../rooms/live-authorization.js";
import {
  ROOM_JOIN_REQUEST_CHANGED,
  readRoomJoinRequestChangedEvent,
  roomJoinRequestEvents,
  roomJoinRequestStreamPayload,
} from "../../rooms/join-request-events.js";
import {
  ROOM_MENTION_CREATED,
  readRoomMentionCreatedEvent,
  roomMentionEvents,
  roomMentionStreamPayload,
} from "../../rooms/mention-events.js";
import { roomMembershipInvalidationEvents } from "../../rooms/membership-events.js";
import { roomEventBridgeLossEvents } from "../../server/bridged-emitter.js";
import { ACCOUNT_ROOM_READ, ACCOUNT_ROOM_READ_STREAM_EVENT, accountReadEvents, type AccountRoomReadEvent } from "../../account-unread/read-events.js";

export interface AccountActivityStreamDeps {
  hub: AccountActivityHub;
  getAccountRoomsForAccount: typeof getAccountRoomsForAccount;
  /** Someone asked to join a room, or the request was answered. Defaults to the server's emitter. */
  joinRequestEvents?: EventEmitter;
  /** Someone was @mentioned in a room, including unopened or archived rooms. Defaults to the server's emitter. */
  mentionEvents?: EventEmitter;
  /** Whether the account is an admin of the room right now. Defaults to the members store. */
  isRoomAdmin?(accountId: string, roomId: string): Promise<boolean>;
  /**
   * The live read re-check of one watched room. Defaults to a lease of
   * live-authorization.ts in the activity scope over the cached room read
   * decision. Null: the room is gone.
   */
  openRoomAuthorization?(req: AuthenticatedRequest, roomId: string): Promise<LiveRoomAuthorizationLease | null>;
  /** Whether the stream's own credential still names the same account. Defaults to a fresh credential read. */
  credentialStillValid?(req: AuthenticatedRequest): Promise<boolean>;
}

/**
 * After a check that got no answer, a frame for that room is skipped without
 * asking again for this long, so a GitHub outage costs one check per room per
 * period, not one per frame.
 */
const ACTIVITY_FAILURE_RETRY_MS = 30_000;

/**
 * The activity frames' own lease for one watched room (a focus room is
 * judged by its own target, as the room gates judge it). Activity frames
 * carry only ids, times, agent names and `tasks_changed_at`, so they are
 * decided from CACHED answers: the cached GitHub "yes" is refreshed in the
 * background after 5 minutes (a definite "no" invalidates at once), and the
 * lease keeps an answer for the same 5 minutes. A membership end, a GitHub
 * webhook cache clear, a bridge loss or a credential retirement invalidates
 * it at once. It is a separate lease from the room stream's, which keeps its
 * fresh 60 s check; neither can starve or close the other. No timer: an idle
 * room costs nothing.
 */
async function openRoomAuthorization(req: AuthenticatedRequest, roomId: string): Promise<LiveRoomAuthorizationLease | null> {
  const project = await getProjectById(roomId);
  if (!project) return null;
  const target = await classifyRoomAccess(project);
  return acquireLiveRoomAuthorization({
    req,
    roomId: project.id,
    accessRoomName: roomAccessName(target),
    scope: "account_activity",
    leaseMs: REPO_ACCESS_REFRESH_AFTER_MS,
    failureRetryMs: ACTIVITY_FAILURE_RETRY_MS,
    authorize: async () => {
      // A revoked session or owner token must not keep receiving frames.
      const fresh = await resolveRequestAuth(req);
      if (fresh.authKind !== req.authKind || fresh.account?.account_id !== req.sessionAccount?.account_id) return false;
      const decision = await decideRoomRead({
        project,
        target,
        principal: roomAccessPrincipal(fresh.account),
        freshness: "cached",
      });
      // No answer from GitHub is not a "no": the lease skips the frame and holds nothing.
      if (decision.kind === "indeterminate") throw new GitHubAccessUnavailableError(null);
      return decision.kind === "allow";
    },
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
    // Each watched room, lower-cased, to its id as listed.
    const watchedRoomOf = new Map<string, string>();
    try {
      const rooms = await deps.getAccountRoomsForAccount(req.sessionAccount.account_id, {
        login: req.sessionAccount.login,
        limit: ACCOUNT_ACTIVITY_ROOM_LIMIT,
      });
      roomIds = rooms.flatMap((room) => [room.room_id, ...room.focus_rooms.map((focus) => focus.room_id)]);
      for (const roomId of roomIds) watchedRoomOf.set(roomId.toLowerCase(), roomId);
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

    // Every frame about a room passes a live read re-check of that room (its
    // own lease, see openRoomAuthorization). A room the account can no longer
    // read stops appearing in frames: before the next frame after an
    // invalidation event, else within one lease period. A refusal is kept
    // only for the lease period or until an invalidation; a check that got no
    // answer skips that frame only. The stream stays open for the other rooms;
    // a revoked credential closes it.
    const openLease = deps.openRoomAuthorization ?? openRoomAuthorization;
    const checkCredential = deps.credentialStillValid ?? credentialStillValid;
    const leases = new Map<string, Promise<LiveRoomAuthorizationLease | null>>();
    const queues = new Map<string, Promise<void>>();
    let credentialCheckedAt = -Infinity;
    connection.addCleanup(() => {
      for (const lease of leases.values()) void lease.then((value) => value?.release(), () => undefined);
      leases.clear();
    });
    const leaseFor = (roomId: string) => {
      const leaseKey = roomId.toLowerCase();
      let lease = leases.get(leaseKey);
      if (!lease) {
        lease = openLease(req, roomId).then((opened) => {
          if (opened && connection.closed) { opened.release(); return null; }
          return opened;
        }, (error: unknown) => {
          // Load the room again on its next frame.
          leases.delete(leaseKey);
          throw error;
        });
        leases.set(leaseKey, lease);
      }
      return lease;
    };
    const authorizeRoom = async (targetRoomId: string): Promise<boolean> => {
      if (!targetRoomId || connection.closed) return false;
      const lease = await leaseFor(targetRoomId);
      if (!lease) return false;
      if (await lease.check()) return !connection.closed;
      // A refusal (not a missing answer): is the credential itself gone? At
      // most one read per lease period, then close the whole stream.
      if (!lease.lastCheckFailed() && !connection.closed && Date.now() - credentialCheckedAt >= REPO_ACCESS_REFRESH_AFTER_MS) {
        credentialCheckedAt = Date.now();
        if (!(await checkCredential(req).catch(() => true))) connection.close();
      }
      return false;
    };
    const mayShow = async (roomId: string): Promise<boolean> => {
      const watched = watchedRoomOf.get(roomId.toLowerCase());
      if (!watched) return false;
      return authorizeRoom(watched);
    };
    const mayShowTargetRoom = async (roomId: string): Promise<boolean> => {
      const canonical = watchedRoomOf.get(roomId.toLowerCase()) ?? roomId;
      return authorizeRoom(canonical);
    };
    /** Writes a room's frames in order, each after its room's re-check. */
    const writeAboutRoom = (roomId: string, data: () => string) => {
      const key = roomId.toLowerCase();
      const next = (queues.get(key) ?? Promise.resolve()).then(async () => {
        if (await mayShow(roomId)) await connection.write(data());
      }).catch((error) => {
        console.warn("[account activity] room re-check failed", error);
      });
      queues.set(key, next);
      void next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
    };
    /** Writes a targeted room frame (including unopened/archived rooms) after a live read check. */
    const writeAboutTargetRoom = (roomId: string, data: () => string) => {
      const key = roomId.toLowerCase();
      const next = (queues.get(key) ?? Promise.resolve()).then(async () => {
        if (await mayShowTargetRoom(roomId)) await connection.write(data());
      }).catch((error) => {
        console.warn("[account activity] target room re-check failed", error);
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

      const mentionEvents = deps.mentionEvents ?? roomMentionEvents;
      const onRoomMention = (payload: unknown) => {
        const event = readRoomMentionCreatedEvent(payload);
        if (
          !event
          || connection.closed
          || !event.targetAccountIds.includes(accountId)
          || event.publisherAccountId === accountId
        ) {
          return;
        }
        writeAboutTargetRoom(event.projectId, () => frame(ROOM_MENTION_EVENT, roomMentionStreamPayload(event)));
      };
      mentionEvents.on(ROOM_MENTION_CREATED, onRoomMention);
      connection.addCleanup(() => { mentionEvents.off(ROOM_MENTION_CREATED, onRoomMention); });
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
