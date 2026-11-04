/**
 * A person's test of a webhook wake rule: one delivery through the real
 * pipeline (the rule's sealed URL and secret, the signature, the receiver's
 * sender key, the pinned-address client that follows no redirect), sent and
 * recorded in the request that asked for it, with the result returned at
 * once. The test counts against the rule's hourly budget and is bounded to
 * five per rule in ten minutes; its failure never counts toward pausing the
 * rule, and its success clears the run of failures and resumes a paused rule.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { WakeRuleError, type WakeRuleTestResult } from "../../../shared/wake-rules.mjs";
import { db } from "../db/client.js";
import { getWakeRule, retireWakeRulesForCredential } from "../db/wake-rules.js";
import {
  defaultWakeWebhookDeps,
  openWakeWebhookTarget,
  postOpenedWakeWebhook,
  type WakeWebhookDeliveryDeps,
} from "../notifications/wake-webhooks.js";
import { queueWakeRuleInvalidation } from "../server/events.js";
import { wakeRoomUrl } from "./public-url.js";

export const WAKE_WEBHOOK_TESTS_PER_WINDOW = 5;
export const WAKE_WEBHOOK_TEST_WINDOW_MS = 10 * 60 * 1000;
export const WAKE_WEBHOOK_TEST_PREVIEW = "Test delivery from LetAgents";

export async function testWakeWebhookRule(input: {
  roomId: string;
  ruleId: string;
  /** The person testing: the rule's owner, named as the sender of the test body. */
  account: { id: string; login: string };
  deps?: WakeWebhookDeliveryDeps;
  now?: Date;
}): Promise<WakeRuleTestResult> {
  const deps = input.deps ?? defaultWakeWebhookDeps();
  const now = input.now ?? deps.now();
  const nowIso = now.toISOString();
  const rule = await getWakeRule(input.roomId, input.ruleId);
  if (!rule) throw new WakeRuleError("Wake rule not found in this room.", 404);
  if (!rule.owner_account_id || rule.owner_account_id !== input.account.id) {
    throw new WakeRuleError("Only the account that owns this agent can test its webhook rule.", 403);
  }
  if (rule.delivery_kind !== "webhook") throw new WakeRuleError("Only webhook rules can be tested.", 409);
  if (rule.status !== "active" && rule.status !== "paused") throw new WakeRuleError("This wake rule has ended.", 409);
  if (!rule.delivery_target) throw new WakeRuleError("This wake rule has ended.", 409);
  // The same checks a message delivery makes: the sign-in that registered the rule, then the account's room access.
  let live: boolean;
  try {
    live = await deps.credentialLive(rule.credential_kind, rule.credential_ref);
  } catch {
    throw new WakeRuleError("The sign-in behind this rule could not be checked now. Try again in a minute.", 503);
  }
  if (!live) {
    if (rule.credential_kind === "token" || rule.credential_kind === "agent_session") {
      await retireWakeRulesForCredential(db, rule.credential_kind, rule.credential_ref!);
    }
    queueWakeRuleInvalidation(input.roomId);
    return { status: 0, error_class: "credential_revoked", delivery_id: null, resumed: false };
  }
  let access;
  try {
    access = await deps.authorize(rule.owner_account_id, input.roomId);
  } catch {
    access = "retry" as const;
  }
  if (access === "retry") throw new WakeRuleError("Your room access could not be checked now. Try again in a minute.", 503);
  if (access === "deny") return { status: 0, error_class: "access_denied", delivery_id: null, resumed: false };
  if (!deps.cipher) throw new WakeRuleError("Webhook delivery is not set up on this server.", 503);
  const target = openWakeWebhookTarget(deps.cipher, {
    rule_id: rule.id, owner_account_id: rule.owner_account_id, delivery_target: rule.delivery_target, delivery_bearer: rule.delivery_bearer,
  });
  if (!target) return { status: 0, error_class: "target_unreadable", delivery_id: null, resumed: false };

  // Counted and recorded under the rule's lock (the one createWakeRule takes),
  // so parallel tests cannot all pass the count. The row is written first,
  // as `dead` with its own reason, so the budget (by scheduled_at) and the
  // rate limit see it even if the send is cut short, and no worker, old or
  // new, ever claims it as a message.
  const deliveryId = `whd_${randomUUID().replace(/-/g, "")}`;
  const windowStart = new Date(now.getTime() - WAKE_WEBHOOK_TEST_WINDOW_MS).toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake-rules:${input.roomId}:${rule.agent_key}`}, 0))`);
    const [recent] = (await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM wake_webhook_deliveries
       WHERE rule_id = ${rule.id} AND purpose = 'test' AND created_at > ${windowStart}
    `)).rows;
    if (Number(recent?.n ?? 0) >= WAKE_WEBHOOK_TESTS_PER_WINDOW) {
      throw new WakeRuleError(`You sent ${WAKE_WEBHOOK_TESTS_PER_WINDOW} tests in the last 10 minutes. Wait a few minutes, then try again.`, 429);
    }
    await tx.execute(sql`
      INSERT INTO wake_webhook_deliveries (
        id, rule_id, room_id, kind, purpose, message_number, sender, text_preview, match_count, state, attempt_count,
        last_error, scheduled_at, next_attempt_at, created_at, updated_at, owner_account_id, host_fingerprint
      ) VALUES (
        ${deliveryId}, ${rule.id}, ${input.roomId}, 'webhook', 'test', NULL, '', '', 1, 'dead', 1,
        'test_incomplete', ${nowIso}, ${nowIso}, ${nowIso}, ${nowIso}, ${rule.owner_account_id}, ${rule.delivery_host_fingerprint}
      )
    `);
  });
  const outcome = await postOpenedWakeWebhook({
    rule_id: rule.id,
    owner_account_id: rule.owner_account_id,
    delivery_bearer: rule.delivery_bearer,
    target,
    payload: {
      delivery_id: deliveryId,
      room_id: input.roomId,
      message_id: "test",
      sender: input.account.login,
      text_preview: WAKE_WEBHOOK_TEST_PREVIEW,
      room_url: wakeRoomUrl(input.roomId),
      rule_id: rule.id,
      sent_at: nowIso,
    },
  }, deps, now);
  const doneIso = deps.now().toISOString();
  const status = outcome.kind === "skipped" ? 0 : outcome.status;
  const errorClass = outcome.kind === "delivered" ? null : outcome.error;
  let resumed = false;
  if (outcome.kind === "delivered") {
    await db.execute(sql`
      UPDATE wake_webhook_deliveries
         SET state = 'delivered', delivered_at = ${doneIso}, last_status = ${status}, last_error = NULL, updated_at = ${doneIso}
       WHERE id = ${deliveryId}
    `);
    // A receiver that accepts a test works again: the run of failures ends,
    // as after a delivered message, and a rule those failures had paused resumes.
    const [updated] = (await db.execute<{ status: string }>(sql`
      UPDATE agent_wake_rules
         SET delivery_consecutive_failures = 0, delivery_last_status = ${status}, delivery_last_error = NULL, delivery_last_attempt_at = ${doneIso},
             status = CASE WHEN status = 'paused' THEN 'active' ELSE status END,
             paused_at = CASE WHEN status = 'paused' THEN NULL ELSE paused_at END,
             updated_at = CASE WHEN status = 'paused' THEN ${doneIso}::timestamptz ELSE updated_at END
       WHERE id = ${rule.id} AND status IN ('active', 'paused')
       RETURNING status
    `)).rows;
    resumed = rule.status === "paused" && updated?.status === "active";
  } else {
    // A test is never retried, and its failure never counts toward a pause.
    await db.execute(sql`
      UPDATE wake_webhook_deliveries
         SET last_status = ${status || null}, last_error = ${errorClass}, updated_at = ${doneIso}
       WHERE id = ${deliveryId}
    `);
    await db.execute(sql`
      UPDATE agent_wake_rules
         SET delivery_last_status = ${status || null}, delivery_last_error = ${errorClass}, delivery_last_attempt_at = ${doneIso}
       WHERE id = ${rule.id}
    `);
  }
  queueWakeRuleInvalidation(input.roomId);
  return { status, error_class: errorClass, delivery_id: deliveryId, resumed };
}
