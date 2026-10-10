import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { createTypingDisplay, createTypingSender, TYPING } from '../../../../shared/room-typing.mjs'
import { roomPath } from './room/api'
import { useAuth } from './useAuth'

const listeners = new Set<(room: string, signal: unknown) => void>()
export function receiveRoomTyping(room: string, signal: unknown = null) {
  for (const listener of listeners) listener(room, signal)
}

export function useRoomTyping(room: Ref<string>) {
  const auth = useAuth()
  const self = computed(() => auth.isSignedIn.value ? auth.user.value?.id ?? null : null)
  const label = ref('')
  if (typeof window === 'undefined') return { label, input: (_nonempty: boolean) => {}, stop: () => {} }
  const receiver = createTypingDisplay((value: string) => { label.value = value })
  let target = room.value
  const sender = createTypingSender({ clientId: crypto.randomUUID(), send: input => {
    if (!target || !self.value) return
    return fetch(`${roomPath(target)}/typing`, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      signal: AbortSignal.timeout(TYPING.interval), keepalive: true })
  } })
  const clear = () => receiver.clear()
  const receive = (identifier: string, signal: unknown) => {
    if (identifier !== target || !self.value) return
    if (signal === null) clear(); else receiver.receive(signal, self.value)
  }
  listeners.add(receive)
  watch([room, self], () => { sender.stop(); clear(); target = room.value }, { flush: 'sync' })
  const leave = () => { sender.stop(); clear() }
  window.addEventListener('pagehide', leave)
  onScopeDispose(() => { leave(); listeners.delete(receive); window.removeEventListener('pagehide', leave) })
  return { label, input: (nonempty: boolean) => { if (self.value) sender.input(nonempty) }, stop: sender.stop }
}

/** Display-only view of who is typing, for surfaces outside the composer. It reports nothing. */
export function useRoomTypingNames(room: Ref<string>) {
  const auth = useAuth()
  const self = computed(() => auth.isSignedIn.value ? auth.user.value?.id ?? null : null)
  const names = ref<string[]>([])
  if (typeof window === 'undefined') return names
  // Heartbeats repeat the same people; assign only on a real change so the list does not re-render.
  const display = createTypingDisplay((_label: string, people: string[]) => {
    if (people.join('\n') !== names.value.join('\n')) names.value = people
  })
  let target = room.value
  const receive = (identifier: string, signal: unknown) => {
    if (identifier !== target || !self.value) return
    if (signal === null) display.clear(); else display.receive(signal, self.value)
  }
  listeners.add(receive)
  watch([room, self], () => { display.clear(); target = room.value }, { flush: 'sync' })
  onScopeDispose(() => { display.clear(); listeners.delete(receive) })
  return names
}
