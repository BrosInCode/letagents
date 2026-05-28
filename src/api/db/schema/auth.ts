import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { accounts } from "./core.js";

export const auth_states = pgTable("auth_states", {
  id: text("id").primaryKey(),
  state: text("state").notNull().unique(),
  redirect_to: text("redirect_to"),
  expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
});

export const auth_sessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull().unique(),
    provider_access_token: text("provider_access_token"),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    account_idx: index("auth_sessions_account_id_idx").on(table.account_id),
  })
);

export const owner_tokens = pgTable(
  "owner_tokens",
  {
    token_id: text("token_id").primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    github_user_id: text("github_user_id").notNull(),
    token_hash: text("token_hash").notNull().unique(),
    provider_access_token: text("provider_access_token"),
    oauth_token_expires_at: timestamp("oauth_token_expires_at", {
      mode: "string",
      withTimezone: true,
    }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    account_idx: index("owner_tokens_account_id_idx").on(table.account_id),
    github_user_idx: index("owner_tokens_github_user_id_idx").on(table.github_user_id),
    token_hash_idx: uniqueIndex("owner_tokens_token_hash_idx").on(table.token_hash),
  })
);

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  canonical_key: text("canonical_key").notNull().unique(),
  name: text("name").notNull(),
  display_name: text("display_name").notNull(),
  owner_account_id: text("owner_account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  owner_login: text("owner_login").notNull(),
  owner_label: text("owner_label").notNull(),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
}, (table) => ({
  canonical_idx: uniqueIndex("agents_canonical_key_idx").on(table.canonical_key),
  owner_name_idx: uniqueIndex("agents_owner_name_idx").on(table.owner_account_id, table.name),
  owner_idx: index("agents_owner_account_id_idx").on(table.owner_account_id),
}));
