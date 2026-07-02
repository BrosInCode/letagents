import type { Express } from "express";

import {
  startSseStream,
  stopSseStream,
} from "../../../http/sse.js";
import { hydrateMessageReplies, type Message } from "../../../db.js";
import { parseScopedId } from "../../../db/utils.js";
import {
  beginRoomAgentDelivery,
  InvalidRoomAgentDeliverySessionError,
} from "../../../rooms/agent-delivery.js";
import { attachAgentMessageActivation } from "../../../rooms/activation-routing.js";
import type { ResolvedRequestAgentIdentity } from "../../../request/agent-identity.js";
import {
  isPromptOnlyAgentMessage,
} from "../../../../shared/room-agent-prompts.js";
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
    let endDelivery: (() => Promise<void>) | null = null;
    let activationIdentity: ResolvedRequestAgentIdentity | null = null;
    if (!isDesktopHumanClient(req)) {
      try {
        const delivery = await beginRoomAgentDelivery({
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
    let streamClosed = false;
    let messageWriteQueue = Promise.resolve();

    const writeMessageCreated = async ({ projectId: eventProjectId, message }: MessageCreatedEvent) => {
      if (eventProjectId !== projectId) return;
      if (streamClosed) return;
      if (!deps.shouldIncludePromptOnlyMessages(req) && isPromptOnlyAgentMessage(message.text, message.agent_prompt_kind)) {
        return;
      }
      try {
        const streamMessage = await hydrateStreamMessage(project.id, message, req.sessionAccount?.account_id ?? null);
        if (streamClosed) return;
        res.write(`data: ${JSON.stringify({
          ...(activationIdentity ? attachAgentMessageActivation(streamMessage, activationIdentity) : streamMessage),
          room_id: project.id,
        })}\n\n`);
      } catch (error) {
        console.error(`[room messages stream] failed to hydrate message for ${project.id}`, error);
        if (streamClosed) return;
        res.write(`data: ${JSON.stringify({
          ...(activationIdentity ? attachAgentMessageActivation(message, activationIdentity) : message),
          room_id: project.id,
        })}\n\n`);
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
      res.write(`event: task_update\ndata: ${JSON.stringify({ ...event.task, room_id: project.id })}\n\n`);
    };

    const onGitHubEventUpdated = (event: GitHubRoomEventUpdatedEvent) => {
      if (event.projectId !== projectId) return;
      res.write(`event: github_event\ndata: ${JSON.stringify({
        ...toPublicGitHubRoomEvent(event.event),
        room_id: project.id,
      })}\n\n`);
    };

    const onReasoningUpdated = (event: ReasoningSessionUpdatedEvent) => {
      if (event.projectId !== projectId) return;
      res.write(
        `event: reasoning_update\ndata: ${JSON.stringify({
          room_id: project.id,
          session: event.session,
          update: event.update ?? null,
        })}\n\n`
      );
    };

    const onReasoningRemoved = (event: ReasoningSessionRemovedEvent) => {
      if (event.projectId !== projectId) return;
      res.write(`event: reasoning_remove\ndata: ${JSON.stringify({ room_id: project.id, session_id: event.session_id })}\n\n`);
    };

    const onArtifactUpdated = (event: RoomArtifactUpdatedEvent) => {
      if (event.projectId !== projectId) return;
      res.write(`event: artifact_update\ndata: ${JSON.stringify({
        room_id: project.id,
        artifact_identity_key: event.artifact?.identity_key ?? null,
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
        res.write(`event: ${streamName}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    };

    deps.messageEvents.on("message:created", onMessageCreated);
    deps.taskEvents.on("task:updated", onTaskUpdated);
    deps.githubRoomEvents?.on("github_event:updated", onGitHubEventUpdated);
    deps.reasoningEvents.on("reasoning:updated", onReasoningUpdated);
    deps.reasoningEvents.on("reasoning:removed", onReasoningRemoved);
    deps.artifactEvents?.on("artifact:updated", onArtifactUpdated);
    rentalEvents.on("activity:created", onRentalActivityCreated);

    req.on("close", () => {
      streamClosed = true;
      deps.messageEvents.off("message:created", onMessageCreated);
      deps.taskEvents.off("task:updated", onTaskUpdated);
      deps.githubRoomEvents?.off("github_event:updated", onGitHubEventUpdated);
      deps.artifactEvents?.off("artifact:updated", onArtifactUpdated);
      rentalEvents.off("activity:created", onRentalActivityCreated);
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
): Promise<Message> {
  if (!accountId) return message;
  const messageNumber = parseScopedId(message.id, "msg");
  if (!messageNumber) return message;
  const rootNumber = parseScopedId(message.thread_root_id, "msg");
  const replyToNumber = message.thread_reply_to_id
    ? parseScopedId(message.thread_reply_to_id, "msg")
    : null;
  const [hydrated] = await hydrateMessageReplies(roomId, [{
    room_id: roomId,
    number: messageNumber,
    reply_to_number: replyToNumber,
    thread_root_number: rootNumber && rootNumber !== messageNumber ? rootNumber : null,
    sender: message.sender,
    text: message.text,
    agent_prompt_kind: message.agent_prompt_kind,
    source: message.source,
    client_message_id: null,
    timestamp: message.timestamp,
  }], { accountId });
  return hydrated ?? message;
}
