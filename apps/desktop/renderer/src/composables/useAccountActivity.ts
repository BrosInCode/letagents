import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { DesktopAccountActivityState } from "../../../electron/ipc-types";
import { indexAccountActivity } from "../domain/account-activity";
import { desktopIpc } from "../ipc/index";

/**
 * The account's activity stream, as the sidebar uses it. The stream is opened
 * when signed in and reopened when the set of rooms changes, so it always
 * watches the rooms the sidebar shows; it is closed on sign-out.
 */
export function useAccountActivity(options: { authenticated: Ref<boolean>; roomIds: Ref<readonly string[]> }) {
  const state = ref<DesktopAccountActivityState>({ connected: false, rooms: {} });
  const index = computed(() => indexAccountActivity(state.value));
  const connected = computed(() => state.value.connected);
  const room = desktopIpc.room;

  const unsubscribe = room?.onAccountActivity?.((next) => { state.value = next; }) ?? null;
  void room?.getAccountActivity?.().then((next) => { if (next) state.value = next; }).catch(() => undefined);

  // Joining several rooms at once reopens the stream once, not once per room.
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  const roomSetKey = computed(() => [...options.roomIds.value].sort().join("\n"));
  watch([options.authenticated, roomSetKey], ([authenticated]) => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    // Signed out, or no rooms yet (the list has not loaded): nothing to watch.
    if (!authenticated || !options.roomIds.value.length) {
      void room?.stopAccountActivity?.().catch(() => undefined);
      state.value = { connected: false, rooms: {} };
      return;
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void room?.restartAccountActivity?.().catch(() => undefined);
    }, 400);
  }, { immediate: true });

  onBeforeUnmount(() => {
    if (restartTimer) clearTimeout(restartTimer);
    unsubscribe?.();
  });

  return { state, index, connected };
}
