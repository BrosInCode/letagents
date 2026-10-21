import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";

import type {
  TrackerRuleAction,
  TrackerRuleInput,
  TrackerRuleTrigger,
  TrackerRuleVersionView,
  TrackerRuleView,
} from "../../../../shared/ticket-connectors.mjs";
import { db } from "../../db/client.js";
import { room_tracker_filters, tracker_rule_runs, tracker_rule_versions, tracker_rules } from "../../db/schema.js";
import { parseTrackerRuleAction, parseTrackerRuleTrigger } from "./validate.js";

export type TrackerRuleRow = typeof tracker_rules.$inferSelect;
export type TrackerRuleRunRow = typeof tracker_rule_runs.$inferSelect;
export type TrackerRuleRunOutcome = "pending" | "succeeded" | "failed" | "quarantined" | "error";

/** A stored rule whose trigger and actions passed validation again on read. */
export interface LoadedTrackerRule {
  id: string;
  connection_id: string;
  room_id: string | null;
  name: string;
  enabled: boolean;
  version: number;
  trigger: TrackerRuleTrigger;
  actions: TrackerRuleAction[];
}

/** A rule runs at most once per ticket and event type and action in this window. */
export const TRACKER_RULE_RUN_DEBOUNCE_MS = 10 * 60_000;

export function newTrackerRuleId(): string {
  return `trule_${randomUUID()}`;
}

/**
 * Validates a stored rule again. A row changed outside the routes (or by an
 * older format) is dropped instead of acting on a shape nobody checked.
 */
export function loadTrackerRule(row: TrackerRuleRow): LoadedTrackerRule | null {
  const trigger = parseTrackerRuleTrigger(row.trigger);
  if (!trigger.ok || !Array.isArray(row.actions) || row.actions.length === 0) return null;
  const actions: TrackerRuleAction[] = [];
  for (const [index, entry] of row.actions.entries()) {
    const action = parseTrackerRuleAction(entry, index);
    if (!action.ok) return null;
    actions.push(action.value);
  }
  return {
    id: row.id,
    connection_id: row.connection_id,
    room_id: row.room_id,
    name: row.name,
    enabled: row.enabled,
    version: row.version,
    trigger: trigger.value,
    actions,
  };
}

export function toTrackerRuleView(row: TrackerRuleRow): TrackerRuleView {
  return {
    id: row.id,
    connection_id: row.connection_id,
    room_id: row.room_id,
    name: row.name,
    enabled: row.enabled,
    trigger: row.trigger as unknown as TrackerRuleTrigger,
    actions: row.actions as unknown as TrackerRuleAction[],
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

type Executor = Pick<typeof db, "insert" | "select" | "update">;

async function insertVersion(executor: Executor, rule: TrackerRuleRow, accountId: string, at: string): Promise<void> {
  await executor.insert(tracker_rule_versions).values({
    id: `trulev_${randomUUID()}`,
    rule_id: rule.id,
    version: rule.version,
    name: rule.name,
    room_id: rule.room_id,
    trigger: rule.trigger,
    actions: rule.actions,
    created_by: accountId,
    created_at: at,
  });
}

/** Rules, versions and runs. Callers check that the account owns the connection. */
export const trackerRuleStore = {
  async list(connectionId: string): Promise<TrackerRuleRow[]> {
    return db.select().from(tracker_rules)
      .where(eq(tracker_rules.connection_id, connectionId))
      .orderBy(asc(tracker_rules.created_at), asc(tracker_rules.id));
  },

  async count(connectionId: string): Promise<number> {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(tracker_rules)
      .where(eq(tracker_rules.connection_id, connectionId));
    return row?.count ?? 0;
  },

  async get(connectionId: string, ruleId: string): Promise<TrackerRuleRow | null> {
    const [row] = await db.select().from(tracker_rules)
      .where(and(eq(tracker_rules.id, ruleId), eq(tracker_rules.connection_id, connectionId)))
      .limit(1);
    return row ?? null;
  },

  async create(connectionId: string, accountId: string, input: TrackerRuleInput): Promise<TrackerRuleRow> {
    const at = new Date().toISOString();
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(tracker_rules).values({
        id: newTrackerRuleId(),
        connection_id: connectionId,
        room_id: input.room_id,
        name: input.name,
        enabled: input.enabled ?? true,
        trigger: input.trigger as unknown as Record<string, unknown>,
        actions: input.actions as unknown as Array<Record<string, unknown>>,
        version: 1,
        created_by: accountId,
        created_at: at,
        updated_at: at,
      }).returning();
      await insertVersion(tx, row!, accountId, at);
      return row!;
    });
  },

  /** Saves the content as the next version. The row is locked so two saves cannot take one number. */
  async update(connectionId: string, ruleId: string, accountId: string, input: TrackerRuleInput): Promise<TrackerRuleRow | null> {
    const at = new Date().toISOString();
    return db.transaction(async (tx) => {
      const [current] = await tx.select().from(tracker_rules)
        .where(and(eq(tracker_rules.id, ruleId), eq(tracker_rules.connection_id, connectionId)))
        .for("update").limit(1);
      if (!current) return null;
      const [row] = await tx.update(tracker_rules).set({
        room_id: input.room_id,
        name: input.name,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        trigger: input.trigger as unknown as Record<string, unknown>,
        actions: input.actions as unknown as Array<Record<string, unknown>>,
        version: current.version + 1,
        updated_at: at,
      }).where(eq(tracker_rules.id, ruleId)).returning();
      await insertVersion(tx, row!, accountId, at);
      return row!;
    });
  },

  async setEnabled(connectionId: string, ruleId: string, enabled: boolean): Promise<TrackerRuleRow | null> {
    const [row] = await db.update(tracker_rules)
      .set({ enabled, updated_at: new Date().toISOString() })
      .where(and(eq(tracker_rules.id, ruleId), eq(tracker_rules.connection_id, connectionId)))
      .returning();
    return row ?? null;
  },

  async delete(connectionId: string, ruleId: string): Promise<boolean> {
    const rows = await db.delete(tracker_rules)
      .where(and(eq(tracker_rules.id, ruleId), eq(tracker_rules.connection_id, connectionId)))
      .returning({ id: tracker_rules.id });
    return rows.length > 0;
  },

  async versions(ruleId: string): Promise<TrackerRuleVersionView[]> {
    const rows = await db.select().from(tracker_rule_versions)
      .where(eq(tracker_rule_versions.rule_id, ruleId))
      .orderBy(desc(tracker_rule_versions.version))
      .limit(100);
    return rows.map((row) => ({
      version: row.version,
      name: row.name,
      room_id: row.room_id,
      trigger: row.trigger as unknown as TrackerRuleTrigger,
      actions: row.actions as unknown as TrackerRuleAction[],
      created_at: row.created_at,
    }));
  },

  async version(ruleId: string, version: number): Promise<TrackerRuleVersionView | null> {
    const [row] = await db.select().from(tracker_rule_versions)
      .where(and(eq(tracker_rule_versions.rule_id, ruleId), eq(tracker_rule_versions.version, version)))
      .limit(1);
    return row
      ? {
          version: row.version,
          name: row.name,
          room_id: row.room_id,
          trigger: row.trigger as unknown as TrackerRuleTrigger,
          actions: row.actions as unknown as TrackerRuleAction[],
          created_at: row.created_at,
        }
      : null;
  },

  /** The connection's rules that can apply in this room, oldest first: the matcher's order. */
  async forRoom(connectionId: string, roomId: string): Promise<LoadedTrackerRule[]> {
    const rows = await db.select().from(tracker_rules)
      .where(and(
        eq(tracker_rules.connection_id, connectionId),
        eq(tracker_rules.enabled, true),
        or(isNull(tracker_rules.room_id), eq(tracker_rules.room_id, roomId)),
      ))
      .orderBy(asc(tracker_rules.created_at), asc(tracker_rules.id));
    return rows.map(loadTrackerRule).filter((rule): rule is LoadedTrackerRule => rule !== null);
  },

  /**
   * Records that a rule matched one delivery. Unique per rule and delivery:
   * the first room to record it owns the run; `claimed` is false when another
   * room did. A retry of the same delivery in the same room gets its earlier
   * row back, with the actions it planned then. A rule runs at most once per
   * ticket and event (type and action) in `TRACKER_RULE_RUN_DEBOUNCE_MS`, so a
   * burst of check runs or a close-and-reopen loop writes once.
   */
  async claimRun(
    input: Omit<TrackerRuleRunRow, "id" | "effect_ids" | "outcome" | "detail" | "created_at" | "updated_at">,
    now = new Date(),
  ): Promise<{ run: TrackerRuleRunRow | null; claimed: boolean }> {
    const sameDelivery = and(eq(tracker_rule_runs.rule_id, input.rule_id!), eq(tracker_rule_runs.delivery_id, input.delivery_id));
    const owns = (run: TrackerRuleRunRow) => run.room_id === input.room_id && run.task_id === input.task_id;
    return db.transaction(async (tx) => {
      // One claim at a time per rule and ticket, so a burst of deliveries
      // (check runs finish together) cannot all pass the debounce check.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tracker_rule_run:${input.rule_id}:${input.external_ref}`}))`);
      const [earlier] = await tx.select().from(tracker_rule_runs).where(sameDelivery).limit(1);
      if (earlier) return { run: earlier, claimed: owns(earlier) };
      const [recent] = await tx.select({ id: tracker_rule_runs.id }).from(tracker_rule_runs)
        .where(and(
          eq(tracker_rule_runs.rule_id, input.rule_id!),
          eq(tracker_rule_runs.external_ref, input.external_ref),
          eq(tracker_rule_runs.event_type, input.event_type),
          eq(tracker_rule_runs.event_action, input.event_action),
          gt(tracker_rule_runs.created_at, new Date(now.getTime() - TRACKER_RULE_RUN_DEBOUNCE_MS).toISOString()),
        ))
        .limit(1);
      if (recent) return { run: null, claimed: false };
      const at = now.toISOString();
      const [inserted] = await tx.insert(tracker_rule_runs).values({
        ...input,
        id: `trun_${randomUUID()}`,
        effect_ids: [],
        outcome: "pending",
        detail: null,
        created_at: at,
        updated_at: at,
      }).onConflictDoNothing({ target: [tracker_rule_runs.rule_id, tracker_rule_runs.delivery_id] }).returning();
      if (inserted) return { run: inserted, claimed: true };
      // The same delivery for another ticket of this rule was claimed meanwhile.
      const [existing] = await tx.select().from(tracker_rule_runs).where(sameDelivery).limit(1);
      if (!existing) throw new Error("The rule run conflict row could not be loaded.");
      return { run: existing, claimed: owns(existing) };
    });
  },

  async finishRun(id: string, input: { effect_ids: string[]; outcome: TrackerRuleRunOutcome; detail: string | null }): Promise<void> {
    await db.update(tracker_rule_runs)
      .set({ ...input, updated_at: new Date().toISOString() })
      .where(eq(tracker_rule_runs.id, id));
  },

  /** Rooms with a filter on this connection, enabled or not: the rooms a rule may name. */
  async roomsForConnection(connectionId: string): Promise<string[]> {
    const rows = await db.select({ room_id: room_tracker_filters.room_id }).from(room_tracker_filters)
      .where(eq(room_tracker_filters.connection_id, connectionId))
      .orderBy(asc(room_tracker_filters.room_id));
    return [...new Set(rows.map((row) => row.room_id))];
  },

  async runsForRoom(roomId: string, limit = 50): Promise<TrackerRuleRunRow[]> {
    return db.select().from(tracker_rule_runs)
      .where(eq(tracker_rule_runs.room_id, roomId))
      .orderBy(desc(tracker_rule_runs.created_at))
      .limit(limit);
  },
};

export type TrackerRuleStore = typeof trackerRuleStore;
