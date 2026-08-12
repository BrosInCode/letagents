interface Waiter {
  generation: number;
  resolve: (outcome: TrailingSingleFlightOutcome) => void;
  reject: (error: unknown) => void;
}

export interface TrailingSingleFlightOutcome {
  requestedGeneration: number;
  completedGeneration: number;
  coalesced: boolean;
}

/**
 * Coalesces concurrent requests into one active pass and at most one trailing
 * pass. Generation waiters close the completion/finally window where a plain
 * boolean latch can otherwise lose a wakeup.
 */
export function createTrailingSingleFlight(
  runPass: () => Promise<void>,
): () => Promise<TrailingSingleFlightOutcome> {
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let drainPromise: Promise<void> | null = null;
  const waiters: Waiter[] = [];

  const ensureDrain = () => {
    if (drainPromise) return;
    drainPromise = drain().finally(() => {
      drainPromise = null;
      if (completedGeneration < requestedGeneration) ensureDrain();
    });
  };

  const settleThrough = (generation: number, error?: unknown) => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter || waiter.generation > generation) continue;
      waiters.splice(index, 1);
      if (error === undefined) {
        waiter.resolve({
          requestedGeneration: waiter.generation,
          completedGeneration: generation,
          coalesced: waiter.generation < generation,
        });
      }
      else waiter.reject(error);
    }
  };

  async function drain(): Promise<void> {
    while (completedGeneration < requestedGeneration) {
      const passGeneration = requestedGeneration;
      try {
        await runPass();
        completedGeneration = passGeneration;
        settleThrough(passGeneration);
      } catch (error) {
        completedGeneration = passGeneration;
        settleThrough(passGeneration, error);
      }
    }
  }

  return () => {
    const generation = ++requestedGeneration;
    const result = new Promise<TrailingSingleFlightOutcome>((resolve, reject) => {
      waiters.push({ generation, resolve, reject });
    });
    ensureDrain();
    return result;
  };
}
