export interface ManagedMessageDeliveryTracker {
  remember(roomIdentifier: string, messageId: string | null | undefined): boolean;
  size(): number;
}

export function createManagedMessageDeliveryTracker(
  maxEntries = 5_000,
): ManagedMessageDeliveryTracker {
  const seen = new Set<string>();
  const order: string[] = [];
  const limit = Math.max(1, Math.floor(maxEntries));

  return {
    remember(roomIdentifier, messageId) {
      const id = messageId?.trim();
      if (!id) {
        return true;
      }

      const key = `${roomIdentifier.trim()}::${id}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      order.push(key);
      while (order.length > limit) {
        const evicted = order.shift();
        if (evicted) {
          seen.delete(evicted);
        }
      }
      return true;
    },
    size() {
      return seen.size;
    },
  };
}
