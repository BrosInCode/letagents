import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { rooms } from "./core.js";

export const GIT_ROOM_PROVIDERS = ["github"] as const;
export const GIT_ROOM_REF_TYPES = ["default_branch", "branch", "tag", "pull_request"] as const;
export const GIT_ROOM_VISIBILITIES = ["public", "private", "unknown"] as const;
export const GIT_ROOM_BINDING_SOURCES = ["github_repository", "webhook", "manual"] as const;

export type GitRoomProvider = (typeof GIT_ROOM_PROVIDERS)[number];
export type GitRoomRefType = (typeof GIT_ROOM_REF_TYPES)[number];
export type GitRoomVisibility = (typeof GIT_ROOM_VISIBILITIES)[number];
export type GitRoomBindingSource = (typeof GIT_ROOM_BINDING_SOURCES)[number];

export const room_git_bindings = pgTable(
  "room_git_bindings",
  {
    room_id: text("room_id")
      .primaryKey()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    provider: text("provider").notNull().$type<GitRoomProvider>(),
    host: text("host").notNull(),
    repository_id: text("repository_id"),
    repository_full_name: text("repository_full_name").notNull(),
    repository_owner: text("repository_owner").notNull(),
    repository_name: text("repository_name").notNull(),
    ref_type: text("ref_type").notNull().$type<GitRoomRefType>(),
    ref_name: text("ref_name"),
    default_branch: text("default_branch"),
    base_ref: text("base_ref"),
    head_ref: text("head_ref"),
    head_repository_id: text("head_repository_id"),
    head_repository_full_name: text("head_repository_full_name"),
    head_repository_owner: text("head_repository_owner"),
    head_repository_name: text("head_repository_name"),
    visibility: text("visibility").notNull().default("unknown").$type<GitRoomVisibility>(),
    is_default: boolean("is_default").notNull().default(false),
    source: text("source").notNull().$type<GitRoomBindingSource>(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    repository_idx: index("room_git_bindings_repository_idx").on(
      table.provider,
      table.host,
      table.repository_full_name
    ),
    repository_id_idx: index("room_git_bindings_repository_id_idx").on(
      table.provider,
      table.repository_id
    ),
    ref_idx: index("room_git_bindings_ref_idx").on(
      table.provider,
      table.host,
      table.repository_full_name,
      table.ref_type,
      table.ref_name
    ),
    provider_check: check("room_git_bindings_provider_check", sql`${table.provider} IN ('github')`),
    ref_type_check: check(
      "room_git_bindings_ref_type_check",
      sql`${table.ref_type} IN ('default_branch', 'branch', 'tag', 'pull_request')`
    ),
    visibility_check: check(
      "room_git_bindings_visibility_check",
      sql`${table.visibility} IN ('public', 'private', 'unknown')`
    ),
    source_check: check(
      "room_git_bindings_source_check",
      sql`${table.source} IN ('github_repository', 'webhook', 'manual')`
    ),
  })
);
