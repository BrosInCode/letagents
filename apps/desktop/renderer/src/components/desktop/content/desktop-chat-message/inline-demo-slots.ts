/** Inline demos that may run at the same time, across every room in the window. */
export const MAX_RUNNING_INLINE_DEMOS = 3;

export interface InlineDemoSlot {
  /** Gives the place back, or leaves the queue. Safe to call more than once. */
  release(): void;
}

export interface InlineDemoSlots {
  /**
   * Asks for a place to run. `onGrant` runs once: at once when a place is free,
   * or later, in request order, when a holder releases one. It must not throw.
   */
  request(onGrant: () => void): InlineDemoSlot;
  runningCount(): number;
  waitingCount(): number;
}

interface SlotEntry extends InlineDemoSlot {
  onGrant(): void;
}

export function createInlineDemoSlots(limit: number): InlineDemoSlots {
  const running = new Set<SlotEntry>();
  const waiting: SlotEntry[] = [];

  function grantWaiting(): void {
    while (running.size < limit && waiting.length > 0) {
      const next = waiting.shift()!;
      running.add(next);
      next.onGrant();
    }
  }

  return {
    request(onGrant) {
      const entry: SlotEntry = {
        onGrant,
        release() {
          if (running.delete(entry)) {
            grantWaiting();
            return;
          }
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
        },
      };
      waiting.push(entry);
      grantWaiting();
      return entry;
    },
    runningCount: () => running.size,
    waitingCount: () => waiting.length,
  };
}

export const inlineDemoSlots = createInlineDemoSlots(MAX_RUNNING_INLINE_DEMOS);
