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
 * advances immediately, `close()` settles waiters at once, and a subscriber
 * that arrives after the bump is answered without waiting at all.
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
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dependencies: DaemonStateWatchDependencies) {
    this.scheduleTimeout = dependencies.setTimeout ?? setTimeout;
    this.cancelTimeout = dependencies.clearTimeout ?? clearTimeout;
    this.coalesceMs = Number.isFinite(dependencies.coalesceMs)
      ? Math.max(0, Math.floor(dependencies.coalesceMs!))
      : 0;
  }

  notify(): void {
    this.sequence += 1;
    if (this.coalesceMs === 0) {
      this.releaseWaiters();
      return;
    }
    if (this.coalesceTimer !== null || this.waiters.size === 0) return;
    this.coalesceTimer = this.scheduleTimeout(() => {
      this.coalesceTimer = null;
      this.releaseWaiters();
    }, this.coalesceMs);
  }

  close(): void {
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    if (this.coalesceTimer !== null) {
      this.cancelTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async watch(input: DaemonStateWatchInput): Promise<DaemonStateWatchSnapshot> {
    const generation = this.dependencies.currentGeneration();
    const waitMs = Number.isFinite(input.waitMs)
      ? Math.max(0, Math.min(30_000, Math.floor(input.waitMs)))
      : 25_000;
    if (
      !this.dependencies.isHandoffScheduled()
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
        const timer = this.scheduleTimeout(finish, waitMs);
        this.waiters.add(finish);
      });
    }
    await this.dependencies.assertCurrent();
    return {
      daemon_generation: this.dependencies.currentGeneration(),
      sequence: this.sequence,
      // The room-level channel publishes activity summaries only. Full history
      // belongs to manifest.list and the per-agent inspector/stream reads.
      entries: projectStateWatchEntries(await this.dependencies.entries()),
    };
  }
}
