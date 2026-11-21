/**
 * Clean-slate daemon schema v1, plain numbered migration runner, and exact
 * in-memory reference shape comparison.
 *
 * All future schema changes add a numbered migration in DAEMON_STATE_MIGRATIONS
 * (keyed by source version: e.g. `1: migrateV1ToV2`), update applySchemaCurrent
 * to match the new target shape, and bump DAEMON_STATE_SCHEMA_VERSION.
 */
import { DatabaseSync } from "node:sqlite";
import { applyEffectJournalSchema } from "../effect-journal/schema.js";
import { applyApprovalRequestClosureSchema } from "../execution-approval-journal.js";
import { applyExecutionApprovalPublicationSchema } from "../execution-approval-publication-store.js";
import { applyExecutionStorageSchema } from "../execution-storage-schema.js";
import { applyHostToolRuleSchema } from "../host-tool-rules.js";
import { applyManagedLaunchContractSchema } from "../managed-launch-contract.js";
import { applyPreparedRoomContextSchema } from "../prepared-room-context.js";
import { applyRoomWorkPublicationSchema } from "../room-work-publication-store.js";
import { applyRuntimeRecoverySchema } from "../runtime-recovery-journal.js";
import {
  DAEMON_STATE_APPLICATION_ID,
  SCHEMA_VERSION,
  toSqliteUserVersion,
  applyAgentStateVersionSchema,
  normalizeSchemaSql,
  type Row,
} from "./shared.js";
import { assertDaemonStateVersionSupported } from "./version-gate.js";

export type SchemaMigration = (database: DatabaseSync) => void;

/** Schema v1 -> v2: introduces the unified external-effect journal and its version triggers. */
export function migrateV1ToV2(database: DatabaseSync): void {
  applyEffectJournalSchema(database);
  applyAgentStateVersionSchema(database);
}

/**
 * Plain numbered migrations from schema v1 onward. Each entry upgrades from
 * version `N` to `N + 1` inside the caller's write transaction.
 */
export const DAEMON_STATE_MIGRATIONS: Readonly<Record<number, SchemaMigration>> = {
  1: migrateV1ToV2,
};

type SchemaEntry = { type: string; name: string; tblName: string; sql: string };

let cachedReferenceSchema: readonly SchemaEntry[] | null = null;

function readSchemaEntries(database: DatabaseSync): SchemaEntry[] {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type, name
  `).all() as Row[];
  return rows.map((row) => ({
    type: String(row.type),
    name: String(row.name),
    tblName: String(row.tbl_name),
    sql: normalizeSchemaSql(String(row.sql)),
  }));
}

/** Applies the complete clean-slate v1 schema inside an active write transaction. */
export function applySchemaV1(database: DatabaseSync): void {
  database.exec(`
    -- Operational maintenance receipts/warnings (encrypted recovery backups,
    -- space compaction). Replaces legacy migration_records/migration_failures.
    CREATE TABLE daemon_maintenance_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),
      updated_at TEXT NOT NULL
    ) STRICT;

    -- Core agent domain table. Replaces 11 1:1 agent_* tables, 17 *_present
    -- columns, and global manifest_metadata.generation with per-agent version
    -- optimistic concurrency.
    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL UNIQUE,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_json TEXT CHECK (avatar_json IS NULL OR (json_valid(avatar_json) AND length(avatar_json) <= 44000)),
      room_id TEXT NOT NULL,
      local_room_id TEXT CHECK (local_room_id IS NULL OR (length(trim(local_room_id)) > 0 AND local_room_id = room_id)),
      provider TEXT NOT NULL,
      model TEXT,
      reasoning_effort TEXT CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low','medium','high','xhigh','max')),
      charter TEXT NOT NULL,
      permission_profile_id TEXT,
      config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision >= 1),
      runtime_configuration_revision INTEGER NOT NULL DEFAULT 1 CHECK (runtime_configuration_revision >= 1),
      provider_launch_policy_json TEXT CHECK (provider_launch_policy_json IS NULL OR json_valid(provider_launch_policy_json)),
      image_input INTEGER NOT NULL DEFAULT 0 CHECK (image_input IN (0, 1)),
      live_sharing TEXT NOT NULL DEFAULT 'off' CHECK (live_sharing IN ('off', 'on', 'withdrawing')),
      desired_state TEXT NOT NULL,
      source_repo_path TEXT,
      deployment_id TEXT UNIQUE,
      run_id TEXT,
      observed_state TEXT NOT NULL,
      workspace_path TEXT,
      work_attempt_id TEXT,
      provider_work_attempt_id TEXT,
      provider_continuation_id TEXT,
      provider_execution_generation_id TEXT,
      provider_connection_json TEXT CHECK (provider_connection_json IS NULL OR json_valid(provider_connection_json)),
      workplace_liveness_json TEXT CHECK (workplace_liveness_json IS NULL OR json_valid(workplace_liveness_json)),
      native_liveness_json TEXT CHECK (native_liveness_json IS NULL OR json_valid(native_liveness_json)),
      condition TEXT NOT NULL,
      last_error TEXT,
      ready_reached_at TEXT,
      last_turn_control_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_turn_control_sequence >= 0),
      turn_control_inbox_item_id TEXT,
      turn_control_status TEXT,
      turn_control_json TEXT CHECK (turn_control_json IS NULL OR json_valid(turn_control_json)),
      last_worker_binding_json TEXT CHECK (last_worker_binding_json IS NULL OR json_valid(last_worker_binding_json)),
      reconciliation_json TEXT CHECK (reconciliation_json IS NULL OR json_valid(reconciliation_json)),
      reconciliation_notices_json TEXT CHECK (reconciliation_notices_json IS NULL OR json_valid(reconciliation_notices_json)),
      CHECK ((deployment_id IS NULL AND run_id IS NULL) OR (deployment_id IS NOT NULL AND run_id IS NOT NULL)),
      CHECK ((turn_control_json IS NULL AND turn_control_inbox_item_id IS NULL AND turn_control_status IS NULL)
        OR (turn_control_json IS NOT NULL AND turn_control_status IS NOT NULL)),
      UNIQUE(agent_id, run_id)
    ) STRICT;
    CREATE INDEX agents_room ON agents(room_id, sort_order);
    CREATE INDEX agents_turn_control_inbox_item ON agents(turn_control_inbox_item_id)
      WHERE turn_control_inbox_item_id IS NOT NULL;

    CREATE TABLE activity_events (
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
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
    CREATE INDEX activity_events_summary ON activity_events(agent_id, sequence, sort_order);

    -- Lifetime reconciliation action replay dedup. Updates to agents preserve
    -- rows; deleting an agent cascades cleanup automatically.
    CREATE TABLE reconciliation_action_tombstones (
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      action_id TEXT NOT NULL,
      PRIMARY KEY(agent_id, action_id)
    ) STRICT;

    -- Work-attempt durability.
    CREATE TABLE work_attempts (
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
    CREATE TABLE work_attempt_lease_epochs (
      work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      lease_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(work_attempt_id, sort_order)
    ) STRICT;
    CREATE TABLE work_attempt_checkpoints (
      work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      at TEXT NOT NULL,
      room_cursor TEXT,
      provider_continuation_id TEXT,
      PRIMARY KEY(work_attempt_id, sort_order)
    ) STRICT;
    CREATE TABLE work_attempt_executions (
      execution_generation_id TEXT PRIMARY KEY,
      work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      generation INTEGER NOT NULL,
      terminal_json TEXT,
      UNIQUE(work_attempt_id, generation)
    ) STRICT;
    CREATE UNIQUE INDEX one_live_work_attempt_execution
      ON work_attempt_executions(work_attempt_id) WHERE terminal_json IS NULL;

    -- Worker bindings & supervised worker sessions.
    CREATE TABLE worker_session_bindings (
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
    CREATE UNIQUE INDEX worker_session_binding_authority
      ON worker_session_bindings(entry_id, binding_epoch, execution_generation_id, agent_session_id);
    CREATE TABLE worker_binding_watermarks (
      entry_id TEXT PRIMARY KEY,
      binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE worker_binding_publications (
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
    CREATE INDEX worker_binding_publications_current
      ON worker_binding_publications(entry_id, binding_epoch, sequence DESC);
    CREATE TABLE worker_generation_verifications (
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
    CREATE INDEX worker_generation_verifications_current
      ON worker_generation_verifications(entry_id, binding_epoch, sequence DESC);
    CREATE TABLE worker_execution_bindings (
      entry_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      api_url TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      work_attempt_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      agent_key TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(entry_id, execution_generation_id, agent_session_id, grant_id),
      FOREIGN KEY(work_attempt_id) REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE supervised_worker_sessions (
      agent_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      expires_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE supervised_worker_mint_states (
      agent_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      agent_instance_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('never_minted','minting_unknown','exact')),
      agent_session_id TEXT,
      updated_at TEXT NOT NULL,
      CHECK (
        (phase = 'exact' AND agent_session_id IS NOT NULL)
        OR (phase IN ('never_minted','minting_unknown') AND agent_session_id IS NULL)
      )
    ) STRICT;

    -- Inbox items & delivery journals.
    CREATE TABLE inbox_items (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_message_json TEXT NOT NULL,
      activation_json TEXT NOT NULL,
      fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence > 0),
      state TEXT NOT NULL CHECK (state IN (
        'pending','dispatching','awaiting_result','result_recovery','publishing',
        'retryable','blocked','acknowledged','acknowledged_no_reply',
        'cancelled_by_room_move','cancelled_by_user','acknowledged_failed'
      )),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      action_id TEXT NOT NULL,
      reply_client_message_id TEXT NOT NULL,
      provider_turn_id TEXT,
      outcome TEXT,
      last_error TEXT,
      failure_code TEXT CHECK (failure_code IS NULL OR failure_code = 'provider_continuation_missing'),
      blocked_by_inbox_item_id TEXT REFERENCES inbox_items(inbox_item_id),
      next_attempt_at_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acknowledged_at TEXT,
      terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason = 'upgrade_authority_unavailable'),
      UNIQUE(agent_id, room_id, source_message_id),
      UNIQUE(agent_id, fifo_sequence),
      UNIQUE(inbox_item_id, agent_id, room_id)
    ) STRICT;
    CREATE INDEX inbox_items_head ON inbox_items(agent_id, fifo_sequence);

    CREATE TABLE supervised_agent_inbox_events (
      inbox_item_id TEXT NOT NULL REFERENCES inbox_items(inbox_item_id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
      idempotency_key TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN (
        'received','queued','turn_started','turn_finished','result_unreadable',
        'publish_started','published','no_reply','retry_scheduled','blocked',
        'room_move_cancelled','conversation_restoring','conversation_restored','user_cancelled'
      )),
      observed_at TEXT NOT NULL,
      detail TEXT,
      PRIMARY KEY(inbox_item_id, event_sequence),
      UNIQUE(inbox_item_id, idempotency_key)
    ) STRICT;
    CREATE INDEX supervised_agent_inbox_events_timeline
      ON supervised_agent_inbox_events(inbox_item_id, event_sequence);

    CREATE TABLE supervised_agent_publications (
      inbox_item_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      canonical_message_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      FOREIGN KEY(inbox_item_id, agent_id, room_id)
        REFERENCES inbox_items(inbox_item_id, agent_id, room_id) ON DELETE CASCADE,
      UNIQUE(room_id, client_message_id),
      UNIQUE(room_id, canonical_message_id)
    ) STRICT;
    CREATE INDEX supervised_agent_publications_agent_room
      ON supervised_agent_publications(agent_id, room_id);

    CREATE TABLE supervised_agent_provider_turn_bindings (
      inbox_item_id TEXT PRIMARY KEY REFERENCES inbox_items(inbox_item_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      work_attempt_id TEXT NOT NULL,
      origin_execution_generation_id TEXT NOT NULL,
      provider_continuation_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      UNIQUE(agent_id, provider_continuation_id, provider_turn_id),
      FOREIGN KEY(inbox_item_id, agent_id, room_id)
        REFERENCES inbox_items(inbox_item_id, agent_id, room_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE supervised_agent_terminal_results (
      inbox_item_id TEXT PRIMARY KEY REFERENCES inbox_items(inbox_item_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('reply','no_reply','unreadable','failed','interrupted')),
      normalized_text TEXT,
      evidence_source TEXT NOT NULL CHECK (evidence_source IN ('transcript','stream','none')),
      terminal_evidence_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (outcome NOT IN ('failed','interrupted') OR (normalized_text IS NULL AND evidence_source <> 'none'))
    ) STRICT;
    CREATE UNIQUE INDEX supervised_agent_terminal_result_turn
      ON supervised_agent_terminal_results(agent_id, execution_generation_id, provider_turn_id);

    CREATE TABLE supervised_agent_ingress_cursors (
      agent_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      last_observed_message_id TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE supervised_agent_ingress_health (
      agent_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('starting','observing','backoff','blocked','stopped')),
      detail TEXT,
      observed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE supervised_agent_observed_messages (
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_message_json TEXT NOT NULL,
      activation_json TEXT NOT NULL,
      activation_decision TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(agent_id, room_id, source_message_id)
    ) STRICT;
    CREATE INDEX supervised_agent_observed_context
      ON supervised_agent_observed_messages(agent_id, room_id, source_message_id);
    CREATE TABLE supervised_agent_history_boundaries (
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      earliest_retained_observed_message_id TEXT,
      earliest_retained_inbox_message_id TEXT,
      earliest_retained_receipt_sequence INTEGER,
      pruned_before_message_id TEXT,
      pruned_at TEXT,
      updated_at TEXT NOT NULL,
      CHECK ((pruned_before_message_id IS NULL) = (pruned_at IS NULL)),
      PRIMARY KEY(agent_id, room_id)
    ) STRICT;
    CREATE INDEX supervised_agent_history_boundaries_updated
      ON supervised_agent_history_boundaries(agent_id, updated_at);
    CREATE TABLE supervised_agent_pruned_sources (
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      pruned_at TEXT NOT NULL,
      PRIMARY KEY(agent_id, room_id, source_message_id)
    ) STRICT;
    CREATE INDEX supervised_agent_pruned_sources_retention
      ON supervised_agent_pruned_sources(agent_id, pruned_at, source_message_id);

    -- Effects & per-feature operation journals.
    CREATE TABLE effects (
      effect_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      mcp_request_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_json TEXT NOT NULL,
      mutation INTEGER NOT NULL CHECK (mutation IN (0, 1)),
      state TEXT NOT NULL CHECK (state IN ('prepared','executing','uncertain','completed','failed')),
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, execution_generation_id, provider_turn_id, mcp_request_id)
    ) STRICT;
    CREATE INDEX effects_turn ON effects(agent_id, execution_generation_id, provider_turn_id);

    CREATE TABLE effect_tombstones (
      effect_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      mcp_request_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      request_bytes INTEGER NOT NULL CHECK (request_bytes >= 0),
      mutation INTEGER NOT NULL CHECK (mutation IN (0, 1)),
      state TEXT NOT NULL CHECK (state IN ('uncertain','completed','failed')),
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, execution_generation_id, provider_turn_id, mcp_request_id)
    ) STRICT;
    CREATE INDEX effect_tombstones_turn
      ON effect_tombstones(agent_id, execution_generation_id, provider_turn_id);

    CREATE TABLE provider_continuation_repairs (
      repair_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      inbox_item_id TEXT NOT NULL,
      daemon_generation INTEGER NOT NULL CHECK (daemon_generation >= 1),
      execution_generation_id TEXT NOT NULL,
      work_attempt_id TEXT NOT NULL,
      expected_pid INTEGER NOT NULL CHECK (expected_pid > 0),
      expected_process_identity TEXT NOT NULL,
      missing_continuation TEXT NOT NULL,
      replacement_continuation TEXT,
      phase TEXT NOT NULL CHECK (phase IN ('probing','replacement_created','committed','failed')),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(inbox_item_id, agent_id, room_id)
        REFERENCES inbox_items(inbox_item_id, agent_id, room_id) ON DELETE CASCADE
    ) STRICT;
    CREATE UNIQUE INDEX one_active_provider_continuation_repair
      ON provider_continuation_repairs(agent_id) WHERE phase NOT IN ('committed','failed');
    CREATE INDEX provider_continuation_repairs_agent_created
      ON provider_continuation_repairs(agent_id, created_at);
    CREATE INDEX provider_continuation_repairs_inbox
      ON provider_continuation_repairs(inbox_item_id, updated_at);
    CREATE INDEX provider_continuation_repairs_inbox_created
      ON provider_continuation_repairs(inbox_item_id, created_at);

    CREATE TABLE agent_room_moves (
      operation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL,
      destination_room_id TEXT NOT NULL,
      daemon_generation INTEGER NOT NULL CHECK (daemon_generation >= 1),
      work_attempt_id TEXT,
      execution_generation_id TEXT,
      agent_session_id TEXT,
      activating_inbox_item_id TEXT,
      provider_turn_id TEXT,
      effect_id TEXT,
      phase TEXT NOT NULL CHECK (phase IN (
        'prepared','waiting_for_current_turn','joining_destination','membership_committed',
        'rotating_credentials','bootstrapping_destination_tail','active','failed','rollback_required'
      )),
      remote_room_id TEXT,
      destination_cursor TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_cursor_present INTEGER NOT NULL DEFAULT 0 CHECK (source_cursor_present IN (0, 1)),
      source_cursor TEXT,
      source_credentials_revoked INTEGER NOT NULL DEFAULT 0 CHECK (source_credentials_revoked IN (0, 1)),
      CHECK (source_room_id <> destination_room_id),
      CHECK ((work_attempt_id IS NULL) = (execution_generation_id IS NULL))
    ) STRICT;
    CREATE UNIQUE INDEX one_active_agent_room_move
      ON agent_room_moves(agent_id) WHERE phase NOT IN ('active','failed');
    CREATE INDEX agent_room_moves_agent_updated
      ON agent_room_moves(agent_id, updated_at);

    CREATE TABLE agent_purge_operations (
      operation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      daemon_generation INTEGER NOT NULL CHECK (daemon_generation >= 1),
      phase TEXT NOT NULL CHECK (phase IN (
        'prepared','reprepare_credentials','revoking_credentials','local_commit','complete','failed'
      )),
      external_revoke_required INTEGER NOT NULL CHECK (external_revoke_required IN (0, 1)),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attached_work_attempt_id TEXT,
      preserved_workspace_path TEXT,
      worker_session_attestation TEXT NOT NULL CHECK (worker_session_attestation IN ('exact','none','unknown','not_required')),
      agent_session_id TEXT,
      CHECK (
        (external_revoke_required = 0 AND worker_session_attestation = 'not_required' AND agent_session_id IS NULL)
        OR (external_revoke_required = 1 AND (
          (worker_session_attestation = 'exact' AND agent_session_id IS NOT NULL)
          OR (worker_session_attestation IN ('none','unknown') AND agent_session_id IS NULL)
        ))
      )
    ) STRICT;
    CREATE UNIQUE INDEX one_active_agent_purge
      ON agent_purge_operations(agent_id) WHERE phase NOT IN ('complete','failed');
    CREATE INDEX agent_purge_operations_agent_updated
      ON agent_purge_operations(agent_id, updated_at);
  `);

  applyExecutionStorageSchema(database);
  applyApprovalRequestClosureSchema(database);
  applyExecutionApprovalPublicationSchema(database);
  applyHostToolRuleSchema(database);
  applyRoomWorkPublicationSchema(database);
  applyRuntimeRecoverySchema(database);
  applyPreparedRoomContextSchema(database);
  applyManagedLaunchContractSchema(database);
  applyAgentStateVersionSchema(database);
}

/**
 * Applies the current daemon schema on an empty database by installing the
 * immutable v1 baseline followed by every plain numbered migration through
 * `SCHEMA_VERSION`. Fresh installs and migrated databases therefore share
 * the exact same DDL by construction.
 */
export function applySchemaCurrent(database: DatabaseSync): void {
  applySchemaV1(database);
  runNumberedMigrations(database, 1, SCHEMA_VERSION);
}

/** Runs plain numbered migrations `fromVersion -> targetVersion` inside a transaction. */
/**
 * Runs plain numbered migrations (`v1 -> v2 -> ...`) inside the caller's
 * active `BEGIN IMMEDIATE` transaction.
 *
 * Foreign-key hazard note: `DaemonStateSchema.createSchema` runs migrations
 * inside `BEGIN IMMEDIATE` with `PRAGMA foreign_keys = ON`. SQLite ignores
 * `PRAGMA foreign_keys = OFF` inside a transaction, so a migration that drops
 * and recreates a parent table referenced by `ON DELETE CASCADE` (such as
 * `agents`) would silently delete child rows. Keep migrations additive or
 * drop-only for leaf tables; if a future migration must rebuild a parent table,
 * toggle `PRAGMA foreign_keys = OFF` outside the transaction and verify
 * `PRAGMA foreign_key_check` before restoring it.
 */
export function runNumberedMigrations(
  database: DatabaseSync,
  fromVersion: number,
  targetVersion: number,
  migrations: Readonly<Record<number, SchemaMigration>> = DAEMON_STATE_MIGRATIONS,
): void {
  for (let version = fromVersion; version < targetVersion; version += 1) {
    const step = migrations[version];
    if (!step) throw new Error(`Missing daemon state migration from schema v${version} to v${version + 1}.`);
    step(database);
    database.exec(`PRAGMA user_version = ${toSqliteUserVersion(version + 1)}`);
  }
}

function referenceSchema(): readonly SchemaEntry[] {
  if (cachedReferenceSchema) return cachedReferenceSchema;
  const memory = new DatabaseSync(":memory:");
  try {
    memory.exec("PRAGMA foreign_keys = ON");
    applySchemaCurrent(memory);
    memory.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}`);
    memory.exec(`PRAGMA user_version = ${toSqliteUserVersion(SCHEMA_VERSION)}`);
    cachedReferenceSchema = readSchemaEntries(memory);
    return cachedReferenceSchema;
  } finally {
    memory.close();
  }
}

/**
 * Compares the database's full `sqlite_master` shape 1:1 against a fresh
 * in-memory database built from the exact same schema code.
 */
export function validateDaemonStateShape(database: DatabaseSync): void {
  if (assertDaemonStateVersionSupported(database) !== SCHEMA_VERSION) {
    throw new Error(`Daemon state storage requires schema version ${SCHEMA_VERSION}.`);
  }
  const expected = referenceSchema();
  const actual = readSchemaEntries(database);
  const expectedMap = new Map(expected.map((entry) => [`${entry.type}:${entry.name}`, entry]));
  const actualMap = new Map(actual.map((entry) => [`${entry.type}:${entry.name}`, entry]));
  for (const [key, want] of expectedMap) {
    const got = actualMap.get(key);
    if (!got || got.tblName !== want.tblName || got.sql !== want.sql) {
      throw new Error(`Daemon state schema mismatch on ${want.type} ${want.name}.`);
    }
  }
  for (const [key, extra] of actualMap) {
    if (!expectedMap.has(key)) {
      throw new Error(`Daemon state schema contains unexpected ${extra.type} ${extra.name}.`);
    }
  }
  if (database.prepare("PRAGMA foreign_key_check").get()) {
    throw new Error("Daemon state failed foreign-key validation.");
  }
  const integrity = database.prepare("PRAGMA integrity_check(1)").get() as Row | undefined;
  if (String(integrity?.integrity_check ?? "").toLowerCase() !== "ok") {
    throw new Error(`Daemon state failed SQLite integrity validation: ${String(integrity?.integrity_check ?? "unknown")}`);
  }
}

/** Owns the single daemon-state schema and plain numbered transitions from v1. */
export class DaemonStateSchema {
  constructor(readonly schemaInitializationHook?: (database: DatabaseSync) => void) {}

  createSchema(database: DatabaseSync): void {
    const existingVersion = assertDaemonStateVersionSupported(database);
    if (existingVersion === SCHEMA_VERSION) {
      this.validateCurrentShape(database);
      return;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      // Re-check under the write lock: another process may have finished bootstrapping
      // or migrating between the unlocked read above and acquiring BEGIN IMMEDIATE.
      const lockedVersion = assertDaemonStateVersionSupported(database);
      if (lockedVersion === 0) {
        applySchemaCurrent(database);
        this.schemaInitializationHook?.(database);
        database.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}`);
        database.exec(`PRAGMA user_version = ${toSqliteUserVersion(SCHEMA_VERSION)}`);
      } else if (lockedVersion < SCHEMA_VERSION) {
        runNumberedMigrations(database, lockedVersion, SCHEMA_VERSION);
      }
      this.validateCurrentShape(database);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
      throw error;
    }
  }

  validateCurrentShape(database: DatabaseSync): void {
    validateDaemonStateShape(database);
  }
}
