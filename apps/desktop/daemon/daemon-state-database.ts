import { DatabaseSync, type StatementSync } from "node:sqlite";
import { applyExecutionStorageSchema, migrateExecutionStorageV18ToV19, validateExecutionStorageSchema } from "./execution-storage-schema.js";
import { readDurableNativeFailure } from "./supervised-agent-history-retention.js";

export const DAEMON_STATE_SCHEMA_VERSION = 20;
const SCHEMA_VERSION = DAEMON_STATE_SCHEMA_VERSION;
const INBOX_STATES_V17 = "'pending','dispatching','awaiting_result','result_recovery','publishing','retryable','blocked','acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user'";
const INBOX_STATE_CONSTRAINT = /state\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*state\s+IN\s*\(([^)]+)\)\s*\)/i;
type Row = Record<string, unknown>;
function parseJson<T>(value: unknown): T { return JSON.parse(String(value)) as T; }
function run(statement: StatementSync, ...values: unknown[]): void { statement.run(...values as never[]); }
function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

const TERMINAL_RESULTS_TABLE = "supervised_agent_terminal_results";
const TERMINAL_RESULTS_INDEX = "CREATE UNIQUE INDEX supervised_agent_terminal_result_turn ON supervised_agent_terminal_results(agent_id,execution_generation_id,provider_turn_id)";
function terminalResultsSql(version: 19 | 20, table = TERMINAL_RESULTS_TABLE): string {
  return `CREATE TABLE ${table} (
    inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL, execution_generation_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('reply','no_reply','unreadable'${version === 20 ? ",'failed','interrupted'" : ""})),
    normalized_text TEXT, evidence_source TEXT NOT NULL CHECK(evidence_source IN ('transcript','stream','none')),
    terminal_evidence_json TEXT NOT NULL, observed_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ${version === 20 ? ",CHECK(outcome NOT IN ('failed','interrupted') OR (normalized_text IS NULL AND evidence_source <> 'none'))" : ""}
  ) STRICT`;
}

function normalizedTerminalSql(sql: string): string {
  // Preserve case-sensitive CHECK values; ALTER TABLE may quote identifiers.
  return (sql.match(/'(?:''|[^'])*'|[^']+/g) ?? []).map((part) => part.startsWith("'") ? part
    : part.replace(/\bIF\s+NOT\s+EXISTS\s+/gi, "").replaceAll('"', "").replace(/\s+/g, "").toLowerCase())
    .join("").replace(/;$/, "");
}

/** Terminal rows are authority: never repair a lost or weakened definition. */
function validateTerminalResults(database: DatabaseSync, requiredVersion?: 20): 19 | 20 {
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(TERMINAL_RESULTS_TABLE) as Row | undefined;
  const version = ([20, 19] as const).find((candidate) => (!requiredVersion || candidate === requiredVersion)
    && definition && normalizedTerminalSql(String(definition.sql)) === normalizedTerminalSql(terminalResultsSql(candidate)));
  if (!version) throw new Error("Daemon terminal-result authority has an invalid or missing table definition.");
  const index = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='supervised_agent_terminal_result_turn'").get() as Row | undefined;
  const indexes = database.prepare("PRAGMA index_list(supervised_agent_terminal_results)").all() as Row[];
  if (!index || normalizedTerminalSql(String(index.sql)) !== normalizedTerminalSql(TERMINAL_RESULTS_INDEX)
    || indexes.length !== 2 || indexes.filter((entry) => entry.origin === "pk" && Number(entry.unique) === 1).length !== 1
    || database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(TERMINAL_RESULTS_TABLE)) {
    throw new Error("Daemon terminal-result authority has invalid indexes or triggers.");
  }
  for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]) {
    if ((database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(String(name))})`).all() as Row[])
      .some((key) => key.table === TERMINAL_RESULTS_TABLE)) {
      throw new Error("Daemon terminal-result authority has an unrecognized inbound dependency.");
    }
  }
  if (database.prepare("PRAGMA foreign_key_check(supervised_agent_terminal_results)").get()
    || database.prepare(`SELECT 1 FROM supervised_agent_terminal_results
      WHERE outcome NOT IN ('reply','no_reply','unreadable'${version === 20 ? ",'failed','interrupted'" : ""})
        OR evidence_source NOT IN ('transcript','stream','none')
        OR (outcome IN ('failed','interrupted') AND (normalized_text IS NOT NULL OR evidence_source='none')) LIMIT 1`).get()) {
    throw new Error("Daemon terminal-result authority contains invalid evidence.");
  }
  return version;
}

/** Read-only compatibility gate, also used before opening persistent WAL state. */
export function assertDaemonStateVersionSupported(database: DatabaseSync): number {
  const existingVersion = Number((database.prepare("PRAGMA user_version").get() as Row).user_version);
  const hasMetadata = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manifest_metadata'").get();
  const metadata = hasMetadata
    ? database.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton=1").get() as Row | undefined
    : undefined;
  const metadataVersion = metadata ? Number(metadata.schema_version) : undefined;
  if (existingVersion > SCHEMA_VERSION) throw new Error(`Unsupported daemon state schema version ${existingVersion}.`);
  if (metadataVersion !== undefined && metadataVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported daemon manifest metadata schema version ${metadataVersion}.`);
  }
  if (existingVersion === 0 && metadataVersion !== undefined) {
    throw new Error(`Daemon state version pair is inconsistent: user_version=0, metadata schema_version=${metadataVersion}.`);
  }
  if (existingVersion !== 0 && metadataVersion !== existingVersion) {
    throw new Error(`Daemon state version pair is inconsistent: user_version=${existingVersion}, metadata schema_version=${metadataVersion ?? "missing"}.`);
  }
  if (existingVersion >= 18) validateExecutionStorageSchema(database, existingVersion === 18 ? 18 : 19);
  if (existingVersion >= 17) validateTerminalResults(database, existingVersion === 20 ? 20 : undefined);
  if (existingVersion === 20) {
    // Reject inconsistent new terminal authority before legacy upgrade repair
    // can relabel a missing binding as an old, unrecoverable no-reply turn.
    for (const row of database.prepare(`SELECT i.inbox_item_id FROM supervised_agent_inbox i
      LEFT JOIN supervised_agent_terminal_results t ON t.inbox_item_id=i.inbox_item_id
      WHERE t.outcome IN ('failed','interrupted') OR i.state='acknowledged_failed'
        OR CASE WHEN json_valid(i.outcome) THEN json_extract(i.outcome,'$.kind') END IN ('failed','interrupted')`).all() as Row[]) {
      readDurableNativeFailure(database, String(row.inbox_item_id));
    }
  }
  return existingVersion;
}

/** Owns the single daemon-state schema and all version transitions. */
export class DaemonStateSchema {
  constructor(
    private readonly schemaInitializationHook?: (database: DatabaseSync) => void,
    /** Test-only interruption seam after v6 COMMIT, before physical scrub. */
    private readonly postV6CommitBeforeScrubHook?: () => void,
    /** Test-only failure seam used to prove a pending scrub fails closed. */
    private readonly beforeV6ScrubHook?: () => void,
    /** Test-only interruption seam after the v13 repair journal is backed up. */
    private readonly afterV13RepairJournalBackupHook?: () => void,
  ) {}

createSchema(database: DatabaseSync): void {
  const existingVersion = assertDaemonStateVersionSupported(database);
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
  if (existingVersion !== 0 && existingVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported daemon state schema version ${existingVersion}.`);
  }
  if (existingVersion === SCHEMA_VERSION) {
    this.repairAndValidateV20Shape(database);
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
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
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
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
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
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
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
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
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
    // A real v4 database has none of the delivery v7-v9 or inspector v10
    // tables, so complete and validate the current shape before advancing
    // either version marker.
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
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
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
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
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

/** V8 is an additive, transactionally versioned inspector-history upgrade. */
migrateV7ToV8(database: DatabaseSync): void {
  // First repair exactly the v7 additive shape. This preserves the prior
  // fail-closed scrub guard before the new version marker is advanced.
  this.repairAndValidateV7Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

/** V9 makes message identity room-scoped and verifies cross-table delivery evidence. */
migrateV8ToV9(database: DatabaseSync): void {
  this.repairAndValidateV8Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

/** V10 adds revisioned Inspector configuration and durable room-move journals. */
migrateV9ToV10(database: DatabaseSync): void {
  this.repairAndValidateV9Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyCurrentSchemaTail(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** V11 binds every external purge acknowledgement to its exact worker session. */
migrateV10ToV11(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (this.tableColumns(database, "agent_purge_operations").size) this.rebuildPurgeOperationsV11(database);
    this.applyCurrentSchemaTail(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** V12 records the crash-safe local state of every supervisor worker mint. */
migrateV11ToV12(database: DatabaseSync): void {
  this.repairAndValidateV11Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyCurrentSchemaTail(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** V13 journals safe same-process continuation repair and user cancellation. */
migrateV12ToV13(database: DatabaseSync): void {
  this.repairAndValidateV12Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV13Shape(database);
    this.validateV13Shape(database);
    this.applyV14Shape(database);
    this.validateV14Shape(database);
    this.applyV15Shape(database);
    this.validateV15Shape(database);
    this.applyV16Shape(database);
    this.validateV16Shape(database);
    this.applyV17Shape(database, true);
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** V14 preserves the complete OpenCode server identity across daemon handoff. */
migrateV13ToV14(database: DatabaseSync): void {
  this.repairAndValidateV13Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV14Shape(database);
    this.validateV14Shape(database);
    this.applyV15Shape(database);
    this.validateV15Shape(database);
    this.applyV16Shape(database);
    this.validateV16Shape(database);
    this.applyV17Shape(database, true);
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** V15 separates lifetime action replay memory from the bounded manifest view. */
migrateV14ToV15(database: DatabaseSync): void {
  this.repairAndValidateV14Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV15Shape(database);
    this.validateV15Shape(database);
    this.applyV16Shape(database);
    this.validateV16Shape(database);
    this.applyV17Shape(database, true);
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** V16 binds every native turn id to its immutable provider authority scope. */
migrateV15ToV16(database: DatabaseSync): void {
  this.repairAndValidateV15Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV16Shape(database);
    this.validateV16Shape(database);
    this.applyV17Shape(database, true);
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** V17 gives every ordinary MCP effect a durable class and honest ambiguity lifecycle. */
migrateV16ToV17(database: DatabaseSync): void {
  this.repairAndValidateV16Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV17Shape(database, true);
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** V18 reserves typed execution storage without changing legacy delivery decisions. */
migrateV17ToV18(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** V19 adds observer fencing and proof slots, never historical outcomes. */
migrateV18ToV19(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV18Shape(database, 18);
    migrateExecutionStorageV18ToV19(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** Only the terminal-result CHECK changes; native evidence is not reinterpreted. */
migrateV19ToV20(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV18Shape(database);
    this.applyV20Shape(database);
    this.schemaInitializationHook?.(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

private applyV20Shape(database: DatabaseSync): void {
  if (validateTerminalResults(database) === 20) return;
  database.exec(`
    ${terminalResultsSql(20, "supervised_agent_terminal_results_v20")};
    INSERT INTO supervised_agent_terminal_results_v20(rowid,inbox_item_id,agent_id,execution_generation_id,provider_turn_id,outcome,normalized_text,evidence_source,terminal_evidence_json,observed_at,updated_at)
      SELECT rowid,inbox_item_id,agent_id,execution_generation_id,provider_turn_id,outcome,normalized_text,evidence_source,terminal_evidence_json,observed_at,updated_at FROM supervised_agent_terminal_results;
    DROP TABLE supervised_agent_terminal_results;
    ALTER TABLE supervised_agent_terminal_results_v20 RENAME TO supervised_agent_terminal_results;
    ${TERMINAL_RESULTS_INDEX};
  `);
  validateTerminalResults(database, 20);
}

private createPurgeOperationsV11(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_purge_operations (
      operation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),
      phase TEXT NOT NULL CHECK(phase IN ('prepared','reprepare_credentials','revoking_credentials','local_commit','complete','failed')),
      external_revoke_required INTEGER NOT NULL CHECK(external_revoke_required IN (0,1)),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attached_work_attempt_id TEXT,
      preserved_workspace_path TEXT,
      worker_session_attestation TEXT NOT NULL CHECK(worker_session_attestation IN ('exact','none','unknown','not_required')),
      agent_session_id TEXT,
      CHECK(
        (external_revoke_required=0 AND worker_session_attestation='not_required' AND agent_session_id IS NULL)
        OR
        (external_revoke_required=1 AND (
          (worker_session_attestation='exact' AND agent_session_id IS NOT NULL)
          OR
          (worker_session_attestation IN ('none','unknown') AND agent_session_id IS NULL)
        ))
      )
    ) STRICT;
  `);
}

private durablePurgeMigrationSession(database: DatabaseSync, agentId: string): string | null {
  const retained = database.prepare(`SELECT binding_agent_session_id FROM retained_worker_bindings
    WHERE agent_id=? AND last_worker_binding_present=1 AND binding_agent_session_id IS NOT NULL`).get(agentId) as Row | undefined;
  if (typeof retained?.binding_agent_session_id === "string" && retained.binding_agent_session_id.trim()) {
    return retained.binding_agent_session_id.trim();
  }
  const supervised = database.prepare("SELECT agent_session_id FROM supervised_worker_sessions WHERE agent_id=?").get(agentId) as Row | undefined;
  if (typeof supervised?.agent_session_id === "string" && supervised.agent_session_id.trim()) {
    return supervised.agent_session_id.trim();
  }
  const ids = new Set<string>();
  for (const [table, column] of [
    ["worker_session_bindings", "entry_id"],
    ["worker_binding_publications", "entry_id"],
    ["worker_generation_verifications", "entry_id"],
  ] as const) {
    for (const row of database.prepare(`SELECT DISTINCT agent_session_id FROM ${table} WHERE ${column}=?`).all(agentId) as Row[]) {
      if (typeof row.agent_session_id === "string" && row.agent_session_id.trim()) ids.add(row.agent_session_id.trim());
    }
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

/**
 * Rebuild instead of ALTER: v10's phase CHECK cannot represent a recoverable
 * ambiguous purge. Active external rows are deliberately put back before the
 * revoke boundary, even when the legacy row claimed local_commit.
 */
private rebuildPurgeOperationsV11(database: DatabaseSync): void {
  const rows = database.prepare("SELECT * FROM agent_purge_operations ORDER BY created_at,operation_id").all() as Row[];
  database.exec(`
    DROP INDEX IF EXISTS agent_purge_operations_agent_updated;
    DROP INDEX IF EXISTS one_active_agent_purge;
    ALTER TABLE agent_purge_operations RENAME TO agent_purge_operations_pre_v11;
  `);
  this.createPurgeOperationsV11(database);
  const insert = database.prepare(`INSERT INTO agent_purge_operations
    (operation_id,request_id,agent_id,daemon_generation,phase,external_revoke_required,error,created_at,updated_at,
      attached_work_attempt_id,preserved_workspace_path,worker_session_attestation,agent_session_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    const agentId = String(row.agent_id);
    const external = Number(row.external_revoke_required) === 1;
    const terminal = row.phase === "complete" || row.phase === "failed";
    const storedAttestation = typeof row.worker_session_attestation === "string"
      ? row.worker_session_attestation
      : null;
    const storedSession = typeof row.agent_session_id === "string" && row.agent_session_id.trim()
      ? row.agent_session_id.trim()
      : null;
    const recoveredSession = storedSession ?? this.durablePurgeMigrationSession(database, agentId);
    let phase = String(row.phase);
    let attestation: "exact" | "none" | "unknown" | "not_required";
    let sessionId: string | null;
    if (!external) {
      attestation = "not_required";
      sessionId = null;
      if (!terminal) phase = "local_commit";
    } else if (terminal) {
      attestation = storedAttestation === "none"
        ? "none"
        : recoveredSession ? "exact" : "unknown";
      sessionId = attestation === "exact" ? recoveredSession : null;
    } else if (storedAttestation === "none") {
      attestation = "none";
      sessionId = null;
      phase = "revoking_credentials";
    } else if (recoveredSession) {
      attestation = "exact";
      sessionId = recoveredSession;
      phase = "revoking_credentials";
    } else {
      attestation = "unknown";
      sessionId = null;
      phase = "reprepare_credentials";
    }
    run(insert,
      row.operation_id, row.request_id, agentId, row.daemon_generation, phase, external ? 1 : 0,
      row.error ?? null, row.created_at, row.updated_at, row.attached_work_attempt_id ?? null,
      row.preserved_workspace_path ?? null, attestation, sessionId);
  }
  database.exec("DROP TABLE agent_purge_operations_pre_v11");
}

private applyV11Shape(database: DatabaseSync): void {
  const columns = this.tableColumns(database, "agent_configurations");
  if (!columns.has("reasoning_effort")) database.exec("ALTER TABLE agent_configurations ADD COLUMN reasoning_effort TEXT");
  if (!columns.has("config_revision")) database.exec("ALTER TABLE agent_configurations ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1 CHECK(config_revision >= 1)");
  if (!columns.has("runtime_configuration_revision")) database.exec("ALTER TABLE agent_configurations ADD COLUMN runtime_configuration_revision INTEGER NOT NULL DEFAULT 1 CHECK(runtime_configuration_revision >= 1)");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_room_moves (
      operation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL,
      destination_room_id TEXT NOT NULL,
      daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),
      work_attempt_id TEXT,
      execution_generation_id TEXT,
      agent_session_id TEXT,
      activating_inbox_item_id TEXT,
      provider_turn_id TEXT,
      effect_id TEXT,
      phase TEXT NOT NULL CHECK(phase IN ('prepared','waiting_for_current_turn','joining_destination','membership_committed','rotating_credentials','bootstrapping_destination_tail','active','failed','rollback_required')),
      remote_room_id TEXT,
      destination_cursor TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_cursor_present INTEGER NOT NULL DEFAULT 0 CHECK(source_cursor_present IN (0,1)),
      source_cursor TEXT,
      source_credentials_revoked INTEGER NOT NULL DEFAULT 0 CHECK(source_credentials_revoked IN (0,1)),
      CHECK(source_room_id <> destination_room_id),
      CHECK((work_attempt_id IS NULL) = (execution_generation_id IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_room_moves_agent_updated ON agent_room_moves(agent_id, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_agent_room_move ON agent_room_moves(agent_id)
      WHERE phase NOT IN ('active','failed');
  `);
  this.createPurgeOperationsV11(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS agent_purge_operations_agent_updated ON agent_purge_operations(agent_id,updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_agent_purge ON agent_purge_operations(agent_id)
      WHERE phase NOT IN ('complete','failed');
  `);
}

private validateV11Shape(database: DatabaseSync): void {
  const columns = this.tableColumns(database, "agent_configurations");
  for (const column of ["reasoning_effort", "config_revision", "runtime_configuration_revision"]) {
    if (!columns.has(column)) throw new Error(`Daemon state v11 is missing agent configuration column ${column}.`);
  }
  const moves = this.tableColumns(database, "agent_room_moves");
  for (const column of ["operation_id", "request_id", "agent_id", "source_room_id", "destination_room_id", "daemon_generation", "work_attempt_id", "execution_generation_id", "agent_session_id", "activating_inbox_item_id", "provider_turn_id", "effect_id", "phase", "remote_room_id", "destination_cursor", "source_credentials_revoked", "created_at", "updated_at", "source_cursor_present", "source_cursor"]) {
    if (!moves.has(column)) throw new Error(`Daemon state v11 is missing room-move column ${column}.`);
  }
  const purges = this.tableColumns(database, "agent_purge_operations");
  for (const column of ["operation_id", "request_id", "agent_id", "daemon_generation", "phase", "external_revoke_required", "created_at", "updated_at", "attached_work_attempt_id", "preserved_workspace_path", "worker_session_attestation", "agent_session_id"]) {
    if (!purges.has(column)) throw new Error(`Daemon state v11 is missing purge-operation column ${column}.`);
  }
  const normalizeSql = (value: string) => value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replaceAll('"', "").replaceAll("`", "").replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").replace(/\)\s*strict$/i, ")strict").trim().toLowerCase();
  const canonicalTables: Record<string, string> = {
    agent_room_moves: `CREATE TABLE agent_room_moves (operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,agent_id TEXT NOT NULL,source_room_id TEXT NOT NULL,destination_room_id TEXT NOT NULL,daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),work_attempt_id TEXT,execution_generation_id TEXT,agent_session_id TEXT,activating_inbox_item_id TEXT,provider_turn_id TEXT,effect_id TEXT,phase TEXT NOT NULL CHECK(phase IN ('prepared','waiting_for_current_turn','joining_destination','membership_committed','rotating_credentials','bootstrapping_destination_tail','active','failed','rollback_required')),remote_room_id TEXT,destination_cursor TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_cursor_present INTEGER NOT NULL DEFAULT 0 CHECK(source_cursor_present IN (0,1)),source_cursor TEXT,source_credentials_revoked INTEGER NOT NULL DEFAULT 0 CHECK(source_credentials_revoked IN (0,1)),CHECK(source_room_id <> destination_room_id),CHECK((work_attempt_id IS NULL) = (execution_generation_id IS NULL))) STRICT`,
    agent_purge_operations: `CREATE TABLE agent_purge_operations (operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,agent_id TEXT NOT NULL,daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),phase TEXT NOT NULL CHECK(phase IN ('prepared','reprepare_credentials','revoking_credentials','local_commit','complete','failed')),external_revoke_required INTEGER NOT NULL CHECK(external_revoke_required IN (0,1)),error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,attached_work_attempt_id TEXT,preserved_workspace_path TEXT,worker_session_attestation TEXT NOT NULL CHECK(worker_session_attestation IN ('exact','none','unknown','not_required')),agent_session_id TEXT,CHECK((external_revoke_required=0 AND worker_session_attestation='not_required' AND agent_session_id IS NULL) OR (external_revoke_required=1 AND ((worker_session_attestation='exact' AND agent_session_id IS NOT NULL) OR (worker_session_attestation IN ('none','unknown') AND agent_session_id IS NULL))))) STRICT`,
  };
  const strictTables = database.prepare("PRAGMA table_list").all() as Row[];
  for (const table of ["agent_room_moves", "agent_purge_operations"]) {
    const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
    if (!definition || normalizeSql(String(definition.sql)) !== normalizeSql(canonicalTables[table]!)) throw new Error(`Daemon state v11 table ${table} does not match its canonical definition.`);
    const info = strictTables.find((row) => row.name === table && row.type === "table");
    if (!info || Number(info.strict) !== 1 || Number(info.wr) !== 0) throw new Error(`Daemon state v11 table ${table} must be a strict rowid table.`);
    const fk = database.prepare(`PRAGMA foreign_key_check(${table})`).get();
    if (fk) throw new Error(`Daemon state v11 table ${table} contains a broken foreign key.`);
  }
  const indexes: Record<string, { table: string; unique: number; partial: number; columns: string[] }> = {
    agent_room_moves_agent_updated: { table: "agent_room_moves", unique: 0, partial: 0, columns: ["agent_id", "updated_at"] },
    one_active_agent_room_move: { table: "agent_room_moves", unique: 1, partial: 1, columns: ["agent_id"] },
    agent_purge_operations_agent_updated: { table: "agent_purge_operations", unique: 0, partial: 0, columns: ["agent_id", "updated_at"] },
    one_active_agent_purge: { table: "agent_purge_operations", unique: 1, partial: 1, columns: ["agent_id"] },
  };
  const canonicalIndexes: Record<string, string> = {
    agent_room_moves_agent_updated: "CREATE INDEX agent_room_moves_agent_updated ON agent_room_moves(agent_id,updated_at)",
    one_active_agent_room_move: "CREATE UNIQUE INDEX one_active_agent_room_move ON agent_room_moves(agent_id) WHERE phase NOT IN ('active','failed')",
    agent_purge_operations_agent_updated: "CREATE INDEX agent_purge_operations_agent_updated ON agent_purge_operations(agent_id,updated_at)",
    one_active_agent_purge: "CREATE UNIQUE INDEX one_active_agent_purge ON agent_purge_operations(agent_id) WHERE phase NOT IN ('complete','failed')",
  };
  for (const [name, expected] of Object.entries(indexes)) {
    const listed = (database.prepare(`PRAGMA index_list(${expected.table})`).all() as Row[]).find((row) => row.name === name);
    const terms = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Row[]).filter((row) => Number(row.key) === 1).sort((a, b) => Number(a.seqno) - Number(b.seqno));
    const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as Row | undefined;
    if (!listed || String(listed.origin) !== "c" || Number(listed.unique) !== expected.unique || Number(listed.partial) !== expected.partial || !definition || normalizeSql(String(definition.sql)) !== normalizeSql(canonicalIndexes[name]!) || terms.length !== expected.columns.length || terms.some((term, index) => Number(term.cid) < 0 || term.name !== expected.columns[index] || Number(term.desc) !== 0 || String(term.coll).toUpperCase() !== "BINARY")) throw new Error(`Daemon state v11 index ${name} is invalid.`);
  }
  const integrity = database.prepare("PRAGMA integrity_check").get() as Row | undefined;
  if (!integrity || Object.values(integrity)[0] !== "ok" || database.prepare("PRAGMA foreign_key_check").get()) throw new Error("Daemon state v11 failed SQLite integrity validation.");
}

repairAndValidateV11Shape(database: DatabaseSync): void {
  this.repairAndValidateV9Shape(database);
  const columns = this.tableColumns(database, "agent_configurations");
  const purgeColumns = this.tableColumns(database, "agent_purge_operations");
  if (columns.has("reasoning_effort") && columns.has("config_revision") && columns.has("runtime_configuration_revision") && this.tableColumns(database, "agent_room_moves").has("source_cursor_present")
    && this.tableColumns(database, "agent_room_moves").has("source_credentials_revoked")
    && purgeColumns.has("attached_work_attempt_id") && purgeColumns.has("preserved_workspace_path")
    && purgeColumns.has("worker_session_attestation") && purgeColumns.has("agent_session_id")) {
    this.applyV11Shape(database);
    this.validateV11Shape(database);
    return;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    let moveColumns = this.tableColumns(database, "agent_room_moves");
    if (moveColumns.size && !moveColumns.has("request_id")) {
      const count = Number((database.prepare("SELECT COUNT(*) AS count FROM agent_room_moves").get() as Row).count);
      if (count !== 0) throw new Error("Cannot repair the prerelease v10 room-move journal because it contains operations.");
      database.exec("DROP TABLE agent_room_moves");
      moveColumns = new Set();
    }
    if (moveColumns.size && !moveColumns.has("source_cursor_present")) {
      database.exec("ALTER TABLE agent_room_moves ADD COLUMN source_cursor_present INTEGER NOT NULL DEFAULT 0 CHECK(source_cursor_present IN (0,1))");
    }
    if (moveColumns.size && !moveColumns.has("source_cursor")) {
      database.exec("ALTER TABLE agent_room_moves ADD COLUMN source_cursor TEXT");
    }
    if (moveColumns.size && !moveColumns.has("source_credentials_revoked")) {
      database.exec("ALTER TABLE agent_room_moves ADD COLUMN source_credentials_revoked INTEGER NOT NULL DEFAULT 0 CHECK(source_credentials_revoked IN (0,1))");
    }
    let purgeColumns = this.tableColumns(database, "agent_purge_operations");
    if (purgeColumns.size && !purgeColumns.has("attached_work_attempt_id")) {
      database.exec("ALTER TABLE agent_purge_operations ADD COLUMN attached_work_attempt_id TEXT");
    }
    if (purgeColumns.size && !purgeColumns.has("preserved_workspace_path")) {
      database.exec("ALTER TABLE agent_purge_operations ADD COLUMN preserved_workspace_path TEXT");
    }
    if (purgeColumns.size && !purgeColumns.has("agent_session_id")) {
      database.exec("ALTER TABLE agent_purge_operations ADD COLUMN agent_session_id TEXT");
    }
    purgeColumns = this.tableColumns(database, "agent_purge_operations");
    if (purgeColumns.size && !purgeColumns.has("worker_session_attestation")) {
      this.rebuildPurgeOperationsV11(database);
    }
    this.applyV11Shape(database); this.validateV11Shape(database); database.exec("COMMIT");
  }
  catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
}

private applyV12Shape(database: DatabaseSync): void {
  this.applyV11Shape(database);
  const existed = this.tableColumns(database, "supervised_worker_mint_states").size > 0;
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervised_worker_mint_states (
      agent_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      agent_instance_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('never_minted','minting_unknown','exact')),
      agent_session_id TEXT,
      updated_at TEXT NOT NULL,
      CHECK(
        (phase='exact' AND agent_session_id IS NOT NULL)
        OR
        (phase IN ('never_minted','minting_unknown') AND agent_session_id IS NULL)
      )
    ) STRICT;
  `);
  if (!existed) {
    // V11 had no mint journal. Seed only facts that its durable records can
    // actually prove; omitted legacy bindings deliberately remain unknown.
    const now = new Date().toISOString();
    run(database.prepare(`
      INSERT INTO supervised_worker_mint_states
        (agent_id,room_id,agent_instance_id,phase,agent_session_id,updated_at)
      SELECT b.agent_id,m.room_id,'daemon:' || b.agent_id,
        CASE WHEN b.binding_agent_session_id IS NULL THEN 'minting_unknown' ELSE 'exact' END,
        b.binding_agent_session_id,COALESCE(b.binding_updated_at,?)
      FROM retained_worker_bindings b
      JOIN agent_room_memberships m USING(agent_id)
      WHERE b.last_worker_binding_present=1
    `), now);
    run(database.prepare(`
      INSERT OR REPLACE INTO supervised_worker_mint_states
        (agent_id,room_id,agent_instance_id,phase,agent_session_id,updated_at)
      SELECT agent_id,room_id,'daemon:' || agent_id,'exact',agent_session_id,updated_at
      FROM supervised_worker_sessions
    `));
  }
}

/**
 * Every legacy migration in this file advances directly to the current
 * paired version marker. Keep the physical v12 validation ahead of the v13
 * inbox rebuild so an incomplete predecessor can never be disguised by the
 * continuation-repair tables.
 */
private applyCurrentSchemaTail(database: DatabaseSync): void {
  this.applyV12Shape(database);
  this.validateV12Shape(database);
  this.applyV13Shape(database);
  this.validateV13Shape(database);
  this.applyV14Shape(database);
  this.validateV14Shape(database);
  this.applyV15Shape(database);
  this.validateV15Shape(database);
  this.applyV16Shape(database);
  this.validateV16Shape(database);
  this.applyV17Shape(database, true);
  this.validateV17Shape(database);
  this.applyV18Shape(database);
  this.validateV18Shape(database);
  this.applyV20Shape(database);
}

private validateV12Shape(database: DatabaseSync): void {
  this.validateV11Shape(database);
  const expectedColumns = ["agent_id", "room_id", "agent_instance_id", "phase", "agent_session_id", "updated_at"];
  const details = database.prepare("PRAGMA table_xinfo(supervised_worker_mint_states)")
    .all() as Array<{ name: string; hidden: number }>;
  const actualColumns = details.map((column) => String(column.name));
  if (actualColumns.length !== expectedColumns.length
    || expectedColumns.some((column, index) => actualColumns[index] !== column)
    || details.some((column) => Number(column.hidden) !== 0)) {
    throw new Error("Daemon state v12 mint-state table has invalid columns.");
  }
  if (actualColumns.some((column) => /(token|bearer|credential|secret)/i.test(column))) {
    throw new Error("Daemon state v12 mint-state table must never persist worker credentials.");
  }
  const normalizeSql = (value: string) => value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replaceAll('"', "").replaceAll("`", "").replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").replace(/\)\s*strict$/i, ")strict").trim().toLowerCase();
  const canonical = `CREATE TABLE supervised_worker_mint_states (agent_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,agent_instance_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('never_minted','minting_unknown','exact')),agent_session_id TEXT,updated_at TEXT NOT NULL,CHECK((phase='exact' AND agent_session_id IS NOT NULL) OR (phase IN ('never_minted','minting_unknown') AND agent_session_id IS NULL))) STRICT`;
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_worker_mint_states'").get() as Row | undefined;
  const info = (database.prepare("PRAGMA table_list").all() as Row[])
    .find((row) => row.name === "supervised_worker_mint_states" && row.type === "table");
  if (!definition || normalizeSql(String(definition.sql)) !== normalizeSql(canonical)
    || !info || Number(info.strict) !== 1 || Number(info.wr) !== 0) {
    throw new Error("Daemon state v12 mint-state table does not match its canonical strict definition.");
  }
}

repairAndValidateV12Shape(database: DatabaseSync): void {
  this.repairAndValidateV11Shape(database);
  const columns = this.tableColumns(database, "supervised_worker_mint_states");
  if (columns.size === 0) {
    throw new Error("Daemon state v12 is missing its mint-state table and cannot safely reconstruct erased mint attempts.");
  }
  this.validateV12Shape(database);
}

private applyV13Shape(database: DatabaseSync): void {
  const inboxColumns = this.tableColumns(database, "supervised_agent_inbox");
  const hasFailureCode = inboxColumns.has("failure_code");
  const hasRepairJournal = this.tableColumns(database, "provider_continuation_repairs").size > 0;
  const inboxDefinition = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'",
  ).get() as Row | undefined;
  const retainedInboxStates = INBOX_STATE_CONSTRAINT.exec(String(inboxDefinition?.sql))?.[1]?.replace(/\s/g, "") === `${INBOX_STATES_V17},'acknowledged_failed'`
    ? `${INBOX_STATES_V17},'acknowledged_failed'` : INBOX_STATES_V17;
  const hasCanonicalFailureCodeConstraint = /CHECK\s*\(\s*failure_code\s+IS\s+NULL\s+OR\s+failure_code\s*=\s*'provider_continuation_missing'\s*\)/i
    .test(String(inboxDefinition?.sql));
  if (hasFailureCode && hasRepairJournal && hasCanonicalFailureCodeConstraint) {
    // The causal event table is additive evidence. A current-version reopen
    // may safely recreate an absent empty journal, but it must never rebuild
    // the authoritative inbox or repair journal in place.
    if (!this.tableColumns(database, "supervised_agent_inbox_events").size) {
      database.exec(`
        CREATE TABLE supervised_agent_inbox_events (
          inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
          event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
          idempotency_key TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled','conversation_restoring','conversation_restored','user_cancelled')),
          observed_at TEXT NOT NULL,
          detail TEXT,
          PRIMARY KEY(inbox_item_id,event_sequence),
          UNIQUE(inbox_item_id,idempotency_key)
        ) STRICT;
        CREATE INDEX supervised_agent_inbox_events_timeline
          ON supervised_agent_inbox_events(inbox_item_id,event_sequence);
      `);
    }
    return;
  }
  if (hasFailureCode) {
    const invalidFailureCode = database.prepare(`
      SELECT failure_code
      FROM supervised_agent_inbox
      WHERE failure_code IS NOT NULL
        AND failure_code <> 'provider_continuation_missing'
      LIMIT 1
    `).get() as Row | undefined;
    if (invalidFailureCode) {
      throw new Error("Daemon state v13 inbox contains an unsupported continuation failure code.");
    }
  }
  const migratedFailureCode = hasFailureCode
    ? `CASE
        WHEN failure_code='provider_continuation_missing' THEN failure_code
        WHEN state='blocked' AND attempt_count=0 AND provider_turn_id IS NULL AND outcome IS NULL
          AND lower(last_error) GLOB 'thread not found: ????????-????-????-????-????????????'
          THEN 'provider_continuation_missing'
        ELSE NULL
      END`
    : `CASE WHEN state='blocked' AND attempt_count=0 AND provider_turn_id IS NULL AND outcome IS NULL
        AND lower(last_error) GLOB 'thread not found: ????????-????-????-????-????????????'
        THEN 'provider_continuation_missing' ELSE NULL END`;

  const terminalVersion = validateTerminalResults(database);
  // A rolled-back version marker or interrupted legacy repair can retain the
  // current repair journal while temporarily rebuilding the older delivery
  // tables. Preserve those rows outside the foreign-key graph while the
  // authoritative inbox is rebuilt, then restore them against the new parent.
  if (hasRepairJournal) {
    database.exec(`
      DROP TABLE IF EXISTS temp.provider_continuation_repairs_v13_backup;
      CREATE TEMP TABLE provider_continuation_repairs_v13_backup AS
        SELECT * FROM provider_continuation_repairs;
      DROP TABLE provider_continuation_repairs;
    `);
    this.afterV13RepairJournalBackupHook?.();
  }
  const restoreNativeTurnBindings = this.detachLaterInboxTables(database, ["supervised_agent_provider_turn_bindings"]);
  database.exec(`
    PRAGMA defer_foreign_keys = ON;
    ALTER TABLE supervised_agent_inbox RENAME TO supervised_agent_inbox_pre_v13;

    CREATE TABLE supervised_agent_inbox (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      source_message_json TEXT NOT NULL, activation_json TEXT NOT NULL,
      fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence > 0),
      state TEXT NOT NULL CHECK (state IN (${retainedInboxStates})),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      action_id TEXT NOT NULL, reply_client_message_id TEXT NOT NULL,
      provider_turn_id TEXT, outcome TEXT, last_error TEXT,
      failure_code TEXT CHECK(failure_code IS NULL OR failure_code='provider_continuation_missing'),
      blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),
      next_attempt_at_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged_at TEXT,
      UNIQUE(agent_id,room_id,source_message_id), UNIQUE(agent_id,fifo_sequence),
      UNIQUE(inbox_item_id,agent_id,room_id)
    ) STRICT;
    INSERT INTO supervised_agent_inbox
      (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,failure_code,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
      SELECT inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,
        ${migratedFailureCode},
        blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at
      FROM supervised_agent_inbox_pre_v13;

    CREATE TABLE supervised_agent_inbox_events_v13 (
      inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
      idempotency_key TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled','conversation_restoring','conversation_restored','user_cancelled')),
      observed_at TEXT NOT NULL, detail TEXT,
      PRIMARY KEY(inbox_item_id,event_sequence), UNIQUE(inbox_item_id,idempotency_key)
    ) STRICT;
    INSERT INTO supervised_agent_inbox_events_v13 SELECT * FROM supervised_agent_inbox_events;

    ${terminalResultsSql(terminalVersion, "supervised_agent_terminal_results_v13")};
    INSERT INTO supervised_agent_terminal_results_v13 SELECT * FROM supervised_agent_terminal_results;

    CREATE TABLE supervised_agent_publications_v13 (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL, canonical_message_id TEXT NOT NULL, published_at TEXT NOT NULL,
      FOREIGN KEY(inbox_item_id,agent_id,room_id)
        REFERENCES supervised_agent_inbox(inbox_item_id,agent_id,room_id) ON DELETE CASCADE,
      UNIQUE(room_id,client_message_id), UNIQUE(room_id,canonical_message_id)
    ) STRICT;
    INSERT INTO supervised_agent_publications_v13 SELECT * FROM supervised_agent_publications;

    DROP TABLE supervised_agent_inbox_events;
    DROP TABLE supervised_agent_terminal_results;
    DROP TABLE supervised_agent_publications;
    DROP TABLE supervised_agent_inbox_pre_v13;

    ALTER TABLE supervised_agent_inbox_events_v13 RENAME TO supervised_agent_inbox_events;
    ALTER TABLE supervised_agent_terminal_results_v13 RENAME TO supervised_agent_terminal_results;
    ALTER TABLE supervised_agent_publications_v13 RENAME TO supervised_agent_publications;

    CREATE INDEX supervised_agent_inbox_head ON supervised_agent_inbox(agent_id,fifo_sequence);
    CREATE INDEX supervised_agent_inbox_events_timeline ON supervised_agent_inbox_events(inbox_item_id,event_sequence);
    CREATE UNIQUE INDEX supervised_agent_terminal_result_turn ON supervised_agent_terminal_results(agent_id,execution_generation_id,provider_turn_id);
    CREATE INDEX supervised_agent_publications_agent_room ON supervised_agent_publications(agent_id,room_id);

    CREATE TABLE provider_continuation_repairs (
      repair_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      inbox_item_id TEXT NOT NULL,
      daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 1),
      execution_generation_id TEXT NOT NULL,
      work_attempt_id TEXT NOT NULL,
      expected_pid INTEGER NOT NULL CHECK(expected_pid > 0),
      expected_process_identity TEXT NOT NULL,
      missing_continuation TEXT NOT NULL,
      replacement_continuation TEXT,
      phase TEXT NOT NULL CHECK(phase IN ('probing','replacement_created','committed','failed')),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(inbox_item_id,agent_id,room_id)
        REFERENCES supervised_agent_inbox(inbox_item_id,agent_id,room_id) ON DELETE CASCADE
    ) STRICT;
    CREATE UNIQUE INDEX one_active_provider_continuation_repair
      ON provider_continuation_repairs(agent_id) WHERE phase NOT IN ('committed','failed');
    CREATE INDEX provider_continuation_repairs_inbox
      ON provider_continuation_repairs(inbox_item_id,updated_at);
  `);
  if (hasRepairJournal) {
    database.exec(`
      INSERT INTO provider_continuation_repairs
        SELECT * FROM temp.provider_continuation_repairs_v13_backup;
      DROP TABLE temp.provider_continuation_repairs_v13_backup;
    `);
  }
  restoreNativeTurnBindings();
}

private validateV13Shape(database: DatabaseSync): void {
  this.validateV12Shape(database);
  const inboxColumns = this.tableColumns(database, "supervised_agent_inbox");
  const hasV17TerminalReason = inboxColumns.has("terminal_reason");
  const repairColumns = this.tableColumns(database, "provider_continuation_repairs");
  const expectedInboxColumns = [
    "inbox_item_id", "agent_id", "room_id", "source_message_id", "source_message_json",
    "activation_json", "fifo_sequence", "state", "attempt_count", "action_id",
    "reply_client_message_id", "provider_turn_id", "outcome", "last_error", "failure_code",
    "blocked_by_inbox_item_id", "next_attempt_at_ms", "created_at", "updated_at", "acknowledged_at",
    ...(hasV17TerminalReason ? ["terminal_reason"] : []),
  ];
  const expectedRepairColumns = [
    "repair_id", "agent_id", "room_id", "inbox_item_id", "daemon_generation",
    "execution_generation_id", "work_attempt_id", "expected_pid",
    "expected_process_identity", "missing_continuation", "replacement_continuation",
    "phase", "attempt_count", "last_error", "created_at", "updated_at",
  ];
  if (inboxColumns.size !== expectedInboxColumns.length
    || expectedInboxColumns.some((column) => !inboxColumns.has(column))
    || repairColumns.size !== expectedRepairColumns.length
    || expectedRepairColumns.some((column) => !repairColumns.has(column))) {
    throw new Error("Daemon state v13 continuation-repair shape is incomplete.");
  }
  const inbox = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as Row | undefined;
  const repairs = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_continuation_repairs'").get() as Row | undefined;
  const events = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox_events'").get() as Row | undefined;
  const inboxSql = String(inbox?.sql);
  const repairSql = String(repairs?.sql);
  const eventSql = String(events?.sql);
  if (!inbox || !repairs || !events
    || !/cancelled_by_user/i.test(inboxSql)
    || !/CHECK\s*\(\s*failure_code\s+IS\s+NULL\s+OR\s+failure_code\s*=\s*'provider_continuation_missing'\s*\)/i.test(inboxSql)
    || !/phase\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*phase\s+IN\s*\(\s*'probing'\s*,\s*'replacement_created'\s*,\s*'committed'\s*,\s*'failed'\s*\)\s*\)/i.test(repairSql)
    || !/FOREIGN KEY\s*\(\s*inbox_item_id\s*,\s*agent_id\s*,\s*room_id\s*\)\s*REFERENCES\s+supervised_agent_inbox/i.test(repairSql)
    || !/conversation_restoring/i.test(eventSql) || !/conversation_restored/i.test(eventSql) || !/user_cancelled/i.test(eventSql)
    || !/STRICT\s*$/i.test(inboxSql) || !/STRICT\s*$/i.test(repairSql) || !/STRICT\s*$/i.test(eventSql)) {
    throw new Error("Daemon state v13 continuation-repair tables are invalid.");
  }
  const indexes: Record<string, { table: string; unique: number; partial: number; columns: string[] }> = {
    one_active_provider_continuation_repair: {
      table: "provider_continuation_repairs", unique: 1, partial: 1, columns: ["agent_id"],
    },
    provider_continuation_repairs_inbox: {
      table: "provider_continuation_repairs", unique: 0, partial: 0, columns: ["inbox_item_id", "updated_at"],
    },
  };
  for (const [name, expected] of Object.entries(indexes)) {
    const listed = (database.prepare(`PRAGMA index_list(${expected.table})`).all() as Row[])
      .find((row) => row.name === name);
    const terms = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Row[])
      .filter((row) => Number(row.key) === 1)
      .sort((left, right) => Number(left.seqno) - Number(right.seqno));
    if (!listed || String(listed.origin) !== "c" || Number(listed.unique) !== expected.unique
      || Number(listed.partial) !== expected.partial || terms.length !== expected.columns.length
      || terms.some((term, index) => Number(term.cid) < 0 || term.name !== expected.columns[index]
        || Number(term.desc) !== 0 || String(term.coll).toUpperCase() !== "BINARY")) {
      throw new Error(`Daemon state v13 index ${name} is invalid.`);
    }
  }
  const activeIndex = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='one_active_provider_continuation_repair'",
  ).get() as Row | undefined;
  if (!activeIndex
    || !/WHERE\s+phase\s+NOT\s+IN\s*\(\s*'committed'\s*,\s*'failed'\s*\)/i.test(String(activeIndex.sql))) {
    throw new Error("Daemon state v13 active continuation-repair index is invalid.");
  }
  if (database.prepare("PRAGMA foreign_key_check").get()) {
    throw new Error("Daemon state v13 failed foreign-key validation.");
  }
}

repairAndValidateV13Shape(database: DatabaseSync): void {
  // Preserve every predecessor's additive repair guarantees on current
  // opens. The v7 validator recognizes the v13 inbox discriminator, so this
  // repairs only unchanged authority/configuration columns and never
  // downgrades the current delivery state machine.
  this.repairAndValidateV12Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV13Shape(database);
    this.validateV13Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
  this.finishPendingV6SecretScrub(database);
}

private applyV14Shape(database: DatabaseSync): void {
  if (!this.tableColumns(database, "runtime_deployments").has("provider_server_auth_path")) {
    database.exec("ALTER TABLE runtime_deployments ADD COLUMN provider_server_auth_path TEXT");
  }
  database.exec(`
    UPDATE runtime_deployments
    SET provider_connection_kind = NULL,
        provider_connection_url = NULL,
        provider_server_auth_path = NULL,
        provider_connection_pid = NULL,
        provider_process_identity_present = 0,
        provider_process_identity = NULL
    WHERE provider_connection_kind = 'opencode_server'
      AND (provider_connection_url IS NULL OR provider_server_auth_path IS NULL);
  `);
}

private validateV14Shape(database: DatabaseSync): void {
  this.validateV13Shape(database);
  if (!this.tableColumns(database, "runtime_deployments").has("provider_server_auth_path")) {
    throw new Error("Daemon state v14 is missing the OpenCode server authentication reference.");
  }
  if (database.prepare(`
    SELECT 1 FROM runtime_deployments
    WHERE provider_connection_kind = 'opencode_server'
      AND (provider_connection_url IS NULL OR provider_server_auth_path IS NULL)
    LIMIT 1
  `).get()) {
    throw new Error("Daemon state v14 contains incomplete OpenCode server connection evidence.");
  }
}

repairAndValidateV14Shape(database: DatabaseSync): void {
  this.repairAndValidateV13Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV14Shape(database);
    this.validateV14Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

private applyV15Shape(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_action_tombstones (
      agent_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      PRIMARY KEY(agent_id, action_id)
    ) STRICT;
    INSERT OR IGNORE INTO reconciliation_action_tombstones(agent_id, action_id)
      SELECT agent_id, action_id FROM reconciliation_completed_actions;
  `);
}

private validateV15Shape(database: DatabaseSync): void {
  this.validateV14Shape(database);
  const expected = ["agent_id", "action_id"];
  const actual = database.prepare("PRAGMA table_xinfo(reconciliation_action_tombstones)").all() as Row[];
  if (actual.length !== expected.length || expected.some((column, index) => actual[index]?.name !== column)
    || actual.some((column) => Number(column.hidden) !== 0 || String(column.type).toUpperCase() !== "TEXT" || Number(column.notnull) !== 1)
    || Number(actual[0]?.pk) !== 1 || Number(actual[1]?.pk) !== 2) {
    throw new Error("Daemon state v15 action-tombstone table has an invalid shape.");
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(reconciliation_action_tombstones)").all() as Row[];
  if (foreignKeys.length !== 0) {
    throw new Error("Daemon state v15 lifetime action tombstones must survive targeted identity replacement.");
  }
  if (!this.hasUniqueIndex(database, "reconciliation_action_tombstones", ["agent_id", "action_id"], false)) {
    throw new Error("Daemon state v15 action-tombstone identity constraint is missing.");
  }
}

repairAndValidateV15Shape(database: DatabaseSync): void {
  this.repairAndValidateV14Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV15Shape(database);
    this.validateV15Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

private applyV16Shape(database: DatabaseSync): void {
  if (!this.tableColumns(database, "turn_control_journals").has("action_sequence")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN action_sequence INTEGER");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("target_room_id")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN target_room_id TEXT");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("target_source_message_id")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN target_source_message_id TEXT");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("target_provider_continuation_id")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN target_provider_continuation_id TEXT");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervised_agent_provider_turn_bindings (
      inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      work_attempt_id TEXT NOT NULL,
      origin_execution_generation_id TEXT NOT NULL,
      provider_continuation_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      UNIQUE(agent_id, provider_continuation_id, provider_turn_id),
      FOREIGN KEY(inbox_item_id, agent_id, room_id)
        REFERENCES supervised_agent_inbox(inbox_item_id, agent_id, room_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS turn_control_sequence_watermarks (
      agent_id TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0)
    ) STRICT;
    UPDATE turn_control_journals
      SET action_sequence=1
      WHERE turn_control_present=1 AND action_id IS NOT NULL AND action_sequence IS NULL;
    INSERT INTO turn_control_sequence_watermarks(agent_id,last_sequence)
      SELECT agent_id,MAX(action_sequence) FROM turn_control_journals
      WHERE action_sequence IS NOT NULL GROUP BY agent_id
      ON CONFLICT(agent_id) DO UPDATE SET last_sequence=MAX(last_sequence,excluded.last_sequence);
    DELETE FROM reconciliation_action_tombstones;
  `);
  database.exec(`
    UPDATE turn_control_journals AS j
    SET target_room_id=(SELECT i.room_id FROM supervised_agent_inbox i WHERE i.inbox_item_id=j.inbox_item_id),
        target_source_message_id=(SELECT i.source_message_id FROM supervised_agent_inbox i WHERE i.inbox_item_id=j.inbox_item_id),
        target_provider_continuation_id=(SELECT b.provider_continuation_id FROM supervised_agent_provider_turn_bindings b WHERE b.inbox_item_id=j.inbox_item_id)
    WHERE j.turn_control_present=1 AND j.inbox_item_id IS NOT NULL
      AND (j.target_room_id IS NULL OR j.target_source_message_id IS NULL OR j.target_provider_continuation_id IS NULL)
      AND EXISTS (SELECT 1 FROM supervised_agent_provider_turn_bindings b
        WHERE b.inbox_item_id=j.inbox_item_id
          AND b.work_attempt_id=j.turn_work_attempt_id
          AND b.origin_execution_generation_id=j.turn_execution_generation_id);
    UPDATE turn_control_journals
    SET status='uncertain',
        error='This turn-control action predates exact causal target fencing and cannot be replayed automatically.'
    WHERE turn_control_present=1 AND status IN ('prepared','dispatching','retryable')
      AND (target_room_id IS NULL OR target_source_message_id IS NULL
        OR target_provider_continuation_id IS NULL OR inbox_item_id IS NULL OR provider_turn_id IS NULL);
  `);
  // Missing legacy provider-turn authority is classified by v17 after its
  // explicit terminal-reason column exists. v16 must not misrepresent an
  // upgrade retirement as a user cancellation, even transiently inside the
  // all-the-way-to-current migration transaction.
  database.exec(`
    UPDATE supervised_agent_effects AS e
    SET state='failed',
        error='Upgrade fenced a legacy effect whose exact provider-turn authority cannot be reconstructed; it will not be replayed.',
        updated_at=datetime('now')
    WHERE e.state IN ('prepared','executing') AND e.tool_name<>'join_room'
      AND NOT EXISTS (SELECT 1 FROM supervised_agent_provider_turn_bindings b
        WHERE b.agent_id=e.agent_id AND b.room_id=e.room_id
          AND b.origin_execution_generation_id=e.execution_generation_id
          AND b.provider_turn_id=e.provider_turn_id);
    UPDATE agent_room_moves
    SET phase='failed',
        error='Upgrade fenced a supervised room move before any external membership mutation because its activating turn authority cannot be reconstructed.',
        updated_at=datetime('now')
    WHERE effect_id IS NOT NULL AND activating_inbox_item_id IS NOT NULL
      AND phase IN ('prepared','waiting_for_current_turn')
      AND NOT EXISTS (SELECT 1 FROM supervised_agent_provider_turn_bindings b
        WHERE b.inbox_item_id=agent_room_moves.activating_inbox_item_id
          AND b.agent_id=agent_room_moves.agent_id
          AND b.work_attempt_id=agent_room_moves.work_attempt_id
          AND b.origin_execution_generation_id=agent_room_moves.execution_generation_id
          AND b.provider_turn_id=agent_room_moves.provider_turn_id);
    UPDATE supervised_agent_effects AS e
    SET state='failed',
        error='Upgrade fenced the legacy supervised room move before external membership mutation; it will not be replayed.',
        updated_at=datetime('now')
    WHERE e.state IN ('prepared','executing') AND e.tool_name='join_room'
      AND EXISTS (SELECT 1 FROM agent_room_moves m
        WHERE m.effect_id=e.effect_id AND m.phase='failed'
          AND m.error LIKE 'Upgrade fenced a supervised room move%');
    UPDATE supervised_agent_effects AS e
    SET state='failed',
        error='Upgrade fenced an orphaned legacy room-move effect with no durable recovery journal; it will not be replayed.',
        updated_at=datetime('now')
    WHERE e.state IN ('prepared','executing') AND e.tool_name='join_room'
      AND NOT EXISTS (SELECT 1 FROM agent_room_moves m WHERE m.effect_id=e.effect_id);
    UPDATE supervised_agent_effects AS e
    SET state='completed',
        result_json=(SELECT json_object(
          'phase','active','moved',json('true'),'old_room',m.source_room_id,
          'destination_room',COALESCE(m.remote_room_id,m.destination_room_id),
          'destination_cursor',m.destination_cursor)
          FROM agent_room_moves m WHERE m.effect_id=e.effect_id AND m.phase='active'),
        error=NULL,updated_at=datetime('now')
    WHERE e.state IN ('prepared','executing') AND e.tool_name='join_room'
      AND EXISTS (SELECT 1 FROM agent_room_moves m WHERE m.effect_id=e.effect_id AND m.phase='active');
    UPDATE supervised_agent_effects AS e
    SET state='failed',
        error=COALESCE((SELECT m.error FROM agent_room_moves m
          WHERE m.effect_id=e.effect_id AND m.phase='failed'),
          'The legacy room move failed before its effect journal was settled.'),
        updated_at=datetime('now')
    WHERE e.state IN ('prepared','executing') AND e.tool_name='join_room'
      AND EXISTS (SELECT 1 FROM agent_room_moves m WHERE m.effect_id=e.effect_id AND m.phase='failed');
  `);
  // Earlier v16 builds could commit two internally valid but mutually split
  // states. Repair only exact, non-effectful evidence before validating:
  //
  // 1. Cursor may have advanced runtime+binding from its wrapper's temporary
  //    continuation to the real session while an already-prepared control
  //    retained the temporary id. The exact inbox/turn/work/generation tuple
  //    proves this is the same turn, so the journal can advance with it.
  // 2. Retention could prune the terminal inbox row referenced by the single
  //    completed control journal. The native action is already terminal; clear
  //    its unverifiable causal tuple to an honest audit-only record rather than
  //    preventing daemon startup forever. Active controls remain fail-closed.
  database.exec(`
    UPDATE turn_control_journals AS j
    SET target_provider_continuation_id=(
          SELECT b.provider_continuation_id
          FROM supervised_agent_provider_turn_bindings b
          WHERE b.inbox_item_id=j.inbox_item_id
        ),
        updated_at=datetime('now')
    WHERE j.turn_control_present=1
      AND j.target_provider_continuation_id LIKE 'cursor-pending:%'
      AND EXISTS (
        SELECT 1
        FROM supervised_agent_inbox i
        JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=i.inbox_item_id
        JOIN agent_configurations c ON c.agent_id=j.agent_id
        JOIN runtime_deployments d ON d.agent_id=j.agent_id
        WHERE i.inbox_item_id=j.inbox_item_id
          AND i.agent_id=j.agent_id AND i.room_id=j.target_room_id
          AND i.source_message_id=j.target_source_message_id
          AND i.provider_turn_id=j.provider_turn_id
          AND b.agent_id=j.agent_id AND b.room_id=j.target_room_id
          AND b.work_attempt_id=j.turn_work_attempt_id
          AND b.origin_execution_generation_id=j.turn_execution_generation_id
          AND b.provider_turn_id=j.provider_turn_id
          AND b.provider_continuation_id NOT LIKE 'cursor-pending:%'
          AND c.provider='cursor' AND d.provider_ref_present=1
          AND d.provider_work_attempt_id=b.work_attempt_id
          AND d.provider_execution_generation_id=b.origin_execution_generation_id
          AND d.provider_continuation_id=b.provider_continuation_id
      );
    UPDATE turn_control_journals AS j
    SET target_room_id=NULL,target_source_message_id=NULL,
        target_provider_continuation_id=NULL,inbox_item_id=NULL,provider_turn_id=NULL,
        error=CASE WHEN error IS NULL OR length(trim(error))=0
          THEN 'Historical completed turn-control target is unavailable after predecessor retention; retained as audit-only.'
          ELSE error || ' Historical exact target is unavailable after predecessor retention; retained as audit-only.' END,
        updated_at=datetime('now')
    WHERE j.turn_control_present=1 AND j.status='completed'
      AND j.target_room_id IS NOT NULL
      AND j.inbox_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM supervised_agent_inbox i
        WHERE i.inbox_item_id=j.inbox_item_id
      )
      AND EXISTS (
        SELECT 1 FROM supervised_agent_pruned_sources p
        WHERE p.agent_id=j.agent_id
          AND p.room_id=j.target_room_id
          AND p.source_message_id=j.target_source_message_id
      );
  `);
}

private validateV16Shape(database: DatabaseSync): void {
  this.validateV15Shape(database);
  if (!this.tableColumns(database, "turn_control_journals").has("action_sequence")) {
    throw new Error("Daemon state v16 turn-control journal is missing its durable action sequence.");
  }
  for (const column of ["target_room_id", "target_source_message_id", "target_provider_continuation_id"]) {
    if (!this.tableColumns(database, "turn_control_journals").has(column)) {
      throw new Error(`Daemon state v16 turn-control journal is missing ${column}.`);
    }
  }
  const expected = [
    "inbox_item_id", "agent_id", "room_id", "work_attempt_id",
    "origin_execution_generation_id", "provider_continuation_id", "provider_turn_id",
  ];
  const actual = database.prepare("PRAGMA table_xinfo(supervised_agent_provider_turn_bindings)").all() as Row[];
  if (actual.length !== expected.length || expected.some((column, index) => actual[index]?.name !== column)
    || actual.some((column) => Number(column.hidden) !== 0 || String(column.type).toUpperCase() !== "TEXT" || Number(column.notnull) !== 1)
    || Number(actual[0]?.pk) !== 1) {
    throw new Error("Daemon state v16 provider-turn authority binding table has an invalid shape.");
  }
  const invalid = database.prepare(`SELECT 1
    FROM supervised_agent_provider_turn_bindings b
    LEFT JOIN supervised_agent_inbox i ON i.inbox_item_id=b.inbox_item_id
    WHERE i.inbox_item_id IS NULL OR i.agent_id<>b.agent_id OR i.room_id<>b.room_id
      OR i.provider_turn_id IS NULL OR i.provider_turn_id<>b.provider_turn_id
    LIMIT 1`).get();
  if (invalid) throw new Error("Daemon state v16 provider-turn authority binding is detached from its exact inbox turn.");
  if (!this.hasUniqueIndex(database, "supervised_agent_provider_turn_bindings", ["agent_id", "provider_continuation_id", "provider_turn_id"], false)) {
    throw new Error("Daemon state v16 provider-turn scoped identity constraint is missing.");
  }
  const watermarkColumns = database.prepare("PRAGMA table_xinfo(turn_control_sequence_watermarks)").all() as Row[];
  if (watermarkColumns.length !== 2
    || watermarkColumns[0]?.name !== "agent_id" || watermarkColumns[1]?.name !== "last_sequence"
    || String(watermarkColumns[0]?.type).toUpperCase() !== "TEXT"
    || String(watermarkColumns[1]?.type).toUpperCase() !== "INTEGER"
    || Number(watermarkColumns[0]?.pk) !== 1
    || watermarkColumns.some((column) => Number(column.notnull) !== 1 || Number(column.hidden) !== 0)) {
    throw new Error("Daemon state v16 turn-control sequence watermark has an invalid shape.");
  }
  if (database.prepare("SELECT 1 FROM reconciliation_action_tombstones LIMIT 1").get()) {
    throw new Error("Daemon state v16 retained legacy lifetime action tombstones.");
  }
  if (database.prepare(`SELECT 1 FROM turn_control_sequence_watermarks
    WHERE last_sequence<0 OR last_sequence>9007199254740991 LIMIT 1`).get()) {
    throw new Error("Daemon state v16 turn-control sequence watermark is outside the safe integer range.");
  }
  if (database.prepare(`SELECT 1 FROM turn_control_journals j
    LEFT JOIN turn_control_sequence_watermarks w ON w.agent_id=j.agent_id
    WHERE j.turn_control_present=1 AND j.action_id IS NOT NULL
      AND (j.action_sequence IS NULL OR j.action_sequence<1 OR j.action_sequence>9007199254740991
        OR w.agent_id IS NULL OR w.last_sequence<>j.action_sequence)
    LIMIT 1`).get()) {
    throw new Error("Daemon state v16 turn-control journal does not exactly match its sequence watermark.");
  }
  if (database.prepare(`SELECT 1 FROM turn_control_journals j
    LEFT JOIN supervised_agent_inbox i ON i.inbox_item_id=j.inbox_item_id
    LEFT JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=j.inbox_item_id
    WHERE j.turn_control_present=1
      AND ((j.target_room_id IS NULL)+(j.target_source_message_id IS NULL)
        +(j.target_provider_continuation_id IS NULL)) NOT IN (0,3)
      OR j.turn_control_present=1 AND j.target_room_id IS NOT NULL
      AND (j.inbox_item_id IS NULL OR j.provider_turn_id IS NULL
        OR i.inbox_item_id IS NULL OR i.agent_id<>j.agent_id OR i.room_id<>j.target_room_id
        OR i.source_message_id<>j.target_source_message_id
        OR i.provider_turn_id<>j.provider_turn_id
        OR b.inbox_item_id IS NULL OR b.agent_id<>j.agent_id
        OR b.provider_continuation_id<>j.target_provider_continuation_id
        OR b.work_attempt_id<>j.turn_work_attempt_id
        OR b.origin_execution_generation_id<>j.turn_execution_generation_id)
    LIMIT 1`).get()) {
    throw new Error("Daemon state v16 turn-control causal target is detached from its exact inbox binding.");
  }
  if (database.prepare(`SELECT 1 FROM turn_control_journals
    WHERE turn_control_present=1 AND target_room_id IS NULL
      AND status NOT IN ('uncertain','completed') LIMIT 1`).get()) {
    throw new Error("Daemon state v16 active turn-control journal is missing its exact causal target.");
  }
}

repairAndValidateV16Shape(database: DatabaseSync): void {
  this.repairAndValidateV15Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV16Shape(database);
    this.validateV16Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

private applyV17Shape(database: DatabaseSync, migrateInterruptedEffects: boolean): void {
  if (!this.tableColumns(database, "supervised_agent_inbox").has("terminal_reason")) {
    database.exec(`ALTER TABLE supervised_agent_inbox ADD COLUMN terminal_reason TEXT
      CHECK(terminal_reason IS NULL OR terminal_reason='upgrade_authority_unavailable')`);
  }

  const effectColumns = this.tableColumns(database, "supervised_agent_effects");
  if (!effectColumns.has("mutation")) {
    // SQLite cannot extend the existing state CHECK in place. Rebuild exactly
    // once while preserving the stable effect id and request-id uniqueness.
    database.exec(`
      ALTER TABLE supervised_agent_effects RENAME TO supervised_agent_effects_pre_v17;
      CREATE TABLE supervised_agent_effects (
        effect_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL,
        provider_turn_id TEXT NOT NULL,
        mcp_request_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        request_json TEXT NOT NULL,
        mutation INTEGER NOT NULL CHECK(mutation IN (0,1)),
        state TEXT NOT NULL CHECK(state IN ('prepared','executing','uncertain','completed','failed')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id,execution_generation_id,provider_turn_id,mcp_request_id)
      ) STRICT;
      INSERT INTO supervised_agent_effects
        (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
         tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      SELECT effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
        tool_name,request_json,
        CASE WHEN tool_name IN (
          'get_current_room','check_repo','check_repo_visibility',
          'read_messages','wait_for_messages','get_board','get_board_settings',
          'get_room_artifacts','get_room_events','list_board_intents',
          'get_onboarding_status','status_local_codex_session','rental_list_requests'
        ) THEN 0 ELSE 1 END,
        state,result_json,error,created_at,updated_at
      FROM supervised_agent_effects_pre_v17;
      DROP TABLE supervised_agent_effects_pre_v17;
      CREATE INDEX supervised_agent_effects_turn
        ON supervised_agent_effects(agent_id,execution_generation_id,provider_turn_id);
    `);
  }

  // Inspector diagnostics retain only a bounded set of full uncertain rows.
  // This compact journal preserves the exact dedupe identity and delayed
  // completion authority until retention removes the owning provider-turn
  // binding. It intentionally stores only a request fingerprint and byte
  // count, never the potentially large original request payload.
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervised_agent_effect_tombstones (
      effect_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      mcp_request_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      request_bytes INTEGER NOT NULL CHECK(request_bytes>=0),
      mutation INTEGER NOT NULL CHECK(mutation IN (0,1)),
      state TEXT NOT NULL CHECK(state IN ('uncertain','completed','failed')),
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id,execution_generation_id,provider_turn_id,mcp_request_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_effect_tombstones_turn
      ON supervised_agent_effect_tombstones(agent_id,execution_generation_id,provider_turn_id);
  `);

  // Correct rows written by the predecessor v16 migration, then classify any
  // v15 in-flight turn that reached this all-the-way-to-current transaction.
  // acknowledged_no_reply is only transport shape here; terminal_reason is the
  // authoritative explanation and the outcome remains null/unknown.
  database.exec(`
    UPDATE supervised_agent_inbox_events
    SET idempotency_key='v17_missing_authority_retired',phase='no_reply',
        detail='Upgrade retired an unrecoverable legacy provider turn because its exact authority is unavailable; provider work was not replayed.'
    WHERE idempotency_key='v16_missing_authority_cancelled';
    INSERT INTO supervised_agent_inbox_events
      (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
    SELECT i.inbox_item_id,
      COALESCE((SELECT MAX(e.event_sequence) FROM supervised_agent_inbox_events e
        WHERE e.inbox_item_id=i.inbox_item_id),0)+1,
      'v17_missing_authority_retired','no_reply',datetime('now'),
      'Upgrade retired an unrecoverable legacy provider turn because its exact authority is unavailable; provider work was not replayed.'
    FROM supervised_agent_inbox i
    WHERE i.provider_turn_id IS NOT NULL
      AND i.state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move','cancelled_by_user')
      AND CASE WHEN i.outcome IS NOT NULL AND json_valid(i.outcome)
        AND COALESCE(json_extract(i.outcome,'$.kind')='no_reply'
          OR (json_extract(i.outcome,'$.kind')='reply'
            AND json_type(i.outcome,'$.text')='text'
            AND length(trim(json_extract(i.outcome,'$.text')))>0),0)=1
        THEN 0 ELSE 1 END
      AND NOT EXISTS (SELECT 1 FROM supervised_agent_provider_turn_bindings b
        WHERE b.inbox_item_id=i.inbox_item_id)
      AND NOT EXISTS (SELECT 1 FROM supervised_agent_inbox_events e
        WHERE e.inbox_item_id=i.inbox_item_id AND e.idempotency_key='v17_missing_authority_retired');
    UPDATE supervised_agent_inbox AS i
    SET state='acknowledged_no_reply', failure_code=NULL,
        terminal_reason='upgrade_authority_unavailable',
        last_error='Upgrade retired this legacy provider turn because its exact durable authority is unavailable; the outcome is unknown and provider work was not replayed.',
        blocked_by_inbox_item_id=NULL, next_attempt_at_ms=NULL,
        updated_at=datetime('now'), acknowledged_at=COALESCE(acknowledged_at,datetime('now'))
    WHERE EXISTS (SELECT 1 FROM supervised_agent_inbox_events e
      WHERE e.inbox_item_id=i.inbox_item_id AND e.idempotency_key='v17_missing_authority_retired');
  `);

  if (migrateInterruptedEffects) {
    database.exec(`
      UPDATE supervised_agent_effects
      SET state='prepared',
          error='A read-only supervised effect was interrupted before its result checkpoint and may be executed again safely.',
          updated_at=datetime('now')
      WHERE state='executing' AND mutation=0 AND tool_name<>'join_room';
      UPDATE supervised_agent_effects
      SET state='uncertain',
          error='A mutating supervised effect crossed its execution boundary without a durable result; it may have completed and must not be repeated without verification.',
          updated_at=datetime('now')
      WHERE state='executing' AND mutation=1 AND tool_name<>'join_room';
    `);
  }
}

private validateV17Shape(database: DatabaseSync): void {
  this.validateV16Shape(database);
  const expectedEffects = [
    "effect_id", "agent_id", "room_id", "execution_generation_id", "provider_turn_id",
    "mcp_request_id", "tool_name", "request_json", "mutation", "state", "result_json",
    "error", "created_at", "updated_at",
  ];
  const effects = database.prepare("PRAGMA table_xinfo(supervised_agent_effects)").all() as Row[];
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_effects'").get() as Row | undefined;
  const effectsTable = (database.prepare("PRAGMA table_list").all() as Row[])
    .find((row) => row.name === "supervised_agent_effects" && row.type === "table");
  if (effects.length !== expectedEffects.length
    || expectedEffects.some((column, index) => effects[index]?.name !== column)
    || effects.some((column) => Number(column.hidden) !== 0)
    || !/mutation\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*mutation\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(String(definition?.sql))
    || !/state\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*state\s+IN\s*\([^)]*'uncertain'/i.test(String(definition?.sql))) {
    throw new Error("Daemon state v17 supervised-effect journal has an invalid durable classification shape.");
  }
  if (!effectsTable || Number(effectsTable.strict) !== 1 || Number(effectsTable.wr) !== 0
    || String(effects[0]?.type).toUpperCase() !== "TEXT"
    || Number(effects[0]?.notnull) !== 1 || Number(effects[0]?.pk) !== 1
    || effects.slice(1).some((column) => Number(column.pk) !== 0)) {
    throw new Error("Daemon state v17 supervised-effect journal effect_id must be its exact TEXT primary key.");
  }
  const exactIndexTerms = (indexName: string, expected: string[]): boolean => {
    const escaped = indexName.replace(/"/g, '""');
    const terms = (database.prepare(`PRAGMA index_xinfo("${escaped}")`).all() as Row[])
      .filter((row) => Number(row.key) === 1)
      .sort((left, right) => Number(left.seqno) - Number(right.seqno));
    return terms.length === expected.length && terms.every((term, position) =>
      Number(term.cid) >= 0 && String(term.name) === expected[position]
      && Number(term.desc) === 0 && String(term.coll).toUpperCase() === "BINARY");
  };
  const effectIndexes = database.prepare("PRAGMA index_list(supervised_agent_effects)").all() as Row[];
  const effectIdentity = ["agent_id", "execution_generation_id", "provider_turn_id", "mcp_request_id"];
  const hasExactIdentityConstraint = effectIndexes.some((index) => Number(index.unique) === 1
    && Number(index.partial) === 0 && String(index.origin) === "u"
    && exactIndexTerms(String(index.name), effectIdentity));
  if (!hasExactIdentityConstraint) {
    throw new Error("Daemon state v17 supervised-effect journal is missing its exact request identity constraint.");
  }
  const turnIndex = effectIndexes.find((index) => index.name === "supervised_agent_effects_turn");
  if (!turnIndex || Number(turnIndex.unique) !== 0 || Number(turnIndex.partial) !== 0
    || String(turnIndex.origin) !== "c"
    || !exactIndexTerms("supervised_agent_effects_turn", ["agent_id", "execution_generation_id", "provider_turn_id"])) {
    throw new Error("Daemon state v17 supervised-effect turn index is missing or malformed.");
  }
  const expectedTombstones = [
    "effect_id", "agent_id", "room_id", "execution_generation_id", "provider_turn_id",
    "mcp_request_id", "tool_name", "request_sha256", "request_bytes", "mutation", "state",
    "result_json", "error", "created_at", "updated_at",
  ];
  const tombstones = database.prepare("PRAGMA table_xinfo(supervised_agent_effect_tombstones)").all() as Row[];
  const tombstoneDefinition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_effect_tombstones'").get() as Row | undefined;
  const tombstoneTable = (database.prepare("PRAGMA table_list").all() as Row[])
    .find((row) => row.name === "supervised_agent_effect_tombstones" && row.type === "table");
  if (tombstones.length !== expectedTombstones.length
    || expectedTombstones.some((column, index) => tombstones[index]?.name !== column)
    || tombstones.some((column) => Number(column.hidden) !== 0)
    || !/request_sha256\s+TEXT\s+NOT\s+NULL\s+CHECK/i.test(String(tombstoneDefinition?.sql))
    || !/mutation\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*mutation\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(String(tombstoneDefinition?.sql))) {
    throw new Error("Daemon state v17 supervised-effect tombstone journal has an invalid compact shape.");
  }
  if (!tombstoneTable || Number(tombstoneTable.strict) !== 1 || Number(tombstoneTable.wr) !== 0
    || String(tombstones[0]?.type).toUpperCase() !== "TEXT"
    || Number(tombstones[0]?.notnull) !== 1 || Number(tombstones[0]?.pk) !== 1
    || tombstones.slice(1).some((column) => Number(column.pk) !== 0)) {
    throw new Error("Daemon state v17 supervised-effect tombstone effect_id must be its exact TEXT primary key.");
  }
  const tombstoneIndexes = database.prepare("PRAGMA index_list(supervised_agent_effect_tombstones)").all() as Row[];
  if (!tombstoneIndexes.some((index) => Number(index.unique) === 1 && Number(index.partial) === 0
      && String(index.origin) === "u" && exactIndexTerms(String(index.name), effectIdentity))) {
    throw new Error("Daemon state v17 supervised-effect tombstone identity constraint is missing.");
  }
  const tombstoneTurnIndex = tombstoneIndexes.find((index) => index.name === "supervised_agent_effect_tombstones_turn");
  if (!tombstoneTurnIndex || Number(tombstoneTurnIndex.unique) !== 0 || Number(tombstoneTurnIndex.partial) !== 0
    || String(tombstoneTurnIndex.origin) !== "c"
    || !exactIndexTerms("supervised_agent_effect_tombstones_turn", ["agent_id", "execution_generation_id", "provider_turn_id"])) {
    throw new Error("Daemon state v17 supervised-effect tombstone turn index is missing or malformed.");
  }
  const inbox = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as Row | undefined;
  if (!this.tableColumns(database, "supervised_agent_inbox").has("terminal_reason")
    || !/terminal_reason\s+TEXT\s+CHECK\s*\(\s*terminal_reason\s+IS\s+NULL\s+OR\s+terminal_reason\s*=\s*'upgrade_authority_unavailable'\s*\)/i.test(String(inbox?.sql))) {
    throw new Error("Daemon state v17 inbox is missing its honest upgrade terminal classification.");
  }
  if (database.prepare(`SELECT 1 FROM supervised_agent_effects
    WHERE mutation NOT IN (0,1) OR state NOT IN ('prepared','executing','uncertain','completed','failed') LIMIT 1`).get()) {
    throw new Error("Daemon state v17 contains an invalid supervised-effect classification.");
  }
  if (database.prepare(`SELECT 1 FROM supervised_agent_effect_tombstones
    WHERE mutation NOT IN (0,1) OR state NOT IN ('uncertain','completed','failed')
      OR length(request_sha256)<>64 OR request_sha256 GLOB '*[^0-9a-f]*' OR request_bytes<0 LIMIT 1`).get()) {
    throw new Error("Daemon state v17 contains an invalid supervised-effect tombstone.");
  }
  if (database.prepare(`SELECT 1 FROM supervised_agent_inbox
    WHERE terminal_reason IS NOT NULL
      AND (terminal_reason<>'upgrade_authority_unavailable' OR state<>'acknowledged_no_reply') LIMIT 1`).get()) {
    throw new Error("Daemon state v17 contains a mismatched upgrade terminal classification.");
  }
  if (database.prepare("SELECT 1 FROM supervised_agent_inbox_events WHERE idempotency_key='v16_missing_authority_cancelled' LIMIT 1").get()) {
    throw new Error("Daemon state v17 retained a legacy upgrade event represented as user cancellation.");
  }
}

repairAndValidateV17Shape(database: DatabaseSync): void {
  this.repairAndValidateV16Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV17Shape(database, false);
    this.validateV17Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

private applyV18Shape(database: DatabaseSync): void {
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'")
    .get() as Row | undefined;
  const sql = String(definition?.sql ?? "");
  const states = INBOX_STATE_CONSTRAINT.exec(sql)?.[1]?.replace(/\s/g, "");
  if (states !== `${INBOX_STATES_V17},'acknowledged_failed'`) {
    if (states !== INBOX_STATES_V17) throw new Error("Daemon state v18 cannot upgrade an unknown inbox state constraint.");
    // Every direct dependent must be saved before dropping the parent: SQLite
    // rewrites foreign keys on RENAME, and DROP can cascade native-turn and
    // publication authority away even with deferred constraint checking.
    const children = [
      "supervised_agent_inbox_events", "supervised_agent_terminal_results",
      "supervised_agent_publications", "provider_continuation_repairs",
      "supervised_agent_provider_turn_bindings",
    ];
    const tables = ["supervised_agent_inbox", ...children];
    for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]) {
      const table = String(row.name);
      const referencesInbox = (database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as Row[])
        .some((key) => key.table === "supervised_agent_inbox");
      if (referencesInbox && !tables.includes(table)) {
        throw new Error("Daemon state v18 found an unrecognized inbox dependency and cannot safely rebuild it.");
      }
    }
    const definitions = tables.map((table) => {
      const tableDefinition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
      if (!tableDefinition?.sql) throw new Error("Daemon state v18 is missing an authoritative inbox dependency.");
      const objects = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")
        .all(table) as Row[];
      return { table, sql: String(tableDefinition.sql), objects: objects.map((object) => String(object.sql)) };
    });
    database.exec("PRAGMA defer_foreign_keys = ON");
    for (const table of tables) {
      database.exec(`CREATE TEMP TABLE ${quoteIdentifier(`v18_snapshot_${table}`)} AS SELECT * FROM ${quoteIdentifier(table)}`);
    }
    for (const table of children) database.exec(`DROP TABLE ${quoteIdentifier(table)}`);
    database.exec("DROP TABLE supervised_agent_inbox");
    for (const saved of definitions) {
      database.exec(saved.table === "supervised_agent_inbox"
        ? saved.sql.replace(INBOX_STATE_CONSTRAINT, `state TEXT NOT NULL CHECK(state IN (${INBOX_STATES_V17},'acknowledged_failed'))`)
        : saved.sql);
    }
    for (const saved of definitions) {
      database.exec(`INSERT INTO ${quoteIdentifier(saved.table)} SELECT * FROM temp.${quoteIdentifier(`v18_snapshot_${saved.table}`)}`);
      database.exec(`DROP TABLE temp.${quoteIdentifier(`v18_snapshot_${saved.table}`)}`);
      for (const object of saved.objects) database.exec(object);
    }
  }
  applyExecutionStorageSchema(database);
}

private validateV18Shape(database: DatabaseSync, executionStorageVersion: 18 | 19 = 19): void {
  this.validateV17Shape(database);
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as Row | undefined;
  if (INBOX_STATE_CONSTRAINT.exec(String(definition?.sql))?.[1]?.replace(/\s/g, "") !== `${INBOX_STATES_V17},'acknowledged_failed'`) {
    throw new Error("Daemon state v18 inbox is missing its reserved failed-delivery terminal state.");
  }
  validateExecutionStorageSchema(database, executionStorageVersion);
  const expectedKeys: Record<string, string[]> = {
    supervised_agent_inbox: ["blocked_by_inbox_item_id:inbox_item_id:NO ACTION"],
    supervised_agent_inbox_events: ["inbox_item_id:inbox_item_id:CASCADE"],
    supervised_agent_terminal_results: ["inbox_item_id:inbox_item_id:CASCADE"],
    supervised_agent_publications: ["inbox_item_id:inbox_item_id:CASCADE|agent_id:agent_id:CASCADE|room_id:room_id:CASCADE"],
    provider_continuation_repairs: ["inbox_item_id:inbox_item_id:CASCADE|agent_id:agent_id:CASCADE|room_id:room_id:CASCADE"],
    supervised_agent_provider_turn_bindings: ["inbox_item_id:inbox_item_id:CASCADE", "inbox_item_id:inbox_item_id:CASCADE|agent_id:agent_id:CASCADE|room_id:room_id:CASCADE"],
  };
  for (const [table, expected] of Object.entries(expectedKeys)) {
    const groups = new Map<number, Row[]>();
    for (const key of database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as Row[]) {
      if (key.table !== "supervised_agent_inbox" || key.on_update !== "NO ACTION") {
        throw new Error(`Daemon state v18 table ${table} has an invalid inbox authority foreign key.`);
      }
      const group = groups.get(Number(key.id)) ?? [];
      group.push(key); groups.set(Number(key.id), group);
    }
    const actual = [...groups.values()].map((group) => group.sort((a, b) => Number(a.seq) - Number(b.seq))
      .map((key) => `${key.from}:${key.to}:${key.on_delete}`).join("|")).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      throw new Error(`Daemon state v18 table ${table} has an invalid inbox authority foreign key.`);
    }
  }
  if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("Daemon state v18 failed foreign-key validation.");
}

repairAndValidateV20Shape(database: DatabaseSync): void {
  if (!this.tableColumns(database, "supervised_agent_inbox_events").size
    && database.prepare("SELECT 1 FROM supervised_agent_inbox LIMIT 1").get()) {
    throw new Error("Daemon state is missing inbox retry history and cannot safely reconstruct consumed retry budgets.");
  }
  // Missing typed journals are lost authority, not permission to recreate an
  // empty history. Check them before any predecessor's additive repair path.
  validateExecutionStorageSchema(database);
  validateTerminalResults(database, 20);
  this.repairAndValidateV17Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    validateTerminalResults(database, 20);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

/** Preserve later authority when repairing an older physical inbox shape. */
private detachLaterInboxTables(database: DatabaseSync, names: string[]): () => void {
  const saved = names.flatMap((table) => {
    const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
    if (!definition) return [];
    const objects = (database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")
      .all(table) as Row[]).map((row) => String(row.sql));
    database.exec(`CREATE TEMP TABLE ${quoteIdentifier(`inbox_repair_${table}`)} AS SELECT * FROM ${quoteIdentifier(table)}`);
    database.exec(`DROP TABLE ${quoteIdentifier(table)}`);
    return [{ table, sql: String(definition.sql), objects }];
  });
  return () => {
    for (const item of saved) {
      database.exec(item.sql);
      database.exec(`INSERT INTO ${quoteIdentifier(item.table)} SELECT * FROM temp.${quoteIdentifier(`inbox_repair_${item.table}`)}`);
      database.exec(`DROP TABLE temp.${quoteIdentifier(`inbox_repair_${item.table}`)}`);
      for (const object of item.objects) database.exec(object);
    }
  };
}

private applyV8Shape(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervised_agent_publications (
      inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      canonical_message_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      UNIQUE(room_id,client_message_id),
      UNIQUE(room_id,canonical_message_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_publications_agent_room
      ON supervised_agent_publications(agent_id,room_id);
    CREATE TABLE IF NOT EXISTS supervised_agent_history_boundaries (
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      earliest_retained_observed_message_id TEXT,
      earliest_retained_inbox_message_id TEXT,
      earliest_retained_receipt_sequence INTEGER,
      pruned_before_message_id TEXT,
      pruned_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_id,room_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_history_boundaries_updated
      ON supervised_agent_history_boundaries(agent_id,updated_at);
    CREATE TABLE IF NOT EXISTS supervised_agent_pruned_sources (
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      pruned_at TEXT NOT NULL,
      PRIMARY KEY(agent_id,room_id,source_message_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS supervised_agent_pruned_sources_retention
      ON supervised_agent_pruned_sources(agent_id,pruned_at,source_message_id);
  `);
}

private validateV8Shape(database: DatabaseSync): void {
  const canonical: Record<string, string> = {
    supervised_agent_publications: `CREATE TABLE supervised_agent_publications (inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,agent_id TEXT NOT NULL,room_id TEXT NOT NULL,client_message_id TEXT NOT NULL,canonical_message_id TEXT NOT NULL,published_at TEXT NOT NULL,UNIQUE(room_id,client_message_id),UNIQUE(room_id,canonical_message_id)) STRICT`,
    supervised_agent_history_boundaries: `CREATE TABLE supervised_agent_history_boundaries (agent_id TEXT NOT NULL,room_id TEXT NOT NULL,earliest_retained_observed_message_id TEXT,earliest_retained_inbox_message_id TEXT,earliest_retained_receipt_sequence INTEGER,pruned_before_message_id TEXT,pruned_at TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(agent_id,room_id)) STRICT`,
    supervised_agent_pruned_sources: `CREATE TABLE supervised_agent_pruned_sources (agent_id TEXT NOT NULL,room_id TEXT NOT NULL,source_message_id TEXT NOT NULL,pruned_at TEXT NOT NULL,PRIMARY KEY(agent_id,room_id,source_message_id)) STRICT`,
  };
  const normalizeSql = (value: string) => value.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replaceAll('"', "").replaceAll("`", "").replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").replace(/\s*([(),=<>])\s*/g, "$1").replace(/\)\s*strict$/i, ")strict").trim().toLowerCase();
  for (const [table, expected] of Object.entries(canonical)) {
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
    if (!actual || normalizeSql(String(actual.sql)) !== normalizeSql(expected)) throw new Error(`Daemon state v8 table ${table} does not match its canonical definition.`);
    const info = (database.prepare("PRAGMA table_list").all() as Row[]).find((row) => row.name === table && row.type === "table");
    if (!info || Number(info.strict) !== 1 || Number(info.wr) !== 0) throw new Error(`Daemon state v8 table ${table} has an invalid strict schema.`);
  }
  const indexes: Record<string, { table: string; unique: number; columns: string[] }> = {
    supervised_agent_publications_agent_room: { table: "supervised_agent_publications", unique: 0, columns: ["agent_id", "room_id"] },
    supervised_agent_history_boundaries_updated: { table: "supervised_agent_history_boundaries", unique: 0, columns: ["agent_id", "updated_at"] },
    supervised_agent_pruned_sources_retention: { table: "supervised_agent_pruned_sources", unique: 0, columns: ["agent_id", "pruned_at", "source_message_id"] },
  };
  for (const [name, expected] of Object.entries(indexes)) {
    const listed = (database.prepare(`PRAGMA index_list(${expected.table})`).all() as Row[]).find((row) => row.name === name);
    const terms = (database.prepare(`PRAGMA index_xinfo(${name})`).all() as Row[]).filter((row) => Number(row.key) === 1).sort((a, b) => Number(a.seqno) - Number(b.seqno));
    if (!listed || Number(listed.unique) !== expected.unique || Number(listed.partial) !== 0 || String(listed.origin) !== "c" || terms.length !== expected.columns.length || terms.some((term, index) => Number(term.cid) < 0 || term.name !== expected.columns[index] || Number(term.desc) !== 0 || String(term.coll).toUpperCase() !== "BINARY")) throw new Error(`Daemon state v8 index ${name} is invalid.`);
  }
}

repairAndValidateV8Shape(database: DatabaseSync): void {
  const needsRepair = !this.tableColumns(database, "supervised_agent_publications").size || !this.tableColumns(database, "supervised_agent_history_boundaries").size || !this.tableColumns(database, "supervised_agent_pruned_sources").size;
  // Preserve v7's security scrub and shape-repair guards before accepting v8.
  if (!needsRepair) { this.repairAndValidateV7Shape(database); this.validateV8Shape(database); return; }
  database.exec("BEGIN IMMEDIATE");
  try { this.validateV7Shape(database); this.applyV8Shape(database); this.validateV8Shape(database); database.exec("COMMIT"); }
  catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
}

/**
 * V9 deliberately rebuilds the small, bounded delivery-history tables. The
 * old uniqueness key omitted room_id, which made a reused room message id
 * collide across room moves for the same durable agent.
 */
private applyV9Shape(database: DatabaseSync): void {
  const terminalVersion = validateTerminalResults(database);
  const restoreLaterAuthority = this.detachLaterInboxTables(database, ["provider_continuation_repairs", "supervised_agent_provider_turn_bindings"]);
  database.exec(`
    PRAGMA defer_foreign_keys = ON;
    ALTER TABLE supervised_agent_inbox RENAME TO supervised_agent_inbox_v8;
    ALTER TABLE supervised_agent_observed_messages RENAME TO supervised_agent_observed_messages_v8;

    CREATE TABLE supervised_agent_inbox (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      source_message_json TEXT NOT NULL, activation_json TEXT NOT NULL,
      fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence > 0),
      state TEXT NOT NULL CHECK (state IN ('pending','dispatching','awaiting_result','result_recovery','publishing','retryable','blocked','acknowledged','acknowledged_no_reply','cancelled_by_room_move')),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      action_id TEXT NOT NULL, reply_client_message_id TEXT NOT NULL,
      provider_turn_id TEXT, outcome TEXT, last_error TEXT,
      blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),
      next_attempt_at_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged_at TEXT,
      UNIQUE(agent_id,room_id,source_message_id), UNIQUE(agent_id,fifo_sequence),
      UNIQUE(inbox_item_id,agent_id,room_id)
    ) STRICT;
    INSERT INTO supervised_agent_inbox
      (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
      SELECT inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at
      FROM supervised_agent_inbox_v8;

    CREATE TABLE supervised_agent_inbox_events_v9 (
      inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
      idempotency_key TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled')),
      observed_at TEXT NOT NULL, detail TEXT,
      PRIMARY KEY(inbox_item_id,event_sequence), UNIQUE(inbox_item_id,idempotency_key)
    ) STRICT;
    INSERT INTO supervised_agent_inbox_events_v9 SELECT * FROM supervised_agent_inbox_events;

    ${terminalResultsSql(terminalVersion, "supervised_agent_terminal_results_v9")};
    INSERT INTO supervised_agent_terminal_results_v9 SELECT * FROM supervised_agent_terminal_results;

    CREATE TABLE supervised_agent_publications_v9 (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL, canonical_message_id TEXT NOT NULL, published_at TEXT NOT NULL,
      FOREIGN KEY(inbox_item_id,agent_id,room_id)
        REFERENCES supervised_agent_inbox(inbox_item_id,agent_id,room_id) ON DELETE CASCADE,
      UNIQUE(room_id,client_message_id), UNIQUE(room_id,canonical_message_id)
    ) STRICT;
    INSERT INTO supervised_agent_publications_v9 SELECT * FROM supervised_agent_publications;

    DROP TABLE supervised_agent_inbox_events;
    DROP TABLE supervised_agent_terminal_results;
    DROP TABLE supervised_agent_publications;

    DROP TABLE supervised_agent_inbox_v8;

    CREATE TABLE supervised_agent_observed_messages (
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      source_message_json TEXT NOT NULL, activation_json TEXT NOT NULL,
      activation_decision TEXT NOT NULL, observed_at TEXT NOT NULL,
      PRIMARY KEY(agent_id,room_id,source_message_id)
    ) STRICT;
    INSERT INTO supervised_agent_observed_messages SELECT * FROM supervised_agent_observed_messages_v8;
    DROP TABLE supervised_agent_observed_messages_v8;

    ALTER TABLE supervised_agent_inbox_events_v9 RENAME TO supervised_agent_inbox_events;
    ALTER TABLE supervised_agent_terminal_results_v9 RENAME TO supervised_agent_terminal_results;
    ALTER TABLE supervised_agent_publications_v9 RENAME TO supervised_agent_publications;
    CREATE INDEX supervised_agent_inbox_head ON supervised_agent_inbox(agent_id,fifo_sequence);
    CREATE INDEX supervised_agent_inbox_events_timeline ON supervised_agent_inbox_events(inbox_item_id,event_sequence);
    CREATE UNIQUE INDEX supervised_agent_terminal_result_turn ON supervised_agent_terminal_results(agent_id,execution_generation_id,provider_turn_id);
    CREATE INDEX supervised_agent_observed_context ON supervised_agent_observed_messages(agent_id,room_id,source_message_id);
    CREATE INDEX supervised_agent_publications_agent_room ON supervised_agent_publications(agent_id,room_id);

    ALTER TABLE supervised_agent_history_boundaries RENAME TO supervised_agent_history_boundaries_v8;
    CREATE TABLE supervised_agent_history_boundaries (
      agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
      earliest_retained_observed_message_id TEXT, earliest_retained_inbox_message_id TEXT,
      earliest_retained_receipt_sequence INTEGER,
      pruned_before_message_id TEXT, pruned_at TEXT,
      updated_at TEXT NOT NULL,
      CHECK ((pruned_before_message_id IS NULL) = (pruned_at IS NULL)),
      PRIMARY KEY(agent_id,room_id)
    ) STRICT;
    INSERT INTO supervised_agent_history_boundaries
      SELECT agent_id,room_id,earliest_retained_observed_message_id,earliest_retained_inbox_message_id,earliest_retained_receipt_sequence,
        CASE WHEN pruned_before_message_id IS NULL OR pruned_at IS NULL THEN NULL ELSE pruned_before_message_id END,
        CASE WHEN pruned_before_message_id IS NULL OR pruned_at IS NULL THEN NULL ELSE pruned_at END,
        updated_at
      FROM supervised_agent_history_boundaries_v8;
    DROP TABLE supervised_agent_history_boundaries_v8;
    CREATE INDEX supervised_agent_history_boundaries_updated ON supervised_agent_history_boundaries(agent_id,updated_at);
  `);
  restoreLaterAuthority();
}

private validateV9Shape(database: DatabaseSync): void {
  const inbox = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'").get() as Row | undefined;
  const observed = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_observed_messages'").get() as Row | undefined;
  const publications = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_publications'").get() as Row | undefined;
  const boundaries = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_history_boundaries'").get() as Row | undefined;
  for (const [name, row] of Object.entries({ inbox, observed, publications, boundaries })) {
    if (!row || !/STRICT\s*$/i.test(String(row.sql))) throw new Error(`Daemon state v9 table ${name} is invalid.`);
  }
  const inboxSql = String(inbox?.sql);
  const observedSql = String(observed?.sql);
  const publicationsSql = String(publications?.sql);
  const boundariesSql = String(boundaries?.sql);
  if (!/UNIQUE\s*\(\s*agent_id\s*,\s*room_id\s*,\s*source_message_id\s*\)/i.test(inboxSql)
    || !/PRIMARY KEY\s*\(\s*agent_id\s*,\s*room_id\s*,\s*source_message_id\s*\)/i.test(observedSql)
    || !/FOREIGN KEY\s*\(\s*inbox_item_id\s*,\s*agent_id\s*,\s*room_id\s*\)/i.test(publicationsSql)
    || !/CHECK\s*\(\s*\(\s*pruned_before_message_id\s+IS\s+NULL\s*\)\s*=\s*\(\s*pruned_at\s+IS\s+NULL\s*\)\s*\)/i.test(boundariesSql)) {
    throw new Error("Daemon state v9 delivery-history constraints are invalid.");
  }
  if (database.prepare("SELECT 1 FROM supervised_agent_inbox GROUP BY agent_id,room_id,source_message_id HAVING COUNT(*) > 1 LIMIT 1").get()) {
    throw new Error("Daemon state v9 inbox room-scoped uniqueness is invalid.");
  }
  const publicationIndex = database.prepare("PRAGMA index_info('supervised_agent_publications_agent_room')").all() as Row[];
  if (publicationIndex.map((row) => String(row.name)).join(",") !== "agent_id,room_id") {
    throw new Error("Daemon state v9 publication index is invalid.");
  }
  if (database.prepare("SELECT 1 FROM supervised_agent_history_boundaries WHERE (pruned_before_message_id IS NULL) <> (pruned_at IS NULL) LIMIT 1").get()) {
    throw new Error("Daemon state v9 history boundary pruning fields are invalid.");
  }
  if (database.prepare(`SELECT 1 FROM supervised_agent_publications p LEFT JOIN supervised_agent_inbox i
    ON i.inbox_item_id=p.inbox_item_id AND i.agent_id=p.agent_id AND i.room_id=p.room_id
    WHERE i.inbox_item_id IS NULL LIMIT 1`).get()) {
    throw new Error("Daemon state v9 publication parent identity is invalid.");
  }
  if ((database.prepare("PRAGMA foreign_key_check").all() as Row[]).length) {
    throw new Error("Daemon state v9 foreign key integrity check failed.");
  }
}

private hasV9DeliveryHistoryShape(database: DatabaseSync): boolean {
  const publication = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_publications'").get() as Row | undefined;
  return Boolean(publication && /FOREIGN KEY\s*\(\s*inbox_item_id\s*,\s*agent_id\s*,\s*room_id\s*\)/i.test(String(publication.sql)));
}

/**
 * All legacy markers must reach this exact physical delivery shape before
 * either version marker advances. Older schemas have no inbox tables at all,
 * while interrupted upgrades can already have v6-v8 tables, so this path is
 * intentionally additive until the final v9 rebuild.
 */
private advanceDeliveryToCurrent(database: DatabaseSync): void {
  if (this.hasV9DeliveryHistoryShape(database)) {
    this.validateV9Shape(database);
    return;
  }
  this.applyBoundedDeliveryV6Shape(database);
  this.validateBoundedDeliveryV6Shape(database);
  this.applyV7Shape(database);
  this.validateV7Shape(database);
  this.applyV8Shape(database);
  this.validateV8Shape(database);
  this.applyV9Shape(database);
  this.validateV9Shape(database);
}

repairAndValidateV9Shape(database: DatabaseSync): void {
  this.repairAndValidateV7Shape(database);
  this.validateV9Shape(database);
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
    if (this.hasV9DeliveryHistoryShape(database)) {
      this.validateV9Shape(database);
      return requiresScrub;
    }
    this.applyV8Shape(database);
    this.validateV8Shape(database);
    return requiresScrub;
  }
  this.applyV6Shape(database);
  this.validateV6Shape(database);
  this.applyBoundedDeliveryV6Shape(database);
  this.validateBoundedDeliveryV6Shape(database);
  this.applyV7Shape(database);
  this.validateV7Shape(database);
  this.applyV8Shape(database);
  this.validateV8Shape(database);
  return requiresScrub;
}

repairAndValidateV7Shape(database: DatabaseSync): void {
  if (this.tableColumns(database, "worker_session_bindings").has("agent_session_token")) {
    throw new Error("Daemon state v7 must not persist agent_session_token.");
  }
  const hasV13DeliveryShape = this.tableColumns(database, "supervised_agent_inbox").has("failure_code");
  const needsLegacyPresenceRepair = this.tableColumns(database, "reconciliation_records").has("exit_timestamps_json")
    && Boolean(database.prepare("SELECT 1 FROM reconciliation_records WHERE exit_timestamps_json IS NOT NULL LIMIT 1").get());
  const needsV2AdditiveRepair = !this.tableColumns(database, "agent_configurations").has("provider_launch_policy_undefined")
    || !this.tableColumns(database, "runtime_deployments").has("provider_process_identity_present");
  const needsBoundedDeliveryRepair = !this.tableColumns(database, "agent_configurations").has("delivery_mode")
    || !this.tableColumns(database, "agent_configurations").has("delivery_cutover_json")
    || !this.tableColumns(database, "turn_control_journals").has("provider_turn_id")
    || !this.tableColumns(database, "turn_control_journals").has("inbox_item_id")
    || !this.tableColumns(database, "turn_control_journals").has("correction_text")
    || !this.tableColumns(database, "turn_control_journals").has("correction_strategy")
    || !this.tableColumns(database, "turn_control_journals").has("operator_resolution");
  const needsV7AdditiveRepair = !this.tableColumns(database, "supervised_agent_terminal_results").size
    || (!hasV13DeliveryShape && !this.tableColumns(database, "supervised_agent_inbox_events").size);
  const deferMissingV13Events = hasV13DeliveryShape
    && !this.tableColumns(database, "supervised_agent_inbox_events").size;
  if (hasV13DeliveryShape && !this.tableColumns(database, "supervised_agent_terminal_results").size) {
    throw new Error("Daemon state v13 is missing terminal-result evidence and cannot safely reconstruct it.");
  }
  if (!needsLegacyPresenceRepair && !needsV2AdditiveRepair && !needsBoundedDeliveryRepair && !needsV7AdditiveRepair) {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    this.validateV6Shape(database, false);
    this.validateBoundedDeliveryV6Shape(database);
    this.validateV7Shape(database, !deferMissingV13Events);
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
    this.validateV7Shape(database, !deferMissingV13Events);
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
    || !this.tableColumns(database, "turn_control_journals").has("provider_turn_id")
    || !this.tableColumns(database, "turn_control_journals").has("inbox_item_id")
    || !this.tableColumns(database, "turn_control_journals").has("correction_text")
    || !this.tableColumns(database, "turn_control_journals").has("correction_strategy")
    || !this.tableColumns(database, "turn_control_journals").has("operator_resolution");
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
  if (!this.tableColumns(database, "turn_control_journals").has("inbox_item_id")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN inbox_item_id TEXT");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("correction_text")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN correction_text TEXT");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("correction_strategy")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN correction_strategy TEXT CHECK (correction_strategy IS NULL OR correction_strategy IN ('native','stop_then_resend'))");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("operator_resolution")) {
    database.exec("ALTER TABLE turn_control_journals ADD COLUMN operator_resolution TEXT CHECK (operator_resolution IS NULL OR operator_resolution IN ('applied','not_applied'))");
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
  if (!this.tableColumns(database, "turn_control_journals").has("inbox_item_id")) {
    throw new Error("Daemon state v6 inbox_item_id is missing.");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("correction_text")) {
    throw new Error("Daemon state v6 correction_text is missing.");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("correction_strategy")) {
    throw new Error("Daemon state v6 correction_strategy is missing.");
  }
  if (!this.tableColumns(database, "turn_control_journals").has("operator_resolution")) {
    throw new Error("Daemon state v6 operator_resolution is missing.");
  }
  const invalidCorrectionStrategy = database.prepare("SELECT 1 FROM turn_control_journals WHERE correction_strategy IS NOT NULL AND correction_strategy NOT IN ('native','stop_then_resend') LIMIT 1").get();
  if (invalidCorrectionStrategy) throw new Error("Daemon state v6 correction_strategy is invalid.");
  const invalidOperatorResolution = database.prepare("SELECT 1 FROM turn_control_journals WHERE operator_resolution IS NOT NULL AND operator_resolution NOT IN ('applied','not_applied') LIMIT 1").get();
  if (invalidOperatorResolution) throw new Error("Daemon state v6 operator_resolution is invalid.");
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

validateV7Shape(database: DatabaseSync, includeInboxEvents = true): void {
  // The inbox discriminator is sufficient during current-version repair:
  // the additive repair journal may be absent while the authoritative inbox
  // has already reached v13.
  const hasV13DeliveryShape = this.tableColumns(database, "supervised_agent_inbox").has("failure_code");
  const hasV17TerminalReason = this.tableColumns(database, "supervised_agent_inbox").has("terminal_reason");
  const hasV17EffectShape = this.tableColumns(database, "supervised_agent_effects").has("mutation");
  const required: Record<string, string[]> = {
    supervised_agent_inbox: ["inbox_item_id", "agent_id", "room_id", "source_message_id", "source_message_json", "activation_json", "fifo_sequence", "state", "attempt_count", "action_id", "reply_client_message_id", "provider_turn_id", "outcome", "last_error", ...(hasV13DeliveryShape ? ["failure_code"] : []), "blocked_by_inbox_item_id", "next_attempt_at_ms", "created_at", "updated_at", "acknowledged_at", ...(hasV17TerminalReason ? ["terminal_reason"] : [])],
    supervised_agent_inbox_events: ["inbox_item_id", "event_sequence", "idempotency_key", "phase", "observed_at", "detail"],
    supervised_agent_terminal_results: ["inbox_item_id", "agent_id", "execution_generation_id", "provider_turn_id", "outcome", "normalized_text", "evidence_source", "terminal_evidence_json", "observed_at", "updated_at"],
    supervised_agent_observed_messages: ["agent_id", "room_id", "source_message_id", "source_message_json", "activation_json", "activation_decision", "observed_at"],
    supervised_agent_effects: ["effect_id", "agent_id", "room_id", "execution_generation_id", "provider_turn_id", "mcp_request_id", "tool_name", "request_json", ...(hasV17EffectShape ? ["mutation"] : []), "state", "result_json", "error", "created_at", "updated_at"],
    supervised_agent_ingress_health: ["agent_id", "room_id", "execution_generation_id", "state", "detail", "observed_at", "updated_at"],
  };
  if (!includeInboxEvents) delete required.supervised_agent_inbox_events;
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
      AND (provider_connection_kind NOT IN ('codex_app_server', 'claude_cli', 'cursor_cli', 'opencode_server')
        OR (provider_connection_kind IN ('codex_app_server', 'opencode_server') AND provider_connection_url IS NULL));
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
        inbox_item_id = NULL, provider_turn_id = NULL, has_correction = NULL,
        correction_text = NULL, correction_strategy = NULL, operator_resolution = NULL,
        status = NULL, capability = NULL, interrupted = NULL,
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
  if (this.tableColumns(database, "runtime_deployments").has("provider_server_auth_path")) {
    database.exec(`
      UPDATE runtime_deployments SET provider_server_auth_path = NULL
      WHERE provider_ref_present = 0 OR provider_connection_kind <> 'opencode_server';
    `);
  }
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
      // A newer daemon owns this schema. Reject before journal-mode conversion,
      // checkpointing, or initialization can persist changes to its database.
      assertDaemonStateVersionSupported(database);
      const mode = String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: unknown }).journal_mode);
      if (mode.toLowerCase() !== "wal") database.exec("PRAGMA journal_mode = WAL");
      const confirmed = String((database.prepare("PRAGMA journal_mode").get() as { journal_mode: unknown }).journal_mode);
      if (confirmed.toLowerCase() !== "wal") throw new Error(`Daemon state requires WAL journal mode, received ${confirmed}.`);
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA synchronous = FULL");
      // Migration row snapshots must not spill a second plaintext copy to disk.
      database.exec("PRAGMA temp_store = MEMORY");
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
