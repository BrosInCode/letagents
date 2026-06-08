import { normalizeRoomIdentifier } from "./sidebar-rooms";

export const noRoomMessageId = "__none__";

type StoredReadMarkerStorage = Pick<Storage, "getItem">;

export type RoomReadMarkers = Record<string, string>;

export function roomReadKey(roomIdentifier: string | null | undefined): string | null {
  return normalizeRoomIdentifier(roomIdentifier);
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
