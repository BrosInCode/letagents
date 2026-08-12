import { randomUUID } from "node:crypto";

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
  device_id: string;
  account_id: string;
  device_token: string;
  environment: ApnsEnvironment;
  room_id: string;
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

export async function claimNotifications(workerId: string): Promise<ClaimedNotification[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      UPDATE desktop_push_notifications
      SET state = 'retry', claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
      WHERE state = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes'
    `);
    const result = await client.query<ClaimedNotification>(`
      WITH ready AS (
        SELECT notification.id
        FROM desktop_push_notifications AS notification
        INNER JOIN desktop_push_devices AS device ON device.id = notification.device_id
        WHERE notification.state IN ('queued', 'retry')
          AND notification.next_attempt_at <= NOW()
          AND device.enabled = TRUE
        ORDER BY notification.next_attempt_at ASC, notification.created_at ASC
        FOR UPDATE OF notification SKIP LOCKED
        LIMIT $1
      ), claimed AS (
        UPDATE desktop_push_notifications AS notification
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
  await pool.query(`
    UPDATE desktop_push_notifications AS notification
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
      UPDATE desktop_push_notifications
      SET state = 'dead', room_display_name = '', sender = '', body = '',
          last_status = NULL, last_error = $3,
          claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
      WHERE id = $1 AND claimed_by = $2
    `, [notification.id, workerId, message]);
    return;
  }

  const nextAttempt = new Date(Date.now() + retryDelayMs(notification.attempt_count)).toISOString();
  await pool.query(`
    UPDATE desktop_push_notifications
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
      UPDATE desktop_push_notifications
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
        UPDATE desktop_push_notifications
        SET state = 'dead', room_display_name = '', sender = '', body = '',
            last_status = $3, last_error = $4,
            claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
        WHERE id = $1 AND claimed_by = $2
      `, [notification.id, workerId, result.status || null, error]);
      await client.query(`
        UPDATE desktop_push_notifications
        SET state = 'dead', room_display_name = '', sender = '', body = '',
            last_error = $2, updated_at = NOW()
        WHERE device_id = $1 AND state IN ('queued', 'retry')
      `, [notification.device_id, cascadeError]);
    } else if (disposition === "retry") {
      const nextAttempt = new Date(Date.now() + retryDelayMs(notification.attempt_count)).toISOString();
      await client.query(`
        UPDATE desktop_push_notifications
        SET state = 'retry', next_attempt_at = $3, last_status = $4, last_error = $5,
            claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
        WHERE id = $1 AND claimed_by = $2
      `, [notification.id, workerId, nextAttempt, result.status || null, error]);
    } else {
      await client.query(`
        UPDATE desktop_push_notifications
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

async function deliverNotification(
  client: ApnsClient,
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

  let result: ApnsSendResult;
  try {
    result = await client.send({
      notificationId: notification.id,
      deviceToken: notification.device_token,
      environment: notification.environment,
      roomId: notification.room_id,
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

async function processBatch(client: ApnsClient, workerId: string): Promise<void> {
  const notifications = await claimNotifications(workerId);
  const authorizationChecks = new Map<string, Promise<DesktopPushAuthorizationDecision>>();
  for (let index = 0; index < notifications.length; index += DELIVERY_CONCURRENCY) {
    await Promise.all(
      notifications.slice(index, index + DELIVERY_CONCURRENCY)
        .map((notification) => {
          const authorizationKey = `${notification.account_id}\u0000${notification.room_id}`;
          let authorization = authorizationChecks.get(authorizationKey);
          if (!authorization) {
            authorization = authorizeDesktopPushNotification(
              { accountId: notification.account_id, roomId: notification.room_id },
              {
                getProject: getProjectById,
                getAccount: getPushDeliveryAccount,
                resolveAccess: resolveProjectRepoRoomAccessDecision,
              },
            );
            authorizationChecks.set(authorizationKey, authorization);
          }
          return deliverNotification(client, workerId, notification, () => authorization);
        }),
    );
  }
}

async function cleanupTerminalNotifications(): Promise<void> {
  await pool.query(`
    DELETE FROM desktop_push_notifications
    WHERE id IN (
      SELECT id
      FROM desktop_push_notifications
      WHERE (state = 'delivered' AND delivered_at < NOW() - INTERVAL '30 days')
         OR (state = 'dead' AND updated_at < NOW() - INTERVAL '90 days')
      ORDER BY updated_at ASC
      LIMIT 5000
    )
  `);
}

export function startDesktopPushWorker(): () => Promise<void> {
  let credentials;
  try {
    credentials = readApnsCredentials();
  } catch (error) {
    console.error(`[desktop-push] APNs credentials could not be loaded; delivery worker is disabled: ${error instanceof Error ? error.message : String(error)}`);
    return async () => undefined;
  }
  if (!credentials) {
    console.warn("[desktop-push] APNs credentials are not configured; delivery worker is disabled.");
    return async () => undefined;
  }
  const client = new ApnsClient(credentials);
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
      await processBatch(client, workerId);
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
    client.close();
  };
}
