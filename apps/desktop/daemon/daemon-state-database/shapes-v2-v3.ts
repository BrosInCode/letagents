/**
 * Manifest shapes (v2, v3), legacy presence normalization and column helpers.
 *
 * Where new code goes: a new schema version's migration goes in
 * storage-migrations.ts (with its dispatch in schema.ts createSchema and the
 * DAEMON_STATE_SCHEMA_VERSION bump in shared.ts); a change
 * to the current shape goes in shapes-v17-current.ts. The other shapes-*.ts
 * files hold frozen historical versions and change only to fix a repair bug.
 * shapes-v4-v7.ts owns the plain apply/validate shapes for v4 to v7;
 * shapes-v6-v9.ts owns v8 and v9 plus the v6/v7 repair paths
 * (repairAndValidateV6Shape/V7Shape, bounded delivery, secret scrub) that
 * call into those v6/v7 shapes, so the two names overlap at v6 and v7.
 */
import type { DatabaseSync } from "node:sqlite";
import { type Row, parseJson, run, schemaMethods } from "./shared.js";

export const shapesV2V3 = schemaMethods({
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
},

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
},

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
},

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
},

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
},

tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((column) => String(column.name)));
},

validateV2Shape(database: DatabaseSync): void {
  const required: Record<string, string[]> = {
    manifest_metadata: ["singleton", "generation", "schema_version"], migration_records: ["migration_key", "checksum", "imported_at"], migration_failures: ["migration_key", "reason", "failed_at", "quarantined_path"],
    agent_identities: ["agent_id", "created_by", "created_at", "sort_order"], agent_profiles: ["agent_id", "display_name"], agent_room_memberships: ["agent_id", "room_id"],
    agent_configurations: ["agent_id", "provider", "model", "charter", "permission_profile_id", "provider_launch_policy_present", "provider_launch_policy_json", "provider_launch_policy_undefined"], agent_launch_intents: ["agent_id", "desired_state", "source_repo_path_present", "source_repo_path"],
    runtime_deployments: ["agent_id", "deployment_id", "run_id", "observed_state", "workspace_path_present", "workspace_path", "work_attempt_id_present", "work_attempt_id", "provider_ref_present", "provider_work_attempt_id", "provider_continuation_id", "provider_connection_kind", "provider_connection_url", "provider_connection_pid", "provider_process_identity", "provider_process_identity_present", "provider_execution_generation_id", "workplace_liveness_present", "workplace_liveness_state", "workplace_liveness_observed_at", "workplace_liveness_detail", "native_liveness_present", "native_liveness_state", "native_liveness_observed_at", "native_liveness_detail", "activity_present"],
    activity_events: ["agent_id", "sort_order", "observed_at", "sequence", "provider", "kind", "method", "summary", "status", "payload_json", "payload_truncated", "payload_redacted", "durable_payload_ref"], agent_lifecycle_states: ["agent_id", "condition", "last_error_present", "last_error"], agent_readiness: ["agent_id", "ready_reached_at_present", "ready_reached_at"],
    turn_control_journals: ["agent_id", "turn_control_present", "action_id", "turn_work_attempt_id", "turn_execution_generation_id", "has_correction", "status", "capability", "interrupted", "resumed", "turn_state", "error", "recorded_at", "updated_at"], turn_control_stages: ["agent_id", "sort_order", "stage"], retained_worker_bindings: ["agent_id", "last_worker_binding_present", "binding_agent_session_id", "binding_work_attempt_id", "binding_execution_generation_id", "binding_updated_at"],
    reconciliation_records: ["agent_id", "reconciliation_present", "consecutive_action_failures", "last_observed_state", "next_restart_at_ms", "last_action_sequence", "pending_action_id", "pending_action_sequence", "pending_action_kind", "pending_action_recorded_at_ms", "last_terminal_present", "terminal_ended_at", "terminal_exit_code", "terminal_signal", "terminal_stdio_archive_ref", "terminal_stdio_tail", "terminal_cause", "terminal_actor", "terminal_generation", "terminal_provider_continuation_id", "reconciliation_notices_present"], reconciliation_exit_timestamps: ["agent_id", "sort_order", "timestamp_ms"], reconciliation_completed_actions: ["agent_id", "sort_order", "action_id"], reconciliation_notices: ["agent_id", "sort_order", "at", "kind", "cause", "terminal_present", "terminal_ended_at", "terminal_exit_code", "terminal_signal", "terminal_stdio_archive_ref", "terminal_stdio_tail", "terminal_cause", "terminal_actor", "terminal_generation", "terminal_provider_continuation_id"],
  };
  for (const [table, expected] of Object.entries(required)) {
    const actual = this.tableColumns(database, table);
    const missing = expected.filter((column) => !actual.has(column));
    if (missing.length) throw new Error(`Daemon state v2 table ${table} is missing required columns: ${missing.join(", ")}.`);
  }
},
});
