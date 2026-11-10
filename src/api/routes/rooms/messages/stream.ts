import { ROOM_TYPING } from "../../../../../shared/room-typing.mjs";
import { roomTyping } from "../../../server/room-typing.js";
import { waitForMessageRouting } from "./wait-for-routing.js";
import { replyTurnHoldAgentKey } from "./activation-identity.js";
import type { Express, Response } from "express";
import {
  ROOM_RESOURCE_INVALIDATION_CAPABILITY,
} from "../../../../../shared/room-resource-invalidation.mjs";
import { ROOM_JOIN_REQUEST_EVENT } from "../../../../../shared/room-join-requests.mjs";
import { getRoomMemberRole } from "../../../db/room-members.js";
import { roomJoinRequestStreamPayload } from "../../../rooms/join-request-events.js";
import {
  ROOM_MEMBER_ROLE_CHANGED,
  readRoomMemberRoleChanged,
  roomMemberRoleEvents,
} from "../../../rooms/membership-events.js";
import {
  openSseConnection,
  type SseConnection,
} from "../../../http/sse.js";
import { getMessageStreamCheckpoint } from "../../../db.js";
import { InvalidRoomAgentDeliverySessionError } from "../../../rooms/agent-delivery.js";
import { isAppSession } from "../../../request/app-session.js";
import { toPublicGitHubRoomEvent } from "../events.js";
import {
  rentalActivityPayload,
  rentalActivityStreamNames,
} from "./rental-stream-events.js";
import { resolveParticipantRoom } from "./helpers.js";
import type { RoomMessageHandlerDeps, RoomMessageRouteDeps } from "./types.js";
import type { RoomEvent, RoomEventEnvelope } from "../../../server/room-event-broker.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { createBoundedExecutor } from "../../../bounded-async.js";
import {
  getProjectAccessRoomId,
  isRepoBackedProject,
  resolveRequestProjectRepoAccessRoomName,
} from "../../../rooms/access.js";
import type { Message, Project } from "../../../db.js";
import {
  openLiveRoomDeliveryController,
  roomSyncSseFrame,
  subscribeVisibleRoomEvents,
  type LiveRoomDeliveryController,
} from "./live-controller.js";
import {
  hydrateLiveMessageForSubscriber,
  resolveLiveMessageOverlayTarget,
} from "./live-message-delivery.js";

const runStreamCheckpoint = createBoundedExecutor({
  label: "room stream checkpoint",
  maxConcurrent: 32,
  maxQueued: 256,
  timeoutMs: 8_000,
});

const MAX_STREAM_CAPABILITY_VALUES = 16;
const MAX_STREAM_CAPABILITY_BYTES = 512;

/**
 * The SSE frame of a reasoning change. A live session (an agent's turn, shared
 * by its owner) has its own event names, so clients that read reasoning
 * sessions, older ones included, never receive one.
 */
export function reasoningStreamFrame(
  projectId: string,
  event: Extract<RoomEvent, { kind: "reasoning_updated" | "reasoning_removed" }>,
): { name: string; data: Record<string, unknown> } {
  if (event.kind === "reasoning_removed") {
    return {
      name: event.sessionKind === "live" ? "live_activity_remove" : "reasoning_remove",
      data: { room_id: projectId, session_id: event.sessionId },
    };
  }
  if (event.session.kind === "live") {
    return { name: "live_activity_update", data: { room_id: projectId, session: event.session } };
  }
  return { name: "reasoning_update", data: { room_id: projectId, session: event.session, update: event.update } };
}

/**
 * Whether this stream belongs to a room admin in the app. Join requests name
 * the person who asked, so only such a stream receives them. An agent, an
 * owner token (the MCP client) and a repo room never do.
 */
export async function resolveRoomStreamAdmin(req: AuthenticatedRequest, project: Project): Promise<boolean> {
  if (!isAppSession(req) || !req.sessionAccount || isRepoBackedProject(project)) return false;
  return (await getRoomMemberRole(getProjectAccessRoomId(project), req.sessionAccount.account_id)) === "admin";
}

function streamSupports(req: AuthenticatedRequest, capability: string): boolean {
  const raw = req.query?.stream_capability;
  const values = typeof raw === "string"
    ? [raw]
    : Array.isArray(raw) && raw.every((value) => typeof value === "string")
      ? raw
      : [];
  if (values.length === 0 || values.length > MAX_STREAM_CAPABILITY_VALUES) return false;
  let bytes = 0;
  for (const value of values) {
    bytes += Buffer.byteLength(value);
    if (
      bytes > MAX_STREAM_CAPABILITY_BYTES
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
    ) return false;
  }
  return values.includes(capability);
}

export function registerMessageStreamRoute(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.get(/^\/rooms\/(.+)\/messages\/stream$/, async (req: AuthenticatedRequest, res) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;
    await streamRoomMessages({ req, res, project, deps });
  });
}

/** The payload of a `room_sync` frame on the room stream. */
export interface RoomSyncFramePayload {
  room_id: string;
  checkpoint: string | null;
  requested_cursor?: string | null;
  event_cursor: string | null;
  gap: boolean;
}

/** How a stream route shapes the JSON of the frames whose payload names the room. */
export interface RoomMessageStreamFrames {
  roomSync(payload: RoomSyncFramePayload): Record<string, unknown>;
  message(message: Message, roomId: string, routed: boolean): Record<string, unknown>;
  sessionDisconnect(roomId: string): Record<string, unknown>;
}

export const ROOM_MESSAGE_STREAM_FRAMES: RoomMessageStreamFrames = {
  roomSync: (payload) => ({ ...payload }),
  message: (message, roomId, routed) => ({
    ...message,
    room_id: roomId,
    // Marks a re-published message whose routing changed after commit
    // so clients can pass their by-id replay dedupe for it.
    ...(routed ? { routing_pass: 2 } : {}),
  }),
  sessionDisconnect: (roomId) => ({ room_id: roomId }),
};

/**
 * The SSE stream of one resolved room the caller participates in. The
 * subscription starts before the checkpoint read, so no event between the
 * snapshot and the stream is lost. `messageOnly` streams only message
 * events (no tasks, reasoning, typing or join requests).
 */
export async function streamRoomMessages(input: {
  req: AuthenticatedRequest;
  res: Response;
  project: Project;
  deps: RoomMessageHandlerDeps;
  messageOnly?: boolean;
  frames?: RoomMessageStreamFrames;
  logLabel?: string;
}): Promise<void> {
  const { req, res, project, deps } = input;
  const messageOnly = input.messageOnly === true;
  const frames = input.frames ?? ROOM_MESSAGE_STREAM_FRAMES;
  const logLabel = input.logLabel ?? "room messages stream";
  const projectId = project.id;
  const supportsResourceInvalidation = streamSupports(req, ROOM_RESOURCE_INVALIDATION_CAPABILITY);
  const accessRoomName = await (
    deps.resolveRequestProjectRepoAccessRoomName ?? resolveRequestProjectRepoAccessRoomName
  )(req, project);
  // Join requests are for the room's admins only. The role is read once here
  // and updated live when an admin changes it; a failed read means "not admin".
  // The listener is installed before the read, so a change that lands while
  // the read is in flight wins over the read.
  let roomAdmin = false;
  let roleFromEvent: boolean | null = null;
  let stopRoleUpdates = () => {};
  if (!messageOnly && isAppSession(req) && req.sessionAccount && !isRepoBackedProject(project)) {
    const accessRoomId = getProjectAccessRoomId(project).trim().toLowerCase();
    const accountId = req.sessionAccount.account_id;
    const onRoleChanged = (payload: unknown) => {
      const change = readRoomMemberRoleChanged(payload);
      if (change && change.roomId === accessRoomId && change.accountId === accountId) {
        roleFromEvent = change.role === "admin";
        roomAdmin = roleFromEvent;
      }
    };
    roomMemberRoleEvents.on(ROOM_MEMBER_ROLE_CHANGED, onRoleChanged);
    stopRoleUpdates = () => { roomMemberRoleEvents.off(ROOM_MEMBER_ROLE_CHANGED, onRoleChanged); };
  }
  if (!messageOnly) {
    try {
      const fromRead = await (deps.resolveRoomStreamAdmin ?? resolveRoomStreamAdmin)(req, project);
      roomAdmin = roleFromEvent ?? fromRead;
    } catch (error) {
      console.warn(`[${logLabel}] admin check failed for ${projectId}`, error);
    }
  }
  let connection: SseConnection | null = null;
  let streamClosed = false;
  let live: LiveRoomDeliveryController | null = null;
  try {
    live = await openLiveRoomDeliveryController({
      req,
      project,
      accessRoomName,
      transport: "sse",
      trackDelivery: !isAppSession(req),
      onSessionDisconnected: () => {
        streamClosed = true;
        void connection?.write(`event: session_disconnect\ndata: ${JSON.stringify(frames.sessionDisconnect(projectId))}\n\n`)
          .finally(() => connection?.close());
      },
      onAuthorizationDenied: () => connection?.close(),
      reauthorize: deps.reauthorizeGitRoomParticipant,
      beginDelivery: deps.beginRoomAgentDelivery,
    });
  } catch (error) {
      stopRoleUpdates();
      if (error instanceof InvalidRoomAgentDeliverySessionError) {
        res.status(401).json({ error: error.message });
        return;
      }
      throw error;
  }
  if (!live) {
    stopRoleUpdates();
    return;
  }
  const liveController = live;
  liveController.activate();
  if (streamClosed) {
    stopRoleUpdates();
    await liveController.close();
    if (!res.headersSent) res.status(401).json({ error: "Agent delivery session is no longer active." });
    return;
  }

  connection = openSseConnection(req, res, `${logLabel} ${projectId}`);
  connection.addCleanup(stopRoleUpdates);
  const writeEvent = connection.write;
  const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
  const messageOverlayTarget = resolveLiveMessageOverlayTarget(
    req,
    liveController.activationIdentity,
  );
  const eventCursor = req.get?.("Last-Event-ID")
    || (typeof req.query?.event_cursor === "string" ? req.query.event_cursor : null);
  const subscription = subscribeVisibleRoomEvents({
    broker: deps.roomEventBroker,
    roomId: projectId,
    includePromptOnly,
    activationIdentity: liveController.activationIdentity,
    eventCursor,
    ...(messageOnly ? { messageOnly: true } : {}),
    messageOverlayTarget,
    ...(messageOnly ? {} : { roomAdmin: () => roomAdmin }),
  });

  connection.addCleanup(() => {
    streamClosed = true;
    subscription.close();
  });
  connection.addCleanup(() => liveController.close());
  if (!(await liveController.check())) {
    connection.close();
    return;
  }

  // The broker subscription is installed before the checkpoint is read. That
  // ordering closes the snapshot/subscribe race: anything committed while
  // this query is in flight is either represented by the checkpoint or is
  // already queued on this stream (duplicates are harmless client-side).
  const requestedCursor = typeof req.query?.after === "string" && /^msg_\d+$/.test(req.query.after)
    ? req.query.after
    : null;
  try {
    const { checkpoint, cursorExists } = await runStreamCheckpoint(
      () => (deps.getMessageStreamCheckpoint ?? getMessageStreamCheckpoint)(projectId, {
        requestedCursor,
        includePromptOnly,
        waitForRouting: liveController.activationIdentity?.session_kind === "worker",
        holdAgentKey: replyTurnHoldAgentKey(liveController.activationIdentity),
      }),
    );
    await writeEvent(roomSyncSseFrame(frames.roomSync({
      room_id: projectId,
      checkpoint,
      requested_cursor: requestedCursor,
      event_cursor: subscription.checkpointCursor,
      gap: subscription.checkpointGap || Boolean(requestedCursor && !cursorExists),
    })));
  } catch (error) {
    console.error(`[${logLabel}] failed to establish checkpoint for ${projectId}`, error);
    await writeEvent(roomSyncSseFrame(frames.roomSync({
      room_id: projectId,
      checkpoint: null,
      requested_cursor: requestedCursor,
      event_cursor: subscription.checkpointCursor,
      gap: true,
    })));
  }

  if (!messageOnly && isAppSession(req) && !project.focus_key?.startsWith("rental:") && streamSupports(req, ROOM_TYPING)) {
    let checking = false;
    connection.addCleanup(roomTyping.subscribe(projectId, req.sessionAccount!.account_id, (signal) => {
      if (checking || streamClosed || res.writableNeedDrain || res.writableLength > 0) return;
      checking = true;
      void liveController.check().then((allowed) => {
        if (allowed && signal.expires_at > Date.now()) connection?.tryWrite(`event: ${ROOM_TYPING}\ndata: ${JSON.stringify(signal)}\n\n`);
      }).catch(() => { /* A failed hint never closes message delivery. */ }).finally(() => { checking = false; });
    }));
  }

  void pumpRoomEvents().catch((error: unknown) => {
    console.error(`[${logLabel}] failed to deliver event for ${projectId}`, error);
    if (!streamClosed) connection?.close();
  });

  async function pumpRoomEvents(): Promise<void> {
    while (!streamClosed) {
      const delivery = await subscription.next();
      if (!delivery) {
        connection?.close();
        return;
      }
      if (streamClosed) return;
      if (!(await liveController.check())) {
        connection?.close();
        return;
      }
      if (delivery.type === "gap") {
        await writeEvent(roomSyncSseFrame(frames.roomSync({
          room_id: projectId,
          checkpoint: null,
          requested_cursor: requestedCursor,
          event_cursor: delivery.cursor,
          gap: true,
        })));
        continue;
      }
      await writeRoomEvent(delivery.envelope);
    }
  }

  async function writeRoomEvent(envelope: RoomEventEnvelope): Promise<void> {
    const eventId = `id: ${envelope.cursor}\n`;
    const event = envelope.event;
    switch (event.kind) {
      case "message_created":
      case "message_routed": {
        try {
          // Hold the frame (and its event cursor) until all preceding routing
          // decisions commit. This also preserves later queued frames and
          // reconnect replay without a second delivery acknowledgment.
          if (liveController.activationIdentity?.session_kind === "worker" && !await waitForMessageRouting({
            roomId: projectId, messageId: event.message.id, includePromptOnly,
            holdAgentKey: replyTurnHoldAgentKey(liveController.activationIdentity),
            closed: () => streamClosed, load: deps.getMessageStreamCheckpoint,
          })) return;
          // Let every listener enter the shared per-event overlay batch.
          // A per-connection executor here would reject listeners before
          // their work can coalesce into the one bounded database plan.
          const deliveryMessage = await hydrateLiveMessageForSubscriber({
            roomId: projectId,
            message: event.message,
            identity: liveController.activationIdentity,
            target: messageOverlayTarget,
            broker: deps.roomEventBroker,
            batcher: deps.roomMessageOverlayBatcher,
          });
          if (streamClosed) return;
          if (!(await liveController.check())) {
            connection?.close();
            return;
          }
          await writeEvent(`${eventId}data: ${JSON.stringify(
            frames.message(deliveryMessage, projectId, event.kind === "message_routed"),
          )}\n\n`);
        } catch (error) {
          console.error(`[${logLabel}] failed to hydrate message for ${projectId}`, error);
          if (!streamClosed) {
            // Never fall back to the shared canonical body after a
            // recipient/account overlay failed. Ask the client to repair
            // through its authorized read path instead.
            await writeEvent(roomSyncSseFrame(frames.roomSync({
              room_id: projectId,
              checkpoint: null,
              event_cursor: envelope.cursor,
              gap: true,
            })));
            streamClosed = true;
            connection?.close();
          }
        }
        return;
      }
      case "task_updated":
        await writeEvent(`${eventId}event: task_update\ndata: ${JSON.stringify({ ...event.task, room_id: projectId })}\n\n`);
        return;
      case "task_removed":
        await writeEvent(`${eventId}event: task_remove\ndata: ${JSON.stringify({ task_id: event.taskId, room_id: projectId })}\n\n`);
        return;
      case "github_event_updated":
        await writeEvent(`${eventId}event: github_event\ndata: ${JSON.stringify({
          ...toPublicGitHubRoomEvent(event.event),
          room_id: projectId,
        })}\n\n`);
        return;
      case "reasoning_updated":
      case "reasoning_removed": {
        const frame = reasoningStreamFrame(projectId, event);
        await writeEvent(`${eventId}event: ${frame.name}\ndata: ${JSON.stringify(frame.data)}\n\n`);
        return;
      }
      case "artifact_updated":
        await writeEvent(`${eventId}event: artifact_update\ndata: ${JSON.stringify({
          room_id: projectId,
          artifact_identity_key: event.artifact?.identity_key ?? null,
        })}\n\n`);
        return;
      case "message_info_updated":
        await writeEvent(`${eventId}event: message_info_updated\ndata: ${JSON.stringify({
          room_id: projectId,
          message_ids: event.messageIds,
        })}\n\n`);
        return;
      case "join_request_changed":
        // Only an admin's subscription accepted this event (see subscribeVisibleRoomEvents).
        await writeEvent(`${eventId}event: ${ROOM_JOIN_REQUEST_EVENT}\ndata: ${JSON.stringify(
          roomJoinRequestStreamPayload(projectId, event),
        )}\n\n`);
        return;
      case "resource_invalidated": {
        const resource = event.resource;
        if (supportsResourceInvalidation) {
          await writeEvent(`${eventId}event: ${ROOM_RESOURCE_INVALIDATION_CAPABILITY}\ndata: ${JSON.stringify({
            room_id: projectId,
            resource,
          })}\n\n`);
        } else {
          // Preserve the broker cursor for older clients without exposing an
          // event name they do not understand. A gap:false room_sync is an
          // existing cursor-only no-op for both web and Desktop clients.
          await writeEvent(`${eventId}${roomSyncSseFrame({
            room_id: projectId,
            checkpoint: null,
            event_cursor: envelope.cursor,
            gap: false,
          })}`);
        }
        return;
      }
      case "rental_activity_created": {
        if (event.activity.visibility !== "rental_visible") return;
        const payload = rentalActivityPayload(projectId, event.activity);
        const streamNames = rentalActivityStreamNames(event.activity);
        for (const [index, streamName] of streamNames.entries()) {
          const cursorLine = index === streamNames.length - 1 ? eventId : "";
          await writeEvent(`${cursorLine}event: ${streamName}\ndata: ${JSON.stringify(payload)}\n\n`);
        }
      }
    }
  }
}
