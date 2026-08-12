import type {
  DesktopAccountRoomEntry,
  DesktopGitRoomInfo,
} from "../../ipc-types.js";

import type { AppAgentActionRegistryDeps } from "./types.js";

export function normalizeRoomText(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

export function roomAliasCandidates(room: DesktopAccountRoomEntry): string[] {
  return [
    room.roomIdentifier,
    room.displayName,
    room.name,
  ]
    .map(normalizeRoomText)
    .filter((value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
    );
}

export function roomMatchesIdentifier(
  room: DesktopAccountRoomEntry,
  roomIdentifier: string,
): boolean {
  const expected = normalizeRoomText(roomIdentifier);
  if (!expected) return false;
  return roomAliasCandidates(room).some((candidate) => candidate === expected);
}

export function uniqueRoomsByIdentifier(
  rooms: DesktopAccountRoomEntry[],
): DesktopAccountRoomEntry[] {
  const seen = new Set<string>();
  const unique: DesktopAccountRoomEntry[] = [];
  for (const room of rooms) {
    const key = normalizeRoomText(room.roomIdentifier || room.displayName || room.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(room);
  }
  return unique;
}

export function toToolRoom(room: DesktopAccountRoomEntry): Record<string, unknown> {
  return {
    roomIdentifier: room.roomIdentifier,
    displayName: room.displayName,
    name: room.name,
    aliases: roomAliasCandidates(room),
    gitRoom: toToolGitRoom(room.gitRoom),
    pinned: room.pinned,
    archived: room.archived,
    role: room.role,
    source: room.source,
    firstOpenedAt: room.firstOpenedAt,
    lastOpenedAt: room.lastOpenedAt,
    latestMessageAt: room.latestMessageAt,
    focusRooms: room.focusRooms.map((focusRoom) => ({
      roomIdentifier: focusRoom.roomIdentifier,
      displayName: focusRoom.displayName,
      name: focusRoom.name,
      sourceTaskId: focusRoom.sourceTaskId,
      focusKey: focusRoom.focusKey,
      gitRoom: toToolGitRoom(focusRoom.gitRoom),
      lastOpenedAt: focusRoom.lastOpenedAt,
      latestMessageAt: focusRoom.latestMessageAt,
    })),
  };
}

export function toToolGitRoom(gitRoom: DesktopGitRoomInfo | null): Record<string, unknown> | null {
  if (!gitRoom) return null;
  return {
    provider: gitRoom.provider,
    host: gitRoom.host,
    repository: gitRoom.repository.fullName,
    refType: gitRoom.ref.type,
    refName: gitRoom.ref.name,
    defaultBranch: gitRoom.ref.defaultBranch,
    baseRef: gitRoom.ref.baseRef,
    headRef: gitRoom.ref.headRef,
    headRepository: gitRoom.ref.headRepository?.fullName ?? null,
    visibility: gitRoom.visibility,
    accessMode: gitRoom.accessMode,
    isDefault: gitRoom.isDefault,
    source: gitRoom.source,
  };
}

export async function findRoom(
  deps: AppAgentActionRegistryDeps,
  roomIdentifier: string,
): Promise<DesktopAccountRoomEntry | null> {
  const expected = normalizeRoomText(roomIdentifier);
  if (!expected) return null;
  const rooms = await deps.listAccountRooms({
    includeArchived: true,
    limit: 100,
  });
  const canonicalMatches = uniqueRoomsByIdentifier(
    rooms.filter((room) => normalizeRoomText(room.roomIdentifier) === expected),
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) {
    throw new Error(`Multiple rooms match "${roomIdentifier}". Please choose one.`);
  }
  const aliasMatches = uniqueRoomsByIdentifier(
    rooms.filter((room) => roomMatchesIdentifier(room, roomIdentifier)),
  );
  if (aliasMatches.length === 1) return aliasMatches[0];
  if (aliasMatches.length > 1) {
    throw new Error(`Multiple rooms match "${roomIdentifier}". Please choose one.`);
  }
  return null;
}

export async function requireRoom(
  deps: AppAgentActionRegistryDeps,
  roomIdentifier: string,
): Promise<DesktopAccountRoomEntry> {
  const room = await findRoom(deps, roomIdentifier);
  if (!room) {
    throw new Error(`I don't see a room called "${roomIdentifier}" in your account.`);
  }
  return room;
}


export async function findRooms(
  deps: AppAgentActionRegistryDeps,
  roomIdentifiers: string[],
): Promise<DesktopAccountRoomEntry[]> {
  const resolved: DesktopAccountRoomEntry[] = [];
  for (const roomIdentifier of roomIdentifiers) {
    const room = await findRoom(deps, roomIdentifier);
    if (!room) {
      throw new Error(`I don't see a room called "${roomIdentifier}" in your account.`);
    }
    resolved.push(room);
  }
  return uniqueRoomsByIdentifier(resolved);
}

export async function findUnpinnedRooms(
  deps: AppAgentActionRegistryDeps,
  excludeRoomIdentifiers: string[] | null | undefined,
): Promise<DesktopAccountRoomEntry[]> {
  const rooms = await deps.listAccountRooms({
    includeArchived: false,
    limit: 100,
  });
  const excluded = excludeRoomIdentifiers || [];
  return rooms.filter(
    (room) =>
      !room.pinned &&
      !excluded.some((roomIdentifier) => roomMatchesIdentifier(room, roomIdentifier)),
  );
}

export async function verifyRoomPinned(
  deps: AppAgentActionRegistryDeps,
  roomIdentifier: string,
  pinned: boolean,
): Promise<void> {
  const room = await findRoom(deps, roomIdentifier);
  if (!room || room.pinned !== pinned) {
    throw new Error(`The room "${roomIdentifier}" was not ${pinned ? "pinned" : "unpinned"}.`);
  }
}

export async function verifyRoomArchived(
  deps: AppAgentActionRegistryDeps,
  roomIdentifier: string,
  archived: boolean,
): Promise<void> {
  const room = await findRoom(deps, roomIdentifier);
  if (!room || room.archived !== archived) {
    throw new Error(`The room "${roomIdentifier}" was not ${archived ? "archived" : "restored"}.`);
  }
}

export function joinRoomNames(rooms: Array<{ displayName: string }>): string {
  if (rooms.length === 1) return rooms[0].displayName;
  if (rooms.length === 2) return `${rooms[0].displayName} and ${rooms[1].displayName}`;
  return `${rooms.slice(0, -1).map((room) => room.displayName).join(", ")}, and ${rooms[rooms.length - 1].displayName}`;
}
