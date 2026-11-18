import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { accounts, rooms } from "./core.js";

/**
 * Room pages (shared/api/pages.mjs), created in migration 0155. v1 pages are
 * owned by a room; `org` is in the contract for a later page library.
 */
export const pages = pgTable("pages", {
  id: text("id").primaryKey(),
  owner_kind: text("owner_kind").notNull(),
  owner_room_id: text("owner_room_id").references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  owner_org_id: text("owner_org_id"),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  current_version: integer("current_version"),
  created_by_kind: text("created_by_kind").notNull(),
  created_by: text("created_by").notNull(),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  owner_room_slug_idx: uniqueIndex("pages_owner_room_slug_idx").on(table.owner_room_id, table.slug).where(sql`${table.owner_room_id} IS NOT NULL`),
  owner_org_slug_idx: uniqueIndex("pages_owner_org_slug_idx").on(table.owner_org_id, table.slug).where(sql`${table.owner_org_id} IS NOT NULL`),
  owner_kind_check: check("pages_owner_kind_check", sql`${table.owner_kind} IN ('room', 'org')`),
  owner_check: check("pages_owner_check", sql`(${table.owner_kind} = 'room' AND ${table.owner_room_id} IS NOT NULL AND ${table.owner_org_id} IS NULL)
    OR (${table.owner_kind} = 'org' AND ${table.owner_org_id} IS NOT NULL AND ${table.owner_room_id} IS NULL)`),
  created_by_kind_check: check("pages_created_by_kind_check", sql`${table.created_by_kind} IN ('person', 'agent')`),
  current_version_check: check("pages_current_version_check", sql`${table.current_version} IS NULL OR ${table.current_version} > 0`),
}));

export const page_versions = pgTable("page_versions", {
  page_id: text("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  html: text("html").notNull(),
  sha256: text("sha256").notNull(),
  byte_size: integer("byte_size").notNull(),
  manifest: jsonb("manifest").notNull(),
  author_kind: text("author_kind").notNull(),
  author_id: text("author_id").notNull(),
  author_owner_account_id: text("author_owner_account_id").references(() => accounts.id, { onDelete: "set null" }),
  source_message_id: text("source_message_id"),
  source_attachment_id: text("source_attachment_id"),
  status: text("status").notNull(),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ name: "page_versions_pkey", columns: [table.page_id, table.version] }),
  version_check: check("page_versions_version_check", sql`${table.version} > 0`),
  byte_size_check: check("page_versions_byte_size_check", sql`${table.byte_size} > 0 AND ${table.byte_size} <= 2097152`),
  author_kind_check: check("page_versions_author_kind_check", sql`${table.author_kind} IN ('person', 'agent')`),
  status_check: check("page_versions_status_check", sql`${table.status} IN ('live', 'draft', 'pending_approval', 'superseded')`),
  source_check: check("page_versions_source_check", sql`(${table.source_message_id} IS NULL) = (${table.source_attachment_id} IS NULL)`),
}));

export const page_placements = pgTable("page_placements", {
  page_id: text("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
  room_id: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  surface: text("surface").notNull(),
  position: integer("position").notNull(),
  pinned_by: text("pinned_by").references(() => accounts.id, { onDelete: "set null" }),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ name: "page_placements_pkey", columns: [table.page_id, table.room_id, table.surface] }),
  room_surface_idx: index("page_placements_room_surface_idx").on(table.room_id, table.surface, table.position),
  surface_check: check("page_placements_surface_check", sql`${table.surface} IN ('room.tab', 'task.panel', 'message', 'room.widget')`),
  position_check: check("page_placements_position_check", sql`${table.position} >= 0`),
}));

export const page_grants = pgTable("page_grants", {
  page_id: text("page_id").notNull(),
  version: integer("version").notNull(),
  room_id: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  capabilities: text("capabilities").array().notNull(),
  approved_by: text("approved_by").references(() => accounts.id, { onDelete: "set null" }),
  approved_at: timestamp("approved_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ name: "page_grants_pkey", columns: [table.page_id, table.version, table.room_id] }),
  version_fk: foreignKey({
    name: "page_grants_version_fk",
    columns: [table.page_id, table.version],
    foreignColumns: [page_versions.page_id, page_versions.version],
  }).onDelete("cascade"),
}));

export const page_diagnostics = pgTable("page_diagnostics", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  page_id: text("page_id").notNull(),
  version: integer("version").notNull(),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  at: timestamp("at", { mode: "string", withTimezone: true }).notNull(),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  version_fk: foreignKey({
    name: "page_diagnostics_version_fk",
    columns: [table.page_id, table.version],
    foreignColumns: [page_versions.page_id, page_versions.version],
  }).onDelete("cascade"),
  version_idx: index("page_diagnostics_version_idx").on(table.page_id, table.version, table.id),
  kind_check: check("page_diagnostics_kind_check", sql`${table.kind} IN ('console_error', 'exception', 'failed_call')`),
  message_check: check("page_diagnostics_message_check", sql`char_length(${table.message}) BETWEEN 1 AND 2000`),
}));
