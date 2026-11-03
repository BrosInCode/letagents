import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { accounts } from "./core.js";

/** Remote MCP sessions served by the API's /mcp endpoint (migration 0119). */
export const remote_mcp_sessions = pgTable(
  "remote_mcp_sessions",
  {
    session_id: text("session_id").primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the owner token that opened the session. */
    token_hash: text("token_hash").notNull(),
    agent_instance_id: text("agent_instance_id").notNull(),
    client_name: text("client_name"),
    room_id: text("room_id"),
    worker_session_id: text("worker_session_id"),
    read_cursor: text("read_cursor"),
    state: jsonb("state").$type<Record<string, unknown>>().notNull(),
    version: integer("version").notNull().default(1),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp("last_seen_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    /** The credential's one session for requests sent without a session id (migration 0129). */
    implicit: boolean("implicit").notNull().default(false),
  },
  (table) => [
    index("remote_mcp_sessions_account_idx").on(table.account_id, table.last_seen_at),
    index("remote_mcp_sessions_token_idx").on(table.token_hash),
    index("remote_mcp_sessions_last_seen_idx").on(table.last_seen_at),
    uniqueIndex("remote_mcp_sessions_implicit_token_idx").on(table.token_hash).where(sql`${table.implicit}`),
  ],
);

/**
 * Remote MCP credential state (migration 0129): the merged runtime state of
 * every session one credential (owner token or OAuth grant) opened. A new
 * session starts from it, so a client that opens a session per call keeps its
 * worker handles, rooms and cursors. Sealed like a session's state.
 */
export const remote_mcp_credentials = pgTable(
  "remote_mcp_credentials",
  {
    /** SHA-256 hex of the owner token or OAuth grant secret. */
    token_hash: text("token_hash").primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    state: jsonb("state").$type<Record<string, unknown>>().notNull(),
    version: integer("version").notNull().default(1),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("remote_mcp_credentials_account_idx").on(table.account_id)],
);
