import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { accounts } from "./core.js";

/** "Ask for an agent": a one-use link asking someone to add an agent to a room. */
export const agent_asks = pgTable("agent_asks", {
  id: text("id").primaryKey(),
  link_token_hash: text("link_token_hash").notNull(),
  room_id: text("room_id").notNull(),
  asker_account_id: text("asker_account_id").notNull().references(() => accounts.id, { onDelete: "cascade", onUpdate: "cascade" }),
  provider_id: text("provider_id").notNull(),
  model: text("model"),
  model_label: text("model_label").notNull(),
  amount_percent: integer("amount_percent"),
  note: text("note").notNull().default(""),
  state: text("state").notNull().default("open"),
  expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
  giver_account_id: text("giver_account_id").references(() => accounts.id, { onDelete: "set null", onUpdate: "cascade" }),
  claim_expires_at: timestamp("claim_expires_at", { mode: "string", withTimezone: true }),
  given_provider_id: text("given_provider_id"),
  given_model: text("given_model"),
  given_model_label: text("given_model_label"),
  given_amount_percent: integer("given_amount_percent"),
  agent_key: text("agent_key"),
  grant_id: text("grant_id"),
  room_agent_session_id: text("room_agent_session_id"),
  paused_at: timestamp("paused_at", { mode: "string", withTimezone: true }),
  hold_expires_at: timestamp("hold_expires_at", { mode: "string", withTimezone: true }),
  ended_reason: text("ended_reason"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  ended_at: timestamp("ended_at", { mode: "string", withTimezone: true }),
}, (table) => ({
  token_uq: uniqueIndex("agent_asks_link_token_hash_uq").on(table.link_token_hash),
  room_idx: index("agent_asks_room_idx").on(table.room_id, table.created_at),
  asker_open_idx: index("agent_asks_asker_open_idx").on(table.asker_account_id).where(sql`${table.state} IN ('open', 'claimed')`),
  giver_idx: index("agent_asks_giver_idx").on(table.giver_account_id).where(sql`${table.state} IN ('claimed', 'on_hold', 'active', 'paused')`),
  live_idx: index("agent_asks_live_idx").on(table.state, table.updated_at).where(sql`${table.state} IN ('open', 'claimed', 'on_hold', 'active', 'paused')`),
  state_check: check("agent_asks_state_check", sql`${table.state} IN ('open', 'claimed', 'on_hold', 'active', 'paused', 'ended', 'expired', 'cancelled')`),
  amount_check: check("agent_asks_amount_check", sql`(${table.amount_percent} IS NULL OR ${table.amount_percent} BETWEEN 1 AND 100) AND (${table.given_amount_percent} IS NULL OR ${table.given_amount_percent} BETWEEN 1 AND 100)`),
}));
