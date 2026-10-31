import { computed, inject, onScopeDispose, provide, reactive, shallowRef, watch, type Ref } from "vue";
import { createMessagePinStore, type MessagePinState } from "../../../../../shared/message-pin-store.mjs";
import type { DesktopAuthAccount } from "../../../electron/ipc-types";
import { normalizeRoomIdentifier } from "../domain/sidebar-rooms";
import { safeUserVisibleErrorDetail } from "../domain/user-visible-error";
import { desktopIpc } from "../ipc/index";

const revisions = reactive(new Map<string, number>());
const viewer = shallowRef<string | null>(null);
export function setMessagePinViewer(account: DesktopAuthAccount | null): void { viewer.value = account?.id ?? null; }
export function invalidateRoomMessagePins(room: string): void {
  const key = normalizeRoomIdentifier(room);
  if (key) revisions.set(key, (revisions.get(key) ?? 0) + 1);
}
export function useRoomMessagePins(room: Ref<string>, reportError: (message: string) => void) {
  const state = shallowRef<MessagePinState>({ pins: [], available: false, loading: false, pending: null, error: null });
  const supported = computed(() => Boolean(desktopIpc.room?.getMessagePins && desktopIpc.room?.setMessagePin));
  const store = createMessagePinStore<string>({
    load: (id) => desktopIpc.room.getMessagePins!(id),
    mutate: (id, message, pinned) => desktopIpc.room.setMessagePin!(id, message, pinned),
    onChange: (value) => {
      state.value = { ...value, error: value.error ? safeUserVisibleErrorDetail(value.error, "Pins could not be loaded.") : null };
    },
    onError: (error) => reportError(safeUserVisibleErrorDetail(error, "Pins could not be saved.")),
  });
  watch(() => [room.value, viewer.value, supported.value], () => {
    store.reset(room.value && supported.value ? room.value : null);
  }, { immediate: true, flush: "sync" });
  watch(() => revisions.get(normalizeRoomIdentifier(room.value) ?? ""), () => { void store.refresh(); });
  onScopeDispose(() => store.dispose());
  return {
    state,
    canPin: computed(() => state.value.available && viewer.value !== null),
    isPinned: (id: string) => state.value.pins.some((pin) => pin.message_id === id),
    toggle: (id: string) => {
      if (state.value.available && viewer.value) void store.setPinned(id, !state.value.pins.some((pin) => pin.message_id === id));
    },
    refresh: () => { void store.refresh(); },
  };
}
const KEY = Symbol("message-pins");
type Context = ReturnType<typeof useRoomMessagePins>;
export function provideRoomMessagePins(context: Context): void { provide(KEY, context); }
export function injectRoomMessagePins(): Context | null { return inject<Context | null>(KEY, null); }
