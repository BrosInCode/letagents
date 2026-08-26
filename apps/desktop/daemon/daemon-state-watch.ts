import type { DaemonManifestEntryView } from "./types.js";

export interface DaemonStateWatchDependencies {
  currentGeneration: () => number;
  isHandoffScheduled: () => boolean;
  assertCurrent: () => Promise<void>;
  entries: () => Promise<DaemonManifestEntryView[]>;
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

  constructor(private readonly dependencies: DaemonStateWatchDependencies) {
    this.scheduleTimeout = dependencies.setTimeout ?? setTimeout;
    this.cancelTimeout = dependencies.clearTimeout ?? clearTimeout;
  }

  notify(): void {
    this.sequence += 1;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  close(): void {
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
      entries: await this.dependencies.entries(),
    };
  }
}
