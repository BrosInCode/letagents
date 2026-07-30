import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { chmod, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { DaemonStateSchema, openDaemonStateDatabase } from "./daemon-state-database.js";

import {
  composeDaemonManifestEntry,
  projectDaemonManifestEntry,
  type DaemonManifestDomainProjection,
} from "./manifest-entry-projection.js";
import type {
  DaemonActivityEvent,
  DaemonAgentConfiguration,
  DaemonManifest,
  DaemonManifestEntry,
  DaemonProviderConnection,
  DaemonProviderRuntimeReference,
  DaemonPurgePhase,
  DaemonPurgeRecord,
  DaemonPurgeWorkerSessionAttestation,
  DaemonRoomMovePhase,
  DaemonRoomMoveRecord,
  DaemonTurnControlEffect,
  ExecutionTerminalPayload,
  LegacyLaneOwner,
  ReconciliationNotice,
  ReconciliationState,
} from "./types.js";

type StoredManifest = { manifest: DaemonManifest; checksum: string };
type Row = Record<string, unknown>;
type StoredAgentConfiguration = { provider: string; model: string | null; reasoning_effort: DaemonAgentConfiguration["reasoning_effort"]; charter: string; permission_profile_id: string | null; provider_launch_policy: unknown; config_revision: number; runtime_configuration_revision: number };

function roomMoveFromRow(row: Row): DaemonRoomMoveRecord {
  return {
    operation_id: String(row.operation_id), request_id: String(row.request_id), agent_id: String(row.agent_id),
    source_room_id: String(row.source_room_id), destination_room_id: String(row.destination_room_id), daemon_generation: Number(row.daemon_generation),
    work_attempt_id: nullableString(row.work_attempt_id), execution_generation_id: nullableString(row.execution_generation_id), agent_session_id: nullableString(row.agent_session_id),
    activating_inbox_item_id: nullableString(row.activating_inbox_item_id), provider_turn_id: nullableString(row.provider_turn_id), effect_id: nullableString(row.effect_id),
    phase: String(row.phase) as DaemonRoomMovePhase, remote_room_id: nullableString(row.remote_room_id), destination_cursor: nullableString(row.destination_cursor),
    source_credentials_revoked: bool(row.source_credentials_revoked),
    source_cursor_present: bool(row.source_cursor_present), source_cursor: nullableString(row.source_cursor),
    error: nullableString(row.error), created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

function purgeFromRow(row: Row): DaemonPurgeRecord {
  return {
    operation_id: String(row.operation_id), request_id: String(row.request_id), agent_id: String(row.agent_id),
    daemon_generation: Number(row.daemon_generation), phase: String(row.phase) as DaemonPurgePhase,
    external_revoke_required: bool(row.external_revoke_required), attached_work_attempt_id: nullableString(row.attached_work_attempt_id),
    preserved_workspace_path: nullableString(row.preserved_workspace_path),
    worker_session_attestation: String(row.worker_session_attestation) as DaemonPurgeWorkerSessionAttestation,
    agent_session_id: nullableString(row.agent_session_id),
    error: nullableString(row.error),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

/**
 * This is the version for the *entire* daemon-state database, not only the
 * manifest projection.  Other durable stores deliberately go through this
 * initializer so two connections cannot race independent user_version owners.
 */
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

function normalizeManifestEntry(entry: DaemonManifestEntry): DaemonManifestEntry {
  return JSON.parse(JSON.stringify(entry)) as DaemonManifestEntry;
}

function canonicalManifestEntry(entry: DaemonManifestEntry): DaemonManifestEntry {
  return composeDaemonManifestEntry(projectDaemonManifestEntry(normalizeManifestEntry(entry)));
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
    private readonly permissionHousekeeping?: (paths: string[]) => Promise<void>,
    private readonly schemaInitializationHook?: (database: DatabaseSync) => void,
  ) {}

  /** Initialise/upgrade the shared daemon database without retaining a handle. */
  static async ensureDatabase(path: string): Promise<void> {
    const store = new ManifestStore(path);
    try { await store.load(); } finally { await store.close(); }
  }

  async load(): Promise<DaemonManifest> {
    const database = await this.getDatabase();
    const generation = Number((database.prepare("SELECT generation FROM manifest_metadata WHERE singleton = 1").get() as Row).generation);
    const entries = (database.prepare(`
      SELECT
        i.agent_id, i.created_by, i.created_at,
        p.display_name, m.room_id,
        c.provider, c.model, c.reasoning_effort, c.charter, c.permission_profile_id, c.config_revision, c.runtime_configuration_revision, c.delivery_mode, c.delivery_cutover_json,
        c.provider_launch_policy_present, c.provider_launch_policy_undefined, c.provider_launch_policy_json,
        l.desired_state, l.source_repo_path_present, l.source_repo_path,
        d.deployment_id, d.run_id, d.observed_state,
        d.workspace_path_present, d.workspace_path,
        d.work_attempt_id_present, d.work_attempt_id,
        d.provider_ref_present, d.provider_work_attempt_id, d.provider_continuation_id,
        d.provider_connection_kind, d.provider_connection_url, d.provider_server_auth_path,
        d.provider_connection_pid,
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
        t.provider_turn_id,
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

  async getEntry(agentId: string): Promise<DaemonManifestEntry | undefined> {
    const database = await this.getDatabase();
    return this.readEntryFromDatabase(database, agentId);
  }

  async getAgentConfiguration(agentId: string): Promise<StoredAgentConfiguration | undefined> {
    const database = await this.getDatabase();
    const row = database.prepare(`SELECT provider,model,reasoning_effort,charter,permission_profile_id,provider_launch_policy_present,provider_launch_policy_undefined,provider_launch_policy_json,config_revision,runtime_configuration_revision FROM agent_configurations WHERE agent_id=?`).get(agentId) as Row | undefined;
    if (!row) return undefined;
    return { provider: String(row.provider), model: nullableString(row.model), reasoning_effort: nullableString(row.reasoning_effort) as DaemonAgentConfiguration["reasoning_effort"], charter: String(row.charter), permission_profile_id: nullableString(row.permission_profile_id), provider_launch_policy: bool(row.provider_launch_policy_present) && !bool(row.provider_launch_policy_undefined) ? parseJson(row.provider_launch_policy_json) : {}, config_revision: Number(row.config_revision), runtime_configuration_revision: Number(row.runtime_configuration_revision) };
  }

  async prepareRoomMove(input: Omit<DaemonRoomMoveRecord, "phase" | "remote_room_id" | "destination_cursor" | "source_credentials_revoked" | "source_cursor_present" | "source_cursor" | "error" | "created_at" | "updated_at"> & { phase: "prepared" | "waiting_for_current_turn" }): Promise<{ created: boolean; move: DaemonRoomMoveRecord }> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const existing = database.prepare("SELECT * FROM agent_room_moves WHERE request_id=?").get(input.request_id) as Row | undefined;
        if (existing) {
          const move = roomMoveFromRow(existing);
          if (move.operation_id !== input.operation_id || move.agent_id !== input.agent_id || move.source_room_id !== input.source_room_id || move.destination_room_id !== input.destination_room_id || move.execution_generation_id !== input.execution_generation_id) throw new Error("Room-move request id is already bound to different coordinates.");
          database.exec("COMMIT");
          return { created: false, move };
        }
        const now = new Date().toISOString();
        const sourceCursor = database.prepare("SELECT last_observed_message_id FROM supervised_agent_ingress_cursors WHERE agent_id=? AND room_id=?")
          .get(input.agent_id, input.source_room_id) as Row | undefined;
        run(database.prepare(`INSERT INTO agent_room_moves(operation_id,request_id,agent_id,source_room_id,destination_room_id,daemon_generation,work_attempt_id,execution_generation_id,agent_session_id,activating_inbox_item_id,provider_turn_id,effect_id,phase,remote_room_id,destination_cursor,error,created_at,updated_at,source_cursor_present,source_cursor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?)`),
          input.operation_id, input.request_id, input.agent_id, input.source_room_id, input.destination_room_id, input.daemon_generation, input.work_attempt_id, input.execution_generation_id, input.agent_session_id, input.activating_inbox_item_id, input.provider_turn_id, input.effect_id, input.phase, now, now,
          sourceCursor ? 1 : 0, sourceCursor?.last_observed_message_id ?? null);
        const row = database.prepare("SELECT * FROM agent_room_moves WHERE operation_id=?").get(input.operation_id) as Row;
        database.exec("COMMIT");
        return { created: true, move: roomMoveFromRow(row) };
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  async getRoomMove(operationId: string): Promise<DaemonRoomMoveRecord | null> {
    const row = (await this.getDatabase()).prepare("SELECT * FROM agent_room_moves WHERE operation_id=?").get(operationId) as Row | undefined;
    return row ? roomMoveFromRow(row) : null;
  }

  async pendingRoomMoves(agentId?: string): Promise<DaemonRoomMoveRecord[]> {
    const database = await this.getDatabase();
    const rows = (agentId
      ? database.prepare("SELECT * FROM agent_room_moves WHERE agent_id=? AND phase NOT IN ('active','failed') ORDER BY created_at").all(agentId)
      : database.prepare("SELECT * FROM agent_room_moves WHERE phase NOT IN ('active','failed') ORDER BY created_at").all()) as Row[];
    return rows.map(roomMoveFromRow);
  }

  async advanceRoomMove(input: { operationId: string; agentId: string; expectedDaemonGeneration: number; expectedExecutionGenerationId: string | null; from: DaemonRoomMovePhase[]; to: DaemonRoomMovePhase; remoteRoomId?: string | null; destinationCursor?: string | null; sourceCredentialsRevoked?: boolean; error?: string | null; adoptDaemonGeneration?: number }): Promise<DaemonRoomMoveRecord> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database.prepare("SELECT * FROM agent_room_moves WHERE operation_id=?").get(input.operationId) as Row | undefined;
        if (!row) throw new Error("Unknown room-move operation.");
        const current = roomMoveFromRow(row);
        if (current.agent_id !== input.agentId || current.daemon_generation !== input.expectedDaemonGeneration || current.execution_generation_id !== input.expectedExecutionGenerationId || !input.from.includes(current.phase)) throw new ManifestConflictError("Room-move phase fence changed.");
        const updatedAt = new Date().toISOString();
        run(database.prepare(`UPDATE agent_room_moves SET phase=?,daemon_generation=?,remote_room_id=COALESCE(?,remote_room_id),destination_cursor=COALESCE(?,destination_cursor),source_credentials_revoked=CASE WHEN ? THEN 1 ELSE source_credentials_revoked END,error=?,updated_at=? WHERE operation_id=?`), input.to, input.adoptDaemonGeneration ?? current.daemon_generation, input.remoteRoomId ?? null, input.destinationCursor ?? null, input.sourceCredentialsRevoked ? 1 : 0, input.error ?? null, updatedAt, input.operationId);
        const updated = database.prepare("SELECT * FROM agent_room_moves WHERE operation_id=?").get(input.operationId) as Row;
        database.exec("COMMIT");
        return roomMoveFromRow(updated);
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  async preparePurge(expectedGeneration: number, input: {
    operationId: string;
    requestId: string;
    agentId: string;
    daemonGeneration: number;
    externalRevokeRequired: boolean;
    workerSessionAttestation: DaemonPurgeWorkerSessionAttestation;
    agentSessionId: string | null;
  }): Promise<{ generation: number; created: boolean; purge: DaemonPurgeRecord }> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const generation = Number((database.prepare("SELECT generation FROM manifest_metadata WHERE singleton=1").get() as Row).generation);
        if (generation !== expectedGeneration) throw new ManifestConflictError("Manifest generation changed before purge preparation.");
        const existing = database.prepare("SELECT * FROM agent_purge_operations WHERE request_id=?").get(input.requestId) as Row | undefined;
        if (existing) {
          const purge = purgeFromRow(existing);
          if (purge.operation_id !== input.operationId || purge.agent_id !== input.agentId
            || purge.worker_session_attestation !== input.workerSessionAttestation
            || purge.agent_session_id !== input.agentSessionId) {
            throw new Error("Purge request id is already bound to another operation or worker session.");
          }
          database.exec("COMMIT");
          return { generation, created: false, purge };
        }
        const attachment = this.assertPurgePreconditions(database, input.agentId);
        const now = new Date().toISOString();
        const phase: DaemonPurgePhase = input.externalRevokeRequired
          ? input.workerSessionAttestation === "unknown" ? "reprepare_credentials" : "revoking_credentials"
          : "local_commit";
        if (!input.externalRevokeRequired && (input.workerSessionAttestation !== "not_required" || input.agentSessionId !== null)) {
          throw new Error("A local-only purge cannot carry worker-session revocation evidence.");
        }
        if (input.externalRevokeRequired
          && !((input.workerSessionAttestation === "exact" && Boolean(input.agentSessionId?.trim()))
            || (input.workerSessionAttestation === "none" && input.agentSessionId === null)
            || (input.workerSessionAttestation === "unknown" && input.agentSessionId === null))) {
          throw new Error("External purge revocation requires exact, none-minted, or recoverable worker-session evidence.");
        }
        run(database.prepare("INSERT INTO agent_purge_operations(operation_id,request_id,agent_id,daemon_generation,phase,external_revoke_required,error,created_at,updated_at,attached_work_attempt_id,preserved_workspace_path,worker_session_attestation,agent_session_id) VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?,?)"),
          input.operationId, input.requestId, input.agentId, input.daemonGeneration, phase, input.externalRevokeRequired ? 1 : 0, now, now,
          attachment.attachedWorkAttemptId, attachment.preservedWorkspacePath, input.workerSessionAttestation, input.agentSessionId ?? null);
        const purge = purgeFromRow(database.prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(input.operationId) as Row);
        database.exec("COMMIT");
        return { generation, created: true, purge };
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  async getPurge(operationId: string): Promise<DaemonPurgeRecord | null> {
    const row = (await this.getDatabase()).prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(operationId) as Row | undefined;
    return row ? purgeFromRow(row) : null;
  }

  async pendingPurges(): Promise<DaemonPurgeRecord[]> {
    return ((await this.getDatabase()).prepare("SELECT * FROM agent_purge_operations WHERE phase IN ('reprepare_credentials','revoking_credentials','local_commit') ORDER BY created_at").all() as Row[]).map(purgeFromRow);
  }

  /**
   * Resolve only durable worker-session evidence. A mint attempt is an
   * irreversible uncertainty boundary until its idempotent remote response is
   * recorded. Exact evidence outranks older explicit-none facts, while
   * conflicting exact ids and legacy omissions fail closed.
   */
  async durablePurgeWorkerSessionAttestation(agentId: string): Promise<{
    workerSessionAttestation: "exact" | "none" | "unknown";
    agentSessionId: string | null;
  }> {
    const database = await this.getDatabase();
    const mint = database.prepare("SELECT phase,agent_session_id FROM supervised_worker_mint_states WHERE agent_id=?")
      .get(agentId) as Row | undefined;
    if (mint?.phase === "minting_unknown") {
      return { workerSessionAttestation: "unknown", agentSessionId: null };
    }
    const ids = new Set<string>();
    const addExact = (value: unknown) => {
      const sessionId = nullableString(value)?.trim();
      if (sessionId) ids.add(sessionId);
    };
    if (mint?.phase === "exact") addExact(mint.agent_session_id);

    const retained = database.prepare("SELECT last_worker_binding_present,binding_agent_session_id FROM retained_worker_bindings WHERE agent_id=?").get(agentId) as Row | undefined;
    if (retained && bool(retained.last_worker_binding_present)) {
      addExact(retained.binding_agent_session_id);
    }
    const current = database.prepare("SELECT agent_session_id FROM supervised_worker_sessions WHERE agent_id=?").get(agentId) as Row | undefined;
    addExact(current?.agent_session_id);
    for (const [table, column] of [
      ["worker_session_bindings", "entry_id"],
      ["worker_binding_publications", "entry_id"],
      ["worker_generation_verifications", "entry_id"],
    ] as const) {
      const rows = database.prepare(`SELECT DISTINCT agent_session_id FROM ${table} WHERE ${column}=?`).all(agentId) as Row[];
      for (const row of rows) addExact(row.agent_session_id);
    }
    if (ids.size === 1) return { workerSessionAttestation: "exact", agentSessionId: [...ids][0]! };
    if (ids.size > 1) return { workerSessionAttestation: "unknown", agentSessionId: null };

    const retainedProvesNone = Boolean(retained && bool(retained.last_worker_binding_present)
      && nullableString(retained.binding_agent_session_id) === null);
    if (retainedProvesNone && mint?.phase === "never_minted") {
      return { workerSessionAttestation: "none", agentSessionId: null };
    }
    return { workerSessionAttestation: "unknown", agentSessionId: null };
  }

  async adoptPurgeDaemonGeneration(input: { operationId: string; agentId: string; expectedDaemonGeneration: number; daemonGeneration: number }): Promise<DaemonPurgeRecord> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database.prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(input.operationId) as Row | undefined;
        if (!row) throw new Error("Unknown purge operation.");
        const purge = purgeFromRow(row);
        if (purge.agent_id !== input.agentId || purge.daemon_generation !== input.expectedDaemonGeneration || !["reprepare_credentials", "revoking_credentials", "local_commit"].includes(purge.phase)) throw new ManifestConflictError("Purge credential-revocation fence changed.");
        run(database.prepare("UPDATE agent_purge_operations SET daemon_generation=?,updated_at=? WHERE operation_id=?"), input.daemonGeneration, new Date().toISOString(), input.operationId);
        const updated = purgeFromRow(database.prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(input.operationId) as Row);
        database.exec("COMMIT");
        return updated;
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  async repreparePurgeCredentials(input: {
    operationId: string;
    agentId: string;
    expectedDaemonGeneration: number;
    workerSessionAttestation: "exact" | "none";
    agentSessionId: string | null;
  }): Promise<DaemonPurgeRecord> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database.prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(input.operationId) as Row | undefined;
        if (!row) throw new Error("Unknown purge operation.");
        const purge = purgeFromRow(row);
        if (purge.agent_id !== input.agentId || purge.daemon_generation !== input.expectedDaemonGeneration
          || purge.phase !== "reprepare_credentials" || !purge.external_revoke_required
          || !((input.workerSessionAttestation === "exact" && Boolean(input.agentSessionId?.trim()))
            || (input.workerSessionAttestation === "none" && input.agentSessionId === null))) {
          throw new ManifestConflictError("Purge credential repreparation fence changed.");
        }
        run(database.prepare("UPDATE agent_purge_operations SET phase='revoking_credentials',worker_session_attestation=?,agent_session_id=?,error=NULL,updated_at=? WHERE operation_id=?"),
          input.workerSessionAttestation, input.agentSessionId, new Date().toISOString(), input.operationId);
        const updated = purgeFromRow(database.prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(input.operationId) as Row);
        database.exec("COMMIT");
        return updated;
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  async markPurgeCredentialsRevoked(input: {
    operationId: string;
    agentId: string;
    expectedDaemonGeneration: number;
    agentSessionId: string;
  }): Promise<DaemonPurgeRecord> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database.prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(input.operationId) as Row | undefined;
        if (!row) throw new Error("Unknown purge operation.");
        const purge = purgeFromRow(row);
        if (purge.agent_id !== input.agentId || purge.daemon_generation !== input.expectedDaemonGeneration
          || purge.phase !== "revoking_credentials" || purge.worker_session_attestation !== "exact"
          || purge.agent_session_id !== input.agentSessionId) {
          throw new ManifestConflictError("Purge credential-revocation acknowledgement is stale or belongs to another worker session.");
        }
        run(database.prepare("UPDATE agent_purge_operations SET phase='local_commit',error=NULL,updated_at=? WHERE operation_id=?"), new Date().toISOString(), input.operationId);
        const updated = purgeFromRow(database.prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(input.operationId) as Row);
        database.exec("COMMIT");
        return updated;
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  async markPurgeGrantRevokedWithoutWorkerSession(input: {
    operationId: string;
    agentId: string;
    expectedDaemonGeneration: number;
  }): Promise<DaemonPurgeRecord> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database.prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(input.operationId) as Row | undefined;
        if (!row) throw new Error("Unknown purge operation.");
        const purge = purgeFromRow(row);
        if (purge.agent_id !== input.agentId || purge.daemon_generation !== input.expectedDaemonGeneration
          || purge.phase !== "revoking_credentials" || purge.worker_session_attestation !== "none"
          || purge.agent_session_id !== null) {
          throw new ManifestConflictError("Purge grant-only acknowledgement is stale or lacks durable no-session proof.");
        }
        run(database.prepare("UPDATE agent_purge_operations SET phase='local_commit',error=NULL,updated_at=? WHERE operation_id=?"), new Date().toISOString(), input.operationId);
        const updated = purgeFromRow(database.prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(input.operationId) as Row);
        database.exec("COMMIT");
        return updated;
      } catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  /** One transaction proves all durable preconditions, removes every agent-owned row, advances generation, and completes the journal. */
  async commitPurge(expectedGeneration: number, input: { operationId: string; agentId: string; daemonGeneration: number }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<{ generation: number; purge: DaemonPurgeRecord }> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      let transactionOpen = false;
      let committed = false;
      const commit = async () => {
        database.exec("BEGIN IMMEDIATE"); transactionOpen = true;
        const generation = Number((database.prepare("SELECT generation FROM manifest_metadata WHERE singleton=1").get() as Row).generation);
        if (generation !== expectedGeneration) throw new ManifestConflictError("Manifest generation changed before purge commit.");
        const purgeRow = database.prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(input.operationId) as Row | undefined;
        if (!purgeRow) throw new Error("Unknown purge operation.");
        const purge = purgeFromRow(purgeRow);
        if (purge.agent_id !== input.agentId || purge.daemon_generation !== input.daemonGeneration || purge.phase !== "local_commit") throw new ManifestConflictError("Purge is not authorized for local commit.");
        const attachment = this.assertPurgePreconditions(database, input.agentId);
        if (attachment.attachedWorkAttemptId !== purge.attached_work_attempt_id || attachment.preservedWorkspacePath !== purge.preserved_workspace_path) {
          throw new ManifestConflictError("Purge target attachment changed after preparation.");
        }
        for (const [table, column] of [
          ["supervised_agent_effects", "agent_id"], ["supervised_agent_observed_messages", "agent_id"], ["supervised_agent_ingress_health", "agent_id"],
          ["supervised_agent_ingress_cursors", "agent_id"], ["supervised_agent_history_boundaries", "agent_id"], ["supervised_agent_pruned_sources", "agent_id"],
          ["supervised_worker_mint_states", "agent_id"], ["supervised_worker_sessions", "agent_id"], ["supervised_agent_inbox", "agent_id"], ["worker_binding_publications", "entry_id"],
          ["worker_generation_verifications", "entry_id"], ["worker_binding_watermarks", "entry_id"], ["worker_session_bindings", "entry_id"],
          ["agent_room_moves", "agent_id"],
        ] as const) run(database.prepare(`DELETE FROM ${table} WHERE ${column}=?`), input.agentId);
        if (purge.attached_work_attempt_id !== null) {
          const deletedAttempt = database.prepare("DELETE FROM work_attempts WHERE work_attempt_id=?").run(purge.attached_work_attempt_id);
          if (Number(deletedAttempt.changes) !== 1) throw new ManifestConflictError("Purge work attempt disappeared before local commit.");
        }
        const deleted = database.prepare("DELETE FROM agent_identities WHERE agent_id=?").run(input.agentId);
        if (Number(deleted.changes) !== 1) throw new Error("Purge target disappeared before local commit.");
        const advanced = database.prepare("UPDATE manifest_metadata SET generation=generation+1 WHERE singleton=1 AND generation=?").run(expectedGeneration);
        if (Number(advanced.changes) !== 1) throw new ManifestConflictError("Manifest generation changed during purge commit.");
        run(database.prepare("UPDATE agent_purge_operations SET phase='complete',error=NULL,updated_at=? WHERE operation_id=?"), new Date().toISOString(), input.operationId);
        database.exec("COMMIT"); transactionOpen = false; committed = true;
      };
      try { if (commitFence) await commitFence(commit); else await commit(); if (!committed) throw new Error("Purge commit fence returned without committing."); }
      catch (error) { if (transactionOpen) { try { database.exec("ROLLBACK"); } catch {} } throw error; }
      return { generation: expectedGeneration + 1, purge: purgeFromRow(database.prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(input.operationId) as Row) };
    });
  }

  private assertPurgePreconditions(database: DatabaseSync, agentId: string): { attachedWorkAttemptId: string | null; preservedWorkspacePath: string | null } {
    const state = database.prepare(`SELECT l.desired_state,d.observed_state,d.workspace_path_present,d.workspace_path,d.work_attempt_id_present,d.work_attempt_id,
        d.provider_ref_present,d.provider_work_attempt_id,d.provider_execution_generation_id,t.turn_control_present,t.status AS turn_status
      FROM agent_launch_intents l JOIN runtime_deployments d USING(agent_id) JOIN turn_control_journals t USING(agent_id) WHERE l.agent_id=?`).get(agentId) as Row | undefined;
    if (!state || state.desired_state !== "stopped" || !["absent", "stopped", "failed"].includes(String(state.observed_state))) throw new Error("Purge requires a fully stopped durable lifecycle.");
    const runtimeAttempt = bool(state.work_attempt_id_present) ? nullableString(state.work_attempt_id) : null;
    const providerAttempt = bool(state.provider_ref_present) ? nullableString(state.provider_work_attempt_id) : null;
    if (runtimeAttempt !== null && providerAttempt !== null && runtimeAttempt !== providerAttempt) throw new Error("Purge encountered conflicting durable work-attempt attachments.");
    const attachedWorkAttemptId = runtimeAttempt ?? providerAttempt;
    let preservedWorkspacePath = bool(state.workspace_path_present) ? nullableString(state.workspace_path) : null;
    if (attachedWorkAttemptId !== null) {
      const attempt = database.prepare("SELECT workspace_path FROM work_attempts WHERE work_attempt_id=?").get(attachedWorkAttemptId) as Row | undefined;
      if (!attempt || typeof attempt.workspace_path !== "string") throw new Error("Purge cannot prove the attached work attempt.");
      if (preservedWorkspacePath !== null && preservedWorkspacePath !== attempt.workspace_path) throw new Error("Purge encountered a workspace-path attachment mismatch.");
      preservedWorkspacePath = String(attempt.workspace_path);
      if (database.prepare("SELECT 1 FROM work_attempt_executions WHERE work_attempt_id=? AND terminal_json IS NULL LIMIT 1").get(attachedWorkAttemptId)) {
        throw new Error("Purge cannot remove a work attempt with a live provider execution.");
      }
      if (database.prepare(`SELECT 1 FROM runtime_deployments
          WHERE agent_id<>? AND ((work_attempt_id_present=1 AND work_attempt_id=?) OR (provider_ref_present=1 AND provider_work_attempt_id=?)) LIMIT 1`)
        .get(agentId, attachedWorkAttemptId, attachedWorkAttemptId)) {
        throw new Error("Purge cannot remove a work attempt attached to another agent.");
      }
    }
    if (state.provider_execution_generation_id !== null) {
      if (typeof state.provider_execution_generation_id !== "string" || attachedWorkAttemptId === null) throw new Error("Purge encountered invalid durable provider coordinates.");
      const execution = database.prepare("SELECT terminal_json FROM work_attempt_executions WHERE execution_generation_id=? AND work_attempt_id=?").get(state.provider_execution_generation_id, attachedWorkAttemptId) as Row | undefined;
      if (!execution || execution.terminal_json === null) throw new Error("Purge cannot remove an agent with a live provider execution.");
    }
    if (bool(state.turn_control_present) && ![null, "completed"].includes(state.turn_status as string | null)) throw new Error("Purge cannot remove an agent with nonterminal turn control.");
    const blockers = [
      database.prepare("SELECT 1 FROM worker_session_bindings WHERE entry_id=? LIMIT 1").get(agentId),
      database.prepare("SELECT 1 FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','cancelled_by_room_move') LIMIT 1").get(agentId),
      database.prepare("SELECT 1 FROM supervised_agent_effects WHERE agent_id=? AND state IN ('prepared','executing') LIMIT 1").get(agentId),
      database.prepare("SELECT 1 FROM supervised_agent_ingress_health WHERE agent_id=? AND state NOT IN ('stopped','blocked') LIMIT 1").get(agentId),
      database.prepare("SELECT 1 FROM agent_room_moves WHERE agent_id=? AND phase NOT IN ('active','failed') LIMIT 1").get(agentId),
    ];
    if (blockers.some(Boolean)) throw new Error("Purge has a durable provider, credential, turn, effect, ingress, or room-move blocker.");
    return { attachedWorkAttemptId, preservedWorkspacePath };
  }

  async updateAgentConfiguration(expectedGeneration: number, input: { agentId: string; expectedRevision: number; model: string | null; reasoningEffort: DaemonAgentConfiguration["reasoning_effort"]; charter: string; permissionProfileId: string | null; providerLaunchPolicy: unknown }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<{ generation: number; outcome: "updated" | "conflict" | "invalid"; configuration?: StoredAgentConfiguration }> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      const currentGeneration = Number((database.prepare("SELECT generation FROM manifest_metadata WHERE singleton=1").get() as Row).generation);
      if (currentGeneration !== expectedGeneration) throw new ManifestConflictError(`Manifest generation ${currentGeneration} does not match expected ${expectedGeneration}.`);
      const current = database.prepare("SELECT config_revision FROM agent_configurations WHERE agent_id=?").get(input.agentId) as Row | undefined;
      if (!current) return { generation: currentGeneration, outcome: "invalid" as const };
      if (Number(current.config_revision) !== input.expectedRevision) {
        return { generation: currentGeneration, outcome: "conflict" as const, configuration: await this.getAgentConfiguration(input.agentId) };
      }
      let committed = false;
      let transactionOpen = false;
      const commit = async () => {
        database.exec("BEGIN IMMEDIATE"); transactionOpen = true;
        const advanced = database.prepare("UPDATE manifest_metadata SET generation=generation+1 WHERE singleton=1 AND generation=?").run(expectedGeneration);
        if (Number(advanced.changes) !== 1) throw new ManifestConflictError("Manifest generation changed during configuration update.");
        const changed = database.prepare(`UPDATE agent_configurations SET model=?,reasoning_effort=?,charter=?,permission_profile_id=?,provider_launch_policy_present=1,provider_launch_policy_undefined=0,provider_launch_policy_json=?,config_revision=config_revision+1 WHERE agent_id=? AND config_revision=?`).run(input.model, input.reasoningEffort ?? null, input.charter, input.permissionProfileId, json(input.providerLaunchPolicy), input.agentId, input.expectedRevision);
        if (Number(changed.changes) !== 1) throw new ManifestConflictError("Agent configuration revision changed during update.");
        database.exec("COMMIT"); transactionOpen = false; committed = true;
      };
      try {
        if (commitFence) await commitFence(commit); else await commit();
        if (!committed) throw new Error("Configuration commit fence returned without committing.");
      } catch (error) {
        if (transactionOpen) { try { database.exec("ROLLBACK"); } catch {} }
        throw error;
      }
      return { generation: expectedGeneration + 1, outcome: "updated" as const, configuration: await this.getAgentConfiguration(input.agentId) };
    });
  }

  private readEntryFromDatabase(database: DatabaseSync, agentId: string): DaemonManifestEntry | undefined {
    const row = database.prepare(`
      SELECT
        i.agent_id, i.created_by, i.created_at,
        p.display_name, m.room_id,
        c.provider, c.model, c.reasoning_effort, c.charter, c.permission_profile_id, c.config_revision, c.runtime_configuration_revision, c.delivery_mode, c.delivery_cutover_json,
        c.provider_launch_policy_present, c.provider_launch_policy_undefined, c.provider_launch_policy_json,
        l.desired_state, l.source_repo_path_present, l.source_repo_path,
        d.deployment_id, d.run_id, d.observed_state,
        d.workspace_path_present, d.workspace_path,
        d.work_attempt_id_present, d.work_attempt_id,
        d.provider_ref_present, d.provider_work_attempt_id, d.provider_continuation_id,
        d.provider_connection_kind, d.provider_connection_url, d.provider_server_auth_path,
        d.provider_connection_pid,
        d.provider_process_identity_present, d.provider_process_identity, d.provider_execution_generation_id,
        d.workplace_liveness_present, d.workplace_liveness_state,
        d.workplace_liveness_observed_at, d.workplace_liveness_detail,
        d.native_liveness_present, d.native_liveness_state,
        d.native_liveness_observed_at, d.native_liveness_detail,
        d.activity_present,
        s.condition, s.last_error_present, s.last_error,
        r.ready_reached_at_present, r.ready_reached_at,
        t.turn_control_present, t.action_id, t.turn_work_attempt_id,
        t.turn_execution_generation_id, t.has_correction, t.status AS turn_status,
        t.provider_turn_id,
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
      WHERE i.agent_id = ?
    `).get(agentId) as Row | undefined;
    return row ? composeDaemonManifestEntry(this.projectionFromRow(database, row)) : undefined;
  }

  async replaceEntry(
    expectedGeneration: number,
    entry: DaemonManifestEntry,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry }> {
    const normalized = canonicalManifestEntry(entry);
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const row = database.prepare("SELECT sort_order FROM agent_identities WHERE agent_id = ?").get(normalized.id) as Row | undefined;
      if (!row) throw new Error(`Unknown daemon manifest entry: ${normalized.id}`);
      // Configuration revisions are Inspector-owned state, intentionally not
      // part of the legacy flat manifest projection. Preserve them through
      // unrelated lifecycle/runtime replacements.
      const configuration = database.prepare("SELECT * FROM agent_configurations WHERE agent_id=?").get(normalized.id) as Row;
      const projection = projectDaemonManifestEntry(normalized);
      this.preserveInspectorConfiguration(projection, configuration);
      run(database.prepare("DELETE FROM agent_identities WHERE agent_id = ?"), normalized.id);
      this.insertProjection(database, projection, Number(row.sort_order));
      const persisted = this.readEntryFromDatabase(database, normalized.id);
      if (!persisted) throw new Error(`Daemon manifest entry disappeared during replacement: ${normalized.id}`);
      return persisted;
    }, commitFence);
    return { generation: result.generation, entry: result.value };
  }

  async replaceEntriesBatch(
    expectedGeneration: number,
    entries: DaemonManifestEntry[],
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entries: DaemonManifestEntry[] }> {
    const normalized = entries.map(canonicalManifestEntry);
    if (new Set(normalized.map((entry) => entry.id)).size !== normalized.length) {
      throw new Error("Targeted manifest batch contains duplicate agent ids.");
    }
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const findOrder = database.prepare("SELECT sort_order FROM agent_identities WHERE agent_id = ?");
      const remove = database.prepare("DELETE FROM agent_identities WHERE agent_id = ?");
      for (const entry of normalized) {
        const row = findOrder.get(entry.id) as Row | undefined;
        if (!row) throw new Error(`Unknown daemon manifest entry: ${entry.id}`);
        const configuration = database.prepare("SELECT * FROM agent_configurations WHERE agent_id=?").get(entry.id) as Row;
        const projection = projectDaemonManifestEntry(entry);
        this.preserveInspectorConfiguration(projection, configuration);
        run(remove, entry.id);
        this.insertProjection(database, projection, Number(row.sort_order));
      }
      return normalized.map((entry) => {
        const persisted = this.readEntryFromDatabase(database, entry.id);
        if (!persisted) throw new Error(`Daemon manifest batch entry disappeared during replacement: ${entry.id}`);
        return persisted;
      });
    }, commitFence);
    return { generation: result.generation, entries: result.value };
  }

  /** Deletes only the durable manifest identity. Callers must first prove purge preconditions. */
  async removeEntry(
    expectedGeneration: number,
    agentId: string,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number }> {
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const deleted = database.prepare("DELETE FROM agent_identities WHERE agent_id=?").run(agentId);
      if (Number(deleted.changes) !== 1) throw new Error(`Unknown daemon manifest entry: ${agentId}`);
      return undefined;
    }, commitFence);
    return { generation: result.generation };
  }

  async markRuntimeConfigurationApplied(expectedGeneration: number, input: { agentId: string; executionGenerationId: string; appliedRevision: number }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<{ generation: number; configuration: StoredAgentConfiguration }> {
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const row = database.prepare(`SELECT c.config_revision,c.runtime_configuration_revision,d.provider_execution_generation_id FROM agent_configurations c JOIN runtime_deployments d USING(agent_id) WHERE c.agent_id=?`).get(input.agentId) as Row | undefined;
      if (!row || row.provider_execution_generation_id !== input.executionGenerationId) throw new ManifestConflictError("Provider execution changed before its configuration revision was applied.");
      if (!Number.isSafeInteger(input.appliedRevision) || input.appliedRevision < 1 || input.appliedRevision > Number(row.config_revision)) throw new Error("Applied runtime configuration revision is invalid.");
      if (Number(row.runtime_configuration_revision) > input.appliedRevision) throw new ManifestConflictError("Runtime configuration revision cannot move backwards.");
      run(database.prepare("UPDATE agent_configurations SET runtime_configuration_revision=? WHERE agent_id=?"), input.appliedRevision, input.agentId);
    }, commitFence);
    const configuration = await this.getAgentConfiguration(input.agentId);
    if (!configuration) throw new Error("Agent disappeared after runtime configuration apply.");
    return { generation: result.generation, configuration };
  }

  async appendActivity(
    expectedGeneration: number,
    agentId: string,
    event: DaemonActivityEvent,
    observedState: DaemonManifestEntry["observed_state"],
    nativeLiveness: NonNullable<DaemonManifestEntry["native_liveness"]>,
    limit = 200,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry }> {
    const normalizedEvent = parseJson<DaemonActivityEvent>(json(event));
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const latest = database.prepare("SELECT sequence FROM activity_events WHERE agent_id = ? ORDER BY sort_order DESC LIMIT 1").get(agentId) as Row | undefined;
      const lastSequence = latest ? Number(latest.sequence) : -1;
      if (normalizedEvent.sequence <= lastSequence) throw new Error(`Native activity sequence ${normalizedEvent.sequence} is not newer than ${lastSequence}.`);
      const updated = database.prepare(`
        UPDATE runtime_deployments
        SET observed_state = ?, native_liveness_present = 1, native_liveness_state = ?,
            native_liveness_observed_at = ?, native_liveness_detail = ?, activity_present = 1
        WHERE agent_id = ?
      `).run(observedState, nativeLiveness.state, nativeLiveness.observed_at ?? null, nativeLiveness.detail ?? null, agentId);
      if (Number(updated.changes) !== 1) throw new Error(`Unknown daemon manifest entry: ${agentId}`);
      const order = Number((database.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM activity_events WHERE agent_id = ?").get(agentId) as Row).next_order);
      run(database.prepare(`
        INSERT INTO activity_events(
          agent_id, sort_order, observed_at, sequence, provider, kind, method, summary,
          status, payload_json, payload_truncated, payload_redacted, durable_payload_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `), agentId, order, normalizedEvent.observed_at, normalizedEvent.sequence, normalizedEvent.provider,
      normalizedEvent.kind, normalizedEvent.method, normalizedEvent.summary, normalizedEvent.status,
      json(normalizedEvent.payload), Number(normalizedEvent.payload_truncated), Number(normalizedEvent.payload_redacted),
      normalizedEvent.durable_payload_ref);
      run(database.prepare(`
        DELETE FROM activity_events
        WHERE agent_id = ? AND sort_order NOT IN (
          SELECT sort_order FROM activity_events WHERE agent_id = ? ORDER BY sort_order DESC LIMIT ?
        )
      `), agentId, agentId, limit);
      const persisted = this.readEntryFromDatabase(database, agentId);
      if (!persisted) throw new Error(`Daemon manifest entry disappeared during activity append: ${agentId}`);
      return persisted;
    }, commitFence);
    return { generation: result.generation, entry: result.value };
  }

  async updateWorkplaceLiveness(
    expectedGeneration: number,
    agentId: string,
    liveness: NonNullable<DaemonManifestEntry["workplace_liveness"]>,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry }> {
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const updated = database.prepare(`
        UPDATE runtime_deployments
        SET workplace_liveness_present = 1, workplace_liveness_state = ?,
            workplace_liveness_observed_at = ?, workplace_liveness_detail = ?
        WHERE agent_id = ?
      `).run(liveness.state, liveness.observed_at ?? null, liveness.detail ?? null, agentId);
      if (Number(updated.changes) !== 1) throw new Error(`Unknown daemon manifest entry: ${agentId}`);
      const persisted = this.readEntryFromDatabase(database, agentId);
      if (!persisted) throw new Error(`Daemon manifest entry disappeared during liveness update: ${agentId}`);
      return persisted;
    }, commitFence);
    return { generation: result.generation, entry: result.value };
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
      const normalizedEntries = entries.map(canonicalManifestEntry);
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
          this.replaceEntries(database, normalizedEntries);
          this.replaceLegacyLaneOwners(database, owners ?? []);
          database.exec("COMMIT");
          transactionOpen = false;
          committed = true;
        };
        if (commitFence) await commitFence(commit);
        else await commit();
        if (!committed) throw new Error("Manifest commit fence returned without committing the transaction.");

        const manifest: DaemonManifest = owners?.length
          ? { generation: expectedGeneration + 1, entries: normalizedEntries, legacy_lane_owners: owners }
          : { generation: expectedGeneration + 1, entries: normalizedEntries };
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
    let database: DatabaseSync | null = null;
    try {
      database = await openDaemonStateDatabase(this.path, async (opened) => {
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

  private createSchema(database: DatabaseSync): void {
    new DaemonStateSchema(this.schemaInitializationHook).createSchema(database);
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
      this.replaceEntries(database, stored.manifest.entries, false);
      this.replaceLegacyLaneOwners(database, stored.manifest.legacy_lane_owners ?? []);
      run(database.prepare("UPDATE manifest_metadata SET generation = ? WHERE singleton = 1"), stored.manifest.generation);
      run(database.prepare("INSERT INTO migration_records(migration_key, checksum, imported_at) VALUES (?, ?, ?)"), migrationKey, stored.checksum, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
      throw error;
    }
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

  private replaceEntries(database: DatabaseSync, entries: DaemonManifestEntry[], initializeNewMintStates = true): void {
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
  }

  private preserveInspectorConfiguration(projection: DaemonManifestDomainProjection, row: Row): void {
    projection.configuration.provider = String(row.provider);
    projection.configuration.model = nullableString(row.model);
    projection.configuration.reasoning_effort = nullableString(row.reasoning_effort) as DaemonAgentConfiguration["reasoning_effort"];
    projection.configuration.charter = String(row.charter);
    projection.configuration.permission_profile_id = nullableString(row.permission_profile_id);
    projection.configuration.config_revision = Number(row.config_revision);
    projection.configuration.runtime_configuration_revision = Number(row.runtime_configuration_revision);
    if (bool(row.provider_launch_policy_present)) {
      projection.configuration.provider_launch_policy = bool(row.provider_launch_policy_undefined) ? undefined : parseJson(row.provider_launch_policy_json);
    } else {
      delete projection.configuration.provider_launch_policy;
    }
  }

  private insertProjection(database: DatabaseSync, projection: DaemonManifestDomainProjection, sortOrder: number): void {
    const { identity, profile, membership, configuration, launch_intent: launch, runtime_deployment: runtime, lifecycle, readiness, turn_control_journal: turnJournal, retained_worker_binding: bindingRecord, reconciliation: reconciliationRecord } = projection;
    run(database.prepare("INSERT INTO agent_identities VALUES (?, ?, ?, ?)"), identity.agent_id, identity.created_by, identity.created_at, sortOrder);
    run(database.prepare("INSERT INTO agent_profiles VALUES (?, ?)"), identity.agent_id, profile.display_name);
    run(database.prepare("INSERT INTO agent_room_memberships VALUES (?, ?)"), identity.agent_id, membership.room_id);
    const policyPresent = Object.hasOwn(configuration, "provider_launch_policy");
    const policyUndefined = policyPresent && configuration.provider_launch_policy === undefined;
    run(database.prepare(`
      INSERT INTO agent_configurations(
        agent_id, provider, model, reasoning_effort, charter, permission_profile_id, config_revision, runtime_configuration_revision, delivery_mode, delivery_cutover_json,
        provider_launch_policy_present, provider_launch_policy_undefined, provider_launch_policy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `), identity.agent_id, configuration.provider, configuration.model, configuration.reasoning_effort ?? null, configuration.charter, configuration.permission_profile_id, configuration.config_revision ?? 1, configuration.runtime_configuration_revision ?? configuration.config_revision ?? 1, configuration.delivery_mode ?? "mcp_polling", configuration.delivery_cutover === undefined ? null : json(configuration.delivery_cutover), Number(policyPresent), Number(policyUndefined), policyPresent && !policyUndefined ? json(configuration.provider_launch_policy) : null);
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
        provider_process_identity_present, provider_process_identity, provider_execution_generation_id,
        workplace_liveness_present, workplace_liveness_state, workplace_liveness_observed_at, workplace_liveness_detail,
        native_liveness_present, native_liveness_state, native_liveness_observed_at, native_liveness_detail,
        activity_present
      ) VALUES (${Array.from({ length: 27 }, () => "?").join(", ")})
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
    run(database.prepare(`
      INSERT INTO turn_control_journals(
        agent_id, turn_control_present, action_id, turn_work_attempt_id,
        turn_execution_generation_id, provider_turn_id, has_correction, status,
        capability, interrupted, resumed, turn_state, error, recorded_at, updated_at
      ) VALUES (${Array.from({ length: 15 }, () => "?").join(", ")})
    `),
      identity.agent_id, Number(turnPresent), turn?.action_id ?? null, turn?.work_attempt_id ?? null,
      turn?.execution_generation_id ?? null, turn?.provider_turn_id ?? null, turn ? Number(turn.has_correction) : null,
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
      ...(nullableString(row.provider_turn_id) ? { provider_turn_id: nullableString(row.provider_turn_id) } : {}),
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
      configuration: { agent_id: agentId, provider: String(row.provider), model: nullableString(row.model), reasoning_effort: nullableString(row.reasoning_effort) as DaemonAgentConfiguration["reasoning_effort"], charter: String(row.charter), permission_profile_id: nullableString(row.permission_profile_id), config_revision: Number(row.config_revision), runtime_configuration_revision: Number(row.runtime_configuration_revision), ...(row.delivery_mode !== "mcp_polling" ? { delivery_mode: String(row.delivery_mode) as DaemonManifestEntry["delivery_mode"] } : {}), ...(row.delivery_cutover_json === null ? {} : { delivery_cutover: parseJson(row.delivery_cutover_json) }), ...(bool(row.provider_launch_policy_present) ? { provider_launch_policy: bool(row.provider_launch_policy_undefined) ? undefined : parseJson(row.provider_launch_policy_json) } : {}) },
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

  private writeTargeted<T>(
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
            const current = Number((database.prepare("SELECT generation FROM manifest_metadata WHERE singleton = 1").get() as Row).generation);
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

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writes;
    let release!: () => void;
    this.writes = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async secureDatabaseFiles(): Promise<void> {
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
