import type { RoomEntry } from "../components/desktop/types";

export const SIDEBAR_PROJECT_ROOM_PREVIEW_LIMIT = 8;

type SidebarProjectRoomPreviewOptions = {
  rooms: RoomEntry[];
  activeEntryId: string;
  expanded: boolean;
  limit?: number;
};

export function previewSidebarProjectRooms({
  rooms,
  activeEntryId,
  expanded,
  limit = SIDEBAR_PROJECT_ROOM_PREVIEW_LIMIT,
}: SidebarProjectRoomPreviewOptions): RoomEntry[] {
  if (expanded || rooms.length <= limit) return rooms;
  const preview = rooms.slice(0, limit);
  const activeRoom = rooms.find((room) => room.id === activeEntryId);
  if (!activeRoom || preview.some((room) => room.id === activeRoom.id)) return preview;
  return [...preview.slice(0, Math.max(0, limit - 1)), activeRoom];
}
