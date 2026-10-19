import type { ActivityWrite } from "./manifest-store.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "./types.js";

/**
 * How long an admitted activity event may wait for others before its batch is
 * written. Long enough that a streaming agent's burst of events, and events
 * from several agents at once, share one commit (and one disk sync); short
 * enough that a persisted view lags the live stream by less than a frame or
 * two of a person reading it. The live inspector stream does not wait for it.
 */
export const ACTIVITY_BATCH_WINDOW_MS = 50;

/**
 * The most events one transaction writes. About 64 small inserts take a few
 * milliseconds, so a burst never becomes one long transaction; a full batch is
 * written at once instead of waiting for the window.
 */
export const ACTIVITY_BATCH_MAX_EVENTS = 64;

/** How long close() waits for the manifest lane before it gives up a batch. */
export const ACTIVITY_BATCH_CLOSE_TIMEOUT_MS = 2_000;

export type ActivityWriteBatcherOptions = {
  /**
   * The manifest mutation lane, entered without the activity flush that every
   * other mutation runs first. Admission and flushes both run inside it, so
   * they are ordered with every other manifest mutation.
   */
  serialize<T>(operation: () => Promise<T>): Promise<T>;
  /** Write one batch in one transaction and accept its manifest generation. */
  commit(items: readonly ActivityWrite[]): Promise<void>;
  /**
   * Events that could not be written. After a failed batch each event is
   * retried once on its own, so one bad event costs only itself, as a failed
   * single write did; what still fails is dropped and reported here.
   */
  diagnostic?(error: unknown, dropped: number): void;
  /**
   * False for an error that no retry can fix, such as lost authority: the
   * batch is then dropped without per-event retries. Default: retry.
   */
  retryable?(error: unknown): boolean;
  windowMs?: number;
  maxEvents?: number;
  closeTimeoutMs?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

/**
 * Groups admitted native activity events into short batches so that a busy
 * stream costs one commit per window instead of one per event. Only activity
 * events use it; every other daemon write stays one commit each.
 *
 * Ordering rules:
 * - Admission, flushes and all other manifest mutations share one lane, and
 *   every other mutation writes pending activity first (flushInLane). So the
 *   commit order of activity against every other manifest write is the order
 *   in which they were admitted, and a load-then-write never misses an event.
 * - Events of one entry are written in admission order; their sequences were
 *   checked against committed plus pending events at admission.
 * - The state notification for an event fires from the commit fence, after
 *   its batch commits.
 *
 * A crash loses at most the events of the current window: they were admitted
 * but not yet committed.
 */
export class ActivityWriteBatcher {
  private pending: ActivityWrite[] = [];
  /** Taken from pending by a flush whose commit has not finished. Still visible to overlay(). */
  private inFlight: ActivityWrite[] = [];
  private timer: unknown = null;
  private closed = false;
  /** The flush running now, possibly inside another mutation's lane turn. */
  private current: Promise<void> | null = null;
  private readonly windowMs: number;
  private readonly maxEvents: number;
  private readonly closeTimeoutMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: ActivityWriteBatcherOptions) {
    this.windowMs = options.windowMs ?? ACTIVITY_BATCH_WINDOW_MS;
    this.maxEvents = options.maxEvents ?? ACTIVITY_BATCH_MAX_EVENTS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? ACTIVITY_BATCH_CLOSE_TIMEOUT_MS;
    this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get size(): number {
    return this.pending.length + this.inFlight.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Runs an admission inside the manifest lane without flushing first. */
  serializeAdmission<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.serialize(operation);
  }

  /** Call inside serializeAdmission, after the event was validated. */
  admit(item: ActivityWrite): void {
    if (this.closed) throw new Error("Daemon activity writes are closed.");
    this.pending.push(item);
    if (this.pending.length >= this.maxEvents) {
      this.cancelTimer();
      // The caller holds the lane; the flush runs as soon as it is released.
      void this.flush();
    } else if (this.timer === null) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        void this.flush();
      }, this.windowMs);
      const handle = this.timer as { unref?: () => void };
      handle.unref?.();
    }
  }

  /** The newest pending sequence and runtime state of one entry, for admission. */
  pendingState(entryId: string): { lastSequence: number; observedState: DaemonManifestEntry["observed_state"] | null } | null {
    const items = this.unwritten(entryId);
    if (!items.length) return null;
    const withRuntime = items.filter((item) => item.runtimeUpdate);
    return {
      lastSequence: items.at(-1)!.event.sequence,
      observedState: withRuntime.at(-1)?.runtimeUpdate?.observedState ?? null,
    };
  }

  /**
   * Adds this entry's admitted but uncommitted events to a committed read, as
   * the write will apply them, so a reader that acts on its own entry's recent
   * activity (the provider stream) sees what it already admitted.
   */
  overlay<T extends DaemonManifestEntry | undefined>(entry: T): T {
    if (!entry) return entry;
    const committed = entry.activity?.at(-1)?.sequence ?? Number.NEGATIVE_INFINITY;
    const fresh = this.unwritten(entry.id).filter((item) => item.event.sequence > committed);
    if (!fresh.length) return entry;
    const activity = [...(entry.activity ?? []), ...fresh.map((item) => structuredClone(item.event) as DaemonActivityEvent)]
      .slice(-fresh.at(-1)!.limit);
    const runtime = fresh.filter((item) => item.runtimeUpdate).at(-1)?.runtimeUpdate;
    return {
      ...entry,
      activity,
      ...(runtime ? { observed_state: runtime.observedState, native_liveness: { ...runtime.nativeLiveness } } : {}),
    };
  }

  /** Writes everything pending. Enters the manifest lane itself. */
  flush(): Promise<void> {
    if (this.closed || !this.pending.length) return Promise.resolve();
    return this.options.serialize(() => this.flushInLane()).catch((error: unknown) => {
      // The lane refused to start: this daemon no longer owns the state, so
      // nothing pending may be written. Report it; never reject a timer.
      const dropped = this.pending.length;
      this.pending = [];
      if (dropped) this.options.diagnostic?.(error, dropped);
    });
  }

  /**
   * Writes everything pending, in batches of at most maxEvents. The caller
   * must hold the manifest lane: every other manifest mutation calls this
   * first. A batch that fails is dropped and reported; it never fails the
   * mutation that asked for the flush.
   */
  flushInLane(): Promise<void> {
    const run = this.writePending();
    this.current = run;
    void run.finally(() => { if (this.current === run) this.current = null; });
    return run;
  }

  private async writePending(): Promise<void> {
    this.cancelTimer();
    while (!this.closed && this.pending.length) {
      const batch = this.pending.splice(0, this.maxEvents);
      this.inFlight = batch;
      try {
        await this.options.commit(batch);
      } catch (error) {
        await this.retryEachOnce(batch, error);
      } finally {
        this.inFlight = [];
      }
    }
  }

  /** Still inside the lane, with the same commit (and fence) as the batch. */
  private async retryEachOnce(batch: ActivityWrite[], batchError: unknown): Promise<void> {
    if (batch.length === 1 || this.options.retryable?.(batchError) === false) {
      this.options.diagnostic?.(batchError, batch.length);
      return;
    }
    let failed = 0;
    let lastError: unknown = batchError;
    for (const item of batch) {
      try {
        await this.options.commit([item]);
      } catch (error) {
        failed += 1;
        lastError = error;
        if (this.options.retryable?.(error) === false) {
          const rest = batch.length - batch.indexOf(item) - 1;
          this.options.diagnostic?.(error, failed + rest);
          return;
        }
      }
    }
    if (failed) this.options.diagnostic?.(lastError, failed);
  }

  /**
   * Writes what is pending, then refuses new events and stops the timer. Waits
   * for the manifest lane at most closeTimeoutMs; events it could not write
   * are dropped and reported, as a crash would lose them. After close nothing
   * is written, so no flush can run after the database closes.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.cancelTimer();
    let timedOut = false;
    let timeout: unknown = null;
    await Promise.race([
      // A batch may be in flight inside another mutation's lane turn while
      // nothing is pending: wait for it too, so its commit is queued before
      // the caller releases authority.
      (async () => { await this.current?.catch(() => undefined); await this.flush(); })(),
      new Promise<void>((resolve) => {
        timeout = this.setTimer(() => { timedOut = true; resolve(); }, this.closeTimeoutMs);
        (timeout as { unref?: () => void }).unref?.();
      }),
    ]);
    if (timeout !== null) this.clearTimer(timeout);
    this.closed = true;
    this.cancelTimer();
    const dropped = this.pending.length;
    this.pending = [];
    if (dropped) this.options.diagnostic?.(new Error(timedOut
      ? "The manifest lane stayed busy while daemon activity writes closed."
      : "Daemon activity writes closed with events still pending."), dropped);
  }

  private unwritten(entryId: string): ActivityWrite[] {
    return [...this.inFlight, ...this.pending].filter((item) => item.agentId === entryId);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
