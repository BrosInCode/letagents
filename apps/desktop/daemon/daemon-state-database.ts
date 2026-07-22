import { DatabaseSync, type StatementSync } from "node:sqlite";

export const DAEMON_STATE_SCHEMA_VERSION = 7;
const SCHEMA_VERSION = DAEMON_STATE_SCHEMA_VERSION;
type Row = Record<string, unknown>;
function parseJson<T>(value: unknown): T { return JSON.parse(String(value)) as T; }
function run(statement: StatementSync, ...values: unknown[]): void { statement.run(...values as never[]); }

/** Owns the single daemon-state schema and all version transitions. */
export class DaemonStateSchema {
  constructor(
    private readonly schemaInitializationHook?: (database: DatabaseSync) => void,
    /** Test-only interruption seam after v6 COMMIT, before physical scrub. */
    private readonly postV6CommitBeforeScrubHook?: () => void,
    /** Test-only failure seam used to prove a pending scrub fails closed. */
    private readonly beforeV6ScrubHook?: () => void,
  ) {}

createSchema(database: DatabaseSync): void {
  const existingVersion = Number((database.prepare("PRAGMA user_version").get() as Row).user_version);
  const metadataVersion = this.metadataSchemaVersion(database);
  if (existingVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported daemon state schema version ${existingVersion}.`);
  }
  if (metadataVersion !== undefined && metadataVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported daemon manifest metadata schema version ${metadataVersion}.`);
  }
  if (existingVersion === 0 && metadataVersion !== undefined) {
    throw new Error(`Daemon state version pair is inconsistent: user_version=0, metadata schema_version=${metadataVersion}.`);
  }
  if (existingVersion !== 0 && metadataVersion !== existingVersion) {
    throw new Error(`Daemon state version pair is inconsistent: user_version=${existingVersion}, metadata schema_version=${metadataVersion ?? "missing"}.`);
  }
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
  if (existingVersion !== 0 && existingVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported daemon state schema version ${existingVersion}.`);
  }
  if (existingVersion === SCHEMA_VERSION) {
    this.repairAndValidateV7Shape(database);
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
      room_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_configurations (
      agent_id TEXT PRIMARY KEY REFERENCES agent_identities(agent_id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT,
      charter TEXT NOT NULL,
      permission_profile_id TEXT,
      delivery_mode TEXT NOT NULL DEFAULT 'mcp_polling' CHECK (delivery_mode IN ('mcp_polling','desktop_events','daemon_inbox')),
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
      turn_work_attempt_id TEXT,
      turn_execution_generation_id TEXT,
      provider_turn_id TEXT,
      has_correction INTEGER,
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
    this.applyV7Shape(database);
    this.validateV7Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

metadataSchemaVersion(database: DatabaseSync): number | undefined {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manifest_metadata'").get();
  if (!exists) return undefined;
  const row = database.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as Row | undefined;
  return row ? Number(row.schema_version) : undefined;
}

migrateV1ToV2(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    const requiresScrub = this.migrateWorkerShapeToV6(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    if (requiresScrub) this.markV6SecretScrubPending(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
    if (requiresScrub) this.completeV6SecretScrub(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

migrateV2ToV3(database: DatabaseSync): void {
  // Audit the complete v2 shape and legacy presence encodings on every open.
  // The transaction is normally read/no-op, but also repairs partially
  // applied v2 databases whose version markers were advanced prematurely.
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    const requiresScrub = this.migrateWorkerShapeToV6(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    if (requiresScrub) this.markV6SecretScrubPending(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
    if (requiresScrub) this.completeV6SecretScrub(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

migrateV3ToV4(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    // A v3 database is already validated before we add private credentials.
    // Do not advance either version marker until the complete v4 shape exists.
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    this.applyV4Shape(database);
    const requiresScrub = this.migrateWorkerShapeToV6(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    if (requiresScrub) this.markV6SecretScrubPending(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
    if (requiresScrub) this.completeV6SecretScrub(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

repairAndValidateV3Shape(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

repairAndValidateV4Shape(database: DatabaseSync): void {
  // A completed v4 database is validated read-only on each open. Taking an
  // IMMEDIATE transaction merely to run CREATE IF NOT EXISTS makes a daemon
  // handoff contend with an in-flight, fenced mutation for no state benefit.
  let needsRepair = this.tableColumns(database, "reconciliation_records").has("exit_timestamps_json")
    && Boolean(database.prepare("SELECT 1 FROM reconciliation_records WHERE exit_timestamps_json IS NOT NULL LIMIT 1").get());
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    this.validateV4Shape(database);
  } catch { needsRepair = true; }
  if (!needsRepair) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    this.applyV4Shape(database);
    this.validateV4Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

migrateV4ToV5(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    const requiresScrub = this.migrateWorkerShapeToV6(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    if (requiresScrub) this.markV6SecretScrubPending(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
    if (requiresScrub) this.completeV6SecretScrub(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

repairAndValidateV5Shape(database: DatabaseSync): void {
  // Keep the existing v2 repair path, but reject malformed private authority
  // tables rather than accepting a database whose fencing guarantees changed.
  let needsRepair = this.tableColumns(database, "reconciliation_records").has("exit_timestamps_json")
    && Boolean(database.prepare("SELECT 1 FROM reconciliation_records WHERE exit_timestamps_json IS NOT NULL LIMIT 1").get());
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    this.validateV4Shape(database);
    this.validateV5Shape(database);
  } catch {
    needsRepair = true;
  }
  if (!needsRepair) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    this.applyV4Shape(database);
    this.validateV4Shape(database);
    this.applyV5Shape(database);
    this.validateV5Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

migrateV5ToV6(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    const requiresScrub = this.migrateWorkerShapeToV6(database);
    this.applyBoundedDeliveryV6Shape(database);
    this.validateBoundedDeliveryV6Shape(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    if (requiresScrub) this.markV6SecretScrubPending(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
    // The old table contained a credential. secure_delete clears freed cells;
    // checkpoint + VACUUM rewrites both main and WAL before this initializer
    // returns a live v6 connection.
    if (requiresScrub) this.completeV6SecretScrub(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

migrateV6ToV7(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    this.validateV6Shape(database);
    this.validateBoundedDeliveryV6Shape(database);
    this.applyV7Shape(database);
    this.validateV7Shape(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

/**
 * Older-version test fixtures can carry a newer physical worker table after a
 * version-marker rollback.  Prefer its already-secret-free v6 shape; real
 * v1–v5 databases still build and validate each predecessor in order.
 */
private migrateWorkerShapeToV6(database: DatabaseSync): boolean {
  const columns = this.tableColumns(database, "worker_session_bindings");
  const requiresScrub = columns.has("agent_session_token");
  if (!columns.has("credential_ref")) {
    this.applyV4Shape(database);
    this.validateV4Shape(database);
  }
  this.applyV5Shape(database);
  this.validateV5Shape(database);
  // Test fixtures and interrupted version-marker repairs may already carry
  // the secret-free v7 delivery shape. Never try to validate that expanded
  // state machine against the narrower v6 CHECK constraints.
  if (this.tableColumns(database, "supervised_agent_terminal_results").size) {
    if (requiresScrub) this.applyV6Shape(database);
    this.validateV7Shape(database);
    return requiresScrub;
  }
  this.applyV6Shape(database);
  this.validateV6Shape(database);
  this.applyBoundedDeliveryV6Shape(database);
  this.validateBoundedDeliveryV6Shape(database);
  this.applyV7Shape(database);
  this.validateV7Shape(database);
  return requiresScrub;
}

repairAndValidateV7Shape(database: DatabaseSync): void {
  if (this.tableColumns(database, "worker_session_bindings").has("agent_session_token")) {
    throw new Error("Daemon state v7 must not persist agent_session_token.");
  }
  const needsLegacyPresenceRepair = this.tableColumns(database, "reconciliation_records").has("exit_timestamps_json")
    && Boolean(database.prepare("SELECT 1 FROM reconciliation_records WHERE exit_timestamps_json IS NOT NULL LIMIT 1").get());
  const needsV2AdditiveRepair = !this.tableColumns(database, "agent_configurations").has("provider_launch_policy_undefined")
    || !this.tableColumns(database, "runtime_deployments").has("provider_process_identity_present");
  const needsBoundedDeliveryRepair = !this.tableColumns(database, "agent_configurations").has("delivery_mode")
    || !this.tableColumns(database, "agent_configurations").has("delivery_cutover_json")
    || !this.tableColumns(database, "turn_control_journals").has("provider_turn_id");
  const needsV7AdditiveRepair = !this.tableColumns(database, "supervised_agent_terminal_results").size
    || !this.tableColumns(database, "supervised_agent_inbox_events").size;
  if (!needsLegacyPresenceRepair && !needsV2AdditiveRepair && !needsBoundedDeliveryRepair && !needsV7AdditiveRepair) {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    this.validateV6Shape(database, false);
    this.validateBoundedDeliveryV6Shape(database);
    this.validateV7Shape(database);
    this.finishPendingV6SecretScrub(database);
    return;
  }
  if (this.hasPendingV6SecretScrub(database)) {
    throw new Error("Daemon state v7 cannot repair additive schema state while a credential scrub is pending.");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    if (needsLegacyPresenceRepair || needsV2AdditiveRepair) this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    // Current-version repair never synthesizes or rewrites authority tables.
    // Corruption in work-attempt or worker fencing remains a hard failure.
    this.validateV3Shape(database);
    this.validateV6Shape(database, false);
    if (needsBoundedDeliveryRepair) this.applyBoundedDeliveryV6Shape(database);
    this.validateBoundedDeliveryV6Shape(database);
    if (needsV7AdditiveRepair) this.applyV7Shape(database);
    this.validateV7Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

repairAndValidateV6Shape(database: DatabaseSync): void {
  if (this.tableColumns(database, "worker_session_bindings").has("agent_session_token")) {
    throw new Error("Daemon state v6 must not persist agent_session_token.");
  }
  const needsLegacyPresenceRepair = this.tableColumns(database, "reconciliation_records").has("exit_timestamps_json")
    && Boolean(database.prepare("SELECT 1 FROM reconciliation_records WHERE exit_timestamps_json IS NOT NULL LIMIT 1").get());
  const needsBoundedDeliveryRepair = !this.tableColumns(database, "agent_configurations").has("delivery_mode")
    || !this.tableColumns(database, "agent_configurations").has("delivery_cutover_json")
    || !this.tableColumns(database, "turn_control_journals").has("provider_turn_id");
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    this.validateV6Shape(database);
    this.validateBoundedDeliveryV6Shape(database);
    this.finishPendingV6SecretScrub(database);
    if (!needsLegacyPresenceRepair && !needsBoundedDeliveryRepair) return;
  } catch (error) {
    // A pending scrub is safety-critical. Do not convert a failed VACUUM or
    // checkpoint into an unrelated shape-repair attempt that could claim the
    // database healthy while raw credential pages remain.
    if (this.hasPendingV6SecretScrub(database)) throw error;
    // Do not validate or recreate the retired v5 credential shape on normal
    // v6 opens. v2/v3 repairs remain necessary for old partial-marker cases.
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    this.applyV6Shape(database);
    this.validateV6Shape(database);
    this.applyBoundedDeliveryV6Shape(database);
    this.validateBoundedDeliveryV6Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

private applyBoundedDeliveryV6Shape(database: DatabaseSync): void {
  if (!this.tableColumns(database, "agent_configurations").has("delivery_mode")) {
    database.exec("ALTER TABLE agent_configurations ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'mcp_polling' CHECK (delivery_mode IN ('mcp_polling','desktop_events','daemon_inbox'))");
  }
  if (!this.tableColumns(database, "agent_configurations").has("delivery_cutover_json")) {
    database.exec("ALTER TABLE agent_configurations ADD COLUMN delivery_cutover_json TEXT");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("provider_turn_id")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN provider_turn_id TEXT");
  }
}

private validateBoundedDeliveryV6Shape(database: DatabaseSync): void {
  const columns = this.tableColumns(database, "agent_configurations");
  if (!columns.has("delivery_mode")) throw new Error("Daemon state v6 delivery_mode is missing.");
  if (!columns.has("delivery_cutover_json")) throw new Error("Daemon state v6 delivery_cutover_json is missing.");
  const invalid = database.prepare("SELECT 1 FROM agent_configurations WHERE delivery_mode NOT IN ('mcp_polling','desktop_events','daemon_inbox') LIMIT 1").get();
  if (invalid) throw new Error("Daemon state v6 delivery_mode is invalid.");
  if (!this.tableColumns(database, "turn_control_journals").has("provider_turn_id")) {
    throw new Error("Daemon state v6 provider_turn_id is missing.");
  }
}

private finishPendingV6SecretScrub(database: DatabaseSync): void {
  if (this.hasPendingV6SecretScrub(database)) this.finishV6SecretScrub(database);
}

private hasPendingV6SecretScrub(database: DatabaseSync): boolean {
  const pending = database.prepare("SELECT checksum FROM migration_records WHERE migration_key='v6-worker-token-scrub'").get() as Row | undefined;
  return pending?.checksum === "pending";
}

private markV6SecretScrubPending(database: DatabaseSync): void {
  run(database.prepare("INSERT OR REPLACE INTO migration_records(migration_key, checksum, imported_at) VALUES ('v6-worker-token-scrub', 'pending', ?)"), new Date().toISOString());
}

private completeV6SecretScrub(database: DatabaseSync): void {
  this.postV6CommitBeforeScrubHook?.();
  this.finishV6SecretScrub(database);
}

private finishV6SecretScrub(database: DatabaseSync): void {
  this.beforeV6ScrubHook?.();
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec("VACUUM");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec("BEGIN IMMEDIATE");
  try {
    run(database.prepare("DELETE FROM migration_records WHERE migration_key='v6-worker-token-scrub' AND checksum='pending'"));
    database.exec("COMMIT");
  } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
}

applyV4Shape(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS worker_session_bindings (
      entry_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      work_attempt_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      agent_session_token TEXT NOT NULL,
      api_url TEXT NOT NULL,
      room_cursor TEXT,
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
      binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS worker_session_binding_authority
      ON worker_session_bindings(entry_id, binding_epoch, execution_generation_id, agent_session_id);
    CREATE TABLE IF NOT EXISTS worker_binding_publications (
      reservation_id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
      execution_generation_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      observed_at TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted', 'failed')),
      created_at TEXT NOT NULL,
      finalized_at TEXT,
      UNIQUE(entry_id, sequence)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS worker_binding_publications_current
      ON worker_binding_publications(entry_id, binding_epoch, sequence DESC);
    CREATE TABLE IF NOT EXISTS worker_generation_verifications (
      reservation_id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
      from_execution_generation_id TEXT NOT NULL,
      to_execution_generation_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      observed_at TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted', 'failed', 'lost_race')),
      created_at TEXT NOT NULL,
      finalized_at TEXT,
      UNIQUE(entry_id, sequence)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS worker_generation_verifications_current
      ON worker_generation_verifications(entry_id, binding_epoch, sequence DESC);
  `);
}

validateV4Shape(database: DatabaseSync): void {
  const normalizeSql = (value: string) => {
    const stripped = value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
    let result = ""; let quote = ""; let escaped = false;
    for (const char of stripped) {
      if (quote) { result += char; if (escaped) escaped = false; else if (char === "'") quote = ""; else if (char === "\\") escaped = true; }
      else if (char === "'") { quote = char; result += char; } else result += char.toLowerCase();
    }
    return result.replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").trim();
  };
  const canonicalTables: Record<string, string> = {
    worker_session_bindings: `CREATE TABLE worker_session_bindings (entry_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,work_attempt_id TEXT NOT NULL,execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,agent_session_token TEXT NOT NULL,api_url TEXT NOT NULL,room_cursor TEXT,last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms >= 0),binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),updated_at TEXT NOT NULL) STRICT`,
    worker_binding_publications: `CREATE TABLE worker_binding_publications (reservation_id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence > 0),observed_at TEXT NOT NULL,observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),state TEXT NOT NULL CHECK(state IN ('reserved','accepted','failed')),created_at TEXT NOT NULL,finalized_at TEXT,UNIQUE(entry_id,sequence)) STRICT`,
    worker_generation_verifications: `CREATE TABLE worker_generation_verifications (reservation_id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),from_execution_generation_id TEXT NOT NULL,to_execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence > 0),observed_at TEXT NOT NULL,observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),state TEXT NOT NULL CHECK(state IN ('reserved','accepted','failed','lost_race')),created_at TEXT NOT NULL,finalized_at TEXT,UNIQUE(entry_id,sequence)) STRICT`,
  };
  for (const [table, canonical] of Object.entries(canonicalTables)) {
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
    if (!actual || normalizeSql(String(actual.sql)) !== normalizeSql(canonical)) throw new Error(`Daemon state v4 table ${table} does not match its canonical definition.`);
  }
  const required: Record<string, string[]> = {
    worker_session_bindings: ["entry_id", "room_id", "work_attempt_id", "execution_generation_id", "agent_session_id", "agent_session_token", "api_url", "room_cursor", "last_sequence", "last_observed_at_ms", "binding_epoch", "updated_at"],
    worker_binding_publications: ["reservation_id", "entry_id", "binding_epoch", "execution_generation_id", "agent_session_id", "sequence", "observed_at", "observed_at_ms", "state", "created_at", "finalized_at"],
    worker_generation_verifications: ["reservation_id", "entry_id", "binding_epoch", "from_execution_generation_id", "to_execution_generation_id", "agent_session_id", "sequence", "observed_at", "observed_at_ms", "state", "created_at", "finalized_at"],
  };
  for (const [table, expected] of Object.entries(required)) {
    const columns = database.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number; hidden: number }>;
    const actual = new Set(columns.map((column) => column.name));
    const missing = expected.filter((column) => !actual.has(column));
    const extra = columns.map((column) => column.name).filter((column) => !expected.includes(column));
    if (missing.length || extra.length) throw new Error(`Daemon state v4 table ${table} has invalid columns (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`);
    for (const column of columns) {
      const isPrimary = column.name === (table === "worker_session_bindings" ? "entry_id" : "reservation_id");
      const expectedType = ["last_sequence", "last_observed_at_ms", "binding_epoch", "sequence", "observed_at_ms"].includes(column.name) ? "INTEGER" : "TEXT";
      const nullable = column.name === "room_cursor" || column.name === "finalized_at";
      if (Number(column.hidden) !== 0 || column.type !== expectedType || Number(column.notnull) !== (nullable ? 0 : 1) || Number(column.pk) !== (isPrimary ? 1 : 0)) {
        throw new Error(`Daemon state v4 table ${table} has invalid definition for ${column.name}.`);
      }
    }
    const tableRow = (database.prepare("PRAGMA table_list").all() as Row[]).find((row) => row.name === table && row.type === "table");
    if (!tableRow || Number(tableRow.strict) !== 1 || Number(tableRow.wr) !== 0) throw new Error(`Daemon state v4 table ${table} must be STRICT rowid tables.`);
  }
  const indexNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Row[]).map((row) => String(row.name)));
  for (const index of ["worker_session_binding_authority", "worker_binding_publications_current", "worker_generation_verifications_current"]) {
    if (!indexNames.has(index)) throw new Error(`Daemon state v4 is missing required index ${index}.`);
  }
  const indexColumns: Record<string, string[]> = {
    worker_session_binding_authority: ["entry_id", "binding_epoch", "execution_generation_id", "agent_session_id"],
    worker_binding_publications_current: ["entry_id", "binding_epoch", "sequence"],
    worker_generation_verifications_current: ["entry_id", "binding_epoch", "sequence"],
  };
  for (const [name, expected] of Object.entries(indexColumns)) {
    const actual = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Array<{ key: number; name: string | null; desc: number }>).filter((row) => Number(row.key) === 1);
    const descendingLast = name !== "worker_session_binding_authority";
    if (actual.length !== expected.length || actual.some((row, index) => row.name !== expected[index] || Number(row.desc) !== (descendingLast && index === expected.length - 1 ? 1 : 0))) {
      throw new Error(`Daemon state v4 index ${name} has an invalid key definition.`);
    }
  }
  const indexRequirements: Record<string, { table: string; unique: number; columns: string[] }> = {
    worker_session_binding_authority: { table: "worker_session_bindings", unique: 1, columns: ["entry_id", "binding_epoch", "execution_generation_id", "agent_session_id"] },
    worker_binding_publications_current: { table: "worker_binding_publications", unique: 0, columns: ["entry_id", "binding_epoch", "sequence"] },
    worker_generation_verifications_current: { table: "worker_generation_verifications", unique: 0, columns: ["entry_id", "binding_epoch", "sequence"] },
  };
  for (const [name, requirement] of Object.entries(indexRequirements)) {
    const listed = (database.prepare(`PRAGMA index_list(${requirement.table})`).all() as Array<{ name: string; unique: number; partial: number; origin: string }>).find((row) => row.name === name);
    if (!listed || Number(listed.unique) !== requirement.unique || Number(listed.partial) !== 0 || String(listed.origin) !== "c") throw new Error(`Daemon state v4 index ${name} has invalid ownership or uniqueness.`);
    const info = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Array<{ key: number; cid: number; name: string | null; desc: number; coll: string }>).filter((row) => Number(row.key) === 1);
    const descendingLast = name !== "worker_session_binding_authority";
    if (info.length !== requirement.columns.length || info.some((row, index) => Number(row.cid) < 0 || row.name !== requirement.columns[index] || Number(row.desc) !== (descendingLast && index === requirement.columns.length - 1 ? 1 : 0) || String(row.coll).toUpperCase() !== "BINARY")) throw new Error(`Daemon state v4 index ${name} has invalid terms.`);
  }
  for (const table of ["worker_binding_publications", "worker_generation_verifications"]) {
    const uniqueSequence = (database.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number; origin: string; partial: number }>).some((row) => {
      if (Number(row.unique) !== 1 || String(row.origin) !== "u" || Number(row.partial) !== 0) return false;
      const terms = (database.prepare(`PRAGMA index_xinfo(${row.name})`).all() as Array<{ key: number; cid: number; name: string | null; desc: number; coll: string }>).filter((term) => Number(term.key) === 1);
      return terms.length === 2 && terms[0]?.cid >= 0 && terms[1]?.cid >= 0 && terms[0]?.name === "entry_id" && terms[1]?.name === "sequence" && Number(terms[0]?.desc) === 0 && Number(terms[1]?.desc) === 0 && String(terms[0]?.coll).toUpperCase() === "BINARY" && String(terms[1]?.coll).toUpperCase() === "BINARY";
    });
    if (!uniqueSequence) throw new Error(`Daemon state v4 table ${table} is missing UNIQUE(entry_id, sequence).`);
  }
  const rejectsCheck = (sql: string, ...values: unknown[]) => {
    database.exec("SAVEPOINT worker_v4_check_probe");
    try {
      try { database.prepare(sql).run(...values as never[]); }
      catch (error: unknown) { if (!/CHECK constraint failed/i.test(String(error))) throw error; return; }
      throw new Error("required CHECK accepted an invalid value");
    } finally { database.exec("ROLLBACK TO worker_v4_check_probe"); database.exec("RELEASE worker_v4_check_probe"); }
  };
  const binding = ["probe", "room", "attempt", "run", "session", "token", "https://example.test", null, 1, 1, 1, "2026-01-01T00:00:00.000Z"];
  rejectsCheck("INSERT INTO worker_session_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...binding.slice(0, 8), -1, 1, 1, binding[11]);
  rejectsCheck("INSERT INTO worker_session_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...binding.slice(0, 8), 1, -1, 1, binding[11]);
  rejectsCheck("INSERT INTO worker_session_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...binding.slice(0, 8), 1, 1, 0, binding[11]);
  const publication = ["probe", "agent", 1, "run", "session", 1, "2026-01-01T00:00:00.000Z", 1, "reserved", "2026-01-01T00:00:00.000Z", null];
  for (const invalid of [[-1, 1, "reserved"], [0, 1, "reserved"], [1, -1, "reserved"], [1, 1, "bogus"], [1, 1, "working"], [1, 1, ""]]) rejectsCheck("INSERT INTO worker_binding_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...publication.slice(0, 5), invalid[0], publication[6], invalid[1], invalid[2], publication[9], null);
  const verification = ["probe", "agent", 1, "from", "to", "session", 1, "2026-01-01T00:00:00.000Z", 1, "reserved", "2026-01-01T00:00:00.000Z", null];
  for (const invalid of [[-1, 1, "reserved"], [0, 1, "reserved"], [1, -1, "reserved"], [1, 1, "bogus"], [1, 1, "working"], [1, 1, ""]]) rejectsCheck("INSERT INTO worker_generation_verifications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...verification.slice(0, 6), invalid[0], verification[7], invalid[1], invalid[2], verification[10], null);
}

applyV5Shape(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS worker_binding_watermarks (
      entry_id TEXT PRIMARY KEY,
      binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  // v4 kept authority only with live credentials. Build the independent
  // tombstone from both the live row and every historic reservation before a
  // v5 opener can bind again. This runs idempotently during interrupted
  // migrations as well as a normal upgrade.
  database.exec(`
    INSERT INTO worker_binding_watermarks
      (entry_id, binding_epoch, last_sequence, last_observed_at_ms, updated_at)
    SELECT entry_id, MAX(binding_epoch), MAX(last_sequence), MAX(last_observed_at_ms), MAX(updated_at)
    FROM (
      SELECT entry_id, binding_epoch, last_sequence, last_observed_at_ms, updated_at
      FROM worker_session_bindings
      UNION ALL
      SELECT entry_id, binding_epoch, sequence, observed_at_ms, observed_at
      FROM worker_binding_publications
      UNION ALL
      SELECT entry_id, binding_epoch, sequence, observed_at_ms, observed_at
      FROM worker_generation_verifications
    )
    GROUP BY entry_id
    ON CONFLICT(entry_id) DO UPDATE SET
      binding_epoch = MAX(worker_binding_watermarks.binding_epoch, excluded.binding_epoch),
      last_sequence = MAX(worker_binding_watermarks.last_sequence, excluded.last_sequence),
      last_observed_at_ms = MAX(worker_binding_watermarks.last_observed_at_ms, excluded.last_observed_at_ms),
      updated_at = CASE
        WHEN excluded.last_observed_at_ms >= worker_binding_watermarks.last_observed_at_ms THEN excluded.updated_at
        ELSE worker_binding_watermarks.updated_at
      END;
  `);
}

validateV5Shape(database: DatabaseSync): void {
  const canonical = `CREATE TABLE worker_binding_watermarks (entry_id TEXT PRIMARY KEY,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms >= 0),updated_at TEXT NOT NULL) STRICT`;
  const normalizeSql = (value: string) => value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replaceAll('"', "").replaceAll("`", "").replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").replace(/\)\s*strict$/i, ")strict").trim().toLowerCase();
  const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='worker_binding_watermarks'").get() as Row | undefined;
  if (!actual || normalizeSql(String(actual.sql)) !== normalizeSql(canonical)) throw new Error("Daemon state v5 table worker_binding_watermarks does not match its canonical definition.");
  const columns = database.prepare("PRAGMA table_xinfo(worker_binding_watermarks)").all() as Array<{ name: string; type: string; notnull: number; pk: number; hidden: number }>;
  const expected = [
    ["entry_id", "TEXT", 1, 1], ["binding_epoch", "INTEGER", 1, 0], ["last_sequence", "INTEGER", 1, 0],
    ["last_observed_at_ms", "INTEGER", 1, 0], ["updated_at", "TEXT", 1, 0],
  ] as const;
  if (columns.length !== expected.length || columns.some((column, index) => column.name !== expected[index]![0] || column.type !== expected[index]![1] || Number(column.notnull) !== expected[index]![2] || Number(column.pk) !== expected[index]![3] || Number(column.hidden) !== 0)) {
    throw new Error("Daemon state v5 table worker_binding_watermarks has invalid columns.");
  }
  const table = (database.prepare("PRAGMA table_list").all() as Row[]).find((row) => row.name === "worker_binding_watermarks" && row.type === "table");
  if (!table || Number(table.strict) !== 1 || Number(table.wr) !== 0) throw new Error("Daemon state v5 table worker_binding_watermarks must be a STRICT rowid table.");
  const rejectsCheck = (sql: string, ...values: unknown[]) => {
    database.exec("SAVEPOINT worker_v5_check_probe");
    try {
      try { database.prepare(sql).run(...values as never[]); }
      catch (error: unknown) { if (!/CHECK constraint failed/i.test(String(error))) throw error; return; }
      throw new Error("required CHECK accepted an invalid value");
    } finally { database.exec("ROLLBACK TO worker_v5_check_probe"); database.exec("RELEASE worker_v5_check_probe"); }
  };
  for (const invalid of [[0, 0, 0], [1, -1, 0], [1, 0, -1]]) rejectsCheck("INSERT INTO worker_binding_watermarks VALUES (?, ?, ?, ?, ?)", "probe", invalid[0], invalid[1], invalid[2], "2026-01-01T00:00:00.000Z");
}

applyV6Shape(database: DatabaseSync): void {
  // This additive v6 journal originally ordered tied timestamps by a text key,
  // which is not causal. Rebuild only that new table into the ordinal shape.
  const eventColumns = this.tableColumns(database, "supervised_agent_inbox_events");
  if (eventColumns.has("transition_key") && !eventColumns.has("event_sequence")) {
    database.exec(`
      CREATE TABLE supervised_agent_inbox_events_v6_ordered (
        inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
        idempotency_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','publish_started','published','no_reply','retry_scheduled','blocked')),
        observed_at TEXT NOT NULL,
        detail TEXT,
        PRIMARY KEY(inbox_item_id,event_sequence),
        UNIQUE(inbox_item_id,idempotency_key)
      ) STRICT;
      INSERT INTO supervised_agent_inbox_events_v6_ordered(inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
      SELECT inbox_item_id,ROW_NUMBER() OVER (PARTITION BY inbox_item_id ORDER BY observed_at,transition_key),transition_key,phase,observed_at,detail
      FROM supervised_agent_inbox_events;
      DROP TABLE supervised_agent_inbox_events;
      ALTER TABLE supervised_agent_inbox_events_v6_ordered RENAME TO supervised_agent_inbox_events;
    `);
  }
  // v4/v5 persisted the raw worker-session token. Rebuild rather than ALTER
  // so no live table in a completed v6 database has a secret column.
  const columns = this.tableColumns(database, "worker_session_bindings");
  if (columns.has("agent_session_token")) {
    database.exec(`
      -- A prior interrupted/manual attempt may have left the staging name.
      -- The caller is in one IMMEDIATE transaction, so discarding that
      -- incomplete copy is safe; the authoritative legacy source remains.
      DROP TABLE IF EXISTS worker_session_bindings_v6;
      CREATE TABLE worker_session_bindings_v6 (
        entry_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        work_attempt_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL,
        agent_session_id TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        api_url TEXT NOT NULL,
        room_cursor TEXT,
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
        last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
        binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO worker_session_bindings_v6
        (entry_id, room_id, work_attempt_id, execution_generation_id, agent_session_id,
         credential_ref, api_url, room_cursor, last_sequence, last_observed_at_ms,
         binding_epoch, updated_at)
      SELECT entry_id, room_id, work_attempt_id, execution_generation_id, agent_session_id,
        lower(hex(randomblob(16))), api_url, room_cursor, last_sequence,
        last_observed_at_ms, binding_epoch, updated_at
      FROM worker_session_bindings;
      DROP TABLE worker_session_bindings;
      ALTER TABLE worker_session_bindings_v6 RENAME TO worker_session_bindings;
      CREATE UNIQUE INDEX worker_session_binding_authority
        ON worker_session_bindings(entry_id, binding_epoch, execution_generation_id, agent_session_id);
    `);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervised_agent_inbox (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_message_json TEXT NOT NULL,
      activation_json TEXT NOT NULL,
      fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence > 0),
      state TEXT NOT NULL CHECK (state IN ('pending','dispatching','awaiting_result','publishing','retryable','blocked','acknowledged','acknowledged_no_reply')),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      action_id TEXT NOT NULL,
      reply_client_message_id TEXT NOT NULL,
      provider_turn_id TEXT,
      outcome TEXT,
      last_error TEXT,
      blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),
      next_attempt_at_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acknowledged_at TEXT,
      UNIQUE(agent_id, source_message_id),
      UNIQUE(agent_id, fifo_sequence)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_inbox_head
      ON supervised_agent_inbox(agent_id, fifo_sequence);
    -- Additive v6 journal: phase facts are append-only and survive a daemon
    -- restart. It does not alter the canonical inbox state machine.
    CREATE TABLE IF NOT EXISTS supervised_agent_inbox_events (
      inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
      idempotency_key TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('received','queued','turn_started','turn_finished','publish_started','published','no_reply','retry_scheduled','blocked')),
      observed_at TEXT NOT NULL,
      detail TEXT,
      PRIMARY KEY(inbox_item_id, event_sequence),
      UNIQUE(inbox_item_id, idempotency_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_inbox_events_timeline
      ON supervised_agent_inbox_events(inbox_item_id, event_sequence);
    CREATE TABLE IF NOT EXISTS supervised_agent_ingress_cursors (
      agent_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      last_observed_message_id TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS supervised_worker_sessions (
      agent_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      expires_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
}

applyV7Shape(database: DatabaseSync): void {
  if (!this.tableColumns(database, "supervised_agent_terminal_results").size) {
    database.exec(`
      ALTER TABLE supervised_agent_inbox RENAME TO supervised_agent_inbox_v6;
      CREATE TABLE supervised_agent_inbox (
        inbox_item_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        source_message_json TEXT NOT NULL,
        activation_json TEXT NOT NULL,
        fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence > 0),
        state TEXT NOT NULL CHECK (state IN ('pending','dispatching','awaiting_result','result_recovery','publishing','retryable','blocked','acknowledged','acknowledged_no_reply','cancelled_by_room_move')),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        action_id TEXT NOT NULL,
        reply_client_message_id TEXT NOT NULL,
        provider_turn_id TEXT,
        outcome TEXT,
        last_error TEXT,
        blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),
        next_attempt_at_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acknowledged_at TEXT,
        UNIQUE(agent_id, source_message_id),
        UNIQUE(agent_id, fifo_sequence)
      ) STRICT;
      INSERT INTO supervised_agent_inbox
        (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
      SELECT inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at
      FROM supervised_agent_inbox_v6;

      CREATE TABLE supervised_agent_inbox_events_v7 (
        inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
        idempotency_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled')),
        observed_at TEXT NOT NULL,
        detail TEXT,
        PRIMARY KEY(inbox_item_id,event_sequence),
        UNIQUE(inbox_item_id,idempotency_key)
      ) STRICT;
      INSERT INTO supervised_agent_inbox_events_v7
        (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
      SELECT inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail
      FROM supervised_agent_inbox_events;
      DROP TABLE supervised_agent_inbox_events;
      DROP TABLE supervised_agent_inbox_v6;
      ALTER TABLE supervised_agent_inbox_events_v7 RENAME TO supervised_agent_inbox_events;
      CREATE INDEX supervised_agent_inbox_head ON supervised_agent_inbox(agent_id,fifo_sequence);
      CREATE INDEX supervised_agent_inbox_events_timeline ON supervised_agent_inbox_events(inbox_item_id,event_sequence);

      CREATE TABLE supervised_agent_terminal_results (
        inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL,
        provider_turn_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('reply','no_reply','unreadable')),
        normalized_text TEXT,
        evidence_source TEXT NOT NULL CHECK(evidence_source IN ('transcript','stream','none')),
        terminal_evidence_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX supervised_agent_terminal_result_turn
        ON supervised_agent_terminal_results(agent_id,execution_generation_id,provider_turn_id);

      CREATE TABLE supervised_agent_observed_messages (
        agent_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        source_message_json TEXT NOT NULL,
        activation_json TEXT NOT NULL,
        activation_decision TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(agent_id,source_message_id)
      ) STRICT;
      CREATE INDEX supervised_agent_observed_context
        ON supervised_agent_observed_messages(agent_id,room_id,source_message_id);

      CREATE TABLE supervised_agent_effects (
        effect_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL,
        provider_turn_id TEXT NOT NULL,
        mcp_request_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','executing','completed','failed')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id,execution_generation_id,provider_turn_id,mcp_request_id)
      ) STRICT;
      CREATE INDEX supervised_agent_effects_turn
        ON supervised_agent_effects(agent_id,execution_generation_id,provider_turn_id);

      CREATE TABLE supervised_agent_ingress_health (
        agent_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('starting','observing','backoff','blocked','stopped')),
        detail TEXT,
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }
  if (!this.tableColumns(database, "supervised_agent_inbox_events").size) {
    database.exec(`
      CREATE TABLE supervised_agent_inbox_events (
        inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
        idempotency_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled')),
        observed_at TEXT NOT NULL,
        detail TEXT,
        PRIMARY KEY(inbox_item_id,event_sequence),
        UNIQUE(inbox_item_id,idempotency_key)
      ) STRICT;
      CREATE INDEX supervised_agent_inbox_events_timeline
        ON supervised_agent_inbox_events(inbox_item_id,event_sequence);
    `);
  }
}

validateV7Shape(database: DatabaseSync): void {
  const required: Record<string, string[]> = {
    supervised_agent_inbox: ["inbox_item_id", "agent_id", "room_id", "source_message_id", "source_message_json", "activation_json", "fifo_sequence", "state", "attempt_count", "action_id", "reply_client_message_id", "provider_turn_id", "outcome", "last_error", "blocked_by_inbox_item_id", "next_attempt_at_ms", "created_at", "updated_at", "acknowledged_at"],
    supervised_agent_inbox_events: ["inbox_item_id", "event_sequence", "idempotency_key", "phase", "observed_at", "detail"],
    supervised_agent_terminal_results: ["inbox_item_id", "agent_id", "execution_generation_id", "provider_turn_id", "outcome", "normalized_text", "evidence_source", "terminal_evidence_json", "observed_at", "updated_at"],
    supervised_agent_observed_messages: ["agent_id", "room_id", "source_message_id", "source_message_json", "activation_json", "activation_decision", "observed_at"],
    supervised_agent_effects: ["effect_id", "agent_id", "room_id", "execution_generation_id", "provider_turn_id", "mcp_request_id", "tool_name", "request_json", "state", "result_json", "error", "created_at", "updated_at"],
    supervised_agent_ingress_health: ["agent_id", "room_id", "execution_generation_id", "state", "detail", "observed_at", "updated_at"],
  };
  for (const [table, expected] of Object.entries(required)) {
    const details = database.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string; hidden: number }>;
    const columns = details.map((column) => String(column.name));
    const info = (database.prepare("PRAGMA table_list").all() as Row[]).find((row) => row.name === table && row.type === "table");
    if (!info || Number(info.strict) !== 1 || expected.some((column) => !columns.includes(column))
      || columns.some((column) => !expected.includes(column)) || details.some((column) => Number(column.hidden) !== 0)) {
      throw new Error(`Daemon state v7 table ${table} has an invalid strict schema.`);
    }
  }
  if (this.tableColumns(database, "worker_session_bindings").has("agent_session_token")) {
    throw new Error("Daemon state v7 must not persist agent_session_token.");
  }
}

validateV6Shape(database: DatabaseSync, includeDeliveryTables = true): void {
  const canonical: Record<string, string> = {
    worker_session_bindings: `CREATE TABLE worker_session_bindings (entry_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,work_attempt_id TEXT NOT NULL,execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,credential_ref TEXT NOT NULL,api_url TEXT NOT NULL,room_cursor TEXT,last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms >= 0),binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),updated_at TEXT NOT NULL) STRICT`,
    supervised_agent_inbox: `CREATE TABLE supervised_agent_inbox (inbox_item_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,room_id TEXT NOT NULL,source_message_id TEXT NOT NULL,source_message_json TEXT NOT NULL,activation_json TEXT NOT NULL,fifo_sequence INTEGER NOT NULL CHECK(fifo_sequence > 0),state TEXT NOT NULL CHECK(state IN ('pending','dispatching','awaiting_result','publishing','retryable','blocked','acknowledged','acknowledged_no_reply')),attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),action_id TEXT NOT NULL,reply_client_message_id TEXT NOT NULL,provider_turn_id TEXT,outcome TEXT,last_error TEXT,blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),next_attempt_at_ms INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,acknowledged_at TEXT,UNIQUE(agent_id,source_message_id),UNIQUE(agent_id,fifo_sequence)) STRICT`,
    supervised_agent_inbox_events: `CREATE TABLE supervised_agent_inbox_events (inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),idempotency_key TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','publish_started','published','no_reply','retry_scheduled','blocked')),observed_at TEXT NOT NULL,detail TEXT,PRIMARY KEY(inbox_item_id,event_sequence),UNIQUE(inbox_item_id,idempotency_key)) STRICT`,
    supervised_agent_ingress_cursors: `CREATE TABLE supervised_agent_ingress_cursors (agent_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,last_observed_message_id TEXT,updated_at TEXT NOT NULL) STRICT`,
    supervised_worker_sessions: `CREATE TABLE supervised_worker_sessions (agent_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,execution_generation_id TEXT NOT NULL,credential_ref TEXT NOT NULL,expires_at TEXT,updated_at TEXT NOT NULL) STRICT`,
    worker_binding_publications: `CREATE TABLE worker_binding_publications (reservation_id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence > 0),observed_at TEXT NOT NULL,observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),state TEXT NOT NULL CHECK(state IN ('reserved','accepted','failed')),created_at TEXT NOT NULL,finalized_at TEXT,UNIQUE(entry_id,sequence)) STRICT`,
    worker_generation_verifications: `CREATE TABLE worker_generation_verifications (reservation_id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),from_execution_generation_id TEXT NOT NULL,to_execution_generation_id TEXT NOT NULL,agent_session_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence > 0),observed_at TEXT NOT NULL,observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),state TEXT NOT NULL CHECK(state IN ('reserved','accepted','failed','lost_race')),created_at TEXT NOT NULL,finalized_at TEXT,UNIQUE(entry_id,sequence)) STRICT`,
    worker_binding_watermarks: `CREATE TABLE worker_binding_watermarks (entry_id TEXT PRIMARY KEY,binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms >= 0),updated_at TEXT NOT NULL) STRICT`,
  };
  if (!includeDeliveryTables) {
    delete canonical.supervised_agent_inbox;
    delete canonical.supervised_agent_inbox_events;
    delete canonical.supervised_agent_ingress_cursors;
    delete canonical.supervised_worker_sessions;
  }
  const normalizeSql = (value: string) => value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replaceAll('"', "").replaceAll("`", "").replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").replace(/\)\s*strict$/i, ")strict").trim().toLowerCase();
  for (const [table, expected] of Object.entries(canonical)) {
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
    if (!actual || normalizeSql(String(actual.sql)) !== normalizeSql(expected)) throw new Error(`Daemon state v6 table ${table} does not match its canonical definition.`);
  }
  const required: Record<string, string[]> = {
    worker_session_bindings: ["entry_id", "room_id", "work_attempt_id", "execution_generation_id", "agent_session_id", "credential_ref", "api_url", "room_cursor", "last_sequence", "last_observed_at_ms", "binding_epoch", "updated_at"],
    supervised_agent_inbox: ["inbox_item_id", "agent_id", "room_id", "source_message_id", "source_message_json", "activation_json", "fifo_sequence", "state", "attempt_count", "action_id", "reply_client_message_id", "provider_turn_id", "outcome", "last_error", "blocked_by_inbox_item_id", "next_attempt_at_ms", "created_at", "updated_at", "acknowledged_at"],
    supervised_agent_inbox_events: ["inbox_item_id", "event_sequence", "idempotency_key", "phase", "observed_at", "detail"],
    supervised_agent_ingress_cursors: ["agent_id", "room_id", "last_observed_message_id", "updated_at"],
    supervised_worker_sessions: ["agent_id", "room_id", "agent_session_id", "execution_generation_id", "credential_ref", "expires_at", "updated_at"],
  };
  if (!includeDeliveryTables) {
    delete required.supervised_agent_inbox;
    delete required.supervised_agent_inbox_events;
    delete required.supervised_agent_ingress_cursors;
    delete required.supervised_worker_sessions;
  }
  for (const [table, expected] of Object.entries(required)) {
    const details = database.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string; hidden: number }>;
    const columns = details.map((column) => String(column.name));
    const missing = expected.filter((column) => !columns.includes(column));
    const extra = columns.filter((column) => !expected.includes(column));
    const info = (database.prepare("PRAGMA table_list").all() as Row[]).find((row) => row.name === table && row.type === "table");
    if (!info || Number(info.strict) !== 1 || missing.length || extra.length || details.some((column) => Number(column.hidden) !== 0)) {
      throw new Error(`Daemon state v6 table ${table} has an invalid strict schema.`);
    }
  }
  if (this.tableColumns(database, "worker_session_bindings").has("agent_session_token")) {
    throw new Error("Daemon state v6 must not persist agent_session_token.");
  }
  if (includeDeliveryTables) {
    const duplicateInbox = database.prepare(`SELECT 1 FROM supervised_agent_inbox GROUP BY agent_id, source_message_id HAVING COUNT(*) > 1 LIMIT 1`).get();
    if (duplicateInbox) throw new Error("Daemon state v6 inbox uniqueness is invalid.");
  }
  const indexes: Record<string, { table: string; unique: number; columns: string[] }> = {
    worker_session_binding_authority: { table: "worker_session_bindings", unique: 1, columns: ["entry_id", "binding_epoch", "execution_generation_id", "agent_session_id"] },
    worker_binding_publications_current: { table: "worker_binding_publications", unique: 0, columns: ["entry_id", "binding_epoch", "sequence"] },
    worker_generation_verifications_current: { table: "worker_generation_verifications", unique: 0, columns: ["entry_id", "binding_epoch", "sequence"] },
    supervised_agent_inbox_head: { table: "supervised_agent_inbox", unique: 0, columns: ["agent_id", "fifo_sequence"] },
    supervised_agent_inbox_events_timeline: { table: "supervised_agent_inbox_events", unique: 0, columns: ["inbox_item_id", "event_sequence"] },
  };
  if (!includeDeliveryTables) {
    delete indexes.supervised_agent_inbox_head;
    delete indexes.supervised_agent_inbox_events_timeline;
  }
  for (const [name, expected] of Object.entries(indexes)) {
    const listed = (database.prepare(`PRAGMA index_list(${expected.table})`).all() as Row[]).find((row) => row.name === name);
    const terms = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Row[]).filter((row) => Number(row.key) === 1).sort((a, b) => Number(a.seqno) - Number(b.seqno));
    if (!listed || Number(listed.unique) !== expected.unique || Number(listed.partial) !== 0
      || String(listed.origin) !== "c" || terms.length !== expected.columns.length
      || terms.some((term, index) => Number(term.cid) < 0 || term.name !== expected.columns[index]
        || Number(term.desc) !== (name.endsWith("_current") && index === terms.length - 1 ? 1 : 0)
        || String(term.coll).toUpperCase() !== "BINARY")) {
      throw new Error(`Daemon state v6 index ${name} is invalid.`);
    }
  }
}

applyV3Shape(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS work_attempts (
      work_attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, lease_id TEXT NOT NULL,
      current_lease_epoch INTEGER NOT NULL, workspace_path TEXT NOT NULL UNIQUE,
      workspace_repo TEXT NOT NULL, workspace_remote_url TEXT NOT NULL,
      workspace_resolved_revision TEXT NOT NULL, workspace_bare_path TEXT NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, concluded_at TEXT,
      conclusion_cause TEXT, postmortem_diff TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS work_attempt_lease_epochs (
      work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL, lease_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      recorded_at TEXT NOT NULL, PRIMARY KEY(work_attempt_id, sort_order)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS work_attempt_checkpoints (
      work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL, at TEXT NOT NULL, room_cursor TEXT,
      provider_continuation_id TEXT, PRIMARY KEY(work_attempt_id, sort_order)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS work_attempt_executions (
      execution_generation_id TEXT PRIMARY KEY,
      work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,
      started_at TEXT NOT NULL, actor TEXT NOT NULL, generation INTEGER NOT NULL,
      terminal_json TEXT, UNIQUE(work_attempt_id, generation)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_live_work_attempt_execution
      ON work_attempt_executions(work_attempt_id) WHERE terminal_json IS NULL;
  `);
}

validateV3Shape(database: DatabaseSync): void {
  type Column = { name: string; type: "TEXT" | "INTEGER"; notnull: 0 | 1; pk: number };
  const required: Record<string, Column[]> = {
    work_attempts: [
      { name: "work_attempt_id", type: "TEXT", notnull: 1, pk: 1 }, { name: "task_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "lease_id", type: "TEXT", notnull: 1, pk: 0 }, { name: "current_lease_epoch", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "workspace_path", type: "TEXT", notnull: 1, pk: 0 }, { name: "workspace_repo", type: "TEXT", notnull: 1, pk: 0 },
      { name: "workspace_remote_url", type: "TEXT", notnull: 1, pk: 0 }, { name: "workspace_resolved_revision", type: "TEXT", notnull: 1, pk: 0 },
      { name: "workspace_bare_path", type: "TEXT", notnull: 1, pk: 0 }, { name: "state", type: "TEXT", notnull: 1, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, pk: 0 }, { name: "concluded_at", type: "TEXT", notnull: 0, pk: 0 },
      { name: "conclusion_cause", type: "TEXT", notnull: 0, pk: 0 }, { name: "postmortem_diff", type: "TEXT", notnull: 0, pk: 0 },
    ],
    work_attempt_lease_epochs: [
      { name: "work_attempt_id", type: "TEXT", notnull: 1, pk: 1 }, { name: "sort_order", type: "INTEGER", notnull: 1, pk: 2 },
      { name: "lease_id", type: "TEXT", notnull: 1, pk: 0 }, { name: "epoch", type: "INTEGER", notnull: 1, pk: 0 }, { name: "recorded_at", type: "TEXT", notnull: 1, pk: 0 },
    ],
    work_attempt_checkpoints: [
      { name: "work_attempt_id", type: "TEXT", notnull: 1, pk: 1 }, { name: "sort_order", type: "INTEGER", notnull: 1, pk: 2 },
      { name: "at", type: "TEXT", notnull: 1, pk: 0 }, { name: "room_cursor", type: "TEXT", notnull: 0, pk: 0 }, { name: "provider_continuation_id", type: "TEXT", notnull: 0, pk: 0 },
    ],
    work_attempt_executions: [
      { name: "execution_generation_id", type: "TEXT", notnull: 1, pk: 1 }, { name: "work_attempt_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "started_at", type: "TEXT", notnull: 1, pk: 0 }, { name: "actor", type: "TEXT", notnull: 1, pk: 0 },
      { name: "generation", type: "INTEGER", notnull: 1, pk: 0 }, { name: "terminal_json", type: "TEXT", notnull: 0, pk: 0 },
    ],
  };
  for (const [table, expected] of Object.entries(required)) {
    const tableRow = (database.prepare("PRAGMA table_list").all() as Row[]).find((row) => row.name === table && row.type === "table");
    if (!tableRow || Number(tableRow.strict) !== 1 || Number(tableRow.wr) !== 0) throw new Error(`Daemon state v3 table ${table} must be a STRICT rowid table.`);
    const actual = database.prepare(`PRAGMA table_xinfo(${table})`).all() as Row[];
    const valid = actual.length === expected.length && expected.every((column, index) => {
      const found = actual[index];
      return found?.name === column.name && String(found.type).toUpperCase() === column.type
        && Number(found.notnull) === column.notnull && Number(found.pk) === column.pk && Number(found.hidden) === 0;
    });
    if (!valid) throw new Error(`Daemon state v3 table ${table} has an invalid column, type, nullability, or primary-key shape.`);
  }
  for (const table of ["work_attempt_lease_epochs", "work_attempt_checkpoints", "work_attempt_executions"]) {
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Row[];
    if (foreignKeys.length !== 1 || foreignKeys[0]?.table !== "work_attempts" || foreignKeys[0]?.from !== "work_attempt_id"
      || foreignKeys[0]?.to !== "work_attempt_id" || String(foreignKeys[0]?.on_delete).toUpperCase() !== "CASCADE") {
      throw new Error(`Daemon state v3 table ${table} has an invalid work-attempt foreign key.`);
    }
  }
  if (!this.hasUniqueIndex(database, "work_attempts", ["workspace_path"], false)
    || !this.hasUniqueIndex(database, "work_attempt_executions", ["work_attempt_id", "generation"], false)) {
    throw new Error("Daemon state v3 required workspace or generation uniqueness constraint is missing.");
  }
  const named = (database.prepare("PRAGMA index_list(work_attempt_executions)").all() as Row[])
    .find((row) => row.name === "one_live_work_attempt_execution");
  const namedTerms = (database.prepare("PRAGMA index_xinfo(one_live_work_attempt_execution)").all() as Row[])
    .filter((row) => Number(row.key) === 1)
    .sort((left, right) => Number(left.seqno) - Number(right.seqno));
  const sql = database.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = 'one_live_work_attempt_execution'").get() as Row | undefined;
  const normalizedSql = String(sql?.sql ?? "").replace(/[\s"`\[\]]+/g, " ").trim().toLowerCase();
  if (!named || Number(named.unique) !== 1 || Number(named.partial) !== 1 || String(named.origin) !== "c" || sql?.tbl_name !== "work_attempt_executions"
    || !this.hasUniqueIndex(database, "work_attempt_executions", ["work_attempt_id"], true, "one_live_work_attempt_execution")
    || namedTerms.length !== 1 || Number(namedTerms[0]?.cid) < 0 || namedTerms[0]?.name !== "work_attempt_id"
    || Number(namedTerms[0]?.desc) !== 0 || String(namedTerms[0]?.coll).toUpperCase() !== "BINARY"
    || !normalizedSql.endsWith("where terminal_json is null")) {
    throw new Error("Daemon state v3 live execution uniqueness index is missing or malformed.");
  }
}

hasUniqueIndex(database: DatabaseSync, table: string, columns: string[], partial: boolean, exactName?: string): boolean {
  const indexes = database.prepare(`PRAGMA index_list(${table})`).all() as Row[];
  return indexes.some((index) => {
    if (exactName !== undefined && index.name !== exactName) return false;
    if (Number(index.unique) !== 1 || Boolean(Number(index.partial)) !== partial) return false;
    const escaped = String(index.name).replace(/"/g, '""');
    const keys = (database.prepare(`PRAGMA index_xinfo("${escaped}")`).all() as Row[])
      .filter((row) => Number(row.key) === 1)
      .sort((left, right) => Number(left.seqno) - Number(right.seqno));
    return keys.length === columns.length && keys.every((row, position) => Number(row.cid) >= 0 && String(row.name) === columns[position]);
  });
}

applyV2Shape(database: DatabaseSync, backfillExitTimestamps: boolean): void {
  if (!this.tableColumns(database, "agent_configurations").has("provider_launch_policy_undefined")) {
    database.exec("ALTER TABLE agent_configurations ADD COLUMN provider_launch_policy_undefined INTEGER NOT NULL DEFAULT 0 CHECK (provider_launch_policy_undefined IN (0, 1))");
  }
  if (!this.tableColumns(database, "runtime_deployments").has("provider_process_identity_present")) {
    database.exec("ALTER TABLE runtime_deployments ADD COLUMN provider_process_identity_present INTEGER NOT NULL DEFAULT 0 CHECK (provider_process_identity_present IN (0, 1))");
    database.exec("UPDATE runtime_deployments SET provider_process_identity_present = CASE WHEN provider_process_identity IS NULL THEN 0 ELSE 1 END");
  }
  database.exec(`CREATE TABLE IF NOT EXISTS reconciliation_exit_timestamps (
    agent_id TEXT NOT NULL REFERENCES reconciliation_records(agent_id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    PRIMARY KEY(agent_id, sort_order)
  ) STRICT`);
  this.normalizeLegacyPresenceEncodings(database);
  if (backfillExitTimestamps && this.tableColumns(database, "reconciliation_records").has("exit_timestamps_json")) {
    const rows = database.prepare(`
      SELECT records.agent_id, records.exit_timestamps_json
      FROM reconciliation_records records
      WHERE records.reconciliation_present = 1
        AND records.exit_timestamps_json IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM reconciliation_exit_timestamps normalized
          WHERE normalized.agent_id = records.agent_id
        )
    `).all() as Row[];
    const insert = database.prepare("INSERT INTO reconciliation_exit_timestamps(agent_id, sort_order, timestamp_ms) VALUES (?, ?, ?)");
    const markBackfilled = database.prepare("UPDATE reconciliation_records SET exit_timestamps_json = NULL WHERE agent_id = ?");
    for (const row of rows) {
      const timestamps = parseJson<unknown[]>(row.exit_timestamps_json);
      if (!Array.isArray(timestamps) || timestamps.some((value) => !Number.isFinite(value))) throw new Error(`Invalid v1 reconciliation exit timestamps for ${String(row.agent_id)}.`);
      timestamps.forEach((timestamp, index) => run(insert, row.agent_id, index, Number(timestamp)));
      run(markBackfilled, row.agent_id);
    }
  }
}

/**
 * v1 could persist an own-property whose value was `undefined` as a presence
 * bit plus NULL columns. Normalize only encodings that cannot represent a
 * valid nullable v2 value, and clear stale payload columns whenever a bit is
 * absent. This prevents reads from manufacturing objects with "null" state.
 */
normalizeLegacyPresenceEncodings(database: DatabaseSync): void {
  database.exec(`
    UPDATE agent_configurations
    SET provider_launch_policy_present = 0,
        provider_launch_policy_undefined = 0,
        provider_launch_policy_json = NULL
    WHERE provider_launch_policy_undefined = 1
       OR (provider_launch_policy_present = 1 AND provider_launch_policy_json IS NULL);
    UPDATE agent_configurations
    SET provider_launch_policy_undefined = 0, provider_launch_policy_json = NULL
    WHERE provider_launch_policy_present = 0;

    UPDATE agent_launch_intents SET source_repo_path = NULL WHERE source_repo_path_present = 0;

    UPDATE runtime_deployments SET workspace_path = NULL WHERE workspace_path_present = 0;
    UPDATE runtime_deployments SET work_attempt_id = NULL WHERE work_attempt_id_present = 0;
    UPDATE runtime_deployments
    SET provider_work_attempt_id = NULL, provider_continuation_id = NULL,
        provider_connection_kind = NULL, provider_connection_url = NULL,
        provider_connection_pid = NULL, provider_process_identity_present = 0,
        provider_process_identity = NULL, provider_execution_generation_id = NULL
    WHERE provider_ref_present = 0;
    UPDATE runtime_deployments
    SET provider_ref_present = 0, provider_work_attempt_id = NULL,
        provider_continuation_id = NULL, provider_connection_kind = NULL,
        provider_connection_url = NULL, provider_connection_pid = NULL,
        provider_process_identity_present = 0, provider_process_identity = NULL,
        provider_execution_generation_id = NULL
    WHERE provider_ref_present = 1
      AND (provider_work_attempt_id IS NULL OR provider_continuation_id IS NULL OR provider_execution_generation_id IS NULL)
      AND NOT (provider_work_attempt_id IS NULL AND provider_continuation_id IS NULL
        AND provider_execution_generation_id IS NULL AND provider_connection_kind IS NULL);
    UPDATE runtime_deployments
    SET provider_connection_kind = NULL, provider_connection_url = NULL,
        provider_connection_pid = NULL, provider_process_identity_present = 0,
        provider_process_identity = NULL
    WHERE provider_connection_kind IS NOT NULL
      AND (provider_connection_kind NOT IN ('codex_app_server', 'claude_cli', 'cursor_cli')
        OR (provider_connection_kind = 'codex_app_server' AND provider_connection_url IS NULL));
    UPDATE runtime_deployments SET provider_process_identity = NULL
    WHERE provider_process_identity_present = 0;

    UPDATE runtime_deployments
    SET workplace_liveness_present = 0, workplace_liveness_state = NULL,
        workplace_liveness_observed_at = NULL, workplace_liveness_detail = NULL
    WHERE workplace_liveness_present = 1 AND workplace_liveness_state IS NULL;
    UPDATE runtime_deployments
    SET workplace_liveness_state = NULL, workplace_liveness_observed_at = NULL,
        workplace_liveness_detail = NULL
    WHERE workplace_liveness_present = 0;
    UPDATE runtime_deployments
    SET native_liveness_present = 0, native_liveness_state = NULL,
        native_liveness_observed_at = NULL, native_liveness_detail = NULL
    WHERE native_liveness_present = 1 AND native_liveness_state IS NULL;
    UPDATE runtime_deployments
    SET native_liveness_state = NULL, native_liveness_observed_at = NULL,
        native_liveness_detail = NULL
    WHERE native_liveness_present = 0;
    DELETE FROM activity_events
    WHERE agent_id IN (SELECT agent_id FROM runtime_deployments WHERE activity_present = 0);

    UPDATE agent_lifecycle_states SET last_error = NULL WHERE last_error_present = 0;
    UPDATE agent_readiness SET ready_reached_at = NULL WHERE ready_reached_at_present = 0;

    UPDATE turn_control_journals SET turn_control_present = 0
    WHERE turn_control_present = 1 AND action_id IS NOT NULL
      AND (turn_work_attempt_id IS NULL OR turn_execution_generation_id IS NULL
        OR has_correction IS NULL OR status IS NULL OR capability IS NULL
        OR recorded_at IS NULL OR updated_at IS NULL);
    UPDATE turn_control_journals
    SET action_id = NULL, turn_work_attempt_id = NULL, turn_execution_generation_id = NULL,
        has_correction = NULL, status = NULL, capability = NULL, interrupted = NULL,
        resumed = NULL, turn_state = NULL, error = NULL, recorded_at = NULL, updated_at = NULL
    WHERE turn_control_present = 0 OR action_id IS NULL;
    DELETE FROM turn_control_stages
    WHERE agent_id IN (SELECT agent_id FROM turn_control_journals WHERE turn_control_present = 0 OR action_id IS NULL);

    UPDATE retained_worker_bindings SET last_worker_binding_present = 0
    WHERE last_worker_binding_present = 1 AND binding_agent_session_id IS NOT NULL
      AND (binding_work_attempt_id IS NULL OR binding_execution_generation_id IS NULL OR binding_updated_at IS NULL);
    UPDATE retained_worker_bindings
    SET binding_agent_session_id = NULL, binding_work_attempt_id = NULL,
        binding_execution_generation_id = NULL, binding_updated_at = NULL
    WHERE last_worker_binding_present = 0 OR binding_agent_session_id IS NULL;

    UPDATE reconciliation_records
    SET reconciliation_present = 0, consecutive_action_failures = NULL,
        last_observed_state = NULL, next_restart_at_ms = NULL, last_action_sequence = NULL,
        pending_action_id = NULL, pending_action_sequence = NULL, pending_action_kind = NULL,
        pending_action_recorded_at_ms = NULL, last_terminal_present = 0,
        terminal_ended_at = NULL, terminal_exit_code = NULL, terminal_signal = NULL,
        terminal_stdio_archive_ref = NULL, terminal_stdio_tail = NULL,
        terminal_cause = NULL, terminal_actor = NULL, terminal_generation = NULL,
        terminal_provider_continuation_id = NULL
    WHERE reconciliation_present = 0 OR consecutive_action_failures IS NULL
       OR last_observed_state IS NULL OR last_action_sequence IS NULL;
    UPDATE reconciliation_records
    SET pending_action_id = NULL, pending_action_sequence = NULL, pending_action_kind = NULL,
        pending_action_recorded_at_ms = NULL
    WHERE pending_action_id IS NULL OR pending_action_sequence IS NULL
       OR pending_action_kind IS NULL OR pending_action_recorded_at_ms IS NULL;
    UPDATE reconciliation_records
    SET last_terminal_present = 0, terminal_ended_at = NULL, terminal_exit_code = NULL,
        terminal_signal = NULL, terminal_stdio_archive_ref = NULL, terminal_stdio_tail = NULL,
        terminal_cause = NULL, terminal_actor = NULL, terminal_generation = NULL,
        terminal_provider_continuation_id = NULL
    WHERE last_terminal_present = 0 OR terminal_ended_at IS NULL OR terminal_stdio_tail IS NULL
       OR terminal_cause IS NULL OR terminal_actor IS NULL OR terminal_generation IS NULL;
    DELETE FROM reconciliation_exit_timestamps
    WHERE agent_id IN (SELECT agent_id FROM reconciliation_records WHERE reconciliation_present = 0);
    DELETE FROM reconciliation_completed_actions
    WHERE agent_id IN (SELECT agent_id FROM reconciliation_records WHERE reconciliation_present = 0);
    DELETE FROM reconciliation_notices
    WHERE agent_id IN (SELECT agent_id FROM reconciliation_records WHERE reconciliation_notices_present = 0);
    UPDATE reconciliation_notices
    SET terminal_present = 0, terminal_ended_at = NULL, terminal_exit_code = NULL,
        terminal_signal = NULL, terminal_stdio_archive_ref = NULL, terminal_stdio_tail = NULL,
        terminal_cause = NULL, terminal_actor = NULL, terminal_generation = NULL,
        terminal_provider_continuation_id = NULL
    WHERE terminal_present = 0 OR terminal_ended_at IS NULL OR terminal_stdio_tail IS NULL
       OR terminal_cause IS NULL OR terminal_actor IS NULL OR terminal_generation IS NULL;
  `);
}

tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((column) => String(column.name)));
}

validateV2Shape(database: DatabaseSync): void {
  const required: Record<string, string[]> = {
    manifest_metadata: ["singleton", "generation", "schema_version"], migration_records: ["migration_key", "checksum", "imported_at"], migration_failures: ["migration_key", "reason", "failed_at", "quarantined_path"],
    agent_identities: ["agent_id", "created_by", "created_at", "sort_order"], agent_profiles: ["agent_id", "display_name"], agent_room_memberships: ["agent_id", "room_id"],
    agent_configurations: ["agent_id", "provider", "model", "charter", "permission_profile_id", "provider_launch_policy_present", "provider_launch_policy_json", "provider_launch_policy_undefined"], agent_launch_intents: ["agent_id", "desired_state", "source_repo_path_present", "source_repo_path"],
    runtime_deployments: ["agent_id", "deployment_id", "run_id", "observed_state", "workspace_path_present", "workspace_path", "work_attempt_id_present", "work_attempt_id", "provider_ref_present", "provider_work_attempt_id", "provider_continuation_id", "provider_connection_kind", "provider_connection_url", "provider_connection_pid", "provider_process_identity", "provider_process_identity_present", "provider_execution_generation_id", "workplace_liveness_present", "workplace_liveness_state", "workplace_liveness_observed_at", "workplace_liveness_detail", "native_liveness_present", "native_liveness_state", "native_liveness_observed_at", "native_liveness_detail", "activity_present"],
    activity_events: ["agent_id", "sort_order", "observed_at", "sequence", "provider", "kind", "method", "summary", "status", "payload_json", "payload_truncated", "payload_redacted", "durable_payload_ref"], agent_lifecycle_states: ["agent_id", "condition", "last_error_present", "last_error"], agent_readiness: ["agent_id", "ready_reached_at_present", "ready_reached_at"],
    turn_control_journals: ["agent_id", "turn_control_present", "action_id", "turn_work_attempt_id", "turn_execution_generation_id", "has_correction", "status", "capability", "interrupted", "resumed", "turn_state", "error", "recorded_at", "updated_at"], turn_control_stages: ["agent_id", "sort_order", "stage"], retained_worker_bindings: ["agent_id", "last_worker_binding_present", "binding_agent_session_id", "binding_work_attempt_id", "binding_execution_generation_id", "binding_updated_at"],
    reconciliation_records: ["agent_id", "reconciliation_present", "consecutive_action_failures", "last_observed_state", "next_restart_at_ms", "last_action_sequence", "pending_action_id", "pending_action_sequence", "pending_action_kind", "pending_action_recorded_at_ms", "last_terminal_present", "terminal_ended_at", "terminal_exit_code", "terminal_signal", "terminal_stdio_archive_ref", "terminal_stdio_tail", "terminal_cause", "terminal_actor", "terminal_generation", "terminal_provider_continuation_id", "reconciliation_notices_present"], reconciliation_exit_timestamps: ["agent_id", "sort_order", "timestamp_ms"], reconciliation_completed_actions: ["agent_id", "sort_order", "action_id"], reconciliation_notices: ["agent_id", "sort_order", "at", "kind", "cause", "terminal_present", "terminal_ended_at", "terminal_exit_code", "terminal_signal", "terminal_stdio_archive_ref", "terminal_stdio_tail", "terminal_cause", "terminal_actor", "terminal_generation", "terminal_provider_continuation_id"],
    legacy_lane_owners: ["reservation_id", "room_id", "provider", "owner_pid", "owner_process_identity", "state", "session_id", "created_at", "updated_at", "sort_order"],
  };
  for (const [table, expected] of Object.entries(required)) {
    const actual = this.tableColumns(database, table);
    const missing = expected.filter((column) => !actual.has(column));
    if (missing.length) throw new Error(`Daemon state v2 table ${table} is missing required columns: ${missing.join(", ")}.`);
  }
}


}

/** Opens a daemon state connection with the non-negotiable durability settings. */
export async function openDaemonStateDatabase(path: string, initializeSchema: (database: DatabaseSync) => void | Promise<void>): Promise<DatabaseSync> {
  const { chmod, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // Fresh sibling daemons can race at the one-time WAL conversion or schema
  // DDL before busy_timeout is fully effective. Close each failed handle and
  // back off outside SQLite; never turn an unrelated initialization error into
  // a retry loop.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(path);
      database.exec("PRAGMA busy_timeout = 5000");
      const mode = String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: unknown }).journal_mode);
      if (mode.toLowerCase() !== "wal") database.exec("PRAGMA journal_mode = WAL");
      const confirmed = String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: unknown }).journal_mode);
      if (confirmed.toLowerCase() !== "wal") throw new Error(`Daemon state requires WAL journal mode, received ${confirmed}.`);
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA synchronous = FULL");
      // v6 can retire a formerly-secret column. Zero deleted cells so a
      // successful migration does not leave its token in reusable SQLite pages.
      database.exec("PRAGMA secure_delete = ON");
      for (const candidate of [path, `${path}-wal`, `${path}-shm`]) { try { await chmod(candidate, 0o600); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      await initializeSchema(database);
      return database;
    } catch (error) {
      try { database?.close(); } catch { /* preserve the triggering error */ }
      if (attempt === 7 || !isSqliteBusyOrLocked(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw new Error("Daemon state initialization retry loop exited unexpectedly.");
}

function isSqliteBusyOrLocked(error: unknown): boolean {
  const candidate = error as NodeJS.ErrnoException;
  const code = String(candidate?.code ?? "").toUpperCase();
  const message = String(candidate?.message ?? error).toUpperCase();
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /SQLITE_(BUSY|LOCKED)|DATABASE IS (BUSY|LOCKED)/.test(message);
}

/** Initialise or upgrade the complete daemon-state schema without retaining a connection. */
export async function ensureDaemonStateDatabase(path: string): Promise<void> {
  const database = await openDaemonStateDatabase(path, (opened) => new DaemonStateSchema().createSchema(opened));
  database.close();
}
