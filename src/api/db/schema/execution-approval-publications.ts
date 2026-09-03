import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { room_agent_work } from "./agent-work.js";
import { execution_delegation_grants } from "./execution-approvals.js";

/** Immutable, custody-bound copies of the exact bytes a delegate may inspect. */
export const execution_approval_publications = pgTable(
  "execution_approval_publications",
  {
    publication_id: text("publication_id").primaryKey(),
    room_agent_work_attempt_id: text("room_agent_work_attempt_id")
      .notNull()
      .references(() => room_agent_work.attempt_id, { onDelete: "cascade" }),
    delegation_instance_id: text("delegation_instance_id").notNull(),
    delegation_revision: integer("delegation_revision").notNull(),
    request_id: text("request_id").notNull(),
    request_version: integer("request_version").notNull(),
    request_sha256: text("request_sha256").notNull(),
    projection_sha256: text("projection_sha256").notNull(),
    projection_json: text("projection_json").notNull(),
    publication_digest: text("publication_digest").notNull(),
    produced_at: timestamp("produced_at", { mode: "string", withTimezone: true }).notNull(),
    published_at: timestamp("published_at", { mode: "string", withTimezone: true }).notNull(),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    closed_at: timestamp("closed_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    delegation_fk: foreignKey({
      name: "execution_approval_publications_delegation_fk",
      columns: [table.delegation_instance_id, table.delegation_revision],
      foreignColumns: [
        execution_delegation_grants.delegation_instance_id,
        execution_delegation_grants.revision,
      ],
    }).onDelete("cascade"),
    request_uq: uniqueIndex("execution_approval_publications_request_uq").on(
      table.delegation_instance_id,
      table.delegation_revision,
      table.request_id,
      table.request_version,
    ),
    approver_inventory_idx: index("execution_approval_publications_inventory_idx")
      .on(table.delegation_instance_id, table.delegation_revision, table.published_at, table.publication_id),
    work_idx: index("execution_approval_publications_work_idx").on(table.room_agent_work_attempt_id),
    expiry_idx: index("execution_approval_publications_expiry_idx").on(table.expires_at),
    delegation_revision_check: check(
      "execution_approval_publications_delegation_revision_check",
      sql`${table.delegation_revision} >= 1`,
    ),
    request_version_check: check(
      "execution_approval_publications_request_version_check",
      sql`${table.request_version} >= 1`,
    ),
    request_digest_check: check(
      "execution_approval_publications_request_digest_check",
      sql`${table.request_sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    projection_digest_check: check(
      "execution_approval_publications_projection_digest_check",
      sql`${table.projection_sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    publication_digest_check: check(
      "execution_approval_publications_publication_digest_check",
      sql`${table.publication_digest} ~ '^[0-9a-f]{64}$'`,
    ),
    projection_size_check: check(
      "execution_approval_publications_projection_size_check",
      sql`octet_length(${table.projection_json}) <= 24576`,
    ),
    expiry_check: check(
      "execution_approval_publications_expiry_check",
      sql`${table.expires_at} > ${table.produced_at} AND ${table.expires_at} > ${table.published_at}`,
    ),
    closure_check: check(
      "execution_approval_publications_closure_check",
      sql`${table.closed_at} IS NULL OR ${table.closed_at} >= ${table.published_at}`,
    ),
  }),
);
