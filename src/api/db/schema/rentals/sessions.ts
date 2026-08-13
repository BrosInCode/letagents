import {
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { accounts, rooms } from "../core.js";
import {
  rentalContinuityModeEnum,
  rentalModeEnum,
  rentalSessionStatusEnum,
  rentalStartTriggerEnum,
  rentalTriggerConfidenceEnum,
} from "./enums.js";
import { rental_listings } from "./listings.js";
import { rental_provider_hosts } from "./provider-hosts.js";

export const rental_sessions = pgTable(
  "rental_sessions",
  {
    id: text("id").primaryKey(),
    listing_id: text("listing_id").notNull(),
    renter_account_id: text("renter_account_id").notNull(),
    provider_account_id: text("provider_account_id").notNull(),
    target_room_id: text("target_room_id"),
    room_id: text("room_id"),
    room_placement: text("room_placement").notNull().default("legacy_child"),
    room_history_access: text("room_history_access").notNull().default("filtered"),
    capability_envelope: jsonb("capability_envelope"),
    repo_provider: text("repo_provider").default("github"),
    repo_owner: text("repo_owner"),
    repo_name: text("repo_name"),
    base_branch: text("base_branch"),
    work_branch: text("work_branch"),
    task_title: text("task_title").notNull(),
    task_prompt: text("task_prompt").notNull(),
    mode: rentalModeEnum("mode").notNull().default("scoped"),
    continuity_mode: rentalContinuityModeEnum("continuity_mode")
      .notNull()
      .default("smart_handoff"),
    continuity_pack: jsonb("continuity_pack"),
    status: rentalSessionStatusEnum("status").notNull().default("requested"),
    approved_scope: jsonb("approved_scope"),
    policy: jsonb("policy"),
    provider_host_id: text("provider_host_id").references(() => rental_provider_hosts.id, {
      onDelete: "set null",
    }),
    selected_runtime: jsonb("selected_runtime").$type<{
      kind: string;
      modelLabel?: string;
      permissionProfileId?: string;
    }>(),
    launch_attempt: integer("launch_attempt").notNull().default(0),
    launch_state: text("launch_state"),
    daemon_entry_id: text("daemon_entry_id"),
    room_agent_session_id: text("room_agent_session_id"),
    launch_error_code: text("launch_error_code"),
    launch_error_message: text("launch_error_message"),
    initial_task_message_id: text("initial_task_message_id"),
    request_expires_at: timestamp("request_expires_at", { withTimezone: true }),
    quota_lease: jsonb("quota_lease"),
    native_quota_unit: text("native_quota_unit"),
    native_quota_start_snapshot: jsonb("native_quota_start_snapshot"),
    native_quota_latest_snapshot: jsonb("native_quota_latest_snapshot"),
    meter_confidence: text("meter_confidence"),
    lrt_limit: integer("lrt_limit"),
    lrt_reserved: integer("lrt_reserved").notNull().default(0),
    lrt_used: integer("lrt_used").notNull().default(0),
    budget_stop_threshold: numeric("budget_stop_threshold"),
    time_limit_minutes: integer("time_limit_minutes"),
    start_trigger: rentalStartTriggerEnum("start_trigger"),
    trigger_confidence: rentalTriggerConfidenceEnum("trigger_confidence"),
    renter_lane_exhausted_at: timestamp("renter_lane_exhausted_at", {
      withTimezone: true,
    }),
    renter_lane_provider: text("renter_lane_provider"),
    renter_lane_model: text("renter_lane_model"),
    renter_lane_refresh_eta: timestamp("renter_lane_refresh_eta", {
      withTimezone: true,
    }),
    renter_quota_signal: jsonb("renter_quota_signal"),
    renter_lane_recovered_at: timestamp("renter_lane_recovered_at", {
      withTimezone: true,
    }),
    heartbeat_count: integer("heartbeat_count").notNull().default(0),
    last_heartbeat_at: timestamp("last_heartbeat_at", { withTimezone: true }),
    started_at: timestamp("started_at", { withTimezone: true }),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "rental_sessions_listing_fk",
      columns: [table.listing_id],
      foreignColumns: [rental_listings.id],
    }),
    foreignKey({
      name: "rental_sessions_target_room_fk",
      columns: [table.target_room_id],
      foreignColumns: [rooms.id as AnyPgColumn],
    }).onUpdate("cascade"),
    foreignKey({
      name: "rental_sessions_renter_fk",
      columns: [table.renter_account_id],
      foreignColumns: [accounts.id as AnyPgColumn],
    }),
    foreignKey({
      name: "rental_sessions_provider_fk",
      columns: [table.provider_account_id],
      foreignColumns: [accounts.id as AnyPgColumn],
    }),
    foreignKey({
      name: "rental_sessions_room_fk",
      columns: [table.room_id],
      foreignColumns: [rooms.id as AnyPgColumn],
    }).onUpdate("cascade"),
    index("rental_sessions_listing_id_idx").on(table.listing_id),
    index("rental_sessions_renter_account_id_idx").on(table.renter_account_id),
    index("rental_sessions_provider_account_id_idx").on(table.provider_account_id),
    index("rental_sessions_room_id_idx").on(table.room_id),
    index("rental_sessions_provider_host_id_idx").on(table.provider_host_id),
    index("rental_sessions_target_room_id_idx").on(table.target_room_id),
    index("rental_sessions_renter_lane_exhausted_idx").on(
      table.renter_account_id,
      table.renter_lane_exhausted_at,
    ),
  ],
);
