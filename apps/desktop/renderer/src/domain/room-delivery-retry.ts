import { ref, type Ref } from "vue";

export interface RoomDeliveryRetryTarget {
  agentId: string;
  sourceMessageId: string;
}

export type RoomDeliveryRetryResult<T> =
  | { started: false }
  | { started: true; ok: true; value: T }
  | { started: true; ok: false; error: unknown };

/**
 * UI-side ownership for a single receipt retry. The key deliberately includes
 * the agent: one blocked message can be retried by several agents at once,
 * while a second click for the same receipt is ignored until the first RPC has
 * settled.
 */
export function roomDeliveryRetryKey(target: RoomDeliveryRetryTarget): string {
  return `${target.agentId}:${target.sourceMessageId}`;
}

export function createRoomDeliveryRetryCoordinator(): {
  retryingKeys: Ref<ReadonlySet<string>>;
  run<T>(target: RoomDeliveryRetryTarget, operation: () => Promise<T>): Promise<RoomDeliveryRetryResult<T>>;
} {
  const retryingKeys = ref<ReadonlySet<string>>(new Set());

  async function run<T>(target: RoomDeliveryRetryTarget, operation: () => Promise<T>): Promise<RoomDeliveryRetryResult<T>> {
    const key = roomDeliveryRetryKey(target);
    if (retryingKeys.value.has(key)) return { started: false };

    retryingKeys.value = new Set([...retryingKeys.value, key]);
    try {
      return { started: true, ok: true, value: await operation() };
    } catch (error) {
      return { started: true, ok: false, error };
    } finally {
      const next = new Set(retryingKeys.value);
      next.delete(key);
      retryingKeys.value = next;
    }
  }

  return { retryingKeys, run };
}
