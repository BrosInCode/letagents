import { sql } from "drizzle-orm";
import { PERSON_MENTION_START, PERSON_MENTION_END } from "../../../shared/room-notification-preferences.mjs";

import type { MessageCreateTransaction } from "../db/messages/create.js";
import type { MessageRow } from "../db/types.js";

export interface DesktopPushEnqueueOptions {
  /**
   * Accounts that must get a push for this message even without an
   * account_room_recents row. Their room level is ignored, except that a muted
   * room gets no push. The caller must have checked room access already (a
   * retry decision is fine, because the push worker checks again at delivery).
   */
  notify_account_ids?: readonly string[];
  /**
   * Accounts whose account_room_recents row is created (archived = false) in the
   * same transaction. Use only accounts whose room access was allowed. An
   * existing recents row is left as the person set it.
   */
  recents_account_ids?: readonly string[];
}

export async function enqueueDesktopPushNotifications(
  tx: MessageCreateTransaction,
  message: MessageRow,
  options?: DesktopPushEnqueueOptions,
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

  const notifyAccountIds = [...new Set(options?.notify_account_ids ?? [])];
  if (notifyAccountIds.length > 0) {
    await enqueueTargetedDesktopPushNotifications(tx, message, notifyAccountIds, now);
  }
  const recentsAccountIds = [...new Set(options?.recents_account_ids ?? [])];
  if (recentsAccountIds.length > 0) {
    await insertTargetedRoomRecents(tx, message, recentsAccountIds, now);
  }
}

/**
 * Targeted pushes for explicitly named accounts (for example a GitHub review
 * request). Unlike the normal insert, this ignores the room level and the
 * recents join, except that a muted room gets no push. It keeps the publisher
 * and snooze rules. It does not write any recents row.
 */
async function enqueueTargetedDesktopPushNotifications(
  tx: MessageCreateTransaction,
  message: MessageRow,
  accountIds: readonly string[],
  now: string,
): Promise<void> {
  const accountIdList = sql.join(accountIds.map((accountId) => sql`${accountId}`), sql`, `);
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
    INNER JOIN rooms AS room ON room.id = ${message.room_id}
    LEFT JOIN account_room_notification_preferences AS preference
      ON preference.account_id = device.account_id AND preference.room_id = ${message.room_id}
    WHERE device.enabled = TRUE
      AND device.account_id IN (${accountIdList})
      AND (${message.publisher_account_id}::text IS NULL OR device.account_id <> ${message.publisher_account_id})
      AND (preference.snoozed_until IS NULL OR preference.snoozed_until <= statement_timestamp())
      AND COALESCE(preference.level, 'all') <> 'muted'
    ON CONFLICT (device_id, room_id, message_number) DO NOTHING
  `);
}

/**
 * Creates a recents row (archived = false) for each allowed account that has none.
 * The same transaction runs it, so future messages follow the normal path.
 * It never changes an existing recents row.
 */
async function insertTargetedRoomRecents(
  tx: MessageCreateTransaction,
  message: MessageRow,
  accountIds: readonly string[],
  now: string,
): Promise<void> {
  const accountIdList = sql.join(accountIds.map((accountId) => sql`${accountId}`), sql`, `);
  await tx.execute(sql`
    INSERT INTO account_room_recents (
      account_id,
      room_id,
      display_name,
      source,
      pinned,
      archived,
      first_opened_at,
      last_opened_at,
      updated_at
    )
    SELECT
      account.id,
      room.id,
      room.display_name,
      NULL,
      FALSE,
      FALSE,
      ${now},
      ${now},
      ${now}
    FROM accounts AS account
    INNER JOIN rooms AS room ON room.id = ${message.room_id}
    WHERE account.id IN (${accountIdList})
      AND (${message.publisher_account_id}::text IS NULL OR account.id <> ${message.publisher_account_id})
    ON CONFLICT (account_id, room_id) DO NOTHING
  `);
}
