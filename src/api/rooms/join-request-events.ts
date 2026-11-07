import type { RoomJoinRequest } from "../../../shared/room-membership.mjs";
import { createBridgedEmitter } from "../server/bridged-emitter.js";

/**
 * Someone asked to join a members-only room, or the request was answered.
 * The event is published on the access room and on each of its focus rooms,
 * so an admin with any of them open hears it. Only admins may receive it: the
 * room stream and the account activity stream check the role before they
 * write the frame, because it names the person who asked.
 */
export interface RoomJoinRequestChangedEvent {
  /** The room the event is published on: the access room or one of its focus rooms. */
  projectId: string;
  /** The room whose admins decide: the parent of a focus room, else the room. */
  accessRoomId: string;
  roomDisplayName: string;
  request: RoomJoinRequest;
}

export const ROOM_JOIN_REQUEST_CHANGED = "join_request:changed";

export const roomJoinRequestEvents = createBridgedEmitter("room-join-requests");
// One listener per open account activity stream, plus the room event broker.
roomJoinRequestEvents.setMaxListeners(0);

export function announceRoomJoinRequestChanged(input: {
  accessRoomId: string;
  focusRoomIds: readonly string[];
  roomDisplayName: string;
  request: RoomJoinRequest;
}): void {
  for (const projectId of new Set([input.accessRoomId, ...input.focusRoomIds])) {
    roomJoinRequestEvents.emit(ROOM_JOIN_REQUEST_CHANGED, {
      projectId,
      accessRoomId: input.accessRoomId,
      roomDisplayName: input.roomDisplayName,
      request: input.request,
    } satisfies RoomJoinRequestChangedEvent);
  }
}

/** Reads a join-request event payload from the bridge; null for anything else. */
export function readRoomJoinRequestChangedEvent(payload: unknown): RoomJoinRequestChangedEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as Partial<RoomJoinRequestChangedEvent>;
  if (typeof event.projectId !== "string" || typeof event.accessRoomId !== "string") return null;
  if (!event.request || typeof event.request !== "object" || typeof event.request.id !== "string") return null;
  return {
    projectId: event.projectId,
    accessRoomId: event.accessRoomId,
    roomDisplayName: typeof event.roomDisplayName === "string" ? event.roomDisplayName : "",
    request: event.request,
  };
}

/** The `join_request` SSE payload, the same on the room stream and the account stream. */
export function roomJoinRequestStreamPayload(
  roomId: string,
  event: Pick<RoomJoinRequestChangedEvent, "accessRoomId" | "roomDisplayName" | "request">,
): Record<string, unknown> {
  return {
    room_id: roomId,
    access_room_id: event.accessRoomId,
    request: { ...event.request, room_display_name: event.roomDisplayName },
  };
}
