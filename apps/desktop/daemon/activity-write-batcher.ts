import { ManifestConflictError, type ActivityWrite, type ManifestStore } from "./manifest-store.js";
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

/**
 * The longest one lane turn may spend retrying a failed batch event by event.
 * The lane also carries transitions, admissions and the desktop view.
 */
export const ACTIVITY_BATCH_RETRY_BUDGET_MS = 250;

// SQLite primary result codes that belong to one row's content.
const SQLITE_TOOBIG = 18;
const SQLITE_CONSTRAINT = 19;
const SQLITE_MISMATCH = 20;
const SQLITE_RANGE = 25;

/**
 * True for an error caused by one event's own content: a constraint, size or
 * type failure, or a payload that cannot be encoded. Only these make a
 * per-event retry useful. A busy or locked database, an I/O error, a
 * generation conflict (another writer committed first) or lost authority
 * would fail every event the same way, or could reorder an older event over
 * a newer write, so the batch is dropped instead.
 */
export function isSingleEventActivityError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errcode?: unknown } | null;
  if (candidate && candidate.code === "ERR_SQLITE_ERROR" && typeof candidate.errcode === "number") {
    const primary = candidate.errcode & 0xff;
    return primary === SQLITE_CONSTRAINT || primary === SQLITE_TOOBIG
      || primary === SQLITE_MISMATCH || primary === SQLITE_RANGE;
  }
  return error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError;
}

/**
 * One batch commit, as the daemon makes it. A generation conflict means a
 * writer outside the manifest lane committed first; within the lane none can,
 * since every other mutation flushes pending activity before it runs. The only
 * such writer is the retiring daemon's provider birth checkpoint
 * (ProviderExecutionCoordinator.persistReturnedProviderForHandoff), which
 * retires its entry's pending activity inside the commit lane right after it
 * commits. So the whole batch is retried once against the current generation,
 * with mayWrite still checked inside the transaction: the retired entry stays
 * skipped and every other entry's events, often their final idle state before
 * a handoff, are kept. A second conflict throws, and the batch is dropped.
 */
export async function commitActivityBatch(input: {
  store: Pick<ManifestStore, "recordActivityBatch" | "readGeneration">;
  items: readonly ActivityWrite[];
  expectedGeneration: number;
  fence: (commit: () => Promise<void>) => Promise<void>;
  mayWrite: (agentId: string) => boolean;
}): Promise<{ generation: number; written: number; skipped: number; retriedAfterConflict: boolean }> {
  try {
    const result = await input.store.recordActivityBatch(input.expectedGeneration, input.items, input.fence, input.mayWrite);
    return { ...result, retriedAfterConflict: false };
  } catch (error) {
    if (!(error instanceof ManifestConflictError)) throw error;
    const current = await input.store.readGeneration();
    const result = await input.store.recordActivityBatch(current, input.items, input.fence, input.mayWrite);
    return { ...result, retriedAfterConflict: true };
  }
}

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
   * Events that could not be written. A batch that failed because of one
   * event's content is retried event by event, so that event costs only
   * itself, as a failed single write did; what still fails is dropped and
   * reported here. Any other failure drops the batch.
   */
  diagnostic?(error: unknown, dropped: number): void;
  /** Whether a batch failure is worth a per-event retry. Default: isSingleEventActivityError. */
  retryPerEvent?(error: unknown): boolean;
  /** Total time a per-event retry may take in one lane turn. */
  retryBudgetMs?: number;
  now?: () => number;
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
  /** Entries whose provider birth a retiring daemon checkpointed; their activity is never written after it. */
  private readonly retired = new Set<string>();
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

  /**
   * A retiring daemon wrote this entry's provider birth outside the manifest
   * lane. Call inside the commit lane right after that commit: pending events
   * for the entry are dropped, and a batch that commits later skips them, so
   * older activity can never overwrite the birth record.
   */
  retireEntry(entryId: string): void {
    this.retired.add(entryId);
    const before = this.pending.length;
    this.pending = this.pending.filter((item) => item.agentId !== entryId);
    const dropped = before - this.pending.length;
    if (dropped) this.options.diagnostic?.(new Error(`Provider birth for ${entryId} was checkpointed during handoff.`), dropped);
  }

  /** Whether an event for this entry may still be written. Checked inside the batch transaction. */
  mayWrite(entryId: string): boolean {
    return !this.retired.has(entryId);
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

  /**
   * Still inside the lane, with the same commit (and fence) as the batch, and
   * only for a failure that belongs to one event. Stops at the first failure
   * of any other kind, and when the retry budget is spent.
   */
  private async retryEachOnce(batch: ActivityWrite[], batchError: unknown): Promise<void> {
    const perEvent = this.options.retryPerEvent ?? isSingleEventActivityError;
    if (batch.length === 1 || !perEvent(batchError)) {
      this.options.diagnostic?.(batchError, batch.length);
      return;
    }
    const now = this.options.now ?? (() => performance.now());
    const deadline = now() + (this.options.retryBudgetMs ?? ACTIVITY_BATCH_RETRY_BUDGET_MS);
    let failed = 0;
    let lastError: unknown = batchError;
    for (const [index, item] of batch.entries()) {
      if (now() > deadline) {
        this.options.diagnostic?.(new Error("The per-event activity retry ran out of time."), failed + batch.length - index);
        return;
      }
      try {
        await this.options.commit([item]);
      } catch (error) {
        failed += 1;
        lastError = error;
        if (!perEvent(error)) {
          this.options.diagnostic?.(error, failed + batch.length - index - 1);
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
