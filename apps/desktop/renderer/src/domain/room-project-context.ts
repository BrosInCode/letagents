import type { DesktopRoomInfo } from "../../../electron/ipc-types";

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
 *   git-room:github.com:owner/repo:branch:<ref>  ->  github.com/owner/repo
 *   git-room:local:<id>:branch:<ref>             ->  local/<id>
 * A base identifier (github.com/owner/repo) passes through normalized.
 */
export function canonicalRepoIdentity(value: string | null | undefined): string | null {
  const normalized = normalizeRoomIdentifier(value);
  if (!normalized) return null;
  const gitRoom = /^git-room:([^:\s]+):(.+?)(?::(?:branch|ref|tag):[a-z0-9_-]+)?$/.exec(normalized);
  if (gitRoom) return `${gitRoom[1]}/${gitRoom[2]}`;
  return normalized;
}

/**
 * Branch-independent repository identities under which a repo room can be
 * recognized: its room identifier, its stable repository id, and its
 * host/fullName pair — each reduced to a canonical repository key. Used to
 * decide whether a local checkout genuinely belongs to a repo room, without
 * caring which branch/worktree that checkout currently has.
 */
export function gitRoomIdentityKeys(
  gitRoom: DesktopRoomInfo["gitRoom"] | null | undefined,
  roomIdentifier?: string | null,
): string[] {
  const keys = new Set<string>();
  const roomKey = canonicalRepoIdentity(roomIdentifier);
  if (roomKey) keys.add(roomKey);
  if (gitRoom) {
    const repoId = normalizeRoomIdentifier(gitRoom.repository.id);
    if (repoId) keys.add(repoId);
    const hostFullName = canonicalRepoIdentity(`${gitRoom.host}/${gitRoom.repository.fullName}`);
    if (hostFullName) keys.add(hostFullName);
  }
  return [...keys];
}

/**
 * Resolve the durable project root for the active root room.
 *
 * The stored root recorded when the project room was opened always wins. If a
 * repo-backed root room has no stored root — e.g. an older build's
 * account/app-agent reopen cleared it, or the entry rehydrated from storage
 * after a relaunch without one — a focus room must NOT fall back to a per-room
 * folder prompt. It self-heals from the active desktop workspace, but ONLY when
 * the workspace's canonical Git identity matches the room's repo. On any
 * mismatch (or missing identity) it fails closed and returns null, so the
 * repo-room boundary requires an explicit selection and we never launch a
 * supervised agent in a valid-but-unrelated repository. A room with no repo
 * context at all also resolves to null.
 */
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
  recentRootRooms: ReadonlyArray<{ identifier: string; rootPath: string | null }>;
  workspaceRepoStatus?: { rootPath: string; roomIdentifier?: string | null; isGitRepo?: boolean } | null;
}): string | null {
  const identifier = normalizeRoomIdentifier(input.activeRootIdentifier);
  if (!identifier) return null;
  const stored = input.recentRootRooms.find(
    (entry) => normalizeRoomIdentifier(entry.identifier) === identifier,
  )?.rootPath?.trim() || null;
  if (stored) return stored;

  // Self-heal only a repo-backed room, and only from an identity-matched
  // workspace. Anything else fails closed at the repo-room boundary.
  if (!input.activeRootGitRoom) return null;
  const workspace = input.workspaceRepoStatus;
  const workspaceRoot = workspace?.rootPath?.trim();
  if (!workspace?.isGitRepo || !workspaceRoot) return null;
  const workspaceIdentity = canonicalRepoIdentity(workspace.roomIdentifier);
  if (!workspaceIdentity) return null;
  const roomIdentities = gitRoomIdentityKeys(input.activeRootGitRoom, input.activeRootIdentifier);
  return roomIdentities.includes(workspaceIdentity) ? workspaceRoot : null;
}
