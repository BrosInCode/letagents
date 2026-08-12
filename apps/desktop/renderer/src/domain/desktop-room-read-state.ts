import type {
  DesktopAccountRoomEntry,
  DesktopRoomLatestMessage,
} from "../../../electron/ipc-types";
import { normalizeRoomIdentifier } from "./sidebar-rooms";

export const noRoomMessageId = "__none__";

type StoredReadMarkerStorage = Pick<Storage, "getItem">;

export type RoomReadMarkers = Record<string, string>;

export function roomReadKey(roomIdentifier: string | null | undefined): string | null {
  return normalizeRoomIdentifier(roomIdentifier);
}

/**
 * Derive sidebar latest-message state from the `/account/rooms` payload that is
 * already in memory (top-level rooms AND their focus rooms), avoiding a
 * per-room `/rooms/:id/messages` fan-out on every sidebar refresh. Sidebar rooms
 * without an authoritative latest message in the account-rooms payload are
 * returned as `uncoveredRoomIdentifiers` so the caller can fall back to a direct
 * lookup for just those. Local-storage entries (`source === "local"`) are always
 * uncovered: the main process merges them into the payload with hardcoded null
 * latest fields because their latest message lives in the local DB.
 */
export function deriveSidebarLatestMessages(input: {
  accountRooms: readonly DesktopAccountRoomEntry[];
  sidebarRoomIdentifiers: readonly string[];
}): {
  latestMessages: Record<string, DesktopRoomLatestMessage>;
  uncoveredRoomIdentifiers: string[];
} {
  const accountRoomLatestByKey = new Map<string, DesktopRoomLatestMessage>();
  for (const accountRoom of input.accountRooms) {
    for (const room of [accountRoom, ...accountRoom.focusRooms]) {
      if (room.source === "local") continue;
      const key = roomReadKey(room.roomIdentifier);
      if (!key) continue;
      accountRoomLatestByKey.set(key, {
        roomIdentifier: room.roomIdentifier,
        latestMessageId: room.latestMessageId,
        latestMessageAt: room.latestMessageAt,
      });
    }
  }

  const latestMessages: Record<string, DesktopRoomLatestMessage> = {};
  const uncoveredRoomIdentifiers: string[] = [];
  for (const roomIdentifier of input.sidebarRoomIdentifiers) {
    const key = roomReadKey(roomIdentifier);
    if (!key) continue;
    const covered = accountRoomLatestByKey.get(key);
    if (covered) {
      latestMessages[key] = covered;
    } else {
      uncoveredRoomIdentifiers.push(roomIdentifier);
    }
  }

  return { latestMessages, uncoveredRoomIdentifiers };
}

export function hasUnreadRoomActivity(options: {
  activeRoomIdentifier: string | null | undefined;
  latestMessageId: string | null | undefined;
  readMarkers: RoomReadMarkers;
  roomIdentifier: string | null | undefined;
}): boolean {
  const key = roomReadKey(options.roomIdentifier);
  if (!key || !options.latestMessageId) return false;
  if (key === roomReadKey(options.activeRoomIdentifier)) return false;
  if (!hasReadMarker(options.readMarkers, key)) return false;
  return options.readMarkers[key] !== options.latestMessageId;
}

export function seedRoomReadMarker(
  readMarkers: RoomReadMarkers,
  roomIdentifier: string | null | undefined,
  latestMessageId: string | null | undefined,
): { changed: boolean; readMarkers: RoomReadMarkers } {
  const key = roomReadKey(roomIdentifier);
  if (!key || hasReadMarker(readMarkers, key)) {
    return { changed: false, readMarkers };
  }
  return {
    changed: true,
    readMarkers: {
      ...readMarkers,
      [key]: latestMessageId || noRoomMessageId,
    },
  };
}

export function markRoomRead(
  readMarkers: RoomReadMarkers,
  roomIdentifier: string | null | undefined,
  latestMessageId: string | null | undefined,
): { changed: boolean; readMarkers: RoomReadMarkers } {
  const key = roomReadKey(roomIdentifier);
  const marker = latestMessageId || noRoomMessageId;
  if (!key || readMarkers[key] === marker) {
    return { changed: false, readMarkers };
  }
  return {
    changed: true,
    readMarkers: {
      ...readMarkers,
      [key]: marker,
    },
  };
}

export function readStoredRoomMessageIds(
  storage: StoredReadMarkerStorage,
  storageKey: string,
): RoomReadMarkers {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] =>
          typeof entry[0] === "string"
          && typeof entry[1] === "string"
          && Boolean(entry[0].trim())
          && Boolean(entry[1].trim())
        )
        .map(([key, value]) => [key.trim().toLowerCase(), value.trim()])
    );
  } catch {
    return {};
  }
}

function hasReadMarker(readMarkers: RoomReadMarkers, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(readMarkers, key);
}
