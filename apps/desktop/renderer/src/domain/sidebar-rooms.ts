import type {
  DesktopAccountRoomEntry,
  DesktopGitRoomInfo,
  DesktopRoomSnapshot,
} from "../../../electron/ipc-types";
import type { ProjectGroup, RoomEntry } from "../components/desktop/types";

export type RecentRootRoom = {
  identifier: string;
  kind: RecentRootRoomKind;
  rootPath: string | null;
  displayName: string;
  meta: string;
  updatedAt: string;
};

export type RecentRootRoomKind = "project" | "room";

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
        const kind = entry.kind === "project" || entry.kind === "room"
          ? entry.kind
          : rootPath
            ? "project"
            : "room";
        const displayName = typeof entry.displayName === "string" && entry.displayName.trim()
          ? entry.displayName.trim()
          : identifier;
        const meta = typeof entry.meta === "string" && entry.meta.trim() ? entry.meta.trim() : "Room";
        const updatedAt = typeof entry.updatedAt === "string" && entry.updatedAt.trim()
          ? entry.updatedAt
          : new Date(0).toISOString();
        return { identifier, kind, rootPath, displayName, meta, updatedAt };
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
  aliasIdentifiers?: readonly (string | null | undefined)[];
  displayName?: string | null;
  kind?: RecentRootRoomKind | null;
  rootPath?: string | null;
  meta?: string | null;
}): RecentRootRoom[] {
  const identifier = input.snapshot.room?.identifier || input.snapshot.roomIdentifier;
  if (!identifier?.trim()) return [...input.recentRootRooms];
  const normalizedIdentifier = normalizeRoomIdentifier(identifier);
  if (!normalizedIdentifier) return [...input.recentRootRooms];
  const aliases = roomSnapshotAliases(input.snapshot);
  for (const alias of input.aliasIdentifiers || []) {
    const normalizedAlias = normalizeRoomIdentifier(alias);
    if (normalizedAlias) aliases.add(normalizedAlias);
  }

  const rootPath = input.rootPath || null;
  const kind = input.kind || (rootPath ? "project" : "room");
  const room: RecentRootRoom = {
    identifier,
    kind,
    rootPath,
    displayName: input.displayName
      || input.snapshot.room?.displayName
      || input.snapshot.room?.name
      || input.snapshot.roomIdentifier
      || identifier,
    meta: input.meta || input.snapshot.room?.code || rootPathLabel(rootPath) || "Room",
    updatedAt: new Date().toISOString(),
  };

  return [
    room,
    ...input.recentRootRooms.filter((entry) =>
      !aliases.has(normalizeRoomIdentifier(entry.identifier) || "")
    ),
  ].slice(0, 12);
}

export function resolveAccountRoomAliasIdentifier(
  roomIdentifier: string | null | undefined,
  accountRooms: readonly DesktopAccountRoomEntry[],
): string | null {
  const normalizedIdentifier = normalizeRoomIdentifier(roomIdentifier);
  if (!normalizedIdentifier) return null;

  const matches = accountRooms.filter((room) => {
    if (normalizeRoomIdentifier(room.roomIdentifier) === normalizedIdentifier) return false;
    return [
      room.displayName,
      room.name,
    ].some((alias) => normalizeRoomIdentifier(alias) === normalizedIdentifier);
  });
  const identifiers = new Set(
    matches
      .map((room) => room.roomIdentifier.trim())
      .filter(Boolean),
  );
  return identifiers.size === 1 ? [...identifiers][0] || null : null;
}

function roomSnapshotAliases(snapshot: DesktopRoomSnapshot): Set<string> {
  return new Set([
    snapshot.roomIdentifier,
    snapshot.access.roomIdentifier,
    snapshot.access.code,
    snapshot.room?.identifier,
    snapshot.room?.name,
    snapshot.room?.code,
  ]
    .map(normalizeRoomIdentifier)
    .filter((value): value is string => Boolean(value)));
}

export function buildSidebarProjectGroups(input: {
  currentParentRoom: RoomEntry;
  focusRooms: DesktopRoomSnapshot["focusRooms"];
  accountRooms: readonly DesktopAccountRoomEntry[];
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
    existing.parent = mergeRoomEntry(existing.parent, group.parent);
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

  return sortSidebarProjectGroups(groups);
}

function mergeRoomEntries(current: RoomEntry[], incoming: RoomEntry[]): RoomEntry[] {
  const entries = [...current];
  const entryIndexes = new Map(entries.map((entry, index) => [roomEntryKey(entry), index]));
  for (const entry of incoming) {
    const key = roomEntryKey(entry);
    const existingIndex = entryIndexes.get(key);
    if (existingIndex !== undefined) {
      entries[existingIndex] = mergeRoomEntry(entries[existingIndex], entry);
      continue;
    }
    entryIndexes.set(key, entries.length);
    entries.push(entry);
  }
  return entries;
}

function mergeRoomEntry(current: RoomEntry, incoming: RoomEntry): RoomEntry {
  return {
    ...current,
    latestMessageId: incoming.latestMessageId || current.latestMessageId,
    latestMessageAt: incoming.latestMessageAt || current.latestMessageAt,
    pinned: current.pinned || incoming.pinned,
  };
}

function roomEntryKey(entry: RoomEntry): string {
  return normalizeRoomIdentifier(entry.roomIdentifier || entry.title) || entry.id;
}

function desktopFocusRoomToEntry(focusRoom: DesktopRoomSnapshot["focusRooms"][number]): RoomEntry {
  const gitMeta = gitRoomSidebarMeta(focusRoom.gitRoom);
  return {
    id: `room:focus:${focusRoom.roomId}`,
    type: "room",
    kind: "focus",
    roomIdentifier: focusRoom.identifier,
    title: focusRoom.displayName,
    meta: gitMeta?.meta || focusRoom.code || focusRoom.sourceTaskId || "Focus room",
    sectionLabel: gitMeta ? "Git Room" : "Focus room",
    headline: gitMeta?.headline || "Focused work should stay close to the room it came from.",
    description: gitMeta?.description
      || "A focus room gives one thread of work more space, without losing the connection back to the main room.",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    source: "account",
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
  const gitMeta = gitRoomSidebarMeta(room.gitRoom);
  return {
    id: `room:focus:${room.roomIdentifier}`,
    type: "room",
    kind: "focus",
    roomIdentifier: room.roomIdentifier,
    title: room.displayName,
    meta: gitMeta?.meta || (room.focusStatus === "concluded"
      ? "Concluded"
      : room.sourceTaskId || room.focusKey || "Focus room"),
    sectionLabel: gitMeta ? "Git Room" : "Focus room",
    headline: gitMeta?.headline || "Focused work should stay close to the room it came from.",
    description: gitMeta?.description
      || "A focus room gives one thread of work more space, without losing the connection back to the main room.",
    latestMessageId: room.latestMessageId,
    latestMessageAt: room.latestMessageAt,
    hasUnread: false,
    pinned: false,
    source: "account",
  };
}

function accountRoomToEntry(room: DesktopAccountRoomEntry): RoomEntry {
  const gitMeta = gitRoomSidebarMeta(room.gitRoom);
  return {
    id: rootRoomEntryId(room.roomIdentifier),
    type: "room",
    kind: "parent",
    roomIdentifier: room.roomIdentifier,
    title: room.displayName,
    meta: gitMeta?.meta || accountRoomMeta(room),
    sectionLabel: gitMeta ? "Git Room" : "Account room",
    headline: gitMeta?.headline || "Open this room from your account history.",
    description: gitMeta?.description
      || "Rooms from your account are available across devices, with focus rooms grouped underneath.",
    latestMessageId: room.latestMessageId,
    latestMessageAt: room.latestMessageAt,
    hasUnread: false,
    pinned: room.pinned,
    source: "account",
  };
}

function sortSidebarProjectGroups(groups: ProjectGroup[]): ProjectGroup[] {
  return groups
    .map((group, index) => ({ group, index }))
    .sort((left, right) => {
      if (left.group.parent.pinned !== right.group.parent.pinned) {
        return left.group.parent.pinned ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ group }) => group);
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

function gitRoomSidebarMeta(gitRoom: DesktopGitRoomInfo | null): {
  meta: string;
  headline: string;
  description: string;
} | null {
  if (!gitRoom) return null;

  const refType = gitRoom.ref.type === "default_branch"
    ? "Default branch"
    : gitRoom.ref.type === "pull_request"
      ? "Pull request"
      : gitRoom.ref.type === "branch"
        ? "Branch"
        : "Tag";
  return {
    meta: `${refType} · ${gitRoomRefLabel(gitRoom)}`,
    headline: gitRoom.repository.fullName,
    description: gitRoom.accessMode === "private" ? "Private Git Room" : "Git Room",
  };
}

function gitRoomRefLabel(gitRoom: DesktopGitRoomInfo): string {
  const ref = gitRoom.ref;
  if (
    ref.name
    && ref.headRepository?.fullName
    && ref.headRepository.fullName !== gitRoom.repository.fullName
  ) {
    return `${ref.headRepository.owner}:${ref.name}`;
  }
  return ref.name || ref.defaultBranch || ref.type.replace("_", " ");
}
