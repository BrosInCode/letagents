import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { RoomAgentWork } from "../../../../shared/room-agent-work.mjs";
import { accounts } from "./core.js";
import { messages } from "./messages.js";

// Secondary snapshots only. Immutable publisher custody is distinct from the
// rotating grant/session credentials and from public attempt identity.
export const room_agent_work = pgTable("room_agent_work", {
  attempt_id: text("attempt_id").primaryKey(),
  room_id: text("room_id").notNull(),
  source_message_number: integer("source_message_number").notNull(),
  agent_key: text("agent_key").notNull(),
  owner_account_id: text("owner_account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  host_id: text("host_id").notNull(),
  installation_id: text("installation_id").notNull(),
  agent_instance_id: text("agent_instance_id").notNull(),
  publisher_revision: bigint("publisher_revision", { mode: "number" }).notNull(),
  summary_digest: text("summary_digest").notNull(),
  summary: jsonb("summary").$type<RoomAgentWork["summary"]>().notNull(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
}, (table) => ({
  source_fk: foreignKey({ name: "room_agent_work_source_fk", columns: [table.room_id, table.source_message_number], foreignColumns: [messages.room_id, messages.number] }).onDelete("cascade").onUpdate("cascade"),
  delivery_uq: uniqueIndex("room_agent_work_delivery_uq").on(table.room_id, table.source_message_number, table.agent_key),
  recent_idx: index("room_agent_work_recent_idx").on(table.room_id, table.updated_at, table.attempt_id),
  revision_check: check("room_agent_work_revision_check", sql`${table.publisher_revision} BETWEEN 1 AND 9007199254740991`),
  summary_size_check: check("room_agent_work_summary_size_check", sql`octet_length(${table.summary}::text) <= 2048`),
}));
