/**
 * The wake webhook half of the notifications worker. Deliveries are claimed
 * like desktop pushes (`FOR UPDATE SKIP LOCKED`, a stale claim is taken back
 * after 5 minutes) and retried with the same backoff: network errors and 5xx
 * are retried up to 10 attempts; 4xx, redirects and refused addresses are
 * final. Five final failures in a row pause the rule.
 */
import { randomUUID } from "node:crypto";

import { getProjectById } from "../db.js";
import { pool } from "../db/client.js";
import { loadConnectorCipher, type ConnectorCipher, type EncryptedCredentials } from "../connectors/crypto.js";
import { resolveProjectRepoRoomAccessDecision } from "../rooms/access.js";
import { queueWakeRuleInvalidation } from "../server/events.js";
import {
  afterFinalWakeWebhookFailure,
  buildWakeWebhookBody,
  signWakeWebhook,
  wakeWebhookBinding,
  wakeWebhookHeaders,
  wakeWebhookRoomUrl,
} from "../wake-rules/webhook-delivery.js";
import { postWakeWebhook, type WakeWebhookSendResult } from "../wake-rules/webhook-url.js";
import { authorizeDesktopPushNotification, type DesktopPushAuthorizationDecision } from "./authorization.js";
import { retryDelayMs } from "./delivery-policy.js";
import { getPushDeliveryAccount } from "./push-account.js";

const POLL_INTERVAL_MS = 2_000;
const CLAIM_LIMIT = 20;
const DELIVERY_CONCURRENCY = 10;
export const WAKE_WEBHOOK_MAX_ATTEMPTS = 10;
const CLEANUP_INTERVAL_MS = 60 * 60_000;

export interface ClaimedWakeWebhook {
  id: string;
  rule_id: string;
  room_id: string;
  message_number: number;
  sender: string;
  text_preview: string;
  attempt_count: number;
  rule_status: string;
  owner_account_id: string | null;
  delivery_target: EncryptedCredentials | null;
}

export interface WakeWebhookDeliveryDeps {
  cipher: ConnectorCipher | null;
  /** Whether the agent's account may still read the room. */
  authorize(accountId: string, roomId: string): Promise<DesktopPushAuthorizationDecision>;
  send(input: { url: string; body: string; headers: Record<string, string> }): Promise<WakeWebhookSendResult>;
  now(): Date;
}

export function defaultWakeWebhookDeps(): WakeWebhookDeliveryDeps {
  return {
    cipher: loadConnectorCipher(),
    authorize: (accountId, roomId) => authorizeDesktopPushNotification({ accountId, roomId }, {
      getProject: getProjectById, getAccount: getPushDeliveryAccount, resolveAccess: resolveProjectRepoRoomAccessDecision,
    }),
    send: (input) => postWakeWebhook(input),
    now: () => new Date(),
  };
}

export async function claimWakeWebhookDeliveries(workerId: string, limit = CLAIM_LIMIT): Promise<ClaimedWakeWebhook[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query(`
      UPDATE wake_webhook_deliveries
         SET state = 'retry', claimed_at = NULL, claimed_by = NULL, updated_at = NOW()
       WHERE state = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes'
    `);
    const result = await client.query<ClaimedWakeWebhook>(`
      WITH ready AS (
        SELECT id FROM wake_webhook_deliveries
         WHERE state IN ('queued', 'retry') AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      ), claimed AS (
        UPDATE wake_webhook_deliveries AS delivery
           SET state = 'processing', attempt_count = delivery.attempt_count + 1,
               claimed_at = NOW(), claimed_by = $2, updated_at = NOW()
          FROM ready
         WHERE delivery.id = ready.id
        RETURNING delivery.*
      )
      SELECT claimed.id, claimed.rule_id, claimed.room_id, claimed.message_number, claimed.sender,
             claimed.text_preview, claimed.attempt_count,
             rule.status AS rule_status, rule.owner_account_id, rule.delivery_target
        FROM claimed
        INNER JOIN agent_wake_rules AS rule ON rule.id = claimed.rule_id
    `, [limit, workerId]);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type Outcome =
  | { kind: "delivered"; status: number }
  /** Try again later; does not count as a failure of the rule. */
  | { kind: "retry"; status: number; error: string }
  /** Failed for good; counts toward pausing the rule. */
  | { kind: "failed"; status: number; error: string }
  /** The rule stopped (cancelled, paused, expired): the delivery is dropped, nothing counts. */
  | { kind: "skipped"; error: string };

const short = (text: string) => text.slice(0, 500);

/** Record one attempt. Returns true when the rule paused because of it. */
export async function recordWakeWebhookOutcome(
  delivery: ClaimedWakeWebhook,
  workerId: string,
  outcome: Outcome,
  now: Date,
): Promise<boolean> {
  const nowIso = now.toISOString();
  let final = outcome;
  if (final.kind === "retry" && delivery.attempt_count >= WAKE_WEBHOOK_MAX_ATTEMPTS) {
    final = { kind: "failed", status: final.status, error: `${final.error} (gave up after ${delivery.attempt_count} attempts)` };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let paused = false;
    if (final.kind === "delivered") {
      await client.query(`
        UPDATE wake_webhook_deliveries
           SET state = 'delivered', delivered_at = $3, sender = '', text_preview = '', last_status = $4, last_error = NULL,
               claimed_at = NULL, claimed_by = NULL, updated_at = $3
         WHERE id = $1 AND claimed_by = $2
      `, [delivery.id, workerId, nowIso, final.status]);
      await client.query(`
        UPDATE agent_wake_rules
           SET delivery_consecutive_failures = 0, delivery_delivered_count = delivery_delivered_count + 1,
               delivery_last_status = $2, delivery_last_error = NULL, delivery_last_attempt_at = $3
         WHERE id = $1
      `, [delivery.rule_id, final.status, nowIso]);
    } else if (final.kind === "retry") {
      const nextAttempt = new Date(now.getTime() + retryDelayMs(delivery.attempt_count)).toISOString();
      await client.query(`
        UPDATE wake_webhook_deliveries
           SET state = 'retry', next_attempt_at = $3, last_status = $4, last_error = $5,
               claimed_at = NULL, claimed_by = NULL, updated_at = $6
         WHERE id = $1 AND claimed_by = $2
      `, [delivery.id, workerId, nextAttempt, final.status || null, short(final.error), nowIso]);
      await client.query(`
        UPDATE agent_wake_rules SET delivery_last_status = $2, delivery_last_error = $3, delivery_last_attempt_at = $4 WHERE id = $1
      `, [delivery.rule_id, final.status || null, short(final.error), nowIso]);
    } else {
      await client.query(`
        UPDATE wake_webhook_deliveries
           SET state = 'dead', sender = '', text_preview = '', last_status = $3, last_error = $4,
               claimed_at = NULL, claimed_by = NULL, updated_at = $5
         WHERE id = $1 AND claimed_by = $2
      `, [delivery.id, workerId, final.kind === "failed" ? final.status || null : null, short(final.error), nowIso]);
      if (final.kind === "failed") {
        const rule = await client.query<{ status: string; failures: number }>(`
          SELECT status, delivery_consecutive_failures AS failures FROM agent_wake_rules WHERE id = $1 FOR UPDATE
        `, [delivery.rule_id]);
        const current = rule.rows[0];
        if (current) {
          const next = afterFinalWakeWebhookFailure(current.failures);
          paused = next.pause && current.status === "active";
          await client.query(`
            UPDATE agent_wake_rules
               SET delivery_consecutive_failures = $2, delivery_last_status = $3, delivery_last_error = $4,
                   delivery_last_attempt_at = $5,
                   status = CASE WHEN $6::boolean THEN 'paused' ELSE status END,
                   paused_at = CASE WHEN $6::boolean THEN $5::timestamptz ELSE paused_at END,
                   updated_at = CASE WHEN $6::boolean THEN $5::timestamptz ELSE updated_at END
             WHERE id = $1
          `, [delivery.rule_id, next.consecutiveFailures, final.status || null, short(final.error), nowIso, paused]);
          if (paused) {
            // Nothing more goes out for a paused rule; adding it again resumes it.
            await client.query(`
              UPDATE wake_webhook_deliveries
                 SET state = 'dead', sender = '', text_preview = '', last_error = 'The rule was paused.', updated_at = $2
               WHERE rule_id = $1 AND state IN ('queued', 'retry')
            `, [delivery.rule_id, nowIso]);
          }
        }
      }
    }
    await client.query("COMMIT");
    return paused;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function attempt(delivery: ClaimedWakeWebhook, deps: WakeWebhookDeliveryDeps, now: Date): Promise<Outcome> {
  if (delivery.rule_status !== "active") return { kind: "skipped", error: `The rule is ${delivery.rule_status}.` };
  if (!delivery.owner_account_id || !delivery.delivery_target) return { kind: "failed", status: 0, error: "The rule has no webhook target." };
  let access: DesktopPushAuthorizationDecision;
  try {
    access = await deps.authorize(delivery.owner_account_id, delivery.room_id);
  } catch (error) {
    return { kind: "retry", status: 0, error: `Room access check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (access === "retry") return { kind: "retry", status: 0, error: "No usable GitHub credential is available to check room access." };
  if (access === "deny") return { kind: "failed", status: 0, error: "The agent's account can no longer read this room." };
  if (!deps.cipher) return { kind: "retry", status: 0, error: "Webhook delivery is not set up on this server." };
  let target: { url: string; secret: string };
  try {
    const opened = deps.cipher.decrypt(delivery.delivery_target, wakeWebhookBinding(delivery.rule_id, delivery.owner_account_id));
    if (typeof opened.url !== "string" || typeof opened.secret !== "string") throw new Error("bad target");
    target = { url: opened.url, secret: opened.secret };
  } catch {
    return { kind: "failed", status: 0, error: "The stored webhook target could not be read. Add the rule again." };
  }
  const timestamp = Math.floor(now.getTime() / 1000);
  const body = buildWakeWebhookBody({
    delivery_id: delivery.id,
    room_id: delivery.room_id,
    message_id: `msg_${delivery.message_number}`,
    sender: delivery.sender,
    text_preview: delivery.text_preview,
    room_url: wakeWebhookRoomUrl(delivery.room_id),
    rule_id: delivery.rule_id,
    sent_at: now.toISOString(),
  });
  const headers = wakeWebhookHeaders({ deliveryId: delivery.id, timestamp, signature: signWakeWebhook(target.secret, timestamp, body) });
  let result: WakeWebhookSendResult;
  try {
    result = await deps.send({ url: target.url, body, headers });
  } catch (error) {
    result = { outcome: "retry", status: 0, error: error instanceof Error ? error.message : String(error) };
  }
  if (result.outcome === "delivered") return { kind: "delivered", status: result.status };
  const error = result.error ?? `HTTP ${result.status}`;
  return result.outcome === "retry" ? { kind: "retry", status: result.status, error } : { kind: "failed", status: result.status, error };
}

/** One attempt of one claimed delivery, recorded. */
export async function deliverWakeWebhook(
  delivery: ClaimedWakeWebhook,
  workerId: string,
  deps: WakeWebhookDeliveryDeps,
): Promise<void> {
  const now = deps.now();
  const outcome = await attempt(delivery, deps, now);
  if (await recordWakeWebhookOutcome(delivery, workerId, outcome, deps.now())) queueWakeRuleInvalidation(delivery.room_id);
}

export async function processWakeWebhookBatch(workerId: string, deps: WakeWebhookDeliveryDeps = defaultWakeWebhookDeps()): Promise<number> {
  const deliveries = await claimWakeWebhookDeliveries(workerId);
  for (let index = 0; index < deliveries.length; index += DELIVERY_CONCURRENCY) {
    await Promise.all(deliveries.slice(index, index + DELIVERY_CONCURRENCY).map(async (delivery) => {
      try {
        await deliverWakeWebhook(delivery, workerId, deps);
      } catch (error) {
        // The claim expires after 5 minutes and the delivery is tried again.
        console.error(`[wake webhooks] could not record delivery ${delivery.id}`, error instanceof Error ? error.message : error);
      }
    }));
  }
  return deliveries.length;
}

export async function cleanupWakeWebhookDeliveries(): Promise<void> {
  await pool.query(`
    DELETE FROM wake_webhook_deliveries
     WHERE id IN (
       SELECT id FROM wake_webhook_deliveries
        WHERE state IN ('delivered', 'dead') AND updated_at < NOW() - INTERVAL '7 days'
        ORDER BY updated_at ASC
        LIMIT 5000
     )
  `);
}

/** Polls for due deliveries every 2 seconds. Returns a stop function that waits for the running pass. */
export function startWakeWebhookWorker(): () => Promise<void> {
  const workerId = randomUUID();
  const deps = defaultWakeWebhookDeps();
  let running: Promise<void> | null = null;
  let stopped = false;
  let lastCleanupAt = 0;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        if (Date.now() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
          await cleanupWakeWebhookDeliveries();
          lastCleanupAt = Date.now();
        }
        await processWakeWebhookBatch(workerId, deps);
      } catch (error) {
        console.error(`[wake webhooks] worker pass failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })().finally(() => { running = null; });
  };
  const interval = setInterval(tick, POLL_INTERVAL_MS);
  interval.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(interval);
    await running;
  };
}
