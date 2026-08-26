export class DeliveryCutoverObservationDetached extends Error {}

export type DeliveryCutoverRetryTimer = {
  unref(): unknown;
};

export type DeliveryCutoverCoordinatorOptions = {
  isHandoffScheduled: () => boolean;
  drive: (entryId: string, detachSignal: AbortSignal) => Promise<void>;
  setRetryTimeout?: (callback: () => void, delayMs: number) => DeliveryCutoverRetryTimer;
};

/**
 * Owns process-local coordination for durable delivery-cutover sagas.
 *
 * Durable phase changes remain behind `drive`; this component owns only the
 * coalesced request, its observation lifetime, retry admission, and shutdown
 * drain. Aborting observation never signals or stops the provider process.
 */
export class DeliveryCutoverCoordinator {
  private readonly requests = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly isHandoffScheduled: () => boolean;
  private readonly drive: (entryId: string, detachSignal: AbortSignal) => Promise<void>;
  private readonly setRetryTimeout: (callback: () => void, delayMs: number) => DeliveryCutoverRetryTimer;

  constructor(options: DeliveryCutoverCoordinatorOptions) {
    this.isHandoffScheduled = options.isHandoffScheduled;
    this.drive = options.drive;
    this.setRetryTimeout = options.setRetryTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  }

  /** Coalesce one durable legacy-polling -> daemon-inbox handoff per agent. */
  start(entryId: string): Promise<void> {
    const existing = this.requests.get(entryId);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(entryId, controller);
    const operation = this.drive(entryId, controller.signal).finally(() => {
      if (this.requests.get(entryId) === operation) this.requests.delete(entryId);
      if (this.controllers.get(entryId) === controller) this.controllers.delete(entryId);
    });
    this.requests.set(entryId, operation);
    return operation;
  }

  scheduleRetry(entryId: string, delayMs: number): void {
    const timer = this.setRetryTimeout(
      () => void this.start(entryId).catch(() => undefined),
      delayMs,
    );
    timer.unref();
  }

  /** Detach local observation and wait for every admitted coordinator to settle. */
  async fenceAndDrain(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.requests.values()]);
  }

  assertObservation(detachSignal: AbortSignal): void {
    if (detachSignal.aborted || this.isHandoffScheduled()) {
      throw new DeliveryCutoverObservationDetached();
    }
  }

  observe<T>(detachSignal: AbortSignal, operation: Promise<T>): Promise<T> {
    this.assertObservation(detachSignal);
    return new Promise<T>((resolve, reject) => {
      const detach = () => {
        detachSignal.removeEventListener("abort", detach);
        reject(new DeliveryCutoverObservationDetached());
      };
      detachSignal.addEventListener("abort", detach, { once: true });
      void operation.then(
        (value) => {
          detachSignal.removeEventListener("abort", detach);
          if (detachSignal.aborted || this.isHandoffScheduled()) {
            reject(new DeliveryCutoverObservationDetached());
          } else {
            resolve(value);
          }
        },
        (error) => {
          detachSignal.removeEventListener("abort", detach);
          reject(error);
        },
      );
    });
  }
}
