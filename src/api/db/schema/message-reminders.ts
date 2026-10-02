import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { accounts } from "./core.js";
import { messages } from "./messages.js";
import { desktop_push_devices } from "./desktop-push.js";

export const message_reminders = pgTable("message_reminders", {
  id: text("id").primaryKey(),
  account_id: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade", onUpdate: "cascade" }),
  room_id: text("room_id").notNull(),
  message_number: integer("message_number").notNull(),
  due_at: timestamp("due_at", { mode: "string", withTimezone: true }).notNull(),
  state: text("state").notNull().default("pending"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  message_fk: foreignKey({ columns: [table.room_id, table.message_number], foreignColumns: [messages.room_id, messages.number] }).onDelete("cascade").onUpdate("cascade"),
  pending_idx: index("message_reminders_pending_idx").on(table.due_at, table.id).where(sql`${table.state} = 'pending'`),
  account_idx: index("message_reminders_account_idx").on(table.account_id, table.due_at, table.id),
  state_check: check("message_reminders_state_check", sql`${table.state} IN ('pending', 'due')`),
}));

export const desktop_reminder_deliveries = pgTable("desktop_reminder_deliveries", {
  id: text("id").primaryKey(),
  reminder_id: text("reminder_id").notNull().references(() => message_reminders.id, { onDelete: "cascade" }),
  device_id: text("device_id").notNull().references(() => desktop_push_devices.id, { onDelete: "cascade", onUpdate: "cascade" }),
  room_id: text("room_id").notNull(),
  message_number: integer("message_number").notNull(),
  thread_root_number: integer("thread_root_number"),
  room_display_name: text("room_display_name").notNull().default(""),
  sender: text("sender").notNull().default(""),
  body: text("body").notNull().default(""),
  state: text("state").notNull().default("queued"),
  attempt_count: integer("attempt_count").notNull().default(0),
  next_attempt_at: timestamp("next_attempt_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  claimed_at: timestamp("claimed_at", { mode: "string", withTimezone: true }),
  claimed_by: text("claimed_by"),
  apns_id: text("apns_id"),
  last_status: integer("last_status"),
  last_error: text("last_error"),
  delivered_at: timestamp("delivered_at", { mode: "string", withTimezone: true }),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  device_reminder_uq: uniqueIndex("desktop_reminder_deliveries_device_reminder_uq").on(table.device_id, table.reminder_id),
  ready_idx: index("desktop_reminder_deliveries_ready_idx").on(table.state, table.next_attempt_at, table.created_at),
  reminder_idx: index("desktop_reminder_deliveries_reminder_idx").on(table.reminder_id),
  state_check: check("desktop_reminder_deliveries_state_check", sql`${table.state} IN ('queued', 'processing', 'retry', 'delivered', 'dead')`),
}));
