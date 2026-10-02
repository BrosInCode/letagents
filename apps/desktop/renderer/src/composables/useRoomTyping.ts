import { onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { createTypingDisplay, createTypingSender } from '../../../../../shared/room-typing.mjs';
import { desktopIpc } from '../ipc/index';
import { normalizeRoomIdentifier } from '../domain/sidebar-rooms';

const account = shallowRef<string | null>(null);
const listeners = new Set<(room: string, signal: unknown) => void>();
export function setTypingAccount(id: string | null) { account.value = id; }
export function receiveRoomTyping(room: string, signal: unknown = null) {
  for (const listener of listeners) listener(room, signal);
}

export function useRoomTyping(room: Ref<string>) {
  const label = ref('');
  if (typeof window === 'undefined') return { label, input: (_nonempty: boolean) => {}, stop: () => {} };
  const receiver = createTypingDisplay(value => { label.value = value; });
  let target = room.value;
  const sender = createTypingSender({ clientId: crypto.randomUUID(), send: input => {
    if (target && account.value) return desktopIpc.room.reportTyping?.(target, input);
  } });
  const clear = () => receiver.clear();
  const receive = (identifier: string, signal: unknown) => {
    if (normalizeRoomIdentifier(identifier) !== normalizeRoomIdentifier(target) || !account.value) return;
    if (signal === null) clear(); else receiver.receive(signal, account.value);
  };
  listeners.add(receive);
  watch([room, account], () => { sender.stop(); clear(); target = room.value; }, { flush: 'sync' });
  const leave = () => { sender.stop(); clear(); };
  window.addEventListener('pagehide', leave);
  onScopeDispose(() => { leave(); listeners.delete(receive); window.removeEventListener('pagehide', leave); });
  return { label, input: (nonempty: boolean) => { if (account.value) sender.input(nonempty); }, stop: sender.stop };
}
