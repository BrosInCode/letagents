import { enqueueDueReminders, loadReminderMessage, deleteMessageReminder } from "./reminders.js";
import { randomUUID } from "node:crypto";
import { canNotifyConversation } from "../conversations/store.js";

import { getProjectById } from "../db.js";
import { pool } from "../db/client.js";
import {
  resolveProjectRepoRoomAccessDecision,
  type RoomAccessAccount,
} from "../rooms/access.js";
import {
  ApnsClient,
  readApnsCredentials,
  type ApnsEnvironment,
  type ApnsSendResult,
} from "./apns-client.js";
import {
  authorizeDesktopPushNotification,
  type DesktopPushAuthorizationDecision,
} from "./authorization.js";
import { classifyApnsResult, type ApnsDisposition } from "./delivery-policy.js";

const POLL_INTERVAL_MS = 2_000;
const CLAIM_LIMIT = 50;
const DELIVERY_CONCURRENCY = 10;
const MAX_ATTEMPTS = 10;
export const MAX_CONSECUTIVE_DEVICE_FAILURES = 50;
const CLEANUP_INTERVAL_MS = 60 * 60_000;

export interface ClaimedNotification {
  id: string;
  reminder_id?: string | null;
  device_id: string;
  account_id: string;
  device_token: string;
  environment: ApnsEnvironment;
  room_id: string | null;
  conversation_id?: string | null;
  room_display_name: string;
  message_number: number;
  thread_root_number: number | null;
  sender: string;
  body: string;
  attempt_count: number;
}

function retryDelayMs(attemptCount: number): number {
  const exponential = Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, attemptCount - 1));
  return Math.floor(exponential * (0.8 + Math.random() * 0.4));
}

type DeliveryTable = "desktop_push_notifications" | "desktop_reminder_deliveries";
function deliveryTable(notification: ClaimedNotification): DeliveryTable {
  return notification.reminder_id ? "desktop_reminder_deliveries" : "desktop_push_notifications";
}
export function claimNotifications(workerId: string): Promise<ClaimedNotification[]> {
  return claimDeliveryTable(workerId, "desktop_push_notifications");
}
export function claimReminderDeliveries(workerId: string): Promise<ClaimedNotification[]> {
  return claimDeliveryTable(workerId, "desktop_reminder_deliveries");
}
async function claimDeliveryTable(workerId: string, table: DeliveryTable): Promise<ClaimedNotification[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query(`
      UPDATE ${table}
      SET state = 'retry', claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
      WHERE state = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes'
    `);
    const result = await client.query<ClaimedNotification>(`
      WITH ready AS (
        SELECT notification.id
        FROM ${table} AS notification
        INNER JOIN desktop_push_devices AS device ON device.id = notification.device_id
        WHERE notification.state IN ('queued', 'retry')
          AND notification.next_attempt_at <= NOW()
          AND device.enabled = TRUE
        ORDER BY notification.next_attempt_at ASC, notification.created_at ASC
        FOR UPDATE OF notification SKIP LOCKED
        LIMIT $1
      ), claimed AS (
        UPDATE ${table} AS notification
        SET state = 'processing',
            attempt_count = notification.attempt_count + 1,
            claimed_at = NOW(),
            claimed_by = $2,
            updated_at = NOW()
        FROM ready
        WHERE notification.id = ready.id
        RETURNING notification.*
      )
      SELECT claimed.id,
             claimed.device_id,
             device.account_id,
             device.device_token,
             device.environment,
             claimed.room_id,
             ${table === "desktop_reminder_deliveries" ? "claimed.reminder_id, NULL::text AS conversation_id" : "NULL::text AS reminder_id, claimed.conversation_id"},
             claimed.room_display_name,
             claimed.message_number,
             claimed.thread_root_number,
             claimed.sender,
             claimed.body,
             claimed.attempt_count
      FROM claimed
      INNER JOIN desktop_push_devices AS device ON device.id = claimed.device_id
    `, [CLAIM_LIMIT, workerId]);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function getPushDeliveryAccount(accountId: string): Promise<RoomAccessAccount | null> {
  const result = await pool.query<RoomAccessAccount>(`
    SELECT account_record.id AS account_id,
           account_record.provider,
           account_record.login,
           COALESCE(
             (
               SELECT owner_token.provider_access_token
               FROM owner_tokens AS owner_token
               WHERE owner_token.account_id = account_record.id
                 AND owner_token.provider_access_token IS NOT NULL
                 AND (
                   owner_token.oauth_token_expires_at IS NULL
                   OR owner_token.oauth_token_expires_at > NOW()
                 )
               ORDER BY owner_token.updated_at DESC
               LIMIT 1
             ),
             (
               SELECT session.provider_access_token
               FROM auth_sessions AS session
               WHERE session.account_id = account_record.id
                 AND session.provider_access_token IS NOT NULL
                 AND session.expires_at > NOW()
               ORDER BY session.created_at DESC
               LIMIT 1
             )
           ) AS provider_access_token
    FROM accounts AS account_record
    WHERE account_record.id = $1
    LIMIT 1
  `, [accountId]);
  return result.rows[0] ?? null;
}

export async function recordAuthorizationDenied(
  notification: ClaimedNotification,
  workerId: string,
): Promise<void> {
  if (notification.conversation_id) {
    // DM eligibility includes this device's session and this message's read
    // cursor. One denied delivery says nothing about another device/message.
    await pool.query(`UPDATE ${deliveryTable(notification)}
      SET state='dead', room_display_name='', sender='', body='',
          last_status=NULL, last_error='Private message notification is no longer eligible',
          claimed_at=NULL, claimed_by=NULL, updated_at=now()
      WHERE id=$1 AND claimed_by=$2`, [notification.id, workerId]);
    return;
  }
  await pool.query(`
    UPDATE ${deliveryTable(notification)} AS notification
    SET state = 'dead', room_display_name = '', sender = '', body = '',
        last_status = NULL, last_error = 'Room access is no longer authorized',
        claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
    FROM desktop_push_devices AS device
    WHERE notification.device_id = device.id
      AND device.account_id = $3
      AND notification.room_id = $4
      AND (
        (notification.id = $1 AND notification.claimed_by = $2)
        OR notification.state IN ('queued', 'retry')
      )
  `, [notification.id, workerId, notification.account_id, notification.room_id]);
}

async function recordAuthorizationError(
  notification: ClaimedNotification,
  workerId: string,
  error: unknown,
): Promise<void> {
  const message = `Room access check failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000);
  if (notification.attempt_count >= MAX_ATTEMPTS) {
    await pool.query(`
      UPDATE ${deliveryTable(notification)}
      SET state = 'dead', room_display_name = '', sender = '', body = '',
          last_status = NULL, last_error = $3,
          claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
      WHERE id = $1 AND claimed_by = $2
    `, [notification.id, workerId, message]);
    return;
  }

  const nextAttempt = new Date(Date.now() + retryDelayMs(notification.attempt_count)).toISOString();
  await pool.query(`
    UPDATE ${deliveryTable(notification)}
    SET state = 'retry', next_attempt_at = $3, last_status = NULL, last_error = $4,
        claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
    WHERE id = $1 AND claimed_by = $2
  `, [notification.id, workerId, nextAttempt, message]);
}

export async function recordResult(
  notification: ClaimedNotification,
  workerId: string,
  result: ApnsSendResult,
): Promise<void> {
  let disposition = classifyApnsResult(result);
  if (disposition === "retry" && notification.attempt_count >= MAX_ATTEMPTS) disposition = "dead";
  const error = result.reason || (result.status ? `APNs HTTP ${result.status}` : "APNs transport error");

  if (disposition === "delivered") {
    await pool.query(`
      UPDATE ${deliveryTable(notification)}
      SET state = 'delivered', delivered_at = NOW(), apns_id = $3,
          room_display_name = '', sender = '', body = '',
          last_status = $4, last_error = NULL, claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
      WHERE id = $1 AND claimed_by = $2
    `, [notification.id, workerId, result.apnsId, result.status]);
    await pool.query(`
      UPDATE desktop_push_devices
      SET failure_count = 0, last_error = NULL, updated_at = NOW()
      WHERE id = $1
    `, [notification.device_id]);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deviceResult = await client.query<{ failure_count: number; enabled: boolean }>(`
      UPDATE desktop_push_devices
      SET failure_count = LEAST(failure_count + 1, $3::integer),
          last_error = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING failure_count, enabled
    `, [notification.device_id, error, MAX_CONSECUTIVE_DEVICE_FAILURES]);
    const device = deviceResult.rows[0];
    const thresholdReached = Boolean(
      device
      && (!device.enabled || device.failure_count >= MAX_CONSECUTIVE_DEVICE_FAILURES),
    );
    const disableDevice = disposition === "disable-device" || thresholdReached;

    if (disableDevice) {
      const cascadeError = disposition === "disable-device"
        ? "Device registration disabled"
        : `Device registration disabled after ${MAX_CONSECUTIVE_DEVICE_FAILURES} consecutive delivery failures`;
      await client.query(`
        UPDATE desktop_push_devices
        SET enabled = FALSE, disabled_at = COALESCE(disabled_at, NOW()),
            last_error = $2, updated_at = NOW()
        WHERE id = $1
      `, [notification.device_id, error]);
      await client.query(`
        UPDATE ${deliveryTable(notification)}
        SET state = 'dead', room_display_name = '', sender = '', body = '',
            last_status = $3, last_error = $4,
            claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
        WHERE id = $1 AND claimed_by = $2
      `, [notification.id, workerId, result.status || null, error]);
      for (const table of ["desktop_push_notifications", "desktop_reminder_deliveries"] as const) {
        await client.query(`
          UPDATE ${table}
          SET state = 'dead', room_display_name = '', sender = '', body = '',
              last_error = $2, updated_at = NOW()
          WHERE device_id = $1 AND state IN ('queued', 'retry')
        `, [notification.device_id, cascadeError]);
      }
    } else if (disposition === "retry") {
      const nextAttempt = new Date(Date.now() + retryDelayMs(notification.attempt_count)).toISOString();
      await client.query(`
        UPDATE ${deliveryTable(notification)}
        SET state = 'retry', next_attempt_at = $3, last_status = $4, last_error = $5,
            claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
        WHERE id = $1 AND claimed_by = $2
      `, [notification.id, workerId, nextAttempt, result.status || null, error]);
    } else {
      await client.query(`
        UPDATE ${deliveryTable(notification)}
        SET state = 'dead', room_display_name = '', sender = '', body = '',
            last_status = $3, last_error = $4,
            claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
        WHERE id = $1 AND claimed_by = $2
      `, [notification.id, workerId, result.status || null, error]);
    }
    await client.query("COMMIT");
  } catch (updateError) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw updateError;
  } finally {
    client.release();
  }
}

export async function deliverNotification(
  client: Pick<ApnsClient, "send">,
  workerId: string,
  notification: ClaimedNotification,
  authorize: () => Promise<DesktopPushAuthorizationDecision>,
): Promise<void> {
  try {
    const authorization = await authorize();
    if (authorization === "retry") {
      await recordAuthorizationError(
        notification,
        workerId,
        new Error("No usable GitHub credential is currently available"),
      );
      return;
    }
    if (authorization === "deny") {
      await recordAuthorizationDenied(notification, workerId);
      return;
    }
  } catch (error) {
    await recordAuthorizationError(notification, workerId, error);
    return;
  }

  if (notification.reminder_id) {
    try {
      const message = await loadReminderMessage(notification.room_id!, notification.message_number);
      if (!message) {
        await deleteMessageReminder(notification.account_id, notification.reminder_id);
        return;
      }
      notification = { ...notification, room_display_name: message.roomName, sender: message.sender,
        body: message.displayText ?? message.body, thread_root_number: message.threadRoot };
      const current = await pool.query(`SELECT id FROM desktop_reminder_deliveries WHERE id = $1 AND claimed_by = $2`, [notification.id, workerId]);
      if (!current.rowCount) return;
    } catch (error) { await recordAuthorizationError(notification, workerId, error); return; }
  }
  let result: ApnsSendResult;
  try {
    result = await client.send({
      notificationId: notification.id,
      reminder: Boolean(notification.reminder_id),
      deviceToken: notification.device_token,
      environment: notification.environment,
      roomId: notification.room_id,
      conversationId: notification.conversation_id,
      roomDisplayName: notification.room_display_name,
      messageId: `msg_${notification.message_number}`,
      threadRootId: notification.thread_root_number ? `msg_${notification.thread_root_number}` : null,
      sender: notification.sender,
      body: notification.body,
    });
  } catch (error) {
    result = { status: 0, reason: error instanceof Error ? error.message : String(error), apnsId: null };
  }
  await recordResult(notification, workerId, result);
}

export function authorizeReminderAccess(accountId: string, roomId: string): Promise<DesktopPushAuthorizationDecision> {
  return authorizeDesktopPushNotification({ accountId, roomId }, {
    getProject: getProjectById, getAccount: getPushDeliveryAccount, resolveAccess: resolveProjectRepoRoomAccessDecision,
  });
}

export async function processBatch(client: Pick<ApnsClient, "send">, workerId: string): Promise<void> {
  const notifications = [...await claimNotifications(workerId), ...await claimReminderDeliveries(workerId)];
  const authorizationChecks = new Map<string, Promise<DesktopPushAuthorizationDecision>>();
  for (let index = 0; index < notifications.length; index += DELIVERY_CONCURRENCY) {
    await Promise.all(
      notifications.slice(index, index + DELIVERY_CONCURRENCY)
        .map((notification) => {
          if (notification.conversation_id) {
            return deliverNotification(client, workerId, notification, async () =>
              await canNotifyConversation(notification.account_id, notification.conversation_id!, notification.message_number, notification.device_id) ? "allow" : "deny");
          }
          const authorizationKey = `${notification.account_id}\u0000${notification.room_id}`;
          let authorization = authorizationChecks.get(authorizationKey);
          if (!authorization) {
            authorization = authorizeReminderAccess(notification.account_id, notification.room_id!);
            authorizationChecks.set(authorizationKey, authorization);
          }
          return deliverNotification(client, workerId, notification, () => authorization);
        }),
    );
  }
}

export async function cleanupTerminalNotifications(): Promise<void> {
  // Deleting the personal entry also removes its deliveries through the FK.
  await pool.query(`
    DELETE FROM message_reminders
    WHERE id IN (
      SELECT id FROM message_reminders
      WHERE state = 'due' AND due_at < NOW() - INTERVAL '30 days'
      ORDER BY due_at ASC
      LIMIT 5000
    )
  `);
  for (const table of ["desktop_push_notifications", "desktop_reminder_deliveries"] as const) {
    await pool.query(`
    DELETE FROM ${table}
    WHERE id IN (
      SELECT id
      FROM ${table}
      WHERE (state = 'delivered' AND delivered_at < NOW() - INTERVAL '30 days')
         OR (state = 'dead' AND updated_at < NOW() - INTERVAL '90 days')
      ORDER BY updated_at ASC
      LIMIT 5000
    )
    `);
  }
}

export function startDesktopPushWorker(): () => Promise<void> {
  let credentials;
  try {
    credentials = readApnsCredentials();
  } catch (error) {
    console.error(`[desktop-push] APNs credentials could not be loaded; push delivery is disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!credentials) {
    console.warn("[desktop-push] APNs credentials are not configured; push delivery is disabled.");
  }
  const client = credentials ? new ApnsClient(credentials) : null;
  const workerId = randomUUID();
  let running = false;
  let runningPromise: Promise<void> | null = null;
  let stopped = false;
  let lastCleanupAt = 0;

  const tick = () => {
    if (stopped || running) return;
    running = true;
    const run = (async () => {
      try {
        if (Date.now() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
          await cleanupTerminalNotifications();
          lastCleanupAt = Date.now();
        }
        await enqueueDueReminders();
        if (client) await processBatch(client, workerId);
      } catch (error) {
        console.error(`[desktop-push] Worker iteration failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = false;
      }
    })();
    const pending = run.finally(() => {
      if (runningPromise === pending) runningPromise = null;
    });
    runningPromise = pending;
  };
  const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
  interval.unref();
  void tick();
  return async () => {
    stopped = true;
    clearInterval(interval);
    await runningPromise;
    client?.close();
  };
}
