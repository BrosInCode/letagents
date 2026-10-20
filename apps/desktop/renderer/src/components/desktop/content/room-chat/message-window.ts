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
//   in chunks while the reader scrolls down, and drops rows far above the
//   reader as it grows (the viewport keeps the visible row in place);
// - at the bottom, and on a room change, the range returns to the newest entries.
// The budget counts rows: a GitHub group counts up to `githubGroupRowLimit`.

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
/**
 * Rows a closed GitHub group shows before "Show earlier updates". It is also
 * the most a group counts toward the window budget: a group is one entry but
 * mounts one row per artifact.
 */
export const githubGroupRowLimit = 50;

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

/** Rows an entry can mount, for the window budget. */
export function entryWeight(entry: WindowEntry): number {
  return entry.type === "github-group" && entry.messages ? Math.max(1, Math.min(entry.messages.length, githubGroupRowLimit)) : 1;
}

/** The first index of the entries above `end` that together weigh `budget`. */
export function startForBudget(entries: readonly WindowEntry[], end: number, budget: number): number {
  let start = Math.min(end, entries.length);
  let total = 0;
  while (start > 0 && total < budget) {
    start -= 1;
    total += entryWeight(entries[start]!);
  }
  return start;
}

/** Total weight of `entries.slice(start, end)`. */
export function windowWeight(entries: readonly WindowEntry[], start: number, end: number): number {
  let total = 0;
  for (let index = Math.max(0, start); index < Math.min(end, entries.length); index += 1) total += entryWeight(entries[index]!);
  return total;
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
 * The mounted range. Its budget counts rows, so a GitHub group counts as up
 * to `githubGroupRowLimit` entries. A pinned message (the open thread root)
 * near the range is pulled inside it; the viewport keeps a far one mounted
 * but hidden (see `pinnedOutside`). A day divider directly above the first
 * entry is included, so the top edge never shows a day without its divider.
 */
export function resolveWindowBounds(
  entries: readonly WindowEntry[],
  state: MessageWindowState,
  indexById: ReadonlyMap<string, number>,
  pinnedIds: ReadonlyArray<string | null | undefined> = [],
  size = messageWindowSize,
): WindowBounds {
  const length = entries.length;
  const latestStart = startForBudget(entries, length, size);
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

/** Pinned entry indexes outside the range, oldest first. */
export function pinnedOutside(bounds: WindowBounds, indexById: ReadonlyMap<string, number>, pinnedIds: ReadonlyArray<string | null | undefined>): number[] {
  const outside = new Set<number>();
  for (const id of pinnedIds) {
    const index = id ? indexById.get(id) : undefined;
    if (index !== undefined && (index < bounds.start || index >= bounds.end)) outside.add(index);
  }
  return [...outside].sort((a, b) => a - b);
}

/** The state after mounting `chunk` more rows above the range, or null at the top. */
export function grownUpwardState(entries: readonly WindowEntry[], bounds: WindowBounds, chunk = messageWindowChunk): MessageWindowState | null {
  if (bounds.start <= 0) return null;
  return windowStateFor(entries, startForBudget(entries, bounds.start, chunk), bounds.end);
}

/**
 * The state after mounting `chunk` more entries below a detached range, or
 * null when it already reaches the newest entry. Within a chunk of the newest
 * entries the range joins them, so new messages mount again. When the range
 * grows past `size + 2 * chunk` rows, its top drops to `size + chunk` rows
 * above the new end; the reader is near the old end, far below that, and the
 * viewport keeps the visible row in place.
 */
export function grownDownwardState(entries: readonly WindowEntry[], bounds: WindowBounds, chunk = messageWindowChunk, size = messageWindowSize): MessageWindowState | null {
  if (bounds.end >= entries.length) return null;
  const end = bounds.end + chunk >= entries.length - chunk ? entries.length : bounds.end + chunk;
  let start = bounds.start;
  if (windowWeight(entries, start, end) > size + 2 * chunk) start = Math.max(start, startForBudget(entries, end, size + chunk));
  return windowStateFor(entries, start, end);
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
