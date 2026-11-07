import type { DesktopAccountRoomJoinRequest, DesktopRoomInfo } from "../../../../../../electron/ipc-types";
import { normalizeRoomIdentifier } from "../../../../domain/sidebar-rooms";

/** The room whose admins decide for `room`: the parent of a focus room, else the room itself. */
export function joinRequestAccessRoom(room: Pick<DesktopRoomInfo, "identifier" | "kind" | "parentRoomId">): string | null {
  return normalizeRoomIdentifier(room.kind === "focus" ? room.parentRoomId : room.identifier);
}

/**
 * The requests the banner at the top of this room shows: the pending requests
 * of its access room that the person has not closed. Nothing for a person who
 * is not an admin, or for a room kept on this computer.
 */
export function joinRequestsForRoom(
  items: readonly DesktopAccountRoomJoinRequest[],
  room: Pick<DesktopRoomInfo, "identifier" | "kind" | "parentRoomId" | "role">,
  options: { localRoom: boolean; dismissed: ReadonlySet<string> },
): DesktopAccountRoomJoinRequest[] {
  if (room.role !== "admin" || options.localRoom) return [];
  const accessRoom = joinRequestAccessRoom(room);
  if (!accessRoom) return [];
  return items.filter((item) =>
    item.state === "pending"
    && normalizeRoomIdentifier(item.room_id) === accessRoom
    && !options.dismissed.has(item.id));
}
