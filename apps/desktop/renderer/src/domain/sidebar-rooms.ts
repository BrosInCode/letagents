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
  if (accountRooms.some(
    (room) => normalizeRoomIdentifier(room.roomIdentifier) === normalizedIdentifier,
  )) return null;

  const matches = accountRooms.filter((room) => {
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
  const currentRoomIdentifier = normalizeRoomIdentifier(input.currentParentRoom.roomIdentifier);

  function upsertGroup(group: ProjectGroup): void {
    const identifiers = projectGroupLookupKeys(group);
    const existing = identifiers.map((identifier) => groupsByRoom.get(identifier)).find(Boolean);
    if (!existing) {
      for (const identifier of identifiers) {
        groupsByRoom.set(identifier, group);
      }
      groups.push(group);
      return;
    }
    existing.parent = mergeRoomEntry(existing.parent, group.parent);
    existing.roomName = existing.parent.title;
    existing.branchRooms = mergeRoomEntries(existing.branchRooms, group.branchRooms);
    existing.focusRooms = mergeRoomEntries(existing.focusRooms, group.focusRooms);
    for (const identifier of identifiers) {
      groupsByRoom.set(identifier, existing);
    }
  }

  upsertGroup({
    id: projectGroupIdForEntry(input.currentParentRoom),
    roomName: input.currentParentRoom.title,
    parent: input.currentParentRoom,
    branchRooms: gitRoomBranchChildFromCurrentEntry(input.currentParentRoom),
    focusRooms: input.focusRooms.map((focusRoom) =>
      desktopFocusRoomToEntry(focusRoom, input.currentParentRoom.roomIdentifier)
    ),
  });

  const groupedGitRooms = groupAccountGitRoomsByRepository(input.accountRooms);
  const groupedRoomIdentifiers = new Set<string>();
  for (const [repositoryKey, rooms] of groupedGitRooms) {
    upsertGroup(accountGitRoomToGroup({
      repositoryKey,
      rooms,
      currentRoomIdentifier,
    }));
    for (const room of rooms) {
      groupedRoomIdentifiers.add(room.roomIdentifier);
    }
  }

  for (const accountRoom of input.accountRooms) {
    if (groupedRoomIdentifiers.has(accountRoom.roomIdentifier)) continue;
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
  const preferIncomingDisplay = current.source === "current" && incoming.source === "account";
  const sameRoom = roomEntryKey(current) === roomEntryKey(incoming);
  if (!sameRoom) {
    const incomingSyntheticGitParent = Boolean(incoming.gitRoom && !incoming.roomIdentifier);
    const keepCurrentDefaultGitParent = incomingSyntheticGitParent && isDefaultGitRoom(current.gitRoom);
    const preferred = incoming.source === "account" && !keepCurrentDefaultGitParent
      ? incoming
      : current;
    return {
      ...preferred,
      ...mergedPinState(current, incoming),
      hasUnread: current.hasUnread || incoming.hasUnread,
      latestMessageId: incoming.latestMessageId || current.latestMessageId,
      latestMessageAt: incoming.latestMessageAt || current.latestMessageAt,
    };
  }
  return {
    ...current,
    title: preferIncomingDisplay ? incoming.title : current.title,
    meta: preferIncomingDisplay ? incoming.meta : current.meta,
    sectionLabel: preferIncomingDisplay ? incoming.sectionLabel : current.sectionLabel,
    headline: preferIncomingDisplay ? incoming.headline : current.headline,
    description: preferIncomingDisplay ? incoming.description : current.description,
    gitRoom: incoming.gitRoom ?? current.gitRoom ?? null,
    focusKey: incoming.focusKey ?? current.focusKey ?? null,
    parentRoomIdentifier: incoming.parentRoomIdentifier ?? current.parentRoomIdentifier ?? null,
    suggestedAction: incoming.suggestedAction ?? current.suggestedAction ?? null,
    currentWorkspace: sameRoom
      ? Boolean(current.currentWorkspace || incoming.currentWorkspace)
      : Boolean(incoming.currentWorkspace),
    latestMessageId: incoming.latestMessageId || current.latestMessageId,
    latestMessageAt: incoming.latestMessageAt || current.latestMessageAt,
    ...mergedPinState(current, incoming),
  };
}

function mergedPinState(
  current: RoomEntry,
  incoming: RoomEntry,
): Pick<RoomEntry, "pinned" | "pinTargetRoomIdentifier" | "pinnedAccountRoomIdentifiers"> {
  return {
    pinned: current.pinned || incoming.pinned,
    pinTargetRoomIdentifier: incoming.pinTargetRoomIdentifier ?? current.pinTargetRoomIdentifier ?? null,
    pinnedAccountRoomIdentifiers: [...new Set([
      ...(current.pinnedAccountRoomIdentifiers || []),
      ...(incoming.pinnedAccountRoomIdentifiers || []),
    ])],
  };
}

export type RoomPinMutation = { pinned: boolean; roomIdentifiers: string[] };

export function buildRoomPinMutation(entry: RoomEntry): RoomPinMutation | null {
  if (entry.pinned) {
    const roomIdentifiers = [...new Set(entry.pinnedAccountRoomIdentifiers || [])];
    return roomIdentifiers.length ? { pinned: false, roomIdentifiers } : null;
  }
  const target = entry.pinTargetRoomIdentifier || null;
  return target ? { pinned: true, roomIdentifiers: [target] } : null;
}

function roomEntryKey(entry: RoomEntry): string {
  return normalizeRoomIdentifier(entry.roomIdentifier || entry.title) || entry.id;
}

function projectGroupIdForEntry(entry: RoomEntry): string {
  const repositoryKey = gitRoomRepositoryKey(entry.gitRoom ?? null);
  return repositoryKey ? `project:git:${repositoryKey}` : `project:${entry.id}`;
}

function projectGroupLookupKeys(group: ProjectGroup): string[] {
  const gitRoom = group.parent.gitRoom ?? null;
  const repositoryKeys = gitRoomRepositoryKeys(gitRoom);
  if (repositoryKeys.length) {
    return repositoryKeys
      .map((key) => normalizeRoomIdentifier(`project:git:${key}`))
      .filter((key): key is string => Boolean(key));
  }
  const roomKey = normalizeRoomIdentifier(group.parent.roomIdentifier || group.parent.title);
  return roomKey ? [roomKey] : [];
}

function groupAccountGitRoomsByRepository(
  rooms: readonly DesktopAccountRoomEntry[],
): Map<string, DesktopAccountRoomEntry[]> {
  const groups = new Map<string, DesktopAccountRoomEntry[]>();
  for (const room of rooms) {
    const repositoryKey = gitRoomRepositoryKey(room.gitRoom);
    if (!repositoryKey) continue;
    const entries = groups.get(repositoryKey) || [];
    entries.push(room);
    groups.set(repositoryKey, entries);
  }
  return groups;
}

function gitRoomBranchChildFromCurrentEntry(entry: RoomEntry): RoomEntry[] {
  if (!entry.gitRoom || isDefaultGitRoom(entry.gitRoom)) return [];
  return [{
    ...entry,
    kind: "branch",
    title: gitRoomRefLabel(entry.gitRoom),
    meta: gitRefTypeLabel(entry.gitRoom),
    sectionLabel: "Branch room",
    suggestedAction: null,
    currentWorkspace: true,
  }];
}

function desktopFocusRoomToEntry(
  focusRoom: DesktopRoomSnapshot["focusRooms"][number],
  parentRoomIdentifier: string | null,
): RoomEntry {
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
    gitRoom: focusRoom.gitRoom,
    ...focusRoomLineage(focusRoom, parentRoomIdentifier),
    suggestedAction: gitMeta ? "Open branch room" : null,
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
    id: projectGroupIdForEntry(parent),
    roomName: parent.title,
    parent,
    branchRooms: [],
    focusRooms: room.focusRooms.map((focusRoom) =>
      accountFocusRoomToEntry(focusRoom, null, room.roomIdentifier)
    ),
  };
}

function accountGitRoomToGroup(input: {
  repositoryKey: string;
  rooms: DesktopAccountRoomEntry[];
  currentRoomIdentifier: string | null;
}): ProjectGroup {
  const sortedRooms = [...input.rooms].sort(compareGitAccountRooms);
  const defaultRoom = sortedRooms.find((room) => isDefaultGitRoom(room.gitRoom));
  const parentRoom = defaultRoom || sortedRooms[0];
  const parent = {
    ...accountGitRoomToRepoParentEntry(parentRoom, input.currentRoomIdentifier),
    pinned: sortedRooms.some((room) => room.pinned),
    pinTargetRoomIdentifier: parentRoom.roomIdentifier,
    pinnedAccountRoomIdentifiers: sortedRooms
      .filter((room) => room.pinned)
      .map((room) => room.roomIdentifier),
  };
  if (!defaultRoom) {
    parent.id = `room:git-repo:${input.repositoryKey}`;
    parent.roomIdentifier = null;
    parent.description = `${sortedRooms.length} ${sortedRooms.length === 1 ? "branch room" : "branch rooms"}`;
    parent.currentWorkspace = false;
  }
  const branchRooms = sortedRooms
    .filter((room) => !defaultRoom || room.roomIdentifier !== defaultRoom.roomIdentifier)
    .map((room) => accountGitRoomToBranchEntry(room, input.currentRoomIdentifier));
  const focusRooms = sortedRooms.flatMap((room) =>
    room.focusRooms.map((focusRoom) =>
      accountFocusRoomToEntry(focusRoom, input.currentRoomIdentifier, room.roomIdentifier)
    )
  );

  return {
    id: `project:git:${input.repositoryKey}`,
    roomName: parent.title,
    parent,
    branchRooms,
    focusRooms,
  };
}

function accountFocusRoomToEntry(
  room: DesktopAccountRoomEntry["focusRooms"][number],
  currentRoomIdentifier: string | null = null,
  parentRoomIdentifier: string | null = null,
): RoomEntry {
  const gitMeta = gitRoomSidebarMeta(room.gitRoom);
  const currentWorkspace = normalizeRoomIdentifier(room.roomIdentifier) === currentRoomIdentifier;
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
    gitRoom: room.gitRoom,
    ...focusRoomLineage(room, parentRoomIdentifier),
    suggestedAction: currentWorkspace ? "Current workspace" : gitMeta ? "Open branch room" : null,
    currentWorkspace,
    latestMessageId: room.latestMessageId,
    latestMessageAt: room.latestMessageAt,
    hasUnread: false,
    pinned: false,
    source: "account",
  };
}

function focusRoomLineage(
  room: { focusKey: string | null; sourceTaskId: string | null; parentRoomId: string | null },
  parentRoomIdentifier: string | null,
): Pick<RoomEntry, "focusKey" | "parentRoomIdentifier"> {
  return {
    focusKey: room.focusKey || room.sourceTaskId,
    parentRoomIdentifier: room.parentRoomId || parentRoomIdentifier,
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
    gitRoom: room.gitRoom,
    latestMessageId: room.latestMessageId,
    latestMessageAt: room.latestMessageAt,
    hasUnread: false,
    pinned: room.pinned,
    pinTargetRoomIdentifier: room.roomIdentifier,
    pinnedAccountRoomIdentifiers: room.pinned ? [room.roomIdentifier] : [],
    source: "account",
  };
}

function accountGitRoomToRepoParentEntry(
  room: DesktopAccountRoomEntry,
  currentRoomIdentifier: string | null,
): RoomEntry {
  const entry = accountRoomToEntry(room);
  const gitRoom = room.gitRoom;
  if (!gitRoom) return entry;
  const currentWorkspace = normalizeRoomIdentifier(room.roomIdentifier) === currentRoomIdentifier;
  return {
    ...entry,
    title: entry.title,
    meta: gitRoom.repository.fullName && gitRoom.repository.fullName !== entry.title
      ? gitRoom.repository.fullName
      : gitAccessModeLabel(gitRoom),
    sectionLabel: "Git repo",
    headline: gitRoom.repository.fullName,
    description: `${gitRefTypeLabel(gitRoom)} · ${gitRoomRefLabel(gitRoom)}`,
    currentWorkspace,
  };
}

function accountGitRoomToBranchEntry(
  room: DesktopAccountRoomEntry,
  currentRoomIdentifier: string | null,
): RoomEntry {
  const entry = accountRoomToEntry(room);
  const gitRoom = room.gitRoom;
  const currentWorkspace = normalizeRoomIdentifier(room.roomIdentifier) === currentRoomIdentifier;
  if (!gitRoom) {
    return {
      ...entry,
      kind: "branch",
      currentWorkspace,
    };
  }
  return {
    ...entry,
    kind: "branch",
    title: gitRoomRefLabel(gitRoom),
    meta: `${gitRefTypeLabel(gitRoom)} · ${gitAccessModeLabel(gitRoom)}`,
    sectionLabel: "Branch room",
    headline: gitRoom.repository.fullName,
    description: room.displayName,
    suggestedAction: null,
    currentWorkspace,
  };
}

function compareGitAccountRooms(left: DesktopAccountRoomEntry, right: DesktopAccountRoomEntry): number {
  const leftDefault = isDefaultGitRoom(left.gitRoom);
  const rightDefault = isDefaultGitRoom(right.gitRoom);
  if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
  return gitRoomRefLabel(left.gitRoom).localeCompare(gitRoomRefLabel(right.gitRoom));
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

  return {
    meta: `${gitRefTypeLabel(gitRoom)} · ${gitRoomRefLabel(gitRoom)}`,
    headline: gitRoom.repository.fullName,
    description: `${gitAccessModeLabel(gitRoom)} Git Room`,
  };
}

function gitRoomRepositoryKey(gitRoom: DesktopGitRoomInfo | null | undefined): string | null {
  return gitRoomRepositoryKeys(gitRoom)[0] || null;
}

function gitRoomRepositoryKeys(gitRoom: DesktopGitRoomInfo | null | undefined): string[] {
  const keys: string[] = [];
  const repositoryId = gitRoom?.repository.id?.trim().toLowerCase();
  if (repositoryId) {
    keys.push(`${gitRoom?.provider || "git"}:${gitRoom?.host || "git"}:id:${repositoryId}`);
  }
  const fullName = gitRoom?.repository.fullName.trim().toLowerCase();
  if (fullName && gitRoom?.accessMode !== "local") {
    keys.push(`${gitRoom?.provider || "git"}:${gitRoom?.host || "git"}:${fullName}`);
  }
  return keys;
}

function isDefaultGitRoom(gitRoom: DesktopGitRoomInfo | null | undefined): boolean {
  return Boolean(gitRoom?.isDefault || gitRoom?.ref.type === "default_branch");
}

function gitAccessModeLabel(gitRoom: DesktopGitRoomInfo): string {
  if (gitRoom.accessMode === "local") return "Local";
  if (gitRoom.accessMode === "private") return "Private";
  if (gitRoom.accessMode === "public") return "Public";
  return "Git";
}

function gitRefTypeLabel(gitRoom: DesktopGitRoomInfo): string {
  if (gitRoom.ref.type === "default_branch") return "Default branch";
  if (gitRoom.ref.type === "pull_request") return "Pull request";
  if (gitRoom.ref.type === "branch") return "Branch";
  return "Tag";
}

function gitRoomRefLabel(gitRoom: DesktopGitRoomInfo | null | undefined): string {
  if (!gitRoom) return "Git ref";
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
