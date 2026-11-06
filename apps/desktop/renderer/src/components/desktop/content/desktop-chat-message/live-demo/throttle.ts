import { LIVE_DEMO, type LiveDemoPoint } from "./protocol";
import { thinPoints } from "./stroke-simplify";

/** The time source of a throttle, so a test can run it without waiting. */
export interface ThrottleClock {
  now(): number;
  setTimer(run: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export const realThrottleClock: ThrottleClock = {
  now: () => performance.now(),
  setTimer: (run, delayMs) => setTimeout(run, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One cursor frame at most every 50 ms (20 a second). */
export const CURSOR_INTERVAL_MS = Math.ceil(1000 / LIVE_DEMO.cursorHz);
/** One ink frame at most every 34 ms (under the server's 30 a second). */
export const INK_INTERVAL_MS = Math.ceil(1000 / LIVE_DEMO.inkFramesPerSecond);

export interface LatestThrottle<T> {
  /** Sends `value` now if the interval has passed, or when it has, unless a newer value replaces it. */
  push(value: T): void;
  /** Forgets a value that waits. */
  cancel(): void;
}

/**
 * Sends the newest value at most once per `intervalMs`. The first value goes at
 * once; values that come too soon wait, and only the newest of them is sent, so
 * the last position of a moving pointer always arrives.
 */
export function createLatestThrottle<T>(
  intervalMs: number,
  send: (value: T) => void,
  clock: ThrottleClock = realThrottleClock,
): LatestThrottle<T> {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let waiting: { value: T } | null = null;
  let timer: unknown = null;

  function deliver(value: T): void {
    lastSentAt = clock.now();
    send(value);
  }

  return {
    push(value) {
      const wait = lastSentAt + intervalMs - clock.now();
      if (wait <= 0 && timer === null) {
        waiting = null;
        deliver(value);
        return;
      }
      waiting = { value };
      if (timer !== null) return;
      timer = clock.setTimer(() => {
        timer = null;
        const next = waiting;
        waiting = null;
        if (next) deliver(next.value);
      }, Math.max(0, wait));
    },
    cancel() {
      waiting = null;
      if (timer !== null) clock.clearTimer(timer);
      timer = null;
    },
  };
}

export interface InkBatcher {
  add(point: LiveDemoPoint): void;
  /** Sends what waits with the stroke's end flag, then stops. */
  end(): void;
  /** Drops what waits (a stroke that was cancelled). */
  cancel(): void;
}

/**
 * Collects the points of one stroke into ink frames: at most one frame per
 * INK_INTERVAL_MS and at most `maxPoints` points in it (a burst is thinned, the
 * saved stroke keeps every point). The first point goes at once.
 */
export function createInkBatcher(
  send: (points: LiveDemoPoint[], end: boolean) => void,
  clock: ThrottleClock = realThrottleClock,
  options: { intervalMs?: number; maxPoints?: number } = {},
): InkBatcher {
  const intervalMs = options.intervalMs ?? INK_INTERVAL_MS;
  const maxPoints = options.maxPoints ?? LIVE_DEMO.inkPointsPerFrame;
  let pending: LiveDemoPoint[] = [];
  let ending = false;
  let finished = false;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;

  function flush(): void {
    timer = null;
    if (finished || (pending.length === 0 && !ending)) return;
    const points = thinPoints(pending, maxPoints);
    pending = [];
    lastSentAt = clock.now();
    if (ending) finished = true;
    send(points, ending);
  }

  function schedule(): void {
    if (finished || timer !== null) return;
    const wait = lastSentAt + intervalMs - clock.now();
    if (wait <= 0) {
      flush();
      return;
    }
    timer = clock.setTimer(flush, wait);
  }

  return {
    add(point) {
      if (ending || finished) return;
      pending.push(point);
      schedule();
    },
    end() {
      if (ending || finished) return;
      ending = true;
      schedule();
    },
    cancel() {
      pending = [];
      finished = true;
      if (timer !== null) clock.clearTimer(timer);
      timer = null;
    },
  };
}
