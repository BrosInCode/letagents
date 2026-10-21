import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { accounts, rooms } from "./core.js";

/** One account's authorised link to one tracker site or workspace. */
export const tracker_connections = pgTable(
  "tracker_connections",
  {
    id: text("id").primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade", onUpdate: "cascade" }),
    provider: text("provider").notNull(),
    display_name: text("display_name").notNull(),
    /** The tracker site (Jira host) or workspace (Linear organization id). */
    site_key: text("site_key").notNull(),
    /** Display only. Requests use the site in the encrypted credentials. */
    site_url: text("site_url"),
    auth_kind: text("auth_kind").notNull(),
    credentials_ciphertext: text("credentials_ciphertext").notNull(),
    credentials_iv: text("credentials_iv").notNull(),
    credentials_version: integer("credentials_version").notNull().default(1),
    tracker_user_id: text("tracker_user_id"),
    tracker_user_label: text("tracker_user_label"),
    status_map: jsonb("status_map").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    unmapped_statuses: jsonb("unmapped_statuses").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    jev_linking_enabled: boolean("jev_linking_enabled").notNull().default(false),
    status: text("status").notNull().default("active"),
    last_error: text("last_error"),
    last_verified_at: timestamp("last_verified_at", { mode: "string", withTimezone: true }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    account_site_unique: uniqueIndex("tracker_connections_account_site_uq")
      .on(table.account_id, table.provider, table.site_key),
    provider_check: check("tracker_connections_provider_check", sql`${table.provider} IN ('jira', 'linear')`),
    auth_kind_check: check("tracker_connections_auth_kind_check", sql`${table.auth_kind} IN ('oauth', 'api_token')`),
    status_check: check("tracker_connections_status_check", sql`${table.status} IN ('active', 'needs_reauth', 'error')`),
  }),
);

/** One ticket cached from a tracker. Written by sync (PR3). */
export const external_items = pgTable(
  "external_items",
  {
    id: text("id").primaryKey(),
    connection_id: text("connection_id")
      .notNull()
      .references(() => tracker_connections.id, { onDelete: "cascade", onUpdate: "cascade" }),
    provider: text("provider").notNull(),
    key: text("key").notNull(),
    title: text("title").notNull(),
    ticket_state: text("ticket_state").notNull(),
    raw_status: text("raw_status").notNull(),
    assignee_id: text("assignee_id"),
    assignee_label: text("assignee_label"),
    url: text("url"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    tracker_updated_at: timestamp("tracker_updated_at", { mode: "string", withTimezone: true }),
    synced_at: timestamp("synced_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    connection_key_unique: uniqueIndex("external_items_connection_key_uq").on(table.connection_id, table.key),
    connection_assignee_idx: index("external_items_connection_assignee_idx").on(table.connection_id, table.assignee_id),
    provider_check: check("external_items_provider_check", sql`${table.provider} IN ('jira', 'linear')`),
    ticket_state_check: check(
      "external_items_ticket_state_check",
      sql`${table.ticket_state} IN ('todo', 'in_progress', 'in_review', 'done')`,
    ),
  }),
);

/**
 * Single-use OAuth `state` values, stored only as a SHA-256 hash. The callback
 * forwards the code to the starting app's loopback port; only that app, signed
 * in as `account_id`, can finish the connection.
 */
export const tracker_oauth_states = pgTable(
  "tracker_oauth_states",
  {
    state_hash: text("state_hash").primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade", onUpdate: "cascade" }),
    provider: text("provider").notNull(),
    loopback_port: integer("loopback_port").notNull(),
    /** PKCE verifier (Linear). Single use, and useless without the code and the client secret. */
    code_verifier: text("code_verifier"),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expires_idx: index("tracker_oauth_states_expires_idx").on(table.expires_at),
    provider_check: check("tracker_oauth_states_provider_check", sql`${table.provider} IN ('jira', 'linear')`),
    loopback_port_check: check("tracker_oauth_states_loopback_port_check", sql`${table.loopback_port} BETWEEN 1024 AND 65535`),
  }),
);

/**
 * Per room, per connection: which tickets to import (JQL for Jira, team or
 * project for Linear). Sync (PR3) polls each enabled filter; a room with no
 * filter runs no sync.
 */
export const room_tracker_filters = pgTable(
  "room_tracker_filters",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    connection_id: text("connection_id")
      .notNull()
      .references(() => tracker_connections.id, { onDelete: "cascade", onUpdate: "cascade" }),
    /** The connection's tracker. One connection per tracker in a room: cards match by `provider:KEY`. */
    provider: text("provider").notNull(),
    filter: text("filter").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** The connection's owner: only they may point a room at their tracker. */
    created_by_account_id: text("created_by_account_id").notNull(),
    /** When the last successful poll started; the next poll asks for changes since then. */
    last_synced_at: timestamp("last_synced_at", { mode: "string", withTimezone: true }),
    /** A process claims a poll by setting this. A claim not finished in time expires. */
    sync_claimed_at: timestamp("sync_claimed_at", { mode: "string", withTimezone: true }),
    /** When the poll under the current claim finished; a running poll is never claimed again. */
    sync_finished_at: timestamp("sync_finished_at", { mode: "string", withTimezone: true }),
    /** A webhook asks for an early poll by setting this. */
    sync_requested_at: timestamp("sync_requested_at", { mode: "string", withTimezone: true }),
    /** Polls failed in a row; the next poll waits until `backoff_until`. */
    failure_count: integer("failure_count").notNull().default(0),
    backoff_until: timestamp("backoff_until", { mode: "string", withTimezone: true }),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    room_connection_unique: uniqueIndex("room_tracker_filters_room_connection_uq").on(table.room_id, table.connection_id),
    room_provider_unique: uniqueIndex("room_tracker_filters_room_provider_uq").on(table.room_id, table.provider),
    provider_check: check("room_tracker_filters_provider_check", sql`${table.provider} IN ('jira', 'linear')`),
    connection_idx: index("room_tracker_filters_connection_idx").on(table.connection_id),
    enabled_idx: index("room_tracker_filters_enabled_idx").on(table.sync_claimed_at).where(sql`${table.enabled}`),
  }),
);

/**
 * Per connection: a repo event trigger and the tracker actions it causes
 * (ticket connectors PR5). `room_id` null applies to every room that imports
 * tickets with the connection. A rule is an approval given in advance by the
 * connection's owner; every write still goes through `workflow_effects`.
 */
export const tracker_rules = pgTable(
  "tracker_rules",
  {
    id: text("id").primaryKey(),
    connection_id: text("connection_id")
      .notNull()
      .references(() => tracker_connections.id, { onDelete: "cascade", onUpdate: "cascade" }),
    room_id: text("room_id")
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    actions: jsonb("actions").$type<Array<Record<string, unknown>>>().notNull(),
    version: integer("version").notNull().default(1),
    /** The account that wrote the rule: always the connection's owner. */
    created_by: text("created_by").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    connection_idx: index("tracker_rules_connection_idx").on(table.connection_id, table.created_at),
    version_check: check("tracker_rules_version_check", sql`${table.version} >= 1`),
  }),
);

/** Every saved version of a rule, for history and rollback. */
export const tracker_rule_versions = pgTable(
  "tracker_rule_versions",
  {
    id: text("id").primaryKey(),
    rule_id: text("rule_id")
      .notNull()
      .references(() => tracker_rules.id, { onDelete: "cascade", onUpdate: "cascade" }),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    room_id: text("room_id"),
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    actions: jsonb("actions").$type<Array<Record<string, unknown>>>().notNull(),
    created_by: text("created_by").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    rule_version_unique: uniqueIndex("tracker_rule_versions_rule_version_uq").on(table.rule_id, table.version),
  }),
);

/**
 * One row per rule that matched one repo event: the audit shown in the board
 * governance section. Unique per rule and delivery, so a rule that applies to
 * several rooms writes once per event, and a redelivery reserves nothing new.
 */
export const tracker_rule_runs = pgTable(
  "tracker_rule_runs",
  {
    id: text("id").primaryKey(),
    rule_id: text("rule_id").references(() => tracker_rules.id, { onDelete: "set null", onUpdate: "cascade" }),
    rule_version: integer("rule_version").notNull(),
    rule_name: text("rule_name").notNull(),
    connection_id: text("connection_id").notNull(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    task_id: text("task_id").notNull(),
    external_ref: text("external_ref").notNull(),
    delivery_id: text("delivery_id").notNull(),
    event_type: text("event_type").notNull(),
    event_action: text("event_action").notNull(),
    event_url: text("event_url"),
    /** The rendered tracker writes, so a retry of the same delivery submits the same requests. */
    planned_actions: jsonb("planned_actions").$type<Array<Record<string, unknown>>>().notNull(),
    effect_ids: jsonb("effect_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    outcome: text("outcome").notNull().default("pending"),
    detail: text("detail"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    rule_delivery_unique: uniqueIndex("tracker_rule_runs_rule_delivery_uq").on(table.rule_id, table.delivery_id),
    room_created_idx: index("tracker_rule_runs_room_created_idx").on(table.room_id, table.created_at),
    debounce_idx: index("tracker_rule_runs_debounce_idx").on(table.rule_id, table.external_ref, table.created_at),
    outcome_check: check(
      "tracker_rule_runs_outcome_check",
      sql`${table.outcome} IN ('pending', 'succeeded', 'failed', 'quarantined', 'error')`,
    ),
  }),
);
