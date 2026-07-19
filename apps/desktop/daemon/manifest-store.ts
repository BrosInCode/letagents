import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { chmod, mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import {
  composeDaemonManifestEntry,
  projectDaemonManifestEntry,
  type DaemonManifestDomainProjection,
} from "./manifest-entry-projection.js";
import type {
  DaemonActivityEvent,
  DaemonManifest,
  DaemonManifestEntry,
  DaemonProviderConnection,
  DaemonProviderRuntimeReference,
  DaemonTurnControlEffect,
  ExecutionTerminalPayload,
  LegacyLaneOwner,
  ReconciliationNotice,
  ReconciliationState,
} from "./types.js";

type StoredManifest = { manifest: DaemonManifest; checksum: string };
type Row = Record<string, unknown>;

const SCHEMA_VERSION = 1;

export class ManifestConflictError extends Error {}

function checksum(manifest: DaemonManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("SQLite manifest JSON payloads must be JSON-serializable.");
  return encoded;
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function run(statement: StatementSync, ...values: unknown[]): void {
  statement.run(...values as never[]);
}

/**
 * SQLite-backed durable state for the daemon's compatibility manifest.
 *
 * The flat manifest entry remains the control-socket contract only. Each row is
 * decomposed into records with distinct ownership before persistence, and reads
 * recompose the same flat projection for existing callers.
 */
export class ManifestStore {
  private database: DatabaseSync | null = null;
  private initializing: Promise<DatabaseSync> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    readonly path: string,
    private readonly legacyJsonPath?: string,
  ) {}

  async load(): Promise<DaemonManifest> {
    const database = await this.getDatabase();
    const generation = Number((database.prepare("SELECT generation FROM manifest_metadata WHERE singleton = 1").get() as Row).generation);
    const entries = (database.prepare(`
      SELECT
        i.agent_id, i.created_by, i.created_at,
        p.display_name, m.room_id,
        c.provider, c.model, c.charter, c.permission_profile_id,
        c.provider_launch_policy_present, c.provider_launch_policy_undefined, c.provider_launch_policy_json,
        l.desired_state, l.source_repo_path_present, l.source_repo_path,
        d.deployment_id, d.run_id, d.observed_state,
        d.workspace_path_present, d.workspace_path,
        d.work_attempt_id_present, d.work_attempt_id,
        d.provider_ref_present, d.provider_work_attempt_id, d.provider_continuation_id,
        d.provider_connection_kind, d.provider_connection_url, d.provider_connection_pid,
        d.provider_process_identity_present,
        d.provider_process_identity, d.provider_execution_generation_id,
        d.workplace_liveness_present, d.workplace_liveness_state,
        d.workplace_liveness_observed_at, d.workplace_liveness_detail,
        d.native_liveness_present, d.native_liveness_state,
        d.native_liveness_observed_at, d.native_liveness_detail,
        d.activity_present,
        s.condition, s.last_error_present, s.last_error,
        r.ready_reached_at_present, r.ready_reached_at,
        t.turn_control_present, t.action_id, t.turn_work_attempt_id,
        t.turn_execution_generation_id, t.has_correction, t.status AS turn_status,
        t.capability, t.interrupted, t.resumed, t.turn_state, t.error AS turn_error,
        t.recorded_at, t.updated_at,
        b.last_worker_binding_present, b.binding_agent_session_id,
        b.binding_work_attempt_id, b.binding_execution_generation_id, b.binding_updated_at,
        q.reconciliation_present, q.consecutive_action_failures,
        q.last_observed_state, q.next_restart_at_ms, q.last_action_sequence,
        q.pending_action_id, q.pending_action_sequence, q.pending_action_kind,
        q.pending_action_recorded_at_ms, q.last_terminal_present,
        q.terminal_ended_at, q.terminal_exit_code, q.terminal_signal,
        q.terminal_stdio_archive_ref, q.terminal_stdio_tail, q.terminal_cause,
        q.terminal_actor, q.terminal_generation, q.terminal_provider_continuation_id,
        q.reconciliation_notices_present
      FROM agent_identities i
      JOIN agent_profiles p USING (agent_id)
      JOIN agent_room_memberships m USING (agent_id)
      JOIN agent_configurations c USING (agent_id)
      JOIN agent_launch_intents l USING (agent_id)
      JOIN runtime_deployments d USING (agent_id)
      JOIN agent_lifecycle_states s USING (agent_id)
      JOIN agent_readiness r USING (agent_id)
      JOIN turn_control_journals t USING (agent_id)
      JOIN retained_worker_bindings b USING (agent_id)
      JOIN reconciliation_records q USING (agent_id)
      ORDER BY i.sort_order
    `).all() as Row[]).map((row) => composeDaemonManifestEntry(this.projectionFromRow(database, row)));

    const legacyLaneOwners = (database.prepare(`
      SELECT reservation_id, room_id, provider, owner_pid, owner_process_identity,
             state, session_id, created_at, updated_at
      FROM legacy_lane_owners ORDER BY sort_order
    `).all() as Row[]).map((row): LegacyLaneOwner => ({
      reservation_id: String(row.reservation_id),
      room_id: String(row.room_id),
      provider: String(row.provider),
      owner_pid: Number(row.owner_pid),
      owner_process_identity: String(row.owner_process_identity),
      state: String(row.state) as LegacyLaneOwner["state"],
      session_id: nullableString(row.session_id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }));

    return legacyLaneOwners.length
      ? { generation, entries, legacy_lane_owners: legacyLaneOwners }
      : { generation, entries };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
    await this.initializing?.catch(() => undefined);
    this.database?.close();
    this.database = null;
    this.initializing = null;
  }

  async write(
    expectedGeneration: number,
    entries: DaemonManifest["entries"],
    legacyLaneOwners?: DaemonManifest["legacy_lane_owners"],
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<DaemonManifest> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      const owners = legacyLaneOwners ?? this.readLegacyLaneOwners(database);
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
            const current = Number((database.prepare("SELECT generation FROM manifest_metadata WHERE singleton = 1").get() as Row).generation);
            throw new ManifestConflictError(`Manifest generation ${current} does not match expected ${expectedGeneration}.`);
          }
          this.replaceEntries(database, entries);
          this.replaceLegacyLaneOwners(database, owners ?? []);
          database.exec("COMMIT");
          transactionOpen = false;
          committed = true;
        };
        if (commitFence) await commitFence(commit);
        else await commit();
        if (!committed) throw new Error("Manifest commit fence returned without committing the transaction.");
        await this.secureDatabaseFiles();

        const manifest: DaemonManifest = owners?.length
          ? { generation: expectedGeneration + 1, entries, legacy_lane_owners: owners }
          : { generation: expectedGeneration + 1, entries };
        return manifest;
      } catch (error) {
        if (transactionOpen) {
          try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
        }
        throw error;
      }
    });
  }

  private async getDatabase(): Promise<DatabaseSync> {
    if (this.closed) throw new Error("ManifestStore is closed.");
    if (this.database) return this.database;
    if (!this.initializing) this.initializing = this.initialize();
    return this.initializing;
  }

  private async initialize(): Promise<DatabaseSync> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const database = new DatabaseSync(this.path);
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      const journalMode = String((database.prepare("PRAGMA journal_mode").get() as Row).journal_mode);
      if (journalMode.toLowerCase() !== "wal") database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA synchronous = FULL");
      this.createSchema(database);
      await this.secureDatabaseFiles();
      await this.importLegacyManifest(database);
      this.database = database;
      return database;
    } catch (error) {
      database.close();
      this.initializing = null;
      throw error;
    }
  }

  private createSchema(database: DatabaseSync): void {
    const existingVersion = Number((database.prepare("PRAGMA user_version").get() as Row).user_version);
    if (existingVersion !== 0 && existingVersion !== SCHEMA_VERSION) {
      throw new Error(`Unsupported daemon state schema version ${existingVersion}.`);
    }
    if (existingVersion === SCHEMA_VERSION) {
      const metadata = database.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as Row | undefined;
      const metadataVersion = Number(metadata?.schema_version);
      if (metadataVersion !== SCHEMA_VERSION) throw new Error(`Unsupported daemon manifest metadata schema version ${metadataVersion}.`);
      return;
    }
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
    if (existingVersion === 0) database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    const version = Number((database.prepare("PRAGMA user_version").get() as Row).user_version);
    if (version !== SCHEMA_VERSION) throw new Error(`Unsupported daemon state schema version ${version}.`);
    const metadataVersion = Number((database.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as Row).schema_version);
    if (metadataVersion !== SCHEMA_VERSION) throw new Error(`Unsupported daemon manifest metadata schema version ${metadataVersion}.`);
  }

  private async importLegacyManifest(database: DatabaseSync): Promise<void> {
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
      const current = Number((database.prepare("SELECT generation FROM manifest_metadata WHERE singleton = 1").get() as Row).generation);
      const count = Number((database.prepare("SELECT COUNT(*) AS count FROM agent_identities").get() as Row).count);
      if (current !== 0 || count !== 0) throw new Error("Refusing to import a legacy manifest into non-empty daemon state.");
      this.replaceEntries(database, stored.manifest.entries);
      this.replaceLegacyLaneOwners(database, stored.manifest.legacy_lane_owners ?? []);
      run(database.prepare("UPDATE manifest_metadata SET generation = ? WHERE singleton = 1"), stored.manifest.generation);
      run(database.prepare("INSERT INTO migration_records(migration_key, checksum, imported_at) VALUES (?, ?, ?)"), migrationKey, stored.checksum, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
      throw error;
    }
    await this.secureDatabaseFiles();
    await this.retainLegacyBackup(stored.checksum);
  }

  private async retainLegacyBackup(expectedChecksum: string): Promise<void> {
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

  private replaceEntries(database: DatabaseSync, entries: DaemonManifestEntry[]): void {
    database.exec("DELETE FROM agent_identities");
    entries.forEach((entry, index) => this.insertProjection(database, projectDaemonManifestEntry(entry), index));
  }

  private insertProjection(database: DatabaseSync, projection: DaemonManifestDomainProjection, sortOrder: number): void {
    const { identity, profile, membership, configuration, launch_intent: launch, runtime_deployment: runtime, lifecycle, readiness, turn_control_journal: turnJournal, retained_worker_binding: bindingRecord, reconciliation: reconciliationRecord } = projection;
    run(database.prepare("INSERT INTO agent_identities VALUES (?, ?, ?, ?)"), identity.agent_id, identity.created_by, identity.created_at, sortOrder);
    run(database.prepare("INSERT INTO agent_profiles VALUES (?, ?)"), identity.agent_id, profile.display_name);
    run(database.prepare("INSERT INTO agent_room_memberships VALUES (?, ?)"), identity.agent_id, membership.room_id);
    const policyPresent = Object.hasOwn(configuration, "provider_launch_policy");
    const policyUndefined = policyPresent && configuration.provider_launch_policy === undefined;
    run(database.prepare("INSERT INTO agent_configurations VALUES (?, ?, ?, ?, ?, ?, ?, ?)"), identity.agent_id, configuration.provider, configuration.model, configuration.charter, configuration.permission_profile_id, Number(policyPresent), Number(policyUndefined), policyPresent && !policyUndefined ? json(configuration.provider_launch_policy) : null);
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
    run(database.prepare(`INSERT INTO runtime_deployments VALUES (${Array.from({ length: 26 }, () => "?").join(", ")})`),
      identity.agent_id, runtime.deployment_id, runtime.run_id, runtime.observed_state,
      Number(workspacePresent), workspacePresent ? runtime.workspace_path ?? null : null,
      Number(attemptPresent), attemptPresent ? runtime.work_attempt_id ?? null : null,
      Number(providerPresent), providerRef?.work_attempt_id ?? null, providerRef?.provider_continuation_id ?? null,
      connection?.kind ?? null, connection?.kind === "codex_app_server" ? connection.url : null,
      connection?.pid ?? null, Number(processIdentityPresent), connection?.processIdentity ?? null,
      providerRef?.execution_generation_id ?? null,
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
    run(database.prepare(`INSERT INTO turn_control_journals VALUES (${Array.from({ length: 14 }, () => "?").join(", ")})`),
      identity.agent_id, Number(turnPresent), turn?.action_id ?? null, turn?.work_attempt_id ?? null,
      turn?.execution_generation_id ?? null, turn ? Number(turn.has_correction) : null,
      turn?.status ?? null, turn?.capability ?? null,
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
    run(database.prepare(`INSERT INTO reconciliation_records VALUES (${Array.from({ length: 21 }, () => "?").join(", ")})`),
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
    const insertAction = database.prepare("INSERT INTO reconciliation_completed_actions VALUES (?, ?, ?)");
    (state?.completed_action_ids ?? []).forEach((actionId, index) => run(insertAction, identity.agent_id, index, actionId));
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

  private projectionFromRow(database: DatabaseSync, row: Row): DaemonManifestDomainProjection {
    const agentId = String(row.agent_id);
    let providerRef: DaemonProviderRuntimeReference | null | undefined;
    if (bool(row.provider_ref_present)) {
      if (row.provider_execution_generation_id === null) providerRef = null;
      else {
        let providerConnection: DaemonProviderConnection | null = null;
        if (row.provider_connection_kind === "codex_app_server") providerConnection = { kind: "codex_app_server", url: String(row.provider_connection_url), pid: nullableNumber(row.provider_connection_pid), ...(bool(row.provider_process_identity_present) ? { processIdentity: nullableString(row.provider_process_identity) } : {}) };
        else if (row.provider_connection_kind === "claude_cli") providerConnection = { kind: "claude_cli", pid: nullableNumber(row.provider_connection_pid), ...(bool(row.provider_process_identity_present) ? { processIdentity: nullableString(row.provider_process_identity) } : {}) };
        else if (row.provider_connection_kind === "cursor_cli") providerConnection = { kind: "cursor_cli", pid: nullableNumber(row.provider_connection_pid), ...(bool(row.provider_process_identity_present) ? { processIdentity: nullableString(row.provider_process_identity) } : {}) };
        providerRef = {
          work_attempt_id: String(row.provider_work_attempt_id),
          provider_continuation_id: String(row.provider_continuation_id),
          provider_connection: providerConnection,
          execution_generation_id: String(row.provider_execution_generation_id),
        };
      }
    }
    const activity = (database.prepare("SELECT * FROM activity_events WHERE agent_id = ? ORDER BY sort_order").all(agentId) as Row[]).map((event): DaemonActivityEvent => ({
      observed_at: String(event.observed_at), sequence: Number(event.sequence), provider: String(event.provider),
      kind: String(event.kind), method: String(event.method), summary: String(event.summary),
      status: String(event.status) as DaemonActivityEvent["status"], payload: parseJson(event.payload_json),
      payload_truncated: bool(event.payload_truncated), payload_redacted: bool(event.payload_redacted),
      durable_payload_ref: nullableString(event.durable_payload_ref),
    }));
    const stages = (database.prepare("SELECT stage FROM turn_control_stages WHERE agent_id = ? ORDER BY sort_order").all(agentId) as Row[]).map((stage) => String(stage.stage)) as DaemonTurnControlEffect["stages"];
    const completedActions = (database.prepare("SELECT action_id FROM reconciliation_completed_actions WHERE agent_id = ? ORDER BY sort_order").all(agentId) as Row[]).map((action) => String(action.action_id));
    const exitTimestamps = (database.prepare("SELECT timestamp_ms FROM reconciliation_exit_timestamps WHERE agent_id = ? ORDER BY sort_order").all(agentId) as Row[]).map((item) => Number(item.timestamp_ms));
    const notices = (database.prepare("SELECT * FROM reconciliation_notices WHERE agent_id = ? ORDER BY sort_order").all(agentId) as Row[]).map((notice): ReconciliationNotice => ({
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
      action_id: String(row.action_id), work_attempt_id: String(row.turn_work_attempt_id),
      execution_generation_id: String(row.turn_execution_generation_id), has_correction: bool(row.has_correction),
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
      membership: { agent_id: agentId, room_id: String(row.room_id) },
      configuration: { agent_id: agentId, provider: String(row.provider), model: nullableString(row.model), charter: String(row.charter), permission_profile_id: nullableString(row.permission_profile_id), ...(bool(row.provider_launch_policy_present) ? { provider_launch_policy: bool(row.provider_launch_policy_undefined) ? undefined : parseJson(row.provider_launch_policy_json) } : {}) },
      launch_intent: { agent_id: agentId, desired_state: String(row.desired_state) as DaemonManifestEntry["desired_state"], ...(bool(row.source_repo_path_present) ? { source_repo_path: nullableString(row.source_repo_path) } : {}) },
      runtime_deployment: runtime,
      lifecycle: { agent_id: agentId, condition: String(row.condition) as DaemonManifestEntry["condition"], ...(bool(row.last_error_present) ? { last_error: nullableString(row.last_error) } : {}) },
      readiness: { agent_id: agentId, ...(bool(row.ready_reached_at_present) ? { ready_reached_at: nullableString(row.ready_reached_at) } : {}) },
      turn_control_journal: { agent_id: agentId, ...(bool(row.turn_control_present) ? { turn_control: turn ?? null } : {}) },
      retained_worker_binding: { agent_id: agentId, ...(bool(row.last_worker_binding_present) ? { last_worker_binding: row.binding_agent_session_id === null ? null : { agent_session_id: String(row.binding_agent_session_id), work_attempt_id: String(row.binding_work_attempt_id), execution_generation_id: String(row.binding_execution_generation_id), updated_at: String(row.binding_updated_at) } } : {}) },
      reconciliation: { agent_id: agentId, ...(bool(row.reconciliation_present) ? { reconciliation } : {}), ...(bool(row.reconciliation_notices_present) ? { reconciliation_notices: notices } : {}) },
    };
  }

  private terminalFromRow(row: Row, prefix: string): ExecutionTerminalPayload {
    return {
      ended_at: String(row[`${prefix}ended_at`]), exit_code: nullableNumber(row[`${prefix}exit_code`]),
      signal: nullableString(row[`${prefix}signal`]), stdio_archive_ref: nullableString(row[`${prefix}stdio_archive_ref`]),
      stdio_tail: String(row[`${prefix}stdio_tail`]), terminal_cause: String(row[`${prefix}cause`]),
      actor: String(row[`${prefix}actor`]), generation: Number(row[`${prefix}generation`]),
      provider_continuation_id: nullableString(row[`${prefix}provider_continuation_id`]),
    };
  }

  private readLegacyLaneOwners(database: DatabaseSync): LegacyLaneOwner[] {
    return (database.prepare("SELECT * FROM legacy_lane_owners ORDER BY sort_order").all() as Row[]).map((row) => ({
      reservation_id: String(row.reservation_id), room_id: String(row.room_id), provider: String(row.provider),
      owner_pid: Number(row.owner_pid), owner_process_identity: String(row.owner_process_identity),
      state: String(row.state) as LegacyLaneOwner["state"], session_id: nullableString(row.session_id),
      created_at: String(row.created_at), updated_at: String(row.updated_at),
    }));
  }

  private replaceLegacyLaneOwners(database: DatabaseSync, owners: LegacyLaneOwner[]): void {
    database.exec("DELETE FROM legacy_lane_owners");
    const insert = database.prepare("INSERT INTO legacy_lane_owners VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    owners.forEach((owner, index) => run(insert, owner.reservation_id, owner.room_id, owner.provider, owner.owner_pid, owner.owner_process_identity, owner.state, owner.session_id, owner.created_at, owner.updated_at, index));
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writes;
    let release!: () => void;
    this.writes = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async secureDatabaseFiles(): Promise<void> {
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      await chmod(path, 0o600).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}
