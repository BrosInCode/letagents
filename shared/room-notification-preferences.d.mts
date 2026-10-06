export type RoomNotificationLevel = 'all' | 'mentions' | 'muted';
export interface RoomNotificationPreference {
  level: RoomNotificationLevel;
  snoozed_until: string | null;
}
export interface RoomNotificationPreferenceEntry extends RoomNotificationPreference { room_id: string }
export interface RoomNotificationPreferenceList { preferences: RoomNotificationPreferenceEntry[]; truncated: boolean }
export type RoomNotificationPreferenceChange = Partial<RoomNotificationPreference>;
export type RoomNotificationSnoozePreset = '1h' | '8h' | 'tomorrow';
export declare const ROOM_NOTIFICATION_LEVELS: readonly RoomNotificationLevel[];
export declare const DEFAULT_ROOM_NOTIFICATION_PREFERENCE: Readonly<RoomNotificationPreference>;
export declare const PERSON_MENTION_START: string;
export declare const PERSON_MENTION_END: string;
export declare function mentionsPerson(text: unknown, login: string | null | undefined): boolean;
export declare function roomNotificationsSuppressed(preference: RoomNotificationPreference | null | undefined, now?: number): boolean;
export declare function allowsRoomNotification(preference: RoomNotificationPreference | null | undefined, text: unknown, login: string | null | undefined, now?: number): boolean;
export declare function roomNotificationSnoozeUntil(preset: RoomNotificationSnoozePreset, now?: Date): string;
