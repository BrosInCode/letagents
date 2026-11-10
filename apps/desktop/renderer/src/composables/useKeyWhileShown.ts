import { computed, type ComputedRef, type Ref } from "vue";

/**
 * A key that follows `key` only while `shown` is true, and keeps the last shown
 * key while hidden. On show it takes the current key in the same render.
 *
 * App.vue keys the room shell's KeepAlive with it: a key change that happens
 * only while Settings or Inbox hides the room (a focus room's snapshot falls
 * back to the parent for a moment) must not destroy the hidden room, but a
 * real room change must replace the KeepAlive so the old room is unmounted.
 */
export function useKeyWhileShown<T>(
  shown: Readonly<Ref<boolean>>,
  key: Readonly<Ref<T>>,
): ComputedRef<T> {
  let lastShownKey = key.value;
  return computed(() => {
    const current = key.value;
    if (shown.value) lastShownKey = current;
    return lastShownKey;
  });
}
