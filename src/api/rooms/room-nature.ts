/**
 * The one server module that answers "what kind of room is this?":
 * a join-code room, a repository room, a named (ad-hoc) room, or a focus room.
 *
 * Today the answer comes from the shape of the room id. A later migration
 * stores it as `rooms.origin`; then only the inside of `getRoomNature` changes
 * and every caller keeps its call.
 *
 * Kept free of imports so hot paths (and `routing.ts`, `room-ids.ts`, which
 * re-export from here) can use it without import cycles.
 *
 * Where two existing checks disagree, this module keeps both under names that
 * say what they do. It does not pick a winner; see the notes on
 * `isFocusRoomIdShape` / `matchesFocusRoomIdDatabaseCheck`,
 * `parseGitHubRepoRoomId` / `parseGitHubRefParentRoomId`, and
 * `isRepoRoomByIdShape` / `resolveRepoAccessTarget`.
 */

export type RoomOrigin = "join_code" | "repo" | "named" | "focus";

/** The columns `getRoomNature` reads. PR2 adds the stored `origin`. */
export interface RoomNatureSource {
  id: string;
  kind: string;
  parent_room_id?: string | null;
}

export interface RoomNature {
  origin: RoomOrigin;
  isFocus: boolean;
  /** The join code a client sees as `code`, or null. */
  joinCode: string | null;
  /** The value a client sees as `name`: the id, except for join-code rooms. */
  name: string | undefined;
  /** The room whose access rules apply: the parent of a focus room, else itself. */
  accessRoomId: string;
}

// ── Join codes ────────────────────────────────────────────────────────────

/** Join code pattern: XXXX-XXXX or XXXX-XXXX-XXXX (uppercase). */
export const JOIN_CODE_PATTERN = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,2}$/;

/** True when the value has the shape of a join code, in any letter case. */
export function isJoinCodeShape(value: string): boolean {
  return JOIN_CODE_PATTERN.test(value.toUpperCase());
}

// ── Repository rooms ──────────────────────────────────────────────────────

/**
 * Repository-backed room ids are `host/namespace/repo` locators.
 *
 * Two shapes count:
 *   - Any three segments whose first segment is a hostname-like token
 *     (`github.com/owner/repo`, `bitbucket.org/ws/repo`, `local/Users/x`). A
 *     first segment without a dot is kept on purpose: an SSH config alias such
 *     as `git@github-work:acme/app.git` becomes `github-work/acme/app`, and the
 *     server cannot tell it from a typed name. Failing closed is safer than
 *     opening an ad-hoc room that is named after a private repository.
 *   - `gitlab.com` with three or more segments. GitLab nests groups
 *     (`gitlab.com/group/sub/project`), and `parseRepoRoomName` already reads
 *     those as repositories, so both functions must agree.
 */
const THREE_SEGMENT_ROOM_ID = /^[A-Za-z0-9.-]+\/[^/]+\/[^/]+$/;

export function isRepoShapedRoomId(roomId: string): boolean {
  if (THREE_SEGMENT_ROOM_ID.test(roomId)) {
    return true;
  }

  const segments = roomId.split("/");
  return segments.length >= 3 && segments[0].toLowerCase() === "gitlab.com";
}

/**
 * A `github.com/owner/repo` room id, any letter case, no colon in owner or
 * repo. Returns owner and repo lowercased. This is the check that decides
 * whether a room gets a manual GitHub binding.
 *
 * Disagrees with `parseGitHubRefParentRoomId` on letter case and colons.
 */
export function parseGitHubRepoRoomId(roomId: string): { owner: string; name: string } | null {
  const match = /^github\.com\/([^/:\s]+)\/([^/:\s]+)$/i.exec(roomId.trim());
  if (!match) {
    return null;
  }
  return { owner: match[1].toLowerCase(), name: match[2].toLowerCase() };
}

/**
 * The parent of a branch or tag locator (`github.com/owner/repo/focus/git:...`).
 * Lowercase `github.com` only, colons allowed, no trimming. Returns
 * `owner/repo` exactly as written.
 *
 * Disagrees with `parseGitHubRepoRoomId` on letter case and colons.
 */
export function parseGitHubRefParentRoomId(parentRoomId: string): string | null {
  return /^github\.com\/([^/\s]+\/[^/\s]+)$/.exec(parentRoomId)?.[1] ?? null;
}

// ── Focus rooms ───────────────────────────────────────────────────────────

/**
 * The focus room id shape that server code checks: `focus_` and digits.
 * Accepts `focus_0` and `focus_007`.
 *
 * Disagrees with the database check `rooms_focus_id_check`
 * (`FOCUS_ROOM_ID_DATABASE_PATTERN`), which rejects both.
 */
export function isFocusRoomIdShape(roomId: string): boolean {
  return /^focus_\d+$/.test(roomId);
}

/** The pattern in the `rooms_focus_id_check` constraint (schema/core.ts). */
export const FOCUS_ROOM_ID_DATABASE_PATTERN = "^focus_[1-9][0-9]*$";

/** True when a `kind = 'focus'` row with this id passes `rooms_focus_id_check`. */
export function matchesFocusRoomIdDatabaseCheck(roomId: string): boolean {
  return new RegExp(FOCUS_ROOM_ID_DATABASE_PATTERN).test(roomId);
}

/** Split `<parent>/focus/<key>`; the key has no `/`. */
export function parseFocusRoomLocator(
  roomLocator: string
): { parentRoomId: string; focusKey: string } | null {
  const marker = "/focus/";
  const index = roomLocator.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }

  const parentRoomId = roomLocator.slice(0, index);
  const focusKey = roomLocator.slice(index + marker.length);
  if (!parentRoomId || !focusKey || focusKey.includes("/")) {
    return null;
  }

  return { parentRoomId, focusKey };
}

/** Ids that no request may create as a main room. */
export function isReservedMainRoomCreationId(roomId: string): boolean {
  const normalized = roomId.trim();
  return isFocusRoomIdShape(normalized)
    || /^git-room:github\.com:/i.test(normalized)
    || /(?:^|\/)focus\//i.test(normalized);
}

// ── Classification ────────────────────────────────────────────────────────

/**
 * Classify a stored room id by its shape alone. Order: focus id, join code,
 * repository, named. PR2 uses this to backfill `rooms.origin` and to compare
 * the stored value with the shape.
 */
export function classifyRoomId(roomId: string): RoomOrigin {
  if (isFocusRoomIdShape(roomId)) return "focus";
  if (isJoinCodeShape(roomId)) return "join_code";
  if (isRepoShapedRoomId(roomId)) return "repo";
  return "named";
}

export type RoomLocator =
  | { type: "focus_locator"; parentRoomId: string; focusKey: string }
  | { type: "join_code" }
  | { type: "reserved" }
  | { type: "room_name" };

/**
 * Classify a room string that a client sent, before any room is found.
 * Same order as room resolution: focus locator, join code, reserved id, name.
 */
export function classifyRoomLocator(input: string): RoomLocator {
  const focusLocator = parseFocusRoomLocator(input);
  if (focusLocator) return { type: "focus_locator", ...focusLocator };
  if (isJoinCodeShape(input)) return { type: "join_code" };
  if (isReservedMainRoomCreationId(input)) return { type: "reserved" };
  return { type: "room_name" };
}

/**
 * The nature of a stored room. Reads the id shape until `rooms.origin`
 * exists; callers do not change when it does.
 */
export function getRoomNature(room: RoomNatureSource): RoomNature {
  const joinCodeShaped = isJoinCodeShape(room.id);
  const isFocus = room.kind === "focus";
  const origin: RoomOrigin = isFocus
    ? "focus"
    : joinCodeShaped
      ? "join_code"
      : isRepoShapedRoomId(room.id)
        ? "repo"
        : "named";
  return {
    origin,
    isFocus,
    joinCode: joinCodeShaped ? room.id : null,
    name: joinCodeShaped ? undefined : room.id,
    accessRoomId: room.parent_room_id ?? room.id,
  };
}

/** True for a main room whose id is a join code: the only rooms that can be deleted. */
export function isJoinCodeMainRoom(room: RoomNatureSource): boolean {
  return room.kind === "main" && isJoinCodeShape(room.id);
}

// ── Repository access target (two existing behaviours) ───────────────────

/**
 * Behaviour A (today's `isRepoBackedProject`): the access room id has a
 * repository shape. A binding is not read.
 *
 * Disagrees with `resolveRepoAccessTarget` for a room whose id is not
 * repository-shaped but which has a GitHub binding: A says no, B says yes.
 */
export function isRepoRoomByIdShape(room: RoomNatureSource): boolean {
  return isRepoShapedRoomId(room.parent_room_id ?? room.id);
}

export interface RepoBindingLike {
  provider: string;
  host: string;
  repository_full_name: string;
}

/**
 * Behaviour B (today's `resolveProjectRepoAccessTarget`): the access room id
 * when it has a repository shape; else the first GitHub binding of the access
 * room, then of the room itself.
 */
export async function resolveRepoAccessTarget<TBinding extends RepoBindingLike>(
  room: RoomNatureSource,
  getBinding: (roomId: string) => Promise<TBinding | null>,
): Promise<{ roomName: string; repoRoomName: string; binding: TBinding | null } | null> {
  const accessRoomId = room.parent_room_id ?? room.id;
  if (isRepoShapedRoomId(accessRoomId)) {
    return { roomName: accessRoomId, repoRoomName: accessRoomId, binding: null };
  }

  for (const roomId of [...new Set([accessRoomId, room.id])]) {
    const binding = await getBinding(roomId);
    if (!binding || binding.provider !== "github") {
      continue;
    }
    return {
      roomName: roomId,
      repoRoomName: `${binding.host}/${binding.repository_full_name}`,
      binding,
    };
  }

  return null;
}
