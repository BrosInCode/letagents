import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { accounts, rooms } from "./core.js";
import { workflow_effects } from "./effects.js";

/**
 * LetAgents API intents (migration 0154): a proposed write, its actor chain,
 * the room policy's answer and what running it did. `payload_fingerprint`
 * is a hash of the kind's payload, so one proposer has at most one pending
 * intent per change while two proposers each get their own.
 */
export const api_intents = pgTable(
  "api_intents",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payload_fingerprint: text("payload_fingerprint").notNull(),
    principal_kind: text("principal_kind").notNull(),
    principal_id: text("principal_id").notNull(),
    principal_login: text("principal_login"),
    via_kind: text("via_kind"),
    via_id: text("via_id"),
    via_version: integer("via_version"),
    state: text("state").notNull(),
    decided_by: text("decided_by").references(() => accounts.id, { onDelete: "set null" }),
    decided_at: timestamp("decided_at", { mode: "string", withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    effect_id: text("effect_id").references(() => workflow_effects.id, { onDelete: "set null" }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("api_intents_room_created_idx").on(table.room_id, table.created_at),
    uniqueIndex("api_intents_pending_uq")
      .on(table.room_id, table.kind, table.payload_fingerprint, table.principal_kind, table.principal_id)
      .where(sql`${table.state} = 'pending_approval'`),
    check("api_intents_kind_check", sql`${table.kind} IN ('task.create', 'task.update', 'ticket.transition', 'ticket.comment')`),
    check("api_intents_state_check", sql`${table.state} IN ('pending_approval', 'approved', 'running', 'done', 'failed', 'denied')`),
    check("api_intents_principal_kind_check", sql`${table.principal_kind} IN ('person', 'agent')`),
    check("api_intents_via_kind_check", sql`${table.via_kind} IS NULL OR ${table.via_kind} IN ('page', 'job', 'integration')`),
    check("api_intents_payload_check", sql`jsonb_typeof(${table.payload}) = 'object'`),
  ],
);

export type ApiIntentRow = typeof api_intents.$inferSelect;
