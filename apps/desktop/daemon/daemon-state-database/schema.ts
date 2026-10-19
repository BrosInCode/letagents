/** The DaemonStateSchema class: constructor, createSchema dispatch and method composition. */
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, applyAgentImageInputColumn, applyAgentLiveSharingColumn, applyDaemonEfficiencyMigration, retireDesktopEventsDelivery, type Row } from "./shared.js";
import { assertDaemonStateVersionSupported } from "./version-gate.js";
import { migrationsV1ToV12 } from "./migrations-v1-v12.js";
import { migrationsV13ToV24 } from "./migrations-v13-v24.js";
import { storageMigrations } from "./storage-migrations.js";
import { runtimeBirthRepairs } from "./runtime-birth-repairs.js";
import { shapesV11V12 } from "./shapes-v11-v12.js";
import { shapesV13ToV16 } from "./shapes-v13-v16.js";
import { shapesV17ToCurrent } from "./shapes-v17-current.js";
import { shapesV6ToV9 } from "./shapes-v6-v9.js";
import { shapesV4ToV7 } from "./shapes-v4-v7.js";
import { shapesV2V3 } from "./shapes-v2-v3.js";

type MigrationsV1ToV12 = typeof migrationsV1ToV12;
type MigrationsV13ToV24 = typeof migrationsV13ToV24;
type StorageMigrations = typeof storageMigrations;
type RuntimeBirthRepairs = typeof runtimeBirthRepairs;
type ShapesV11V12 = typeof shapesV11V12;
type ShapesV13ToV16 = typeof shapesV13ToV16;
type ShapesV17ToCurrent = typeof shapesV17ToCurrent;
type ShapesV6ToV9 = typeof shapesV6ToV9;
type ShapesV4ToV7 = typeof shapesV4ToV7;
type ShapesV2V3 = typeof shapesV2V3;

/** Owns the single daemon-state schema and all version transitions. */
export class DaemonStateSchema {
  constructor(
    readonly schemaInitializationHook?: (database: DatabaseSync) => void,
    /** Test-only interruption seam after v6 COMMIT, before physical scrub. */
    readonly postV6CommitBeforeScrubHook?: () => void,
    /** Test-only failure seam used to prove a pending scrub fails closed. */
    readonly beforeV6ScrubHook?: () => void,
    /** Test-only interruption seam after the v13 repair journal is backed up. */
    readonly afterV13RepairJournalBackupHook?: () => void,
  ) {}

createSchema(database: DatabaseSync): void {
  const existingVersion = assertDaemonStateVersionSupported(database);
  if (existingVersion !== 0) retireDesktopEventsDelivery(database);
  if (existingVersion === 1) {
    this.migrateV1ToV2(database);
    return;
  }
  if (existingVersion === 2) {
    this.migrateV2ToV3(database);
    return;
  }
  if (existingVersion === 3) {
    this.migrateV3ToV4(database);
    return;
  }
  if (existingVersion === 4) {
    this.migrateV4ToV5(database);
    return;
  }
  if (existingVersion === 5) {
    this.migrateV5ToV6(database);
    return;
  }
  if (existingVersion === 6) {
    this.migrateV6ToV7(database);
    return;
  }
  if (existingVersion === 7) {
    this.migrateV7ToV8(database);
    return;
  }
  if (existingVersion === 8) {
    this.migrateV8ToV9(database);
    return;
  }
  if (existingVersion === 9) {
    this.migrateV9ToV10(database);
    return;
  }
  if (existingVersion === 10) {
    this.migrateV10ToV11(database);
    return;
  }
  if (existingVersion === 11) {
    this.migrateV11ToV12(database);
    return;
  }
  if (existingVersion === 12) {
    this.migrateV12ToV13(database);
    return;
  }
  if (existingVersion === 13) {
    this.migrateV13ToV14(database);
    return;
  }
  if (existingVersion === 14) {
    this.migrateV14ToV15(database);
    return;
  }
  if (existingVersion === 15) {
    this.migrateV15ToV16(database);
    return;
  }
  if (existingVersion === 16) {
    this.migrateV16ToV17(database);
    return;
  }
  if (existingVersion === 17) {
    this.migrateV17ToV18(database);
    return;
  }
  if (existingVersion === 18) {
    this.migrateV18ToV19(database);
    return;
  }
  if (existingVersion === 19) {
    this.migrateV19ToV20(database);
    return;
  }
  if (existingVersion === 20) {
    this.migrateV20ToV21(database);
    return;
  }
  if (existingVersion === 21) {
    this.migrateV21ToV22(database);
    return;
  }
  if (existingVersion === 22) {
    this.migrateV22ToV23(database);
    return;
  }
  if (existingVersion === 23) {
    this.migrateV23ToV24(database);
    return;
  }
  if (existingVersion === 24 || existingVersion === 25) {
    this.migratePollingOfferStorage(database);
    return;
  }
  if (existingVersion === 26) {
    this.migrateRoomWorkPublicationStorage(database);
    return;
  }
  if (existingVersion === 27) {
    this.migrateLifecycleProjectionStorage(database);
    return;
  }
  if (existingVersion === 28) {
    this.migrateLegacyActiveRuntimeBirths(database);
    return;
  }
  if (existingVersion === 29) {
    this.migrateLifecycleEffectStorage(database);
    return;
  }
  if (existingVersion === 30) {
    this.migrateRuntimeFailureEffectStorage(database);
    return;
  }
  if (existingVersion === 31) {
    this.migrateLifecycleProjectionProviderSet(database);
    return;
  }
  if (existingVersion === 32) {
    this.migrateIncompatibleCodexRuntimeBirths(database);
    return;
  }
  if (existingVersion === 33) {
    this.migrateExecutionDelegationAuthorityStorage(database);
    return;
  }
  if (existingVersion === 34) {
    this.migrateExecutionApprovalProjectionStorage(database);
    return;
  }
  if (existingVersion >= 35 && existingVersion <= 41) {
    this.migrateExecutionApprovalPublicationStorage(database);
    return;
  }
  if (existingVersion >= 43 && existingVersion <= 50) {
    this.migrateHostToolRules(database);
    return;
  }
  if (existingVersion === 42) {
    this.migratePreparedRoomContext(database);
    return;
  }
  if (existingVersion !== 0 && existingVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported daemon state schema version ${existingVersion}.`);
  }
  if (existingVersion === SCHEMA_VERSION) {
    this.validateLocalRoomMembershipShape(database);
    this.repairAndValidateCurrentShape(database);
    return;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
    CREATE TABLE IF NOT EXISTS manifest_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL CHECK (generation >= 0),
      schema_version INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO manifest_metadata(singleton, generation, schema_version) VALUES (1, 0, ${SCHEMA_VERSION});

    CREATE TABLE IF NOT EXISTS migration_records (
      migration_key TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      imported_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS migration_failures (
      migration_key TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      failed_at TEXT NOT NULL,
      quarantined_path TEXT NOT NULL
    ) STRICT;

    -- Work-attempt authority lives in this same database.  The child tables
    -- are intentionally separate so checkpoint and terminal updates never
    -- rewrite unrelated attempts (or a JSON document).
    CREATE TABLE IF NOT EXISTS work_attempts (
      work_attempt_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      current_lease_epoch INTEGER NOT NULL,
      workspace_path TEXT NOT NULL UNIQUE,
      workspace_repo TEXT NOT NULL,
      workspace_remote_url TEXT NOT NULL,
      workspace_resolved_revision TEXT NOT NULL,
      workspace_bare_path TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      concluded_at TEXT,
      conclusion_cause TEXT,
      postmortem_diff TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS work_attempt_lease_epochs (
      work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      lease_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(work_attempt_id, sort_order)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS work_attempt_checkpoints (
      work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      at TEXT NOT NULL,
      room_cursor TEXT,
      provider_continuation_id TEXT,
      PRIMARY KEY(work_attempt_id, sort_order)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS work_attempt_executions (
      execution_generation_id TEXT PRIMARY KEY,
      work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      generation INTEGER NOT NULL,
      terminal_json TEXT,
      UNIQUE(work_attempt_id, generation)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_live_work_attempt_execution
      ON work_attempt_executions(work_attempt_id) WHERE terminal_json IS NULL;

    CREATE TABLE IF NOT EXISTS agent_identities (
      agent_id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_profiles (
      agent_id TEXT PRIMARY KEY REFERENCES agent_identities(agent_id) ON DELETE CASCADE,
      display_name TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_room_memberships (
      agent_id TEXT PRIMARY KEY REFERENCES agent_identities(agent_id) ON DELETE CASCADE,
      room_id TEXT NOT NULL,
      local_room_id TEXT CHECK (local_room_id IS NULL OR (length(trim(local_room_id)) > 0 AND local_room_id = room_id))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_configurations (
      agent_id TEXT PRIMARY KEY REFERENCES agent_identities(agent_id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT,
      charter TEXT NOT NULL,
      permission_profile_id TEXT,
      delivery_mode TEXT NOT NULL DEFAULT 'mcp_polling' CHECK (delivery_mode IN ('mcp_polling','daemon_inbox')),
      delivery_cutover_json TEXT,
      provider_launch_policy_present INTEGER NOT NULL CHECK (provider_launch_policy_present IN (0, 1)),
      provider_launch_policy_undefined INTEGER NOT NULL CHECK (provider_launch_policy_undefined IN (0, 1)),
      provider_launch_policy_json TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_launch_intents (
      agent_id TEXT PRIMARY KEY REFERENCES agent_identities(agent_id) ON DELETE CASCADE,
      desired_state TEXT NOT NULL,
      source_repo_path_present INTEGER NOT NULL CHECK (source_repo_path_present IN (0, 1)),
      source_repo_path TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS runtime_deployments (
      agent_id TEXT PRIMARY KEY REFERENCES agent_identities(agent_id) ON DELETE CASCADE,
      deployment_id TEXT UNIQUE,
      run_id TEXT,
      observed_state TEXT NOT NULL,
      workspace_path_present INTEGER NOT NULL CHECK (workspace_path_present IN (0, 1)),
      workspace_path TEXT,
      work_attempt_id_present INTEGER NOT NULL CHECK (work_attempt_id_present IN (0, 1)),
      work_attempt_id TEXT,
      provider_ref_present INTEGER NOT NULL CHECK (provider_ref_present IN (0, 1)),
      provider_work_attempt_id TEXT,
      provider_continuation_id TEXT,
      provider_connection_kind TEXT,
      provider_connection_url TEXT,
      provider_server_auth_path TEXT,
      provider_connection_pid INTEGER,
      provider_process_identity_present INTEGER NOT NULL CHECK (provider_process_identity_present IN (0, 1)),
      provider_process_identity TEXT,
      provider_execution_generation_id TEXT,
      workplace_liveness_present INTEGER NOT NULL CHECK (workplace_liveness_present IN (0, 1)),
      workplace_liveness_state TEXT,
      workplace_liveness_observed_at TEXT,
      workplace_liveness_detail TEXT,
      native_liveness_present INTEGER NOT NULL CHECK (native_liveness_present IN (0, 1)),
      native_liveness_state TEXT,
      native_liveness_observed_at TEXT,
      native_liveness_detail TEXT,
      activity_present INTEGER NOT NULL CHECK (activity_present IN (0, 1)),
      CHECK ((deployment_id IS NULL AND run_id IS NULL) OR (deployment_id IS NOT NULL AND run_id IS NOT NULL)),
      UNIQUE(agent_id, run_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS activity_events (
      agent_id TEXT NOT NULL REFERENCES runtime_deployments(agent_id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      method TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_truncated INTEGER NOT NULL CHECK (payload_truncated IN (0, 1)),
      payload_redacted INTEGER NOT NULL CHECK (payload_redacted IN (0, 1)),
      durable_payload_ref TEXT,
      PRIMARY KEY(agent_id, sort_order)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS agent_lifecycle_states (
      agent_id TEXT PRIMARY KEY REFERENCES agent_identities(agent_id) ON DELETE CASCADE,
      condition TEXT NOT NULL,
      last_error_present INTEGER NOT NULL CHECK (last_error_present IN (0, 1)),
      last_error TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_readiness (
      agent_id TEXT PRIMARY KEY REFERENCES agent_identities(agent_id) ON DELETE CASCADE,
      ready_reached_at_present INTEGER NOT NULL CHECK (ready_reached_at_present IN (0, 1)),
      ready_reached_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS turn_control_journals (
      agent_id TEXT PRIMARY KEY REFERENCES agent_identities(agent_id) ON DELETE CASCADE,
      turn_control_present INTEGER NOT NULL CHECK (turn_control_present IN (0, 1)),
      action_id TEXT,
      action_sequence INTEGER,
      turn_work_attempt_id TEXT,
      turn_execution_generation_id TEXT,
      target_room_id TEXT,
      target_source_message_id TEXT,
      target_provider_continuation_id TEXT,
      inbox_item_id TEXT,
      provider_turn_id TEXT,
      has_correction INTEGER,
      correction_text TEXT,
      correction_strategy TEXT CHECK (correction_strategy IS NULL OR correction_strategy IN ('native','stop_then_resend')),
      operator_resolution TEXT CHECK (operator_resolution IS NULL OR operator_resolution IN ('applied','not_applied')),
      status TEXT,
      capability TEXT,
      interrupted INTEGER,
      resumed INTEGER,
      turn_state TEXT,
      error TEXT,
      recorded_at TEXT,
      updated_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS turn_control_stages (
      agent_id TEXT NOT NULL REFERENCES turn_control_journals(agent_id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      stage TEXT NOT NULL,
      PRIMARY KEY(agent_id, sort_order)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS retained_worker_bindings (
      agent_id TEXT PRIMARY KEY REFERENCES agent_identities(agent_id) ON DELETE CASCADE,
      last_worker_binding_present INTEGER NOT NULL CHECK (last_worker_binding_present IN (0, 1)),
      binding_agent_session_id TEXT,
      binding_work_attempt_id TEXT,
      binding_execution_generation_id TEXT,
      binding_updated_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS reconciliation_records (
      agent_id TEXT PRIMARY KEY REFERENCES agent_identities(agent_id) ON DELETE CASCADE,
      reconciliation_present INTEGER NOT NULL CHECK (reconciliation_present IN (0, 1)),
      consecutive_action_failures INTEGER,
      last_observed_state TEXT,
      next_restart_at_ms INTEGER,
      last_action_sequence INTEGER,
      pending_action_id TEXT,
      pending_action_sequence INTEGER,
      pending_action_kind TEXT,
      pending_action_recorded_at_ms INTEGER,
      last_terminal_present INTEGER NOT NULL CHECK (last_terminal_present IN (0, 1)),
      terminal_ended_at TEXT,
      terminal_exit_code INTEGER,
      terminal_signal TEXT,
      terminal_stdio_archive_ref TEXT,
      terminal_stdio_tail TEXT,
      terminal_cause TEXT,
      terminal_actor TEXT,
      terminal_generation INTEGER,
      terminal_provider_continuation_id TEXT,
      reconciliation_notices_present INTEGER NOT NULL CHECK (reconciliation_notices_present IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS reconciliation_completed_actions (
      agent_id TEXT NOT NULL REFERENCES reconciliation_records(agent_id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      action_id TEXT NOT NULL,
      PRIMARY KEY(agent_id, sort_order)
    ) STRICT;
    -- Lifetime replay authority is intentionally separate from the bounded
    -- manifest projection. Targeted entry replacement deletes/reinserts the
    -- projection graph, but must never erase historical effect identity.
    CREATE TABLE IF NOT EXISTS reconciliation_action_tombstones (
      agent_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      PRIMARY KEY(agent_id, action_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS reconciliation_exit_timestamps (
      agent_id TEXT NOT NULL REFERENCES reconciliation_records(agent_id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      PRIMARY KEY(agent_id, sort_order)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS reconciliation_notices (
      agent_id TEXT NOT NULL REFERENCES reconciliation_records(agent_id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      cause TEXT NOT NULL,
      terminal_present INTEGER NOT NULL CHECK (terminal_present IN (0, 1)),
      terminal_ended_at TEXT,
      terminal_exit_code INTEGER,
      terminal_signal TEXT,
      terminal_stdio_archive_ref TEXT,
      terminal_stdio_tail TEXT,
      terminal_cause TEXT,
      terminal_actor TEXT,
      terminal_generation INTEGER,
      terminal_provider_continuation_id TEXT,
      PRIMARY KEY(agent_id, sort_order)
    ) STRICT;

    -- Unused since legacy provider lanes were retired. Kept for one release so
    -- an older daemon (a downgrade, or a dev build sharing ~/.letagents) can
    -- still open a database first created by this build; it read this table
    -- unconditionally. Drop it once no older daemon can meet this database.
    CREATE TABLE IF NOT EXISTS legacy_lane_owners (
      reservation_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_process_identity TEXT NOT NULL,
      state TEXT NOT NULL,
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL UNIQUE
    ) STRICT;
    `);
    this.schemaInitializationHook?.(database);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    const version = Number((database.prepare("PRAGMA user_version").get() as Row).user_version);
    if (version !== SCHEMA_VERSION) throw new Error(`Unsupported daemon state schema version ${version}.`);
    const createdMetadataVersion = this.metadataSchemaVersion(database);
    if (createdMetadataVersion !== SCHEMA_VERSION) throw new Error(`Unsupported daemon manifest metadata schema version ${createdMetadataVersion}.`);
    this.validateV2Shape(database);
    this.applyBoundedDeliveryV6Shape(database);
    this.validateBoundedDeliveryV6Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    const requiresScrub = this.migrateWorkerShapeToV6(database);
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}
}

// The version-range modules hold the remaining methods; merge their types here
// and install them as non-enumerable prototype methods, exactly as class methods.
export interface DaemonStateSchema extends MigrationsV1ToV12, MigrationsV13ToV24, StorageMigrations, RuntimeBirthRepairs, ShapesV11V12, ShapesV13ToV16, ShapesV17ToCurrent, ShapesV6ToV9, ShapesV4ToV7, ShapesV2V3 {}
for (const methods of [migrationsV1ToV12, migrationsV13ToV24, storageMigrations, runtimeBirthRepairs, shapesV11V12, shapesV13ToV16, shapesV17ToCurrent, shapesV6ToV9, shapesV4ToV7, shapesV2V3]) {
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(DaemonStateSchema.prototype, name, { value, writable: true, configurable: true, enumerable: false });
  }
}
