import { shallowRef, toRaw } from "vue";
import type { DesktopRoomSnapshot } from "../../../electron/ipc-types";
import { normalizeRoomIdentifier } from "../domain/sidebar-rooms";

/**
 * The room whose rows on screen were painted from its cached snapshot while
 * its fresh read runs (the room is loading). The message viewport reads this:
 * it restores the scroll position on those rows at once, and treats the
 * fresh rows that replace them as a new baseline, not as new arrivals.
 */
const cachedPaintRoomKeys = shallowRef<ReadonlySet<string>>(new Set());

export function showCachedPaint(roomIdentifiers: readonly (string | null | undefined)[]): void {
  cachedPaintRoomKeys.value = new Set(roomIdentifiers
    .map(normalizeRoomIdentifier)
    .filter((key): key is string => Boolean(key)));
}

export function clearCachedPaint(): void {
  if (cachedPaintRoomKeys.value.size) cachedPaintRoomKeys.value = new Set();
}

/** Reactive: whether `roomIdentifier`'s rows came from a cached paint of this loading period. */
export function isCachedPaintShown(roomIdentifier: string | null | undefined): boolean {
  const key = normalizeRoomIdentifier(roomIdentifier);
  return Boolean(key && cachedPaintRoomKeys.value.has(key));
}

/**
 * A fresh read that failed for a passing reason (no answer, timeout, or a 5xx
 * or 408/429 answer). The rows on screen stay; an access refusal replaces them.
 * Same rule as `shouldPreserveCurrentRoomSnapshot` in desktop-room-snapshots.
 */
export function isTransientSnapshotFailure(snapshot: DesktopRoomSnapshot): boolean {
  if (snapshot.access.status !== "unavailable") return false;
  const httpStatus = snapshot.access.httpStatus;
  return httpStatus === null || [408, 429, 500, 502, 503, 504].includes(httpStatus);
}

/**
 * The last snapshot shown for each recently opened room, kept in memory for
 * this app session so a return to the room paints at once while its fresh
 * read runs (stale-while-revalidate). Nothing is written to disk.
 *
 * A room is kept only while its last known access is "ready": an entry is
 * dropped when a fresh read of the room is not ready, and the room is not
 * stored again until a fresh read is ready again. Cloud rooms of every kind
 * are kept; a local room is kept only when it is a focus room, as before.
 */
export class SelectedRoomSnapshotCache {
  /** Canonical room key -> snapshot, oldest first (LRU order). */
  private readonly entries = new Map<string, DesktopRoomSnapshot>();
  /** Any known identifier of a room (normalized) -> its canonical key. */
  private readonly aliases = new Map<string, string>();
  /** Room keys whose last fresh read was not ready. */
  private readonly refused = new Set<string>();

  constructor(
    private readonly limit: number,
    private readonly maxMessages: number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  read(roomIdentifier: string | null | undefined): DesktopRoomSnapshot | null {
    const key = this.canonicalKey(roomIdentifier);
    if (!key || this.refused.has(key)) return null;
    const snapshot = this.entries.get(key);
    if (!snapshot) return null;
    this.entries.delete(key);
    this.entries.set(key, snapshot);
    return snapshot;
  }

  /**
   * Stores what the room shows now, or drops the room when it may not be kept.
   * Only a fresh read that ended ready may add a room (`create`); any other
   * update (stream events, own sends) changes an entry that exists. A room
   * that was dropped (refused access, or left the account's room list) is
   * not stored again until a fresh ready read (`noteFreshAccess`).
   */
  remember(
    snapshot: DesktopRoomSnapshot | null,
    aliases: readonly (string | null | undefined)[] = [],
    { create = false }: { create?: boolean } = {},
  ): void {
    const keys = snapshotKeys(snapshot, aliases);
    if (!keys.length) return;
    if (!snapshot || !cacheableSnapshot(snapshot) || keys.some((key) => this.refused.has(key))) {
      this.forget(keys);
      return;
    }
    if (!create && !keys.some((key) => this.entries.has(this.aliases.get(key) || key))) return;
    const canonical = keys[0]!;
    for (const key of keys) {
      const previous = this.aliases.get(key);
      if (previous && previous !== canonical) this.forget([previous]);
      this.aliases.set(key, canonical);
    }
    const raw = toRaw(snapshot);
    const stored = raw.messages.length > this.maxMessages
      ? { ...raw, messages: raw.messages.slice(-this.maxMessages) }
      : raw;
    this.entries.delete(canonical);
    this.entries.set(canonical, stored);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.forget([oldest]);
    }
  }

  /**
   * Records the access of a fresh read of a room. A room whose fresh read is
   * not ready is dropped and is not stored again until a ready read.
   */
  noteFreshAccess(
    snapshot: DesktopRoomSnapshot,
    aliases: readonly (string | null | undefined)[] = [],
  ): void {
    const keys = snapshotKeys(snapshot, aliases);
    if (snapshot.access.status === "ready") {
      for (const key of keys) this.refused.delete(key);
      return;
    }
    this.drop(keys);
  }

  /**
   * Drops each named room (with its aliases) and keeps it out until a fresh
   * read of it is ready: a late stream update cannot store it again.
   */
  drop(roomIdentifiers: readonly (string | null | undefined)[]): void {
    const keys = new Set<string>();
    for (const identifier of roomIdentifiers) {
      const key = normalizeRoomIdentifier(identifier);
      if (!key) continue;
      const canonical = this.aliases.get(key) || key;
      keys.add(key);
      keys.add(canonical);
      for (const [alias, target] of this.aliases) if (target === canonical) keys.add(alias);
    }
    this.forget([...keys]);
    for (const key of keys) this.refused.add(key);
  }

  /** Drops each named room together with every alias of it. */
  forget(roomIdentifiers: readonly (string | null | undefined)[]): void {
    const canonicalKeys = new Set<string>();
    for (const identifier of roomIdentifiers) {
      const key = normalizeRoomIdentifier(identifier);
      if (!key) continue;
      canonicalKeys.add(this.aliases.get(key) || key);
    }
    if (!canonicalKeys.size) return;
    for (const key of canonicalKeys) this.entries.delete(key);
    for (const [alias, canonical] of [...this.aliases]) {
      if (canonicalKeys.has(canonical) || canonicalKeys.has(alias)) this.aliases.delete(alias);
    }
  }

  clear(): void {
    this.entries.clear();
    this.aliases.clear();
    this.refused.clear();
  }

  private canonicalKey(roomIdentifier: string | null | undefined): string | null {
    const key = normalizeRoomIdentifier(roomIdentifier);
    return key ? this.aliases.get(key) || key : null;
  }
}

function cacheableSnapshot(snapshot: DesktopRoomSnapshot): boolean {
  return snapshot.access.status === "ready"
    && (snapshot.room?.kind === "focus" || snapshot.storage?.effectiveMode !== "local");
}

/** The snapshot's own key first, then every other identifier it is known by. */
function snapshotKeys(
  snapshot: DesktopRoomSnapshot | null,
  aliases: readonly (string | null | undefined)[],
): string[] {
  const keys = [snapshot?.roomIdentifier, snapshot?.room?.identifier, ...aliases]
    .map(normalizeRoomIdentifier)
    .filter((key): key is string => Boolean(key));
  return [...new Set(keys)];
}

/**
 * What the room would show had the cached snapshot never been painted: the
 * placeholder the uncached path shows, plus every change made after the
 * paint (stream events, own sends). A value still identical to the painted
 * one came from the cache and is replaced by the placeholder's; in a changed
 * list only the items that came from the cache are removed.
 */
export function withoutCachedPaint(
  current: DesktopRoomSnapshot,
  painted: DesktopRoomSnapshot,
  placeholder: DesktopRoomSnapshot,
): DesktopRoomSnapshot {
  const rawCurrent = toRaw(current) as unknown as Record<string, unknown>;
  const rawPainted = toRaw(painted) as unknown as Record<string, unknown>;
  const result = { ...placeholder } as unknown as Record<string, unknown>;
  for (const key of Object.keys(rawCurrent)) {
    const value = toRaw(rawCurrent[key]);
    const paintedValue = toRaw(rawPainted[key]);
    if (value === paintedValue) continue;
    if (Array.isArray(value) && Array.isArray(paintedValue)) {
      result[key] = withoutPaintedItems(value, paintedValue);
    } else if (key === "githubEvents" && isEventsPage(value) && isEventsPage(paintedValue)) {
      const events = withoutPaintedItems(value.events, paintedValue.events);
      result[key] = events.length ? { ...value, events } : (placeholder.githubEvents ?? null);
    } else {
      result[key] = value;
    }
  }
  return result as unknown as DesktopRoomSnapshot;
}

function withoutPaintedItems<T>(items: readonly T[], painted: readonly T[]): T[] {
  const paintedItems = new Set(painted.map((item) => toRaw(item)));
  return items.filter((item) => !paintedItems.has(toRaw(item)));
}

function isEventsPage(value: unknown): value is { events: unknown[] } {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { events?: unknown }).events));
}
