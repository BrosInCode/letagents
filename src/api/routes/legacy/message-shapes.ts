// The legacy `/projects/:id/messages*` wire shapes. Released clients (the MCP
// package through 0.12.54, older desktops) read `project_id` where the room
// routes say `room_id`, and read bare message frames on the stream. Each
// function maps one modern body or frame to the legacy one; nothing else of
// the modern shape reaches a legacy caller.

import type { Message } from "../../db.js";
import type { CreatedRoomMessageBody } from "../rooms/messages/create-message.js";
import type { RoomMessageListResult, RoomMessagePollBody } from "../rooms/messages/history.js";
import type { RoomMessageStreamFrames } from "../rooms/messages/stream.js";

/** `GET /projects/:id/messages`: the room page keyed by `project_id`. */
export function toLegacyMessagePage(
  projectId: string,
  result: Extract<RoomMessageListResult, { kind: "page" }>,
): { project_id: string; messages: Message[]; has_more: boolean; has_older: boolean | undefined } {
  return {
    project_id: projectId,
    messages: result.messages,
    has_more: result.has_more,
    has_older: result.has_older,
  };
}

/** `GET /projects/:id/messages/poll`: `room_id` becomes `project_id`; the cursor field passes through. */
export function toLegacyPollBody(body: RoomMessagePollBody): {
  project_id: string;
  messages: Message[];
  has_more: boolean;
  last_observed_message_id?: string | null;
} {
  return {
    project_id: body.room_id,
    messages: body.messages,
    has_more: body.has_more,
    ...("last_observed_message_id" in body ? { last_observed_message_id: body.last_observed_message_id } : {}),
  };
}

/**
 * `POST /projects/:id/messages`: the created message itself, without
 * `room_id` and without the desktop's account routing envelope (which the
 * room route returns to a person's own app write).
 */
export function toLegacyCreatedMessageBody(
  body: CreatedRoomMessageBody,
): Omit<CreatedRoomMessageBody, "room_id" | "account_agent_routing"> {
  const { room_id: _roomId, account_agent_routing: _routing, ...message } = body;
  return message;
}

/** `GET /projects/:id/messages/stream` frames. */
export const LEGACY_PROJECT_STREAM_FRAMES: RoomMessageStreamFrames = {
  // The legacy room_sync names the room `project_id` and carries no checkpoint fields.
  roomSync: (payload) => ({
    project_id: payload.room_id,
    event_cursor: payload.event_cursor,
    gap: payload.gap,
  }),
  // A legacy message frame is the message alone: no `room_id`, no `routing_pass`.
  message: (message) => ({ ...message }),
  sessionDisconnect: (roomId) => ({ project_id: roomId }),
};
