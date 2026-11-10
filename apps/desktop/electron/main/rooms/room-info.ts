import type {
  DesktopFocusActivityScope,
  DesktopFocusGitHubEventRouting,
  DesktopFocusParentVisibility,
  DesktopFocusRoomConclusionDetails,
  DesktopFocusRoomSettings,
  DesktopRoomAccess,
  DesktopRoomInfo,
} from "../../ipc-types.js";
import { apiFetch } from "../auth.js";
import { mapDesktopGitRoomPayload } from "./git-room.js";

export type RoomInfoPayload = {
  room_id?: string;
  code?: string;
  name?: string | null;
  display_name?: string | null;
  role?: string;
  authenticated?: boolean;
  kind?: "main" | "focus";
  parent_room_id?: string | null;
  focus_key?: string | null;
  source_task_id?: string | null;
  focus_status?: "active" | "concluded" | null;
  focus_parent_visibility?: DesktopFocusParentVisibility | null;
  focus_activity_scope?: DesktopFocusActivityScope | null;
  focus_github_event_routing?: DesktopFocusGitHubEventRouting | null;
  focus_settings?: Partial<DesktopFocusRoomSettings> | null;
  focus_archived_at?: string | null;
  concluded_at?: string | null;
  conclusion_summary?: string | null;
  conclusion_details?: Partial<DesktopFocusRoomConclusionDetails> | null;
  git_room?: unknown;
};

/**
 * Joined-room info, reused so room opens do not call the join endpoint again.
 *
 * Problem: the map had no size limit and no expiry, so a rename or a role change
 * stayed hidden until sign-out, and a long session kept every room it had seen.
 * Rule: an entry lives `JOINED_ROOM_INFO_TTL_MS` (5 minutes). The map keeps at most
 * `JOINED_ROOM_INFO_MAX_ENTRIES` keys; a hit moves its key to the newest place and
 * the oldest key is dropped first. `clearJoinedRoomInfoCache` still empties it
 * (sign-out and account changes).
 */
export const JOINED_ROOM_INFO_TTL_MS = 5 * 60 * 1000;
export const JOINED_ROOM_INFO_MAX_ENTRIES = 500;
const joinedRoomInfoCache = new Map<string, { payload: RoomInfoPayload; storedAt: number }>();
/**
 * Joins in flight, shared by callers that miss the cache at the same moment.
 *
 * Problem: on a first visit several handlers ask for the room at once, and each
 * sent its own `POST /join` (slow for a repo room, and each one counts against
 * the server's join rate limit).
 * Rule: one request per cache key and `create` variant. Every caller gets its
 * result or its error. The entry goes away when the request settles, so an error
 * is never reused.
 * Invalidation: `clearJoinedRoomInfoCache` and `forgetJoinedRoomInfo` raise one
 * generation and drop every pending join from this map. A join started before
 * that is not shared with later callers, and its answer is not stored; its own
 * callers still get it. This does not need to know a room's aliases (a join code
 * or a focus locator may be pending for a room forgotten by its id). The cost is
 * an extra join for rooms that were pending when any room was forgotten (rare).
 */
const joinedRoomInfoInFlight = new Map<string, Promise<RoomInfoPayload>>();
let joinedRoomInfoGeneration = 0;

function invalidatePendingJoinedRoomInfo(): void {
  joinedRoomInfoGeneration += 1;
  joinedRoomInfoInFlight.clear();
}

export function createRoomAccess(
  input: Partial<DesktopRoomAccess>,
): DesktopRoomAccess {
  return {
    status: input.status || "ready",
    title: input.title || "Room ready",
    message: input.message || "",
    roomIdentifier: input.roomIdentifier || null,
    deviceFlowUrl: input.deviceFlowUrl || null,
    code: input.code || null,
    httpStatus: input.httpStatus || null,
    displayName: input.displayName || null,
    joinRequest: input.joinRequest || null,
  };
}

export function roomInfoCacheKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const focusLocator = /^(github\.com\/[^/]+\/[^/]+\/focus\/)(.+)$/i.exec(trimmed);
  const normalized = focusLocator
    ? `${focusLocator[1].toLowerCase()}${focusLocator[2]}`
    : trimmed.toLowerCase();
  return normalized || null;
}

export function rememberJoinedRoomInfo(
  requestedRoomIdentifier: string,
  payload: RoomInfoPayload,
): void {
  const keys = roomInfoCacheKeys(requestedRoomIdentifier, payload)
    .map(roomInfoCacheKey)
    .filter((key): key is string => Boolean(key));
  const storedAt = Date.now();
  for (const key of keys) {
    joinedRoomInfoCache.delete(key);
    joinedRoomInfoCache.set(key, { payload, storedAt });
  }
  while (joinedRoomInfoCache.size > JOINED_ROOM_INFO_MAX_ENTRIES) {
    const oldest = joinedRoomInfoCache.keys().next().value;
    if (oldest === undefined) break;
    joinedRoomInfoCache.delete(oldest);
  }
}

/**
 * Drops what the app remembers about joining a room, so the next check asks
 * the server. Called when the server refuses the room or the person leaves it.
 */
export function forgetJoinedRoomInfo(roomIdentifier: string | null | undefined): void {
  const key = roomInfoCacheKey(roomIdentifier);
  if (!key) return;
  const remembered = joinedRoomInfoCache.get(key)?.payload;
  const related = new Set([key, ...(remembered ? roomInfoCacheKeys(key, remembered).map(roomInfoCacheKey) : [])]);
  // A join already on its way, under any alias, may answer for access the person
  // no longer has: later checks must not share it, and its answer is not stored.
  invalidatePendingJoinedRoomInfo();
  // Every alias of the room (its code, a branch name) points at the same room id.
  for (const [cachedKey, entry] of joinedRoomInfoCache) {
    if (related.has(cachedKey) || related.has(roomInfoCacheKey(entry.payload.room_id))) joinedRoomInfoCache.delete(cachedKey);
  }
}

export function roomInfoCacheKeys(
  requestedRoomIdentifier: string,
  payload: RoomInfoPayload,
): string[] {
  return [requestedRoomIdentifier, payload.room_id]
    .filter((value): value is string => Boolean(value?.trim()));
}

export function canonicalJoinedRoomIdentifier(
  requestedRoomIdentifier: string,
  payload: RoomInfoPayload,
): string {
  return payload.room_id?.trim() || requestedRoomIdentifier.trim();
}

export type JoinedRoomInfoOptions = {
  /** false: join the room only if it exists; the server answers 404 instead of creating it. */
  create?: boolean;
};

export async function getJoinedRoomInfo(
  roomIdentifier: string,
  options?: JoinedRoomInfoOptions,
): Promise<RoomInfoPayload> {
  const cacheKey = roomInfoCacheKey(roomIdentifier);
  const cached = cacheKey ? joinedRoomInfoCache.get(cacheKey) : null;
  if (cacheKey && cached) {
    if (Date.now() - cached.storedAt < JOINED_ROOM_INFO_TTL_MS) {
      // A hit becomes the newest entry, so busy rooms outlive idle ones.
      joinedRoomInfoCache.delete(cacheKey);
      joinedRoomInfoCache.set(cacheKey, cached);
      return cached.payload;
    }
    joinedRoomInfoCache.delete(cacheKey);
  }

  const noCreate = options?.create === false;
  const flightKey = cacheKey ? `${cacheKey}\n${noCreate ? "no-create" : "create"}` : null;
  const shared = flightKey ? joinedRoomInfoInFlight.get(flightKey) : undefined;
  if (shared) return shared;

  const generation = joinedRoomInfoGeneration;
  const flight = (async () => {
    const joined = await apiFetch<RoomInfoPayload>(
      `/rooms/${encodeURIComponent(roomIdentifier)}/join${noCreate ? "?create=false" : ""}`,
      {
        method: "POST",
      },
    );
    // After sign-out or an account change the answer belongs to the old account;
    // after a forget it may describe access the person lost.
    if (generation === joinedRoomInfoGeneration) rememberJoinedRoomInfo(roomIdentifier, joined);
    return joined;
  })();
  if (flightKey) {
    joinedRoomInfoInFlight.set(flightKey, flight);
    // Registered before any caller awaits, so it runs first: a caller that sees
    // the outcome and asks again sends a new join.
    const settle = () => {
      if (joinedRoomInfoInFlight.get(flightKey) === flight) joinedRoomInfoInFlight.delete(flightKey);
    };
    flight.then(settle, settle);
  }
  return flight;
}

export function mapDesktopRoomInfoPayload(
  requestedRoomIdentifier: string,
  payload: RoomInfoPayload,
): DesktopRoomInfo {
  const canonicalIdentifier = canonicalJoinedRoomIdentifier(requestedRoomIdentifier, payload);
  const focusSettings = normalizeRoomFocusSettings(payload);
  return {
    identifier: canonicalIdentifier,
    code: payload.code || "",
    name: payload.name || canonicalIdentifier,
    displayName: payload.display_name || payload.name || canonicalIdentifier,
    role: payload.role || "participant",
    authenticated: Boolean(payload.authenticated),
    kind: payload.kind || "main",
    parentRoomId: payload.parent_room_id || null,
    focusKey: payload.focus_key || null,
    sourceTaskId: payload.source_task_id || null,
    focusStatus: payload.focus_status || null,
    focusParentVisibility: focusSettings?.parent_visibility || null,
    focusActivityScope: focusSettings?.activity_scope || null,
    focusGitHubEventRouting: focusSettings?.github_event_routing || null,
    focusSettings,
    focusArchivedAt: payload.focus_archived_at || null,
    concludedAt: payload.concluded_at || null,
    conclusionSummary: payload.conclusion_summary || null,
    conclusionDetails: normalizeRoomConclusionDetails(payload.conclusion_details),
    gitRoom: mapDesktopGitRoomPayload(payload.git_room),
  };
}

export function clearJoinedRoomInfoCache(): void {
  invalidatePendingJoinedRoomInfo();
  joinedRoomInfoCache.clear();
}

function normalizeRoomFocusSettings(payload: RoomInfoPayload): DesktopFocusRoomSettings | null {
  if (payload.kind !== "focus") return null;
  return {
    parent_visibility:
      normalizeParentVisibility(payload.focus_settings?.parent_visibility)
      || normalizeParentVisibility(payload.focus_parent_visibility)
      || "summary_only",
    activity_scope:
      normalizeActivityScope(payload.focus_settings?.activity_scope)
      || normalizeActivityScope(payload.focus_activity_scope)
      || "task_and_branch",
    github_event_routing:
      normalizeGitHubEventRouting(payload.focus_settings?.github_event_routing)
      || normalizeGitHubEventRouting(payload.focus_github_event_routing)
      || "task_and_branch",
  };
}

function normalizeParentVisibility(value: unknown): DesktopFocusParentVisibility | null {
  return value === "summary_only"
    || value === "major_activity"
    || value === "all_activity"
    || value === "silent"
    ? value
    : null;
}

function normalizeActivityScope(value: unknown): DesktopFocusActivityScope | null {
  return value === "task_and_branch" || value === "task_only" || value === "room"
    ? value
    : null;
}

function normalizeGitHubEventRouting(value: unknown): DesktopFocusGitHubEventRouting | null {
  return value === "task_and_branch"
    || value === "focus_owned_only"
    || value === "task_only"
    || value === "all_parent_repo"
    || value === "off"
    ? value
    : null;
}

function normalizeRoomConclusionDetails(value: RoomInfoPayload["conclusion_details"]): DesktopFocusRoomConclusionDetails | null {
  if (!value) return null;
  return {
    artifact: value.artifact || "",
    review_state:
      value.review_state === "reviewed"
      || value.review_state === "needs_review"
      || value.review_state === "not_required"
        ? value.review_state
        : "needs_review",
    blocker_state:
      value.blocker_state === "none"
      || value.blocker_state === "resolved"
      || value.blocker_state === "blocked"
        ? value.blocker_state
        : "none",
    parent_task_next:
      value.parent_task_next === "keep_open"
      || value.parent_task_next === "move_to_review"
      || value.parent_task_next === "mark_blocked"
      || value.parent_task_next === "mark_done"
      || value.parent_task_next === "follow_up"
        ? value.parent_task_next
        : "keep_open",
    next_owner: value.next_owner || "",
  };
}
