import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgEnum, pgTable, primaryKey, serial, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { TaskWorkflowArtifact } from "../repo-workflow.js";
import { AGENT_PRESENCE_STATUSES } from "../../shared/agent-presence.js";
import { ROOM_PARTICIPANT_KINDS } from "../../shared/room-participant.js";

export const participantRoleEnum = pgEnum("participant_role", ["participant", "admin"]);
export const roomParticipantKindEnum = pgEnum("room_participant_kind", ROOM_PARTICIPANT_KINDS);
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
export const agentPresenceStatusEnum = pgEnum("agent_presence_status", AGENT_PRESENCE_STATUSES);

export const id_sequences = pgTable("id_sequences", {
  name: text("name").primaryKey(),
  value: integer("value").notNull(),
});

export const rooms = pgTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    display_name: text("display_name").notNull(),
    kind: text("kind").notNull().default("main"),
    parent_room_id: text("parent_room_id").references((): AnyPgColumn => rooms.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    focus_key: text("focus_key"),
    source_task_id: text("source_task_id"),
    focus_status: text("focus_status"),
    concluded_at: timestamp("concluded_at", { mode: "string", withTimezone: true }),
    conclusion_summary: text("conclusion_summary"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    parent_idx: index("rooms_parent_room_id_idx").on(table.parent_room_id),
    parent_source_task_idx: index("rooms_parent_source_task_idx").on(
      table.parent_room_id,
      table.source_task_id
    ),
    parent_focus_key_idx: uniqueIndex("rooms_parent_focus_key_idx")
      .on(table.parent_room_id, table.focus_key)
      .where(sql`${table.kind} = 'focus'`),
    active_focus_task_idx: uniqueIndex("rooms_active_focus_task_idx")
      .on(table.parent_room_id, table.source_task_id)
      .where(sql`${table.kind} = 'focus' AND ${table.focus_status} = 'active'`),
    kind_check: check("rooms_kind_check", sql`${table.kind} IN ('main', 'focus')`),
    focus_status_check: check(
      "rooms_focus_status_check",
      sql`${table.focus_status} IS NULL OR ${table.focus_status} IN ('active', 'concluded')`
    ),
    focus_lineage_check: check(
      "rooms_focus_lineage_check",
      sql`(
        ${table.kind} = 'main'
        AND ${table.parent_room_id} IS NULL
        AND ${table.focus_key} IS NULL
        AND ${table.source_task_id} IS NULL
        AND ${table.focus_status} IS NULL
        AND ${table.concluded_at} IS NULL
        AND ${table.conclusion_summary} IS NULL
      ) OR (
        ${table.kind} = 'focus'
        AND ${table.parent_room_id} IS NOT NULL
        AND ${table.focus_key} IS NOT NULL
        AND ${table.source_task_id} IS NOT NULL
        AND ${table.focus_status} IS NOT NULL
      )`
    ),
  })
);

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

export const system_github_app = pgTable(
  "system_github_app",
  {
    id: serial("id").primaryKey(),
    app_id: text("app_id").notNull(),
    app_slug: text("app_slug").notNull(),
    client_id: text("client_id").notNull(),
    client_secret: text("client_secret").notNull(),
    private_key: text("private_key").notNull(),
    webhook_secret: text("webhook_secret").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).defaultNow().notNull(),
  }
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

export const room_agent_presence = pgTable(
  "room_agent_presence",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    actor_label: text("actor_label").notNull(),
    agent_key: text("agent_key"),
    display_name: text("display_name").notNull(),
    owner_label: text("owner_label"),
    ide_label: text("ide_label"),
    status: agentPresenceStatusEnum("status").notNull().default("idle"),
    status_text: text("status_text"),
    last_heartbeat_at: timestamp("last_heartbeat_at", { mode: "string", withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "room_agent_presence_pk", columns: [table.room_id, table.actor_label] }),
    room_idx: index("room_agent_presence_room_id_idx").on(table.room_id),
    room_status_idx: index("room_agent_presence_room_status_idx").on(table.room_id, table.status),
    room_heartbeat_idx: index("room_agent_presence_room_heartbeat_idx").on(
      table.room_id,
      table.last_heartbeat_at
    ),
    room_agent_key_idx: index("room_agent_presence_room_agent_key_idx").on(table.room_id, table.agent_key),
  })
);

export const room_participants = pgTable(
  "room_participants",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    participant_key: text("participant_key").notNull(),
    kind: roomParticipantKindEnum("kind").notNull(),
    actor_label: text("actor_label"),
    agent_key: text("agent_key"),
    github_login: text("github_login"),
    display_name: text("display_name").notNull(),
    owner_label: text("owner_label"),
    ide_label: text("ide_label"),
    last_seen_at: timestamp("last_seen_at", { mode: "string", withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "room_participants_pk", columns: [table.room_id, table.participant_key] }),
    room_idx: index("room_participants_room_id_idx").on(table.room_id),
    room_kind_idx: index("room_participants_room_kind_idx").on(table.room_id, table.kind),
    room_last_seen_idx: index("room_participants_room_last_seen_idx").on(table.room_id, table.last_seen_at),
    room_actor_idx: index("room_participants_room_actor_idx").on(table.room_id, table.actor_label),
    room_login_idx: index("room_participants_room_login_idx").on(table.room_id, table.github_login),
  })
);

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
    reply_to_number: integer("reply_to_number"),
    sender: text("sender").notNull(),
    text: text("text").notNull(),
    agent_prompt_kind: text("agent_prompt_kind"),
    source: text("source"),
    timestamp: timestamp("timestamp", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "messages_pk", columns: [table.room_id, table.number] }),
    room_idx: index("messages_room_id_idx").on(table.room_id),
    reply_to_idx: index("messages_reply_to_idx").on(table.room_id, table.reply_to_number),
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
    assignee_agent_key: text("assignee_agent_key"),
    created_by: text("created_by").notNull(),
    source_message_id: text("source_message_id"),
    pr_url: text("pr_url"),
    workflow_artifacts: jsonb("workflow_artifacts")
      .$type<TaskWorkflowArtifact[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "tasks_pk", columns: [table.room_id, table.number] }),
    room_idx: index("tasks_room_id_idx").on(table.room_id),
    status_idx: index("tasks_status_idx").on(table.status),
    room_assignee_key_idx: index("tasks_room_assignee_agent_key_idx").on(
      table.room_id,
      table.assignee_agent_key
    ),
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

/**
 * Canonical event type vocabulary for github_room_events.
 *
 * Both the persistence layer (task_51) and the materialization layer (task_52)
 * MUST use these values as event_type. Do not use GitHub-native webhook names
 * (e.g. use "pull_request_review" not "review", "issue_comment" not "comment").
 */
export const GITHUB_ROOM_EVENT_TYPES = [
  "pull_request",
  "issue",
  "issue_comment",
  "pull_request_review",
  "check_run",
  "installation",
  "installation_repositories",
  "repository",
] as const;

export type GitHubRoomEventType = (typeof GITHUB_ROOM_EVENT_TYPES)[number];

/**
 * Normalized GitHub room events.
 *
 * Each webhook delivery that produces a meaningful state change is recorded
 * here as one canonical, structured event. The idempotency_key ensures
 * duplicate deliveries never produce duplicate events.
 *
 * Agents and the API query this table instead of parsing room message text.
 *
 * room_id is nullable because some events (installation, installation_repositories)
 * are scoped to an installation, not a specific room/repository.
 */
export interface GitHubRoomEventMetadata {
  /** PR body, review body, comment body, check conclusion, labels, etc. */
  [key: string]: unknown;
}

export const github_room_events = pgTable(
  "github_room_events",
  {
    id: text("id").primaryKey(),
    /** Nullable: installation-scoped events may not map to a room yet */
    room_id: text("room_id")
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    delivery_id: text("delivery_id")
      .references(() => github_webhook_deliveries.delivery_id, {
        onDelete: "set null",
      }),
    /** Must be one of GITHUB_ROOM_EVENT_TYPES */
    event_type: text("event_type").notNull(),
    /** GitHub action: opened, closed, completed, created, etc. */
    action: text("action").notNull(),
    /**
     * Delivery-scoped dedup key derived from repo/object identity plus the
     * `X-GitHub-Delivery` GUID for the specific webhook instance.
     *
     * MUST include the repo full_name (or installation_id for installation events)
     * to avoid cross-repo collisions (PR/issue numbers are repo-local), and MUST
     * include the delivery GUID so repeated real transitions do not collapse while
     * GitHub redeliveries still reuse the same key.
     *
     * Examples:
     *   "brosincode/letagents:pr:42:opened:delivery:8f5d..."
     *   "brosincode/letagents:comment:12345:created:delivery:8f5d..."
     *   "brosincode/letagents:check_run:789:completed:delivery:8f5d..."
     *   "installation:98765:suspend:delivery:8f5d..."
     */
    idempotency_key: text("idempotency_key").notNull().unique(),
    /** Parent GitHub object ID for queryability (PR number, issue number, etc.) */
    github_object_id: text("github_object_id"),
    /** html_url of the GitHub object */
    github_object_url: text("github_object_url"),
    /** PR/issue title or check name */
    title: text("title"),
    /** Current state: open, closed, merged, success, failure, etc. */
    state: text("state"),
    /** GitHub login of the actor who triggered the event */
    actor_login: text("actor_login"),
    /** Structured payload excerpt for richer queries */
    metadata: jsonb("metadata").$type<GitHubRoomEventMetadata>(),
    /** Linked task board task, if one was resolved */
    linked_task_id: text("linked_task_id"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_idx: index("github_room_events_room_id_idx").on(table.room_id),
    event_type_idx: index("github_room_events_event_type_idx").on(
      table.room_id,
      table.event_type
    ),
    object_idx: index("github_room_events_object_idx").on(
      table.room_id,
      table.event_type,
      table.github_object_id
    ),
    delivery_idx: index("github_room_events_delivery_id_idx").on(table.delivery_id),
  })
);
