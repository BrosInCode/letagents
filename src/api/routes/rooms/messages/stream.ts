import type { Express } from "express";
import { ROOM_RESOURCE_INVALIDATION_CAPABILITY } from "../../../../../shared/room-resource-invalidation.mjs";
import {
  openSseConnection,
  type SseConnection,
} from "../../../http/sse.js";
import { getMessageStreamCheckpoint } from "../../../db.js";
import { InvalidRoomAgentDeliverySessionError } from "../../../rooms/agent-delivery.js";
import { isDesktopHumanClient } from "./request-identity.js";
import { toPublicGitHubRoomEvent } from "../events.js";
import {
  rentalActivityPayload,
  rentalActivityStreamNames,
} from "./rental-stream-events.js";
import { resolveParticipantRoom } from "./helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";
import type { RoomEvent, RoomEventEnvelope } from "../../../server/room-event-broker.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { createBoundedExecutor } from "../../../bounded-async.js";
import {
  resolveRequestProjectRepoAccessRoomName,
} from "../../../rooms/access.js";
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

function streamSupportsResourceInvalidation(req: AuthenticatedRequest): boolean {
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
  return values.includes(ROOM_RESOURCE_INVALIDATION_CAPABILITY);
}

export function registerMessageStreamRoute(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.get(/^\/rooms\/(.+)\/messages\/stream$/, async (req: AuthenticatedRequest, res) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const projectId = project.id;
    const supportsResourceInvalidation = streamSupportsResourceInvalidation(req);
    const accessRoomName = await (
      deps.resolveRequestProjectRepoAccessRoomName ?? resolveRequestProjectRepoAccessRoomName
    )(req, project);
    let connection: SseConnection | null = null;
    let streamClosed = false;
    let live: LiveRoomDeliveryController | null = null;
    try {
      live = await openLiveRoomDeliveryController({
        req,
        project,
        accessRoomName,
        transport: "sse",
        trackDelivery: !isDesktopHumanClient(req),
        onSessionDisconnected: () => {
          streamClosed = true;
          void connection?.write(`event: session_disconnect\ndata: ${JSON.stringify({ room_id: projectId })}\n\n`)
            .finally(() => connection?.close());
        },
        onAuthorizationDenied: () => connection?.close(),
        reauthorize: deps.reauthorizeGitRoomParticipant,
        beginDelivery: deps.beginRoomAgentDelivery,
      });
    } catch (error) {
        if (error instanceof InvalidRoomAgentDeliverySessionError) {
          res.status(401).json({ error: error.message });
          return;
        }
        throw error;
    }
    if (!live) return;
    const liveController = live;
    liveController.activate();
    if (streamClosed) {
      await liveController.close();
      if (!res.headersSent) res.status(401).json({ error: "Agent delivery session is no longer active." });
      return;
    }

    connection = openSseConnection(req, res, `room messages stream ${projectId}`);
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
      messageOverlayTarget,
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
        }),
      );
      await writeEvent(roomSyncSseFrame({
        room_id: projectId,
        checkpoint,
        requested_cursor: requestedCursor,
        event_cursor: subscription.checkpointCursor,
        gap: subscription.checkpointGap || Boolean(requestedCursor && !cursorExists),
      }));
    } catch (error) {
      console.error(`[room messages stream] failed to establish checkpoint for ${projectId}`, error);
      await writeEvent(roomSyncSseFrame({
        room_id: projectId,
        checkpoint: null,
        requested_cursor: requestedCursor,
        event_cursor: subscription.checkpointCursor,
        gap: true,
      }));
    }

    void pumpRoomEvents().catch((error: unknown) => {
      console.error(`[room messages stream] failed to deliver event for ${projectId}`, error);
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
          await writeEvent(roomSyncSseFrame({
            room_id: projectId,
            checkpoint: null,
            requested_cursor: requestedCursor,
            event_cursor: delivery.cursor,
            gap: true,
          }));
          continue;
        }
        await writeRoomEvent(delivery.envelope);
      }
    }

    async function writeRoomEvent(envelope: RoomEventEnvelope): Promise<void> {
      const eventId = `id: ${envelope.cursor}\n`;
      const event = envelope.event;
      switch (event.kind) {
        case "message_created": {
          try {
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
            await writeEvent(`${eventId}data: ${JSON.stringify({
              ...deliveryMessage,
              room_id: projectId,
            })}\n\n`);
          } catch (error) {
            console.error(`[room messages stream] failed to hydrate message for ${projectId}`, error);
            if (!streamClosed) {
              // Never fall back to the shared canonical body after a
              // recipient/account overlay failed. Ask the client to repair
              // through its authorized read path instead.
              await writeEvent(roomSyncSseFrame({
                room_id: projectId,
                checkpoint: null,
                event_cursor: envelope.cursor,
                gap: true,
              }));
              streamClosed = true;
              connection?.close();
            }
          }
          return;
        }
        case "task_updated":
          await writeEvent(`${eventId}event: task_update\ndata: ${JSON.stringify({ ...event.task, room_id: projectId })}\n\n`);
          return;
        case "github_event_updated":
          await writeEvent(`${eventId}event: github_event\ndata: ${JSON.stringify({
            ...toPublicGitHubRoomEvent(event.event),
            room_id: projectId,
          })}\n\n`);
          return;
        case "reasoning_updated":
          await writeEvent(`${eventId}event: reasoning_update\ndata: ${JSON.stringify({
            room_id: projectId,
            session: event.session,
            update: event.update,
          })}\n\n`);
          return;
        case "reasoning_removed":
          await writeEvent(`${eventId}event: reasoning_remove\ndata: ${JSON.stringify({
            room_id: projectId,
            session_id: event.sessionId,
          })}\n\n`);
          return;
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
        case "agent_work_invalidated":
          if (supportsResourceInvalidation) {
            await writeEvent(`${eventId}event: ${ROOM_RESOURCE_INVALIDATION_CAPABILITY}\ndata: ${JSON.stringify({
              room_id: projectId,
              resource: "agent_work",
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
  });
}
