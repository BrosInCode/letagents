import { computed, inject, onScopeDispose, provide, shallowRef, watch, type Ref } from 'vue'
import { createMessagePinStore, type MessagePinState } from '../../../../shared/message-pin-store.mjs'
import type { MessagePinsResponse } from '../../../../shared/message-pins.mjs'
import { apiFetch, roomPath } from './room/api'
import { useAuth } from './useAuth'

export const lastMessagePinInvalidation = shallowRef<{ roomId: string } | null>(null)
export function publishMessagePinInvalidation(roomId: string): void {
  lastMessagePinInvalidation.value = { roomId }
}
export function useRoomMessagePins(room: Ref<string>, reportError: (message: string) => void) {
  const auth = useAuth()
  const viewer = computed(() => auth.isSignedIn.value ? auth.user.value?.login ?? null : null)
  const state = shallowRef<MessagePinState>({ pins: [], available: false, loading: false, pending: null, error: null })
  const store = createMessagePinStore<string>({
    load: (id): Promise<MessagePinsResponse> => apiFetch(`${roomPath(id)}/messages/pins`),
    mutate: (id, message, pinned) => apiFetch(`${roomPath(id)}/messages/${message}/pin`, { method: pinned ? 'PUT' : 'DELETE' }),
    onChange: (value) => { state.value = value },
    onError: reportError,
  })
  watch(() => [room.value, viewer.value], () => store.reset(room.value || null), { immediate: true, flush: 'sync' })
  watch(lastMessagePinInvalidation, (value) => { if (value?.roomId === room.value) void store.refresh() })
  onScopeDispose(() => store.dispose())
  return {
    state,
    canPin: computed(() => state.value.available && viewer.value !== null),
    isPinned: (id: string) => state.value.pins.some((pin) => pin.message_id === id),
    toggle: (id: string) => {
      if (state.value.available && viewer.value) void store.setPinned(id, !state.value.pins.some((pin) => pin.message_id === id))
    },
    refresh: () => { void store.refresh() },
  }
}
const KEY = Symbol('message-pins')
type Context = ReturnType<typeof useRoomMessagePins>
export function provideRoomMessagePins(context: Context): void { provide(KEY, context) }
export function injectRoomMessagePins(): Context | null { return inject<Context | null>(KEY, null) }
