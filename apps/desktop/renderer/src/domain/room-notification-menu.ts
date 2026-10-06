import { roomNotificationSnoozeUntil, type RoomNotificationPreference, type RoomNotificationPreferenceChange } from '../../../../../shared/room-notification-preferences.mjs';

export type RoomNotificationMenuItem = {
  id: string; label: string; role?: 'menuitemradio'; checked?: boolean; disabled?: boolean;
};
export function roomNotificationMenuItems(preference: RoomNotificationPreference, disabled = false): RoomNotificationMenuItem[] {
  return [
    ...(['all', 'mentions', 'muted'] as const).map((level, index) => ({
      id: `notification-level-${level}`, label: ['All messages', 'Mentions only', 'Muted'][index]!,
      role: 'menuitemradio' as const, checked: preference.level === level, disabled,
    })),
    { id: 'notification-snooze-1h', label: 'Snooze for 1 hour', disabled },
    { id: 'notification-snooze-8h', label: 'Snooze for 8 hours', disabled },
    { id: 'notification-snooze-tomorrow', label: 'Snooze until tomorrow 09:00', disabled },
    ...(Date.parse(preference.snoozed_until ?? '') > Date.now()
      ? [{ id: 'notification-resume', label: 'Resume notifications', disabled }] : []),
  ];
}
export function roomNotificationMenuChange(id: string): RoomNotificationPreferenceChange | null {
  for (const level of ['all', 'mentions', 'muted'] as const) if (id === `notification-level-${level}`) return { level };
  for (const preset of ['1h', '8h', 'tomorrow'] as const) if (id === `notification-snooze-${preset}`) return { snoozed_until: roomNotificationSnoozeUntil(preset) };
  return id === 'notification-resume' ? { snoozed_until: null } : null;
}
