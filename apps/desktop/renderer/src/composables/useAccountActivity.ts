import { computed, onBeforeUnmount, ref, toRaw, watch, type Ref } from "vue";
import type { DesktopAccountActivityState, DesktopAccountRoomActivity } from "../../../electron/ipc-types";
import { indexAccountActivity } from "../domain/account-activity";
import { reuseUnchanged } from "../domain/reuse-unchanged";
import { desktopIpc } from "../ipc/index";

/**
 * The account's activity stream, as the sidebar uses it. The stream is opened
 * when signed in and reopened when the set of rooms changes, so it always
 * watches the rooms the sidebar shows; it is closed on sign-out.
 */
export function useAccountActivity(options: { authenticated: Ref<boolean>; roomIds: Ref<readonly string[]> }) {
  const state = ref<DesktopAccountActivityState>({ connected: false, rooms: {} });
  /**
   * When each room's cards last changed (`tasksChangedAt`), kept apart from
   * `state` so a card change does not re-run the sidebar's computeds; only My
   * work reads it. Keyed by the server's room id.
   */
  const tasksChangedAt = ref<Record<string, string | null>>({});
  const index = computed(() => indexAccountActivity(state.value));
  const connected = computed(() => state.value.connected);
  const room = desktopIpc.room;

  function accept(next: DesktopAccountActivityState): void {
    const rooms: Record<string, DesktopAccountRoomActivity> = {};
    const stamps: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(next.rooms)) {
      const { tasksChangedAt: stamp, ...rest } = value;
      rooms[key] = rest;
      stamps[value.roomId] = stamp ?? null;
    }
    // Equal data keeps its references, so a frame that only moved a stamp changes nothing here.
    state.value = reuseUnchanged(toRaw(state.value), { connected: next.connected, rooms });
    tasksChangedAt.value = reuseUnchanged(toRaw(tasksChangedAt.value), stamps);
  }

  const unsubscribe = room?.onAccountActivity?.(accept) ?? null;
  void room?.getAccountActivity?.().then((next) => { if (next) accept(next); }).catch(() => undefined);

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
      tasksChangedAt.value = {};
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

  return { state, tasksChangedAt, index, connected };
}
