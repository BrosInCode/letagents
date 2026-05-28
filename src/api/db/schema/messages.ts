import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { rooms } from "./core.js";
import { rentalVisibilityEnum } from "./rentals.js";

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
    // Rental Room Projection: visibility controls which participants see this message
    visibility: rentalVisibilityEnum("visibility"),
    // Links message to a rental session when sent by/for a rental participant
    rental_session_id: text("rental_session_id"),
    timestamp: timestamp("timestamp", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "messages_pk", columns: [table.room_id, table.number] }),
    room_idx: index("messages_room_id_idx").on(table.room_id),
    reply_to_idx: index("messages_reply_to_idx").on(table.room_id, table.reply_to_number),
    auto_prompt_idx: index("messages_auto_prompt_idx")
      .on(table.room_id, table.sender)
      .where(sql`${table.agent_prompt_kind} = 'auto'`),
    // Rental projection filter: quickly find rental-visible messages for a session
    rental_session_idx: index("messages_rental_session_id_idx")
      .on(table.room_id, table.rental_session_id)
      .where(sql`${table.rental_session_id} IS NOT NULL`),
    rental_visibility_idx: index("messages_rental_visibility_idx")
      .on(table.room_id, table.visibility)
      .where(sql`${table.visibility} IS NOT NULL`),
    prompt_kind_check: check(
      "messages_agent_prompt_kind_check",
      sql`${table.agent_prompt_kind} IS NULL OR ${table.agent_prompt_kind} IN ('join', 'inline', 'auto')`
    ),
  })
);

export const message_attachments = pgTable(
  "message_attachments",
  {
    room_id: text("room_id").notNull(),
    message_number: integer("message_number").notNull(),
    attachment_number: integer("attachment_number").notNull(),
    upload_id: text("upload_id").notNull(),
    filename: text("filename").notNull(),
    content_type: text("content_type").notNull(),
    byte_size: integer("byte_size").notNull(),
    storage_provider: text("storage_provider").notNull(),
    bucket: text("bucket").notNull(),
    object_key: text("object_key").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "message_attachments_pk",
      columns: [table.room_id, table.message_number, table.attachment_number],
    }),
    message_fk: foreignKey({
      name: "message_attachments_message_fk",
      columns: [table.room_id, table.message_number],
      foreignColumns: [messages.room_id, messages.number],
    }).onDelete("cascade").onUpdate("cascade"),
    room_idx: index("message_attachments_room_idx").on(table.room_id, table.message_number),
    upload_idx: uniqueIndex("message_attachments_upload_idx").on(table.upload_id),
    byte_size_check: check("message_attachments_byte_size_check", sql`${table.byte_size} > 0`),
  })
);

export const message_attachment_uploads = pgTable(
  "message_attachment_uploads",
  {
    upload_id: text("upload_id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    filename: text("filename").notNull(),
    content_type: text("content_type").notNull(),
    byte_size: integer("byte_size").notNull(),
    storage_provider: text("storage_provider").notNull(),
    bucket: text("bucket").notNull(),
    object_key: text("object_key").notNull(),
    status: text("status").notNull(),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    attached_message_number: integer("attached_message_number"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    attached_at: timestamp("attached_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    room_idx: index("message_attachment_uploads_room_idx").on(table.room_id, table.created_at),
    object_key_idx: uniqueIndex("message_attachment_uploads_object_key_idx").on(table.object_key),
    status_check: check(
      "message_attachment_uploads_status_check",
      sql`${table.status} IN ('pending', 'attached')`
    ),
    byte_size_check: check("message_attachment_uploads_byte_size_check", sql`${table.byte_size} > 0`),
  })
);
