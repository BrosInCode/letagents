import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { FocusRoomConclusionDetails } from "../../focus-rooms/conclusion.js";
import type {
  FocusActivityScope,
  FocusGitHubEventRouting,
  FocusParentVisibility,
} from "../../focus-rooms/settings.js";

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
    focus_parent_visibility: text("focus_parent_visibility").$type<FocusParentVisibility>(),
    focus_activity_scope: text("focus_activity_scope").$type<FocusActivityScope>(),
    focus_github_event_routing: text("focus_github_event_routing").$type<FocusGitHubEventRouting>(),
    concluded_at: timestamp("concluded_at", { mode: "string", withTimezone: true }),
    conclusion_summary: text("conclusion_summary"),
    conclusion_details: jsonb("conclusion_details").$type<FocusRoomConclusionDetails>(),
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
    focus_settings_check: check(
      "rooms_focus_settings_check",
      sql`(
        ${table.focus_parent_visibility} IS NULL
        OR ${table.focus_parent_visibility} IN ('summary_only', 'major_activity', 'all_activity', 'silent')
      ) AND (
        ${table.focus_activity_scope} IS NULL
        OR ${table.focus_activity_scope} IN ('task_and_branch', 'task_only', 'room')
      ) AND (
        ${table.focus_github_event_routing} IS NULL
        OR ${table.focus_github_event_routing} IN ('task_and_branch', 'focus_owned_only', 'task_only', 'all_parent_repo', 'off')
      )`
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
        AND ${table.conclusion_details} IS NULL
      ) OR (
        ${table.kind} = 'focus'
        AND ${table.parent_room_id} IS NOT NULL
        AND ${table.focus_key} IS NOT NULL
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
