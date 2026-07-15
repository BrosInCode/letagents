import type { DesktopRoomInfo } from "../../../electron/ipc-types";

function normalizeRoomIdentifier(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

/**
 * A focus room belongs to its parent project unless it explicitly supplies a
 * different Git context of its own. Keep that durable parent context available
 * to local agent launch instead of making the user choose the same project
 * again after entering the focus room.
 */
export function roomWithInheritedProjectContext(
  room: DesktopRoomInfo,
  parentRoom: DesktopRoomInfo | null | undefined,
  isListedChild = false,
): DesktopRoomInfo {
  if (room.kind !== "focus" || room.gitRoom || !parentRoom?.gitRoom) return room;
  const parentIdentifier = normalizeRoomIdentifier(parentRoom.identifier);
  const declaredParent = normalizeRoomIdentifier(room.parentRoomId);
  if (!isListedChild && (!declaredParent || declaredParent !== parentIdentifier)) return room;
  return {
    ...room,
    gitRoom: parentRoom.gitRoom,
  };
}
