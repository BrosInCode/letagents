// A room link the desktop app opens: `letagents://in/<room>`, the same path
// the web uses (`https://letagents.chat/in/<room>`), so a link copied from
// one works in the other. The web page offers it as "Open in LetAgents
// Desktop"; the installed app registers the `letagents` scheme (see
// docs/desktop-release.md). An optional `?message=msg_N` reveals one message.
import {
  LETAGENTS_ROOM_ORIGIN,
  decodeRoomPath,
  encodeRoomPathIdentifier,
  isValidMessageId,
  parseLetAgentsMessageUrl,
} from './room-message-urls.mjs';

export const DESKTOP_LINK_SCHEME = 'letagents';

const MAX_ROOM_IDENTIFIER = 512;

/** A room identifier the link may carry: trimmed, bounded, no control characters. */
export function isValidRoomLinkIdentifier(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ROOM_IDENTIFIER
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** `letagents://in/<room>` with an optional `?message=msg_N`; '' for a room that cannot be linked. */
export function buildDesktopRoomLink(roomIdentifier, messageId = null) {
  const value = String(roomIdentifier ?? '').trim();
  if (!isValidRoomLinkIdentifier(value)) return '';
  const message = typeof messageId === 'string' && isValidMessageId(messageId.trim()) ? `?message=${messageId.trim()}` : '';
  return `${DESKTOP_LINK_SCHEME}://in/${encodeRoomPathIdentifier(value)}${message}`;
}

/**
 * Reads a room link: the app scheme (`letagents://in/<room>`) or the web form
 * (`https://letagents.chat/in/<room>`). Returns `{ roomIdentifier, messageId }`
 * or null; a link for anything else, such as an ask link, is null here.
 */
export function parseDesktopRoomLink(url, origin = LETAGENTS_ROOM_ORIGIN) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${DESKTOP_LINK_SCHEME}:`) {
    const web = parseLetAgentsMessageUrl(trimmed, origin);
    return web && isValidRoomLinkIdentifier(web.roomIdentifier) ? web : null;
  }
  // `letagents://in/<room>`: the host is the first path word, the rest is the room.
  if (parsed.hostname !== 'in' || parsed.username || parsed.password || parsed.port) return null;
  const rawRoom = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (!rawRoom) return null;
  const roomIdentifier = decodeRoomPath(rawRoom);
  if (!isValidRoomLinkIdentifier(roomIdentifier)) return null;
  const rawMessageId = parsed.searchParams.get('message');
  const messageId = rawMessageId && isValidMessageId(rawMessageId.trim()) ? rawMessageId.trim() : null;
  return { roomIdentifier, messageId };
}
