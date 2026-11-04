/**
 * The wake delivery half of the notifications worker (webhooks, email and
 * MCP events).
 *
 * Deliveries are claimed like desktop pushes (`FOR UPDATE SKIP LOCKED`, a
 * stale claim is taken back after 5 minutes) and retried with the same
 * backoff. Webhooks, email and MCP events run in separate lanes, each a pool that starts
 * the next delivery as soon as one finishes. Claims are fair per account: one
 * account gets at most a few deliveries per claim and in flight at once, so
 * one slow or busy receiver cannot hold everyone else back.
 *
 * Each attempt checks that the rule is still current, that the credential
 * that registered it still works, and that its account can still read the
 * room. A webhook: network errors and 5xx retry, up to 10 attempts; 408, 425
 * and 429 wait for their Retry-After (at most 5 minutes) and never count
 * toward a pause; other 4xx (410 and 413 included), redirects and refused
 * addresses are final. An MCP event is a webhook in the Standard Webhooks
 * envelope (`../wake-rules/mcp-events.ts`); a 410 also ends its
 * subscription. An email: a
 * recipient rejection (5xx to RCPT TO or DATA) is final, a temporary one
 * retries, and the operator's own SMTP problems retry without touching the
 * rule. Five final failures in a row pause the rule. Only error classes are
 * stored, never transport text.
 */
import { randomUUID } from "node:crypto";

import { WAKE_RULE_LIMITS, type WakeRuleDeliveryKind } from "../../../shared/wake-rules.mjs";
import { getProjectById } from "../db.js";
import { db, pool } from "../db/client.js";
import { isWakeRuleCredentialLive, retireWakeRulesForCredential } from "../db/wake-rules.js";
import { getMcpEventMessage } from "../db/wake-rules-mcp-events.js";
import { loadConnectorCipher, type ConnectorCipher, type EncryptedCredentials } from "../connectors/crypto.js";
import { resolveProjectRepoRoomAccessDecision } from "../rooms/access.js";
import { queueWakeRuleInvalidation } from "../server/events.js";
import {
  composeWakeEmail,
  loadWakeMailer,
  wakeEmailConfirmToken,
  wakeEmailDisableToken,
  type WakeMailer,
} from "../wake-rules/email.js";
import {
  buildMcpEventBody,
  mcpEventHeaders,
  mcpEventId,
  mcpEventSignature,
  parseMcpEventSecret,
  MCP_EVENT_ROOM_MESSAGE,
  type McpRoomMessageData,
} from "../wake-rules/mcp-events.js";
import { wakeLinkUrl, wakeRoomUrl } from "../wake-rules/public-url.js";
import {
  WAKE_WEBHOOK_SENDER_MAX,
  afterFinalWakeWebhookFailure,
  buildWakeWebhookBody,
  oneLine,
  webhookOutcome,
  type WakeDeliveryOutcome,
  signWakeWebhook,
  wakeWebhookBinding,
  wakeWebhookHeaders,
  wakeWebhookTextPreview,
} from "../wake-rules/webhook-delivery.js";
import { postWakeWebhook, type WakeWebhookSendResult } from "../wake-rules/webhook-url.js";
import { wakeWebhookBearerBinding, wakeWebhookBearerHeader } from "../wake-rules/webhook-bearer.js";
import { authorizeDesktopPushNotification, type DesktopPushAuthorizationDecision } from "./authorization.js";
import { retryDelayMs } from "./delivery-policy.js";
import { getPushDeliveryAccount } from "./push-account.js";

const POLL_INTERVAL_MS = 1_000;
export const WAKE_WEBHOOK_MAX_ATTEMPTS = 10;
/** Deliveries of one account in flight at once, across instances. */
export const WAKE_DELIVERY_IN_FLIGHT_PER_ACCOUNT = 3;
const CLEANUP_INTERVAL_MS = 60 * 60_000;
const CLEANUP_BATCH = 5000;

export type WakeDeliveryKind = WakeRuleDeliveryKind;

/** How many deliveries of each kind one process sends at once. */
export const WAKE_DELIVERY_LANES: Readonly<Record<WakeDeliveryKind, number>> = { webhook: 16, email: 4, mcp_event: 8 };
const LANE_KINDS = Object.keys(WAKE_DELIVERY_LANES) as WakeDeliveryKind[];

export interface ClaimedWakeWebhook {
  id: string;
  rule_id: string;
  room_id: string;
  kind: WakeDeliveryKind;
  purpose: "message" | "confirm";
  message_number: number | null;
  sender: string;
  text_preview: string;
  attempt_count: number;
  rule_status: string;
  agent_name: string;
  room_name: string | null;
  confirm_expires_at: string | null;
  expires_at: string | null;
  owner_account_id: string | null;
  credential_kind: string | null;
  credential_ref: string | null;
  delivery_target: EncryptedCredentials | null;
  delivery_bearer: EncryptedCredentials | null;
  /** MCP Events subscriptions: the id the receiver knows the subscription by. */
  mcp_subscription_id: string | null;
}

export { webhookOutcome, type WakeDeliveryOutcome };

export interface WakeWebhookDeliveryDeps {
  cipher: ConnectorCipher | null;
  /** Whether the agent's account may still read the room. */
  authorize(accountId: string, roomId: string): Promise<DesktopPushAuthorizationDecision>;
  /** Whether the credential that registered the rule still works. */
  credentialLive(kind: string | null, ref: string | null): Promise<boolean>;
  send(input: { url: string; body: string; headers: Record<string, string>; maxBodyBytes?: number }): Promise<WakeWebhookSendResult>;
  /** Null while the server has no SMTP settings: email deliveries then wait and retry. */
  mailer: WakeMailer | null;
  now(): Date;
}

export function defaultWakeWebhookDeps(): WakeWebhookDeliveryDeps {
  return {
    cipher: loadConnectorCipher(),
    authorize: (accountId, roomId) => authorizeDesktopPushNotification({ accountId, roomId }, {
      getProject: getProjectById, getAccount: getPushDeliveryAccount, resolveAccess: resolveProjectRepoRoomAccessDecision,
    }),
    credentialLive: isWakeRuleCredentialLive,
    send: (input) => postWakeWebhook(input),
    mailer: loadWakeMailer(),
    now: () => new Date(),
  };
}

/**
 * Claim up to `limit` due deliveries of one kind, oldest first, but at most
 * `perAccount` for any one account in this claim, and none for an account
 * that already has `WAKE_DELIVERY_IN_FLIGHT_PER_ACCOUNT` in flight. MCP
 * events of one subscription go one at a time, in message order: the next is
 * claimed only once the one before it has finished.
 */
export async function claimWakeWebhookDeliveries(
  workerId: string,
  limit = 20,
  kind?: WakeDeliveryKind,
  perAccount = WAKE_DELIVERY_IN_FLIGHT_PER_ACCOUNT,
): Promise<ClaimedWakeWebhook[]> {
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
      WITH in_flight AS (
        SELECT owner_account_id, count(*)::int AS n FROM wake_webhook_deliveries
         WHERE state = 'processing' GROUP BY owner_account_id
      ), rule_in_flight AS (
        SELECT DISTINCT rule_id FROM wake_webhook_deliveries WHERE state = 'processing' AND kind = 'mcp_event'
      ), ranked AS (
        SELECT delivery.id,
               row_number() OVER (PARTITION BY delivery.owner_account_id ORDER BY delivery.next_attempt_at, delivery.created_at) AS place,
               row_number() OVER (PARTITION BY delivery.rule_id ORDER BY delivery.next_attempt_at, delivery.message_number, delivery.created_at) AS rule_place,
               COALESCE(in_flight.n, 0) AS busy
          FROM wake_webhook_deliveries AS delivery
          LEFT JOIN in_flight ON in_flight.owner_account_id IS NOT DISTINCT FROM delivery.owner_account_id
         WHERE delivery.state IN ('queued', 'retry') AND delivery.next_attempt_at <= NOW()
           AND ($3::text IS NULL OR delivery.kind = $3)
      ), ready AS (
        SELECT delivery.id FROM wake_webhook_deliveries AS delivery
          JOIN ranked ON ranked.id = delivery.id
         WHERE ranked.place + ranked.busy <= $4
           AND (delivery.kind <> 'mcp_event'
                OR (ranked.rule_place = 1 AND NOT EXISTS (SELECT 1 FROM rule_in_flight WHERE rule_in_flight.rule_id = delivery.rule_id)))
           AND delivery.state IN ('queued', 'retry') AND delivery.next_attempt_at <= NOW()
         ORDER BY delivery.next_attempt_at ASC, delivery.created_at ASC
         FOR UPDATE OF delivery SKIP LOCKED
         LIMIT $1
      ), claimed AS (
        UPDATE wake_webhook_deliveries AS delivery
           SET state = 'processing', attempt_count = delivery.attempt_count + 1,
               claimed_at = NOW(), claimed_by = $2, updated_at = NOW()
          FROM ready
         WHERE delivery.id = ready.id
        RETURNING delivery.*
      )
      SELECT claimed.id, claimed.rule_id, claimed.room_id, claimed.kind, claimed.purpose, claimed.message_number,
             claimed.sender, claimed.text_preview, claimed.attempt_count,
             rule.status AS rule_status, rule.agent_name, rule.confirm_expires_at, rule.expires_at,
             rule.owner_account_id, rule.credential_kind, rule.credential_ref, rule.delivery_target, rule.delivery_bearer,
             rule.mcp_subscription_id,
             room.display_name AS room_name
        FROM claimed
        INNER JOIN agent_wake_rules AS rule ON rule.id = claimed.rule_id
        LEFT JOIN rooms AS room ON room.id = claimed.room_id
    `, [limit, workerId, kind ?? null, perAccount]);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Record one attempt. Returns true when the rule's status changed because of it (paused, or retired by its receiver). */
export async function recordWakeWebhookOutcome(
  delivery: ClaimedWakeWebhook,
  workerId: string,
  outcome: WakeDeliveryOutcome,
  now: Date,
): Promise<boolean> {
  const nowIso = now.toISOString();
  let final = outcome;
  if (final.kind === "retry" && delivery.attempt_count >= WAKE_WEBHOOK_MAX_ATTEMPTS) {
    final = final.uncounted ? { kind: "skipped", error: final.error } : { kind: "failed", status: final.status, error: final.error };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let paused = false;
    const owned = async (text: string, values: unknown[]) => ((await client.query(text, values)).rowCount ?? 0) > 0;
    if (final.kind === "delivered") {
      // The rule's counters move only if this worker still held the delivery.
      if (await owned(`
        UPDATE wake_webhook_deliveries
           SET state = 'delivered', delivered_at = $3, sender = '', text_preview = '', last_status = $4, last_error = NULL,
               claimed_at = NULL, claimed_by = NULL, updated_at = $3
         WHERE id = $1 AND claimed_by = $2
      `, [delivery.id, workerId, nowIso, final.status])) {
        await client.query(`
          UPDATE agent_wake_rules
             SET delivery_consecutive_failures = 0, delivery_delivered_count = delivery_delivered_count + 1,
                 delivery_last_status = $2, delivery_last_error = NULL, delivery_last_attempt_at = $3
           WHERE id = $1
        `, [delivery.rule_id, final.status, nowIso]);
        if (delivery.kind === "mcp_event" && delivery.message_number !== null) {
          // The subscription's cursor only moves forward; a replayed older event leaves it.
          await client.query(`
            UPDATE agent_wake_rules
               SET mcp_cursor = CASE WHEN mcp_cursor IS NULL OR mcp_cursor::bigint < $2::bigint THEN $2::text ELSE mcp_cursor END
             WHERE id = $1
          `, [delivery.rule_id, delivery.message_number]);
        }
      }
    } else if (final.kind === "retry") {
      const waitMs = final.holdMs ?? retryDelayMs(delivery.attempt_count);
      const nextAttempt = new Date(now.getTime() + waitMs).toISOString();
      if (await owned(`
        UPDATE wake_webhook_deliveries
           SET state = 'retry', next_attempt_at = $3, last_status = $4, last_error = $5,
               claimed_at = NULL, claimed_by = NULL, updated_at = $6
         WHERE id = $1 AND claimed_by = $2
      `, [delivery.id, workerId, nextAttempt, final.status || null, final.error, nowIso])) {
        await client.query(`
          UPDATE agent_wake_rules SET delivery_last_status = $2, delivery_last_error = $3, delivery_last_attempt_at = $4 WHERE id = $1
        `, [delivery.rule_id, final.status || null, final.error, nowIso]);
      }
    } else {
      const held = await owned(`
        UPDATE wake_webhook_deliveries
           SET state = 'dead', sender = '', text_preview = '', last_status = $3, last_error = $4,
               claimed_at = NULL, claimed_by = NULL, updated_at = $5
         WHERE id = $1 AND claimed_by = $2
      `, [delivery.id, workerId, final.kind === "failed" ? final.status || null : null, final.error, nowIso]);
      if (held && final.kind === "failed") {
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
          `, [delivery.rule_id, next.consecutiveFailures, final.status || null, final.error, nowIso, paused]);
          if (paused) {
            // Nothing more goes out for a paused rule; adding it again resumes it.
            await client.query(`
              UPDATE wake_webhook_deliveries
                 SET state = 'dead', sender = '', text_preview = '', last_error = 'rule_paused', updated_at = $2
               WHERE rule_id = $1 AND state IN ('queued', 'retry')
            `, [delivery.rule_id, nowIso]);
          }
          if (final.retire && (current.status === "active" || current.status === "paused")) {
            // The receiver said the subscription is over (410 Gone): it ends now, whatever the failure count.
            await client.query(`
              UPDATE agent_wake_rules
                 SET status = 'retired', ended_reason = $2, ended_at = $3, updated_at = $3,
                     delivery_target = NULL, delivery_bearer = NULL
               WHERE id = $1 AND status IN ('active', 'paused')
            `, [delivery.rule_id, final.retire, nowIso]);
            await client.query(`
              UPDATE wake_webhook_deliveries
                 SET state = 'dead', sender = '', text_preview = '', last_error = 'receiver_gone', updated_at = $2
               WHERE rule_id = $1 AND state IN ('queued', 'retry')
            `, [delivery.rule_id, nowIso]);
            paused = true;
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

async function attempt(delivery: ClaimedWakeWebhook, deps: WakeWebhookDeliveryDeps, now: Date): Promise<WakeDeliveryOutcome> {
  // A message goes only to a confirmed, active rule; a confirmation only while the rule waits for one.
  const expected = delivery.purpose === "confirm" ? "pending_confirmation" : "active";
  if (delivery.rule_status !== expected) return { kind: "skipped", error: "rule_inactive" };
  if (delivery.expires_at && Date.parse(delivery.expires_at) <= now.getTime()) return { kind: "skipped", error: "rule_expired" };
  if (delivery.purpose === "confirm" && (!delivery.confirm_expires_at || Date.parse(delivery.confirm_expires_at) <= now.getTime())) {
    return { kind: "skipped", error: "confirmation_expired" };
  }
  if (!delivery.owner_account_id || !delivery.delivery_target) return { kind: "failed", status: 0, error: "target_unreadable" };
  // The sign-in that registered the rule must still work; a revoked one ends the rule.
  try {
    if (!(await deps.credentialLive(delivery.credential_kind, delivery.credential_ref))) {
      if (delivery.credential_kind === "token" || delivery.credential_kind === "agent_session") {
        await retireWakeRulesForCredential(db, delivery.credential_kind, delivery.credential_ref!);
      }
      queueWakeRuleInvalidation(delivery.room_id);
      return { kind: "skipped", error: "credential_revoked" };
    }
  } catch {
    return { kind: "retry", status: 0, error: "access_denied", uncounted: true };
  }
  let access: DesktopPushAuthorizationDecision;
  try {
    access = await deps.authorize(delivery.owner_account_id, delivery.room_id);
  } catch {
    return { kind: "retry", status: 0, error: "access_denied", uncounted: true };
  }
  if (access === "retry") return { kind: "retry", status: 0, error: "access_denied", uncounted: true };
  if (access === "deny") return { kind: "failed", status: 0, error: "access_denied" };
  if (!deps.cipher) return { kind: "retry", status: 0, error: "not_configured", uncounted: true };
  let opened: Record<string, unknown>;
  try {
    opened = deps.cipher.decrypt(delivery.delivery_target, wakeWebhookBinding(delivery.rule_id, delivery.owner_account_id));
  } catch {
    return { kind: "failed", status: 0, error: "target_unreadable" };
  }
  if (delivery.kind === "email") return attemptEmail(delivery, deps, deps.cipher, opened);
  if (typeof opened.url !== "string" || typeof opened.secret !== "string") return { kind: "failed", status: 0, error: "target_unreadable" };
  if (delivery.kind === "mcp_event") return attemptMcpEvent(delivery, deps, opened as { url: string; secret: string }, now);
  const timestamp = Math.floor(now.getTime() / 1000);
  const body = buildWakeWebhookBody({
    delivery_id: delivery.id,
    room_id: delivery.room_id,
    message_id: `msg_${delivery.message_number}`,
    sender: delivery.sender,
    text_preview: delivery.text_preview,
    room_url: wakeRoomUrl(delivery.room_id),
    rule_id: delivery.rule_id,
    sent_at: now.toISOString(),
  });
  const headers = wakeWebhookHeaders({ deliveryId: delivery.id, timestamp, signature: signWakeWebhook(opened.secret, timestamp, body) });
  if (delivery.delivery_bearer) {
    // The receiver's sender key goes only to the rule's own pinned URL (no redirects are followed).
    let sealed: Record<string, unknown>;
    try {
      sealed = deps.cipher.decrypt(delivery.delivery_bearer, wakeWebhookBearerBinding(delivery.rule_id, delivery.owner_account_id));
    } catch {
      return { kind: "failed", status: 0, error: "target_unreadable" };
    }
    if (typeof sealed.bearer !== "string") return { kind: "failed", status: 0, error: "target_unreadable" };
    Object.assign(headers, wakeWebhookBearerHeader(sealed.bearer));
  }
  let result: WakeWebhookSendResult;
  try {
    result = await deps.send({ url: opened.url, body, headers });
  } catch {
    result = { outcome: "retry", status: 0, error: "connect_failed" };
  }
  return webhookOutcome(result);
}

/**
 * One MCP event: the message is read now (its row holds no text), wrapped in
 * the Standard Webhooks envelope and signed with the subscription's secret
 * (and the previous one while a rotation window is open). The event id is
 * fixed by the rule and the message, so a retry or a replay repeats it. A 410
 * ends the subscription.
 */
async function attemptMcpEvent(
  delivery: ClaimedWakeWebhook,
  deps: WakeWebhookDeliveryDeps,
  opened: { url: string; secret: string; previous_secret?: unknown; previous_until?: unknown },
  now: Date,
): Promise<WakeDeliveryOutcome> {
  if (delivery.message_number === null || !delivery.mcp_subscription_id) return { kind: "failed", status: 0, error: "target_unreadable" };
  const message = await getMcpEventMessage(delivery.room_id, delivery.message_number);
  if (!message) return { kind: "skipped", error: "message_gone" };
  let keys;
  try {
    keys = [parseMcpEventSecret(opened.secret)];
    if (typeof opened.previous_secret === "string" && typeof opened.previous_until === "string" && Date.parse(opened.previous_until) > now.getTime()) {
      keys.push(parseMcpEventSecret(opened.previous_secret));
    }
  } catch {
    return { kind: "failed", status: 0, error: "target_unreadable" };
  }
  const data: McpRoomMessageData = {
    room_id: delivery.room_id,
    message_id: `msg_${message.number}`,
    sender: oneLine(message.sender, WAKE_WEBHOOK_SENDER_MAX),
    text_preview: wakeWebhookTextPreview(message.text),
    room_url: wakeRoomUrl(delivery.room_id),
    ...(message.thread_root_number !== null ? { thread_root_id: `msg_${message.thread_root_number}` } : {}),
  };
  const eventId = mcpEventId(delivery.rule_id, message.number);
  const body = buildMcpEventBody({
    eventId,
    name: MCP_EVENT_ROOM_MESSAGE,
    timestamp: new Date(message.timestamp).toISOString(),
    data,
    cursor: String(message.number),
  });
  const timestamp = Math.floor(now.getTime() / 1000);
  const headers = mcpEventHeaders({
    id: eventId,
    timestamp,
    signature: mcpEventSignature(keys, eventId, timestamp, body),
    subscriptionId: delivery.mcp_subscription_id,
  });
  let result: WakeWebhookSendResult;
  try {
    result = await deps.send({ url: opened.url, body, headers, maxBodyBytes: WAKE_RULE_LIMITS.mcpEventMaxBodyBytes });
  } catch {
    result = { outcome: "retry", status: 0, error: "connect_failed" };
  }
  if (result.status === 410) return { kind: "failed", status: 410, error: "http_4xx", retire: "the receiver answered 410 Gone" };
  return webhookOutcome(result);
}

async function attemptEmail(
  delivery: ClaimedWakeWebhook,
  deps: WakeWebhookDeliveryDeps,
  cipher: ConnectorCipher,
  opened: Record<string, unknown>,
): Promise<WakeDeliveryOutcome> {
  if (typeof opened.to !== "string") return { kind: "failed", status: 0, error: "target_unreadable" };
  if (!deps.mailer) return { kind: "retry", status: 0, error: "not_configured", uncounted: true };
  const disableUrl = wakeLinkUrl("disable", wakeEmailDisableToken(cipher, delivery.rule_id));
  const roomUrl = wakeRoomUrl(delivery.room_id);
  const message = delivery.purpose === "confirm"
    ? composeWakeEmail({
      purpose: "confirm",
      to: opened.to,
      roomUrl,
      disableUrl,
      deliveryId: delivery.id,
      confirmUrl: wakeLinkUrl("confirm", wakeEmailConfirmToken(cipher, delivery.rule_id, delivery.confirm_expires_at!)),
    })
    : composeWakeEmail({
      purpose: "message",
      to: opened.to,
      roomUrl,
      disableUrl,
      deliveryId: delivery.id,
      agentName: delivery.agent_name,
      roomName: delivery.room_name || delivery.room_id,
      sender: delivery.sender,
      preview: delivery.text_preview,
      messageId: `msg_${delivery.message_number}`,
    });
  const result = await deps.mailer.send(message);
  if (result.outcome === "delivered") return { kind: "delivered", status: result.status };
  const error = result.error ?? "smtp_operator";
  if (result.outcome === "dead") return { kind: "failed", status: result.status, error };
  return { kind: "retry", status: result.status, error, ...(result.operator ? { uncounted: true } : {}) };
}

/** One attempt of one claimed delivery, recorded. */
export async function deliverWakeWebhook(
  delivery: ClaimedWakeWebhook,
  workerId: string,
  deps: WakeWebhookDeliveryDeps,
): Promise<void> {
  const outcome = await attempt(delivery, deps, deps.now());
  if (await recordWakeWebhookOutcome(delivery, workerId, outcome, deps.now())) queueWakeRuleInvalidation(delivery.room_id);
}

async function deliverSafely(delivery: ClaimedWakeWebhook, workerId: string, deps: WakeWebhookDeliveryDeps): Promise<void> {
  try {
    await deliverWakeWebhook(delivery, workerId, deps);
  } catch (error) {
    // The claim expires after 5 minutes and the delivery is tried again.
    console.error(`[wake webhooks] could not record delivery ${delivery.id}`, error instanceof Error ? error.name : "error");
  }
}

/** Claim and send everything due now, every kind, and wait for it (tests and one-off passes). */
export async function processWakeWebhookBatch(workerId: string, deps: WakeWebhookDeliveryDeps = defaultWakeWebhookDeps()): Promise<number> {
  let total = 0;
  for (const kind of LANE_KINDS) {
    const deliveries = await claimWakeWebhookDeliveries(workerId, 50, kind);
    total += deliveries.length;
    await Promise.all(deliveries.map((delivery) => deliverSafely(delivery, workerId, deps)));
  }
  return total;
}

/** Delete old delivered and dead rows, a batch at a time, until a batch comes back short. */
export async function cleanupWakeWebhookDeliveries(maxBatches = 20): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await pool.query(`
      DELETE FROM wake_webhook_deliveries
       WHERE id IN (
         SELECT id FROM wake_webhook_deliveries
          WHERE state IN ('delivered', 'dead') AND updated_at < NOW() - INTERVAL '7 days'
          ORDER BY updated_at ASC
          LIMIT ${CLEANUP_BATCH}
       )
    `);
    removed += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < CLEANUP_BATCH) break;
  }
  await pool.query("DELETE FROM wake_email_confirmations WHERE created_at < NOW() - INTERVAL '2 days'");
  return removed;
}

/**
 * One lane per kind (webhook, email, MCP event), each a pool: whenever it has
 * free slots it claims that many and starts each at once, without waiting for
 * the rest.
 */
export function startWakeWebhookWorker(): () => Promise<void> {
  const workerId = randomUUID();
  const deps = defaultWakeWebhookDeps();
  const running = new Set<Promise<void>>();
  const inLane = Object.fromEntries(LANE_KINDS.map((kind) => [kind, 0])) as Record<WakeDeliveryKind, number>;
  const claiming = Object.fromEntries(LANE_KINDS.map((kind) => [kind, false])) as Record<WakeDeliveryKind, boolean>;
  let stopped = false;
  let lastCleanupAt = 0;

  const fill = async (kind: WakeDeliveryKind) => {
    const free = WAKE_DELIVERY_LANES[kind] - inLane[kind];
    if (stopped || claiming[kind] || free <= 0) return;
    claiming[kind] = true;
    try {
      for (const delivery of await claimWakeWebhookDeliveries(workerId, free, kind)) {
        inLane[kind] += 1;
        const task: Promise<void> = deliverSafely(delivery, workerId, deps).finally(() => {
          inLane[kind] -= 1;
          running.delete(task);
          void fill(kind).catch(() => undefined);
        });
        running.add(task);
      }
    } catch (error) {
      console.error(`[wake webhooks] claim failed: ${error instanceof Error ? error.name : "error"}`);
    } finally {
      claiming[kind] = false;
    }
  };
  const tick = () => {
    if (stopped) return;
    if (Date.now() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      lastCleanupAt = Date.now();
      void cleanupWakeWebhookDeliveries().catch(() => undefined);
    }
    for (const kind of LANE_KINDS) void fill(kind);
  };
  const interval = setInterval(tick, POLL_INTERVAL_MS);
  interval.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(interval);
    await Promise.allSettled([...running]);
  };
}
