import { createBridgedEmitter } from "../server/bridged-emitter.js";

/**
 * A person lost membership of a room. Every API instance closes that person's
 * live streams in the room and its focus rooms at once, instead of at the next
 * periodic recheck. Payload: `{ roomId, login }`, both lowercase.
 */
export const roomMembershipInvalidationEvents = createBridgedEmitter("room_membership");
// One listener per open account activity stream, plus the live leases.
roomMembershipInvalidationEvents.setMaxListeners(0);

export function announceRoomMembershipEnded(roomId: string, login: string): void {
  roomMembershipInvalidationEvents.emit("invalidate", {
    roomId: roomId.trim().toLowerCase(),
    login: login.trim().toLowerCase(),
  });
}

/**
 * A room admin made a member an admin, or an admin a member. An open room
 * stream of that person updates what it may show them (join requests are for
 * admins only) without reconnecting. Payload: `{ roomId, accountId, role }`.
 */
export const roomMemberRoleEvents = createBridgedEmitter("room_member_role");
roomMemberRoleEvents.setMaxListeners(0);

export const ROOM_MEMBER_ROLE_CHANGED = "changed";

export function announceRoomMemberRoleChanged(roomId: string, accountId: string, role: "admin" | "member"): void {
  roomMemberRoleEvents.emit(ROOM_MEMBER_ROLE_CHANGED, { roomId: roomId.trim().toLowerCase(), accountId, role });
}

export function readRoomMemberRoleChanged(payload: unknown): { roomId: string; accountId: string; role: "admin" | "member" } | null {
  const event = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (!event || typeof event.roomId !== "string" || typeof event.accountId !== "string") return null;
  if (event.role !== "admin" && event.role !== "member") return null;
  return { roomId: event.roomId, accountId: event.accountId, role: event.role };
}
