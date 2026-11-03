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
const HELD_STATUSES = ["active", "paused"] as const;

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
    dropped_count: row.delivery_dropped_count,
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

/** A webhook target sealed for the rule it belongs to. */
export interface WakeRuleWebhookSeal {
  /** Extra identity: two rules differ when their URLs differ. */
  identitySuffix: string;
  seal(ruleId: string): EncryptedCredentials;
}

export async function createWakeRule(input: {
  roomId: string;
  agent: { agent_key: string; agent_name: string; session_id: string | null; owner_account_id?: string | null };
  rule: ParsedWakeRuleInput;
  baseline: WakeRuleRow["baseline"];
  /** room.message rules: where they deliver. */
  webhook?: WakeRuleWebhookSeal | null;
  now?: Date;
}): Promise<{ rule: WakeRule; created: boolean }> {
  const now = (input.now ?? new Date()).toISOString();
  const identityKey = `${wakeRuleIdentityKey(input.rule.event, input.rule.arguments)}${input.webhook ? `:${input.webhook.identitySuffix}` : ""}`;
  const viewer = { accountId: input.agent.owner_account_id ?? null };
  return db.transaction(async (tx) => {
    // One agent's rules are counted and deduplicated one request at a time.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake-rules:${input.roomId}:${input.agent.agent_key}`}, 0))`);
    const [existing] = await tx.select().from(agent_wake_rules).where(and(
      eq(agent_wake_rules.room_id, input.roomId),
      eq(agent_wake_rules.agent_key, input.agent.agent_key),
      eq(agent_wake_rules.identity_key, identityKey),
      inArray(agent_wake_rules.status, [...HELD_STATUSES]),
    )).limit(1);
    if (existing && input.webhook) {
      // The same webhook rule again: keep it, take the secret given now (a
      // rotation), and resume it if repeated failures had paused it.
      const [kept] = await tx.update(agent_wake_rules).set({
        delivery_target: input.webhook.seal(existing.id),
        status: "active",
        paused_at: null,
        delivery_consecutive_failures: existing.status === "paused" ? 0 : existing.delivery_consecutive_failures,
        updated_at: now,
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
      owner_account_id: input.agent.owner_account_id ?? null,
      delivery_kind: input.webhook ? "webhook" : null,
      delivery_target: input.webhook ? input.webhook.seal(id) : null,
    }).returning();
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

/** Rules the scheduler must look at now. A paused webhook rule is still due at its expiry. */
export async function getDueWakeRules(now: Date, limit = 200): Promise<WakeRuleRow[]> {
  return db.select().from(agent_wake_rules)
    .where(and(
      or(eq(agent_wake_rules.status, "active"), and(eq(agent_wake_rules.status, "paused"), eq(agent_wake_rules.event, "room.message"))),
      lte(agent_wake_rules.next_check_at, now.toISOString()),
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
