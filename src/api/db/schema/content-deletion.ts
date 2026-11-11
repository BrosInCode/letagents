import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { rooms } from "./core.js";

export const deleted_content_keys = pgTable("deleted_content_keys", {
  room_id: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  kind: text("kind").notNull(),
  client_key: text("client_key").notNull(),
}, table => ({
  pk: primaryKey({ columns: [table.room_id, table.kind, table.client_key] }),
  kind_check: check("deleted_content_keys_kind_check", sql`${table.kind} IN ('message', 'task', 'task_source', 'task_external')`),
}));

export const attachment_deletion_queue = pgTable("attachment_deletion_queue", {
  object_key: text("object_key").primaryKey(),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
});

export const deleted_rooms = pgTable("deleted_rooms", {
  room_id: text("room_id").primaryKey(),
  deleted_at: timestamp("deleted_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
});
