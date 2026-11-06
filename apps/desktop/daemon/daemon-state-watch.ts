import { isDeepStrictEqual } from "node:util";
import { projectStateWatchEntries } from "./state-watch-projection.js";
import type { DaemonManifestEntryView } from "./types.js";

/**
 * How long a state change waits for its neighbours before waking subscribers.
 *
 * Worker-binding republication is periodic per agent, so a fleet of running
 * agents produces bursts of unrelated sequence changes. Each wake costs one
 * manifest read plus one snapshot serialization, so a short window
 * collapses a burst into one snapshot. It is a bounded delay on an
 * already-asynchronous observation, never a gate on authority: the sequence
 * advances immediately and `close()` settles waiters at once. Changes during
 * an in-flight projection also coalesce its follow-up, so a busy producer
 * cannot bypass the window merely by keeping the subscriber's cursor behind.
 */
export const STATE_WATCH_NOTIFICATION_COALESCE_MS = 150;

/**
 * How many removed entries the watch remembers, so a subscriber whose cursor
 * is behind by that many removals still gets a changes-only answer. Beyond
 * it the oldest removals are forgotten and such a subscriber gets the whole
 * state again, which is always correct.
 */
export const STATE_WATCH_REMEMBERED_REMOVALS = 1_000;

export interface DaemonStateWatchDependencies {
  currentGeneration: () => number;
  isHandoffScheduled: () => boolean;
  assertCurrent: () => Promise<void>;
  entries: () => Promise<DaemonManifestEntryView[]>;
  /** Omitted (or 0) wakes waiters synchronously with the sequence bump. */
  coalesceMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface DaemonStateWatchInput {
  afterDaemonGeneration: number;
  afterSequence: number;
  waitMs: number;
  /**
   * Answer with only the entries whose view changed after `afterSequence`
   * when the watch still remembers that sequence; otherwise the whole state.
   * A subscriber that asks for this merges the answer into the state it holds.
   */
  changedOnly?: boolean;
}

/** The whole state: every entry, in manifest order. */
export interface DaemonStateWatchSnapshot {
  daemon_generation: number;
  sequence: number;
  entries: DaemonManifestEntryView[];
}

/**
 * The state since a subscriber's sequence: the entries whose view changed
 * (new ones included), the ids of entries that are gone, and the order of
 * every entry now. `complete: false` tells it from a whole snapshot.
 */
export interface DaemonStateWatchChanges {
  daemon_generation: number;
  sequence: number;
  complete: false;
  entries: DaemonManifestEntryView[];
  removed_entry_ids: string[];
  entry_order: string[];
}

export type DaemonStateWatchResult = DaemonStateWatchSnapshot | DaemonStateWatchChanges;

/**
 * What the last snapshot held, per entry: its view, the sequence at which the
 * view last changed, and the sequence at which a gone entry was last seen
 * removed. Changes are tracked per daemon generation from `since`, the first
 * tracked snapshot's sequence; a subscriber behind `since` gets the whole state.
 */
type TrackedViews = {
  generation: number;
  since: number;
  views: Map<string, DaemonManifestEntryView>;
  changedAt: Map<string, number>;
  removedAt: Map<string, number>;
};

export class DaemonStateWatch {
  private sequence = 1;
  private readonly waiters = new Set<() => void>();
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;
  private readonly coalesceMs: number;
  private coalescing: {
    timer: ReturnType<typeof setTimeout>;
    promise: Promise<void>;
    finish: () => void;
  } | null = null;
  private snapshotInFlight: {
    generation: number;
    sequence: number;
    promise: Promise<DaemonStateWatchSnapshot>;
  } | null = null;
  private tracked: TrackedViews | null = null;
  private closed = false;

  constructor(private readonly dependencies: DaemonStateWatchDependencies) {
    this.scheduleTimeout = dependencies.setTimeout ?? setTimeout;
    this.cancelTimeout = dependencies.clearTimeout ?? clearTimeout;
    this.coalesceMs = Number.isFinite(dependencies.coalesceMs)
      ? Math.max(0, Math.floor(dependencies.coalesceMs!))
      : 0;
  }

  notify(): void {
    this.sequence += 1;
    if (this.coalesceMs === 0 || this.closed || this.dependencies.isHandoffScheduled()) {
      this.releaseWaiters();
      return;
    }
    if (this.coalescing || (this.waiters.size === 0 && !this.snapshotInFlight)) return;
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => { finish = resolve; });
    const timer = this.scheduleTimeout(() => this.releaseWaiters(), this.coalesceMs);
    this.coalescing = { timer, promise, finish };
  }

  close(): void {
    this.closed = true;
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    if (this.coalescing) {
      this.cancelTimeout(this.coalescing.timer);
      this.coalescing.finish();
      this.coalescing = null;
    }
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async watch(input: DaemonStateWatchInput): Promise<DaemonStateWatchResult> {
    const generation = this.dependencies.currentGeneration();
    const waitMs = Number.isFinite(input.waitMs)
      ? Math.max(0, Math.min(30_000, Math.floor(input.waitMs)))
      : 25_000;
    let timedOut = false;
    if (
      !this.closed
      && !this.dependencies.isHandoffScheduled()
      && input.afterDaemonGeneration === generation
      && input.afterSequence >= this.sequence
      && waitMs > 0
    ) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.cancelTimeout(timer);
          this.waiters.delete(finish);
          resolve();
        };
        const timer = this.scheduleTimeout(() => { timedOut = true; finish(); }, waitMs);
        this.waiters.add(finish);
      });
    }
    for (;;) {
      await this.dependencies.assertCurrent();
      const snapshot = await this.snapshot(
        waitMs > 0 && !timedOut && input.afterDaemonGeneration === this.dependencies.currentGeneration(),
      );
      // Sharing a projection never shares a caller's authority check. A fence
      // can also be lost while the asynchronous read is in progress.
      await this.dependencies.assertCurrent();
      if (snapshot.daemon_generation === this.dependencies.currentGeneration()) {
        return input.changedOnly ? this.changesSince(input, snapshot) : snapshot;
      }
    }
  }

  /**
   * The snapshot cut down to what changed after the subscriber's sequence, when
   * the watch tracked views continuously from a sequence the subscriber has.
   * Everything else (an older cursor, another generation, a cursor from the
   * future) gets the whole snapshot.
   */
  private changesSince(input: DaemonStateWatchInput, snapshot: DaemonStateWatchSnapshot): DaemonStateWatchResult {
    const tracked = this.tracked;
    if (
      !tracked
      || tracked.generation !== snapshot.daemon_generation
      || input.afterDaemonGeneration !== snapshot.daemon_generation
      || !Number.isFinite(input.afterSequence)
      || input.afterSequence < tracked.since
      || input.afterSequence > snapshot.sequence
    ) {
      return snapshot;
    }
    const after = input.afterSequence;
    const removed: string[] = [];
    for (const [id, sequence] of tracked.removedAt) if (sequence > after) removed.push(id);
    return {
      daemon_generation: snapshot.daemon_generation,
      sequence: snapshot.sequence,
      complete: false,
      entries: snapshot.entries.filter((entry) => (tracked.changedAt.get(entry.id) ?? Number.POSITIVE_INFINITY) > after),
      removed_entry_ids: removed,
      entry_order: snapshot.entries.map((entry) => entry.id),
    };
  }

  /**
   * Record which views this snapshot changed against the previous one. Views
   * are compared whole: a view is the same only when every stored and derived
   * field is, so a liveness threshold crossing counts as a change too.
   * Snapshots are built one at a time in sequence order, so the sequence of
   * a change is the sequence of the first snapshot that showed it.
   */
  private track(snapshot: DaemonStateWatchSnapshot): void {
    const previous = this.tracked?.generation === snapshot.daemon_generation ? this.tracked : null;
    const views = new Map<string, DaemonManifestEntryView>();
    const changedAt = new Map<string, number>();
    const removedAt = new Map<string, number>(previous?.removedAt ?? []);
    for (const entry of snapshot.entries) {
      views.set(entry.id, entry);
      const before = previous?.views.get(entry.id);
      changedAt.set(entry.id, before && isDeepStrictEqual(before, entry)
        ? previous!.changedAt.get(entry.id) ?? snapshot.sequence
        : snapshot.sequence);
      removedAt.delete(entry.id);
    }
    if (previous) {
      for (const id of previous.views.keys()) if (!views.has(id)) removedAt.set(id, snapshot.sequence);
    }
    let since = previous?.since ?? snapshot.sequence;
    while (removedAt.size > STATE_WATCH_REMEMBERED_REMOVALS) {
      // Maps iterate in insertion order and a removal is re-inserted when it
      // recurs, so the first entry is the oldest. Forgetting it means a cursor
      // from before it can no longer be answered with changes only.
      const [id, sequence] = removedAt.entries().next().value as [string, number];
      removedAt.delete(id);
      since = Math.max(since, sequence);
    }
    this.tracked = { generation: snapshot.daemon_generation, since, views, changedAt, removedAt };
  }

  private async snapshot(coalesce: boolean): Promise<DaemonStateWatchSnapshot> {
    for (;;) {
      if (coalesce && !this.closed && !this.dependencies.isHandoffScheduled()) {
        await this.coalescing?.promise;
      }
      const generation = this.dependencies.currentGeneration();
      const sequence = this.sequence;
      const current = this.snapshotInFlight;
      if (current) {
        if (current.generation === generation && current.sequence >= sequence) return current.promise;
        // A mutation during the old read may be absent from its entries. Keep
        // its original sequence and build a successor after it settles.
        await current.promise.catch(() => undefined);
        continue;
      }
      const pending = {
        generation,
        sequence,
        promise: Promise.resolve().then(async () => {
          const snapshot: DaemonStateWatchSnapshot = {
            daemon_generation: generation,
            sequence,
            // Full history belongs to manifest.list and per-agent inspection.
            entries: projectStateWatchEntries(await this.dependencies.entries()),
          };
          this.track(snapshot);
          return snapshot;
        }),
      };
      this.snapshotInFlight = pending;
      try {
        return await pending.promise;
      } finally {
        if (this.snapshotInFlight === pending) this.snapshotInFlight = null;
      }
    }
  }
}
