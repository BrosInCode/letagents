import { createBridgedEmitter } from "../server/bridged-emitter.js";

/**
 * A person lost membership of a room. Every API instance closes that person's
 * live streams in the room and its focus rooms at once, instead of at the next
 * periodic recheck. Payload: `{ roomId, login }`, both lowercase.
 */
export const roomMembershipInvalidationEvents = createBridgedEmitter("room_membership");

export function announceRoomMembershipEnded(roomId: string, login: string): void {
  roomMembershipInvalidationEvents.emit("invalidate", {
    roomId: roomId.trim().toLowerCase(),
    login: login.trim().toLowerCase(),
  });
}
