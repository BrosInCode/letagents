import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { rooms } from "./core.js";
import { task_leases } from "./tasks.js";

export const workflow_effects = pgTable(
  "workflow_effects",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    task_id: text("task_id").notNull(),
    lease_id: text("lease_id")
      .notNull()
      .references(() => task_leases.id, { onDelete: "restrict", onUpdate: "cascade" }),
    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    idempotency_key: text("idempotency_key").notNull(),
    correlation_key: text("correlation_key").notNull(),
    request_fingerprint: text("request_fingerprint").notNull(),
    request_payload: jsonb("request_payload").$type<Record<string, unknown>>().notNull(),
    state: text("state").notNull().default("pending"),
    attempt_count: integer("attempt_count").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(3),
    processing_token: text("processing_token"),
    processing_started_at: timestamp("processing_started_at", { mode: "string", withTimezone: true }),
    next_attempt_at: timestamp("next_attempt_at", { mode: "string", withTimezone: true }),
    external_id: text("external_id"),
    external_url: text("external_url"),
    response_payload: jsonb("response_payload").$type<Record<string, unknown>>(),
    last_error: text("last_error"),
    quarantined_at: timestamp("quarantined_at", { mode: "string", withTimezone: true }),
    quarantine_reason: text("quarantine_reason"),
    created_by: text("created_by").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
    completed_at: timestamp("completed_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    room_idempotency_unique: uniqueIndex("workflow_effects_room_idempotency_uq")
      .on(table.room_id, table.idempotency_key),
    provider_correlation_unique: uniqueIndex("workflow_effects_provider_correlation_uq")
      .on(table.provider, table.correlation_key),
    reconciliation_idx: index("workflow_effects_reconciliation_idx")
      .on(table.state, table.updated_at),
    schedule_idx: index("workflow_effects_schedule_idx")
      .on(table.state, table.next_attempt_at, table.processing_started_at),
    retention_idx: index("workflow_effects_retention_idx")
      .on(table.updated_at)
      .where(sql`${table.state} = 'succeeded' OR (${table.state} = 'failed' AND ${table.attempt_count} >= ${table.max_attempts}) OR ${table.quarantined_at} IS NOT NULL`),
    task_idx: index("workflow_effects_room_task_idx").on(table.room_id, table.task_id),
    state_check: check("workflow_effects_state_check", sql`${table.state} IN ('pending', 'succeeded', 'failed', 'ambiguous')`),
    kind_check: check("workflow_effects_kind_check", sql`${table.kind} IN ('github_review_verdict')`),
    provider_check: check("workflow_effects_provider_check", sql`${table.provider} IN ('github')`),
    attempt_count_check: check("workflow_effects_attempt_count_check", sql`${table.attempt_count} >= 0 AND ${table.attempt_count} <= ${table.max_attempts}`),
    max_attempts_check: check("workflow_effects_max_attempts_check", sql`${table.max_attempts} > 0`),
    processing_coupling_check: check("workflow_effects_processing_coupling_check", sql`(${table.processing_token} IS NULL) = (${table.processing_started_at} IS NULL)`),
    success_evidence_check: check("workflow_effects_success_evidence_check", sql`${table.state} <> 'succeeded' OR (${table.external_id} IS NOT NULL AND ${table.completed_at} IS NOT NULL)`),
    quarantine_coupling_check: check("workflow_effects_quarantine_coupling_check", sql`(${table.quarantined_at} IS NULL) = (${table.quarantine_reason} IS NULL)`),
  }),
);
