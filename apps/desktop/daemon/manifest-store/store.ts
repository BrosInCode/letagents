/**
 * The ManifestStore class: fields, constructor, ensureDatabase, and the method composition.
 *
 * Modules:
 * - entry-reads.ts: Manifest and entry reads, runtime lifecycle authority, and typed lifecycle effects.
 * - approvals.ts: Execution approvals, host tool rules, managed-runtime checks and execution delegation.
 * - delivery-and-polling.ts: Delivery drains, agent configuration reads, live sharing, and custodial polling activation and offers.
 * - room-moves-and-purges.ts: Room-move and purge journals.
 * - entries-and-recovery.ts: Agent configuration updates, entry replacement, provider birth checkpoints and runtime recovery.
 * - turn-control.ts: Turn-control preparation, target checkpoints and commit.
 * - cursor-turns.ts: Cursor prepared-turn and provider-state checkpoints.
 * - activity.ts: Batch entry replacement and removal, runtime configuration, activity writes and workplace liveness.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import { PreparedReadStatements } from "../prepared-reads.js";
import type { DatabaseSync } from "node:sqlite";
import { chmod, readFile, rename } from "node:fs/promises";
import { DaemonStateSchema, openDaemonStateDatabase, openPreparedDaemonStateDatabase } from "../daemon-state-database.js";
import { assertNoPollingActivation } from "../custodial-polling-activation.js";
import { assertNoDeliveryDrain } from "../delivery-drain.js";
import { MAX_PROJECTED_COMPLETED_ACTION_IDS } from "../reconciler-state.js";
import { STATE_WATCH_ACTIVITY_SUMMARY_LIMIT } from "../state-watch-projection.js";
import { pruneSupervisedAgentHistory } from "../supervised-agent-history-retention.js";
import { projectDaemonManifestEntry, type DaemonManifestDomainProjection } from "../manifest-entry-projection.js";
import type { DaemonAgentConfiguration, DaemonManifest, DaemonManifestEntry, DaemonProviderConnection, DaemonProviderRuntimeReference, DaemonTurnControlEffect, ExecutionTerminalPayload, ReconciliationNotice, ReconciliationState } from "../types.js";
import { type StoredManifest, type Row, liveSharingState, type PreMembershipRoomMoveCancellation, ManifestConflictError, checksum, bool, nullableString, nullableNumber, json, parseJson, activityEventFromRow, importedWithoutHomeHarness, canonicalManifestEntry, run, MANIFEST_READS } from "./shared.js";
import { entryReads } from "./entry-reads.js";
import { approvals } from "./approvals.js";
import { deliveryAndPolling } from "./delivery-and-polling.js";
import { roomMovesAndPurges } from "./room-moves-and-purges.js";
import { entriesAndRecovery } from "./entries-and-recovery.js";
import { turnControl } from "./turn-control.js";
import { cursorTurns } from "./cursor-turns.js";
import { activity } from "./activity.js";

/**
 * SQLite-backed durable state for the daemon's compatibility manifest.
 *
 * The flat manifest entry remains the control-socket contract only. Each row is
 * decomposed into records with distinct ownership before persistence, and reads
 * recompose the same flat projection for existing callers.
 */
export class ManifestStore {
  readonly reads = new PreparedReadStatements(MANIFEST_READS);
  database: DatabaseSync | null = null;
  initializing: Promise<DatabaseSync> | null = null;
  writes: Promise<void> = Promise.resolve();
  closed = false;
  pendingActivityState: ((agentId: string) => { observedState: DaemonManifestEntry["observed_state"] | null } | null) | null = null;

  constructor(
    readonly path: string,
    readonly legacyJsonPath?: string,
    readonly permissionHousekeeping?: (paths: string[]) => Promise<void>,
    readonly schemaInitializationHook?: (database: DatabaseSync) => void,
    readonly schemaPrepared = false,
  ) {}

  /** Initialise/upgrade the shared daemon database without retaining a handle. */
  static async ensureDatabase(path: string): Promise<void> {
    const store = new ManifestStore(path);
    try { await store.load(); } finally { await store.close(); }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
    await this.initializing?.catch(() => undefined);
    this.reads.clear();
    this.database?.close();
    this.database = null;
    this.initializing = null;
  }

  async write(
    expectedGeneration: number,
    entries: DaemonManifest["entries"],
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
    roomMoveCancellation?: PreMembershipRoomMoveCancellation,
  ): Promise<DaemonManifest> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      const normalizedEntries = entries.map(canonicalManifestEntry);
      let committed = false;
      let transactionOpen = false;
      try {
        const commit = async () => {
          if (committed) throw new Error("Manifest transaction was already committed.");
          database.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
          const result = database.prepare(`
            UPDATE manifest_metadata SET generation = generation + 1
            WHERE singleton = 1 AND generation = ?
          `).run(expectedGeneration);
          if (Number(result.changes) !== 1) {
            const current = Number((this.reads.get(database, "generation").get() as Row).generation);
            throw new ManifestConflictError(`Manifest generation ${current} does not match expected ${expectedGeneration}.`);
          }
          if (roomMoveCancellation) this.failPreMembershipRoomMoves(database, roomMoveCancellation);
          this.replaceEntries(database, normalizedEntries);
          database.exec("COMMIT");
          transactionOpen = false;
          committed = true;
        };
        if (commitFence) await commitFence(commit);
        else await commit();
        if (!committed) throw new Error("Manifest commit fence returned without committing the transaction.");

        const persistedEntries = normalizedEntries.map((entry) => {
          const persisted = this.readEntryFromDatabase(database, entry.id);
          if (!persisted) throw new Error(`Daemon manifest entry disappeared after full replacement: ${entry.id}`);
          return persisted;
        });
        const returnedEntries = persistedEntries.map((entry) => entry.reconciliation
          ? {
            ...entry,
            reconciliation: {
              ...entry.reconciliation,
              completed_action_ids: entry.reconciliation.completed_action_ids.slice(-MAX_PROJECTED_COMPLETED_ACTION_IDS),
            },
          }
          : entry);
        const manifest: DaemonManifest = { generation: expectedGeneration + 1, entries: returnedEntries };
        return manifest;
      } catch (error) {
        if (transactionOpen) {
          try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
        }
        throw error;
      }
    });
  }

  async getDatabase(): Promise<DatabaseSync> {
    if (this.closed) throw new Error("ManifestStore is closed.");
    if (this.database) return this.database;
    if (!this.initializing) this.initializing = this.initialize();
    return this.initializing;
  }

  async initialize(): Promise<DatabaseSync> {
    let database: DatabaseSync | null = null;
    try {
      database = this.schemaPrepared
        ? await openPreparedDaemonStateDatabase(this.path)
        : await openDaemonStateDatabase(this.path, async (opened) => {
          await this.secureDatabaseFiles();
          this.createSchema(opened);
        });
      await this.importLegacyManifest(database);
      this.database = database;
      return database;
    } catch (error) {
      database?.close();
      this.initializing = null;
      throw error;
    }
  }

  createSchema(database: DatabaseSync): void {
    new DaemonStateSchema(this.schemaInitializationHook).createSchema(database);
  }
  async importLegacyManifest(database: DatabaseSync): Promise<void> {
    if (!this.legacyJsonPath) return;
    const migrationKey = `legacy-json:${this.legacyJsonPath}`;
    const failed = database.prepare("SELECT reason, quarantined_path FROM migration_failures WHERE migration_key = ?").get(migrationKey) as Row | undefined;
    if (failed) throw new Error(`Legacy daemon manifest migration is blocked after validation failure (${String(failed.reason)}); quarantined at ${String(failed.quarantined_path)}.`);
    const existing = database.prepare("SELECT checksum FROM migration_records WHERE migration_key = ?").get(migrationKey) as Row | undefined;
    if (existing) {
      await this.retainLegacyBackup(String(existing.checksum));
      return;
    }

    let source: string;
    try {
      source = await readFile(this.legacyJsonPath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    let stored: StoredManifest;
    try {
      stored = JSON.parse(source) as StoredManifest;
      if (!stored.manifest || stored.checksum !== checksum(stored.manifest)) throw new Error("checksum mismatch");
    } catch (error) {
      const quarantinedPath = `${this.legacyJsonPath}.corrupt-${Date.now()}`;
      run(database.prepare("INSERT OR REPLACE INTO migration_failures(migration_key, reason, failed_at, quarantined_path) VALUES (?, ?, ?, ?)"), migrationKey, String(error), new Date().toISOString(), quarantinedPath);
      await rename(this.legacyJsonPath, quarantinedPath);
      throw new Error(`Legacy daemon manifest failed checksum validation: ${String(error)}`);
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const current = Number((this.reads.get(database, "generation").get() as Row).generation);
      const count = Number((database.prepare("SELECT COUNT(*) AS count FROM agent_identities").get() as Row).count);
      if (current !== 0 || count !== 0) throw new Error("Refusing to import a legacy manifest into non-empty daemon state.");
      // An imported file is not the desktop app's signed choice, so no
      // imported agent starts with its owner's own setup turned on.
      this.replaceEntries(database, stored.manifest.entries.map(importedWithoutHomeHarness).map((entry) =>
        entry.provider === "codex" && entry.provider_ref
          ? { ...entry, desired_state: "stopped" as const }
          : entry), false);
      run(database.prepare("UPDATE manifest_metadata SET generation = ? WHERE singleton = 1"), stored.manifest.generation);
      run(database.prepare("INSERT INTO migration_records(migration_key, checksum, imported_at) VALUES (?, ?, ?)"), migrationKey, stored.checksum, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
      throw error;
    }
    await this.retainLegacyBackup(stored.checksum);
  }

  async retainLegacyBackup(expectedChecksum: string): Promise<void> {
    if (!this.legacyJsonPath) return;
    let source: string;
    try {
      source = await readFile(this.legacyJsonPath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const stored = JSON.parse(source) as StoredManifest;
    if (stored.checksum !== expectedChecksum || !stored.manifest || checksum(stored.manifest) !== expectedChecksum) {
      throw new Error("Refusing to retain a legacy manifest backup whose checksum differs from the imported source.");
    }
    await rename(this.legacyJsonPath, `${this.legacyJsonPath}.migrated-backup`);
  }

  replaceEntries(database: DatabaseSync, entries: DaemonManifestEntry[], initializeNewMintStates = true): void {
    const configurations = new Map((database.prepare("SELECT * FROM agent_configurations").all() as Row[]).map((row) => [String(row.agent_id), row]));
    const existingIdentities = new Set((database.prepare("SELECT agent_id FROM agent_identities").all() as Row[])
      .map((row) => String(row.agent_id)));
    database.exec("DELETE FROM agent_identities");
    entries.forEach((entry, index) => {
      const normalized = canonicalManifestEntry(entry);
      const projection = projectDaemonManifestEntry(normalized);
      const configuration = configurations.get(normalized.id);
      if (configuration) {
        this.preserveInspectorConfiguration(projection, configuration);
      }
      this.insertProjection(database, projection, index);
      if (initializeNewMintStates && !existingIdentities.has(normalized.id)
        && (normalized.delivery_mode ?? "mcp_polling") === "daemon_inbox"
        && Object.hasOwn(normalized, "last_worker_binding")) {
        const binding = normalized.last_worker_binding ?? null;
        run(database.prepare(`
          INSERT OR IGNORE INTO supervised_worker_mint_states
            (agent_id,room_id,agent_instance_id,phase,agent_session_id,updated_at)
          VALUES (?,?,?,?,?,?)
        `), normalized.id, normalized.room_id, `daemon:${normalized.id}`,
        binding ? "exact" : "never_minted", binding?.agent_session_id ?? null,
        binding?.updated_at ?? new Date().toISOString());
      }
    });
    // Full replacement is also the explicit deletion boundary. Targeted
    // replacement deliberately preserves the constant-size sequence authority.
    database.exec(`DELETE FROM turn_control_sequence_watermarks
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_identities identities
        WHERE identities.agent_id = turn_control_sequence_watermarks.agent_id
      )`);
    database.exec(`DELETE FROM reconciliation_action_tombstones
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_identities identities
        WHERE identities.agent_id = reconciliation_action_tombstones.agent_id
      )`);
  }

  preserveInspectorConfiguration(projection: DaemonManifestDomainProjection, row: Row): void {
    // Custody, like Inspector revisions, is database-owned and cannot be
    // replaced by the compatibility manifest's stale or caller-supplied fields.
    projection.configuration.polling_contract = nullableString(row.polling_contract) as DaemonAgentConfiguration["polling_contract"];
    projection.configuration.provider = String(row.provider);
    projection.configuration.model = nullableString(row.model);
    projection.configuration.reasoning_effort = nullableString(row.reasoning_effort) as DaemonAgentConfiguration["reasoning_effort"];
    projection.configuration.charter = String(row.charter);
    projection.configuration.permission_profile_id = nullableString(row.permission_profile_id);
    projection.configuration.config_revision = Number(row.config_revision);
    projection.configuration.runtime_configuration_revision = Number(row.runtime_configuration_revision);
    projection.configuration.image_input = bool(row.image_input);
    projection.configuration.live_sharing = liveSharingState(row.live_sharing);
    if (bool(row.provider_launch_policy_present)) {
      projection.configuration.provider_launch_policy = bool(row.provider_launch_policy_undefined) ? undefined : parseJson(row.provider_launch_policy_json);
    } else {
      delete projection.configuration.provider_launch_policy;
    }
  }

  insertProjection(database: DatabaseSync, projection: DaemonManifestDomainProjection, sortOrder: number): void {
    const { identity, profile, membership, configuration, launch_intent: launch, runtime_deployment: runtime, lifecycle, readiness, turn_control_journal: turnJournal, retained_worker_binding: bindingRecord, reconciliation: reconciliationRecord } = projection;
    // Legacy cutover preparation commits through all projection replacement
    // paths; a preflight check alone would race native drain acceptance.
    if (configuration.delivery_cutover) {
      assertNoDeliveryDrain(database, identity.agent_id);
      assertNoPollingActivation(database, identity.agent_id);
    }
    run(database.prepare("INSERT INTO agent_identities VALUES (?, ?, ?, ?)"), identity.agent_id, identity.created_by, identity.created_at, sortOrder);
    run(database.prepare("INSERT INTO agent_profiles VALUES (?, ?)"), identity.agent_id, profile.display_name);
    run(database.prepare("INSERT INTO agent_room_memberships(agent_id, room_id, local_room_id) VALUES (?, ?, ?)"), identity.agent_id, membership.room_id, membership.local_room_id ?? null);
    const policyPresent = Object.hasOwn(configuration, "provider_launch_policy");
    const policyUndefined = policyPresent && configuration.provider_launch_policy === undefined;
    run(database.prepare(`
      INSERT INTO agent_configurations(
        agent_id, provider, model, reasoning_effort, charter, permission_profile_id, config_revision, runtime_configuration_revision, delivery_mode, delivery_cutover_json,
        provider_launch_policy_present, provider_launch_policy_undefined, provider_launch_policy_json, polling_contract, image_input, live_sharing
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `), identity.agent_id, configuration.provider, configuration.model, configuration.reasoning_effort ?? null, configuration.charter, configuration.permission_profile_id, configuration.config_revision ?? 1, configuration.runtime_configuration_revision ?? configuration.config_revision ?? 1, configuration.delivery_mode ?? "mcp_polling", configuration.delivery_cutover === undefined ? null : json(configuration.delivery_cutover), Number(policyPresent), Number(policyUndefined), policyPresent && !policyUndefined ? json(configuration.provider_launch_policy) : null, configuration.polling_contract ?? null, configuration.image_input === true ? 1 : 0, liveSharingState(configuration.live_sharing));
    const sourcePresent = Object.hasOwn(launch, "source_repo_path");
    run(database.prepare("INSERT INTO agent_launch_intents VALUES (?, ?, ?, ?)"), identity.agent_id, launch.desired_state, Number(sourcePresent), sourcePresent ? launch.source_repo_path ?? null : null);

    const providerPresent = Object.hasOwn(runtime, "provider_ref");
    const providerRef = runtime.provider_ref ?? null;
    const connection = providerRef?.provider_connection ?? null;
    const workspacePresent = Object.hasOwn(runtime, "workspace_path");
    const attemptPresent = Object.hasOwn(runtime, "work_attempt_id");
    const workplacePresent = Object.hasOwn(runtime, "workplace_liveness");
    const nativePresent = Object.hasOwn(runtime, "native_liveness");
    const activityPresent = Object.hasOwn(runtime, "activity");
    const processIdentityPresent = Boolean(connection && Object.hasOwn(connection, "processIdentity") && connection.processIdentity !== undefined);
    run(database.prepare(`
      INSERT INTO runtime_deployments(
        agent_id, deployment_id, run_id, observed_state,
        workspace_path_present, workspace_path, work_attempt_id_present, work_attempt_id,
        provider_ref_present, provider_work_attempt_id, provider_continuation_id,
        provider_connection_kind, provider_connection_url, provider_server_auth_path,
        provider_connection_pid,
        provider_process_identity_present, provider_process_identity, provider_execution_generation_id, custodial_launch_agent_session_id,
        workplace_liveness_present, workplace_liveness_state, workplace_liveness_observed_at, workplace_liveness_detail,
        native_liveness_present, native_liveness_state, native_liveness_observed_at, native_liveness_detail,
        activity_present
      ) VALUES (${Array.from({ length: 28 }, () => "?").join(", ")})
    `),
      identity.agent_id, runtime.deployment_id, runtime.run_id, runtime.observed_state,
      Number(workspacePresent), workspacePresent ? runtime.workspace_path ?? null : null,
      Number(attemptPresent), attemptPresent ? runtime.work_attempt_id ?? null : null,
      Number(providerPresent), providerRef?.work_attempt_id ?? null, providerRef?.provider_continuation_id ?? null,
      connection?.kind ?? null,
      connection?.kind === "codex_app_server" || connection?.kind === "opencode_server"
        ? connection.url
        : null,
      connection?.kind === "opencode_server" ? connection.serverAuthPath : null,
      connection?.pid ?? null, Number(processIdentityPresent), connection?.processIdentity ?? null,
      providerRef?.execution_generation_id ?? null,
      providerRef?.custodial_launch_agent_session_id ?? null,
      Number(workplacePresent), runtime.workplace_liveness?.state ?? null,
      runtime.workplace_liveness?.observed_at ?? null, runtime.workplace_liveness?.detail ?? null,
      Number(nativePresent), runtime.native_liveness?.state ?? null,
      runtime.native_liveness?.observed_at ?? null, runtime.native_liveness?.detail ?? null,
      Number(activityPresent));
    const insertActivity = database.prepare("INSERT INTO activity_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    (runtime.activity ?? []).forEach((event, index) => run(insertActivity,
      identity.agent_id, index, event.observed_at, event.sequence, event.provider, event.kind,
      event.method, event.summary, event.status, json(event.payload), Number(event.payload_truncated),
      Number(event.payload_redacted), event.durable_payload_ref));

    const errorPresent = Object.hasOwn(lifecycle, "last_error");
    run(database.prepare("INSERT INTO agent_lifecycle_states VALUES (?, ?, ?, ?)"), identity.agent_id, lifecycle.condition, Number(errorPresent), errorPresent ? lifecycle.last_error ?? null : null);
    const readyPresent = Object.hasOwn(readiness, "ready_reached_at");
    run(database.prepare("INSERT INTO agent_readiness VALUES (?, ?, ?)"), identity.agent_id, Number(readyPresent), readyPresent ? readiness.ready_reached_at ?? null : null);

    const turnPresent = Object.hasOwn(turnJournal, "turn_control");
    const turn = turnJournal.turn_control ?? null;
    const projectedWatermark = turnJournal.last_turn_control_sequence;
    if (!Number.isSafeInteger(projectedWatermark) || projectedWatermark < 0) {
      throw new Error("Turn-control sequence watermark must be a non-negative safe integer.");
    }
    if (turn && (!Number.isSafeInteger(turn.action_sequence) || turn.action_sequence < 1)) {
      throw new Error("Persisted turn control requires a positive exact action sequence.");
    }
    const existingWatermark = database.prepare("SELECT last_sequence FROM turn_control_sequence_watermarks WHERE agent_id=?")
      .get(identity.agent_id) as Row | undefined;
    if (!existingWatermark && projectedWatermark > 0) {
      run(database.prepare("INSERT INTO turn_control_sequence_watermarks(agent_id,last_sequence) VALUES (?,?)"),
        identity.agent_id, projectedWatermark);
    }
    const durableWatermark = existingWatermark ? Number(existingWatermark.last_sequence) : projectedWatermark;
    if (turn && turn.action_sequence !== durableWatermark) {
      throw new Error("Persisted turn control does not exactly match its durable sequence watermark.");
    }
    run(database.prepare(`
      INSERT INTO turn_control_journals(
        agent_id, turn_control_present, action_id, action_sequence, turn_work_attempt_id,
        turn_execution_generation_id, target_room_id, target_source_message_id, target_provider_continuation_id,
        inbox_item_id, provider_turn_id, has_correction, correction_text, correction_strategy, operator_resolution, status,
        capability, interrupted, resumed, turn_state, error, recorded_at, updated_at
      ) VALUES (${Array.from({ length: 23 }, () => "?").join(", ")})
    `),
      identity.agent_id, Number(turnPresent), turn?.action_id ?? null, turn?.action_sequence ?? null, turn?.work_attempt_id ?? null,
      turn?.execution_generation_id ?? null, turn?.target_room_id ?? null, turn?.target_source_message_id ?? null,
      turn?.target_provider_continuation_id ?? null, turn?.inbox_item_id ?? null, turn?.provider_turn_id ?? null, turn ? Number(turn.has_correction) : null,
      turn?.correction_text ?? null, turn?.correction_strategy ?? null, turn?.operator_resolution ?? null, turn?.status ?? null, turn?.capability ?? null,
      turn?.interrupted === null || turn?.interrupted === undefined ? null : Number(turn.interrupted),
      turn?.resumed === null || turn?.resumed === undefined ? null : Number(turn.resumed),
      turn?.state ?? null, turn?.error ?? null, turn?.recorded_at ?? null, turn?.updated_at ?? null);
    const insertStage = database.prepare("INSERT INTO turn_control_stages VALUES (?, ?, ?)");
    (turn?.stages ?? []).forEach((stage, index) => run(insertStage, identity.agent_id, index, stage));

    const bindingPresent = Object.hasOwn(bindingRecord, "last_worker_binding");
    const binding = bindingRecord.last_worker_binding ?? null;
    run(database.prepare("INSERT INTO retained_worker_bindings VALUES (?, ?, ?, ?, ?, ?)"), identity.agent_id, Number(bindingPresent), binding?.agent_session_id ?? null, binding?.work_attempt_id ?? null, binding?.execution_generation_id ?? null, binding?.updated_at ?? null);

    const reconciliationPresent = Object.hasOwn(reconciliationRecord, "reconciliation");
    const state = reconciliationRecord.reconciliation;
    const terminalPresent = Boolean(state?.last_terminal);
    const terminal = state?.last_terminal;
    const noticesPresent = Object.hasOwn(reconciliationRecord, "reconciliation_notices");
    run(database.prepare(`
      INSERT INTO reconciliation_records(
        agent_id, reconciliation_present, consecutive_action_failures, last_observed_state,
        next_restart_at_ms, last_action_sequence, pending_action_id, pending_action_sequence,
        pending_action_kind, pending_action_recorded_at_ms, last_terminal_present,
        terminal_ended_at, terminal_exit_code, terminal_signal, terminal_stdio_archive_ref,
        terminal_stdio_tail, terminal_cause, terminal_actor, terminal_generation,
        terminal_provider_continuation_id, reconciliation_notices_present
      ) VALUES (${Array.from({ length: 21 }, () => "?").join(", ")})
    `),
      identity.agent_id, Number(reconciliationPresent), state?.consecutive_action_failures ?? null, state?.last_observed_state ?? null,
      state?.next_restart_at_ms ?? null, state?.last_action_sequence ?? null,
      state?.pending_action?.id ?? null, state?.pending_action?.sequence ?? null,
      state?.pending_action?.kind ?? null, state?.pending_action?.recorded_at_ms ?? null,
      Number(terminalPresent), terminal?.ended_at ?? null, terminal?.exit_code ?? null,
      terminal?.signal ?? null, terminal?.stdio_archive_ref ?? null, terminal?.stdio_tail ?? null,
      terminal?.terminal_cause ?? null, terminal?.actor ?? null, terminal?.generation ?? null,
      terminal?.provider_continuation_id ?? null, Number(noticesPresent));
    const insertExitTimestamp = database.prepare("INSERT INTO reconciliation_exit_timestamps VALUES (?, ?, ?)");
    (state?.exit_timestamps_ms ?? []).forEach((timestamp, index) => run(insertExitTimestamp, identity.agent_id, index, timestamp));
    const completedActionIds = state?.completed_action_ids ?? [];
    const projectedActionIds = completedActionIds.slice(-MAX_PROJECTED_COMPLETED_ACTION_IDS);
    const insertAction = database.prepare("INSERT INTO reconciliation_completed_actions VALUES (?, ?, ?)");
    projectedActionIds.forEach((actionId, index) => run(insertAction, identity.agent_id, index, actionId));
    const insertNotice = database.prepare(`INSERT INTO reconciliation_notices VALUES (${Array.from({ length: 15 }, () => "?").join(", ")})`);
    (reconciliationRecord.reconciliation_notices ?? []).forEach((notice, index) => {
      const noticeTerminal = notice.terminal;
      run(insertNotice, identity.agent_id, index, notice.at, notice.kind, notice.cause,
        Number(Boolean(noticeTerminal)), noticeTerminal?.ended_at ?? null, noticeTerminal?.exit_code ?? null,
        noticeTerminal?.signal ?? null, noticeTerminal?.stdio_archive_ref ?? null,
        noticeTerminal?.stdio_tail ?? null, noticeTerminal?.terminal_cause ?? null,
        noticeTerminal?.actor ?? null, noticeTerminal?.generation ?? null,
        noticeTerminal?.provider_continuation_id ?? null);
    });
  }

  projectionFromRow(database: DatabaseSync, row: Row, activityMode: "full" | "summary" = "full"): DaemonManifestDomainProjection {
    const agentId = String(row.agent_id);
    let providerRef: DaemonProviderRuntimeReference | null | undefined;
    if (bool(row.provider_ref_present)) {
      if (row.provider_execution_generation_id === null) providerRef = null;
      else {
        let providerConnection: DaemonProviderConnection | null = null;
        if (row.provider_connection_kind === "codex_app_server") providerConnection = { kind: "codex_app_server", url: String(row.provider_connection_url), pid: nullableNumber(row.provider_connection_pid), ...(bool(row.provider_process_identity_present) ? { processIdentity: nullableString(row.provider_process_identity) } : {}) };
        else if (row.provider_connection_kind === "claude_cli") providerConnection = { kind: "claude_cli", pid: nullableNumber(row.provider_connection_pid), ...(bool(row.provider_process_identity_present) ? { processIdentity: nullableString(row.provider_process_identity) } : {}) };
        else if (row.provider_connection_kind === "cursor_cli") providerConnection = { kind: "cursor_cli", pid: nullableNumber(row.provider_connection_pid), ...(bool(row.provider_process_identity_present) ? { processIdentity: nullableString(row.provider_process_identity) } : {}) };
        else if (row.provider_connection_kind === "opencode_server") providerConnection = {
          kind: "opencode_server",
          url: String(row.provider_connection_url),
          pid: nullableNumber(row.provider_connection_pid),
          ...(bool(row.provider_process_identity_present)
            ? { processIdentity: nullableString(row.provider_process_identity) }
            : {}),
          serverAuthPath: String(row.provider_server_auth_path),
        };
        providerRef = {
          work_attempt_id: String(row.provider_work_attempt_id),
          provider_continuation_id: String(row.provider_continuation_id),
          provider_connection: providerConnection,
          execution_generation_id: String(row.provider_execution_generation_id),
          ...(row.custodial_launch_agent_session_id != null
            ? { custodial_launch_agent_session_id: String(row.custodial_launch_agent_session_id) } : {}),
        };
      }
    }
    // Bound the database read itself: state watchers never need raw payloads.
    // sort_order breaks sequence ties exactly as the stable wire projection does.
    const activityRows = activityMode === "summary"
      ? (this.reads.get(database, "activitySummary")
        .all(agentId, STATE_WATCH_ACTIVITY_SUMMARY_LIMIT) as Row[]).reverse()
      : this.reads.get(database, "activity").all(agentId) as Row[];
    const activity = activityRows.map((event) => activityEventFromRow(event, parseJson(event.payload_json)));
    const stages = (this.reads.get(database, "stages").all(agentId) as Row[]).map((stage) => String(stage.stage)) as DaemonTurnControlEffect["stages"];
    const completedActions = (this.reads.get(database, "completedActions").all(agentId, MAX_PROJECTED_COMPLETED_ACTION_IDS) as Row[])
      .map((action) => String(action.action_id)).reverse();
    const exitTimestamps = (this.reads.get(database, "exitTimestamps").all(agentId) as Row[]).map((item) => Number(item.timestamp_ms));
    const notices = (this.reads.get(database, "notices").all(agentId) as Row[]).map((notice): ReconciliationNotice => ({
      at: String(notice.at), kind: String(notice.kind) as ReconciliationNotice["kind"], cause: String(notice.cause),
      ...(bool(notice.terminal_present) ? { terminal: this.terminalFromRow(notice, "terminal_") } : {}),
    }));

    const runtime: DaemonManifestDomainProjection["runtime_deployment"] = {
      agent_id: agentId,
      deployment_id: nullableString(row.deployment_id),
      run_id: nullableString(row.run_id),
      observed_state: String(row.observed_state) as DaemonManifestEntry["observed_state"],
      ...(bool(row.workspace_path_present) ? { workspace_path: nullableString(row.workspace_path) } : {}),
      ...(bool(row.work_attempt_id_present) ? { work_attempt_id: nullableString(row.work_attempt_id) } : {}),
      ...(bool(row.provider_ref_present) ? { provider_ref: providerRef ?? null } : {}),
      ...(bool(row.workplace_liveness_present) ? { workplace_liveness: { state: String(row.workplace_liveness_state) as "reachable" | "stale" | "unknown", observed_at: nullableString(row.workplace_liveness_observed_at), detail: nullableString(row.workplace_liveness_detail) } } : {}),
      ...(bool(row.native_liveness_present) ? { native_liveness: { state: String(row.native_liveness_state) as "active" | "idle" | "stale" | "terminal" | "unknown", observed_at: nullableString(row.native_liveness_observed_at), detail: nullableString(row.native_liveness_detail) } } : {}),
      ...(bool(row.activity_present) ? { activity } : {}),
    };
    let turn: DaemonTurnControlEffect | null | undefined;
    if (bool(row.turn_control_present)) turn = row.action_id === null ? null : {
      action_id: String(row.action_id), action_sequence: Number(row.action_sequence), work_attempt_id: String(row.turn_work_attempt_id),
      execution_generation_id: String(row.turn_execution_generation_id), has_correction: bool(row.has_correction),
      ...(nullableString(row.target_room_id) ? { target_room_id: nullableString(row.target_room_id) } : {}),
      ...(nullableString(row.target_source_message_id) ? { target_source_message_id: nullableString(row.target_source_message_id) } : {}),
      ...(nullableString(row.target_provider_continuation_id) ? { target_provider_continuation_id: nullableString(row.target_provider_continuation_id) } : {}),
      ...(nullableString(row.inbox_item_id) ? { inbox_item_id: nullableString(row.inbox_item_id) } : {}),
      ...(nullableString(row.provider_turn_id) ? { provider_turn_id: nullableString(row.provider_turn_id) } : {}),
      ...(nullableString(row.correction_text) ? { correction_text: nullableString(row.correction_text) } : {}),
      ...(nullableString(row.correction_strategy) ? { correction_strategy: nullableString(row.correction_strategy) as "native" | "stop_then_resend" } : {}),
      ...(nullableString(row.operator_resolution) ? { operator_resolution: nullableString(row.operator_resolution) as "applied" | "not_applied" } : {}),
      status: String(row.turn_status) as DaemonTurnControlEffect["status"], capability: String(row.capability) as DaemonTurnControlEffect["capability"],
      interrupted: row.interrupted === null ? null : bool(row.interrupted), resumed: row.resumed === null ? null : bool(row.resumed),
      state: row.turn_state === null ? null : String(row.turn_state) as "idle" | "working", stages,
      error: nullableString(row.turn_error), recorded_at: String(row.recorded_at), updated_at: String(row.updated_at),
    };
    let reconciliation: ReconciliationState | undefined;
    if (bool(row.reconciliation_present)) reconciliation = {
      exit_timestamps_ms: exitTimestamps,
      consecutive_action_failures: Number(row.consecutive_action_failures),
      last_observed_state: String(row.last_observed_state) as ReconciliationState["last_observed_state"],
      next_restart_at_ms: nullableNumber(row.next_restart_at_ms), completed_action_ids: completedActions,
      last_action_sequence: Number(row.last_action_sequence),
      pending_action: row.pending_action_id === null ? null : { id: String(row.pending_action_id), sequence: Number(row.pending_action_sequence), kind: String(row.pending_action_kind) as "poke" | "restart_fresh" | "restart_with_resume" | "stop", recorded_at_ms: Number(row.pending_action_recorded_at_ms) },
      ...(bool(row.last_terminal_present) ? { last_terminal: this.terminalFromRow(row, "terminal_") } : {}),
    };
    return {
      identity: { agent_id: agentId, created_by: String(row.created_by), created_at: String(row.created_at) },
      profile: { agent_id: agentId, display_name: String(row.display_name) },
      membership: { agent_id: agentId, room_id: String(row.room_id), ...(row.local_room_id == null ? {} : { local_room_id: String(row.local_room_id) }) },
      configuration: { agent_id: agentId, provider: String(row.provider), model: nullableString(row.model), reasoning_effort: nullableString(row.reasoning_effort) as DaemonAgentConfiguration["reasoning_effort"], charter: String(row.charter), permission_profile_id: nullableString(row.permission_profile_id), config_revision: Number(row.config_revision), runtime_configuration_revision: Number(row.runtime_configuration_revision), ...(row.delivery_mode !== "mcp_polling" ? { delivery_mode: String(row.delivery_mode) as DaemonManifestEntry["delivery_mode"] } : {}), ...(row.delivery_cutover_json === null ? {} : { delivery_cutover: parseJson(row.delivery_cutover_json) }), ...(bool(row.provider_launch_policy_present) ? { provider_launch_policy: bool(row.provider_launch_policy_undefined) ? undefined : parseJson(row.provider_launch_policy_json) } : {}) },
      launch_intent: { agent_id: agentId, desired_state: String(row.desired_state) as DaemonManifestEntry["desired_state"], ...(bool(row.source_repo_path_present) ? { source_repo_path: nullableString(row.source_repo_path) } : {}) },
      runtime_deployment: runtime,
      lifecycle: { agent_id: agentId, condition: String(row.condition) as DaemonManifestEntry["condition"], ...(bool(row.last_error_present) ? { last_error: nullableString(row.last_error) } : {}) },
      readiness: { agent_id: agentId, ...(bool(row.ready_reached_at_present) ? { ready_reached_at: nullableString(row.ready_reached_at) } : {}) },
      turn_control_journal: { agent_id: agentId, last_turn_control_sequence: Number(row.last_turn_control_sequence), ...(bool(row.turn_control_present) ? { turn_control: turn ?? null } : {}) },
      retained_worker_binding: { agent_id: agentId, ...(bool(row.last_worker_binding_present) ? { last_worker_binding: row.binding_agent_session_id === null ? null : { agent_session_id: String(row.binding_agent_session_id), work_attempt_id: String(row.binding_work_attempt_id), execution_generation_id: String(row.binding_execution_generation_id), updated_at: String(row.binding_updated_at) } } : {}) },
      reconciliation: { agent_id: agentId, ...(bool(row.reconciliation_present) ? { reconciliation } : {}), ...(bool(row.reconciliation_notices_present) ? { reconciliation_notices: notices } : {}) },
    };
  }

  terminalFromRow(row: Row, prefix: string): ExecutionTerminalPayload {
    return {
      ended_at: String(row[`${prefix}ended_at`]), exit_code: nullableNumber(row[`${prefix}exit_code`]),
      signal: nullableString(row[`${prefix}signal`]), stdio_archive_ref: nullableString(row[`${prefix}stdio_archive_ref`]),
      stdio_tail: String(row[`${prefix}stdio_tail`]), terminal_cause: String(row[`${prefix}cause`]),
      actor: String(row[`${prefix}actor`]), generation: Number(row[`${prefix}generation`]),
      provider_continuation_id: nullableString(row[`${prefix}provider_continuation_id`]),
    };
  }

  /**
   * A lifecycle stop/pause or exact runtime replacement may cancel a room move
   * only before destination join starts. The move, its MCP effect, the
   * lifecycle/runtime manifest mutation, and retention release share the
   * caller's BEGIN IMMEDIATE transaction. Later phases have possible external
   * membership effects and therefore block the lifecycle edge until ordinary
   * reconciliation reaches active/failed or compensates them.
   */
  failPreMembershipRoomMoves(
    database: DatabaseSync,
    input: PreMembershipRoomMoveCancellation,
  ): void {
    const moves = database.prepare(`SELECT * FROM agent_room_moves
      WHERE agent_id=? AND phase NOT IN ('active','failed') ORDER BY created_at`)
      .all(input.agentId) as Row[];
    if (moves.some((row) => !["prepared", "waiting_for_current_turn"].includes(String(row.phase)))) {
      throw new ManifestConflictError(
        "Agent lifecycle or runtime recovery is blocked while a room move may have changed destination membership.",
      );
    }
    if (moves.length === 0) return;
    const runtime = database.prepare(`SELECT
      m.room_id,
      d.work_attempt_id_present,
      d.work_attempt_id,
      d.provider_ref_present,
      d.provider_execution_generation_id
      FROM agent_room_memberships m
      JOIN runtime_deployments d USING(agent_id)
      WHERE m.agent_id=?`).get(input.agentId) as Row | undefined;
    if (!runtime) {
      throw new ManifestConflictError("Pre-membership room-move cancellation lost its exact agent runtime.");
    }
    const timestamp = new Date().toISOString();
    const updateMove = database.prepare(`UPDATE agent_room_moves
      SET phase='failed',error=?,updated_at=?
      WHERE operation_id=? AND agent_id=? AND phase IN ('prepared','waiting_for_current_turn')`);
    const updateEffect = database.prepare(`UPDATE supervised_agent_effects
      SET state='failed',error=?,updated_at=?
      WHERE effect_id=? AND agent_id=? AND room_id=?
        AND execution_generation_id=? AND provider_turn_id=?
        AND tool_name='join_room' AND state='prepared'`);
    for (const row of moves) {
      const sourceRoomId = String(row.source_room_id);
      const workAttemptId = nullableString(row.work_attempt_id);
      const executionGenerationId = nullableString(row.execution_generation_id);
      if (String(runtime.room_id) !== sourceRoomId
        || !bool(runtime.work_attempt_id_present)
        || nullableString(runtime.work_attempt_id) !== workAttemptId
        || !bool(runtime.provider_ref_present)
        || nullableString(runtime.provider_execution_generation_id) !== executionGenerationId
        || workAttemptId === null || executionGenerationId === null) {
        throw new ManifestConflictError("Pre-membership room move no longer matches the exact source runtime.");
      }

      const effectId = nullableString(row.effect_id);
      const activatingInboxItemId = nullableString(row.activating_inbox_item_id);
      const providerTurnId = nullableString(row.provider_turn_id);
      const mediated = effectId !== null || activatingInboxItemId !== null || providerTurnId !== null;
      if (mediated) {
        if (effectId === null || activatingInboxItemId === null || providerTurnId === null) {
          throw new ManifestConflictError("Pre-membership room move has incomplete mediated-turn authority.");
        }
        const authority = database.prepare(`SELECT
          i.agent_id AS inbox_agent_id,
          i.room_id AS inbox_room_id,
          i.provider_turn_id AS inbox_provider_turn_id,
          b.agent_id AS binding_agent_id,
          b.room_id AS binding_room_id,
          b.work_attempt_id AS binding_work_attempt_id,
          b.origin_execution_generation_id,
          b.provider_turn_id AS binding_provider_turn_id
          FROM supervised_agent_inbox i
          JOIN supervised_agent_provider_turn_bindings b USING(inbox_item_id)
          WHERE i.inbox_item_id=?`).get(activatingInboxItemId) as Row | undefined;
        if (!authority
          || String(authority.inbox_agent_id) !== input.agentId
          || String(authority.binding_agent_id) !== input.agentId
          || String(authority.inbox_room_id) !== sourceRoomId
          || String(authority.binding_room_id) !== sourceRoomId
          || nullableString(authority.inbox_provider_turn_id) !== providerTurnId
          || String(authority.binding_provider_turn_id) !== providerTurnId
          || String(authority.binding_work_attempt_id) !== workAttemptId) {
          throw new ManifestConflictError("Pre-membership room move is detached from its exact activating provider turn.");
        }
        const originExecutionGenerationId = String(authority.origin_execution_generation_id);
        const effect = database.prepare(`SELECT agent_id,room_id,execution_generation_id,provider_turn_id,tool_name,state
          FROM supervised_agent_effects WHERE effect_id=?`).get(effectId) as Row | undefined;
        if (!effect
          || String(effect.agent_id) !== input.agentId
          || String(effect.room_id) !== sourceRoomId
          || String(effect.execution_generation_id) !== originExecutionGenerationId
          || String(effect.provider_turn_id) !== providerTurnId
          || String(effect.tool_name) !== "join_room"
          || !["prepared", "failed"].includes(String(effect.state))) {
          throw new ManifestConflictError("Pre-membership room move is detached from its exact unresolved effect journal.");
        }
        if (String(effect.state) === "prepared") {
          const effectChanged = updateEffect.run(
            input.detail,
            timestamp,
            effectId,
            input.agentId,
            sourceRoomId,
            originExecutionGenerationId,
            providerTurnId,
          );
          if (Number(effectChanged.changes) !== 1) {
            throw new ManifestConflictError("Pre-membership room-move effect changed during lifecycle cancellation.");
          }
        }
      }
      const changed = updateMove.run(input.detail, timestamp, String(row.operation_id), input.agentId);
      if (Number(changed.changes) !== 1) {
        throw new ManifestConflictError("Pre-membership room-move phase changed during lifecycle cancellation.");
      }
    }
    pruneSupervisedAgentHistory(database, input.agentId, () => timestamp);
  }

  /** Journal-first transaction helper. A manifest projection must perform its
   * generation CAS inside the mutation so the projection and journal settle together. */
  writeOperationalJournal<T>(mutation: (database: DatabaseSync) => T, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<T> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      let open = false;
      let committed = false;
      let value!: T;
      try {
        const commit = async () => {
          if (committed) throw new Error("Operational journal transaction was already committed.");
          database.exec("BEGIN IMMEDIATE");
          open = true;
          value = mutation(database);
          database.exec("COMMIT");
          open = false;
          committed = true;
        };
        if (commitFence) await commitFence(commit);
        else await commit();
        if (!committed) throw new Error("Operational journal fence returned without committing the transaction.");
        return value;
      } catch (error) {
        if (open) { try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ } }
        throw error;
      }
    });
  }

  writeTargeted<T>(
    expectedGeneration: number,
    mutation: (database: DatabaseSync) => T,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; value: T }> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      let committed = false;
      let transactionOpen = false;
      let value!: T;
      try {
        const commit = async () => {
          if (committed) throw new Error("Manifest transaction was already committed.");
          database.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
          const result = database.prepare(`
            UPDATE manifest_metadata SET generation = generation + 1
            WHERE singleton = 1 AND generation = ?
          `).run(expectedGeneration);
          if (Number(result.changes) !== 1) {
            const current = Number((this.reads.get(database, "generation").get() as Row).generation);
            throw new ManifestConflictError(`Manifest generation ${current} does not match expected ${expectedGeneration}.`);
          }
          value = mutation(database);
          database.exec("COMMIT");
          transactionOpen = false;
          committed = true;
        };
        if (commitFence) await commitFence(commit);
        else await commit();
        if (!committed) throw new Error("Manifest commit fence returned without committing the transaction.");
        return { generation: expectedGeneration + 1, value };
      } catch (error) {
        if (transactionOpen) {
          try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
        }
        throw error;
      }
    });
  }

  async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writes;
    let release!: () => void;
    this.writes = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async secureDatabaseFiles(): Promise<void> {
    const paths = [this.path, `${this.path}-wal`, `${this.path}-shm`];
    if (this.permissionHousekeeping) {
      await this.permissionHousekeeping(paths);
      return;
    }
    for (const path of paths) {
      await chmod(path, 0o600).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}

// Each concern module holds part of the methods; merge their types here and
// install them as non-enumerable prototype methods, exactly as class methods.
type EntryReadsMethods = typeof entryReads;
type ApprovalsMethods = typeof approvals;
type DeliveryAndPollingMethods = typeof deliveryAndPolling;
type RoomMovesAndPurgesMethods = typeof roomMovesAndPurges;
type EntriesAndRecoveryMethods = typeof entriesAndRecovery;
type TurnControlMethods = typeof turnControl;
type CursorTurnsMethods = typeof cursorTurns;
type ActivityMethods = typeof activity;
export interface ManifestStore extends EntryReadsMethods, ApprovalsMethods, DeliveryAndPollingMethods, RoomMovesAndPurgesMethods, EntriesAndRecoveryMethods, TurnControlMethods, CursorTurnsMethods, ActivityMethods {}
for (const methods of [entryReads, approvals, deliveryAndPolling, roomMovesAndPurges, entriesAndRecovery, turnControl, cursorTurns, activity]) {
  for (const [name, value] of Object.entries(methods)) {
    // Two modules defining one name would silently keep the later definition.
    if (name in ManifestStore.prototype) throw new Error(`ManifestStore method ${name} is defined twice.`);
    Object.defineProperty(ManifestStore.prototype, name, { value, writable: true, configurable: true, enumerable: false });
  }
}
