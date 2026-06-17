import type {
  DesktopGitHubEventsPage,
  DesktopGitHubEventsQuery,
  DesktopGitHubRoomEvent,
  DesktopGitHubRoomEventType,
} from "../../ipc-types.js";

export interface GitHubEventsResponse {
  room_id?: string | null;
  github_room_id?: string | null;
  events?: GitHubRoomEventPayload[];
  has_more?: boolean | null;
}

export interface GitHubRoomEventPayload {
  id?: string | null;
  event_type?: string | null;
  action?: string | null;
  github_object_id?: string | null;
  github_object_url?: string | null;
  title?: string | null;
  state?: string | null;
  actor_login?: string | null;
  metadata?: unknown;
  linked_task_id?: string | null;
  created_at?: string | null;
}

const githubRoomEventTypes = new Set<DesktopGitHubRoomEventType>([
  "pull_request",
  "pull_request_review",
  "issue",
  "issue_comment",
  "check_run",
  "repository",
  "installation",
  "installation_repositories",
]);

export async function getDesktopGitHubEvents(
  roomIdentifier: string,
  query: DesktopGitHubEventsQuery = {},
): Promise<DesktopGitHubEventsPage> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    return {
      roomIdentifier: "",
      githubRoomIdentifier: null,
      events: [],
      hasMore: false,
    };
  }

  const {
    cloudRoomIdentifierForStorage,
    localRoomIdentifierForStorage,
    resolveLocalAwareRoomStorageMode,
  } = await import("./local-store.js");
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    return {
      roomIdentifier: localRoomIdentifierForStorage(storage, trimmedRoomIdentifier),
      githubRoomIdentifier: null,
      events: [],
      hasMore: false,
    };
  }
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(
    storage,
    trimmedRoomIdentifier,
  );

  const params = new URLSearchParams();
  params.set("limit", String(clampEventsLimit(query.limit)));
  appendQueryParam(params, "after", query.after);
  appendQueryParam(params, "event_type", query.eventType);
  appendQueryParam(params, "object_id", query.objectId);
  appendQueryParam(params, "actor", query.actor);
  appendQueryParam(params, "since", query.since);
  appendQueryParam(params, "until", query.until);

  const { apiFetch } = await import("../auth.js");
  const payload = await apiFetch<GitHubEventsResponse>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/events?${params.toString()}`,
  );
  return mapGitHubEventsPayload(cloudRoomIdentifier, payload);
}

export function mapGitHubEventsPayload(
  fallbackRoomIdentifier: string,
  payload: GitHubEventsResponse | null | undefined,
): DesktopGitHubEventsPage {
  const roomIdentifier = payload?.room_id || fallbackRoomIdentifier;
  const events = (payload?.events || [])
    .map(mapGitHubRoomEventPayload)
    .filter((event): event is DesktopGitHubRoomEvent => Boolean(event))
    .sort(compareGitHubRoomEvents);
  return {
    roomIdentifier,
    githubRoomIdentifier: payload?.github_room_id || null,
    events,
    hasMore: Boolean(payload?.has_more),
  };
}

export function mapGitHubRoomEventPayload(
  payload: GitHubRoomEventPayload | null | undefined,
): DesktopGitHubRoomEvent | null {
  if (!payload?.id) return null;
  return {
    id: payload.id,
    eventType: normalizeGitHubEventType(payload.event_type),
    action: payload.action || "",
    githubObjectId: payload.github_object_id || null,
    githubObjectUrl: payload.github_object_url || null,
    title: payload.title || null,
    state: payload.state || null,
    actorLogin: payload.actor_login || null,
    metadata: normalizeMetadata(payload.metadata),
    linkedTaskId: payload.linked_task_id || null,
    createdAt: payload.created_at || new Date(0).toISOString(),
  };
}

function appendQueryParam(
  params: URLSearchParams,
  key: string,
  value: string | number | null | undefined,
): void {
  if (value === null || value === undefined || value === "") return;
  params.set(key, String(value));
}

function clampEventsLimit(value: number | null | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 100;
  return Math.min(100, Math.max(1, Math.round(numeric)));
}

function normalizeGitHubEventType(value: unknown): DesktopGitHubRoomEventType {
  return typeof value === "string" && githubRoomEventTypes.has(value as DesktopGitHubRoomEventType)
    ? (value as DesktopGitHubRoomEventType)
    : "repository";
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compareGitHubRoomEvents(left: DesktopGitHubRoomEvent, right: DesktopGitHubRoomEvent): number {
  const leftTime = Date.parse(left.createdAt || "");
  const rightTime = Date.parse(right.createdAt || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return right.id.localeCompare(left.id);
}
