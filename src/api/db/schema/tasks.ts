import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { TaskWorkflowArtifact } from "../../repo-workflow.js";

import { room_agent_sessions } from "./agents.js";
import { rooms } from "./core.js";
import { taskLeaseKindEnum, taskLeaseStatusEnum, taskLockReasonEnum, taskLockScopeEnum, taskStatusEnum } from "./enums.js";

export const tasks = pgTable(
  "tasks",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatusEnum("status").notNull().default("proposed"),
    assignee: text("assignee"),
    assignee_agent_key: text("assignee_agent_key"),
    created_by: text("created_by").notNull(),
    source_message_id: text("source_message_id"),
    client_task_id: text("client_task_id"),
    pr_url: text("pr_url"),
    workflow_artifacts: jsonb("workflow_artifacts")
      .$type<TaskWorkflowArtifact[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "tasks_pk", columns: [table.room_id, table.number] }),
    room_idx: index("tasks_room_id_idx").on(table.room_id),
    status_idx: index("tasks_status_idx").on(table.status),
    room_assignee_key_idx: index("tasks_room_assignee_agent_key_idx").on(
      table.room_id,
      table.assignee_agent_key
    ),
    room_source_message_id_unique_idx: uniqueIndex("tasks_room_source_message_id_unique_idx")
      .on(table.room_id, table.source_message_id)
      .where(sql`${table.source_message_id} IS NOT NULL AND ${table.client_task_id} IS NULL`),
    room_client_task_id_unique_idx: uniqueIndex("tasks_room_client_task_id_unique_idx")
      .on(table.room_id, table.client_task_id)
      .where(sql`${table.client_task_id} IS NOT NULL`),
  })
);

export const task_leases = pgTable(
  "task_leases",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    task_id: text("task_id").notNull(),
    kind: taskLeaseKindEnum("kind").notNull(),
    status: taskLeaseStatusEnum("status").notNull().default("active"),
    agent_key: text("agent_key").notNull(),
    agent_instance_id: text("agent_instance_id"),
    agent_session_id: text("agent_session_id").references(() => room_agent_sessions.session_id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    actor_label: text("actor_label").notNull(),
    // Monotonic rebind fence (plan §4.5). Incremented on every fenced rebind;
    // every lease-guarded write must present the epoch it last observed.
    epoch: integer("epoch").notNull().default(0),
    branch_ref: text("branch_ref"),
    pr_url: text("pr_url"),
    output_intent: text("output_intent"),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }),
    last_heartbeat_at: timestamp("last_heartbeat_at", { mode: "string", withTimezone: true }),
    revoked_reason: text("revoked_reason"),
    created_by: text("created_by").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    room_task_idx: index("task_leases_room_task_idx").on(table.room_id, table.task_id),
    room_agent_idx: index("task_leases_room_agent_idx").on(table.room_id, table.agent_key),
    room_agent_session_idx: index("task_leases_room_agent_session_idx").on(table.room_id, table.agent_session_id),
    active_work_task_idx: uniqueIndex("task_leases_active_work_task_idx")
      .on(table.room_id, table.task_id)
      .where(sql`${table.kind} = 'work' AND ${table.status} = 'active'`),
    active_review_agent_idx: uniqueIndex("task_leases_active_review_agent_idx")
      .on(table.room_id, table.task_id, table.agent_key)
      .where(sql`${table.kind} = 'review' AND ${table.status} = 'active'`),
  })
);

export const stale_task_prompt_mutes = pgTable(
  "stale_task_prompt_mutes",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    task_id: text("task_id").notNull(),
    task_updated_at: timestamp("task_updated_at", { mode: "string", withTimezone: true }).notNull(),
    muted_by: text("muted_by").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ name: "stale_task_prompt_mutes_pk", columns: [table.room_id, table.task_id] }),
    room_idx: index("stale_task_prompt_mutes_room_idx").on(table.room_id, table.updated_at),
  })
);

export const task_locks = pgTable(
  "task_locks",
  {
    id: text("id").primaryKey(),
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    task_id: text("task_id"),
    scope: taskLockScopeEnum("scope").notNull(),
    reason: taskLockReasonEnum("reason").notNull(),
    message: text("message"),
    created_by: text("created_by").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
    cleared_by: text("cleared_by"),
    cleared_at: timestamp("cleared_at", { mode: "string", withTimezone: true }),
  },
  (table) => ({
    room_scope_idx: index("task_locks_room_scope_idx").on(table.room_id, table.scope),
    room_task_idx: index("task_locks_room_task_idx").on(table.room_id, table.task_id),
    active_room_idx: index("task_locks_active_room_idx")
      .on(table.room_id)
      .where(sql`${table.scope} = 'room' AND ${table.cleared_at} IS NULL`),
    active_task_idx: index("task_locks_active_task_idx")
      .on(table.room_id, table.task_id)
      .where(sql`${table.scope} = 'task' AND ${table.cleared_at} IS NULL`),
    scope_task_check: check(
      "task_locks_scope_task_check",
      sql`(
        ${table.scope} = 'room'
        AND ${table.task_id} IS NULL
      ) OR (
        ${table.scope} = 'task'
        AND ${table.task_id} IS NOT NULL
      )`
    ),
  })
);
