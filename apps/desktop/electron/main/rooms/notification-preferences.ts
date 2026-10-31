import type { RoomNotificationPreferenceChange, RoomNotificationPreferenceEntry, RoomNotificationPreferenceList } from '../../../../../shared/room-notification-preferences.mjs';
import { apiFetch } from '../auth.js';
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from './local-store.js';

async function preferencePath(identifier: string): Promise<string> {
  if (!identifier?.trim()) throw new Error('Choose a room first.');
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === 'local') throw new Error('Notification settings require a cloud room.');
  return `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}/notification-preferences`;
}

export function listDesktopRoomNotificationPreferences(): Promise<RoomNotificationPreferenceList> {
  return apiFetch('/account/room-notification-preferences');
}
export async function getDesktopRoomNotificationPreference(identifier: string): Promise<RoomNotificationPreferenceEntry> {
  return apiFetch(await preferencePath(identifier));
}
export async function setDesktopRoomNotificationPreference(identifier: string, change: RoomNotificationPreferenceChange): Promise<RoomNotificationPreferenceEntry> {
  return apiFetch(await preferencePath(identifier), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
}
