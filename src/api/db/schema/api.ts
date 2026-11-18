import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { auth_sessions } from "./auth.js";
import { accounts, rooms } from "./core.js";

/**
 * The LetAgents API actor chain (migration 0151).
 *
 * `page_grant` bearer tokens: one page version, one room, one person, a few
 * capabilities, 15 minutes. Only the token's SHA-256 hex is stored.
 * `page_id`/`page_version` have no foreign key until the pages registry exists.
 */
export const api_page_tokens = pgTable(
  "api_page_tokens",
  {
    token_id: text("token_id").primaryKey(),
    token_hash: text("token_hash").notNull(),
    account_id: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    /** The app session that minted it; signing out of that session ends it. */
    session_id: text("session_id").notNull().references(() => auth_sessions.id, { onDelete: "cascade" }),
    room_id: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    page_id: text("page_id").notNull(),
    page_version: integer("page_version").notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { mode: "string", withTimezone: true }),
  },
  (table) => [
    uniqueIndex("api_page_tokens_token_hash_idx").on(table.token_hash),
    index("api_page_tokens_account_idx").on(table.account_id, table.expires_at),
    index("api_page_tokens_room_page_idx").on(table.room_id, table.page_id),
    index("api_page_tokens_session_idx").on(table.session_id),
    check("api_page_tokens_page_version_check", sql`${table.page_version} > 0`),
    check("api_page_tokens_capabilities_check", sql`jsonb_typeof(${table.capabilities}) = 'array'`),
  ],
);

/** A room admin's API policy for one capability; no row means the registry default. */
export const room_api_policies = pgTable(
  "room_api_policies",
  {
    room_id: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    capability: text("capability").notNull(),
    mode: text("mode").notNull(),
    updated_by: text("updated_by").references(() => accounts.id, { onDelete: "set null" }),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "room_api_policies_pkey", columns: [table.room_id, table.capability] }),
    check("room_api_policies_mode_check", sql`${table.mode} IN ('allow', 'confirm', 'approve', 'deny')`),
  ],
);

/** Append-only: every API write, intent and job, with who made it and through what. */
export const api_actions = pgTable(
  "api_actions",
  {
    action_id: text("action_id").primaryKey(),
    room_id: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    principal_kind: text("principal_kind").notNull(),
    principal_id: text("principal_id").notNull(),
    via_kind: text("via_kind"),
    via_id: text("via_id"),
    via_version: integer("via_version"),
    method: text("method").notNull(),
    capability: text("capability").notNull(),
    target: text("target"),
    outcome: text("outcome").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("api_actions_room_created_idx").on(table.room_id, table.created_at),
    check("api_actions_principal_kind_check", sql`${table.principal_kind} IN ('person', 'agent')`),
    check("api_actions_via_kind_check", sql`${table.via_kind} IS NULL OR ${table.via_kind} IN ('page', 'job', 'integration')`),
  ],
);
