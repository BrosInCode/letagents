import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { supervisor_host_grants } from "./agents.js";
import { rooms } from "./core.js";
import { coordinationDecisionEnum } from "./enums.js";
import { task_leases, task_locks } from "./tasks.js";

export interface CoordinationEventMetadata {
  [key: string]: unknown;
}

export const coordination_events = pgTable(
  "coordination_events",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    task_id: text("task_id"),
    lease_id: text("lease_id")
      .references(() => task_leases.id, { onDelete: "set null", onUpdate: "cascade" }),
    lock_id: text("lock_id")
      .references(() => task_locks.id, { onDelete: "set null", onUpdate: "cascade" }),
    event_type: text("event_type").notNull(),
    decision: coordinationDecisionEnum("decision").notNull().default("record"),
    actor_label: text("actor_label"),
    actor_key: text("actor_key"),
    actor_instance_id: text("actor_instance_id"),
    reason: text("reason"),
    metadata: jsonb("metadata").$type<CoordinationEventMetadata>(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_task_idx: index("coordination_events_room_task_idx").on(table.room_id, table.task_id),
    room_created_idx: index("coordination_events_room_created_idx").on(
      table.room_id,
      table.created_at
    ),
    lease_idx: index("coordination_events_lease_idx").on(table.lease_id),
    lock_idx: index("coordination_events_lock_idx").on(table.lock_id),
  })
);

// Terminal rebind attestation (plan §4.5). A fenced supervisor persists one row
// here per predecessor execution it observed as dead; rebindTaskLease consumes
// exactly one un-consumed row for the {lease_id, epoch, from_agent_session_id}
// tuple in the same transaction, so a single observed termination authorizes at
// most one rebind. The partial unique index keeps at most one un-consumed row
// per predecessor tuple; evidence is immutable (insert-or-identical, conflicting
// retries are refused) and consumed rows are retained as an audit trail. The
// CHECKs anchor the evidence invariants in the database itself: observed-exit
// causes only, nonnegative epoch, positive grant generation, and consumed_at
// set exactly when consumed_by_epoch records the (strictly higher) new epoch.
export const task_lease_rebind_attestations = pgTable(
  "task_lease_rebind_attestations",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    lease_id: text("lease_id")
      .notNull()
      .references(() => task_leases.id, { onDelete: "cascade", onUpdate: "cascade" }),
    epoch: integer("epoch").notNull(),
    from_agent_session_id: text("from_agent_session_id").notNull(),
    grant_id: text("grant_id")
      .notNull()
      .references(() => supervisor_host_grants.grant_id, { onDelete: "cascade", onUpdate: "cascade" }),
    supervisor_generation: integer("supervisor_generation").notNull(),
    work_attempt_id: text("work_attempt_id").notNull(),
    execution_generation_id: text("execution_generation_id").notNull(),
    cause: text("cause").notNull(),
    attested_at: timestamp("attested_at", { mode: "string", withTimezone: true }).notNull(),
    consumed_at: timestamp("consumed_at", { mode: "string", withTimezone: true }),
    consumed_by_epoch: integer("consumed_by_epoch"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    unconsumed_idx: uniqueIndex("task_lease_rebind_attestations_unconsumed_idx")
      .on(table.lease_id, table.epoch, table.from_agent_session_id)
      .where(sql`${table.consumed_at} IS NULL`),
    lease_idx: index("task_lease_rebind_attestations_lease_idx").on(table.lease_id),
    cause_check: check(
      "task_lease_rebind_attestations_cause_check",
      sql`${table.cause} IN ('exited', 'killed', 'stopped', 'crashed', 'protocol_error')`,
    ),
    epoch_check: check("task_lease_rebind_attestations_epoch_check", sql`${table.epoch} >= 0`),
    generation_check: check(
      "task_lease_rebind_attestations_generation_check",
      sql`${table.supervisor_generation} > 0`,
    ),
    consumed_coupling_check: check(
      "task_lease_rebind_attestations_consumed_coupling_check",
      sql`(${table.consumed_at} IS NULL) = (${table.consumed_by_epoch} IS NULL)`,
    ),
    consumed_epoch_check: check(
      "task_lease_rebind_attestations_consumed_epoch_check",
      sql`${table.consumed_by_epoch} IS NULL OR ${table.consumed_by_epoch} > ${table.epoch}`,
    ),
  })
);
