import { boolean, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { accounts, rooms } from "./core.js";
import { participantRoleEnum, roomParticipantKindEnum } from "./enums.js";

export const participants = pgTable(
  "participants",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
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

export const room_participants = pgTable(
  "room_participants",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    participant_key: text("participant_key").notNull(),
    kind: roomParticipantKindEnum("kind").notNull(),
    actor_label: text("actor_label"),
    agent_key: text("agent_key"),
    github_login: text("github_login"),
    display_name: text("display_name").notNull(),
    owner_label: text("owner_label"),
    ide_label: text("ide_label"),
    hidden_at: timestamp("hidden_at", { mode: "string", withTimezone: true }),
    hidden_by: text("hidden_by"),
    last_seen_at: timestamp("last_seen_at", { mode: "string", withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "room_participants_pk", columns: [table.room_id, table.participant_key] }),
    room_idx: index("room_participants_room_id_idx").on(table.room_id),
    room_kind_idx: index("room_participants_room_kind_idx").on(table.room_id, table.kind),
    room_last_seen_idx: index("room_participants_room_last_seen_idx").on(table.room_id, table.last_seen_at),
    room_hidden_idx: index("room_participants_room_hidden_idx").on(table.room_id, table.hidden_at),
    room_actor_idx: index("room_participants_room_actor_idx").on(table.room_id, table.actor_label),
    room_login_idx: index("room_participants_room_login_idx").on(table.room_id, table.github_login),
    participant_key_idx: index("room_participants_participant_key_idx").on(table.participant_key),
    github_login_idx: index("room_participants_github_login_idx").on(table.github_login),
  })
);

export const project_admins = pgTable(
  "project_admins",
  {
    project_id: text("project_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    assigned_at: timestamp("assigned_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "project_admins_pk", columns: [table.project_id, table.account_id] }),
    account_idx: index("project_admins_account_id_idx").on(table.account_id),
  })
);

export const account_room_recents = pgTable(
  "account_room_recents",
  {
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    display_name: text("display_name"),
    source: text("source"),
    pinned: boolean("pinned").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    first_opened_at: timestamp("first_opened_at", { mode: "string", withTimezone: true }).notNull(),
    last_opened_at: timestamp("last_opened_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "account_room_recents_pk", columns: [table.account_id, table.room_id] }),
    account_last_opened_idx: index("account_room_recents_account_last_opened_idx").on(table.account_id, table.last_opened_at),
    room_idx: index("account_room_recents_room_id_idx").on(table.room_id),
  })
);
