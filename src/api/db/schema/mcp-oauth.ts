import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { accounts } from "./core.js";

/**
 * OAuth 2.1 for the remote MCP endpoint (migration 0125). Every secret here
 * (client secrets, consent tokens, codes, grant secrets, access and refresh
 * tokens) is stored only as its SHA-256 hex.
 */

/** Clients registered through dynamic client registration (RFC 7591). */
export const mcp_oauth_clients = pgTable(
  "mcp_oauth_clients",
  {
    client_id: text("client_id").primaryKey(),
    client_name: text("client_name"),
    redirect_uris: jsonb("redirect_uris").$type<string[]>().notNull(),
    token_endpoint_auth_method: text("token_endpoint_auth_method").notNull(),
    client_secret_hash: text("client_secret_hash"),
    application_type: text("application_type").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    /** First set when a person approves the client; unused clients are deleted after a day. */
    last_used_at: timestamp("last_used_at", { mode: "string", withTimezone: true }),
  },
  (table) => [
    index("mcp_oauth_clients_unused_idx").on(table.created_at).where(sql`${table.last_used_at} IS NULL`),
  ],
);

/** One person's approval of one client: the unit that settings list and revoke. */
export const mcp_oauth_grants = pgTable(
  "mcp_oauth_grants",
  {
    grant_id: text("grant_id").primaryKey(),
    account_id: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    client_id: text("client_id").notNull().references(() => mcp_oauth_clients.client_id, { onDelete: "cascade" }),
    /** SHA-256 of the grant secret that every token of the grant carries; remote MCP sessions bind to it. */
    secret_hash: text("secret_hash").notNull(),
    resource: text("resource").notNull(),
    scope: text("scope").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    last_used_at: timestamp("last_used_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    /** When the newest refresh token expires; the grant is unusable after it. */
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { mode: "string", withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mcp_oauth_grants_secret_idx").on(table.secret_hash),
    index("mcp_oauth_grants_account_idx").on(table.account_id, table.created_at),
    index("mcp_oauth_grants_client_idx").on(table.client_id),
  ],
);

export const mcp_oauth_tokens = pgTable(
  "mcp_oauth_tokens",
  {
    token_hash: text("token_hash").primaryKey(),
    grant_id: text("grant_id").notNull().references(() => mcp_oauth_grants.grant_id, { onDelete: "cascade" }),
    kind: text("kind").$type<"access" | "refresh">().notNull(),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    /** Set when a refresh token is exchanged; a second use revokes the grant. */
    used_at: timestamp("used_at", { mode: "string", withTimezone: true }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("mcp_oauth_tokens_grant_idx").on(table.grant_id),
    index("mcp_oauth_tokens_expires_idx").on(table.expires_at),
    check("mcp_oauth_tokens_kind_check", sql`${table.kind} IN ('access', 'refresh')`),
  ],
);

/** An authorization request from consent page to code exchange. */
export const mcp_oauth_authorizations = pgTable(
  "mcp_oauth_authorizations",
  {
    authorization_id: text("authorization_id").primaryKey(),
    consent_hash: text("consent_hash").notNull(),
    code_hash: text("code_hash"),
    account_id: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    client_id: text("client_id").notNull().references(() => mcp_oauth_clients.client_id, { onDelete: "cascade" }),
    redirect_uri: text("redirect_uri").notNull(),
    code_challenge: text("code_challenge").notNull(),
    resource: text("resource").notNull(),
    scope: text("scope").notNull(),
    state: text("state"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    decided_at: timestamp("decided_at", { mode: "string", withTimezone: true }),
    consumed_at: timestamp("consumed_at", { mode: "string", withTimezone: true }),
    grant_id: text("grant_id"),
  },
  (table) => [
    uniqueIndex("mcp_oauth_authorizations_consent_idx").on(table.consent_hash),
    uniqueIndex("mcp_oauth_authorizations_code_idx").on(table.code_hash),
    index("mcp_oauth_authorizations_expires_idx").on(table.expires_at),
  ],
);
