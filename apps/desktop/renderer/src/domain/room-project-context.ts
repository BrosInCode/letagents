import type { DesktopProjectBinding, DesktopRoomInfo } from "../../../electron/ipc-types";
import { findProjectBinding } from "../../../electron/project-bindings";

export type RepositoryRootBindings = Record<string, string>;

type KeyValueStorage = Pick<Storage, "getItem">;

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

/**
 * Reduce any room/git-room identifier to a branch-independent repository key so
 * two references to the same repo compare equal regardless of the checked-out
 * ref or worktree. A branch/ref/tag-scoped git-room identifier keeps only its
 * repository portion:
 *   github.com/owner/repo/focus/git:branch:<ref> -> github.com/owner/repo
 *   git-room:local:<id>:branch:<ref>             ->  local/<id>
 * A base identifier (github.com/owner/repo) passes through normalized.
 */
export function canonicalRepoIdentity(value: string | null | undefined): string | null {
  const normalized = normalizeRoomIdentifier(value);
  if (!normalized) return null;
  const focusParent = normalized.match(/^(.+)\/focus\/[^/]+$/)?.[1];
  if (focusParent) return focusParent;
  const gitRoom = /^git-room:(local):(.+?)(?::(?:branch|ref|tag):[a-z0-9_-]+)?$/.exec(normalized);
  if (gitRoom) return `${gitRoom[1]}/${gitRoom[2]}`;
  return normalized;
}

/** Parse renderer-era roots once as candidates for the main-process migration. */
export function readRepositoryRootBindings(
  storage: Pick<KeyValueStorage, "getItem">,
  storageKey: string,
  recentRooms: ReadonlyArray<{ identifier: string; rootPath: string | null }> = [],
): RepositoryRootBindings {
  const migrated = Object.fromEntries(recentRooms.flatMap((room) => {
    const identity = canonicalRepoIdentity(room.identifier);
    const rootPath = room.rootPath?.trim();
    return identity && rootPath ? [[identity, rootPath]] : [];
  }));
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return migrated;
    return { ...migrated, ...Object.fromEntries(Object.entries(parsed).flatMap(([identity, value]) => {
      const key = canonicalRepoIdentity(identity);
      const rootPath = typeof value === "string" ? value.trim() : "";
      return key && rootPath ? [[key, rootPath]] : [];
    })) };
  } catch {
    return migrated;
  }
}

/**
 * The repo-room project context for whichever room is active, derived from the
 * sidebar project GROUP that actually contains that room — its parent repo room
 * identifier + gitRoom. This is the authoritative source of a focus room's
 * project: it groups a focus room under its repo regardless of which unrelated
 * room happens to be the last-opened global "root" snapshot. Returns null when
 * the active entry belongs to no repo-backed project group (e.g. a standalone
 * non-repo room), so callers fall back / require selection.
 */
export function activeRepoRoomContext(
  activeEntryId: string | null | undefined,
  groups: ReadonlyArray<{
    parent: { id: string; roomIdentifier: string | null; gitRoom?: DesktopRoomInfo["gitRoom"] };
    branchRooms: ReadonlyArray<{ id: string }>;
    focusRooms: ReadonlyArray<{ id: string }>;
  }>,
): { roomIdentifier: string | null; gitRoom: DesktopRoomInfo["gitRoom"] } | null {
  const id = (activeEntryId || "").trim();
  if (!id) return null;
  for (const group of groups) {
    const contains = group.parent.id === id
      || group.branchRooms.some((room) => room.id === id)
      || group.focusRooms.some((room) => room.id === id);
    if (contains) return { roomIdentifier: group.parent.roomIdentifier, gitRoom: group.parent.gitRoom ?? null };
  }
  return null;
}

export function resolveActiveProjectRootPath(input: {
  activeRootIdentifier: string | null | undefined;
  activeRootGitRoom?: DesktopRoomInfo["gitRoom"] | null;
  projectBindings: readonly DesktopProjectBinding[];
}): string | null {
  // Runtime resolution has exactly one authority: the main-process binding
  // store. Navigation history, startup cwd, and agent workspaces are excluded.
  return findProjectBinding(input.projectBindings, {
    roomIdentifier: input.activeRootIdentifier,
    gitRoom: input.activeRootGitRoom,
  })?.rootPath || null;
}
