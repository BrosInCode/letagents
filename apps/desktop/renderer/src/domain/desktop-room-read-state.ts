import type {
  DesktopAccountRoomEntry,
  DesktopRoomMessage,
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
  localRoomIdentifiers?: readonly string[];
}): {
  latestMessages: Record<string, DesktopRoomLatestMessage>;
  uncoveredRoomIdentifiers: string[];
} {
  const localRooms = new Set(input.localRoomIdentifiers?.map(roomReadKey));
  const accountRoomLatestByKey = new Map<string, DesktopRoomLatestMessage>();
  for (const accountRoom of input.accountRooms) {
    for (const room of [accountRoom, ...accountRoom.focusRooms]) {
      if (room.source === "local" || localRooms.has(roomReadKey(room.roomIdentifier))) continue;
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

export function roomReadMarkerKey(roomIdentifier: string | null | undefined, mode: "cloud" | "local"): string | null {
  const key = roomReadKey(roomIdentifier);
  return key && mode === "local" ? `${key}::local-history` : key;
}

export function isRoomBeingRead(input: {
  hidden: boolean;
  focused: boolean;
  activeRoomIdentifier: string | null | undefined;
  snapshotRoomIdentifier: string | null | undefined;
}): boolean {
  const active = roomReadKey(input.activeRoomIdentifier);
  return !input.hidden && input.focused && Boolean(active)
    && active === roomReadKey(input.snapshotRoomIdentifier);
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
  if (!key || readMarkers[key] === marker || messageNumber(readMarkers[key]) > messageNumber(marker)) {
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

export interface RoomUnreadSnapshot {
  readMessageId: string;
  latestMessageId: string;
  count: number;
}

function messageNumber(id: string | null | undefined): number {
  if (id === noRoomMessageId) return 0;
  if (!id || !/^msg_[1-9]\d*$/.test(id)) return -1;
  const value = Number(id.slice(4));
  return Number.isSafeInteger(value) ? value : -1;
}

/** Count visible records, never ID differences (prompt-only messages leave gaps). */
export async function countUnreadRoomMessages(input: {
  readMessageId: string;
  latestMessageId: string;
  previous?: RoomUnreadSnapshot;
  ownSenderNames: readonly string[];
  loadPage(afterMessageId: string | null): Promise<{ messages: DesktopRoomMessage[]; hasMore: boolean }>;
  isCurrent(): boolean;
}): Promise<RoomUnreadSnapshot | null> {
  const readNumber = messageNumber(input.readMessageId);
  const latestNumber = messageNumber(input.latestMessageId);
  if (readNumber < 0 || latestNumber < 0) return null;
  const result = { readMessageId: input.readMessageId, latestMessageId: input.latestMessageId, count: 0 };
  if (latestNumber <= readNumber) return result;
  const previous = input.previous?.readMessageId === input.readMessageId
    && messageNumber(input.previous.latestMessageId) <= latestNumber ? input.previous : undefined;
  let cursor = previous?.latestMessageId || input.readMessageId;
  let cursorNumber = messageNumber(cursor);
  result.count = previous?.count || 0;
  const ownNames = new Set(input.ownSenderNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
  while (cursorNumber < latestNumber) {
    if (!input.isCurrent()) return null;
    const page = await input.loadPage(cursor === noRoomMessageId ? null : cursor);
    if (!input.isCurrent()) return null;
    let nextNumber = cursorNumber;
    const seen = new Set<string>();
    for (const message of page.messages) {
      const number = messageNumber(message.id);
      if (number <= cursorNumber || number > latestNumber || seen.has(message.id)) continue;
      seen.add(message.id);
      nextNumber = Math.max(nextNumber, number);
      const ownMessage = message.source === "browser" && ownNames.has(message.sender.trim().toLowerCase());
      const promptOnly = message.agentPromptKind === "auto" && !message.text.trim();
      if (!ownMessage && !promptOnly) result.count += 1;
    }
    if (!page.hasMore || page.messages.some((message) => messageNumber(message.id) >= latestNumber)) break;
    if (nextNumber <= cursorNumber) throw new Error("Unread message history did not advance.");
    cursorNumber = nextNumber;
    cursor = `msg_${cursorNumber}`;
  }
  return result;
}
