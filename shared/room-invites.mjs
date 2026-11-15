// One-use invite codes for members-only rooms ("Invite a bot").
//
// A room member makes an invite; the app shows a message with the code for
// the bot's owner; the bot calls `join_code` with the code. An admin's invite
// lets the bot's account in at once (making the link is the approval). A
// member's invite asks the room's admins, as `request_room_access` does. A
// code works one time and ends after seven days. Rooms tied to a GitHub
// repository take no invites: their GitHub roles decide who is in.
//
// The server, the MCP tools and both apps read the names and texts from this
// one file.

/** The SSE event name on the account activity stream (the maker's own devices only). */
export const ROOM_INVITE_EVENT = 'room_invite';

/** How long a code works after it is made. */
export const ROOM_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ROOM_INVITE_PLATFORMS = Object.freeze(['grok', 'chatgpt', 'claude', 'other']);
export const ROOM_INVITE_KINDS = Object.freeze(['admit', 'request']);
export const ROOM_INVITE_STATES = Object.freeze(['open', 'used', 'cancelled', 'expired']);
export const ROOM_INVITE_OUTCOMES = Object.freeze(['admitted', 'requested']);

const PLATFORM_LABELS = Object.freeze({
  grok: 'Grok Bot',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  other: 'A bot',
});

/**
 * The letters of a code: no 0/O, 1/I/L, so a code read aloud or copied by
 * hand cannot be mistyped into another one. 31 letters, 8 places: about 40
 * bits, and a code works once and for seven days.
 */
export const ROOM_INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_SHAPE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
const MAX_TEXT = 512;

export function isRoomInvitePlatform(value) {
  return typeof value === 'string' && ROOM_INVITE_PLATFORMS.includes(value);
}

/** "Grok Bot", "ChatGPT", "Claude", or "A bot". */
export function roomInvitePlatformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? PLATFORM_LABELS.other;
}

/**
 * The code as the server keeps it: upper case, `XXXX-XXXX`. Spaces and a
 * missing or different dash are forgiven. Null when it is not a code.
 */
export function normalizeRoomInviteCode(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const letters = value.toUpperCase().replace(/[\s‐-―_-]+/g, '');
  if (letters.length !== 8) return null;
  const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
  return CODE_SHAPE.test(code) ? code : null;
}

/** Whether the value reads as a one-use invite code (not a room's own XXXX-XXXX-XXXX code). */
export function isRoomInviteCodeShape(value) {
  return normalizeRoomInviteCode(value) !== null;
}

/** The room line after an admin's invite let a bot in: "Grok Bot joined with EmmyMay's invite". */
export function roomInviteJoinedText(platform, makerLogin) {
  const maker = typeof makerLogin === 'string' && makerLogin.trim() ? makerLogin.trim() : 'someone';
  return `${roomInvitePlatformLabel(platform)} joined with ${maker}'s invite`;
}

function text(value) {
  return typeof value === 'string' && value.length <= MAX_TEXT ? value : null;
}

function optionalText(value) {
  if (value === null || value === undefined) return null;
  return text(value);
}

/**
 * Reads one invite as its maker sees it. Returns null for anything that is
 * not shaped like one, without echoing the input. The code is never part of
 * it: the server keeps only a hash.
 */
export function parseRoomInvite(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = text(value.id);
  const roomId = text(value.room_id);
  const createdAt = text(value.created_at);
  const expiresAt = text(value.expires_at);
  if (!id || !roomId || !createdAt || !expiresAt) return null;
  if (!ROOM_INVITE_PLATFORMS.includes(value.platform)) return null;
  if (!ROOM_INVITE_KINDS.includes(value.kind)) return null;
  if (!ROOM_INVITE_STATES.includes(value.state)) return null;
  const outcome = value.outcome === null || value.outcome === undefined
    ? null
    : ROOM_INVITE_OUTCOMES.includes(value.outcome) ? value.outcome : undefined;
  if (outcome === undefined) return null;
  return {
    id,
    room_id: roomId,
    room_display_name: text(value.room_display_name) ?? '',
    origin_room_id: optionalText(value.origin_room_id),
    platform: value.platform,
    kind: value.kind,
    state: value.state,
    outcome,
    created_at: createdAt,
    expires_at: expiresAt,
    used_at: optionalText(value.used_at),
    used_by_login: optionalText(value.used_by_login),
  };
}

/** Reads the `room_invite` SSE payload: `{ invite }`. */
export function parseRoomInviteEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const invite = parseRoomInvite(value.invite);
  return invite ? { invite } : null;
}
