/**
 * Queue wake webhook deliveries for a new room message, inside the message's
 * own transaction, so a delivery exists exactly when its message does. The
 * notifications worker sends them.
 */
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { ActivationIdentity } from "../../shared/activation-routing.js";
import type { WakeRuleArguments } from "../../../shared/wake-rules.mjs";
import type { MessageCreateTransaction } from "../db/messages/create/types.js";
import type { MessageRow } from "../db/types.js";
import {
  WAKE_WEBHOOK_HOUR_MS,
  WAKE_WEBHOOK_SENDER_MAX,
  oneLine,
  planWakeWebhookEnqueue,
  wakeWebhookTextPreview,
} from "./webhook-delivery.js";
import { matchWakeWebhookRules, type WakeWebhookMessageFacts } from "./webhook-match.js";

/** What send-time routing decided about the message. */
export interface WakeWebhookRoutingFacts {
  promptOnly: boolean;
  addressedAgentKey: string | null;
  recipientAgentKeys: readonly string[];
  activeSessions: ReadonlyArray<{
    session_id: string;
    actor_label: string;
    agent_key: string;
    agent_instance_id: string | null;
    display_name: string;
    session_kind: string;
  }>;
  routingMessage: WakeWebhookMessageFacts["routingMessage"];
}

type RuleRow = { id: string; agent_key: string; agent_name: string; arguments: WakeRuleArguments };

export type WakeWebhookEnqueueResult = "queued" | "coalesced" | "dropped";

/**
 * Queue one match for one rule: fold it into the delivery that is waiting, or
 * start a delivery at the end of the rule's coalescing window, or drop it
 * past the hourly cap. One match at a time per rule.
 */
export async function enqueueWakeWebhookMatchTx(
  tx: MessageCreateTransaction,
  ruleId: string,
  message: Pick<MessageRow, "room_id" | "number" | "sender" | "text">,
  now = new Date(),
): Promise<WakeWebhookEnqueueResult> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake-webhook:${ruleId}`}, 0))`);
  const nowIso = now.toISOString();
  const hourAgo = new Date(now.getTime() - WAKE_WEBHOOK_HOUR_MS).toISOString();
  const sender = oneLine(message.sender, WAKE_WEBHOOK_SENDER_MAX);
  const preview = wakeWebhookTextPreview(message.text);
  const [state] = (await tx.execute<{ pending_id: string | null; last_scheduled_at: string | null; recent: number }>(sql`
    SELECT
      (SELECT id FROM wake_webhook_deliveries WHERE rule_id = ${ruleId} AND state = 'queued' LIMIT 1) AS pending_id,
      (SELECT max(scheduled_at) FROM wake_webhook_deliveries WHERE rule_id = ${ruleId}) AS last_scheduled_at,
      (SELECT count(*)::int FROM wake_webhook_deliveries WHERE rule_id = ${ruleId} AND created_at > ${hourAgo}) AS recent
  `)).rows;
  const base = {
    nowMs: now.getTime(),
    lastScheduledAtMs: state?.last_scheduled_at ? Date.parse(state.last_scheduled_at) : null,
    startedInLastHour: Number(state?.recent ?? 0),
  };
  let plan = planWakeWebhookEnqueue({ ...base, pendingDeliveryId: state?.pending_id ?? null });
  if (plan.kind === "coalesce") {
    const folded = await tx.execute(sql`
      UPDATE wake_webhook_deliveries
         SET sender = CASE WHEN ${message.number} >= message_number THEN ${sender} ELSE sender END,
             text_preview = CASE WHEN ${message.number} >= message_number THEN ${preview} ELSE text_preview END,
             message_number = GREATEST(message_number, ${message.number}),
             match_count = match_count + 1,
             updated_at = ${nowIso}
       WHERE id = ${plan.deliveryId} AND state = 'queued'
      RETURNING id
    `);
    if (folded.rows.length > 0) return "coalesced";
    // The worker picked it up meanwhile: this match starts the next window.
    plan = planWakeWebhookEnqueue({ ...base, pendingDeliveryId: null });
  }
  if (plan.kind === "drop") {
    await tx.execute(sql`
      UPDATE agent_wake_rules SET delivery_dropped_count = delivery_dropped_count + 1 WHERE id = ${ruleId}
    `);
    return "dropped";
  }
  if (plan.kind !== "insert") return "dropped";
  const scheduledAt = new Date(plan.scheduledAtMs).toISOString();
  await tx.execute(sql`
    INSERT INTO wake_webhook_deliveries (
      id, rule_id, room_id, message_number, sender, text_preview, match_count, state, attempt_count,
      scheduled_at, next_attempt_at, created_at, updated_at
    ) VALUES (
      ${`whd_${randomUUID().replace(/-/g, "")}`}, ${ruleId}, ${message.room_id}, ${message.number}, ${sender}, ${preview},
      1, 'queued', 0, ${scheduledAt}, ${scheduledAt}, ${nowIso}, ${nowIso}
    )
    ON CONFLICT (rule_id) WHERE state = 'queued' DO UPDATE
       SET message_number = GREATEST(wake_webhook_deliveries.message_number, EXCLUDED.message_number),
           match_count = wake_webhook_deliveries.match_count + 1,
           updated_at = EXCLUDED.updated_at
  `);
  return "queued";
}

/**
 * Match a new message against the room's active room.message rules and queue
 * a delivery for each match. Runs inside the message transaction after
 * routing. A room without webhook rules costs one indexed read; the writes
 * run in a savepoint, so a failure here never blocks the message.
 */
export async function enqueueWakeWebhooksForMessageTx(
  tx: MessageCreateTransaction,
  message: MessageRow,
  routing: WakeWebhookRoutingFacts,
): Promise<number> {
  if (routing.promptOnly) return 0;
  const rules = (await tx.execute<RuleRow>(sql`
    SELECT id, agent_key, agent_name, arguments
      FROM agent_wake_rules
     WHERE room_id = ${message.room_id} AND event = 'room.message' AND status = 'active'
  `)).rows;
  if (rules.length === 0) return 0;
  return tx.transaction(async (savepoint) => {
    // The transaction hook may have restricted who sees the message.
    const [stored] = (await savepoint.execute<{ restricted: boolean }>(sql`
      SELECT (visibility IS NOT NULL OR rental_session_id IS NOT NULL) AS restricted
        FROM messages WHERE room_id = ${message.room_id} AND number = ${message.number}
    `)).rows;
    const matches = matchWakeWebhookRules(rules, {
      sender: message.sender,
      source: message.source ?? null,
      publisher_agent_key: message.publisher_agent_key ?? null,
      thread_root_number: message.thread_root_number ?? null,
      text: message.text,
      promptOnly: false,
      restricted: Boolean(stored?.restricted),
      addressedAgentKey: routing.addressedAgentKey,
      recipientAgentKeys: new Set(routing.recipientAgentKeys),
      activeIdentities: routing.activeSessions.map((session): ActivationIdentity => ({
        actor_label: session.actor_label,
        agent_key: session.agent_key,
        agent_instance_id: session.agent_instance_id,
        agent_session_id: session.session_id,
        display_name: session.display_name,
        session_kind: session.session_kind,
      })),
      routingMessage: routing.routingMessage,
    });
    for (const rule of matches) await enqueueWakeWebhookMatchTx(savepoint, rule.id, message);
    return matches.length;
  }).catch((error: unknown) => {
    console.warn(`[wake webhooks] could not queue deliveries for message ${message.number} in ${message.room_id}`,
      error instanceof Error ? error.message : error);
    return 0;
  });
}
