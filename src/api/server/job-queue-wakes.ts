/**
 * Event-driven job queues (Jev routing, desktop pushes, wake deliveries).
 *
 * A transaction that writes a due job row calls `wakeJobQueue` after it
 * commits, and the queue's worker in this process claims at once. Between
 * wakes a worker sleeps until the next row falls due (a retry, a scheduled
 * delivery, an expired lease), never longer than the fallback, so a lost
 * wake or a row written by another API process is still drained. Claims stay
 * `FOR UPDATE SKIP LOCKED`, so any process may take any row.
 */
import { EventEmitter } from "node:events";

export type JobQueue = "jev_routing" | "desktop_push" | "wake_delivery";

/** The longest a worker sleeps with no wake and nothing due sooner. */
export const JOB_QUEUE_FALLBACK_MS = 30_000;
/** After a failed pass (for example the database is unreachable), try again this soon. */
export const JOB_QUEUE_ERROR_RETRY_MS = 5_000;

const signals = new EventEmitter();
signals.setMaxListeners(0);

/** Call only after the transaction that made rows due has committed. */
export function wakeJobQueue(...queues: JobQueue[]): void {
  for (const queue of new Set(queues)) signals.emit(queue);
}

/** Observe one queue's wakes (tests). Returns the unsubscribe function. */
export function onJobQueueWake(queue: JobQueue, listener: () => void): () => void {
  signals.on(queue, listener);
  return () => { signals.off(queue, listener); };
}

export interface JobQueuePass {
  /** More rows may be claimable now (a full batch): run again at once. */
  again?: boolean;
  /** Milliseconds until the next row falls due, by the database clock; null when nothing waits. */
  nextDueInMs?: number | null;
}

export interface JobQueueLoopOptions {
  queue: JobQueue;
  label: string;
  run(): Promise<JobQueuePass>;
  fallbackMs?: number;
  errorRetryMs?: number;
  /** How a failed pass is logged; the default logs the error itself. */
  logError?(error: unknown): void;
}

export interface JobQueueLoop {
  /** Run a pass now, or right after the one in progress. */
  wake(): void;
  stop(): Promise<void>;
}

/**
 * One single-flight worker loop: a pass runs at start, on a wake, when the
 * next row falls due, and at the latest after `fallbackMs`. A wake during a
 * pass runs one more pass right after it, so a row committed while a claim
 * was in flight is never left for the fallback.
 */
export function startJobQueueLoop(options: JobQueueLoopOptions): JobQueueLoop {
  const fallbackMs = options.fallbackMs ?? JOB_QUEUE_FALLBACK_MS;
  const errorRetryMs = Math.min(fallbackMs, options.errorRetryMs ?? JOB_QUEUE_ERROR_RETRY_MS);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let wokenWhileRunning = false;

  const schedule = (ms: number) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      running = pass();
    }, ms);
    timer.unref?.();
  };

  async function pass(): Promise<void> {
    let delay = fallbackMs;
    try {
      const result = await options.run();
      if (result.again) delay = 0;
      else if (typeof result.nextDueInMs === "number" && Number.isFinite(result.nextDueInMs)) {
        // At least 1 ms: the row is strictly in the future by the database clock.
        delay = Math.min(fallbackMs, Math.max(1, Math.ceil(result.nextDueInMs)));
      }
    } catch (error) {
      if (options.logError) options.logError(error);
      else console.error(`[${options.label}] queue unavailable`, error);
      delay = errorRetryMs;
    }
    running = null;
    if (wokenWhileRunning) {
      wokenWhileRunning = false;
      delay = 0;
    }
    schedule(delay);
  }

  const wake = () => {
    if (stopped) return;
    if (running) wokenWhileRunning = true;
    else schedule(0);
  };
  signals.on(options.queue, wake);
  schedule(0);
  return {
    wake,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      signals.off(options.queue, wake);
      await running;
    },
  };
}

/** Milliseconds from the database's `now()` to a due time, as one query column. */
export const DUE_IN_MS_SQL = (expression: string) => `EXTRACT(EPOCH FROM ((${expression}) - now())) * 1000`;

/** Reads the `due_in_ms` column a next-due query returns. */
export function readDueInMs(row: { due_in_ms?: unknown } | undefined): number | null {
  if (!row || row.due_in_ms === null || row.due_in_ms === undefined) return null;
  const value = Number(row.due_in_ms);
  return Number.isFinite(value) ? value : null;
}
