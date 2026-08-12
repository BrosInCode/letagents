export class BoundedWorkRejectedError extends Error {
  constructor(label: string) {
    super(`${label} is at capacity`);
    this.name = "BoundedWorkRejectedError";
  }
}

export class BoundedWorkTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} exceeded its deadline`);
    this.name = "BoundedWorkTimeoutError";
  }
}

interface QueuedWork<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
  started: boolean;
  consumerSettled: boolean;
}

/**
 * Bounds both active and waiting asynchronous work. The deadline starts at
 * enqueue time; a queued timeout is physically removed, while a timed-out
 * active operation continues occupying its slot until the dependency settles.
 * Deadlines therefore cannot turn a slow dependency into unbounded work.
 */
export function createBoundedExecutor(options: {
  label: string;
  maxConcurrent: number;
  maxQueued: number;
  timeoutMs: number;
}) {
  let active = 0;
  const queue: Array<QueuedWork<unknown>> = [];

  const drain = () => {
    while (active < options.maxConcurrent && queue.length > 0) {
      const work = queue.shift();
      if (!work) return;
      if (work.consumerSettled) continue;
      work.started = true;
      active += 1;
      let result: Promise<unknown>;
      try {
        result = Promise.resolve(work.run());
      } catch (error) {
        result = Promise.reject(error);
      }
      void result.then(
        (value) => {
          if (!work.consumerSettled) {
            work.consumerSettled = true;
            clearTimeout(work.timeout);
            work.resolve(value);
          }
        },
        (error) => {
          if (!work.consumerSettled) {
            work.consumerSettled = true;
            clearTimeout(work.timeout);
            work.reject(error);
          }
        },
      ).finally(() => {
        work.consumerSettled = true;
        clearTimeout(work.timeout);
        active -= 1;
        drain();
      });
    }
  };

  return function runBounded<T>(run: () => Promise<T>): Promise<T> {
    if (active >= options.maxConcurrent && queue.length >= options.maxQueued) {
      return Promise.reject(new BoundedWorkRejectedError(options.label));
    }
    return new Promise<T>((resolve, reject) => {
      let work!: QueuedWork<unknown>;
      work = {
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
        started: false,
        consumerSettled: false,
      };
      work.timeout = setTimeout(() => {
        if (work.consumerSettled) return;
        work.consumerSettled = true;
        if (!work.started) {
          const index = queue.indexOf(work);
          if (index >= 0) queue.splice(index, 1);
        }
        reject(new BoundedWorkTimeoutError(options.label));
      }, options.timeoutMs);
      work.timeout.unref?.();
      queue.push(work);
      drain();
    });
  };
}
