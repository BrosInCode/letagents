import { enqueueDueReminders, loadReminderMessage, deleteMessageReminder, REMINDER_ENQUEUE_LIMIT } from "./reminders.js";
import { randomUUID } from "node:crypto";
import { canNotifyConversation } from "../conversations/store.js";

import { getProjectById } from "../db.js";
import { pool } from "../db/client.js";
import { isProjectRoomMember, resolveProjectRepoRoomAccessDecision } from "../rooms/access.js";
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
import { classifyApnsResult, retryDelayMs, type ApnsDisposition } from "./delivery-policy.js";
import { startWakeWebhookWorker } from "./wake-webhooks.js";
import { getPushDeliveryAccount } from "./push-account.js";
import { loadJoinRequestPushPreview } from "./join-request-pushes.js";
import { DUE_IN_MS_SQL, readDueInMs, startJobQueueLoop } from "../server/job-queue-wakes.js";

const CLAIM_LIMIT = 50;
const DELIVERY_CONCURRENCY = 10;
const MAX_ATTEMPTS = 10;
export const MAX_CONSECUTIVE_DEVICE_FAILURES = 50;
const CLEANUP_INTERVAL_MS = 60 * 60_000;

export interface ClaimedNotification {
  id: string;
  reminder_id?: string | null;
  /** Set for a request to join a room; message_number is 0 for such a row. */
  join_request_id?: string | null;
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


type DeliveryTable = "desktop_push_notifications" | "desktop_reminder_deliveries" | "desktop_join_request_pushes";
const DELIVERY_TABLES: readonly DeliveryTable[] = ["desktop_push_notifications", "desktop_reminder_deliveries", "desktop_join_request_pushes"];
function deliveryTable(notification: ClaimedNotification): DeliveryTable {
  if (notification.join_request_id) return "desktop_join_request_pushes";
  return notification.reminder_id ? "desktop_reminder_deliveries" : "desktop_push_notifications";
}
/** The columns that differ between the three outboxes, read into one ClaimedNotification shape. */
function claimedColumns(table: DeliveryTable): string {
  switch (table) {
    case "desktop_reminder_deliveries":
      return "claimed.reminder_id, NULL::text AS conversation_id, NULL::text AS join_request_id, claimed.message_number, claimed.thread_root_number";
    case "desktop_join_request_pushes":
      return "NULL::text AS reminder_id, NULL::text AS conversation_id, claimed.join_request_id, 0 AS message_number, NULL::integer AS thread_root_number";
    default:
      return "NULL::text AS reminder_id, claimed.conversation_id, NULL::text AS join_request_id, claimed.message_number, claimed.thread_root_number";
  }
}
export function claimNotifications(workerId: string): Promise<ClaimedNotification[]> {
  return claimDeliveryTable(workerId, "desktop_push_notifications");
}
export function claimReminderDeliveries(workerId: string): Promise<ClaimedNotification[]> {
  return claimDeliveryTable(workerId, "desktop_reminder_deliveries");
}
export function claimJoinRequestPushes(workerId: string): Promise<ClaimedNotification[]> {
  return claimDeliveryTable(workerId, "desktop_join_request_pushes");
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
             ${claimedColumns(table)},
             claimed.room_display_name,
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
      for (const table of DELIVERY_TABLES) {
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

  if (notification.join_request_id) {
    // The request may have been answered while this row waited: then nothing is
    // sent, and a row of a person who is no longer an admin is retired too.
    try {
      const preview = await loadJoinRequestPushPreview(notification.join_request_id, notification.account_id);
      if (!preview || !preview.pending || !preview.admin) {
        await recordJoinRequestRetired(notification, workerId, !preview
          ? "Join request no longer exists"
          : !preview.pending ? "Join request already decided" : "Account is no longer a room admin");
        return;
      }
      notification = { ...notification, room_display_name: preview.roomDisplayName, sender: preview.requester, body: "" };
    } catch (error) { await recordAuthorizationError(notification, workerId, error); return; }
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
      joinRequestId: notification.join_request_id ?? null,
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

async function recordJoinRequestRetired(notification: ClaimedNotification, workerId: string, reason: string): Promise<void> {
  await pool.query(`
    UPDATE desktop_join_request_pushes
    SET state = 'dead', room_display_name = '', sender = '', body = '',
        last_status = NULL, last_error = $3,
        claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
    WHERE id = $1 AND claimed_by = $2
  `, [notification.id, workerId, reason]);
}

export function authorizeReminderAccess(accountId: string, roomId: string): Promise<DesktopPushAuthorizationDecision> {
  return authorizeDesktopPushNotification({ accountId, roomId }, {
    getProject: getProjectById, getAccount: getPushDeliveryAccount, resolveAccess: resolveProjectRepoRoomAccessDecision,
    isRoomMember: isProjectRoomMember,
  });
}

/** Claims and sends one batch from each outbox. Returns true when any outbox gave a full batch (more may wait). */
export async function processBatch(client: Pick<ApnsClient, "send">, workerId: string): Promise<boolean> {
  const batches = [
    await claimNotifications(workerId),
    await claimReminderDeliveries(workerId),
    await claimJoinRequestPushes(workerId),
  ];
  const notifications = batches.flat();
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
  return batches.some((batch) => batch.length >= CLAIM_LIMIT);
}

/**
 * Milliseconds until the next push work falls due by the database clock: a
 * pending reminder, a delivery's retry or a stale claim's takeover. Null when
 * nothing waits. Without APNs only reminders matter (they are still enqueued).
 */
export async function nextDesktopPushDueInMs(includeDeliveries: boolean): Promise<number | null> {
  // Rows already due count too (zero or less): one may fall due after a claim's statement started.
  const parts = ["(SELECT min(due_at) FROM message_reminders WHERE state = 'pending')"];
  if (includeDeliveries) {
    for (const table of DELIVERY_TABLES) {
      // Only rows a claim can take: a disabled device's rows are never claimed.
      parts.push(`(SELECT min(next_attempt_at) FROM ${table} WHERE state IN ('queued', 'retry')
        AND device_id IN (SELECT id FROM desktop_push_devices WHERE enabled))`);
      parts.push(`(SELECT min(claimed_at) + INTERVAL '5 minutes' FROM ${table} WHERE state = 'processing')`);
    }
  }
  const result = await pool.query<{ due_in_ms: unknown }>(`SELECT ${DUE_IN_MS_SQL(`LEAST(${parts.join(", ")})`)} AS due_in_ms`);
  return readDueInMs(result.rows[0]);
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
  for (const table of DELIVERY_TABLES) {
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

/**
 * Push delivery runs when a transaction that queued a push or a reminder
 * commits (`wakeJobQueue("desktop_push")`), when the next reminder or retry
 * falls due, and at the latest every fallback interval.
 */
export function startDesktopPushWorker(options: { fallbackMs?: number } = {}): () => Promise<void> {
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
  let lastCleanupAt = 0;

  const loop = startJobQueueLoop({
    queue: "desktop_push",
    label: "desktop-push",
    fallbackMs: options.fallbackMs,
    logError: (error) => console.error(`[desktop-push] Worker iteration failed: ${error instanceof Error ? error.message : String(error)}`),
    async run() {
      if (Date.now() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
        await cleanupTerminalNotifications();
        lastCleanupAt = Date.now();
      }
      const dueReminders = await enqueueDueReminders();
      const fullBatch = client ? await processBatch(client, workerId) : false;
      if (fullBatch || dueReminders >= REMINDER_ENQUEUE_LIMIT) return { again: true };
      return { nextDueInMs: await nextDesktopPushDueInMs(Boolean(client)) };
    },
  });
  // Wake webhooks run their own loop: a slow receiver never delays a push.
  const stopWakeWebhooks = startWakeWebhookWorker({ fallbackMs: options.fallbackMs });
  return async () => {
    await Promise.all([loop.stop(), stopWakeWebhooks()]);
    client?.close();
  };
}
