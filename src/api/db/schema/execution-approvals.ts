import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { agents } from "./auth.js";
import { accounts, rooms } from "./core.js";
import { supervisor_host_grants } from "./agents.js";

export const execution_delegation_grants = pgTable(
  "execution_delegation_grants",
  {
    delegation_instance_id: text("delegation_instance_id").notNull(),
    revision: integer("revision").notNull(),
    owner_account_id: text("owner_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    admission_supervisor_grant_id: text("admission_supervisor_grant_id")
      .notNull()
      .references(() => supervisor_host_grants.grant_id, { onDelete: "restrict", onUpdate: "cascade" }),
    host_id: text("host_id").notNull(),
    installation_id: text("installation_id").notNull(),
    scope_key: text("scope_key").notNull(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    agent_key: text("agent_key")
      .notNull()
      .references(() => agents.canonical_key, { onDelete: "cascade", onUpdate: "cascade" }),
    approver_account_id: text("approver_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    risk_ceiling: text("risk_ceiling").notNull(),
    scope_sha256: text("scope_sha256").notNull(),
    client_request_id: text("client_request_id").notNull(),
    request_fingerprint: text("request_fingerprint").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    expired_at: timestamp("expired_at", { mode: "string", withTimezone: true }),
    retired_at: timestamp("retired_at", { mode: "string", withTimezone: true }),
    retired_by_revision: integer("retired_by_revision"),
    revoked_at: timestamp("revoked_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({
      name: "execution_delegation_grants_pk",
      columns: [table.delegation_instance_id, table.revision],
    }),
    owner_request_unique: uniqueIndex("execution_delegation_grants_owner_request_uq")
      .on(table.owner_account_id, table.client_request_id),
    one_active_revision: uniqueIndex("execution_delegation_grants_active_revision_uq")
      .on(table.delegation_instance_id)
      .where(sql`${table.retired_at} IS NULL AND ${table.revoked_at} IS NULL AND ${table.expired_at} IS NULL`),
    one_active_scope: uniqueIndex("execution_delegation_grants_active_scope_uq")
      .on(
        table.owner_account_id,
        table.host_id,
        table.installation_id,
        table.scope_key,
        table.room_id,
        table.agent_key,
        table.approver_account_id,
      )
      .where(sql`${table.retired_at} IS NULL AND ${table.revoked_at} IS NULL AND ${table.expired_at} IS NULL`),
    owner_idx: index("execution_delegation_grants_owner_idx")
      .on(table.owner_account_id, table.created_at),
    approver_idx: index("execution_delegation_grants_approver_idx")
      .on(table.approver_account_id, table.room_id, table.created_at),
    host_idx: index("execution_delegation_grants_host_idx")
      .on(table.owner_account_id, table.host_id, table.installation_id, table.scope_key, table.created_at),
    expiry_idx: index("execution_delegation_grants_expiry_idx").on(table.expires_at),
    revision_check: check("execution_delegation_grants_revision_check", sql`${table.revision} >= 1`),
    scope_key_check: check("execution_delegation_grants_scope_key_check", sql`${table.scope_key} = 'owner'`),
    category_check: check("execution_delegation_grants_category_check", sql`${table.category} = 'file_change'`),
    risk_check: check("execution_delegation_grants_risk_check", sql`${table.risk_ceiling} = 'low'`),
    scope_digest_check: check(
      "execution_delegation_grants_scope_digest_check",
      sql`${table.scope_sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    request_digest_check: check(
      "execution_delegation_grants_request_digest_check",
      sql`${table.request_fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    expiry_check: check("execution_delegation_grants_expiry_check", sql`${table.expires_at} > ${table.created_at}`),
    retirement_check: check(
      "execution_delegation_grants_retirement_check",
      sql`(${table.retired_at} IS NULL AND ${table.retired_by_revision} IS NULL)
        OR (${table.retired_at} IS NOT NULL AND ${table.retired_by_revision} = ${table.revision} + 1)`,
    ),
    terminal_check: check(
      "execution_delegation_grants_terminal_check",
      sql`NOT (${table.retired_at} IS NOT NULL AND (${table.revoked_at} IS NOT NULL OR ${table.expired_at} IS NOT NULL))
        AND (${table.retired_at} IS NULL OR ${table.retired_at} >= ${table.created_at})
        AND (${table.expired_at} IS NULL OR ${table.expired_at} >= ${table.expires_at})
        AND (${table.revoked_at} IS NULL OR ${table.revoked_at} >= ${table.created_at})`,
    ),
  }),
);

export const execution_delegation_decisions = pgTable(
  "execution_delegation_decisions",
  {
    decision_id: text("decision_id").primaryKey(),
    delegation_instance_id: text("delegation_instance_id").notNull(),
    delegation_revision: integer("delegation_revision").notNull(),
    actor_account_id: text("actor_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    request_id: text("request_id").notNull(),
    request_version: integer("request_version").notNull(),
    request_sha256: text("request_sha256").notNull(),
    projection_sha256: text("projection_sha256").notNull(),
    decision: text("decision").notNull(),
    client_request_id: text("client_request_id").notNull(),
    request_fingerprint: text("request_fingerprint").notNull(),
    decided_at: timestamp("decided_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    grant_fk: foreignKey({
      name: "execution_delegation_decisions_grant_fk",
      columns: [table.delegation_instance_id, table.delegation_revision],
      foreignColumns: [
        execution_delegation_grants.delegation_instance_id,
        execution_delegation_grants.revision,
      ],
    }).onDelete("cascade"),
    actor_request_unique: uniqueIndex("execution_delegation_decisions_actor_request_uq")
      .on(table.actor_account_id, table.client_request_id),
    approval_unique: uniqueIndex("execution_delegation_decisions_approval_uq")
      .on(
        table.delegation_instance_id,
        table.delegation_revision,
        table.request_id,
        table.request_version,
      ),
    grant_idx: index("execution_delegation_decisions_grant_idx")
      .on(table.delegation_instance_id, table.delegation_revision, table.decision_id),
    revision_check: check("execution_delegation_decisions_revision_check", sql`${table.delegation_revision} >= 1`),
    request_version_check: check("execution_delegation_decisions_request_version_check", sql`${table.request_version} >= 1`),
    request_digest_check: check(
      "execution_delegation_decisions_request_digest_check",
      sql`${table.request_sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    projection_digest_check: check(
      "execution_delegation_decisions_projection_digest_check",
      sql`${table.projection_sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    fingerprint_check: check(
      "execution_delegation_decisions_fingerprint_check",
      sql`${table.request_fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    decision_check: check(
      "execution_delegation_decisions_decision_check",
      sql`${table.decision} IN ('allow_once', 'deny')`,
    ),
  }),
);
