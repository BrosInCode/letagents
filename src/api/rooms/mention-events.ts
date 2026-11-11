import type { RoomMentionEvent } from "../../../shared/room-mention-events.mjs";
import { createBridgedEmitter } from "../server/bridged-emitter.js";

/**
 * Targeted `@<login>` mention notification published on the room event bridge
 * so `/account/activity/stream` can deliver `room_mention` frames to signed-in
 * desktop sessions even when the room is unopened (not in `account_room_recents`)
 * or archived.
 */
export interface RoomMentionCreatedEvent {
  projectId: string;
  roomDisplayName: string;
  messageId: string;
  threadRootId: string | null;
  targetAccountIds: readonly string[];
  publisherAccountId: string | null;
}

export const ROOM_MENTION_CREATED = "room_mention:created";

const MAX_ROOM_DISPLAY_NAME_LENGTH = 256;
const MAX_TARGET_ACCOUNTS = 50;

export const roomMentionEvents = createBridgedEmitter("room-mentions");
roomMentionEvents.setMaxListeners(0);
// Keep at least one local listener registered on every API pod so bridged
// inline notifications never report `unknown_notification_event` bridge loss
// when an instance currently has zero open `/account/activity/stream` clients.
roomMentionEvents.on(ROOM_MENTION_CREATED, () => undefined);

export function announceRoomMentionCreated(input: {
  projectId: string;
  roomDisplayName: string;
  messageId: string;
  threadRootId: string | null;
  targetAccountIds: readonly string[];
  publisherAccountId?: string | null;
}): void {
  const targets = [...new Set(input.targetAccountIds.filter((id) => typeof id === "string" && id.length > 0))]
    .slice(0, MAX_TARGET_ACCOUNTS);
  if (!input.projectId || !input.messageId || targets.length === 0) return;
  roomMentionEvents.emit(ROOM_MENTION_CREATED, {
    projectId: input.projectId,
    roomDisplayName: (input.roomDisplayName || "").slice(0, MAX_ROOM_DISPLAY_NAME_LENGTH),
    messageId: input.messageId,
    threadRootId: input.threadRootId || null,
    targetAccountIds: targets,
    publisherAccountId: input.publisherAccountId?.trim() || null,
  } satisfies RoomMentionCreatedEvent);
}

/** Reads a bridged `room_mention:created` payload; returns null for malformed payloads. */
export function readRoomMentionCreatedEvent(payload: unknown): RoomMentionCreatedEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const event = payload as Partial<RoomMentionCreatedEvent>;
  if (typeof event.projectId !== "string" || !event.projectId) return null;
  if (typeof event.messageId !== "string" || !event.messageId) return null;
  if (!Array.isArray(event.targetAccountIds) || event.targetAccountIds.length === 0) return null;
  const targetAccountIds = event.targetAccountIds.filter(
    (accountId): accountId is string => typeof accountId === "string" && accountId.length > 0,
  );
  if (targetAccountIds.length === 0) return null;
  return {
    projectId: event.projectId,
    roomDisplayName: typeof event.roomDisplayName === "string" ? event.roomDisplayName : "",
    messageId: event.messageId,
    threadRootId: typeof event.threadRootId === "string" && event.threadRootId ? event.threadRootId : null,
    targetAccountIds,
    publisherAccountId:
      typeof event.publisherAccountId === "string" && event.publisherAccountId ? event.publisherAccountId : null,
  };
}

/** Formats the SSE `room_mention` payload sent on `/account/activity/stream`. */
export function roomMentionStreamPayload(event: RoomMentionCreatedEvent): RoomMentionEvent {
  return {
    room_id: event.projectId,
    room_display_name: event.roomDisplayName,
    message_id: event.messageId,
    thread_root_id: event.threadRootId,
  };
}
