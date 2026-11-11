// Targeted @mention notification frame sent on a signed-in person's
// /account/activity/stream so unopened Focus/repo rooms and archived rooms
// still alert non-APNs desktop sessions without modifying archived state.

/** The SSE event name on /account/activity/stream. */
export const ROOM_MENTION_EVENT = 'room_mention';

const MAX_TEXT = 512;
const MESSAGE_ID_PATTERN = /^msg_[1-9]\d*$/;

function boundedText(value) {
  return typeof value === 'string' && value.length <= MAX_TEXT ? value : null;
}

function messageIdText(value) {
  const text = boundedText(value);
  return text && MESSAGE_ID_PATTERN.test(text) ? text : null;
}

/**
 * Parses a `room_mention` SSE payload:
 * `{ room_id, room_display_name, message_id, thread_root_id }`.
 * Returns null for malformed payloads.
 */
export function parseRoomMentionEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const roomId = boundedText(value.room_id)?.trim() || null;
  const messageId = messageIdText(value.message_id);
  if (!roomId || !messageId) return null;

  let roomDisplayName = '';
  if (value.room_display_name !== null && value.room_display_name !== undefined) {
    const parsedDisplayName = boundedText(value.room_display_name);
    if (parsedDisplayName === null) return null;
    roomDisplayName = parsedDisplayName;
  }

  let threadRootId = null;
  if (value.thread_root_id !== null && value.thread_root_id !== undefined) {
    threadRootId = messageIdText(value.thread_root_id);
    if (!threadRootId) return null;
  }

  return {
    room_id: roomId,
    room_display_name: roomDisplayName,
    message_id: messageId,
    thread_root_id: threadRootId,
  };
}
