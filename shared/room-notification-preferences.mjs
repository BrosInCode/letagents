export const ROOM_NOTIFICATION_LEVELS = ['all', 'mentions', 'muted'];
export const DEFAULT_ROOM_NOTIFICATION_PREFERENCE = Object.freeze({ level: 'all', snoozed_until: null });
// Shared with PostgreSQL's regex predicate. A final sentence period is punctuation;
// a dot followed by a handle character is part of a longer handle.
export const PERSON_MENTION_START = '(^|[^A-Za-z0-9_./@:-])@';
export const PERSON_MENTION_END = '(?![A-Za-z0-9_/@:-]|\\.[A-Za-z0-9_])';

export function mentionsPerson(text, login) {
  if (typeof login !== 'string' || !login) return false;
  const escaped = login.replace(/[^A-Za-z0-9_-]/g, '\\$&');
  return new RegExp(PERSON_MENTION_START + escaped + PERSON_MENTION_END, 'i').test(String(text ?? ''));
}

export function roomNotificationsSuppressed(preference, now = Date.now()) {
  return preference?.level === 'muted' || Date.parse(preference?.snoozed_until ?? '') > now;
}

export function allowsRoomNotification(preference, text, login, now = Date.now()) {
  if (roomNotificationsSuppressed(preference, now)) return false;
  return preference?.level !== 'mentions' || mentionsPerson(text, login);
}

export function roomNotificationSnoozeUntil(preset, now = new Date()) {
  const date = new Date(now);
  if (preset === 'tomorrow') {
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
  } else if (preset === '1h' || preset === '8h') {
    date.setTime(date.getTime() + (preset === '1h' ? 1 : 8) * 60 * 60 * 1000);
  } else {
    throw new Error('Choose a snooze duration.');
  }
  return date.toISOString();
}
