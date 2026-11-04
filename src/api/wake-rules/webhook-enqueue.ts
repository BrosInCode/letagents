/**
 * Queue wake deliveries (webhook or email) for a new room message, inside the message's
 * own transaction, so a delivery exists exactly when its message does. The
 * notifications worker sends them.
 */
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { ActivationIdentity } from "../../shared/activation-routing.js";
import type { WakeRuleArguments, WakeRuleDeliveryKind } from "../../../shared/wake-rules.mjs";
import type { MessageCreateTransaction } from "../db/messages/create/types.js";
import type { MessageRow } from "../db/types.js";
import { WAKE_RULE_LIMITS } from "../../../shared/wake-rules.mjs";
import {
  WAKE_WEBHOOK_SENDER_MAX,
  oneLine,
  planWakeWebhookEnqueue,
  wakeWebhookTextPreview,
  type WakeDeliveryCap,
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

type RuleRow = {
  id: string;
  agent_key: string;
  agent_name: string;
  arguments: WakeRuleArguments;
  delivery_kind: WakeRuleDeliveryKind;
  owner_account_id: string | null;
  delivery_host_fingerprint: string | null;
};

export type WakeWebhookEnqueueResult = "queued" | "coalesced" | "held";

const HOUR_MS = 60 * 60 * 1000;

/**
 * The three hourly budgets of a new delivery, read in one statement: the
 * rule's own, the account's in this room (across its rules there, so one
 * member's busy rules never hold back anyone else's), and the account's for
 * this target host. Each gives how many deliveries fall in the window (held ones
 * included) and when the window has room again.
 */
async function readCaps(
  tx: MessageCreateTransaction,
  rule: Pick<RuleRow, "id" | "owner_account_id" | "delivery_host_fingerprint">,
  roomId: string,
  now: Date,
): Promise<WakeDeliveryCap[]> {
  const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString();
  const limits = [WAKE_RULE_LIMITS.webhookHourlyCap, WAKE_RULE_LIMITS.roomHourlyCap, WAKE_RULE_LIMITS.hostHourlyCapPerAccount];
  const [row] = (await tx.execute<Record<string, string | number | null>>(sql`
    WITH by_rule AS (
      SELECT scheduled_at FROM wake_webhook_deliveries
       WHERE rule_id = ${rule.id} AND purpose = 'message' AND scheduled_at > ${hourAgo}
    ), by_room AS (
      SELECT scheduled_at FROM wake_webhook_deliveries
       WHERE room_id = ${roomId} AND owner_account_id = ${rule.owner_account_id ?? ""}
         AND purpose = 'message' AND scheduled_at > ${hourAgo}
    ), by_host AS (
      SELECT scheduled_at FROM wake_webhook_deliveries
       WHERE owner_account_id = ${rule.owner_account_id ?? ""} AND host_fingerprint = ${rule.delivery_host_fingerprint ?? ""}
         AND purpose = 'message' AND scheduled_at > ${hourAgo}
    )
    SELECT
      (SELECT count(*)::int FROM by_rule) AS rule_n,
      (SELECT scheduled_at FROM by_rule ORDER BY scheduled_at ASC
        OFFSET GREATEST((SELECT count(*) FROM by_rule) - ${limits[0]!}, 0) LIMIT 1) AS rule_at,
      (SELECT count(*)::int FROM by_room) AS room_n,
      (SELECT scheduled_at FROM by_room ORDER BY scheduled_at ASC
        OFFSET GREATEST((SELECT count(*) FROM by_room) - ${limits[1]!}, 0) LIMIT 1) AS room_at,
      (SELECT count(*)::int FROM by_host) AS host_n,
      (SELECT scheduled_at FROM by_host ORDER BY scheduled_at ASC
        OFFSET GREATEST((SELECT count(*) FROM by_host) - ${limits[2]!}, 0) LIMIT 1) AS host_at
  `)).rows;
  return (["rule", "room", "host"] as const).map((scope, index) => {
    const at = row?.[`${scope}_at`];
    return {
      count: Number(row?.[`${scope}_n`] ?? 0),
      limit: limits[index]!,
      freesAtMs: at ? Date.parse(String(at)) + HOUR_MS : null,
    };
  });
}

/**
 * Queue one MCP event for one subscription. Never folded: each match is one
 * event, inserted as `retry` (waiting, no attempt yet) because `queued` is
 * the one coalescing slot of a webhook or email rule. The row carries no
 * message text; the worker reads the message when it sends. When an hourly
 * budget is spent the event waits for the budget to have room, in order, and
 * at most 50 wait: past that the oldest are dropped (each event carries its
 * own cursor, so the receiver sees the gap and can replay by cursor).
 */
async function enqueueMcpEventMatchTx(
  tx: MessageCreateTransaction,
  rule: Pick<RuleRow, "id" | "owner_account_id" | "delivery_host_fingerprint">,
  message: Pick<MessageRow, "room_id" | "number">,
  now: Date,
): Promise<WakeWebhookEnqueueResult> {
  const nowIso = now.toISOString();
  const plan = planWakeWebhookEnqueue({
    nowMs: now.getTime(),
    pendingDeliveryId: null,
    lastScheduledAtMs: null,
    caps: await readCaps(tx, rule, message.room_id, now),
  });
  if (plan.kind !== "insert") return "coalesced";
  const scheduledAt = new Date(plan.scheduledAtMs).toISOString();
  await tx.execute(sql`
    INSERT INTO wake_webhook_deliveries (
      id, rule_id, room_id, kind, purpose, message_number, sender, text_preview, match_count, state, attempt_count,
      scheduled_at, next_attempt_at, created_at, updated_at, owner_account_id, host_fingerprint, held_by_cap
    ) VALUES (
      ${`whd_${randomUUID().replace(/-/g, "")}`}, ${rule.id}, ${message.room_id}, 'mcp_event', 'message', ${message.number},
      '', '', 1, 'retry', 0, ${scheduledAt}, ${scheduledAt}, ${nowIso}, ${nowIso},
      ${rule.owner_account_id}, ${rule.delivery_host_fingerprint}, ${plan.heldByCap}
    )
  `);
  if (!plan.heldByCap) return "queued";
  await tx.execute(sql`UPDATE agent_wake_rules SET delivery_over_cap_count = delivery_over_cap_count + 1 WHERE id = ${rule.id}`);
  await tx.execute(sql`
    UPDATE wake_webhook_deliveries
       SET state = 'dead', last_error = 'held_overflow', updated_at = ${nowIso}
     WHERE id IN (
       SELECT id FROM wake_webhook_deliveries
        WHERE rule_id = ${rule.id} AND purpose = 'message' AND state = 'retry' AND attempt_count = 0 AND held_by_cap
        ORDER BY message_number DESC
       OFFSET ${WAKE_RULE_LIMITS.mcpEventHeldMax}
     )
  `);
  return "held";
}

/**
 * Queue one match for one rule: fold it into the message delivery that is
 * waiting, or start one at the end of the rule's coalescing window or, when
 * an hourly budget is spent, when the budget has room again. One match at a
 * time per rule. An MCP event is never folded (see above).
 */
export async function enqueueWakeWebhookMatchTx(
  tx: MessageCreateTransaction,
  rule: Pick<RuleRow, "id" | "delivery_kind" | "owner_account_id" | "delivery_host_fingerprint">,
  message: Pick<MessageRow, "room_id" | "number" | "sender" | "text">,
  now = new Date(),
): Promise<WakeWebhookEnqueueResult> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake-webhook:${rule.id}`}, 0))`);
  if (rule.delivery_kind === "mcp_event") return enqueueMcpEventMatchTx(tx, rule, message, now);
  const nowIso = now.toISOString();
  const sender = oneLine(message.sender, WAKE_WEBHOOK_SENDER_MAX);
  const preview = wakeWebhookTextPreview(message.text);
  const [state] = (await tx.execute<{ pending_id: string | null; last_scheduled_at: string | null }>(sql`
    SELECT
      (SELECT id FROM wake_webhook_deliveries WHERE rule_id = ${rule.id} AND state = 'queued' AND purpose = 'message' LIMIT 1) AS pending_id,
      (SELECT max(scheduled_at) FROM wake_webhook_deliveries WHERE rule_id = ${rule.id} AND purpose = 'message') AS last_scheduled_at
  `)).rows;
  const countOverCap = () => tx.execute(sql`
    UPDATE agent_wake_rules SET delivery_over_cap_count = delivery_over_cap_count + 1 WHERE id = ${rule.id}
  `);
  if (state?.pending_id) {
    // The newest message wins; the count of folded matches grows.
    const folded = await tx.execute<{ held_by_cap: boolean }>(sql`
      UPDATE wake_webhook_deliveries
         SET sender = CASE WHEN ${message.number} >= message_number THEN ${sender} ELSE sender END,
             text_preview = CASE WHEN ${message.number} >= message_number THEN ${preview} ELSE text_preview END,
             message_number = GREATEST(message_number, ${message.number}),
             match_count = match_count + 1,
             updated_at = ${nowIso}
       WHERE id = ${state.pending_id} AND state = 'queued' AND purpose = 'message'
      RETURNING held_by_cap
    `);
    if (folded.rows.length > 0) {
      if (folded.rows[0]!.held_by_cap) await countOverCap();
      return "coalesced";
    }
    // The worker picked it up meanwhile: this match starts the next window.
  }
  const plan = planWakeWebhookEnqueue({
    nowMs: now.getTime(),
    pendingDeliveryId: null,
    lastScheduledAtMs: state?.last_scheduled_at ? Date.parse(state.last_scheduled_at) : null,
    caps: await readCaps(tx, rule, message.room_id, now),
  });
  if (plan.kind !== "insert") return "coalesced";
  const scheduledAt = new Date(plan.scheduledAtMs).toISOString();
  await tx.execute(sql`
    INSERT INTO wake_webhook_deliveries (
      id, rule_id, room_id, kind, purpose, message_number, sender, text_preview, match_count, state, attempt_count,
      scheduled_at, next_attempt_at, created_at, updated_at, owner_account_id, host_fingerprint, held_by_cap
    ) VALUES (
      ${`whd_${randomUUID().replace(/-/g, "")}`}, ${rule.id}, ${message.room_id}, ${rule.delivery_kind}, 'message', ${message.number},
      ${sender}, ${preview}, 1, 'queued', 0, ${scheduledAt}, ${scheduledAt}, ${nowIso}, ${nowIso},
      ${rule.owner_account_id}, ${rule.delivery_host_fingerprint}, ${plan.heldByCap}
    )
    ON CONFLICT (rule_id, purpose) WHERE state = 'queued' DO UPDATE
       SET sender = CASE WHEN EXCLUDED.message_number >= wake_webhook_deliveries.message_number THEN EXCLUDED.sender ELSE wake_webhook_deliveries.sender END,
           text_preview = CASE WHEN EXCLUDED.message_number >= wake_webhook_deliveries.message_number THEN EXCLUDED.text_preview ELSE wake_webhook_deliveries.text_preview END,
           message_number = GREATEST(wake_webhook_deliveries.message_number, EXCLUDED.message_number),
           match_count = wake_webhook_deliveries.match_count + 1,
           updated_at = EXCLUDED.updated_at
  `);
  if (plan.heldByCap) {
    await countOverCap();
    return "held";
  }
  return "queued";
}

/**
 * Match a new message against the room's active room.message rules (webhook,
 * email and MCP Events subscriptions alike) and queue a delivery for each match. Runs inside the message transaction after
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
    SELECT id, agent_key, agent_name, arguments, delivery_kind, owner_account_id, delivery_host_fingerprint
      FROM agent_wake_rules
     WHERE room_id = ${message.room_id} AND event = 'room.message' AND status = 'active'
       AND (expires_at IS NULL OR expires_at > now())
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
    // An MCP Events subscription is a person's ChatGPT: posts by that person's
    // own workers (agent posts, by publisher_agent_key) never come back to it
    // (with `any` and `include_agents` and no registered worker, the rule's
    // stand-in agent key would not catch them). The person's own posts from
    // the app still do: mentioning their worker is how they wake it.
    const wanted = matches.filter((rule) => !(rule.delivery_kind === "mcp_event" && message.publisher_agent_key
      && message.publisher_account_id && rule.owner_account_id === message.publisher_account_id));
    for (const rule of wanted) await enqueueWakeWebhookMatchTx(savepoint, rule, message);
    return wanted.length;
  }).catch((error: unknown) => {
    console.warn(`[wake webhooks] could not queue deliveries for message ${message.number} in ${message.room_id}`,
      error instanceof Error ? error.message : error);
    return 0;
  });
}
