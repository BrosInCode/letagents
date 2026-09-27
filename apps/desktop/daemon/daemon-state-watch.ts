import { projectStateWatchEntries } from "./state-watch-projection.js";
import type { DaemonManifestEntryView } from "./types.js";

/**
 * How long a state change waits for its neighbours before waking subscribers.
 *
 * Worker-binding republication is periodic per agent, so a fleet of running
 * agents produces bursts of unrelated sequence changes. Each wake costs one
 * full manifest read plus one snapshot serialization, so a short window
 * collapses a burst into one snapshot. It is a bounded delay on an
 * already-asynchronous observation, never a gate on authority: the sequence
 * advances immediately and `close()` settles waiters at once. Changes during
 * an in-flight projection also coalesce its follow-up, so a busy producer
 * cannot bypass the window merely by keeping the subscriber's cursor behind.
 */
export const STATE_WATCH_NOTIFICATION_COALESCE_MS = 150;

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
}

export interface DaemonStateWatchSnapshot {
  daemon_generation: number;
  sequence: number;
  entries: DaemonManifestEntryView[];
}

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

  async watch(input: DaemonStateWatchInput): Promise<DaemonStateWatchSnapshot> {
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
      if (snapshot.daemon_generation === this.dependencies.currentGeneration()) return snapshot;
    }
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
        promise: Promise.resolve().then(async () => ({
          daemon_generation: generation,
          sequence,
          // Full history belongs to manifest.list and per-agent inspection.
          entries: projectStateWatchEntries(await this.dependencies.entries()),
        })),
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
