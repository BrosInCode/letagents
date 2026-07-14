import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { accounts, rooms } from "./core.js";
import { agentPresenceStatusEnum, roomAgentDeliveryTransportEnum, roomAgentSessionKindEnum } from "./enums.js";

export const room_agent_presence = pgTable(
  "room_agent_presence",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    actor_label: text("actor_label").notNull(),
    agent_key: text("agent_key"),
    agent_session_id: text("agent_session_id").references(() => room_agent_sessions.session_id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    session_kind: roomAgentSessionKindEnum("session_kind").notNull().default("controller"),
    runtime: text("runtime").notNull().default("unknown"),
    display_name: text("display_name").notNull(),
    owner_label: text("owner_label"),
    ide_label: text("ide_label"),
    repo_branch: text("repo_branch"),
    status: agentPresenceStatusEnum("status").notNull().default("idle"),
    status_text: text("status_text"),
    last_heartbeat_at: timestamp("last_heartbeat_at", { mode: "string", withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "room_agent_presence_pk", columns: [table.room_id, table.actor_label] }),
    room_idx: index("room_agent_presence_room_id_idx").on(table.room_id),
    room_status_idx: index("room_agent_presence_room_status_idx").on(table.room_id, table.status),
    room_heartbeat_idx: index("room_agent_presence_room_heartbeat_idx").on(
      table.room_id,
      table.last_heartbeat_at
    ),
    room_agent_key_idx: index("room_agent_presence_room_agent_key_idx").on(table.room_id, table.agent_key),
    room_session_kind_idx: index("room_agent_presence_room_session_kind_idx").on(table.room_id, table.session_kind),
    room_branch_idx: index("room_agent_presence_room_branch_idx")
      .on(table.room_id, table.repo_branch)
      .where(sql`${table.repo_branch} IS NOT NULL`),
  })
);

export const room_agent_sessions = pgTable(
  "room_agent_sessions",
  {
    session_id: text("session_id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    token_hash: text("token_hash").notNull().unique(),
    session_kind: roomAgentSessionKindEnum("session_kind").notNull(),
    runtime: text("runtime").notNull(),
    actor_label: text("actor_label").notNull(),
    agent_key: text("agent_key").notNull(),
    agent_instance_id: text("agent_instance_id"),
    host_id: text("host_id"),
    host_kind: text("host_kind"),
    host_label: text("host_label"),
    liveness_capability: text("liveness_capability"),
    tool_bridge_id: text("tool_bridge_id"),
    repo_branch: text("repo_branch"),
    display_name: text("display_name").notNull(),
    owner_account_id: text("owner_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    supervisor_grant_id: text("supervisor_grant_id").references(() => supervisor_host_grants.grant_id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    owner_label: text("owner_label").notNull(),
    ide_label: text("ide_label").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
    last_seen_at: timestamp("last_seen_at", { mode: "string", withTimezone: true }).notNull(),
    ended_at: timestamp("ended_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    room_idx: index("room_agent_sessions_room_id_idx").on(table.room_id),
    room_kind_idx: index("room_agent_sessions_room_kind_idx").on(table.room_id, table.session_kind),
    agent_key_idx: index("room_agent_sessions_agent_key_idx").on(table.agent_key),
    owner_idx: index("room_agent_sessions_owner_account_id_idx").on(table.owner_account_id),
    grant_idx: index("room_agent_sessions_grant_id_idx").on(table.supervisor_grant_id),
    active_worker_actor_label_idx: uniqueIndex("room_agent_sessions_active_worker_actor_label_idx")
      .on(table.room_id, table.actor_label)
      .where(sql`${table.session_kind} = 'worker' AND ${table.ended_at} IS NULL`),
    room_agent_active_idx: index("room_agent_sessions_room_agent_active_idx").on(
      table.room_id,
      table.agent_key,
      table.ended_at
    ),
    room_branch_idx: index("room_agent_sessions_room_branch_idx")
      .on(table.room_id, table.repo_branch)
      .where(sql`${table.repo_branch} IS NOT NULL`),
  })
);

// A supervisor grant is a host-bound credential, deliberately distinct from
// both owner credentials and worker credentials.  The current generation is a
// fencing value supplied on each privileged supervisor request; it is never
// encoded in the bearer itself.
export const supervisor_host_grants = pgTable(
  "supervisor_host_grants",
  {
    grant_id: text("grant_id").primaryKey(),
    owner_account_id: text("owner_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    host_id: text("host_id").notNull(),
    installation_id: text("installation_id").notNull(),
    token_hash: text("token_hash").notNull().unique(),
    allowed_room_ids: text("allowed_room_ids").array().notNull(),
    allowed_agent_keys: text("allowed_agent_keys").array().notNull(),
    current_generation: integer("current_generation").notNull().default(1),
    issued_at: timestamp("issued_at", { mode: "string", withTimezone: true }).notNull(),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { mode: "string", withTimezone: true }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    active_host_idx: uniqueIndex("supervisor_host_grants_active_host_idx")
      .on(table.owner_account_id, table.host_id, table.installation_id)
      .where(sql`${table.revoked_at} IS NULL`),
    owner_idx: index("supervisor_host_grants_owner_idx").on(table.owner_account_id),
    expiry_idx: index("supervisor_host_grants_expiry_idx").on(table.expires_at),
  })
);

// A worker bearer is deliberately separate from the legacy session_token.
// The legacy token remains an owner-authorized, body-supplied credential while
// this record is the short-lived, least-privilege credential a spawned worker
// may use directly as an Authorization bearer.
export const room_agent_session_bearers = pgTable(
  "room_agent_session_bearers",
  {
    bearer_id: text("bearer_id").primaryKey(),
    session_id: text("session_id")
      .notNull()
      .references(() => room_agent_sessions.session_id, { onDelete: "cascade", onUpdate: "cascade" }),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    supervisor_grant_id: text("supervisor_grant_id").references(() => supervisor_host_grants.grant_id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    token_hash: text("token_hash").notNull().unique(),
    generation: integer("generation").notNull(),
    capabilities: text("capabilities").array().notNull(),
    issued_at: timestamp("issued_at", { mode: "string", withTimezone: true }).notNull(),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { mode: "string", withTimezone: true }),
    rotated_from_bearer_id: text("rotated_from_bearer_id"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    session_idx: index("room_agent_session_bearers_session_id_idx").on(table.session_id),
    room_idx: index("room_agent_session_bearers_room_id_idx").on(table.room_id),
    grant_idx: index("room_agent_session_bearers_grant_id_idx").on(table.supervisor_grant_id),
    active_session_idx: index("room_agent_session_bearers_active_session_idx")
      .on(table.session_id, table.revoked_at, table.expires_at),
    generation_unique: uniqueIndex("room_agent_session_bearers_session_generation_idx")
      .on(table.session_id, table.generation),
  })
);

export const room_agent_liveness_observations = pgTable(
  "room_agent_liveness_observations",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    agent_session_id: text("agent_session_id")
      .notNull()
      .references(() => room_agent_sessions.session_id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    source: text("source").notNull().default("agent_session"),
    host_id: text("host_id"),
    host_kind: text("host_kind"),
    host_label: text("host_label"),
    liveness_capability: text("liveness_capability").notNull().default("session_activity"),
    tool_bridge_id: text("tool_bridge_id"),
    last_observed_at: timestamp("last_observed_at", { mode: "string", withTimezone: true }).notNull(),
    last_tool_call_at: timestamp("last_tool_call_at", { mode: "string", withTimezone: true }),
    detail: text("detail"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "room_agent_liveness_observations_pk",
      columns: [table.room_id, table.agent_session_id, table.source],
    }),
    room_idx: index("room_agent_liveness_observations_room_id_idx").on(table.room_id),
    session_idx: index("room_agent_liveness_observations_session_idx").on(table.agent_session_id),
    observed_idx: index("room_agent_liveness_observations_observed_idx").on(
      table.room_id,
      table.last_observed_at
    ),
  })
);

export const room_agent_delivery_sessions = pgTable(
  "room_agent_delivery_sessions",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    delivery_key: text("delivery_key").notNull(),
    actor_label: text("actor_label").notNull(),
    agent_key: text("agent_key"),
    agent_instance_id: text("agent_instance_id"),
    display_name: text("display_name").notNull(),
    owner_label: text("owner_label"),
    ide_label: text("ide_label"),
    repo_branch: text("repo_branch"),
    agent_session_id: text("agent_session_id").references(() => room_agent_sessions.session_id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    session_kind: roomAgentSessionKindEnum("session_kind").notNull().default("controller"),
    runtime: text("runtime").notNull().default("unknown"),
    transport: roomAgentDeliveryTransportEnum("transport").notNull(),
    active_connection_count: integer("active_connection_count").notNull().default(0),
    last_connected_at: timestamp("last_connected_at", { mode: "string", withTimezone: true }).notNull(),
    last_disconnected_at: timestamp("last_disconnected_at", { mode: "string", withTimezone: true }),
    reconnect_grace_expires_at: timestamp("reconnect_grace_expires_at", {
      mode: "string",
      withTimezone: true,
    }),
    offline_announced_at: timestamp("offline_announced_at", { mode: "string", withTimezone: true }),
    recovery_announced_at: timestamp("recovery_announced_at", { mode: "string", withTimezone: true }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "room_agent_delivery_sessions_pk", columns: [table.room_id, table.delivery_key] }),
    room_idx: index("room_agent_delivery_sessions_room_id_idx").on(table.room_id),
    room_actor_idx: index("room_agent_delivery_sessions_room_actor_idx").on(
      table.room_id,
      table.actor_label
    ),
    room_active_idx: index("room_agent_delivery_sessions_room_active_idx").on(
      table.room_id,
      table.active_connection_count
    ),
    room_grace_idx: index("room_agent_delivery_sessions_room_grace_idx").on(
      table.room_id,
      table.reconnect_grace_expires_at
    ),
    room_agent_key_idx: index("room_agent_delivery_sessions_room_agent_key_idx").on(
      table.room_id,
      table.agent_key
    ),
    room_session_kind_idx: index("room_agent_delivery_sessions_room_session_kind_idx").on(
      table.room_id,
      table.session_kind
    ),
    room_branch_idx: index("room_agent_delivery_sessions_room_branch_idx")
      .on(table.room_id, table.repo_branch)
      .where(sql`${table.repo_branch} IS NOT NULL`),
    active_count_check: check(
      "room_agent_delivery_sessions_active_connection_count_check",
      sql`${table.active_connection_count} >= 0`
    ),
  })
);

export const room_live_agent_suppressions = pgTable(
  "room_live_agent_suppressions",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    actor_label: text("actor_label").notNull(),
    suppressed_by: text("suppressed_by"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "room_live_agent_suppressions_pk", columns: [table.room_id, table.actor_label] }),
    room_idx: index("room_live_agent_suppressions_room_id_idx").on(table.room_id),
    room_actor_idx: index("room_live_agent_suppressions_room_actor_idx").on(table.room_id, table.actor_label),
  })
);
