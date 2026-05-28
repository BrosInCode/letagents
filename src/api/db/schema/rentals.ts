import { boolean, foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";

import { accounts, rooms } from "./core.js";

export const rentalVisibilityEnum = pgEnum("rental_visibility", [
  "rental_visible",
  "renter_only",
  "provider_only",
  "internal",
]);
export const rentalListingStatusEnum = pgEnum("rental_listing_status", [
  "active",
  "paused",
  "disabled",
  "setup_required",
]);
export const rentalVerificationStatusEnum = pgEnum("rental_verification_status", [
  "verified",
  "partially_verified",
  "experimental",
  "unreachable",
]);
export const rentalMeterConfidenceEnum = pgEnum("rental_meter_confidence", [
  "official_exact",
  "local_exact",
  "derived",
  "calibrated",
  "estimated",
  "weak_estimate",
  "unknown",
]);
export const rentalNativeQuotaUnitEnum = pgEnum("rental_native_quota_unit", [
  "tokens",
  "credits",
  "usd",
  "requests",
  "percent_window",
  "time",
  "unknown",
]);

export const rental_listings = pgTable("rental_listings", {
  id: text("id").primaryKey(),
  provider_account_id: text("provider_account_id").notNull(),
  display_name: text("display_name").notNull(),
  status: rentalListingStatusEnum("status").notNull().default("setup_required"),
  verification_status: rentalVerificationStatusEnum("verification_status")
    .notNull()
    .default("experimental"),
  readiness_badges: jsonb("readiness_badges").$type<string[]>().default([]),
  ide_kind: text("ide_kind").notNull(),
  model_label: text("model_label"),
  quota_lane_id: text("quota_lane_id"),
  quota_lane_label: text("quota_lane_label"),
  meter_confidence: rentalMeterConfidenceEnum("meter_confidence")
    .notNull()
    .default("unknown"),
  native_quota_unit: rentalNativeQuotaUnitEnum("native_quota_unit")
    .notNull()
    .default("unknown"),
  last_native_quota_snapshot: jsonb("last_native_quota_snapshot"),
  last_lrt_estimate: integer("last_lrt_estimate"),
  last_quota_reset_at: timestamp("last_quota_reset_at", { withTimezone: true }),
  verified_agent_fingerprint_id: text("verified_agent_fingerprint_id"),
  supported_modes: jsonb("supported_modes")
    .$type<string[]>()
    .notNull()
    .default(["scoped"]),
  max_concurrent_sessions: integer("max_concurrent_sessions").notNull().default(1),
  default_lrt_limit: integer("default_lrt_limit"),
  default_time_limit_minutes: integer("default_time_limit_minutes"),
  manual_accept_required: boolean("manual_accept_required").notNull().default(true),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rentalSessionStatusEnum = pgEnum("rental_session_status", [
  "requested",
  "accepted",
  "provisioning",
  "active",
  "blocked",
  "patch_review",
  "pr_opened",
  "budget_exhausted",
  "stale",
  "completed",
  "cancelled",
  "expired",
  "failed",
]);
export const rentalModeEnum = pgEnum("rental_mode", [
  "scoped",
  "trusted_open",
]);
export const rentalContinuityModeEnum = pgEnum("rental_continuity_mode", [
  "smart_handoff",
  "full_transcript",
]);
export const rentalStartTriggerEnum = pgEnum("rental_start_trigger", [
  "quota_exhausted",
  "user_initiated",
  "scheduled",
  "task_handoff",
]);
export const rentalTriggerConfidenceEnum = pgEnum("rental_trigger_confidence", [
  "exact",
  "inferred",
  "manual",
]);

export const rental_sessions = pgTable(
  "rental_sessions",
  {
    id: text("id").primaryKey(),
    listing_id: text("listing_id").notNull(),
    renter_account_id: text("renter_account_id").notNull(),
    provider_account_id: text("provider_account_id").notNull(),
    room_id: text("room_id"),
    // Repo context
    repo_provider: text("repo_provider").notNull().default("github"),
    repo_owner: text("repo_owner").notNull(),
    repo_name: text("repo_name").notNull(),
    base_branch: text("base_branch").notNull(),
    work_branch: text("work_branch"),
    // Task
    task_title: text("task_title").notNull(),
    task_prompt: text("task_prompt").notNull(),
    // Mode + continuity (§5, D3)
    mode: rentalModeEnum("mode").notNull().default("scoped"),
    continuity_mode: rentalContinuityModeEnum("continuity_mode")
      .notNull()
      .default("smart_handoff"),
    continuity_pack: jsonb("continuity_pack"),
    // Status
    status: rentalSessionStatusEnum("status").notNull().default("requested"),
    // Scope + policy
    approved_scope: jsonb("approved_scope"),
    policy: jsonb("policy"),
    // Quota/budget
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
    // D3 — Renter trigger context
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
    // Heartbeat / liveness (§18.3)
    heartbeat_count: integer("heartbeat_count").notNull().default(0),
    last_heartbeat_at: timestamp("last_heartbeat_at", { withTimezone: true }),
    // Timestamps
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
    // Foreign keys
    foreignKey({
      name: "rental_sessions_listing_fk",
      columns: [table.listing_id],
      foreignColumns: [rental_listings.id],
    }),
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
    }),
    // Indexes
    index("rental_sessions_listing_id_idx").on(table.listing_id),
    index("rental_sessions_renter_account_id_idx").on(table.renter_account_id),
    index("rental_sessions_provider_account_id_idx").on(
      table.provider_account_id
    ),
    index("rental_sessions_room_id_idx").on(table.room_id),
    index("rental_sessions_renter_lane_exhausted_idx").on(
      table.renter_account_id,
      table.renter_lane_exhausted_at
    ),
  ]
);

export const rentalActivitySourceEnum = pgEnum("rental_activity_source", [
  "agent",
  "tool",
  "patch_gate",
  "system",
  "renter",
  "provider",
]);

/**
 * Source of a `rental_usage_meters` row per spec §19.6:
 *   adapter      — desktop-side meter adapter snapshot
 *   tool         — MCP `rental_report_usage` call
 *   self_reported — rented agent's own usage claim (lower trust)
 *   system       — server-side bookkeeping (Budget Sentinel, reconciler)
 */
export const rentalUsageMeterSourceEnum = pgEnum("rental_usage_meter_source", [
  "adapter",
  "tool",
  "self_reported",
  "system",
]);

export const rentalPatchProposalSourceEnum = pgEnum("rental_patch_proposal_source", [
  "signed_change_journal",
  "explicit_patch",
  "raw_diff",
]);

export const rentalPatchGateStatusEnum = pgEnum("rental_patch_gate_status", [
  "pending",
  "passed",
  "passed_with_warnings",
  "needs_renter_approval",
  "rejected",
  "needs_revision",
  "timed_out",
]);

export const rental_activity_events = pgTable(
  "rental_activity_events",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    room_id: text("room_id").notNull(),
    event_type: text("event_type").notNull(),
    source: rentalActivitySourceEnum("source").notNull(),
    verified: boolean("verified").notNull().default(false),
    visibility: rentalVisibilityEnum("visibility")
      .notNull()
      .default("rental_visible"),
    payload: jsonb("payload").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Foreign keys
    foreignKey({
      name: "rental_activity_events_session_fk",
      columns: [table.session_id],
      foreignColumns: [rental_sessions.id],
    }),
    foreignKey({
      name: "rental_activity_events_room_fk",
      columns: [table.room_id],
      foreignColumns: [rooms.id as AnyPgColumn],
    }),
    // Indexes
    index("rental_activity_events_session_id_idx").on(table.session_id),
    index("rental_activity_events_room_id_idx").on(table.room_id),
    index("rental_activity_events_event_type_idx").on(table.event_type),
  ]
);

/**
 * Patch proposals and Signed Change Journal entries for Patch Gate.
 *
 * Each row is idempotent per (session_id, idempotency_key). For
 * `source=signed_change_journal`, `journal_entry` stores the accepted
 * tool-mediated edit that Patch Gate can later reconstruct into a diff.
 * Explicit patches use `diff_ref` for a server-side diff blob/reference.
 */
export const rental_patch_proposals = pgTable(
  "rental_patch_proposals",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    source: rentalPatchProposalSourceEnum("source").notNull(),
    diff_ref: text("diff_ref"),
    summary: text("summary"),
    gate_status: rentalPatchGateStatusEnum("gate_status")
      .notNull()
      .default("pending"),
    risk_score: integer("risk_score"),
    warnings: jsonb("warnings").$type<Record<string, unknown>[]>().notNull().default([]),
    check_results: jsonb("check_results").$type<Record<string, unknown>>().notNull().default({}),
    journal_entry: jsonb("journal_entry").$type<Record<string, unknown>>(),
    idempotency_key: text("idempotency_key").notNull(),
    request_hash: text("request_hash").notNull(),
    response_hash: text("response_hash").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "rental_patch_proposals_session_fk",
      columns: [table.session_id],
      foreignColumns: [rental_sessions.id],
    }),
    index("rental_patch_proposals_session_id_idx").on(table.session_id),
    index("rental_patch_proposals_gate_status_idx").on(table.gate_status),
    uniqueIndex("rental_patch_proposals_session_idempotency_uq").on(
      table.session_id,
      table.idempotency_key,
    ),
  ],
);

/**
 * Per-session meter snapshots reported by desktop adapters / MCP tools.
 *
 * Spec §19.6. Each row is one observation: a NativeQuotaSnapshot from
 * a p2.3 adapter combined with the UsageDelta since the prior row, the
 * resulting LRT delta + running total, and the confidence the adapter
 * had in the reading. Idempotent on (session_id, idempotency_key) so
 * retried writes from a flaky desktop process don't double-count.
 *
 * Numeric fields default to 0 so a "no movement" reading still rolls up
 * cleanly; native_* fields are nullable because not every IDE exposes
 * every native unit.
 */
export const rental_usage_meters = pgTable(
  "rental_usage_meters",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    source: rentalUsageMeterSourceEnum("source").notNull(),
    // Native quota fields — nullable; populated only when the adapter
    // reports them. native_unit is text not enum because some adapters
    // expose multiple unit signals in one snapshot.
    native_unit: text("native_unit"),
    native_used: numeric("native_used"),
    native_remaining: numeric("native_remaining"),
    native_reset_at: timestamp("native_reset_at", { withTimezone: true }),
    // Token deltas — default 0 so summing is safe even when a unit is absent.
    input_tokens: integer("input_tokens").notNull().default(0),
    output_tokens: integer("output_tokens").notNull().default(0),
    cache_creation_tokens: integer("cache_creation_tokens").notNull().default(0),
    cache_read_tokens: integer("cache_read_tokens").notNull().default(0),
    reasoning_tokens: integer("reasoning_tokens").notNull().default(0),
    requests_used: integer("requests_used").notNull().default(0),
    credits_used: numeric("credits_used"),
    usd_used: numeric("usd_used"),
    // LRT bookkeeping — Budget Sentinel reads `lrt_total` to gate work.
    lrt_delta: integer("lrt_delta").notNull().default(0),
    lrt_total: integer("lrt_total").notNull().default(0),
    confidence: rentalMeterConfidenceEnum("confidence").notNull(),
    adapter_payload: jsonb("adapter_payload"),
    // Activity counters mirrored onto the meter for cheap reads.
    tool_call_count: integer("tool_call_count").notNull().default(0),
    command_run_count: integer("command_run_count").notNull().default(0),
    files_exposed_count: integer("files_exposed_count").notNull().default(0),
    heartbeat_count: integer("heartbeat_count").notNull().default(0),
    last_heartbeat_at: timestamp("last_heartbeat_at", { withTimezone: true }),
    // Idempotency: a duplicate report with the same key is a no-op.
    // Unique per (session_id, idempotency_key) — see uniqueIndex below.
    idempotency_key: text("idempotency_key").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "rental_usage_meters_session_fk",
      columns: [table.session_id],
      foreignColumns: [rental_sessions.id],
    }),
    // Cheap session-scoped lookups for Budget Sentinel.
    index("rental_usage_meters_session_id_idx").on(table.session_id),
    // Idempotency guard — duplicate reports from a flaky desktop process
    // hit this and the route returns the existing row.
    uniqueIndex("rental_usage_meters_session_idempotency_uq").on(
      table.session_id,
      table.idempotency_key,
    ),
    // Last-snapshot-per-session reads (Budget Sentinel pre-step + UI).
    index("rental_usage_meters_session_created_idx").on(
      table.session_id,
      table.created_at,
    ),
  ],
);

// ===== RENTAL (Phase 4) =====
export const rentalWorkspaceRetentionStatusEnum = pgEnum(
  "rental_workspace_retention_status",
  ["active", "archived", "expired", "deleted"],
);

/**
 * Workspace manifest per spec §10.6.
 *
 * Records the materialized workspace for a rental session: the git
 * base commit, the disposable work branch, which scope globs were
 * applied, and retention lifecycle timestamps. The materializer
 * creates a row when the workspace is first set up; the retention
 * service marks it expired/deleted when TTL elapses.
 */
export const rental_workspace_manifests = pgTable(
  "rental_workspace_manifests",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    /** SHA of the base commit used for materialization. */
    base_commit_sha: text("base_commit_sha").notNull(),
    /** Disposable work branch created for the rental. */
    work_branch: text("work_branch").notNull(),
    /**
     * JSON array of minimatch glob patterns that define what files
     * are exposed into the rental workspace. Empty array = full repo.
     */
    scope_globs: jsonb("scope_globs").notNull().default([]),
    /** Absolute path to the materialized workspace directory. */
    workspace_path: text("workspace_path"),
    /** Number of files materialized into the workspace. */
    files_materialized: integer("files_materialized").notNull().default(0),
    /** Total bytes of materialized files. */
    bytes_materialized: integer("bytes_materialized").notNull().default(0),
    retention_status: rentalWorkspaceRetentionStatusEnum("retention_status")
      .notNull()
      .default("active"),
    materialized_at: timestamp("materialized_at", { withTimezone: true }),
    /** When the workspace should be cleaned up. */
    expires_at: timestamp("expires_at", { withTimezone: true }),
    /** When the workspace was actually deleted from disk. */
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "rental_workspace_manifests_session_fk",
      columns: [table.session_id],
      foreignColumns: [rental_sessions.id],
    }),
    index("rental_workspace_manifests_session_id_idx").on(table.session_id),
    index("rental_workspace_manifests_retention_idx").on(
      table.retention_status,
      table.expires_at,
    ),
  ],
);

// ===== RENTAL (Phase 4 — Workspace Exposures) =====
export const rentalExposureTypeEnum = pgEnum("rental_exposure_type", [
  "file",
  "search_result",
  "directory_listing",
  "command_output",
]);

export const rentalSecretScanStatusEnum = pgEnum("rental_secret_scan_status", [
  "passed",
  "redacted",
  "blocked",
]);

/**
 * Workspace exposure ledger per spec §19.4.
 *
 * Records every file or context fragment exposed to the provider
 * agent during a rental session. Used by:
 * - Patch Gate: validates edits only touch exposed files
 * - Renter UI: shows what was shared
 * - Audit: post-session disclosure record
 */
export const rental_workspace_exposures = pgTable(
  "rental_workspace_exposures",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    /** Relative path within the workspace. */
    path: text("path").notNull(),
    exposure_type: rentalExposureTypeEnum("exposure_type").notNull(),
    /** Why this file was exposed (e.g. "scope glob match", "renter approved"). */
    reason: text("reason"),
    /** Number of secret values redacted before exposure. */
    redaction_count: integer("redaction_count").notNull().default(0),
    /** Result of the Secret Firewall scan. */
    secret_scan_status: rentalSecretScanStatusEnum("secret_scan_status")
      .notNull()
      .default("passed"),
    /** Who requested this exposure (agent key or "system"). */
    requested_by: text("requested_by"),
    /** Who approved it (renter account ID, "auto", or null if auto-approved). */
    approved_by: text("approved_by"),
    /** Scope ID linking to the workspace manifest scope_globs entry. */
    scope_id: text("scope_id"),
    /** File size in bytes at time of exposure. */
    bytes_exposed: integer("bytes_exposed").notNull().default(0),
    /** SHA-256 hash of the exposed content (for diff auditing). */
    content_hash: text("content_hash"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "rental_workspace_exposures_session_fk",
      columns: [table.session_id],
      foreignColumns: [rental_sessions.id],
    }),
    index("rental_workspace_exposures_session_id_idx").on(table.session_id),
    index("rental_workspace_exposures_session_path_idx").on(
      table.session_id,
      table.path,
    ),
  ],
);
