import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import type { WakeRuleActor, WakeRuleArguments, WakeRuleDeliveryKind, WakeRuleEvent, WakeRuleStatus } from "../../../../shared/wake-rules.mjs";
import type { EncryptedCredentials } from "../../connectors/crypto.js";
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
  /**
   * When the scheduler must look again: a timer, a settling CI run, or expiry.
   * Null only for a room.message rule without an expiry: messages, not the
   * scheduler, drive it.
   */
  next_check_at: timestamp("next_check_at", { mode: "string", withTimezone: true }),
  /** Null only for a room.message rule, which then lasts until it is cancelled. */
  expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }),
  fire_count: integer("fire_count").notNull().default(0),
  last_fired_at: timestamp("last_fired_at", { mode: "string", withTimezone: true }),
  wake_message_number: integer("wake_message_number"),
  cancelled_by: jsonb("cancelled_by").$type<WakeRuleActor>(),
  /** Why a rule stopped before its expiry: its pull request closed or its task finished. */
  ended_reason: text("ended_reason"),
  ended_at: timestamp("ended_at", { mode: "string", withTimezone: true }),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  /** The account that owns the agent. Only it may see delivery details of, or cancel, a webhook rule. */
  owner_account_id: text("owner_account_id"),
  /** room.message only: how the rule reaches its agent. */
  delivery_kind: text("delivery_kind").$type<WakeRuleDeliveryKind>(),
  /**
   * room.message only: where it delivers (a webhook's URL and secret), sealed
   * with the connector key and bound to this rule and account. Never returned
   * by the API.
   */
  delivery_target: jsonb("delivery_target").$type<EncryptedCredentials>(),
  delivery_consecutive_failures: integer("delivery_consecutive_failures").notNull().default(0),
  delivery_dropped_count: integer("delivery_dropped_count").notNull().default(0),
  delivery_delivered_count: integer("delivery_delivered_count").notNull().default(0),
  delivery_last_status: integer("delivery_last_status"),
  delivery_last_error: text("delivery_last_error"),
  delivery_last_attempt_at: timestamp("delivery_last_attempt_at", { mode: "string", withTimezone: true }),
  paused_at: timestamp("paused_at", { mode: "string", withTimezone: true }),
}, (table) => ({
  event_check: check("agent_wake_rules_event_check", sql`${table.event} IN ('timer', 'task.status_changed', 'github.check_completed', 'github.review_submitted', 'github.pr_closed', 'room.message')`),
  status_check: check("agent_wake_rules_status_check", sql`${table.status} IN ('active', 'fired', 'expired', 'cancelled', 'retired', 'paused')`),
  delivery_check: check("agent_wake_rules_delivery_check", sql`(${table.event} = 'room.message') = (${table.delivery_target} IS NOT NULL AND ${table.delivery_kind} IS NOT NULL)`),
  delivery_kind_check: check("agent_wake_rules_delivery_kind_check", sql`${table.delivery_kind} IS NULL OR ${table.delivery_kind} IN ('webhook')`),
  expiry_check: check("agent_wake_rules_expiry_check", sql`${table.event} = 'room.message' OR (${table.expires_at} IS NOT NULL AND ${table.next_check_at} IS NOT NULL)`),
  active_identity_uq: uniqueIndex("agent_wake_rules_active_identity_uq")
    .on(table.room_id, table.agent_key, table.identity_key)
    .where(sql`${table.status} = 'active'`),
  active_room_idx: index("agent_wake_rules_active_room_idx").on(table.room_id, table.event).where(sql`${table.status} = 'active'`),
  next_check_idx: index("agent_wake_rules_next_check_idx").on(table.next_check_at).where(sql`${table.status} = 'active'`),
  recent_idx: index("agent_wake_rules_recent_idx").on(table.room_id, table.ended_at).where(sql`${table.status} <> 'active'`),
}));

/**
 * One outbound wake delivery (a webhook POST), claimed and retried like a desktop push.
 * A rule has at most one delivery waiting to go out (`state = 'queued'`):
 * matches that arrive meanwhile fold into it and move it to the newest
 * message. Terminal rows keep no message text.
 */
export const wake_webhook_deliveries = pgTable("wake_webhook_deliveries", {
  id: text("id").primaryKey(),
  rule_id: text("rule_id").notNull().references(() => agent_wake_rules.id, { onDelete: "cascade" }),
  room_id: text("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  message_number: integer("message_number").notNull(),
  sender: text("sender").notNull(),
  text_preview: text("text_preview").notNull(),
  /** Matches folded into this delivery. */
  match_count: integer("match_count").notNull().default(1),
  state: text("state").$type<"queued" | "retry" | "processing" | "delivered" | "dead">().notNull().default("queued"),
  attempt_count: integer("attempt_count").notNull().default(0),
  /** When the delivery was first due: the end of the rule's coalescing window. */
  scheduled_at: timestamp("scheduled_at", { mode: "string", withTimezone: true }).notNull(),
  next_attempt_at: timestamp("next_attempt_at", { mode: "string", withTimezone: true }).notNull(),
  claimed_at: timestamp("claimed_at", { mode: "string", withTimezone: true }),
  claimed_by: text("claimed_by"),
  last_status: integer("last_status"),
  last_error: text("last_error"),
  delivered_at: timestamp("delivered_at", { mode: "string", withTimezone: true }),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
}, (table) => ({
  state_check: check("wake_webhook_deliveries_state_check", sql`${table.state} IN ('queued', 'retry', 'processing', 'delivered', 'dead')`),
  pending_uq: uniqueIndex("wake_webhook_deliveries_pending_uq").on(table.rule_id).where(sql`${table.state} = 'queued'`),
  ready_idx: index("wake_webhook_deliveries_ready_idx").on(table.next_attempt_at).where(sql`${table.state} IN ('queued', 'retry')`),
  rule_idx: index("wake_webhook_deliveries_rule_idx").on(table.rule_id, table.created_at),
}));
