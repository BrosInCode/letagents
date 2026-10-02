import { sql } from "drizzle-orm";
import { PERSON_MENTION_START, PERSON_MENTION_END } from "../../../shared/room-notification-preferences.mjs";

import type { MessageCreateTransaction } from "../db/messages/create.js";
import type { MessageRow } from "../db/types.js";

export async function enqueueDesktopPushNotifications(
  tx: MessageCreateTransaction,
  message: MessageRow,
): Promise<void> {
  const now = new Date().toISOString();
  await tx.execute(sql`
    INSERT INTO desktop_push_notifications (
      id,
      device_id,
      room_id,
      message_number,
      thread_root_number,
      room_display_name,
      sender,
      body,
      state,
      attempt_count,
      next_attempt_at,
      created_at,
      updated_at
    )
    SELECT
      CONCAT(
        'la_',
        REPLACE(device.id, '-', ''),
        '_',
        LEFT(MD5(${message.room_id}::text), 12),
        '_',
        TO_HEX(${message.number}::bigint)
      ),
      device.id,
      ${message.room_id},
      ${message.number},
      ${message.thread_root_number},
      room.display_name,
      ${message.sender},
      LEFT(${message.text}, 1000),
      'queued',
      0,
      ${now},
      ${now},
      ${now}
    FROM desktop_push_devices AS device
    INNER JOIN account_room_recents AS recent
      ON recent.account_id = device.account_id
      AND recent.room_id = ${message.room_id}
      AND recent.archived = FALSE
    INNER JOIN rooms AS room ON room.id = ${message.room_id}
    LEFT JOIN account_room_notification_preferences AS preference
      ON preference.account_id = device.account_id AND preference.room_id = ${message.room_id}
    INNER JOIN accounts AS account ON account.id = device.account_id
    WHERE device.enabled = TRUE
      AND (${message.publisher_account_id}::text IS NULL OR device.account_id <> ${message.publisher_account_id})
      AND (preference.snoozed_until IS NULL OR preference.snoozed_until <= statement_timestamp())
      AND CASE COALESCE(preference.level, 'all')
        WHEN 'all' THEN TRUE
        WHEN 'mentions' THEN ${message.text} ~* (
          ${PERSON_MENTION_START} || REGEXP_REPLACE(account.login, '([^A-Za-z0-9_-])', ${String.raw`\\\1`}, 'g') || ${PERSON_MENTION_END}
        )
        ELSE FALSE
      END
    ON CONFLICT (device_id, room_id, message_number) DO NOTHING
  `);
}
