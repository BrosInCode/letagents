import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { GitHubRoomChatEventKind } from "../../../../shared/room-settings.mjs";
import { rooms } from "./core.js";

/**
 * Settings a room admin chooses for everyone in the room. They live beside
 * `rooms` rather than on it because guidelines can be several kilobytes and
 * rooms are read on almost every request.
 */
export const room_settings = pgTable("room_settings", {
  room_id: text("room_id").primaryKey().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  // NULL means the room has not chosen: it inherits, then falls back to every kind.
  github_chat_event_kinds: jsonb("github_chat_event_kinds").$type<GitHubRoomChatEventKind[]>(),
  agent_guidelines: text("agent_guidelines"),
  agent_guidelines_updated_by: text("agent_guidelines_updated_by"),
  agent_guidelines_updated_at: timestamp("agent_guidelines_updated_at", { mode: "string", withTimezone: true }),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  github_chat_event_kinds_check: check(
    "room_settings_github_chat_event_kinds_check",
    sql`${table.github_chat_event_kinds} IS NULL OR jsonb_typeof(${table.github_chat_event_kinds}) = 'array'`,
  ),
  agent_guidelines_length_check: check(
    "room_settings_agent_guidelines_length_check",
    sql`${table.agent_guidelines} IS NULL OR octet_length(${table.agent_guidelines}) BETWEEN 1 AND 8000`,
  ),
}));
