import { watch } from 'vue';
import { createRoomNotificationClient } from '../../../../../shared/room-notification-client.mjs';
import { useAuth } from '../useAuth';
import { apiFetch, roomPath } from './api';
import { room } from './state';

export const roomNotificationPreferences = createRoomNotificationClient({
  get: (id) => apiFetch(`${roomPath(id)}/notification-preferences`),
});

// useRoom owns one shared stream for the page; register the focus listener only
// while a room is open and remove it when that room or the account changes.
const { user } = useAuth();
watch([() => room.value?.identifier, () => user.value?.id, () => user.value?.login], ([id], _previous, cleanup) => {
  roomNotificationPreferences.setViewer(user.value ? { id: user.value.id, login: user.value.login } : null);
  if (!id) return;
  const refresh = () => { void roomNotificationPreferences.refresh(id); };
  refresh();
  window.addEventListener('focus', refresh);
  cleanup(() => window.removeEventListener('focus', refresh));
}, { immediate: true, flush: 'sync' });
