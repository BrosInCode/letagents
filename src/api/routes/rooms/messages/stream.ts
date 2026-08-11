import type { Express, Response } from "express";
import {
  createSseWriter,
  startSseStream,
  stopSseStream,
} from "../../../http/sse.js";
import { getLatestMessages, getMessageById, type Message } from "../../../db.js";
import {
  beginRoomAgentDelivery,
  InvalidRoomAgentDeliverySessionError,
} from "../../../rooms/agent-delivery.js";
import { messageInfoEvents, type MessageInfoUpdatedEvent } from "../../../server/message-info-events.js";
import { attachReceiptAuthorityActivations } from "./receipt-activation.js";
import type { ResolvedRequestAgentIdentity } from "../../../request/agent-identity.js";
import {
  isPromptOnlyAgentMessage,
} from "../../../../shared/room-agent-prompts.js";
import { parsePositivePgIntegerScopedId } from "../../../../shared/scoped-ids.js";
import {
  rentalActivityEvents,
  type RentalActivityCreatedEvent,
} from "../../../rental/activity-emitter.js";
import { isDesktopHumanClient } from "./request-identity.js";
import { toPublicGitHubRoomEvent } from "../events.js";
import {
  rentalActivityPayload,
  rentalActivityStreamNames,
} from "./rental-stream-events.js";
import { resolveParticipantRoom } from "./helpers.js";
import type {
  MessageCreatedEvent,
  GitHubRoomEventUpdatedEvent,
  ReasoningSessionRemovedEvent,
  ReasoningSessionUpdatedEvent,
  RoomArtifactUpdatedEvent,
  RoomMessageRouteDeps,
  TaskUpdatedEvent,
} from "./types.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";

export function registerMessageStreamRoute(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.get(/^\/rooms\/(.+)\/messages\/stream$/, async (req: AuthenticatedRequest, res) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const projectId = project.id;
    const desktopHumanClient = isDesktopHumanClient(req);
    const streamAccountId = req.sessionAccount?.account_id ?? null;
    let endDelivery: (() => Promise<void>) | null = null;
    let activationIdentity: ResolvedRequestAgentIdentity | null = null;
    if (!desktopHumanClient) {
      try {
        const delivery = await (deps.beginRoomAgentDelivery ?? beginRoomAgentDelivery)({
          req,
          roomId: project.id,
          transport: "sse",
          onSessionDisconnected: () => {
            res.write(`event: session_disconnect\ndata: ${JSON.stringify({ room_id: projectId })}\n\n`);
            res.end();
          },
        });
        endDelivery = delivery?.end ?? null;
        activationIdentity = delivery?.identity.session_kind === "worker" ? delivery.identity : null;
      } catch (error) {
        if (error instanceof InvalidRoomAgentDeliverySessionError) {
          res.status(401).json({ error: error.message });
          return;
        }
        throw error;
      }
    }

    const heartbeat = startSseStream(res);
    const writeEvent = createSseWriter(res, `room messages stream ${projectId}`);
    let streamClosed = false;
    let messageWriteQueue = Promise.resolve();

    const writeMessageCreated = async ({ projectId: eventProjectId, message }: MessageCreatedEvent) => {
      if (eventProjectId !== projectId) return;
      if (streamClosed) return;
      if (!deps.shouldIncludePromptOnlyMessages(req) && isPromptOnlyAgentMessage(message.text, message.agent_prompt_kind)) {
        return;
      }
      try {
        const streamMessage = await hydrateStreamMessage(
          project.id,
          message,
          streamAccountId,
          desktopHumanClient,
          deps.getMessageById ?? getMessageById,
        );
        if (streamClosed) return;
        const [attached] = await (deps.attachReceiptAuthorityActivations
          ?? attachReceiptAuthorityActivations)(project.id, activationIdentity, [streamMessage]);
        if (streamClosed) return;
        writeEvent(`data: ${JSON.stringify({
          ...(attached ?? streamMessage),
          room_id: project.id,
        })}\n\n`);
      } catch (error) {
        console.error(`[room messages stream] failed to hydrate message for ${project.id}`, error);
        if (streamClosed) return;
        // Neither worker nor desktop-human clients may advance past a message
        // whose receipt/account authority failed to hydrate. Close without a
        // message frame so the durable fallback rereads this exact cursor.
        streamClosed = true;
        writeEvent(`event: room_sync\ndata: ${JSON.stringify({
          room_id: project.id,
          checkpoint: null,
          requested_cursor: null,
          gap: true,
        })}\n\n`);
        res.end();
      }
    };

    const onMessageCreated = (event: MessageCreatedEvent) => {
      messageWriteQueue = messageWriteQueue
        .then(() => writeMessageCreated(event))
        .catch((error: unknown) => {
          console.error(`[room messages stream] failed to write message event for ${project.id}`, error);
        });
    };

    const onTaskUpdated = (event: TaskUpdatedEvent) => {
      if (event.projectId !== projectId) return;
      writeEvent(`event: task_update\ndata: ${JSON.stringify({ ...event.task, room_id: project.id })}\n\n`);
    };

    const onGitHubEventUpdated = (event: GitHubRoomEventUpdatedEvent) => {
      if (event.projectId !== projectId) return;
      writeEvent(`event: github_event\ndata: ${JSON.stringify({
        ...toPublicGitHubRoomEvent(event.event),
        room_id: project.id,
      })}\n\n`);
    };

    const onReasoningUpdated = (event: ReasoningSessionUpdatedEvent) => {
      if (event.projectId !== projectId) return;
      writeEvent(
        `event: reasoning_update\ndata: ${JSON.stringify({
          room_id: project.id,
          session: event.session,
          update: event.update ?? null,
        })}\n\n`
      );
    };

    const onReasoningRemoved = (event: ReasoningSessionRemovedEvent) => {
      if (event.projectId !== projectId) return;
      writeEvent(`event: reasoning_remove\ndata: ${JSON.stringify({ room_id: project.id, session_id: event.session_id })}\n\n`);
    };

    const onArtifactUpdated = (event: RoomArtifactUpdatedEvent) => {
      if (event.projectId !== projectId) return;
      writeEvent(`event: artifact_update\ndata: ${JSON.stringify({
        room_id: project.id,
        artifact_identity_key: event.artifact?.identity_key ?? null,
      })}\n\n`);
    };

    // Invalidation-only: carries ids (or null for room-level), never state.
    // Open Message info cards repair through the authoritative GET endpoint.
    const onMessageInfoUpdated = (event: MessageInfoUpdatedEvent) => {
      if (event.projectId !== projectId) return;
      writeEvent(`event: message_info_updated\ndata: ${JSON.stringify({
        room_id: project.id,
        message_ids: event.messageIds,
      })}\n\n`);
    };

    const rentalEvents = deps.rentalActivityEvents ?? rentalActivityEvents;
    const onRentalActivityCreated = (event: RentalActivityCreatedEvent) => {
      const activity = event.activity;
      if (activity.room_id !== projectId) return;
      // Generic room stream is not role-aware; only rental_visible events are safe here.
      if (activity.visibility !== "rental_visible") return;
      const payload = rentalActivityPayload(project.id, activity);
      for (const streamName of rentalActivityStreamNames(activity)) {
        writeEvent(`event: ${streamName}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    };

    deps.messageEvents.on("message:created", onMessageCreated);
    deps.taskEvents.on("task:updated", onTaskUpdated);
    deps.githubRoomEvents?.on("github_event:updated", onGitHubEventUpdated);
    deps.reasoningEvents.on("reasoning:updated", onReasoningUpdated);
    deps.reasoningEvents.on("reasoning:removed", onReasoningRemoved);
    deps.artifactEvents?.on("artifact:updated", onArtifactUpdated);
    rentalEvents.on("activity:created", onRentalActivityCreated);
    messageInfoEvents.on("message_info:updated", onMessageInfoUpdated);

    // The listeners above are installed before the checkpoint is read. That
    // ordering closes the snapshot/subscribe race: anything committed while
    // this query is in flight is either represented by the checkpoint or is
    // already queued on this stream (duplicates are harmless client-side).
    const requestedCursorNumber = parsePositivePgIntegerScopedId(req.query?.after, "msg");
    const requestedCursor = requestedCursorNumber === null ? null : `msg_${requestedCursorNumber}`;
    try {
      const latest = await getLatestMessages(projectId, {
        limit: 1,
        include_prompt_only: deps.shouldIncludePromptOnlyMessages(req),
      });
      const checkpoint = latest.messages[latest.messages.length - 1]?.id ?? null;
      const cursorExists = !requestedCursor || requestedCursor === checkpoint || Boolean(await getMessageById(
        projectId,
        requestedCursor,
        { include_prompt_only: deps.shouldIncludePromptOnlyMessages(req) },
      ));
      writeEvent(`event: room_sync\ndata: ${JSON.stringify({
        room_id: projectId,
        checkpoint,
        requested_cursor: requestedCursor,
        gap: Boolean(requestedCursor && !cursorExists),
      })}\n\n`);
    } catch (error) {
      console.error(`[room messages stream] failed to establish checkpoint for ${projectId}`, error);
      writeEvent(`event: room_sync\ndata: ${JSON.stringify({ room_id: projectId, checkpoint: null, requested_cursor: requestedCursor, gap: true })}\n\n`);
    }

    req.on("close", () => {
      streamClosed = true;
      deps.messageEvents.off("message:created", onMessageCreated);
      deps.taskEvents.off("task:updated", onTaskUpdated);
      deps.githubRoomEvents?.off("github_event:updated", onGitHubEventUpdated);
      deps.artifactEvents?.off("artifact:updated", onArtifactUpdated);
      rentalEvents.off("activity:created", onRentalActivityCreated);
      messageInfoEvents.off("message_info:updated", onMessageInfoUpdated);
      if (endDelivery) {
        void endDelivery().catch((error: unknown) => {
          console.error(`[room messages stream] failed to end agent delivery for ${project.id}`, error);
        });
      }
      deps.reasoningEvents.off("reasoning:updated", onReasoningUpdated);
      deps.reasoningEvents.off("reasoning:removed", onReasoningRemoved);
      stopSseStream(res, heartbeat);
    });
  });
}

async function hydrateStreamMessage(
  roomId: string,
  message: Message,
  accountId: string | null,
  accountAgentRouting: boolean,
  loadMessageById: typeof getMessageById,
): Promise<Message> {
  if (!accountId) return message;
  const hydrated = await loadMessageById(roomId, message.id, {
    include_prompt_only: true,
    account_id: accountId,
    account_agent_routing: accountAgentRouting,
  });
  if (!hydrated) {
    throw new Error(`Message ${message.id} disappeared before account routing could be hydrated.`);
  }
  return hydrated;
}
