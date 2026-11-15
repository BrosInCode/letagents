import { parseRoomInvite, type RoomInvite, type RoomInviteEvent } from "../../../shared/room-invites.mjs";
import { createBridgedEmitter } from "../server/bridged-emitter.js";

/**
 * An invite was made, cancelled or used. Only its maker hears it, on the
 * account activity stream, so the pill above the composer follows the invite
 * on every device of the maker: a bot that joins clears it, a cancel on one
 * device ends it on the others.
 */
export interface RoomInviteChangedEvent {
  makerAccountId: string;
  invite: RoomInvite;
}

export const ROOM_INVITE_CHANGED = "room_invite:changed";

export const roomInviteEvents = createBridgedEmitter("room-invites");
// One listener per open account activity stream.
roomInviteEvents.setMaxListeners(0);
// Keep one local listener on every API pod, so a bridged event never reports
// an unknown event while a pod has no open account stream.
roomInviteEvents.on(ROOM_INVITE_CHANGED, () => undefined);

export function announceRoomInviteChanged(makerAccountId: string | null, invite: RoomInvite): void {
  if (!makerAccountId) return;
  roomInviteEvents.emit(ROOM_INVITE_CHANGED, { makerAccountId, invite } satisfies RoomInviteChangedEvent);
}

/** Reads an invite event payload from the bridge; null for anything else. */
export function readRoomInviteChangedEvent(payload: unknown): RoomInviteChangedEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const event = payload as Partial<RoomInviteChangedEvent>;
  if (typeof event.makerAccountId !== "string" || !event.makerAccountId) return null;
  const invite = parseRoomInvite(event.invite);
  return invite ? { makerAccountId: event.makerAccountId, invite } : null;
}

/** The `room_invite` SSE payload. */
export function roomInviteStreamPayload(event: RoomInviteChangedEvent): RoomInviteEvent {
  return { invite: event.invite };
}
