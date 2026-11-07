// A person or a bot asked to join a members-only room, or the request was
// answered. The server tells the room's admins at once, on the room stream and
// on the account activity stream; nobody else receives the requester's name.
// Both apps read the event from this one file and show the same banner, play
// one alert sound and raise one desktop notification.
import { ROOM_JOIN_REQUEST_STATES } from './room-membership.mjs';

/** The SSE event name, on the room stream and on the account activity stream. */
export const ROOM_JOIN_REQUEST_EVENT = 'join_request';

/** While the window is hidden, the alert sound plays at most once in this time. */
export const JOIN_REQUEST_HIDDEN_SOUND_INTERVAL_MS = 60_000;

const MAX_TEXT = 512;

function text(value) {
  return typeof value === 'string' && value.length <= MAX_TEXT ? value : null;
}

function optionalText(value) {
  if (value === null || value === undefined) return null;
  return text(value);
}

/**
 * Reads one join request as a room admin sees it. Returns null for anything
 * that is not shaped like one, without echoing the input.
 */
export function parseRoomJoinRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = text(value.id);
  const roomId = text(value.room_id);
  const accountId = text(value.account_id);
  const login = text(value.login);
  const createdAt = text(value.created_at);
  if (!id || !roomId || !accountId || !login || !createdAt) return null;
  if (!ROOM_JOIN_REQUEST_STATES.includes(value.state)) return null;
  const displayName = optionalText(value.display_name);
  const avatarUrl = optionalText(value.avatar_url);
  const decidedAt = optionalText(value.decided_at);
  const retryAfter = optionalText(value.retry_after);
  const decidedByLogin = optionalText(value.decided_by_login);
  const roomDisplayName = optionalText(value.room_display_name);
  if ([displayName, avatarUrl, decidedAt, retryAfter, decidedByLogin, roomDisplayName].some((field) => field === undefined)) return null;
  return {
    id,
    state: value.state,
    created_at: createdAt,
    decided_at: decidedAt,
    retry_after: retryAfter,
    room_id: roomId,
    account_id: accountId,
    login,
    display_name: displayName,
    avatar_url: avatarUrl,
    decided_by_login: decidedByLogin,
    room_display_name: roomDisplayName ?? '',
  };
}

/** Reads the `join_request` SSE payload: `{ room_id, access_room_id, request }`. */
export function parseRoomJoinRequestEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const roomId = text(value.room_id);
  const accessRoomId = text(value.access_room_id);
  const request = parseRoomJoinRequest(value.request);
  if (!roomId || !accessRoomId || !request) return null;
  return { room_id: roomId, access_room_id: accessRoomId, request };
}

/** The name the banner and the notification show for the person who asked. */
export function joinRequesterLabel(request) {
  const name = (request.display_name || '').trim();
  return name || request.login;
}

/** "Ada wants to join this room", or "2 people want to join this room". */
export function joinRequestBannerText(requests) {
  if (requests.length === 1) return `${joinRequesterLabel(requests[0])} wants to join this room`;
  return `${requests.length} people want to join this room`;
}

/** The desktop notification for one request: a title and a body. */
export function joinRequestNotificationText(request, roomDisplayName) {
  const room = (roomDisplayName || request.room_display_name || request.room_id || '').trim() || 'a room';
  return {
    title: `Join request in ${room}`,
    body: `${joinRequesterLabel(request)} wants to join`,
  };
}

/** "just now", "5 min ago", "3 h ago" or "2 d ago": when the person asked. */
export function joinRequestAskedLabel(createdAt, now = Date.now()) {
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return 'earlier';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/**
 * Decides whether a new request plays the alert sound. Every new request plays
 * once while the window is visible. While it is hidden, the sound plays at
 * most once per `hiddenIntervalMs`, so a burst of requests is one sound.
 */
export function createJoinRequestSoundGate(options = {}) {
  const now = options.now ?? Date.now;
  const hiddenIntervalMs = options.hiddenIntervalMs ?? JOIN_REQUEST_HIDDEN_SOUND_INTERVAL_MS;
  const played = new Set();
  let lastHiddenPlayAt = -Infinity;
  return {
    /** True when the sound should play now for this request. */
    shouldPlay(requestId, hidden) {
      if (played.has(requestId)) return false;
      played.add(requestId);
      if (played.size > 500) played.delete(played.values().next().value);
      if (!hidden) return true;
      const at = now();
      if (at - lastHiddenPlayAt < hiddenIntervalMs) return false;
      lastHiddenPlayAt = at;
      return true;
    },
    /** Marks a request the person already knows about, so it never plays. */
    remember(requestId) {
      played.add(requestId);
    },
    reset() {
      played.clear();
      lastHiddenPlayAt = -Infinity;
    },
  };
}
