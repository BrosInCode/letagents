/**
 * A demo can show in two cards of one window (the timeline and an open thread).
 * Main keeps one join per room and demo, bound to one card's lease, so the cards
 * share it: the first card joins, the others ride along, and when the card that
 * holds the join leaves, the next card takes it over.
 */
export interface LiveDemoJoinApi {
  join(roomIdentifier: string, demoKey: string, leaseUrl: string): Promise<void>;
  leave(roomIdentifier: string, demoKey: string): Promise<void>;
}

export interface LiveDemoJoins {
  /** Resolves when main accepted the join. The returned function leaves; it is safe to call twice. */
  join(roomIdentifier: string, demoKey: string, leaseUrl: string): { done: Promise<void>; leave: () => void };
}

interface Holder {
  leaseUrl: string;
}

export function createLiveDemoJoins(api: LiveDemoJoinApi): LiveDemoJoins {
  const holders = new Map<string, Holder[]>();
  const accepted = new Map<string, Promise<void>>();

  function swallow(promise: Promise<void>): void {
    promise.catch(() => undefined);
  }

  return {
    join(roomIdentifier, demoKey, leaseUrl) {
      const id = `${roomIdentifier.trim().toLowerCase()}\u0000${demoKey}`;
      const holder: Holder = { leaseUrl };
      const list = holders.get(id) ?? [];
      holders.set(id, list);
      list.push(holder);
      let done: Promise<void>;
      if (list.length === 1) {
        done = api.join(roomIdentifier, demoKey, leaseUrl);
        accepted.set(id, done);
      } else {
        done = accepted.get(id) ?? Promise.resolve();
      }

      let left = false;
      return {
        done,
        leave() {
          if (left) return;
          left = true;
          const current = holders.get(id);
          const index = current ? current.indexOf(holder) : -1;
          if (!current || index < 0) return;
          current.splice(index, 1);
          if (current.length === 0) {
            holders.delete(id);
            accepted.delete(id);
            swallow(api.leave(roomIdentifier, demoKey));
          } else if (index === 0) {
            const next = api.join(roomIdentifier, demoKey, current[0].leaseUrl);
            accepted.set(id, next);
            swallow(next);
          }
        },
      };
    },
  };
}
