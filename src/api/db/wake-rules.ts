import { and, asc, desc, eq, gt, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  WAKE_RULE_LIMITS,
  WakeRuleError,
  wakeRuleIdentityKey,
  type ParsedWakeRuleInput,
  type WakeRule,
  type WakeRuleActor,
  type WakeRuleEvent,
  type WakeRulePage,
  type WakeRuleDeliveryKind,
  type WakeRuleDeliverySummary,
} from "../../../shared/wake-rules.mjs";
import type { EncryptedCredentials } from "../connectors/crypto.js";
import { db } from "./client.js";
import { repositoryRoomIds } from "./github/repository-rooms.js";
import { agent_wake_rules } from "./schema.js";
import type { MessageCreateTransaction } from "./messages/create.js";
import { wakeRuleExpiry, type WakeRuleEvaluationDeps } from "../wake-rules/evaluate.js";

export type WakeRuleRow = typeof agent_wake_rules.$inferSelect;
type Executor = typeof db | MessageCreateTransaction;

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 50;
/** A person can undo a cancel for this long. */
export const WAKE_RULE_RESTORE_WINDOW_MS = 10 * 60 * 1000;

/** Rules an agent still holds: they count against its limit and are listed as current. */
const HELD_STATUSES = ["active", "paused", "pending_confirmation"] as const;

export interface WakeRuleViewer {
  /** The account asking. Delivery details of a webhook rule are shown only to the account that owns the agent. */
  accountId?: string | null;
}

function deliverySummary(row: WakeRuleRow, viewer: WakeRuleViewer): WakeRuleDeliverySummary | null {
  if (!row.delivery_kind || !row.delivery_target) return null;
  const base = { kind: row.delivery_kind, paused: row.status === "paused" };
  if (!viewer.accountId || !row.owner_account_id || viewer.accountId !== row.owner_account_id) return base;
  return {
    ...base,
    delivered_count: row.delivery_delivered_count,
    consecutive_failures: row.delivery_consecutive_failures,
    over_cap_count: row.delivery_over_cap_count,
    last_status: row.delivery_last_status ?? null,
    last_error: row.delivery_last_error ?? null,
    last_attempt_at: row.delivery_last_attempt_at ? new Date(row.delivery_last_attempt_at).toISOString() : null,
  };
}

export function toWakeRule(row: WakeRuleRow, viewer: WakeRuleViewer = {}): WakeRule {
  return {
    id: row.id,
    room_id: row.room_id,
    agent_key: row.agent_key,
    agent_name: row.agent_name,
    event: row.event,
    arguments: row.arguments,
    repeat: row.repeat,
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    note: row.note,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    fire_count: row.fire_count,
    last_fired_at: row.last_fired_at ? new Date(row.last_fired_at).toISOString() : null,
    wake_message_id: row.wake_message_number ? `msg_${row.wake_message_number}` : null,
    cancelled_by: row.cancelled_by ?? null,
    ended_reason: row.ended_reason ?? null,
    delivery: deliverySummary(row, viewer),
  };
}

/**
 * The first moment the scheduler must look at a new or re-armed rule. A
 * room.message rule is driven by messages; the scheduler looks only at its
 * expiry, and never when it has none.
 */
export function initialNextCheckAt(input: Pick<ParsedWakeRuleInput, "event" | "arguments" | "expires_at">): string | null {
  return input.event === "timer" ? input.arguments.at! : input.expires_at;
}

/** A delivery target (webhook or email) sealed for the rule it belongs to. */
export interface WakeRuleDeliverySeal {
  kind: WakeRuleDeliveryKind;
  /** Keyed fingerprint of the target (the URL without its query, or the address); part of the rule's identity. */
  targetFingerprint: string;
  /** Keyed fingerprint of the target's host (the URL's host, or the address's domain). */
  hostFingerprint: string;
  seal(ruleId: string): EncryptedCredentials;
  /** Webhook: the receiver's sender key, sealed for this rule, or null when it needs none. */
  sealBearer?(ruleId: string): EncryptedCredentials | null;
  /**
   * Email: the SHA-256 of the rule's stop link token, and of a confirmation
   * link token that works until `confirmExpiresAt`.
   */
  linkHashes?(ruleId: string, confirmExpiresAt: string): { confirm: string; disable: string };
}

/** The credential that registered a delivery rule; deliveries stop when it is revoked. */
export interface WakeRuleCredential {
  kind: "token" | "agent_session";
  ref: string;
}

/** Set when an email rule waits for its address: when the link stops working, and whether one was just queued. */
export interface WakeEmailConfirmation {
  expires_at: string;
  sent: boolean;
}

/** Whether this address pressed Stop and has not asked again. */
async function addressSuppressedTx(tx: MessageCreateTransaction, fingerprint: string): Promise<boolean> {
  const result = await tx.execute<{ found: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM wake_email_suppressions WHERE address_fingerprint = ${fingerprint}) AS found
  `);
  return Boolean(result.rows[0]?.found);
}

/**
 * Queue a confirmation email, in the rule's own transaction, when the address
 * and the account still have confirmations left today. Every confirmation is
 * logged by address fingerprint, so cancelling and adding a rule again does
 * not reset the count. Throws WakeRuleError when a budget is spent.
 */
async function queueEmailConfirmationTx(
  tx: MessageCreateTransaction,
  rule: { id: string; room_id: string; owner_account_id: string | null },
  addressFingerprint: string,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const [counts] = (await tx.execute<{ address: number; account: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM wake_email_confirmations WHERE address_fingerprint = ${addressFingerprint} AND created_at > ${dayAgo}) AS address,
      (SELECT count(*)::int FROM wake_email_confirmations WHERE owner_account_id = ${rule.owner_account_id ?? ""} AND created_at > ${dayAgo}) AS account
  `)).rows;
  if (Number(counts?.address ?? 0) >= WAKE_RULE_LIMITS.emailConfirmationsPerAddressPerDay) {
    throw new WakeRuleError(`This address already got ${WAKE_RULE_LIMITS.emailConfirmationsPerAddressPerDay} confirmation requests today. Ask its owner to open one of them, or try again tomorrow.`, 429);
  }
  if (Number(counts?.account ?? 0) >= WAKE_RULE_LIMITS.emailConfirmationsPerAccountPerDay) {
    throw new WakeRuleError(`This account already sent ${WAKE_RULE_LIMITS.emailConfirmationsPerAccountPerDay} confirmation requests today. Try again tomorrow.`, 429);
  }
  await tx.execute(sql`
    INSERT INTO wake_email_confirmations (id, address_fingerprint, owner_account_id, rule_id, created_at)
    VALUES (${`wec_${randomUUID().replace(/-/g, "")}`}, ${addressFingerprint}, ${rule.owner_account_id ?? ""}, ${rule.id}, ${nowIso})
  `);
  await tx.execute(sql`
    INSERT INTO wake_webhook_deliveries (
      id, rule_id, room_id, kind, purpose, message_number, sender, text_preview, match_count, state, attempt_count,
      scheduled_at, next_attempt_at, created_at, updated_at, owner_account_id
    ) VALUES (
      ${`whd_${randomUUID().replace(/-/g, "")}`}, ${rule.id}, ${rule.room_id}, 'email', 'confirm', NULL, '', '', 1, 'queued', 0,
      ${nowIso}, ${nowIso}, ${nowIso}, ${nowIso}, ${rule.owner_account_id}
    )
    ON CONFLICT (rule_id, purpose) WHERE state = 'queued' DO NOTHING
  `);
}

/** When the scheduler must look at a delivery rule: its expiry, or a sooner end of its confirmation link. */
function deliveryRuleNextCheck(expiresAt: string | null, confirmExpiresAt: string | null): string | null {
  if (!confirmExpiresAt) return expiresAt;
  if (!expiresAt) return confirmExpiresAt;
  return Date.parse(confirmExpiresAt) < Date.parse(expiresAt) ? confirmExpiresAt : expiresAt;
}

export async function createWakeRule(input: {
  roomId: string;
  agent: { agent_key: string; agent_name: string; session_id: string | null; owner_account_id?: string | null };
  rule: ParsedWakeRuleInput;
  baseline: WakeRuleRow["baseline"];
  /** room.message rules: where they deliver, and the credential that asked. */
  delivery?: WakeRuleDeliverySeal | null;
  credential?: WakeRuleCredential | null;
  now?: Date;
}): Promise<{ rule: WakeRule; created: boolean; confirmation?: WakeEmailConfirmation }> {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const delivery = input.delivery ?? null;
  if (delivery && (!input.credential || !input.agent.owner_account_id)) {
    throw new WakeRuleError("A webhook or email rule needs an agent that signed in with an account.", 403);
  }
  const ownerAccountId = input.agent.owner_account_id ?? null;
  const identityKey = `${wakeRuleIdentityKey(input.rule.event, input.rule.arguments)}${delivery ? `:${delivery.kind}:${delivery.targetFingerprint}` : ""}`;
  const viewer = { accountId: ownerAccountId };
  const confirmExpiresAt = new Date(nowDate.getTime() + WAKE_RULE_LIMITS.emailConfirmTtlMs).toISOString();
  return db.transaction(async (tx) => {
    // One agent's rules are counted and deduplicated one request at a time.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake-rules:${input.roomId}:${input.agent.agent_key}`}, 0))`);
    // And one account's delivery rules, across rooms (always after the agent lock).
    if (delivery) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake-delivery-account:${ownerAccountId}`}, 0))`);
    const [existing] = await tx.select().from(agent_wake_rules).where(and(
      eq(agent_wake_rules.room_id, input.roomId),
      eq(agent_wake_rules.agent_key, input.agent.agent_key),
      eq(agent_wake_rules.identity_key, identityKey),
      inArray(agent_wake_rules.status, [...HELD_STATUSES]),
    )).limit(1);
    if (delivery && !existing) {
      const [{ held }] = await tx.select({ held: sql<number>`count(*)::int` }).from(agent_wake_rules).where(and(
        eq(agent_wake_rules.owner_account_id, ownerAccountId!),
        sql`${agent_wake_rules.delivery_kind} IS NOT NULL`,
        inArray(agent_wake_rules.status, [...HELD_STATUSES]),
      ));
      if (held >= WAKE_RULE_LIMITS.deliveryRulesPerAccount) {
        throw new WakeRuleError(`This account already has ${WAKE_RULE_LIMITS.deliveryRulesPerAccount} webhook and email rules. Cancel one you no longer need first.`, 409);
      }
    }
    /**
     * An email address gives consent: a new email rule, or one that was
     * stopped or paused, waits for the address to confirm. Confirmations are
     * bounded per address and per account per day, and an address that
     * pressed Stop gets none until it asks again.
     */
    const awaitConfirmation = async (ruleId: string) => {
      if (await addressSuppressedTx(tx, delivery!.targetFingerprint)) {
        console.info(`[wake email] refused a confirmation to a stopped address (rule ${ruleId}).`);
        throw new WakeRuleError("This address asked LetAgents to stop emailing it. Its owner can allow requests again from the stop link of an earlier email.", 403);
      }
      const [{ pending }] = await tx.select({ pending: sql<number>`count(*)::int` }).from(agent_wake_rules).where(and(
        eq(agent_wake_rules.owner_account_id, ownerAccountId!),
        eq(agent_wake_rules.status, "pending_confirmation"),
        sql`${agent_wake_rules.id} <> ${ruleId}`,
      ));
      if (pending >= WAKE_RULE_LIMITS.emailPendingPerAccount) {
        throw new WakeRuleError(`This account already has ${WAKE_RULE_LIMITS.emailPendingPerAccount} email rules waiting for confirmation. Confirm or cancel one first.`, 429);
      }
      const hashes = delivery!.linkHashes!(ruleId, confirmExpiresAt);
      return {
        status: "pending_confirmation" as const,
        confirm_token_hash: hashes.confirm,
        confirm_expires_at: confirmExpiresAt,
        disable_token_hash: hashes.disable,
        confirmed_at: null,
        // The scheduler ends the rule if the link expires unused.
        next_check_at: deliveryRuleNextCheck(input.rule.expires_at, confirmExpiresAt),
      };
    };
    // Adding a delivery rule again renews it: its expiry, its credential, its target.
    const renewal = () => ({
      delivery_target: delivery!.seal(existing!.id),
      // Like the secret, the sender key given now replaces the stored one (or removes it).
      delivery_bearer: delivery!.sealBearer?.(existing!.id) ?? null,
      delivery_target_fingerprint: delivery!.targetFingerprint,
      delivery_host_fingerprint: delivery!.hostFingerprint,
      credential_kind: input.credential!.kind,
      credential_ref: input.credential!.ref,
      expires_at: input.rule.expires_at,
      note: input.rule.note ?? existing!.note,
      updated_at: now,
    });
    if (existing && delivery?.kind === "email") {
      if (existing.status === "active") {
        const [kept] = await tx.update(agent_wake_rules).set({
          ...renewal(), next_check_at: input.rule.expires_at,
        }).where(eq(agent_wake_rules.id, existing.id)).returning();
        return { rule: toWakeRule(kept!, viewer), created: false };
      }
      const lastIssuedMs = existing.status === "pending_confirmation" && existing.confirm_expires_at
        ? Date.parse(existing.confirm_expires_at) - WAKE_RULE_LIMITS.emailConfirmTtlMs
        : -Infinity;
      if (nowDate.getTime() - lastIssuedMs < WAKE_RULE_LIMITS.emailConfirmResendMs) {
        const [kept] = await tx.update(agent_wake_rules).set({
          ...renewal(), next_check_at: deliveryRuleNextCheck(input.rule.expires_at, existing.confirm_expires_at),
        }).where(eq(agent_wake_rules.id, existing.id)).returning();
        return {
          rule: toWakeRule(kept!, viewer),
          created: false,
          confirmation: { expires_at: new Date(existing.confirm_expires_at!).toISOString(), sent: false },
        };
      }
      const [kept] = await tx.update(agent_wake_rules).set({
        ...renewal(),
        ...await awaitConfirmation(existing.id),
        paused_at: null,
        delivery_consecutive_failures: 0,
      }).where(eq(agent_wake_rules.id, existing.id)).returning();
      await queueEmailConfirmationTx(tx, kept!, delivery.targetFingerprint, nowDate);
      return { rule: toWakeRule(kept!, viewer), created: false, confirmation: { expires_at: confirmExpiresAt, sent: true } };
    }
    if (existing && delivery) {
      // The same webhook rule again: keep it, take the URL and secret given
      // now (a rotation), and resume it if repeated failures had paused it.
      const [kept] = await tx.update(agent_wake_rules).set({
        ...renewal(),
        next_check_at: input.rule.expires_at,
        status: "active",
        paused_at: null,
        delivery_consecutive_failures: existing.status === "paused" ? 0 : existing.delivery_consecutive_failures,
      }).where(eq(agent_wake_rules.id, existing.id)).returning();
      return { rule: toWakeRule(kept!, viewer), created: false };
    }
    if (existing) return { rule: toWakeRule(existing, viewer), created: false };
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(agent_wake_rules).where(and(
      eq(agent_wake_rules.room_id, input.roomId),
      eq(agent_wake_rules.agent_key, input.agent.agent_key),
      inArray(agent_wake_rules.status, [...HELD_STATUSES]),
    ));
    if (count >= WAKE_RULE_LIMITS.activePerAgent) {
      throw new WakeRuleError(`You already have ${WAKE_RULE_LIMITS.activePerAgent} active wake rules in this room. Cancel one you no longer need first.`, 409);
    }
    const id = `wake_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const [row] = await tx.insert(agent_wake_rules).values({
      id,
      room_id: input.roomId,
      agent_key: input.agent.agent_key,
      agent_name: input.agent.agent_name,
      created_by_session_id: input.agent.session_id,
      event: input.rule.event,
      arguments: input.rule.arguments,
      identity_key: identityKey,
      note: input.rule.note,
      repeat: input.rule.repeat,
      status: "active",
      baseline: input.baseline,
      cursor_at: now,
      next_check_at: initialNextCheckAt(input.rule),
      expires_at: input.rule.expires_at,
      created_at: now,
      updated_at: now,
      owner_account_id: ownerAccountId,
      delivery_kind: delivery?.kind ?? null,
      delivery_target: delivery ? delivery.seal(id) : null,
      delivery_bearer: delivery?.sealBearer?.(id) ?? null,
      delivery_target_fingerprint: delivery?.targetFingerprint ?? null,
      delivery_host_fingerprint: delivery?.hostFingerprint ?? null,
      credential_kind: delivery ? input.credential!.kind : null,
      credential_ref: delivery ? input.credential!.ref : null,
      ...(delivery?.kind === "email" ? await awaitConfirmation(id) : {}),
    }).returning();
    if (delivery?.kind === "email") {
      await queueEmailConfirmationTx(tx, row!, delivery.targetFingerprint, nowDate);
      return { rule: toWakeRule(row!, viewer), created: true, confirmation: { expires_at: confirmExpiresAt, sent: true } };
    }
    return { rule: toWakeRule(row!, viewer), created: true };
  });
}

export async function getWakeRule(roomId: string, id: string): Promise<WakeRuleRow | null> {
  const [row] = await db.select().from(agent_wake_rules)
    .where(and(eq(agent_wake_rules.room_id, roomId), eq(agent_wake_rules.id, id))).limit(1);
  return row ?? null;
}

/** Current rules (a paused webhook rule included) and the ones that ended in the past week. */
export async function listWakeRules(
  roomId: string,
  options: { agentKey?: string; now?: Date; viewer?: WakeRuleViewer } = {},
): Promise<WakeRulePage> {
  const since = new Date((options.now ?? new Date()).getTime() - RECENT_WINDOW_MS).toISOString();
  const agent = options.agentKey ? eq(agent_wake_rules.agent_key, options.agentKey) : undefined;
  const viewer = options.viewer ?? {};
  const [active, recent] = await Promise.all([
    db.select().from(agent_wake_rules)
      .where(and(eq(agent_wake_rules.room_id, roomId), inArray(agent_wake_rules.status, [...HELD_STATUSES]), agent))
      .orderBy(asc(agent_wake_rules.next_check_at), asc(agent_wake_rules.id)),
    db.select().from(agent_wake_rules)
      .where(and(eq(agent_wake_rules.room_id, roomId), notInArray(agent_wake_rules.status, [...HELD_STATUSES]), gt(agent_wake_rules.ended_at, since), agent))
      .orderBy(desc(agent_wake_rules.ended_at), desc(agent_wake_rules.id))
      .limit(RECENT_LIMIT),
  ]);
  return {
    room_id: roomId,
    active: active.map((row) => toWakeRule(row, viewer)),
    recent: recent.map((row) => toWakeRule(row, viewer)),
  };
}

export async function cancelWakeRule(
  roomId: string,
  id: string,
  actor: WakeRuleActor,
  viewer: WakeRuleViewer = {},
): Promise<WakeRule | null> {
  const now = new Date().toISOString();
  const [row] = await db.update(agent_wake_rules)
    .set({ status: "cancelled", cancelled_by: actor, ended_at: now, updated_at: now })
    .where(and(eq(agent_wake_rules.room_id, roomId), eq(agent_wake_rules.id, id), inArray(agent_wake_rules.status, [...HELD_STATUSES])))
    .returning();
  return row ? toWakeRule(row, viewer) : null;
}

/**
 * Undo a recent cancel, by whoever cancelled it. The rule keeps its original
 * cursor, so anything that happened while it was cancelled still wakes the
 * agent. It counts against the agent's limit like a new rule.
 */
export async function restoreWakeRule(
  roomId: string,
  id: string,
  actor: WakeRuleActor,
  now = new Date(),
  viewer: WakeRuleViewer = {},
): Promise<WakeRule> {
  const nowIso = now.toISOString();
  const restoreAfter = new Date(now.getTime() - WAKE_RULE_RESTORE_WINDOW_MS).toISOString();
  const [target] = await db.select({ agent_key: agent_wake_rules.agent_key }).from(agent_wake_rules)
    .where(and(eq(agent_wake_rules.room_id, roomId), eq(agent_wake_rules.id, id))).limit(1);
  if (!target) throw new WakeRuleError("Wake rule not found in this room.", 404);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake-rules:${roomId}:${target.agent_key}`}, 0))`);
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(agent_wake_rules).where(and(
      eq(agent_wake_rules.room_id, roomId),
      eq(agent_wake_rules.agent_key, target.agent_key),
      inArray(agent_wake_rules.status, [...HELD_STATUSES]),
    ));
    if (count >= WAKE_RULE_LIMITS.activePerAgent) {
      throw new WakeRuleError(`The agent already has ${WAKE_RULE_LIMITS.activePerAgent} active wake rules in this room.`, 409);
    }
    try {
      const [row] = await tx.update(agent_wake_rules)
        .set({
          status: "active", cancelled_by: null, ended_at: null, updated_at: nowIso,
          // An undone rule starts over: earlier failures do not count toward a pause.
          delivery_consecutive_failures: 0,
          // A room.message rule is driven by messages; the scheduler looks only at its expiry.
          next_check_at: sql`CASE WHEN ${agent_wake_rules.event} = 'room.message' THEN ${agent_wake_rules.expires_at} ELSE ${nowIso}::timestamptz END`,
        })
        .where(and(
          eq(agent_wake_rules.room_id, roomId),
          eq(agent_wake_rules.id, id),
          eq(agent_wake_rules.status, "cancelled"),
          sql`${agent_wake_rules.cancelled_by}->>'kind' = ${actor.kind}`,
          sql`${agent_wake_rules.cancelled_by}->>'id' = ${actor.id}`,
          gt(agent_wake_rules.ended_at, restoreAfter),
          or(isNull(agent_wake_rules.expires_at), gt(agent_wake_rules.expires_at, nowIso)),
          // An email address that never confirmed (or stopped the emails) is not revived by undo.
          sql`NOT (${agent_wake_rules.delivery_kind} IS NOT DISTINCT FROM 'email' AND ${agent_wake_rules.confirmed_at} IS NULL)`,
        ))
        .returning();
      if (!row) throw new WakeRuleError("This wake rule can no longer be restored.", 409);
      return toWakeRule(row, viewer);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new WakeRuleError("The agent already has an active wake rule for this.", 409);
      }
      throw error;
    }
  });
}

/**
 * Rules the scheduler must look at now. A paused delivery rule is still due
 * at its expiry, and an email rule waiting for confirmation when its link
 * stops working.
 */
export async function getDueWakeRules(now: Date, limit = 200): Promise<WakeRuleRow[]> {
  return db.select().from(agent_wake_rules)
    .where(and(
      // Written to match the partial index on held rules.
      inArray(agent_wake_rules.status, [...HELD_STATUSES]),
      lte(agent_wake_rules.next_check_at, now.toISOString()),
      or(eq(agent_wake_rules.status, "active"), eq(agent_wake_rules.event, "room.message")),
    ))
    .orderBy(asc(agent_wake_rules.next_check_at))
    .limit(limit);
}

/** Active rules waiting on one task's status. */
export async function getActiveTaskWakeRules(taskRoomId: string, taskId: string): Promise<WakeRuleRow[]> {
  return db.select().from(agent_wake_rules).where(and(
    eq(agent_wake_rules.status, "active"),
    eq(agent_wake_rules.event, "task.status_changed"),
    sql`${agent_wake_rules.arguments}->>'task_id' = ${taskId}`,
    sql`COALESCE(${agent_wake_rules.baseline}->>'room_id', ${agent_wake_rules.room_id}) = ${taskRoomId}`,
  ));
}

/** Active GitHub rules whose repository includes the room an event landed in. */
export async function getActiveGitHubWakeRulesConcerning(eventRoomId: string): Promise<WakeRuleRow[]> {
  return db.select().from(agent_wake_rules).where(and(
    eq(agent_wake_rules.status, "active"),
    sql`${agent_wake_rules.event} LIKE 'github.%'`,
    sql`${agent_wake_rules.room_id} IN ${repositoryRoomIds(eventRoomId)}`,
  ));
}

export async function getNextWakeRuleCheckAt(): Promise<string | null> {
  const [row] = await db.select({ at: sql<string | null>`min(${agent_wake_rules.next_check_at})` })
    .from(agent_wake_rules).where(inArray(agent_wake_rules.status, [...HELD_STATUSES]));
  return row?.at ?? null;
}

/**
 * Re-arm a rule that is not ready yet, optionally moving it past events it
 * has decided about. Fenced so a concurrent wake wins.
 */
export async function scheduleWakeRuleCheck(
  rule: WakeRuleRow,
  at: string,
  options: { cursorAt?: string; capAtExpiry?: boolean } = {},
): Promise<void> {
  // An ordinary check never waits past expiry, when the rule must end. A
  // failure backoff is not capped: an expiry notice that keeps failing must
  // not be retried on every pass.
  const expiresAt = rule.expires_at;
  const nextAt = options.capAtExpiry === false || !expiresAt || Date.parse(at) < Date.parse(expiresAt) ? at : expiresAt;
  const cursorAt = options.cursorAt;
  await db.update(agent_wake_rules)
    .set({ next_check_at: nextAt, ...(cursorAt ? { cursor_at: cursorAt } : {}) })
    .where(and(eq(agent_wake_rules.id, rule.id), eq(agent_wake_rules.status, "active"), eq(agent_wake_rules.fire_count, rule.fire_count)));
}

/**
 * Record a wake inside the transaction that creates its message. Returns
 * false when another instance already woke the agent for this rule; the
 * caller then rolls the message back.
 */
export async function recordWakeRuleFiredTx(tx: Executor, rule: WakeRuleRow, input: {
  /** `ended`: the agent was told that what the rule waited for can no longer happen. */
  outcome: "fired" | "expired" | "ended";
  messageNumber: number;
  cursorAt: string;
  baseline: WakeRuleRow["baseline"];
  now: string;
  /** Set when this wake is the rule's last because what it watched is over. */
  endedReason?: string | null;
}): Promise<boolean> {
  const expiresAt = wakeRuleExpiry(rule);
  const keepsWatching = input.outcome === "fired" && rule.repeat && !input.endedReason
    && Date.parse(expiresAt) > Date.parse(input.now);
  const nextCheckAt = keepsWatching
    ? new Date(Math.min(Date.parse(input.now) + WAKE_RULE_LIMITS.repeatDebounceMs, Date.parse(expiresAt))).toISOString()
    : rule.next_check_at;
  const updated = await tx.update(agent_wake_rules)
    .set({
      status: keepsWatching ? "active" : input.outcome === "fired" ? "fired" : input.outcome === "expired" ? "expired" : "retired",
      fire_count: rule.fire_count + 1,
      last_fired_at: input.now,
      wake_message_number: input.messageNumber,
      cursor_at: input.cursorAt,
      baseline: input.baseline,
      next_check_at: nextCheckAt,
      ended_at: keepsWatching ? null : input.now,
      ended_reason: keepsWatching ? null : input.endedReason ?? null,
      updated_at: input.now,
    })
    .where(and(eq(agent_wake_rules.id, rule.id), eq(agent_wake_rules.status, "active"), eq(agent_wake_rules.fire_count, rule.fire_count)))
    .returning({ id: agent_wake_rules.id });
  return updated.length === 1;
}

/**
 * End a rule whose pull request closed, without waking the agent: the rule
 * already woke it for that close. Fenced like a wake, so a concurrent wake
 * wins and the next look decides again.
 */
export async function retireWakeRule(rule: WakeRuleRow, reason: string, now = new Date()): Promise<boolean> {
  const nowIso = now.toISOString();
  const updated = await db.update(agent_wake_rules)
    .set({ status: "retired", ended_reason: reason, ended_at: nowIso, updated_at: nowIso })
    .where(and(eq(agent_wake_rules.id, rule.id), eq(agent_wake_rules.status, "active"), eq(agent_wake_rules.fire_count, rule.fire_count)))
    .returning({ id: agent_wake_rules.id });
  return updated.length === 1;
}

/**
 * End a webhook rule at its expiry. It posts no wake notice: its agent is a
 * hosted bot that is reached by webhook, not by the room.
 */
export async function expireWakeWebhookRule(rule: WakeRuleRow, now = new Date()): Promise<boolean> {
  const nowIso = now.toISOString();
  const updated = await db.update(agent_wake_rules)
    .set({ status: "expired", ended_at: nowIso, updated_at: nowIso })
    .where(and(
      eq(agent_wake_rules.id, rule.id),
      inArray(agent_wake_rules.status, [...HELD_STATUSES]),
      lte(agent_wake_rules.expires_at, nowIso),
    ))
    .returning({ id: agent_wake_rules.id });
  return updated.length === 1;
}

/**
 * Move a delivery rule's next look to when it must end (its expiry, or a
 * sooner confirmation deadline), whatever its status, so the scheduler never
 * finds it due again before then. Fenced on the status it was read with.
 */
export async function rearmWakeDeliveryRule(rule: WakeRuleRow, at?: string): Promise<void> {
  const next = at ?? deliveryRuleNextCheck(rule.expires_at, rule.status === "pending_confirmation" ? rule.confirm_expires_at : null);
  await db.update(agent_wake_rules)
    .set({ next_check_at: next })
    .where(and(eq(agent_wake_rules.id, rule.id), eq(agent_wake_rules.status, rule.status)));
}

/** End an email rule whose confirmation link expired unused. */
export async function endUnconfirmedWakeEmailRule(rule: WakeRuleRow, now = new Date()): Promise<boolean> {
  const nowIso = now.toISOString();
  const updated = await db.update(agent_wake_rules)
    .set({
      status: "expired", ended_at: nowIso, updated_at: nowIso,
      ended_reason: "the email address was not confirmed within 24 hours",
    })
    .where(and(
      eq(agent_wake_rules.id, rule.id),
      eq(agent_wake_rules.status, "pending_confirmation"),
      lte(agent_wake_rules.confirm_expires_at, nowIso),
    ))
    .returning({ id: agent_wake_rules.id });
  return updated.length === 1;
}

export type WakeLinkOutcome =
  | { outcome: "done"; rule: WakeRuleRow }
  | { outcome: "already"; rule: WakeRuleRow }
  | { outcome: "expired" | "ended" | "unknown" | "conflict" | "limited" };

/** Confirm an email rule's address by the hash of its confirmation link. */
export async function confirmWakeEmailRule(tokenHash: string, now = new Date()): Promise<WakeLinkOutcome> {
  const nowIso = now.toISOString();
  let row: WakeRuleRow | undefined;
  try {
    [row] = await db.update(agent_wake_rules)
    .set({
      // The hash stays, so the same link opened again answers "already confirmed".
      status: "active", confirmed_at: nowIso, confirm_expires_at: null, updated_at: nowIso,
      delivery_consecutive_failures: 0,
      // From now on messages drive it; the scheduler looks only at its expiry.
      next_check_at: sql`${agent_wake_rules.expires_at}`,
    })
    .where(and(
      eq(agent_wake_rules.confirm_token_hash, tokenHash),
      eq(agent_wake_rules.status, "pending_confirmation"),
      gt(agent_wake_rules.confirm_expires_at, nowIso),
      // A rule past its own expiry is not revived by a late confirmation.
      or(isNull(agent_wake_rules.expires_at), gt(agent_wake_rules.expires_at, nowIso)),
    ))
    .returning();
  } catch (error) {
    // The agent already holds the same rule another way: say so, not 500.
    if ((error as { code?: string }).code === "23505") return { outcome: "conflict" };
    throw error;
  }
  if (row) return { outcome: "done", rule: row };
  const [known] = await db.select().from(agent_wake_rules).where(eq(agent_wake_rules.confirm_token_hash, tokenHash)).limit(1);
  if (!known) return { outcome: "unknown" };
  if (known.confirmed_at && known.status === "active") return { outcome: "already", rule: known };
  return known.status === "pending_confirmation" || known.status === "expired" ? { outcome: "expired" } : { outcome: "ended" };
}

/**
 * The recipient stops an email rule from its stop link: the rule pauses,
 * nothing waiting goes out, and the address must confirm again before the
 * agent can resume it.
 */
export async function stopWakeEmailRule(tokenHash: string, now = new Date()): Promise<WakeLinkOutcome> {
  const nowIso = now.toISOString();
  return db.transaction(async (tx) => {
    const [row] = await tx.update(agent_wake_rules)
      .set({
        status: "paused", paused_at: nowIso, updated_at: nowIso, confirmed_at: null,
        confirm_token_hash: null, confirm_expires_at: null,
        delivery_last_error: "stopped_by_recipient",
        // Due again only when it must end; a paused rule is never due before that.
        next_check_at: sql`${agent_wake_rules.expires_at}`,
      })
      .where(and(
        eq(agent_wake_rules.disable_token_hash, tokenHash),
        inArray(agent_wake_rules.status, ["active", "pending_confirmation"]),
      ))
      .returning();
    if (row) {
      await tx.execute(sql`
        UPDATE wake_webhook_deliveries
           SET state = 'dead', sender = '', text_preview = '', last_error = 'stopped_by_recipient', updated_at = ${nowIso}
         WHERE rule_id = ${row.id} AND state IN ('queued', 'retry')
      `);
      // The address gets no more confirmation requests until it asks for one.
      if (row.delivery_target_fingerprint) {
        await tx.execute(sql`
          INSERT INTO wake_email_suppressions (address_fingerprint, rule_id, created_at)
          VALUES (${row.delivery_target_fingerprint}, ${row.id}, ${nowIso})
          ON CONFLICT (address_fingerprint) DO NOTHING
        `);
        console.info(`[wake email] an address stopped emails for rule ${row.id}; it gets no confirmation requests until it asks again.`);
      }
      return { outcome: "done", rule: row };
    }
    const [known] = await tx.select().from(agent_wake_rules).where(eq(agent_wake_rules.disable_token_hash, tokenHash)).limit(1);
    if (!known) return { outcome: "unknown" };
    return known.status === "paused" ? { outcome: "already", rule: known } : { outcome: "ended" };
  });
}

/**
 * The person behind a stopped address asks, from the stop page, to allow
 * requests again: the stop is lifted and one new confirmation is sent, within
 * the address's and the account's daily budgets. Confirming it resumes the rule.
 */
export async function requestWakeEmailConfirmationAgain(
  tokenHash: string,
  confirmHashFor: (ruleId: string, confirmExpiresAt: string) => string,
  now = new Date(),
): Promise<WakeLinkOutcome> {
  const nowIso = now.toISOString();
  const confirmExpiresAt = new Date(now.getTime() + WAKE_RULE_LIMITS.emailConfirmTtlMs).toISOString();
  try {
    return await db.transaction(async (tx) => {
      const [rule] = await tx.select().from(agent_wake_rules).where(eq(agent_wake_rules.disable_token_hash, tokenHash)).limit(1);
      if (!rule) return { outcome: "unknown" } as const;
      if (rule.status !== "paused" || !rule.delivery_target_fingerprint) return { outcome: "ended" } as const;
      if (rule.expires_at && Date.parse(rule.expires_at) <= now.getTime()) return { outcome: "ended" } as const;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake-delivery-account:${rule.owner_account_id}`}, 0))`);
      await tx.execute(sql`DELETE FROM wake_email_suppressions WHERE address_fingerprint = ${rule.delivery_target_fingerprint}`);
      const [pending] = await tx.update(agent_wake_rules).set({
        status: "pending_confirmation", paused_at: null, updated_at: nowIso, delivery_consecutive_failures: 0,
        confirm_token_hash: confirmHashFor(rule.id, confirmExpiresAt), confirm_expires_at: confirmExpiresAt,
        delivery_last_error: null, next_check_at: deliveryRuleNextCheck(rule.expires_at, confirmExpiresAt),
      }).where(and(eq(agent_wake_rules.id, rule.id), eq(agent_wake_rules.status, "paused"))).returning();
      if (!pending) return { outcome: "ended" } as const;
      await queueEmailConfirmationTx(tx, pending, rule.delivery_target_fingerprint, now);
      console.info(`[wake email] an address asked for a new confirmation for rule ${rule.id}.`);
      return { outcome: "done", rule: pending } as const;
    });
  } catch (error) {
    if (error instanceof WakeRuleError && error.status === 429) return { outcome: "limited" };
    throw error;
  }
}

/** Whether the credential that registered a delivery rule still works. */
export async function isWakeRuleCredentialLive(kind: string | null, ref: string | null): Promise<boolean> {
  if (!kind || !ref) return false;
  const result = await db.execute<{ live: boolean }>(kind === "agent_session"
    ? sql`SELECT EXISTS (SELECT 1 FROM room_agent_sessions WHERE session_id = ${ref} AND ended_at IS NULL) AS live`
    : sql`SELECT (EXISTS (SELECT 1 FROM owner_tokens WHERE token_hash = ${ref})
        OR EXISTS (SELECT 1 FROM mcp_oauth_grants WHERE secret_hash = ${ref} AND revoked_at IS NULL AND expires_at > now())) AS live`);
  return result.rows[0]?.live === true;
}

export { RETIRE_WAKE_RULES_FOR_CREDENTIAL_SQL, retireWakeRulesForCredential } from "./wake-rule-credentials.js";

/** Whether GitHub activity can reach this room at all. */
export async function roomHasRepository(roomId: string): Promise<boolean> {
  const result = await db.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM room_git_bindings AS binding
       WHERE binding.room_id = ${roomId}
          OR binding.room_id = (SELECT parent_room_id FROM rooms WHERE id = ${roomId})
    ) AS found
  `);
  return Boolean(result.rows[0]?.found);
}

/** The durable state a wake rule is checked against. */
export const wakeRuleEvaluationDeps: WakeRuleEvaluationDeps = {
  async readTaskStatus(roomId, taskNumber) {
    const result = await db.execute<{ status: string }>(sql`
      SELECT status::text AS status FROM tasks WHERE room_id = ${roomId} AND number = ${taskNumber} LIMIT 1
    `);
    return result.rows[0]?.status ?? null;
  },
  async ownedWork(agentKey, ruleRoomId) {
    const result = await db.execute<{ branch_ref: string | null; pr_url: string | null }>(sql`
      SELECT branch_ref, pr_url FROM task_leases
       WHERE agent_key = ${agentKey}
         AND kind = 'work' AND status = 'active'
         AND (expires_at IS NULL OR expires_at > now())
         AND room_id IN ${repositoryRoomIds(ruleRoomId)}
    `);
    const branches = new Set<string>();
    const pullRequests = new Set<number>();
    for (const row of result.rows) {
      if (row.branch_ref) branches.add(row.branch_ref.replace(/^refs\/heads\//, ""));
      const number = row.pr_url ? /\/pull\/(\d+)/.exec(row.pr_url)?.[1] : undefined;
      if (number) pullRequests.add(Number(number));
    }
    return { branches: [...branches], pullRequests: [...pullRequests] };
  },
  async pullRequestBranches(ruleRoomId, pr) {
    const result = await db.execute<{ head_ref: string }>(sql`
      SELECT DISTINCT head_ref FROM github_room_events
       WHERE event_type = 'pull_request' AND github_object_id = ${String(pr)} AND head_ref IS NOT NULL
         AND room_id IN ${repositoryRoomIds(ruleRoomId)}
    `);
    return result.rows.map((row) => row.head_ref);
  },
  async pullRequestClosed(ruleRoomId, pr) {
    // The newest close or reopen decides, in GitHub's own order.
    const result = await db.execute<{ action: string; state: string | null; event_order_at: string }>(sql`
      SELECT action, state, event_order_at FROM github_room_events
       WHERE event_type = 'pull_request' AND github_object_id = ${String(pr)}
         AND action IN ('closed', 'reopened')
         AND room_id IN ${repositoryRoomIds(ruleRoomId)}
       ORDER BY event_order_at DESC, created_at DESC, id DESC
       LIMIT 1
    `);
    const latest = result.rows[0];
    return latest?.action === "closed"
      ? { merged: latest.state === "merged", closed_at: new Date(latest.event_order_at).toISOString() }
      : null;
  },
  async githubEventsAfter(input) {
    // CI can record hundreds of checks between looks: keep the newest. Reviews
    // and closes are few, and the oldest one wakes first.
    const newestFirst = input.eventType === "check_run";
    const result = await db.execute<{
      action: string; title: string | null; state: string | null; github_object_url: string | null;
      actor_login: string | null; github_object_id: string | null; head_ref: string | null; head_sha: string | null; created_at: string;
    }>(sql`
      SELECT action, title, state, github_object_url, actor_login, github_object_id, head_ref, head_sha, created_at
        FROM github_room_events
       WHERE event_type = ${input.eventType}
         AND action = ${input.action}
         AND created_at > ${input.after}
         AND created_at <= ${input.until}
         AND room_id IN ${repositoryRoomIds(input.ruleRoomId)}
         ${input.headRefs ? sql`AND head_ref IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(input.headRefs)}::jsonb))` : sql``}
         ${input.pullRequests ? sql`AND github_object_id IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(input.pullRequests.map(String))}::jsonb))` : sql``}
       ORDER BY created_at ${newestFirst ? sql`DESC` : sql`ASC`}, id ${newestFirst ? sql`DESC` : sql`ASC`}
       LIMIT 1000
    `);
    const rows = newestFirst ? result.rows.reverse() : result.rows;
    return rows.map((row) => ({
      action: row.action,
      title: row.title,
      state: row.state,
      url: row.github_object_url,
      actor: row.actor_login,
      pr: row.github_object_id && /^\d+$/.test(row.github_object_id) ? Number(row.github_object_id) : null,
      head_ref: row.head_ref,
      head_sha: row.head_sha,
      recorded_at: new Date(row.created_at).toISOString(),
    }));
  },
};
