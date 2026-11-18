import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { JobState } from "../../../../shared/api/jobs.mjs";
import { rooms } from "./core.js";

/**
 * Structured work handed to one agent through the LetAgents API. The actor
 * chain is stored flat (principal, then what it acted through). A job that
 * reached an agent points at the thread root it posted; `no_agent` jobs have
 * none.
 */
export const api_jobs = pgTable("api_jobs", {
  id: text("id").primaryKey(),
  room_id: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  principal_kind: text("principal_kind").$type<"person" | "agent">().notNull(),
  principal_id: text("principal_id").notNull(),
  via_kind: text("via_kind").$type<"page" | "job" | "integration">(),
  via_id: text("via_id"),
  via_version: integer("via_version"),
  target_agent_key: text("target_agent_key"),
  instruction: text("instruction").notNull(),
  input: jsonb("input").$type<unknown>(),
  result_schema: jsonb("result_schema").$type<Record<string, unknown>>(),
  state: text("state").$type<JobState>().notNull(),
  progress: text("progress"),
  result: jsonb("result").$type<unknown>(),
  error: text("error"),
  root_message_number: integer("root_message_number"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  finished_at: timestamp("finished_at", { mode: "string", withTimezone: true }),
}, (table) => [
  index("api_jobs_room_created_idx").on(table.room_id, table.created_at.desc()),
  index("api_jobs_room_state_idx").on(table.room_id, table.state, table.created_at.desc()),
  check("api_jobs_state_check", sql`${table.state} IN ('queued', 'no_agent', 'running', 'needs_input', 'done', 'failed', 'cancelled')`),
  check("api_jobs_principal_kind_check", sql`${table.principal_kind} IN ('person', 'agent')`),
  check("api_jobs_via_kind_check", sql`${table.via_kind} IS NULL OR ${table.via_kind} IN ('page', 'job', 'integration')`),
]);

export type ApiJobRow = typeof api_jobs.$inferSelect;
