/**
 * MCP Events subscriptions in the database: a `room.message` wake rule with
 * delivery kind `mcp_event`, found by the credential that made it and the
 * subscription id the client derives, renewed in place, cancelled by
 * `events/unsubscribe`, and replayed by cursor from its own delivery rows.
 * The handlers are in `../remote-mcp/events.ts`.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { WAKE_RULE_LIMITS, type WakeRuleArguments } from "../../../shared/wake-rules.mjs";
import type { EncryptedCredentials } from "../connectors/crypto.js";
import { db, pool } from "./client.js";
import { agent_wake_rules } from "./schema.js";
import type { WakeRuleRow } from "./wake-rules.js";

const HELD_STATUSES = ["active", "paused", "pending_confirmation"] as const;

/** Delivery rows older than this are deleted by the worker's cleanup, so a cursor before it cannot be replayed in full. */
export const MCP_EVENT_REPLAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Thrown when the account already holds its maximum of delivery rules (webhook, email and MCP Events together). */
export class McpEventSubscriptionCapError extends Error {
  constructor(readonly limit: number, readonly scope: "subscriptions") {
    super(`This account already has ${limit} webhook, email and MCP Events rules. Unsubscribe or cancel one you no longer need first.`);
    this.name = "McpEventSubscriptionCapError";
  }
}

/** The subscription's agent in the room: the credential's registered worker, or a stand-in for `any` without one. */
export interface McpEventRuleAgent {
  agent_key: string;
  agent_name: string;
  session_id: string | null;
  owner_account_id: string;
}

export async function findHeldMcpEventRule(credentialRef: string, subscriptionId: string): Promise<WakeRuleRow | null> {
  const [row] = await db.select().from(agent_wake_rules).where(and(
    eq(agent_wake_rules.credential_ref, credentialRef),
    eq(agent_wake_rules.mcp_subscription_id, subscriptionId),
    inArray(agent_wake_rules.status, [...HELD_STATUSES]),
  )).limit(1);
  return row ?? null;
}

/**
 * Create the subscription's rule, or renew the held one with the same id:
 * new sealed target (a rotation keeps the previous secret for a while), new
 * expiry, the worker as it is now, and `active` again if repeated failures
 * had paused it. The account's delivery rules are counted under its lock.
 */
export async function saveMcpEventSubscription(input: {
  roomId: string;
  agent: McpEventRuleAgent;
  credentialRef: string;
  subscriptionId: string;
  eventName: string;
  /** The canonical arguments as the client sent them (the subscription's identity). */
  subscriptionArguments: Record<string, unknown>;
  /** The matching arguments the rule evaluates, as a webhook rule's. */
  ruleArguments: WakeRuleArguments;
  /** The `refreshBefore` granted. */
  expiresAt: string;
  targetFingerprint: string;
  hostFingerprint: string;
  seal(ruleId: string): EncryptedCredentials;
  now?: Date;
}): Promise<{ rule: WakeRuleRow; created: boolean; previousStatus: WakeRuleRow["status"] | null }> {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  return db.transaction(async (tx) => {
    // One account's delivery rules are counted and renewed one request at a time (the same lock webhook rules take).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake-delivery-account:${input.agent.owner_account_id}`}, 0))`);
    const [existing] = await tx.select().from(agent_wake_rules).where(and(
      eq(agent_wake_rules.credential_ref, input.credentialRef),
      eq(agent_wake_rules.mcp_subscription_id, input.subscriptionId),
      inArray(agent_wake_rules.status, [...HELD_STATUSES]),
    )).limit(1);
    if (existing) {
      const [kept] = await tx.update(agent_wake_rules).set({
        agent_key: input.agent.agent_key,
        agent_name: input.agent.agent_name,
        created_by_session_id: input.agent.session_id,
        arguments: input.ruleArguments,
        mcp_arguments: input.subscriptionArguments,
        delivery_target: input.seal(existing.id),
        delivery_target_fingerprint: input.targetFingerprint,
        delivery_host_fingerprint: input.hostFingerprint,
        expires_at: input.expiresAt,
        next_check_at: input.expiresAt,
        status: "active",
        paused_at: null,
        delivery_consecutive_failures: existing.status === "paused" ? 0 : existing.delivery_consecutive_failures,
        updated_at: now,
      }).where(eq(agent_wake_rules.id, existing.id)).returning();
      return { rule: kept!, created: false, previousStatus: existing.status };
    }
    const [{ held }] = await tx.select({ held: sql<number>`count(*)::int` }).from(agent_wake_rules).where(and(
      eq(agent_wake_rules.owner_account_id, input.agent.owner_account_id),
      sql`${agent_wake_rules.delivery_kind} IS NOT NULL`,
      inArray(agent_wake_rules.status, [...HELD_STATUSES]),
    ));
    if (held >= WAKE_RULE_LIMITS.deliveryRulesPerAccount) throw new McpEventSubscriptionCapError(WAKE_RULE_LIMITS.deliveryRulesPerAccount, "subscriptions");
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(agent_wake_rules).where(and(
      eq(agent_wake_rules.room_id, input.roomId),
      eq(agent_wake_rules.agent_key, input.agent.agent_key),
      inArray(agent_wake_rules.status, [...HELD_STATUSES]),
    ));
    if (count >= WAKE_RULE_LIMITS.activePerAgent) throw new McpEventSubscriptionCapError(WAKE_RULE_LIMITS.activePerAgent, "subscriptions");
    const id = `wake_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const [row] = await tx.insert(agent_wake_rules).values({
      id,
      room_id: input.roomId,
      agent_key: input.agent.agent_key,
      agent_name: input.agent.agent_name,
      created_by_session_id: input.agent.session_id,
      event: "room.message",
      arguments: input.ruleArguments,
      // One held rule per subscription id; the id already names the credential.
      identity_key: `mcp_event:${input.subscriptionId}`,
      note: null,
      repeat: true,
      status: "active",
      baseline: null,
      cursor_at: now,
      next_check_at: input.expiresAt,
      expires_at: input.expiresAt,
      created_at: now,
      updated_at: now,
      owner_account_id: input.agent.owner_account_id,
      delivery_kind: "mcp_event",
      delivery_target: input.seal(id),
      delivery_target_fingerprint: input.targetFingerprint,
      delivery_host_fingerprint: input.hostFingerprint,
      credential_kind: "token",
      credential_ref: input.credentialRef,
      mcp_subscription_id: input.subscriptionId,
      mcp_event_name: input.eventName,
      mcp_arguments: input.subscriptionArguments,
      mcp_cursor: null,
    }).returning();
    return { rule: row!, created: true, previousStatus: null };
  });
}

/**
 * `events/unsubscribe`: end the held subscription with this id, as the
 * subscriber's own cancel, and drop what it still had to send. Null when
 * there was none (the call is idempotent).
 */
export async function cancelMcpEventSubscription(credentialRef: string, subscriptionId: string, now = new Date()): Promise<WakeRuleRow | null> {
  const nowIso = now.toISOString();
  return db.transaction(async (tx) => {
    const [row] = await tx.update(agent_wake_rules)
      .set({
        status: "cancelled",
        cancelled_by: sql`jsonb_build_object('kind', 'agent', 'id', ${agent_wake_rules.agent_key}, 'label', ${agent_wake_rules.agent_name})`,
        ended_at: nowIso,
        updated_at: nowIso,
      })
      .where(and(
        eq(agent_wake_rules.credential_ref, credentialRef),
        eq(agent_wake_rules.mcp_subscription_id, subscriptionId),
        inArray(agent_wake_rules.status, [...HELD_STATUSES]),
      ))
      .returning();
    if (!row) return null;
    await tx.execute(sql`
      UPDATE wake_webhook_deliveries
         SET state = 'dead', sender = '', text_preview = '', last_error = 'unsubscribed', updated_at = ${nowIso}
       WHERE rule_id = ${row.id} AND state IN ('queued', 'retry')
    `);
    return row;
  });
}

/**
 * Replay for a renewal with a cursor: every event of this subscription after
 * the cursor goes out again (the same event id), newest 50 at most. Rows that
 * are still waiting go as they are. Returns how many will go and whether
 * older ones had to be left out.
 */
export async function replayMcpEventDeliveries(
  ruleId: string,
  afterNumber: number,
  now = new Date(),
): Promise<{ replayed: number; truncated: boolean }> {
  const max = WAKE_RULE_LIMITS.mcpEventReplayMax;
  const rows = (await pool.query<{ id: string; state: string; message_number: number }>(`
    SELECT id, state, message_number FROM wake_webhook_deliveries
     WHERE rule_id = $1 AND purpose = 'message' AND message_number > $2
     ORDER BY message_number DESC
     LIMIT $3
  `, [ruleId, afterNumber, max + 1])).rows;
  const truncated = rows.length > max;
  const kept = rows.slice(0, max).reverse();
  const nowMs = now.getTime();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [index, row] of kept.entries()) {
      if (row.state !== "delivered" && row.state !== "dead") continue;
      // In order: each a millisecond after the one before.
      const at = new Date(nowMs + index).toISOString();
      await client.query(`
        UPDATE wake_webhook_deliveries
           SET state = 'retry', attempt_count = 0, scheduled_at = $2, next_attempt_at = $2, claimed_at = NULL, claimed_by = NULL,
               last_status = NULL, last_error = NULL, delivered_at = NULL, held_by_cap = false, updated_at = $3
         WHERE id = $1 AND state IN ('delivered', 'dead')
      `, [row.id, at, new Date(nowMs).toISOString()]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { replayed: kept.length, truncated };
}

/** The newest message number in the room: the cursor a new subscription starts after. */
export async function roomLatestMessageNumber(roomId: string): Promise<number> {
  const result = await pool.query<{ latest: number }>(
    "SELECT COALESCE(max(number), 0)::int AS latest FROM messages WHERE room_id = $1",
    [roomId],
  );
  return result.rows[0]?.latest ?? 0;
}

/** When a message was posted (ISO), or null when the room has no such message. */
export async function roomMessagePostedAt(roomId: string, number: number): Promise<string | null> {
  const result = await pool.query<{ posted_at: string }>(
    "SELECT timestamp AS posted_at FROM messages WHERE room_id = $1 AND number = $2",
    [roomId, number],
  );
  const at = result.rows[0]?.posted_at;
  return at ? new Date(at).toISOString() : null;
}

export interface McpEventWorkerSession {
  session_id: string;
  room_id: string;
  agent_key: string;
  display_name: string;
  owner_account_id: string;
  ended_at: string | null;
}

/** A worker session by id, for checking that a remembered worker handle still names this account's worker in the room. */
export async function getMcpEventWorkerSession(sessionId: string): Promise<McpEventWorkerSession | null> {
  const result = await pool.query<McpEventWorkerSession>(`
    SELECT session_id, room_id, agent_key, display_name, owner_account_id, ended_at
      FROM room_agent_sessions WHERE session_id = $1
  `, [sessionId]);
  return result.rows[0] ?? null;
}

/** The message an event carries, read when the event is sent (its row holds no text). */
export async function getMcpEventMessage(roomId: string, number: number): Promise<{
  number: number; sender: string; text: string; thread_root_number: number | null; timestamp: string;
} | null> {
  const result = await pool.query<{ number: number; sender: string; text: string; thread_root_number: number | null; timestamp: string }>(
    "SELECT number, sender, text, thread_root_number, timestamp FROM messages WHERE room_id = $1 AND number = $2",
    [roomId, number],
  );
  return result.rows[0] ?? null;
}
