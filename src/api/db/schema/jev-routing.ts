import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { DeferredJevRoutingPlan } from "../messages/jev-routing-hint.js";
import { messages } from "./messages.js";

export const jev_routing_jobs = pgTable("jev_routing_jobs", {
  room_id: text("room_id").notNull(),
  message_number: integer("message_number").notNull(),
  plan: jsonb("plan").$type<DeferredJevRoutingPlan>().notNull(),
  state: text("state").notNull().default("pending"),
  claim_token: text("claim_token"),
  available_at: timestamp("available_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull().default(sql`now() + interval '8 seconds'`),
  attempts: integer("attempts").notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.room_id, table.message_number] }),
  message_fk: foreignKey({ columns: [table.room_id, table.message_number], foreignColumns: [messages.room_id, messages.number] }).onDelete("cascade").onUpdate("cascade"),
  state_check: check("jev_routing_jobs_state_check", sql`${table.state} IN ('pending', 'processing', 'completed')`),
  frontier_idx: index("jev_routing_jobs_frontier_idx").on(table.room_id, table.message_number).where(sql`${table.state} <> 'completed' AND ${table.plan}->>'mode' = 'active'`),
  pending_idx: index("jev_routing_jobs_pending_idx").on(table.available_at).where(sql`${table.state} <> 'completed'`),
}));
