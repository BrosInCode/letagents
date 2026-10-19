import type { ActivityShape, CommittedActivityWrite, ManifestStore } from "./manifest-store.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "./types.js";

/**
 * The most bytes of stored activity the windows hold together. One entry's
 * window is at most 200 events, each with a payload of at most 32 KiB after
 * redaction; usually it is a few hundred KiB. The least recently read windows
 * are dropped first.
 */
export const RECENT_ACTIVITY_WINDOWS_MAX_BYTES = 16 * 1024 * 1024;

type Window = { events: DaemonActivityEvent[]; bytes: number[]; totalBytes: number };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function sameStoredFields(left: DaemonActivityEvent, right: DaemonActivityEvent): boolean {
  return left.sequence === right.sequence && left.observed_at === right.observed_at
    && left.provider === right.provider && left.kind === right.kind && left.method === right.method
    && left.summary === right.summary && left.status === right.status
    && left.payload_truncated === right.payload_truncated && left.payload_redacted === right.payload_redacted
    && left.durable_payload_ref === right.durable_payload_ref;
}

/**
 * The provider stream classifies each event against its entry's recent
 * activity, which a full read rebuilds from up to 200 stored events with their
 * payloads, for every event. These windows keep that stored activity in memory
 * per entry, so a read needs only the entry without payloads.
 *
 * A window is never trusted on its own. Each read takes, from one snapshot,
 * the entry with its newest stored events (without payloads) and the shape of
 * its whole stored activity (count, sum of sequences, first sequence). The
 * window is used only when it has the same shape and the same newest events;
 * otherwise the read is the full read, as before, and the window is rebuilt
 * from it. So a write that did not come through the activity batches (a turn
 * notice, an entry replacement, another daemon) costs one full read, never a
 * stale answer.
 *
 * The check relies on one rule of every activity writer: stored events are
 * appended with a newer sequence and trimmed from the oldest, never changed
 * in place. A writer that rewrote an older event's payload, and kept every
 * checked field the same, would not be seen; none does.
 *
 * Events the batches commit are added to the window after their commit, as a
 * full read would return them. The result of read() is the same as
 * overlay(getEntry(entryId)): the batcher's overlay adds the events that are
 * admitted but not yet committed. Window events are frozen and shared between
 * reads; readers must not change them (the provider stream only reads them).
 */
export class RecentActivityWindows {
  /** In order of last use, oldest first. */
  private readonly windows = new Map<string, Window>();
  private totalBytes = 0;

  constructor(private readonly ports: {
    store: Pick<ManifestStore, "getEntry" | "getEntrySummaryWithActivityShape">;
    overlay<T extends DaemonManifestEntry | undefined>(entry: T): T;
    maxBytes?: number;
  }) {}

  /** The same entry as overlay(store.getEntry(entryId)). */
  async read(entryId: string): Promise<DaemonManifestEntry | undefined> {
    const current = await this.ports.store.getEntrySummaryWithActivityShape(entryId);
    if (!current) {
      this.forget(entryId);
      return this.ports.overlay(undefined);
    }
    const committed = this.match(entryId, current.activityShape, current.entry.activity ?? []);
    if (committed && current.entry.activity !== undefined) {
      return this.ports.overlay({ ...current.entry, activity: committed });
    }
    if (committed && !committed.length) return this.ports.overlay(current.entry);
    const full = await this.ports.store.getEntry(entryId);
    if (full) this.seed(entryId, full.activity ?? []);
    else this.forget(entryId);
    return this.ports.overlay(full);
  }

  /** Adds events a batch committed, in commit order, to the windows that exist. */
  committed(writes: readonly CommittedActivityWrite[]): void {
    for (const write of writes) {
      const window = this.windows.get(write.agentId);
      if (!window) continue;
      // A full read that ran after this commit already holds the event.
      if (write.event.sequence <= (window.events.at(-1)?.sequence ?? Number.NEGATIVE_INFINITY)) continue;
      window.events.push(deepFreeze(write.event));
      window.bytes.push(write.bytes);
      window.totalBytes += write.bytes;
      this.totalBytes += write.bytes;
      while (window.events.length > write.limit) {
        window.events.shift();
        const bytes = window.bytes.shift()!;
        window.totalBytes -= bytes;
        this.totalBytes -= bytes;
      }
    }
    this.evict();
  }

  /** Drops one entry's window, or every window. */
  forget(entryId?: string): void {
    if (entryId === undefined) {
      this.windows.clear();
      this.totalBytes = 0;
      return;
    }
    const window = this.windows.get(entryId);
    if (!window) return;
    this.windows.delete(entryId);
    this.totalBytes -= window.totalBytes;
  }

  get size(): number {
    return this.windows.size;
  }

  private match(entryId: string, shape: ActivityShape, newest: readonly DaemonActivityEvent[]): DaemonActivityEvent[] | null {
    const window = this.windows.get(entryId);
    if (!window) return null;
    const events = window.events;
    let sequenceTotal = 0;
    for (const event of events) sequenceTotal += event.sequence;
    const tail = events.slice(-newest.length);
    if (events.length !== shape.count || sequenceTotal !== shape.sequenceTotal
      || (events[0]?.sequence ?? null) !== shape.firstSequence
      || newest.length > events.length
      || !newest.every((event, index) => sameStoredFields(event, tail[index]!))) {
      this.forget(entryId);
      return null;
    }
    // Most recently used last.
    this.windows.delete(entryId);
    this.windows.set(entryId, window);
    return events.slice();
  }

  private seed(entryId: string, activity: readonly DaemonActivityEvent[]): void {
    this.forget(entryId);
    const bytes = activity.map((event) => JSON.stringify(event).length);
    const window: Window = {
      events: activity.map((event) => deepFreeze(event)),
      bytes,
      totalBytes: bytes.reduce((total, value) => total + value, 0),
    };
    this.windows.set(entryId, window);
    this.totalBytes += window.totalBytes;
    this.evict();
  }

  private evict(): void {
    const maxBytes = this.ports.maxBytes ?? RECENT_ACTIVITY_WINDOWS_MAX_BYTES;
    for (const [entryId] of this.windows) {
      if (this.totalBytes <= maxBytes) return;
      this.forget(entryId);
    }
  }
}
