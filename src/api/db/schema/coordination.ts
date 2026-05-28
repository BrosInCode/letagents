import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
