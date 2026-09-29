import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { accounts, rooms } from "./core.js";
import { rentalVisibilityEnum } from "./rentals.js";

export const messages = pgTable(
  "messages",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    number: integer("number").notNull(),
    reply_to_number: integer("reply_to_number"),
    thread_root_number: integer("thread_root_number"),
    sender: text("sender").notNull(),
    text: text("text").notNull(),
    display_text: text("display_text"),
    agent_prompt_kind: text("agent_prompt_kind"),
    source: text("source"),
    client_message_id: text("client_message_id"),
    // Authenticated publisher identity is stamped by the server for worker
    // writes. It is never accepted from the caller's message body.
    publisher_agent_key: text("publisher_agent_key"),
    publisher_agent_session_id: text("publisher_agent_session_id"),
    publisher_account_id: text("publisher_account_id"),
    routing_snapshot_version: integer("routing_snapshot_version"),
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
    thread_root_idx: index("messages_thread_root_idx").on(table.room_id, table.thread_root_number),
    client_message_id_idx: uniqueIndex("messages_room_client_message_id_uq")
      .on(table.room_id, table.client_message_id)
      .where(sql`${table.client_message_id} IS NOT NULL`),
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

export const message_thread_reads = pgTable(
  "message_thread_reads",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    thread_root_number: integer("thread_root_number").notNull(),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade", onUpdate: "cascade" }),
    last_read_message_number: integer("last_read_message_number").notNull(),
    // Materialized reply position at the cursor. This makes unread counts a
    // constant-time subtraction from message_thread_summaries.reply_count.
    last_read_reply_count: integer("last_read_reply_count").notNull().default(0),
    read_at: timestamp("read_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "message_thread_reads_pk",
      columns: [table.room_id, table.thread_root_number, table.account_id],
    }),
    account_idx: index("message_thread_reads_account_idx").on(table.account_id),
    room_account_idx: index("message_thread_reads_room_account_idx").on(table.room_id, table.account_id),
    thread_root_idx: index("message_thread_reads_thread_root_idx").on(table.room_id, table.thread_root_number),
  })
);

/**
 * Incremental, room-scoped thread projection. Rows exist only once a root has
 * at least one visible reply; the insert trigger fast-returns for unthreaded
 * timeline messages before touching any projection table.
 * The database trigger installed with the table owns maintenance so every
 * writer (including an older app instance during rollout) has identical
 * transactional semantics.
 */
export const message_thread_summaries = pgTable(
  "message_thread_summaries",
  {
    room_id: text("room_id").notNull(),
    thread_root_number: integer("thread_root_number").notNull(),
    reply_count: integer("reply_count").notNull(),
    latest_reply_number: integer("latest_reply_number").notNull(),
    participant_count: integer("participant_count").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "message_thread_summaries_pk",
      columns: [table.room_id, table.thread_root_number],
    }),
    root_fk: foreignKey({
      name: "message_thread_summaries_root_fk",
      columns: [table.room_id, table.thread_root_number],
      foreignColumns: [messages.room_id, messages.number],
    }).onDelete("cascade").onUpdate("cascade"),
    latest_reply_fk: foreignKey({
      name: "message_thread_summaries_latest_reply_fk",
      columns: [table.room_id, table.latest_reply_number],
      foreignColumns: [messages.room_id, messages.number],
    }).onDelete("cascade").onUpdate("cascade"),
    latest_reply_idx: index("message_thread_summaries_latest_reply_idx")
      .on(table.room_id, table.latest_reply_number),
    reply_count_check: check("message_thread_summaries_reply_count_check", sql`${table.reply_count} > 0`),
    participant_count_check: check(
      "message_thread_summaries_participant_count_check",
      sql`${table.participant_count} > 0`
    ),
  })
);

/**
 * One row per sender/source identity in a materialized thread. Identity text
 * is intentionally data rather than a btree key: historical sender/source
 * values and source integrations may exceed PostgreSQL's index-row limit.
 */
export const message_thread_participants = pgTable(
  "message_thread_participants",
  {
    room_id: text("room_id").notNull(),
    thread_root_number: integer("thread_root_number").notNull(),
    participant_number: integer("participant_number").notNull(),
    identity_hash: text("identity_hash").notNull(),
    sender: text("sender").notNull(),
    source: text("source"),
    message_count: integer("message_count").notNull(),
    latest_message_number: integer("latest_message_number"),
    routing_message_count: integer("routing_message_count").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "message_thread_participants_pk",
      columns: [table.room_id, table.thread_root_number, table.participant_number],
    }),
    root_fk: foreignKey({
      name: "message_thread_participants_root_fk",
      columns: [table.room_id, table.thread_root_number],
      foreignColumns: [messages.room_id, messages.number],
    }).onDelete("cascade").onUpdate("cascade"),
    identity_idx: index("message_thread_participants_identity_idx")
      .on(table.room_id, table.thread_root_number, table.identity_hash),
    visible_latest_idx: index("message_thread_participants_visible_latest_idx")
      .on(table.room_id, table.thread_root_number, table.latest_message_number.desc())
      .where(sql`${table.message_count} > 0`),
    message_count_check: check(
      "message_thread_participants_message_count_check",
      sql`${table.message_count} >= 0`
    ),
    routing_count_check: check(
      "message_thread_participants_routing_count_check",
      sql`${table.routing_message_count} > 0`
    ),
    visible_latest_check: check(
      "message_thread_participants_visible_latest_check",
      sql`(${table.message_count} = 0) = (${table.latest_message_number} IS NULL)`
    ),
  })
);

/**
 * Index-safe routing aliases for materialized participants. Alias text stays
 * outside every btree key; the fixed-width digest narrows candidates and the
 * caller verifies raw normalized equality to close hash collisions.
 */
export const message_thread_participant_aliases = pgTable(
  "message_thread_participant_aliases",
  {
    room_id: text("room_id").notNull(),
    thread_root_number: integer("thread_root_number").notNull(),
    participant_number: integer("participant_number").notNull(),
    alias_number: integer("alias_number").notNull(),
    alias_hash: text("alias_hash").notNull(),
    alias_text: text("alias_text").notNull(),
    is_full: boolean("is_full").notNull().default(false),
  },
  (table) => ({
    pk: primaryKey({
      name: "message_thread_participant_aliases_pk",
      columns: [table.room_id, table.thread_root_number, table.participant_number, table.alias_number],
    }),
    participant_fk: foreignKey({
      name: "message_thread_participant_aliases_participant_fk",
      columns: [table.room_id, table.thread_root_number, table.participant_number],
      foreignColumns: [
        message_thread_participants.room_id,
        message_thread_participants.thread_root_number,
        message_thread_participants.participant_number,
      ],
    }).onDelete("cascade").onUpdate("cascade"),
    active_lookup_idx: index("message_thread_participant_aliases_active_lookup_idx")
      .on(table.room_id, table.alias_hash, table.thread_root_number),
    hash_check: check(
      "message_thread_participant_aliases_hash_check",
      sql`LENGTH(${table.alias_hash}) = 32`,
    ),
    number_check: check(
      "message_thread_participant_aliases_number_check",
      sql`${table.alias_number} BETWEEN 1 AND 17`,
    ),
  }),
);

/** Exact authenticated publisher identities attached to display participants. */
export const message_thread_participant_agents = pgTable(
  "message_thread_participant_agents",
  {
    room_id: text("room_id").notNull(),
    thread_root_number: integer("thread_root_number").notNull(),
    participant_number: integer("participant_number").notNull(),
    agent_number: integer("agent_number").notNull(),
    agent_key_hash: text("agent_key_hash").notNull(),
    agent_key: text("agent_key").notNull(),
    owner_account_id: text("owner_account_id").notNull(),
    message_count: integer("message_count").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "message_thread_participant_agents_pk",
      columns: [
        table.room_id,
        table.thread_root_number,
        table.participant_number,
        table.agent_number,
      ],
    }),
    participant_fk: foreignKey({
      name: "message_thread_participant_agents_participant_fk",
      columns: [table.room_id, table.thread_root_number, table.participant_number],
      foreignColumns: [
        message_thread_participants.room_id,
        message_thread_participants.thread_root_number,
        message_thread_participants.participant_number,
      ],
    }).onDelete("cascade").onUpdate("cascade"),
    lookup_idx: index("message_thread_participant_agents_lookup_idx")
      .on(table.room_id, table.agent_key_hash, table.thread_root_number),
    hash_check: check(
      "message_thread_participant_agents_hash_check",
      sql`LENGTH(${table.agent_key_hash}) = 32`,
    ),
    count_check: check(
      "message_thread_participant_agents_count_check",
      sql`${table.message_count} > 0`,
    ),
  }),
);

/** Fixed-width idempotency row and visible-reply ordinal. */
export const message_thread_projected_messages = pgTable(
  "message_thread_projected_messages",
  {
    room_id: text("room_id").notNull(),
    message_number: integer("message_number").notNull(),
    thread_root_number: integer("thread_root_number").notNull(),
    participant_number: integer("participant_number").notNull(),
    participant_agent_number: integer("participant_agent_number"),
    reply_ordinal: integer("reply_ordinal"),
    is_visible: boolean("is_visible").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "message_thread_projected_messages_pk",
      columns: [table.room_id, table.message_number],
    }),
    message_fk: foreignKey({
      name: "message_thread_projected_messages_message_fk",
      columns: [table.room_id, table.message_number],
      foreignColumns: [messages.room_id, messages.number],
    }).onDelete("cascade").onUpdate("cascade"),
    root_fk: foreignKey({
      name: "message_thread_projected_messages_root_fk",
      columns: [table.room_id, table.thread_root_number],
      foreignColumns: [messages.room_id, messages.number],
    }).onDelete("cascade").onUpdate("cascade"),
    participant_agent_fk: foreignKey({
      name: "message_thread_projected_messages_participant_agent_fk",
      columns: [
        table.room_id,
        table.thread_root_number,
        table.participant_number,
        table.participant_agent_number,
      ],
      foreignColumns: [
        message_thread_participant_agents.room_id,
        message_thread_participant_agents.thread_root_number,
        message_thread_participant_agents.participant_number,
        message_thread_participant_agents.agent_number,
      ],
    }).onUpdate("cascade"),
    thread_idx: index("message_thread_projected_messages_thread_idx")
      .on(table.room_id, table.thread_root_number, table.message_number),
    ordinal_uq: uniqueIndex("message_thread_projected_messages_ordinal_uq")
      .on(table.room_id, table.thread_root_number, table.reply_ordinal)
      .where(sql`${table.reply_ordinal} IS NOT NULL`),
    visibility_check: check(
      "message_thread_projected_messages_visibility_check",
      sql`${table.is_visible} = (${table.reply_ordinal} IS NOT NULL)`
    ),
  })
);

export const message_room_thread_stats = pgTable(
  "message_room_thread_stats",
  {
    room_id: text("room_id")
      .primaryKey()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    thread_count: integer("thread_count").notNull().default(0),
    reply_version: integer("reply_version").notNull().default(0),
  },
  (table) => ({
    count_check: check(
      "message_room_thread_stats_count_check",
      sql`${table.thread_count} >= 0 AND ${table.reply_version} >= 0`,
    ),
  })
);

export const message_account_thread_read_stats = pgTable(
  "message_account_thread_read_stats",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade", onUpdate: "cascade" }),
    current_read_version: integer("current_read_version").notNull().default(0),
    cached_read_version: integer("cached_read_version").notNull().default(-1),
    cached_room_reply_version: integer("cached_room_reply_version").notNull().default(-1),
    read_thread_count: integer("read_thread_count").notNull().default(0),
    fully_read_thread_count: integer("fully_read_thread_count").notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({
      name: "message_account_thread_read_stats_pk",
      columns: [table.room_id, table.account_id],
    }),
    count_check: check(
      "message_account_thread_read_stats_count_check",
      sql`${table.current_read_version} >= 0
          AND ${table.cached_read_version} >= -1
          AND ${table.cached_room_reply_version} >= -1
          AND ${table.read_thread_count} >= 0
          AND ${table.fully_read_thread_count} >= 0
          AND ${table.fully_read_thread_count} <= ${table.read_thread_count}`,
    ),
  }),
);

export const message_thread_projection_watermarks = pgTable(
  "message_thread_projection_watermarks",
  {
    room_id: text("room_id")
      .primaryKey()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    through_message_number: integer("through_message_number").notNull(),
    message_cursor: integer("message_cursor").notNull().default(0),
    read_thread_root_cursor: integer("read_thread_root_cursor").notNull().default(0),
    read_account_cursor: text("read_account_cursor").notNull().default(""),
    reads_completed: boolean("reads_completed").notNull().default(false),
    completed_at: timestamp("completed_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    pending_idx: index("message_thread_projection_watermarks_pending_idx")
      .on(table.room_id)
      .where(sql`${table.completed_at} IS NULL`),
    number_check: check(
      "message_thread_projection_watermarks_number_check",
      sql`${table.through_message_number} >= 0 AND ${table.message_cursor} >= 0`
    ),
  })
);

export const message_thread_projection_rollout = pgTable(
  "message_thread_projection_rollout",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    room_cursor: text("room_cursor").notNull().default(""),
    watermarks_created: boolean("watermarks_created").notNull().default(false),
    completed_at: timestamp("completed_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    singleton_check: check("message_thread_projection_rollout_singleton_check", sql`${table.singleton}`),
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

export const message_agent_receipts = pgTable(
  "message_agent_receipts",
  {
    id: text("id").primaryKey(),
    message_room_id: text("message_room_id").notNull(),
    message_number: integer("message_number").notNull(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    agent_session_id: text("agent_session_id").notNull(),
    agent_key: text("agent_key").notNull(),
    actor_label: text("actor_label").notNull(),
    activation_reason: text("activation_reason").notNull(),
    receipt_state: text("receipt_state").notNull(),
    // Canonical reply message number, stamped by the server-owned replied
    // transition. Supervised publications carry no reply_to, so this is the
    // only durable link from a replied receipt to its answer.
    reply_message_number: integer("reply_message_number"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    message_fk: foreignKey({
      name: "message_agent_receipts_message_fk",
      columns: [table.message_room_id, table.message_number],
      foreignColumns: [messages.room_id, messages.number],
    }).onDelete("cascade").onUpdate("cascade"),
    message_idx: index("message_agent_receipts_message_idx").on(table.message_room_id, table.message_number),
    session_idx: index("message_agent_receipts_session_idx").on(table.room_id, table.agent_session_id),
    // Delivery surfaces and the session-terminal sweep both look receipts up
    // by durable agent identity.
    agent_key_idx: index("message_agent_receipts_agent_key_idx").on(table.message_room_id, table.agent_key, table.message_number),
    // One receipt per durable agent per message: several live sessions may
    // share an agent_key, but the agent was asked exactly once.
    agent_uq: uniqueIndex("message_agent_receipts_message_agent_uq").on(table.message_room_id, table.message_number, table.agent_key),
  })
);

export const message_agent_receipt_events = pgTable(
  "message_agent_receipt_events",
  {
    id: text("id").primaryKey(),
    receipt_id: text("receipt_id")
      .notNull()
      .references(() => message_agent_receipts.id, { onDelete: "cascade", onUpdate: "cascade" }),
    message_room_id: text("message_room_id").notNull(),
    message_number: integer("message_number").notNull(),
    from_state: text("from_state"),
    to_state: text("to_state").notNull(),
    actor_session_id: text("actor_session_id"),
    timestamp: timestamp("timestamp", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    receipt_idx: index("message_agent_receipt_events_receipt_idx").on(table.receipt_id),
  })
);

export const room_agent_observation_spans = pgTable(
  "room_agent_observation_spans",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    agent_session_id: text("agent_session_id").notNull(),
    agent_key: text("agent_key").notNull(),
    first_message_sequence: integer("first_message_sequence").notNull(),
    last_message_sequence: integer("last_message_sequence").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_session_idx: index("room_agent_observation_spans_room_session_idx").on(table.room_id, table.agent_session_id),
  })
);

export const message_human_read_ranges = pgTable(
  "message_human_read_ranges",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    account_id: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade", onUpdate: "cascade" }),
    scope_kind: text("scope_kind").notNull(),
    thread_root_number: integer("thread_root_number"),
    first_message_sequence: integer("first_message_sequence").notNull(),
    last_message_sequence: integer("last_message_sequence").notNull(),
    client_batch_id: text("client_batch_id").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_account_idx: index("message_human_read_ranges_room_account_idx").on(table.room_id, table.account_id),
    batch_uq: uniqueIndex("message_human_read_ranges_batch_uq").on(table.room_id, table.account_id, table.client_batch_id),
  })
);
