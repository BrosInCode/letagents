import type {
  DesktopAccountActivityState,
  DesktopAccountRoomActivity,
  DesktopRoomLatestMessage,
} from "../../../electron/ipc-types";
import { roomReadKey } from "./desktop-room-read-state";
import type { SidebarRoomActivity } from "./sidebar-room-display";

/** The activity stream's rooms, keyed the way the sidebar keys rooms. */
export function indexAccountActivity(state: DesktopAccountActivityState): Map<string, DesktopAccountRoomActivity> {
  const index = new Map<string, DesktopAccountRoomActivity>();
  for (const room of Object.values(state.rooms)) {
    const key = roomReadKey(room.roomId);
    if (key) index.set(key, room);
  }
  return index;
}

export function sidebarActivityFor(
  index: ReadonlyMap<string, DesktopAccountRoomActivity>,
  roomIdentifier: string | null | undefined,
): SidebarRoomActivity | null {
  const key = roomReadKey(roomIdentifier);
  const room = key ? index.get(key) : undefined;
  return room?.working.length ? { working: room.working.map((agent) => ({ displayName: agent.displayName })) } : null;
}

function messageNumber(id: string | null | undefined): number {
  const match = /^msg_(\d+)$/.exec(id ?? "");
  return match ? Number(match[1]) : -1;
}

/**
 * The newer of two reports of a room's latest message. The stream is usually
 * ahead of the last room-list refresh, but a refresh can land after the stream
 * dropped, so neither source always wins.
 */
export function newerLatestMessage(
  a: DesktopRoomLatestMessage | null | undefined,
  b: DesktopRoomLatestMessage | null | undefined,
): DesktopRoomLatestMessage | null {
  if (!a?.latestMessageId) return b ?? a ?? null;
  if (!b?.latestMessageId) return a;
  return messageNumber(b.latestMessageId) > messageNumber(a.latestMessageId) ? b : a;
}

export function streamedLatestMessage(
  index: ReadonlyMap<string, DesktopAccountRoomActivity>,
  roomIdentifier: string | null | undefined,
): DesktopRoomLatestMessage | null {
  const key = roomReadKey(roomIdentifier);
  const room = key ? index.get(key) : undefined;
  if (!room || !room.latestMessageId) return null;
  return { roomIdentifier: room.roomId, latestMessageId: room.latestMessageId, latestMessageAt: room.latestMessageAt };
}

/** While the stream is open, the room list is refreshed only this often, for renamed or newly created rooms. */
export const ACCOUNT_ROOMS_REFRESH_WHILE_STREAMING_MS = 5 * 60_000;
