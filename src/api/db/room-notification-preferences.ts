import { DEFAULT_ROOM_NOTIFICATION_PREFERENCE } from '../../../shared/room-notification-preferences.mjs';
import type { RoomNotificationPreferenceChange, RoomNotificationPreferenceEntry, RoomNotificationPreferenceList } from '../../../shared/room-notification-preferences.mjs';
import { pool } from './client.js';

type StoredPreference = Omit<RoomNotificationPreferenceEntry, 'snoozed_until'> & { snoozed_until: Date | null };
function toPreference(row: StoredPreference): RoomNotificationPreferenceEntry {
  return { ...row, snoozed_until: row.snoozed_until?.toISOString() ?? null };
}

export async function getRoomNotificationPreference(accountId: string, roomId: string): Promise<RoomNotificationPreferenceEntry> {
  const result = await pool.query<StoredPreference>(`SELECT room_id, level, snoozed_until
    FROM account_room_notification_preferences WHERE account_id=$1 AND room_id=$2`, [accountId, roomId]);
  return result.rows[0] ? toPreference(result.rows[0]) : { room_id: roomId, ...DEFAULT_ROOM_NOTIFICATION_PREFERENCE };
}

/**
 * Every saved row, so a client of any version reads each saved level as it is.
 * (The default level changed from "all" to "mentions"; a client that
 * still assumes "all" for a missing row must see a saved "mentions".)
 */
export async function listRoomNotificationPreferences(accountId: string): Promise<RoomNotificationPreferenceList> {
  const result = await pool.query<StoredPreference>(`SELECT room_id, level, snoozed_until
    FROM account_room_notification_preferences WHERE account_id=$1
    ORDER BY room_id LIMIT 501`, [accountId]);
  return { preferences: result.rows.slice(0, 500).map(toPreference), truncated: result.rows.length > 500 };
}

/** One upsert preserves the other field even across concurrent level/snooze changes. */
export async function setRoomNotificationPreference(
  accountId: string, roomId: string, change: RoomNotificationPreferenceChange,
): Promise<RoomNotificationPreferenceEntry | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    const result = await client.query<StoredPreference>(`INSERT INTO account_room_notification_preferences
      (account_id, room_id, level, snoozed_until)
      -- A snooze alone saves the default level, not "all".
      SELECT $1, $2, COALESCE($3, $6), $4::timestamptz
      WHERE $4::timestamptz IS NULL OR ($4::timestamptz > statement_timestamp()
        AND $4::timestamptz <= statement_timestamp() + INTERVAL '7 days')
      ON CONFLICT (account_id, room_id) DO UPDATE SET
        level = COALESCE($3, account_room_notification_preferences.level),
        snoozed_until = CASE WHEN $5 THEN $4::timestamptz ELSE account_room_notification_preferences.snoozed_until END
      RETURNING room_id, level, snoozed_until`,
    [accountId, roomId, change.level ?? null, change.snoozed_until ?? null, 'snoozed_until' in change,
      DEFAULT_ROOM_NOTIFICATION_PREFERENCE.level]);
    await client.query('COMMIT');
    return result.rows[0] ? toPreference(result.rows[0]) : null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
