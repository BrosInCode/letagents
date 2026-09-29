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

const joinedRoomInfoCache = new Map<string, RoomInfoPayload>();

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
  for (const key of keys) {
    joinedRoomInfoCache.set(key, payload);
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

export async function getJoinedRoomInfo(
  roomIdentifier: string,
): Promise<RoomInfoPayload> {
  const cacheKey = roomInfoCacheKey(roomIdentifier);
  const cached = cacheKey ? joinedRoomInfoCache.get(cacheKey) : null;
  if (cached) return cached;

  const joined = await apiFetch<RoomInfoPayload>(
    `/rooms/${encodeURIComponent(roomIdentifier)}/join`,
    {
      method: "POST",
    },
  );
  rememberJoinedRoomInfo(roomIdentifier, joined);
  return joined;
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
