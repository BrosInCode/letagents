import { sql } from "drizzle-orm";
import { check, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const participantRoleEnum = pgEnum("participant_role", ["participant", "admin"]);
export const taskStatusEnum = pgEnum("task_status", [
  "proposed",
  "accepted",
  "assigned",
  "in_progress",
  "blocked",
  "in_review",
  "merged",
  "done",
  "cancelled",
]);

export const id_sequences = pgTable("id_sequences", {
  name: text("name").primaryKey(),
  value: integer("value").notNull(),
});

export const rooms = pgTable("rooms", {
  id: text("id").primaryKey(),
  display_name: text("display_name").notNull(),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
});

export const room_aliases = pgTable(
  "room_aliases",
  {
    alias: text("alias").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_idx: index("room_aliases_room_id_idx").on(table.room_id),
  })
);

export const github_repositories = pgTable(
  "github_repositories",
  {
    github_repo_id: text("github_repo_id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    owner_login: text("owner_login").notNull(),
    repo_name: text("repo_name").notNull(),
    full_name: text("full_name").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_idx: uniqueIndex("github_repositories_room_id_idx").on(table.room_id),
    full_name_idx: uniqueIndex("github_repositories_full_name_idx").on(table.full_name),
  })
);

export const github_app_installations = pgTable(
  "github_app_installations",
  {
    installation_id: text("installation_id").primaryKey(),
    target_type: text("target_type").notNull(),
    target_login: text("target_login").notNull(),
    target_github_id: text("target_github_id").notNull(),
    repository_selection: text("repository_selection").notNull(),
    permissions_json: text("permissions_json"),
    suspended_at: timestamp("suspended_at", { mode: "string", withTimezone: true }),
    uninstalled_at: timestamp("uninstalled_at", { mode: "string", withTimezone: true }),
    last_synced_at: timestamp("last_synced_at", { mode: "string", withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    target_login_idx: index("github_app_installations_target_login_idx").on(table.target_login),
    target_id_idx: index("github_app_installations_target_github_id_idx").on(table.target_github_id),
  })
);

export const github_app_repositories = pgTable(
  "github_app_repositories",
  {
    github_repo_id: text("github_repo_id").primaryKey(),
    installation_id: text("installation_id")
      .notNull()
      .references(() => github_app_installations.installation_id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    owner_login: text("owner_login").notNull(),
    repo_name: text("repo_name").notNull(),
    full_name: text("full_name").notNull(),
    room_id: text("room_id").notNull(),
    removed_at: timestamp("removed_at", { mode: "string", withTimezone: true }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    installation_idx: index("github_app_repositories_installation_id_idx").on(table.installation_id),
    full_name_idx: uniqueIndex("github_app_repositories_full_name_idx").on(table.full_name),
    room_idx: index("github_app_repositories_room_id_idx").on(table.room_id),
  })
);

export const github_webhook_deliveries = pgTable(
  "github_webhook_deliveries",
  {
    delivery_id: text("delivery_id").primaryKey(),
    event_name: text("event_name").notNull(),
    action: text("action"),
    installation_id: text("installation_id"),
    github_repo_id: text("github_repo_id"),
    room_id: text("room_id"),
    status: text("status").notNull(),
    error: text("error"),
    received_at: timestamp("received_at", { mode: "string", withTimezone: true }).notNull(),
    processed_at: timestamp("processed_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    event_idx: index("github_webhook_deliveries_event_name_idx").on(table.event_name),
    installation_idx: index("github_webhook_deliveries_installation_id_idx").on(table.installation_id),
    room_idx: index("github_webhook_deliveries_room_id_idx").on(table.room_id),
  })
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    provider_user_id: text("provider_user_id").notNull(),
    login: text("login").notNull(),
    display_name: text("display_name"),
    avatar_url: text("avatar_url"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    provider_user_idx: uniqueIndex("accounts_provider_user_idx").on(table.provider, table.provider_user_id),
    login_idx: index("accounts_login_idx").on(table.login),
  })
);

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

export const participants = pgTable(
  "participants",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    github_id: text("github_id"),
    github_login: text("github_login"),
    display_name: text("display_name").notNull(),
    role: participantRoleEnum("role").notNull().default("participant"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_idx: index("participants_room_id_idx").on(table.room_id),
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

export const project_admins = pgTable(
  "project_admins",
  {
    project_id: text("project_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    assigned_at: timestamp("assigned_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "project_admins_pk", columns: [table.project_id, table.account_id] }),
    account_idx: index("project_admins_account_id_idx").on(table.account_id),
  })
);

export const messages = pgTable(
  "messages",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    number: integer("number").notNull(),
    sender: text("sender").notNull(),
    text: text("text").notNull(),
    agent_prompt_kind: text("agent_prompt_kind"),
    source: text("source"),
    timestamp: timestamp("timestamp", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "messages_pk", columns: [table.room_id, table.number] }),
    room_idx: index("messages_room_id_idx").on(table.room_id),
    auto_prompt_idx: index("messages_auto_prompt_idx")
      .on(table.room_id, table.sender)
      .where(sql`${table.agent_prompt_kind} = 'auto'`),
    prompt_kind_check: check(
      "messages_agent_prompt_kind_check",
      sql`${table.agent_prompt_kind} IS NULL OR ${table.agent_prompt_kind} IN ('join', 'inline', 'auto')`
    ),
  })
);

export const tasks = pgTable(
  "tasks",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatusEnum("status").notNull().default("proposed"),
    assignee: text("assignee"),
    created_by: text("created_by").notNull(),
    source_message_id: text("source_message_id"),
    pr_url: text("pr_url"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "tasks_pk", columns: [table.room_id, table.number] }),
    room_idx: index("tasks_room_id_idx").on(table.room_id),
    status_idx: index("tasks_status_idx").on(table.status),
  })
);

export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    code: text("code").notNull().unique(),
    created_by: text("created_by"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    room_idx: index("invites_room_id_idx").on(table.room_id),
  })
);
