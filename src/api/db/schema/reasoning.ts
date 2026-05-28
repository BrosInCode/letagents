import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { AGENT_PRESENCE_STATUSES } from "../../../shared/agent-presence.js";
import { rooms } from "./core.js";
import { agentPresenceStatusEnum } from "./enums.js";

export interface ReasoningSnapshot {
  summary: string;
  goal?: string | null;
  checking?: string | null;
  hypothesis?: string | null;
  blocker?: string | null;
  next_action?: string | null;
  milestone?: string | null;
  confidence?: number | null;
  status?: (typeof AGENT_PRESENCE_STATUSES)[number] | null;
}

export const reasoning_sessions = pgTable(
  "reasoning_sessions",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    task_id: text("task_id"),
    anchor_message_id: text("anchor_message_id"),
    actor_label: text("actor_label").notNull(),
    agent_key: text("agent_key"),
    status: agentPresenceStatusEnum("status"),
    summary: text("summary").notNull(),
    latest_payload: jsonb("latest_payload").$type<ReasoningSnapshot>().notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
    closed_at: timestamp("closed_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    room_updated_idx: index("reasoning_sessions_room_updated_idx").on(table.room_id, table.updated_at),
    room_open_idx: index("reasoning_sessions_room_open_idx")
      .on(table.room_id, table.closed_at, table.updated_at),
    room_actor_idx: index("reasoning_sessions_room_actor_idx").on(table.room_id, table.actor_label),
    room_task_idx: index("reasoning_sessions_room_task_idx").on(table.room_id, table.task_id),
  })
);

export const reasoning_session_updates = pgTable(
  "reasoning_session_updates",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    session_id: text("session_id")
      .notNull()
      .references(() => reasoning_sessions.id, { onDelete: "cascade", onUpdate: "cascade" }),
    actor_label: text("actor_label").notNull(),
    status: agentPresenceStatusEnum("status"),
    summary: text("summary").notNull(),
    milestone: text("milestone"),
    payload: jsonb("payload").$type<ReasoningSnapshot>().notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    session_created_idx: index("reasoning_session_updates_session_created_idx").on(
      table.session_id,
      table.created_at
    ),
    room_created_idx: index("reasoning_session_updates_room_created_idx").on(
      table.room_id,
      table.created_at
    ),
  })
);
