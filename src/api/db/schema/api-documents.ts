import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { rooms } from "./core.js";

/**
 * Shared JSON documents for the LetAgents API (shared/api/data.mjs), created
 * in migration 0152. room_id leads the key, so every read and write goes
 * through the room in the URL. A delete leaves a tombstone row (`deleted`)
 * so a doc id's revision never repeats.
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
  deleted: boolean("deleted").notNull().default(false),
  updated_by_kind: text("updated_by_kind").notNull(),
  updated_by_id: text("updated_by_id").notNull(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ name: "api_documents_pkey", columns: [table.room_id, table.scope, table.scope_id, table.collection, table.doc_id] }),
  scope_check: check("api_documents_scope_check", sql`${table.scope} IN ('viewer', 'page', 'room')`),
  updated_by_kind_check: check("api_documents_updated_by_kind_check", sql`${table.updated_by_kind} IN ('person', 'agent')`),
  revision_check: check("api_documents_revision_check", sql`${table.revision} >= 1`),
  size_check: check("api_documents_size_check", sql`${table.size_bytes} >= 0`),
  tombstones_idx: index("api_documents_tombstones_idx").on(table.room_id, table.updated_at).where(sql`${table.deleted}`),
}));

/** Live documents and bytes per room; every document write locks the room's row. */
export const api_document_usage = pgTable("api_document_usage", {
  room_id: text("room_id").primaryKey().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  docs: integer("docs").notNull().default(0),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
}, (table) => ({
  docs_check: check("api_document_usage_docs_check", sql`${table.docs} >= 0`),
  bytes_check: check("api_document_usage_bytes_check", sql`${table.bytes} >= 0`),
}));
