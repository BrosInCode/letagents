import { and, asc, desc, eq, gt, lte, ne, sql } from "drizzle-orm";
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
} from "../../../shared/wake-rules.mjs";
import { db } from "./client.js";
import { agent_wake_rules } from "./schema.js";
import type { MessageCreateTransaction } from "./messages/create.js";
import type { WakeRuleEvaluationDeps } from "../wake-rules/evaluate.js";

export type WakeRuleRow = typeof agent_wake_rules.$inferSelect;
type Executor = typeof db | MessageCreateTransaction;

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 50;
/** A person can undo a cancel for this long. */
export const WAKE_RULE_RESTORE_WINDOW_MS = 10 * 60 * 1000;

export function toWakeRule(row: WakeRuleRow): WakeRule {
  return {
    id: row.id,
    room_id: row.room_id,
    agent_key: row.agent_key,
    agent_name: row.agent_name,
    event: row.event,
    arguments: row.arguments,
    repeat: row.repeat,
    expires_at: new Date(row.expires_at).toISOString(),
    note: row.note,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    fire_count: row.fire_count,
    last_fired_at: row.last_fired_at ? new Date(row.last_fired_at).toISOString() : null,
    wake_message_id: row.wake_message_number ? `msg_${row.wake_message_number}` : null,
    cancelled_by: row.cancelled_by ?? null,
    ended_reason: row.ended_reason ?? null,
  };
}

/** The first moment the scheduler must look at a new or re-armed rule. */
export function initialNextCheckAt(input: Pick<ParsedWakeRuleInput, "event" | "arguments" | "expires_at">): string {
  return input.event === "timer" ? input.arguments.at! : input.expires_at;
}

export async function createWakeRule(input: {
  roomId: string;
  agent: { agent_key: string; agent_name: string; session_id: string | null };
  rule: ParsedWakeRuleInput;
  baseline: WakeRuleRow["baseline"];
  now?: Date;
}): Promise<{ rule: WakeRule; created: boolean }> {
  const now = (input.now ?? new Date()).toISOString();
  const identityKey = wakeRuleIdentityKey(input.rule.event, input.rule.arguments);
  return db.transaction(async (tx) => {
    // One agent's rules are counted and deduplicated one request at a time.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake-rules:${input.roomId}:${input.agent.agent_key}`}, 0))`);
    const [existing] = await tx.select().from(agent_wake_rules).where(and(
      eq(agent_wake_rules.room_id, input.roomId),
      eq(agent_wake_rules.agent_key, input.agent.agent_key),
      eq(agent_wake_rules.identity_key, identityKey),
      eq(agent_wake_rules.status, "active"),
    )).limit(1);
    if (existing) return { rule: toWakeRule(existing), created: false };
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(agent_wake_rules).where(and(
      eq(agent_wake_rules.room_id, input.roomId),
      eq(agent_wake_rules.agent_key, input.agent.agent_key),
      eq(agent_wake_rules.status, "active"),
    ));
    if (count >= WAKE_RULE_LIMITS.activePerAgent) {
      throw new WakeRuleError(`You already have ${WAKE_RULE_LIMITS.activePerAgent} active wake rules in this room. Cancel one you no longer need first.`, 409);
    }
    const [row] = await tx.insert(agent_wake_rules).values({
      id: `wake_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
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
    }).returning();
    return { rule: toWakeRule(row!), created: true };
  });
}

export async function getWakeRule(roomId: string, id: string): Promise<WakeRuleRow | null> {
  const [row] = await db.select().from(agent_wake_rules)
    .where(and(eq(agent_wake_rules.room_id, roomId), eq(agent_wake_rules.id, id))).limit(1);
  return row ?? null;
}

export async function listWakeRules(roomId: string, options: { agentKey?: string; now?: Date } = {}): Promise<WakeRulePage> {
  const since = new Date((options.now ?? new Date()).getTime() - RECENT_WINDOW_MS).toISOString();
  const agent = options.agentKey ? eq(agent_wake_rules.agent_key, options.agentKey) : undefined;
  const [active, recent] = await Promise.all([
    db.select().from(agent_wake_rules)
      .where(and(eq(agent_wake_rules.room_id, roomId), eq(agent_wake_rules.status, "active"), agent))
      .orderBy(asc(agent_wake_rules.next_check_at), asc(agent_wake_rules.id)),
    db.select().from(agent_wake_rules)
      .where(and(eq(agent_wake_rules.room_id, roomId), ne(agent_wake_rules.status, "active"), gt(agent_wake_rules.ended_at, since), agent))
      .orderBy(desc(agent_wake_rules.ended_at), desc(agent_wake_rules.id))
      .limit(RECENT_LIMIT),
  ]);
  return { room_id: roomId, active: active.map(toWakeRule), recent: recent.map(toWakeRule) };
}

export async function cancelWakeRule(roomId: string, id: string, actor: WakeRuleActor): Promise<WakeRule | null> {
  const now = new Date().toISOString();
  const [row] = await db.update(agent_wake_rules)
    .set({ status: "cancelled", cancelled_by: actor, ended_at: now, updated_at: now })
    .where(and(eq(agent_wake_rules.room_id, roomId), eq(agent_wake_rules.id, id), eq(agent_wake_rules.status, "active")))
    .returning();
  return row ? toWakeRule(row) : null;
}

/**
 * Undo a recent cancel, by whoever cancelled it. The rule keeps its original
 * cursor, so anything that happened while it was cancelled still wakes the
 * agent. It counts against the agent's limit like a new rule.
 */
export async function restoreWakeRule(roomId: string, id: string, actor: WakeRuleActor, now = new Date()): Promise<WakeRule> {
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
      eq(agent_wake_rules.status, "active"),
    ));
    if (count >= WAKE_RULE_LIMITS.activePerAgent) {
      throw new WakeRuleError(`The agent already has ${WAKE_RULE_LIMITS.activePerAgent} active wake rules in this room.`, 409);
    }
    try {
      const [row] = await tx.update(agent_wake_rules)
        .set({ status: "active", cancelled_by: null, ended_at: null, next_check_at: nowIso, updated_at: nowIso })
        .where(and(
          eq(agent_wake_rules.room_id, roomId),
          eq(agent_wake_rules.id, id),
          eq(agent_wake_rules.status, "cancelled"),
          sql`${agent_wake_rules.cancelled_by}->>'kind' = ${actor.kind}`,
          sql`${agent_wake_rules.cancelled_by}->>'id' = ${actor.id}`,
          gt(agent_wake_rules.ended_at, restoreAfter),
          gt(agent_wake_rules.expires_at, nowIso),
        ))
        .returning();
      if (!row) throw new WakeRuleError("This wake rule can no longer be restored.", 409);
      return toWakeRule(row);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new WakeRuleError("The agent already has an active wake rule for this.", 409);
      }
      throw error;
    }
  });
}

export async function getDueWakeRules(now: Date, limit = 200): Promise<WakeRuleRow[]> {
  return db.select().from(agent_wake_rules)
    .where(and(eq(agent_wake_rules.status, "active"), lte(agent_wake_rules.next_check_at, now.toISOString())))
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
    .from(agent_wake_rules).where(eq(agent_wake_rules.status, "active"));
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
  const nextAt = options.capAtExpiry === false || Date.parse(at) < Date.parse(rule.expires_at) ? at : rule.expires_at;
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
  outcome: "fired" | "expired";
  messageNumber: number;
  cursorAt: string;
  baseline: WakeRuleRow["baseline"];
  now: string;
  /** Set when this wake is the rule's last because what it watched is over. */
  endedReason?: string | null;
}): Promise<boolean> {
  const keepsWatching = input.outcome === "fired" && rule.repeat && !input.endedReason
    && Date.parse(rule.expires_at) > Date.parse(input.now);
  const nextCheckAt = keepsWatching
    ? new Date(Math.min(Date.parse(input.now) + WAKE_RULE_LIMITS.repeatDebounceMs, Date.parse(rule.expires_at))).toISOString()
    : rule.next_check_at;
  const updated = await tx.update(agent_wake_rules)
    .set({
      status: keepsWatching ? "active" : input.outcome === "expired" ? "expired" : "fired",
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
 * End a rule whose pull request closed or whose task finished, without waking
 * the agent: nothing it waits for can happen any more. Fenced like a wake, so
 * a concurrent wake wins and the next look decides again.
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
 * Rooms whose GitHub events concern a room: itself, its parent, every room
 * bound to the same repository, and their focus rooms. Events land in a
 * branch room, a focus room or the repository room depending on routing; an
 * agent waiting on a branch should not care which. A subquery, not a list, so
 * a repository with thousands of branch rooms is never truncated.
 */
function repositoryRoomIds(roomId: string) {
  return sql`(
    WITH anchor AS (
      SELECT ${roomId}::text AS room_id
      UNION SELECT room.parent_room_id FROM rooms AS room WHERE room.id = ${roomId} AND room.parent_room_id IS NOT NULL
    ), family AS (
      SELECT room_id FROM anchor
      UNION SELECT binding.room_id
        FROM room_git_bindings AS binding
        JOIN room_git_bindings AS bound
          ON bound.provider = binding.provider
         AND bound.host = binding.host
         AND bound.repository_full_name = binding.repository_full_name
       WHERE bound.room_id IN (SELECT room_id FROM anchor)
    )
    SELECT room_id FROM family
    UNION SELECT room.id FROM rooms AS room WHERE room.parent_room_id IN (SELECT room_id FROM family)
  )`;
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
    const result = await db.execute<{ action: string; state: string | null }>(sql`
      SELECT action, state FROM github_room_events
       WHERE event_type = 'pull_request' AND github_object_id = ${String(pr)}
         AND action IN ('closed', 'reopened')
         AND room_id IN ${repositoryRoomIds(ruleRoomId)}
       ORDER BY event_order_at DESC, created_at DESC, id DESC
       LIMIT 1
    `);
    const latest = result.rows[0];
    return latest?.action === "closed" ? { merged: latest.state === "merged" } : null;
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
