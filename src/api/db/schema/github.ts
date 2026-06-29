import { index, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { rooms } from "./core.js";

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
    default_branch: text("default_branch"),
    visibility: text("visibility").notNull().default("unknown"),
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

export const GITHUB_ROOM_EVENT_TYPES = [
  "pull_request",
  "issue",
  "issue_comment",
  "pull_request_review",
  "check_run",
  "installation",
  "installation_repositories",
  "repository",
  "push",
  "create",
  "delete",
] as const;

export type GitHubRoomEventType = (typeof GITHUB_ROOM_EVENT_TYPES)[number];

/**
 * Normalized GitHub room events.
 *
 * Each webhook delivery that produces a meaningful state change is normalized
 * here as one canonical, structured event. semantic_id is the delivery-independent
 * event identity used to suppress redelivery side effects; idempotency_key keeps
 * the provider delivery GUID for exact-delivery retries and diagnostics.
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
     * Delivery-scoped key derived from repo/object identity plus the
     * `X-GitHub-Delivery` GUID for the specific webhook instance.
     *
     * MUST include the repo full_name (or installation_id for installation events)
     * to avoid cross-repo collisions (PR/issue numbers are repo-local), and includes
     * the delivery GUID so exact delivery retries can be diagnosed separately from
     * semantic redeliveries.
     *
     * Examples:
     *   "brosincode/letagents:pr:42:opened:delivery:8f5d..."
     *   "brosincode/letagents:comment:12345:created:delivery:8f5d..."
     *   "brosincode/letagents:check_run:789:completed:delivery:8f5d..."
     *   "installation:98765:suspend:delivery:8f5d..."
     */
    idempotency_key: text("idempotency_key").notNull().unique(),
    /**
     * Semantic provider object/event identity without webhook-delivery scope. This
     * is the durable event key used to keep GitHub redeliveries from replaying
     * lifecycle and projection side effects.
     */
    semantic_id: text("semantic_id"),
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
    /** GitHub event/object timestamps used to order provider activity. */
    provider_event_at: timestamp("provider_event_at", { mode: "string", withTimezone: true }),
    provider_object_updated_at: timestamp("provider_object_updated_at", {
      mode: "string",
      withTimezone: true,
    }),
    /** Normalized order timestamp, populated from provider time or created_at. */
    event_order_at: timestamp("event_order_at", { mode: "string", withTimezone: true }).notNull(),
    /** Git ref metadata for branch and PR scoped routing. */
    ref: text("ref"),
    base_ref: text("base_ref"),
    head_ref: text("head_ref"),
    head_sha: text("head_sha"),
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
    order_idx: index("github_room_events_room_order_idx").on(
      table.room_id,
      table.event_order_at,
      table.id
    ),
    ref_idx: index("github_room_events_room_ref_idx").on(table.room_id, table.ref),
    head_ref_idx: index("github_room_events_room_head_ref_idx").on(table.room_id, table.head_ref),
    head_sha_idx: index("github_room_events_room_head_sha_idx").on(table.room_id, table.head_sha),
  })
);
