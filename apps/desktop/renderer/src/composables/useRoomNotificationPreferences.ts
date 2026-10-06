import { ref } from 'vue';
import { createRoomNotificationClient } from '../../../../../shared/room-notification-client.mjs';
import { roomNotificationsSuppressed } from '../../../../../shared/room-notification-preferences.mjs';
import { desktopIpc } from '../ipc/index.js';
import { normalizeRoomIdentifier } from '../domain/sidebar-rooms';

const revision = ref(0);
export const roomNotificationPreferences = createRoomNotificationClient({
  get: (id) => desktopIpc.room.getNotificationPreference(id),
  list: () => desktopIpc.room.listNotificationPreferences(),
  put: (id, change) => desktopIpc.room.setNotificationPreference(id, change),
}, () => { revision.value++; }, (id) => normalizeRoomIdentifier(id) ?? '');

export function roomNotificationState(id: string) {
  void revision.value;
  return { ...roomNotificationPreferences.state(id) };
}
export function roomNotificationsMuted(id: string | null | undefined): boolean {
  return Boolean(id && roomNotificationsSuppressed(roomNotificationState(id).preference));
}
export function roomNotificationAccountAvailable(): boolean {
  void revision.value;
  return roomNotificationPreferences.signedIn();
}
