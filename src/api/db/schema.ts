import { index, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const participantRoleEnum = pgEnum("participant_role", ["participant", "admin"]);
export const taskStatusEnum = pgEnum("task_status", [
  "proposed",
  "accepted",
  "assigned",
  "in_progress",
  "blocked",
  "in_review",
  "merged",
  "done",
  "cancelled",
]);

export const id_sequences = pgTable("id_sequences", {
  name: text("name").primaryKey(),
  value: integer("value").notNull(),
});

export const rooms = pgTable("rooms", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").unique(),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
});

export const participants = pgTable(
  "participants",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    github_id: text("github_id"),
    github_login: text("github_login"),
    display_name: text("display_name").notNull(),
    role: participantRoleEnum("role").notNull().default("participant"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_idx: index("participants_room_id_idx").on(table.room_id),
  })
);

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  canonical_key: text("canonical_key").notNull().unique(),
  display_name: text("display_name").notNull(),
  owner_github_id: text("owner_github_id"),
  owner_label: text("owner_label"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
});

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    project_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    sender: text("sender").notNull(),
    text: text("text").notNull(),
    timestamp: timestamp("timestamp", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_idx: index("messages_room_id_idx").on(table.project_id),
  })
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    project_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatusEnum("status").notNull().default("proposed"),
    assignee: text("assignee"),
    created_by: text("created_by").notNull(),
    source_message_id: text("source_message_id"),
    pr_url: text("pr_url"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_idx: index("tasks_room_id_idx").on(table.project_id),
    status_idx: index("tasks_status_idx").on(table.status),
  })
);

export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    code: text("code").notNull().unique(),
    created_by: text("created_by"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    room_idx: index("invites_room_id_idx").on(table.room_id),
  })
);
