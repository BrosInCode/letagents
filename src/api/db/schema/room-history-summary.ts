import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { rooms } from "./core.js";

/**
 * Where a room's history summary stands: the next message number to read into
 * the tree, how many messages it holds, and the worker lease and retry state.
 * A row exists once the worker first reached the room.
 */
export const room_history_summary_state = pgTable("room_history_summary_state", {
  room_id: text("room_id").primaryKey().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  next_number: integer("next_number").notNull(),
  leaf_count: integer("leaf_count").notNull().default(0),
  claim_token: text("claim_token"),
  available_at: timestamp("available_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  failures: integer("failures").notNull().default(0),
  last_error: text("last_error"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  counts_check: check("room_history_summary_state_counts_check",
    sql`${table.next_number} >= 0 AND ${table.leaf_count} >= 0 AND ${table.failures} >= 0`),
  available_idx: index("room_history_summary_state_available_idx").on(table.available_at),
}));

/**
 * One line of the tree. Node (0, idx) is the idx-th summarized message; node
 * (level, idx) merges (level-1, 2idx) and (level-1, 2idx+1). `text` is null
 * until the line is written. A parent row exists once both children have text.
 */
export const room_history_summary_nodes = pgTable("room_history_summary_nodes", {
  room_id: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  level: integer("level").notNull(),
  idx: integer("idx").notNull(),
  first_number: integer("first_number").notNull(),
  last_number: integer("last_number").notNull(),
  first_at: timestamp("first_at", { mode: "string", withTimezone: true }).notNull(),
  last_at: timestamp("last_at", { mode: "string", withTimezone: true }).notNull(),
  text: text("text"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  built_at: timestamp("built_at", { mode: "string", withTimezone: true }),
}, (table) => ({
  pk: primaryKey({ name: "room_history_summary_nodes_pk", columns: [table.room_id, table.level, table.idx] }),
  range_check: check("room_history_summary_nodes_range_check",
    sql`${table.level} >= 0 AND ${table.level} <= 40 AND ${table.idx} >= 0 AND ${table.first_number} <= ${table.last_number}`),
  text_check: check("room_history_summary_nodes_text_check",
    sql`${table.text} IS NULL OR octet_length(${table.text}) BETWEEN 1 AND 512`),
  unbuilt_idx: index("room_history_summary_nodes_unbuilt_idx").on(table.room_id, table.level, table.idx).where(sql`${table.text} IS NULL`),
}));
