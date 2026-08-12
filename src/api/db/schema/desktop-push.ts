import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { accounts, rooms } from "./core.js";
import { messages } from "./messages.js";

export const desktop_push_devices = pgTable(
  "desktop_push_devices",
  {
    id: text("id").primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade", onUpdate: "cascade" }),
    installation_id: text("installation_id").notNull(),
    device_token: text("device_token").notNull(),
    token_hash: text("token_hash").notNull(),
    bundle_id: text("bundle_id").notNull(),
    environment: text("environment").notNull(),
    app_version: text("app_version"),
    enabled: boolean("enabled").notNull().default(true),
    failure_count: integer("failure_count").notNull().default(0),
    last_error: text("last_error"),
    last_registered_at: timestamp("last_registered_at", { mode: "string", withTimezone: true }).notNull(),
    disabled_at: timestamp("disabled_at", { mode: "string", withTimezone: true }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    account_installation_uq: uniqueIndex("desktop_push_devices_account_installation_uq")
      .on(table.account_id, table.installation_id, table.environment),
    token_uq: uniqueIndex("desktop_push_devices_token_uq")
      .on(table.environment, table.token_hash),
    account_idx: index("desktop_push_devices_account_idx").on(table.account_id),
    active_idx: index("desktop_push_devices_active_idx").on(table.enabled, table.environment),
    environment_check: check(
      "desktop_push_devices_environment_check",
      sql`${table.environment} IN ('production', 'sandbox')`,
    ),
  }),
);
export const desktop_push_notifications = pgTable(
  "desktop_push_notifications",
  {
    id: text("id").primaryKey(),
    device_id: text("device_id")
      .notNull()
      .references(() => desktop_push_devices.id, { onDelete: "cascade", onUpdate: "cascade" }),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    message_number: integer("message_number").notNull(),
    thread_root_number: integer("thread_root_number"),
    room_display_name: text("room_display_name").notNull(),
    sender: text("sender").notNull(),
    body: text("body").notNull(),
    state: text("state").notNull().default("queued"),
    attempt_count: integer("attempt_count").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { mode: "string", withTimezone: true }).notNull(),
    claimed_at: timestamp("claimed_at", { mode: "string", withTimezone: true }),
    claimed_by: text("claimed_by"),
    apns_id: text("apns_id"),
    last_status: integer("last_status"),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    delivered_at: timestamp("delivered_at", { mode: "string", withTimezone: true }),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    message_fk: foreignKey({
      name: "desktop_push_notifications_message_fk",
      columns: [table.room_id, table.message_number],
      foreignColumns: [messages.room_id, messages.number],
    }).onDelete("cascade").onUpdate("cascade"),
    device_message_uq: uniqueIndex("desktop_push_notifications_device_message_uq")
      .on(table.device_id, table.room_id, table.message_number),
    ready_idx: index("desktop_push_notifications_ready_idx")
      .on(table.state, table.next_attempt_at, table.created_at),
    device_idx: index("desktop_push_notifications_device_idx").on(table.device_id),
    state_check: check(
      "desktop_push_notifications_state_check",
      sql`${table.state} IN ('queued', 'processing', 'retry', 'delivered', 'dead')`,
    ),
  }),
);
