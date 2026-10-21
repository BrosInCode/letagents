import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
  grant_idx: index("agent_asks_grant_idx").on(table.grant_id).where(sql`${table.grant_id} IS NOT NULL`),
  live_idx: index("agent_asks_live_idx").on(table.state, table.updated_at).where(sql`${table.state} IN ('open', 'claimed', 'on_hold', 'active', 'paused')`),
  state_check: check("agent_asks_state_check", sql`${table.state} IN ('open', 'claimed', 'on_hold', 'active', 'paused', 'ended', 'expired', 'cancelled')`),
  amount_check: check("agent_asks_amount_check", sql`(${table.amount_percent} IS NULL OR ${table.amount_percent} BETWEEN 1 AND 100) AND (${table.given_amount_percent} IS NULL OR ${table.given_amount_percent} BETWEEN 1 AND 100)`),
}));

/** The LetAgents-held copy of the asker's repo that a given agent works on (D13). */
export const agent_ask_workspaces = pgTable("agent_ask_workspaces", {
  ask_id: text("ask_id").primaryKey().references(() => agent_asks.id, { onDelete: "cascade" }),
  repo_full_name: text("repo_full_name").notNull(),
  base_branch: text("base_branch").notNull(),
  base_sha: text("base_sha"),
  work_branch: text("work_branch").notNull(),
  pr_number: integer("pr_number"),
  pr_url: text("pr_url"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
});

/** What the given agent was shown: the asker's "Files seen" list (D44). */
export const agent_ask_reads = pgTable("agent_ask_reads", {
  id: text("id").primaryKey(),
  ask_id: text("ask_id").notNull().references(() => agent_asks.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  target: text("target").notNull(),
  blocked: boolean("blocked").notNull().default(false),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ask_idx: index("agent_ask_reads_ask_idx").on(table.ask_id, table.created_at),
  kind_check: check("agent_ask_reads_kind_check", sql`${table.kind} IN ('file', 'list', 'search')`),
}));

/** A change the given agent proposes; the asker approves it into a PR (D43). */
export const agent_ask_proposals = pgTable("agent_ask_proposals", {
  id: text("id").primaryKey(),
  ask_id: text("ask_id").notNull().references(() => agent_asks.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  files: jsonb("files").notNull(),
  state: text("state").notNull().default("waiting"),
  error: text("error"),
  pr_url: text("pr_url"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  decided_at: timestamp("decided_at", { mode: "string", withTimezone: true }),
}, (table) => ({
  ask_idx: index("agent_ask_proposals_ask_idx").on(table.ask_id, table.created_at),
  state_check: check("agent_ask_proposals_state_check", sql`${table.state} IN ('waiting', 'approved', 'declined', 'failed')`),
}));
