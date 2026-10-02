import type { RoomNotificationPreference, RoomNotificationPreferenceChange, RoomNotificationPreferenceEntry, RoomNotificationPreferenceList } from './room-notification-preferences.mjs';
export interface RoomNotificationClientState {
  preference: RoomNotificationPreference; ready: boolean; loading: boolean; busy: boolean; error: string; version: number;
}
export declare function createRoomNotificationClient(api: {
  get(roomId: string): Promise<RoomNotificationPreferenceEntry>;
  list?(): Promise<RoomNotificationPreferenceList>;
  put?(roomId: string, change: RoomNotificationPreferenceChange): Promise<RoomNotificationPreferenceEntry>;
}, changed?: () => void, normalizeKey?: (roomId: string) => string): {
  setViewer(viewer: { id: string; login: string } | null): void;
  signedIn(): boolean;
  allowsAfterRead(roomId: string, text: unknown): Promise<boolean>;
  state(roomId: string): RoomNotificationClientState;
  refresh(roomId: string): Promise<void>;
  refreshAll(): Promise<void>;
  update(roomId: string, change: RoomNotificationPreferenceChange): Promise<void>;
  allows(roomId: string, text: unknown, now?: number): boolean;
};
