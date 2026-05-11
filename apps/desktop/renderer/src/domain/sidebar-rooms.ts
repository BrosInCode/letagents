import type {
  DesktopAccountRoomEntry,
  DesktopRoomSnapshot,
} from "../../../electron/ipc-types";
import type { ProjectGroup, RoomEntry } from "../components/desktop/types";

export type RecentRootRoom = {
  identifier: string;
  rootPath: string | null;
  displayName: string;
  meta: string;
  updatedAt: string;
};

export function normalizeRoomIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

export function rootPathLabel(rootPath: string | null | undefined): string | null {
  return rootPath?.split("/").filter(Boolean).pop() || null;
}

export function rootRoomEntryId(roomIdentifier: string | null | undefined): string {
  return `room:parent:${encodeURIComponent(normalizeRoomIdentifier(roomIdentifier) || "main")}`;
}

export function readStoredRecentRootRooms(storageKey: string): RecentRootRoom[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): RecentRootRoom | null => {
        if (!entry || typeof entry !== "object") return null;
        const identifier = typeof entry.identifier === "string" ? entry.identifier.trim() : "";
        if (!identifier) return null;
        const rootPath = typeof entry.rootPath === "string" && entry.rootPath.trim() ? entry.rootPath.trim() : null;
        const displayName = typeof entry.displayName === "string" && entry.displayName.trim()
          ? entry.displayName.trim()
          : identifier;
        const meta = typeof entry.meta === "string" && entry.meta.trim() ? entry.meta.trim() : "Room";
        const updatedAt = typeof entry.updatedAt === "string" && entry.updatedAt.trim()
          ? entry.updatedAt
          : new Date(0).toISOString();
        return { identifier, rootPath, displayName, meta, updatedAt };
      })
      .filter((entry): entry is RecentRootRoom => Boolean(entry))
      .slice(0, 12);
  } catch {
    return [];
  }
}

export function rememberRecentRootRooms(storageKey: string, rooms: RecentRootRoom[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(rooms.slice(0, 12)));
  } catch {
    // Local persistence should never block navigation.
  }
}

export function upsertRecentRootRoomSnapshot(input: {
  snapshot: DesktopRoomSnapshot;
  recentRootRooms: readonly RecentRootRoom[];
  rootPath?: string | null;
  meta?: string | null;
}): RecentRootRoom[] {
  const identifier = input.snapshot.room?.identifier || input.snapshot.roomIdentifier;
  if (!identifier?.trim()) return [...input.recentRootRooms];
  const normalizedIdentifier = normalizeRoomIdentifier(identifier);
  if (!normalizedIdentifier) return [...input.recentRootRooms];

  const rootPath = input.rootPath || null;
  const room: RecentRootRoom = {
    identifier,
    rootPath,
    displayName: input.snapshot.room?.displayName
      || input.snapshot.room?.name
      || input.snapshot.roomIdentifier
      || identifier,
    meta: input.meta || input.snapshot.room?.code || rootPathLabel(rootPath) || "Room",
    updatedAt: new Date().toISOString(),
  };

  return [
    room,
    ...input.recentRootRooms.filter((entry) =>
      normalizeRoomIdentifier(entry.identifier) !== normalizedIdentifier
    ),
  ].slice(0, 12);
}

export function buildSidebarProjectGroups(input: {
  currentParentRoom: RoomEntry;
  focusRooms: DesktopRoomSnapshot["focusRooms"];
  accountRooms: readonly DesktopAccountRoomEntry[];
  recentRootRooms: readonly RecentRootRoom[];
}): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  const groupsByRoom = new Map<string, ProjectGroup>();

  function upsertGroup(group: ProjectGroup): void {
    const identifier = normalizeRoomIdentifier(group.parent.roomIdentifier || group.parent.title);
    if (!identifier) return;
    const existing = groupsByRoom.get(identifier);
    if (!existing) {
      groupsByRoom.set(identifier, group);
      groups.push(group);
      return;
    }
    existing.focusRooms = mergeRoomEntries(existing.focusRooms, group.focusRooms);
  }

  upsertGroup({
    id: `project:${input.currentParentRoom.id}`,
    roomName: input.currentParentRoom.title,
    parent: input.currentParentRoom,
    focusRooms: input.focusRooms.map(desktopFocusRoomToEntry),
  });

  for (const accountRoom of input.accountRooms) {
    upsertGroup(accountRoomToGroup(accountRoom));
  }

  for (const recentRoom of input.recentRootRooms) {
    const parent = recentRootRoomToEntry(recentRoom);
    upsertGroup({
      id: `project:${parent.id}`,
      roomName: parent.title,
      parent,
      focusRooms: [],
    });
  }

  return groups;
}

function mergeRoomEntries(current: RoomEntry[], incoming: RoomEntry[]): RoomEntry[] {
  const entries = [...current];
  const seen = new Set(entries.map(roomEntryKey));
  for (const entry of incoming) {
    const key = roomEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

function roomEntryKey(entry: RoomEntry): string {
  return normalizeRoomIdentifier(entry.roomIdentifier || entry.title) || entry.id;
}

function desktopFocusRoomToEntry(focusRoom: DesktopRoomSnapshot["focusRooms"][number]): RoomEntry {
  return {
    id: `room:focus:${focusRoom.roomId}`,
    type: "room",
    kind: "focus",
    roomIdentifier: focusRoom.identifier,
    title: focusRoom.displayName,
    meta: focusRoom.code || focusRoom.sourceTaskId || "Focus room",
    sectionLabel: "Focus room",
    headline: "Focused work should stay close to the room it came from.",
    description:
      "A focus room gives one thread of work more space, without losing the connection back to the main room.",
  };
}

function accountRoomToGroup(room: DesktopAccountRoomEntry): ProjectGroup {
  const parent = accountRoomToEntry(room);
  return {
    id: `project:${parent.id}`,
    roomName: parent.title,
    parent,
    focusRooms: room.focusRooms.map(accountFocusRoomToEntry),
  };
}

function accountFocusRoomToEntry(room: DesktopAccountRoomEntry["focusRooms"][number]): RoomEntry {
  return {
    id: `room:focus:${room.roomIdentifier}`,
    type: "room",
    kind: "focus",
    roomIdentifier: room.roomIdentifier,
    title: room.displayName,
    meta: room.focusStatus === "concluded"
      ? "Concluded"
      : room.sourceTaskId || room.focusKey || "Focus room",
    sectionLabel: "Focus room",
    headline: "Focused work should stay close to the room it came from.",
    description:
      "A focus room gives one thread of work more space, without losing the connection back to the main room.",
  };
}

function recentRootRoomToEntry(room: RecentRootRoom): RoomEntry {
  return {
    id: rootRoomEntryId(room.identifier),
    type: "room",
    kind: "parent",
    roomIdentifier: room.identifier,
    title: room.displayName,
    meta: room.meta,
    sectionLabel: "Parent room",
    headline: "Return to this room.",
    description: "Recent project rooms stay available here after you open another room.",
  };
}

function accountRoomToEntry(room: DesktopAccountRoomEntry): RoomEntry {
  return {
    id: rootRoomEntryId(room.roomIdentifier),
    type: "room",
    kind: "parent",
    roomIdentifier: room.roomIdentifier,
    title: room.displayName,
    meta: accountRoomMeta(room),
    sectionLabel: "Account room",
    headline: "Open this room from your account history.",
    description: "Rooms from your account are available across devices, with focus rooms grouped underneath.",
  };
}

function accountRoomMeta(room: DesktopAccountRoomEntry): string {
  if (room.role === "admin") return "Admin";
  if (room.source === "join") return "Joined";
  if (room.source === "open_room") return "Opened";
  if (room.source === "create_invite") return "Created";
  if (room.source === "participant") return "Participant";
  if (room.source === "agent") return "Agent activity";
  if (room.source === "recent") return "Recent";
  if (room.source === "focus") return "Focus room";
  return "Account room";
}
