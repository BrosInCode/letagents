import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  bigint,
  unique,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { accounts } from "./core.js";
import { auth_sessions } from "./auth.js";

const time = (name: string) =>
  timestamp(name, { mode: "string", withTimezone: true });
export const app_login_requests = pgTable("app_login_requests", {
  id: text("id").primaryKey(),
  secret_hash: text("secret_hash").notNull(),
  user_code: text("user_code").notNull(),
  consent_session_id: text("consent_session_id").references(
    () => auth_sessions.id,
    { onDelete: "cascade" },
  ),
  consent_hash: text("consent_hash"),
  approved: boolean("approved").notNull().default(false),
  expires_at: time("expires_at").notNull(),
  created_at: time("created_at").notNull().defaultNow(),
});
export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  participant_key: text("participant_key").notNull().unique(),
  created_by: text("created_by")
    .notNull()
    .references(() => accounts.id),
  last_message_number: integer("last_message_number").notNull().default(0),
  created_at: time("created_at").notNull().defaultNow(),
  updated_at: time("updated_at").notNull().defaultNow(),
});
export const conversation_members = pgTable(
  "conversation_members",
  {
    conversation_id: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    accepted_at: time("accepted_at"),
    last_read_number: integer("last_read_number").notNull().default(0),
    muted: boolean("muted").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversation_id, t.account_id] }),
    account_idx: index("conversation_members_account_idx").on(
      t.account_id,
      t.conversation_id,
    ),
    read_check: check(
      "conversation_members_read_check",
      sql`${t.last_read_number} >= 0`,
    ),
  }),
);
export const conversation_messages = pgTable(
  "conversation_messages",
  {
    conversation_id: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    sender_account_id: text("sender_account_id")
      .notNull()
      .references(() => accounts.id),
    client_message_id: text("client_message_id").notNull(),
    text: text("text").notNull(),
    created_at: time("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversation_id, t.number] }),
    retry: unique("conversation_messages_retry_uq").on(
      t.conversation_id,
      t.sender_account_id,
      t.client_message_id,
    ),
    number_check: check(
      "conversation_messages_number_check",
      sql`${t.number} > 0`,
    ),
    text_check: check(
      "conversation_messages_text_check",
      sql`length(${t.text}) BETWEEN 1 AND 20000`,
    ),
    sender_fk: foreignKey({
      name: "conversation_messages_sender_fk",
      columns: [t.conversation_id, t.sender_account_id],
      foreignColumns: [
        conversation_members.conversation_id,
        conversation_members.account_id,
      ],
    }),
  }),
);
export const account_blocks = pgTable(
  "account_blocks",
  {
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    blocked_account_id: text("blocked_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.account_id, t.blocked_account_id] }),
    self_check: check(
      "account_blocks_self_check",
      sql`${t.account_id} <> ${t.blocked_account_id}`,
    ),
  }),
);
export const conversation_versions = pgTable("conversation_versions", {
  account_id: text("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "bigint" }).notNull().default(0n),
});
