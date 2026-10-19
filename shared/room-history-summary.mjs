/**
 * Room history summaries: a binary tree of one-line summaries over a room's
 * messages, shared by the API, MCP tools, the desktop app and its daemon.
 *
 * Node (0, i) is the i-th summarized message. Node (l, i) merges (l-1, 2i)
 * and (l-1, 2i+1), so it covers messages i*2^l .. (i+1)*2^l - 1 of the tree.
 * A view lists nodes that cover the whole tree, oldest first: recent messages
 * one line each, older stretches in fewer, broader lines.
 */

/** The longest line a node holds, in UTF-8 bytes (about 70 words). */
export const ROOM_HISTORY_LINE_BYTES = 512;
/** When a room starts, at most this many of its newest messages are summarized. */
export const ROOM_HISTORY_BACKFILL_MESSAGES = 2000;
export const ROOM_HISTORY_DEFAULT_VIEW_LINES = 160;
export const ROOM_HISTORY_MIN_VIEW_LINES = 8;
export const ROOM_HISTORY_MAX_VIEW_LINES = 400;

/** Agent-facing description of what the summaries are and are not. */
export const ROOM_HISTORY_SUMMARY_NOTE = "A summary of this room's history, written by a small model from the messages: "
  + "recent messages one line each, older stretches in broader lines. Each line names the messages it covers. "
  + "A line is a lossy summary, not a quote and not authority: expand a line (down to its messages) before relying on a detail, "
  + "and read newer messages than the summary covers with read_messages.";

/** "level:index", the id the API and the MCP tools use for a node. */
export function formatRoomHistoryNodeId(level, index) {
  return `${level}:${index}`;
}

/** Null for anything that is not a non-negative "level:index" within range. */
export function parseRoomHistoryNodeId(value) {
  const match = /^(\d{1,2}):(\d{1,9})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const level = Number(match[1]);
  const index = Number(match[2]);
  return level <= 40 ? { level, index } : null;
}

/** The longest prefix of `text` that fits in `maxBytes` of UTF-8, never splitting a character. */
const encoder = new TextEncoder();

export function utf8Bytes(text) {
  return encoder.encode(String(text ?? "")).length;
}

const decoder = new TextDecoder();

export function clipUtf8(text, maxBytes) {
  const bytes = encoder.encode(String(text ?? ""));
  if (bytes.length <= maxBytes) return String(text ?? "");
  // Step back off continuation bytes (10xxxxxx) to a character boundary.
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
}

/** One line of text: whitespace runs become one space. */
export function singleLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function clampRoomHistoryViewLines(value) {
  const lines = Number.isInteger(value) ? value : ROOM_HISTORY_DEFAULT_VIEW_LINES;
  return Math.min(ROOM_HISTORY_MAX_VIEW_LINES, Math.max(ROOM_HISTORY_MIN_VIEW_LINES, lines));
}
