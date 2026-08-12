import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { room_agent_sessions } from "./agents.js";
import { rooms } from "./core.js";
import type { BoardIntentPayload } from "../../board-intent-payloads.js";

export const room_board_settings = pgTable(
  "room_board_settings",
  {
    room_id: text("room_id")
      .primaryKey()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    manager_mode: text("manager_mode").notNull().default("manager_optional"),
    manager_failover: text("manager_failover").notNull().default("auto"),
    stall_nudged_at: timestamp("stall_nudged_at", { mode: "string", withTimezone: true }),
    open_task_count: integer("open_task_count").notNull().default(0),
    last_task_closed_at: timestamp("last_task_closed_at", { mode: "string", withTimezone: true }),
    stall_check_at: timestamp("stall_check_at", { mode: "string", withTimezone: true }),
    updated_by: text("updated_by"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    stall_due_idx: index("room_board_settings_stall_due_idx")
      .on(table.stall_check_at, table.room_id)
      .where(sql`${table.open_task_count} = 0 AND ${table.stall_check_at} IS NOT NULL`),
    manager_mode_check: check(
      "room_board_settings_manager_mode_check",
      sql`${table.manager_mode} IN ('off', 'manager_optional', 'intent_required')`
    ),
    manager_failover_check: check(
      "room_board_settings_manager_failover_check",
      sql`${table.manager_failover} IN ('off', 'announce', 'auto')`
    ),
  })
);

export const board_manager_assignments = pgTable(
  "board_manager_assignments",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    agent_session_id: text("agent_session_id")
      .notNull()
      .references(() => room_agent_sessions.session_id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    agent_key: text("agent_key").notNull(),
    actor_label: text("actor_label").notNull(),
    runtime_source: text("runtime_source").notNull().default("desktop_managed"),
    assigned_by: text("assigned_by").notNull(),
    status: text("status").notNull().default("active"),
    last_heartbeat_at: timestamp("last_heartbeat_at", { mode: "string", withTimezone: true }),
    stall_check_at: timestamp("stall_check_at", { mode: "string", withTimezone: true }),
    released_by: text("released_by"),
    release_reason: text("release_reason"),
    released_at: timestamp("released_at", { mode: "string", withTimezone: true }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_idx: index("board_manager_assignments_room_idx").on(table.room_id, table.status),
    room_agent_session_idx: index("board_manager_assignments_agent_session_idx").on(
      table.room_id,
      table.agent_session_id
    ),
    active_room_unique_idx: uniqueIndex("board_manager_assignments_active_room_unique_idx")
      .on(table.room_id)
      .where(sql`${table.status} = 'active' AND ${table.released_at} IS NULL`),
    stall_due_idx: index("board_manager_assignments_stall_due_idx")
      .on(table.stall_check_at, table.id, table.room_id)
      .where(sql`${table.status} = 'active' AND ${table.stall_check_at} IS NOT NULL`),
    status_check: check(
      "board_manager_assignments_status_check",
      sql`${table.status} IN ('active', 'released')`
    ),
    runtime_source_check: check(
      "board_manager_assignments_runtime_source_check",
      sql`${table.runtime_source} IN ('desktop_managed', 'open_model', 'external', 'unknown')`
    ),
  })
);

export const board_intents = pgTable(
  "board_intents",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    task_id: text("task_id"),
    action_type: text("action_type").notNull(),
    payload: jsonb("payload").$type<BoardIntentPayload>().notNull(),
    payload_hash: text("payload_hash").notNull(),
    status: text("status").notNull().default("pending"),
    proposer_actor_label: text("proposer_actor_label"),
    proposer_actor_key: text("proposer_actor_key"),
    proposer_actor_instance_id: text("proposer_actor_instance_id"),
    proposer_agent_session_id: text("proposer_agent_session_id").references(
      () => room_agent_sessions.session_id,
      { onDelete: "set null", onUpdate: "cascade" }
    ),
    decision_by: text("decision_by"),
    decision_reason: text("decision_reason"),
    approval_token_hash: text("approval_token_hash"),
    decided_at: timestamp("decided_at", { mode: "string", withTimezone: true }),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }),
    escalated_at: timestamp("escalated_at", { mode: "string", withTimezone: true }),
    escalation_check_at: timestamp("escalation_check_at", { mode: "string", withTimezone: true }),
    auto_approved: boolean("auto_approved").notNull().default(false),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_status_idx: index("board_intents_room_status_idx").on(table.room_id, table.status),
    room_status_created_idx: index("board_intents_room_status_created_idx").on(
      table.room_id,
      table.status,
      table.created_at,
      table.id
    ),
    room_task_idx: index("board_intents_room_task_idx").on(table.room_id, table.task_id),
    proposer_session_idx: index("board_intents_proposer_session_idx").on(
      table.room_id,
      table.proposer_agent_session_id
    ),
    pending_action_payload_idx: uniqueIndex("board_intents_pending_action_payload_idx")
      .on(table.room_id, table.action_type, table.payload_hash)
      .where(sql`${table.status} = 'pending'`),
    escalation_due_idx: index("board_intents_escalation_due_idx")
      .on(table.escalation_check_at, table.id, table.room_id)
      .where(sql`${table.status} = 'pending' AND ${table.escalated_at} IS NULL AND ${table.escalation_check_at} IS NOT NULL`),
    expiry_due_idx: index("board_intents_expiry_due_idx")
      .on(table.expires_at, table.id, table.room_id)
      .where(sql`${table.status} IN ('pending', 'approved') AND ${table.expires_at} IS NOT NULL`),
    status_check: check(
      "board_intents_status_check",
      sql`${table.status} IN ('pending', 'approved', 'denied', 'expired', 'used')`
    ),
    action_type_check: check(
      "board_intents_action_type_check",
      sql`${table.action_type} IN ('task_create', 'task_claim', 'task_close', 'task_override', 'task_update')`
    ),
  })
);
