// A bounded mount window for the room timeline.
//
// The viewport mounts a contiguous range of timeline entries, not the whole
// loaded history:
// - a room opens on the newest `messageWindowSize` entries;
// - the range grows upward in chunks while the reader scrolls up (the viewport
//   keeps the visible row in place with its scroll-anchor code);
// - a jump to a loaded message outside the range extends the range when the
//   message is near, or moves the range to the message when it is far away.
//   Such a detached range does not reach the newest entry; it grows downward
//   in chunks while the reader scrolls down;
// - at the bottom, and on a room change, the range returns to the newest entries.
// Rows above the reader never leave while the reader is above the bottom, so
// no row moves under the reader.

/** Newest timeline entries mounted when a room opens or the reader follows. */
export const messageWindowSize = 200;
/** Entries added at an edge each time the reader nears it. */
export const messageWindowChunk = 100;
/** Entries kept above a jump target. */
export const messageWindowTargetAbove = 40;
/** Entries kept below a jump target in a detached window. */
export const messageWindowTargetBelow = 100;
/** A target this close to the window extends it instead of moving it. */
export const messageWindowReach = 300;

export interface WindowEdge {
  /** The first (start) or last (end) message of the range. */
  messageId: string;
  /** Last known entry index, used only when the message has gone. */
  index: number;
}

export type MessageWindowState =
  /** The newest `messageWindowSize` entries. Slides only while following. */
  | { kind: "latest" }
  /**
   * A fixed range. `start: null` is the top of the loaded history (older pages
   * mount as they arrive). `end: null` is the newest entry (new messages mount).
   */
  | { kind: "range"; start: WindowEdge | null; end: WindowEdge | null };

export interface WindowEntry {
  type: string;
  message?: { id: string };
  messages?: ReadonlyArray<{ id: string }>;
}

/** Mounted entries are `entries.slice(start, end)`. */
export interface WindowBounds {
  start: number;
  end: number;
}

/** Message ids an entry renders: one message, a GitHub group, or none. */
export function entryMessageIds(entry: WindowEntry): readonly string[] {
  if (entry.type === "message" && entry.message) return [entry.message.id];
  if (entry.type === "github-group" && entry.messages) return entry.messages.map(message => message.id);
  return [];
}

/** Message id -> index of the timeline entry that renders it. */
export function indexEntriesByMessageId(entries: readonly WindowEntry[]): Map<string, number> {
  const index = new Map<string, number>();
  entries.forEach((entry, position) => {
    for (const id of entryMessageIds(entry)) index.set(id, position);
  });
  return index;
}

/** The first message at or after `index`. */
export function firstMessageIdFrom(entries: readonly WindowEntry[], index: number): string | null {
  for (let position = Math.max(0, index); position < entries.length; position += 1) {
    const ids = entryMessageIds(entries[position]!);
    if (ids.length) return ids[0]!;
  }
  return null;
}

/** The last message at or before `index`. */
export function lastMessageIdUpTo(entries: readonly WindowEntry[], index: number): string | null {
  for (let position = Math.min(entries.length - 1, index); position >= 0; position -= 1) {
    const ids = entryMessageIds(entries[position]!);
    if (ids.length) return ids[ids.length - 1]!;
  }
  return null;
}

function startEdge(entries: readonly WindowEntry[], start: number): WindowEdge | null {
  if (start <= 0) return null;
  const messageId = firstMessageIdFrom(entries, start);
  return messageId ? { messageId, index: start } : null;
}

function endEdge(entries: readonly WindowEntry[], end: number): WindowEdge | null {
  if (end >= entries.length) return null;
  const messageId = lastMessageIdUpTo(entries, end - 1);
  return messageId ? { messageId, index: end - 1 } : null;
}

/** A state for the range `[start, end)` of the current entries. */
export function windowStateFor(entries: readonly WindowEntry[], start: number, end: number): MessageWindowState {
  return { kind: "range", start: startEdge(entries, start), end: endEdge(entries, end) };
}

/**
 * The mounted range. A pinned message (the open thread root) near the range is
 * pulled inside it. A day divider directly above the first entry is included,
 * so the top edge never shows a day without its divider.
 */
export function resolveWindowBounds(
  entries: readonly WindowEntry[],
  state: MessageWindowState,
  indexById: ReadonlyMap<string, number>,
  pinnedIds: ReadonlyArray<string | null | undefined> = [],
  size = messageWindowSize,
): WindowBounds {
  const length = entries.length;
  const latestStart = Math.max(0, length - size);
  let start: number;
  let end: number;
  if (state.kind === "latest") {
    start = latestStart;
    end = length;
  } else {
    start = state.start ? indexById.get(state.start.messageId) ?? Math.min(Math.max(0, state.start.index), latestStart) : 0;
    end = state.end ? (indexById.get(state.end.messageId) ?? Math.min(state.end.index, length - 1)) + 1 : length;
    end = Math.min(length, Math.max(end, start + 1));
  }
  for (const id of pinnedIds) {
    const index = id ? indexById.get(id) : undefined;
    if (index === undefined) continue;
    if (index < start && start - index <= messageWindowReach) start = index;
    if (index >= end && index - end < messageWindowReach) end = index + 1;
  }
  if (start > 0 && entries[start]?.type !== "date" && entries[start - 1]?.type === "date") start -= 1;
  return { start, end };
}

/** The state after mounting `chunk` more entries above the range, or null at the top. */
export function grownUpwardState(entries: readonly WindowEntry[], bounds: WindowBounds, chunk = messageWindowChunk): MessageWindowState | null {
  if (bounds.start <= 0) return null;
  return windowStateFor(entries, bounds.start - chunk, bounds.end);
}

/**
 * The state after mounting `chunk` more entries below a detached range, or
 * null when it already reaches the newest entry. Within a chunk of the newest
 * entries the range joins them, so new messages mount again.
 */
export function grownDownwardState(entries: readonly WindowEntry[], bounds: WindowBounds, chunk = messageWindowChunk): MessageWindowState | null {
  if (bounds.end >= entries.length) return null;
  const end = bounds.end + chunk >= entries.length - chunk ? entries.length : bounds.end + chunk;
  return windowStateFor(entries, bounds.start, end);
}

/**
 * The state that mounts `messageId`. Null when the message is not loaded, or
 * is already inside the range. A near target extends the range; a far one
 * gets a detached range around it, unless the newest entries are near.
 */
export function windowStateIncluding(
  entries: readonly WindowEntry[],
  bounds: WindowBounds,
  indexById: ReadonlyMap<string, number>,
  messageId: string,
  size = messageWindowSize,
): MessageWindowState | null {
  const index = indexById.get(messageId);
  if (index === undefined) return null;
  if (index >= bounds.start && index < bounds.end) return null;
  const length = entries.length;
  const start = Math.max(0, index - messageWindowTargetAbove);
  if (index < bounds.start && bounds.start - index <= messageWindowReach) return windowStateFor(entries, start, bounds.end);
  if (index >= bounds.end && index - bounds.end < messageWindowReach) {
    return windowStateFor(entries, bounds.start, Math.min(length, index + messageWindowTargetBelow));
  }
  const end = index + messageWindowTargetBelow >= length - size ? length : index + messageWindowTargetBelow;
  return windowStateFor(entries, start, end);
}

/**
 * The scrollTop that keeps an anchor row at the same place on screen after
 * rows were added or removed above it.
 */
export function anchoredScrollTop(scrollTop: number, anchorOffsetBefore: number, anchorOffsetAfter: number): number {
  return Math.max(0, scrollTop + anchorOffsetAfter - anchorOffsetBefore);
}
