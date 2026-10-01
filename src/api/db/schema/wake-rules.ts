import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import type { WakeRuleActor, WakeRuleArguments, WakeRuleEvent, WakeRuleStatus } from "../../../../shared/wake-rules.mjs";
import { rooms } from "./core.js";

/**
 * What an agent is waiting for. A rule is checked against durable room state
 * (task status, recorded GitHub events, the clock), so a missed live event
 * only delays a wake; it cannot lose one. `fire_count` fences each wake: the
 * wake message and the rule update commit together or not at all.
 */
export const agent_wake_rules = pgTable("agent_wake_rules", {
  id: text("id").primaryKey(),
  room_id: text("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  agent_key: text("agent_key").notNull(),
  agent_name: text("agent_name").notNull(),
  created_by_session_id: text("created_by_session_id"),
  event: text("event").$type<WakeRuleEvent>().notNull(),
  arguments: jsonb("arguments").$type<WakeRuleArguments>().notNull(),
  identity_key: text("identity_key").notNull(),
  note: text("note"),
  repeat: boolean("repeat").notNull().default(false),
  status: text("status").$type<WakeRuleStatus>().notNull().default("active"),
  /** Task rules: the task's board and the status seen when the rule was made or last fired. */
  baseline: jsonb("baseline").$type<{ room_id: string; status: string }>(),
  /** Only events after this moment can fire the rule. */
  cursor_at: timestamp("cursor_at", { mode: "string", withTimezone: true }).notNull(),
  /** When the scheduler must look again: a timer, a settling CI run, or expiry. */
  next_check_at: timestamp("next_check_at", { mode: "string", withTimezone: true }).notNull(),
  expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
  fire_count: integer("fire_count").notNull().default(0),
  last_fired_at: timestamp("last_fired_at", { mode: "string", withTimezone: true }),
  wake_message_number: integer("wake_message_number"),
  cancelled_by: jsonb("cancelled_by").$type<WakeRuleActor>(),
  /** Why a rule stopped before its expiry: its pull request closed or its task finished. */
  ended_reason: text("ended_reason"),
  ended_at: timestamp("ended_at", { mode: "string", withTimezone: true }),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
}, (table) => ({
  event_check: check("agent_wake_rules_event_check", sql`${table.event} IN ('timer', 'task.status_changed', 'github.check_completed', 'github.review_submitted', 'github.pr_closed')`),
  status_check: check("agent_wake_rules_status_check", sql`${table.status} IN ('active', 'fired', 'expired', 'cancelled', 'retired')`),
  active_identity_uq: uniqueIndex("agent_wake_rules_active_identity_uq")
    .on(table.room_id, table.agent_key, table.identity_key)
    .where(sql`${table.status} = 'active'`),
  active_room_idx: index("agent_wake_rules_active_room_idx").on(table.room_id, table.event).where(sql`${table.status} = 'active'`),
  next_check_idx: index("agent_wake_rules_next_check_idx").on(table.next_check_at).where(sql`${table.status} = 'active'`),
  recent_idx: index("agent_wake_rules_recent_idx").on(table.room_id, table.ended_at).where(sql`${table.status} <> 'active'`),
}));
