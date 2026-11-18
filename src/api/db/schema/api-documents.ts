import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { rooms } from "./core.js";

/**
 * Shared JSON documents for the LetAgents API (shared/api/data.mjs), created
 * in migration 0152. room_id leads the key, so every read and write goes
 * through the room in the URL.
 */
export const api_documents = pgTable("api_documents", {
  room_id: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  scope: text("scope").notNull(),
  scope_id: text("scope_id").notNull(),
  collection: text("collection").notNull(),
  doc_id: text("doc_id").notNull(),
  data: jsonb("data").notNull(),
  size_bytes: integer("size_bytes").notNull(),
  revision: integer("revision").notNull(),
  updated_by_kind: text("updated_by_kind").notNull(),
  updated_by_id: text("updated_by_id").notNull(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ name: "api_documents_pkey", columns: [table.room_id, table.scope, table.scope_id, table.collection, table.doc_id] }),
  scope_check: check("api_documents_scope_check", sql`${table.scope} IN ('viewer', 'page', 'room')`),
  updated_by_kind_check: check("api_documents_updated_by_kind_check", sql`${table.updated_by_kind} IN ('person', 'agent')`),
  revision_check: check("api_documents_revision_check", sql`${table.revision} >= 1`),
  size_check: check("api_documents_size_check", sql`${table.size_bytes} >= 0`),
}));
