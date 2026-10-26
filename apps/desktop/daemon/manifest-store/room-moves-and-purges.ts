/**
 * Room-move and purge journals.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import type { DatabaseSync } from "node:sqlite";
import { assertNoPollingActivation } from "../custodial-polling-activation.js";
import { assertNoDeliveryDrain } from "../delivery-drain.js";
import { cancelInterruptedSupervisedTurn, pruneSupervisedAgentHistory } from "../supervised-agent-history-retention.js";
import type { DaemonPurgePhase, DaemonPurgeRecord, DaemonPurgeWorkerSessionAttestation, DaemonRoomMovePhase, DaemonRoomMoveRecord } from "../types.js";
import { type Row, roomMoveFromRow, purgeFromRow, ManifestConflictError, bool, nullableString, json, run, storeMethods } from "./shared.js";

export const roomMovesAndPurges = storeMethods({
  async prepareRoomMove(
    input: Omit<DaemonRoomMoveRecord, "phase" | "remote_room_id" | "destination_cursor" | "source_credentials_revoked" | "source_cursor_present" | "source_cursor" | "error" | "created_at" | "updated_at"> & { phase: "prepared" | "waiting_for_current_turn" },
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ created: boolean; move: DaemonRoomMoveRecord }> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      let transactionOpen = false;
      let committed = false;
      let result!: { created: boolean; move: DaemonRoomMoveRecord };
      try {
        const commit = async () => {
          if (committed) throw new Error("Room-move preparation transaction was already committed.");
          database.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
          const existing = database.prepare("SELECT * FROM agent_room_moves WHERE request_id=?").get(input.request_id) as Row | undefined;
          if (existing) {
            const move = roomMoveFromRow(existing);
            if (move.operation_id !== input.operation_id || move.agent_id !== input.agent_id || move.source_room_id !== input.source_room_id || move.destination_room_id !== input.destination_room_id || move.execution_generation_id !== input.execution_generation_id) throw new Error("Room-move request id is already bound to different coordinates.");
            result = { created: false, move };
          } else {
            assertNoDeliveryDrain(database, input.agent_id);
            assertNoPollingActivation(database, input.agent_id);
            const unresolvedControl = database.prepare(`SELECT action_id FROM turn_control_journals
              WHERE agent_id=? AND turn_control_present=1 AND status IN ('prepared','dispatching','retryable','uncertain')`).get(input.agent_id) as Row | undefined;
            if (unresolvedControl) {
              throw new ManifestConflictError(`Room move is blocked by unresolved turn-control action '${String(unresolvedControl.action_id)}'.`);
            }
            const now = new Date().toISOString();
            const sourceCursor = database.prepare("SELECT last_observed_message_id FROM supervised_agent_ingress_cursors WHERE agent_id=? AND room_id=?")
              .get(input.agent_id, input.source_room_id) as Row | undefined;
            run(database.prepare(`INSERT INTO agent_room_moves(operation_id,request_id,agent_id,source_room_id,destination_room_id,daemon_generation,work_attempt_id,execution_generation_id,agent_session_id,activating_inbox_item_id,provider_turn_id,effect_id,phase,remote_room_id,destination_cursor,error,created_at,updated_at,source_cursor_present,source_cursor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?)`),
              input.operation_id, input.request_id, input.agent_id, input.source_room_id, input.destination_room_id, input.daemon_generation, input.work_attempt_id, input.execution_generation_id, input.agent_session_id, input.activating_inbox_item_id, input.provider_turn_id, input.effect_id, input.phase, now, now,
              sourceCursor ? 1 : 0, sourceCursor?.last_observed_message_id ?? null);
            const row = database.prepare("SELECT * FROM agent_room_moves WHERE operation_id=?").get(input.operation_id) as Row;
            result = { created: true, move: roomMoveFromRow(row) };
          }
          database.exec("COMMIT");
          transactionOpen = false;
          committed = true;
        };
        if (commitFence) await commitFence(commit);
        else await commit();
        if (!committed) throw new Error("Room-move preparation fence returned without committing the transaction.");
        return result;
      } catch (error) {
        if (transactionOpen) { try { database.exec("ROLLBACK"); } catch {} }
        throw error;
      }
    });
  },

  async getRoomMove(operationId: string): Promise<DaemonRoomMoveRecord | null> {
    const row = (await this.getDatabase()).prepare("SELECT * FROM agent_room_moves WHERE operation_id=?").get(operationId) as Row | undefined;
    return row ? roomMoveFromRow(row) : null;
  },

  async pendingRoomMoves(agentId?: string): Promise<DaemonRoomMoveRecord[]> {
    const database = await this.getDatabase();
    const rows = (agentId
      ? database.prepare("SELECT * FROM agent_room_moves WHERE agent_id=? AND phase NOT IN ('active','failed') ORDER BY created_at").all(agentId)
      : database.prepare("SELECT * FROM agent_room_moves WHERE phase NOT IN ('active','failed') ORDER BY created_at").all()) as Row[];
    return rows.map(roomMoveFromRow);
  },

  /**
   * Advance one exact room-move journal edge. Terminal edges also settle the
   * mediated join_room effect in this same transaction: a crash may observe
   * neither terminal record or both, never a terminal move with a live effect.
   */
  async advanceRoomMove(
    input: { operationId: string; agentId: string; expectedDaemonGeneration: number; expectedExecutionGenerationId: string | null; from: DaemonRoomMovePhase[]; to: DaemonRoomMovePhase; remoteRoomId?: string | null; destinationCursor?: string | null; sourceCredentialsRevoked?: boolean; error?: string | null; adoptDaemonGeneration?: number },
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<DaemonRoomMoveRecord> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      let transactionOpen = false;
      let committed = false;
      let updated!: DaemonRoomMoveRecord;
      try {
        const commit = async () => {
          if (committed) throw new Error("Room-move transaction was already committed.");
          database.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
          const row = database.prepare("SELECT * FROM agent_room_moves WHERE operation_id=?").get(input.operationId) as Row | undefined;
          if (!row) throw new Error("Unknown room-move operation.");
          const current = roomMoveFromRow(row);
          if (current.agent_id !== input.agentId || current.daemon_generation !== input.expectedDaemonGeneration || current.execution_generation_id !== input.expectedExecutionGenerationId || !input.from.includes(current.phase)) throw new ManifestConflictError("Room-move phase fence changed.");
          const updatedAt = new Date().toISOString();
          run(database.prepare(`UPDATE agent_room_moves SET phase=?,daemon_generation=?,remote_room_id=COALESCE(?,remote_room_id),destination_cursor=COALESCE(?,destination_cursor),source_credentials_revoked=CASE WHEN ? THEN 1 ELSE source_credentials_revoked END,error=?,updated_at=? WHERE operation_id=?`), input.to, input.adoptDaemonGeneration ?? current.daemon_generation, input.remoteRoomId ?? null, input.destinationCursor ?? null, input.sourceCredentialsRevoked ? 1 : 0, input.error ?? null, updatedAt, input.operationId);
          updated = roomMoveFromRow(database.prepare("SELECT * FROM agent_room_moves WHERE operation_id=?").get(input.operationId) as Row);
          if ((input.to === "active" || input.to === "failed") && updated.effect_id !== null) {
            if (!updated.activating_inbox_item_id || !updated.provider_turn_id || !updated.work_attempt_id || !updated.execution_generation_id) {
              throw new ManifestConflictError("Terminal mediated room move lost its complete activating-turn coordinates.");
            }
            const authority = database.prepare(`SELECT
              i.agent_id AS inbox_agent_id,i.room_id AS inbox_room_id,i.provider_turn_id AS inbox_provider_turn_id,
              b.agent_id AS binding_agent_id,b.room_id AS binding_room_id,b.work_attempt_id AS binding_work_attempt_id,
              b.origin_execution_generation_id,b.provider_turn_id AS binding_provider_turn_id
              FROM supervised_agent_inbox i
              JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=i.inbox_item_id
              WHERE i.inbox_item_id=?`).get(updated.activating_inbox_item_id) as Row | undefined;
            const effectRow = database.prepare("SELECT * FROM supervised_agent_effects WHERE effect_id=?").get(updated.effect_id) as Row | undefined;
            if (!authority
              || String(authority.inbox_agent_id) !== updated.agent_id
              || String(authority.inbox_room_id) !== updated.source_room_id
              || nullableString(authority.inbox_provider_turn_id) !== updated.provider_turn_id
              || String(authority.binding_agent_id) !== updated.agent_id
              || String(authority.binding_room_id) !== updated.source_room_id
              || String(authority.binding_work_attempt_id) !== updated.work_attempt_id
              || nullableString(authority.binding_provider_turn_id) !== updated.provider_turn_id
              || !effectRow
              || String(effectRow.agent_id) !== updated.agent_id
              || String(effectRow.room_id) !== updated.source_room_id
              || String(effectRow.execution_generation_id) !== String(authority.origin_execution_generation_id)
              || nullableString(effectRow.provider_turn_id) !== updated.provider_turn_id
              || String(effectRow.tool_name) !== "join_room"
              || String(effectRow.state) !== "prepared") {
              throw new ManifestConflictError("Terminal room move lost its exact activating binding or prepared join-room effect.");
            }
            const resultJson = input.to === "active"
              ? json({
                phase: "active",
                moved: true,
                old_room: updated.source_room_id,
                destination_room: updated.remote_room_id ?? updated.destination_room_id,
                destination_cursor: updated.destination_cursor,
              })
              : null;
            const effectError = input.to === "failed"
              ? (updated.error ?? "The room move failed before its effect journal was settled.").slice(0, 32_768)
              : null;
            run(database.prepare("UPDATE supervised_agent_effects SET state=?,result_json=?,error=?,updated_at=? WHERE effect_id=? AND state='prepared'"),
              input.to === "active" ? "completed" : "failed", resultJson, effectError, updatedAt, updated.effect_id);
          }
          if (input.to === "active" || input.to === "failed") {
            // Reaching a terminal room-move phase releases the compensation rows
            // protected by the shared retention policy. Compact only after the
            // exact effect reached the same terminal boundary.
            pruneSupervisedAgentHistory(database, input.agentId, () => updatedAt);
          }
          database.exec("COMMIT");
          transactionOpen = false;
          committed = true;
        };
        if (commitFence) await commitFence(commit);
        else await commit();
        if (!committed) throw new Error("Room-move commit fence returned without committing the transaction.");
        return updated;
      } catch (error) {
        if (transactionOpen) { try { database.exec("ROLLBACK"); } catch {} }
        throw error;
      }
    });
  },

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
        const now = new Date().toISOString();
        this.settleGivenAgentInboxForPurge(database, input.agentId, now);
        const attachment = this.assertPurgePreconditions(database, input.agentId);
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
  },

  async getPurge(operationId: string): Promise<DaemonPurgeRecord | null> {
    const row = (await this.getDatabase()).prepare("SELECT * FROM agent_purge_operations WHERE operation_id=?").get(operationId) as Row | undefined;
    return row ? purgeFromRow(row) : null;
  },

  async pendingPurges(): Promise<DaemonPurgeRecord[]> {
    return ((await this.getDatabase()).prepare("SELECT * FROM agent_purge_operations WHERE phase IN ('reprepare_credentials','revoking_credentials','local_commit') ORDER BY created_at").all() as Row[]).map(purgeFromRow);
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
          ["supervised_agent_effects", "agent_id"], ["supervised_agent_effect_tombstones", "agent_id"], ["supervised_agent_observed_messages", "agent_id"], ["supervised_agent_ingress_health", "agent_id"],
          ["supervised_agent_ingress_cursors", "agent_id"], ["supervised_agent_history_boundaries", "agent_id"], ["supervised_agent_pruned_sources", "agent_id"],
          ["supervised_worker_mint_states", "agent_id"], ["supervised_worker_sessions", "agent_id"], ["supervised_agent_inbox", "agent_id"], ["worker_binding_publications", "entry_id"],
          ["worker_generation_verifications", "entry_id"], ["worker_binding_watermarks", "entry_id"], ["worker_session_bindings", "entry_id"],
          ["agent_room_moves", "agent_id"], ["turn_control_sequence_watermarks", "agent_id"],
          ["reconciliation_action_tombstones", "agent_id"],
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
  },

  /**
   * A given agent (Ask for an agent, id `supervised_rental_ask_*`) removed
   * before it ever answered still holds the room messages it was handed:
   * items in `pending`, `retryable` or `blocked` with no provider turn. Nothing
   * else settles them, so they would block its purge for good. They are
   * cancelled here, in FIFO order, only while the agent is fully stopped and
   * only up to the first item a provider turn touched. An ordinary supervised
   * agent keeps its items, and its purge is refused as before.
   */
  settleGivenAgentInboxForPurge(database: DatabaseSync, agentId: string, timestamp: string): number {
    if (!agentId.startsWith("supervised_rental_ask_")) return 0;
    const lifecycle = database.prepare(`SELECT l.desired_state,d.observed_state FROM agent_launch_intents l
      JOIN runtime_deployments d USING(agent_id) WHERE l.agent_id=?`).get(agentId) as Row | undefined;
    if (!lifecycle || lifecycle.desired_state !== "stopped" || !["absent", "stopped", "failed"].includes(String(lifecycle.observed_state))) return 0;
    let cancelled = 0;
    for (;;) {
      const head = database.prepare(`SELECT inbox_item_id,state,provider_turn_id FROM supervised_agent_inbox WHERE agent_id=?
        AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
        ORDER BY fifo_sequence LIMIT 1`).get(agentId) as Row | undefined;
      if (!head || !["pending", "retryable", "blocked"].includes(String(head.state)) || head.provider_turn_id !== null) break;
      const settled = cancelInterruptedSupervisedTurn(database, String(head.inbox_item_id), "The agent was removed before it answered.", timestamp);
      if (settled?.state !== "cancelled_by_user" && settled?.state !== "acknowledged_failed") break;
      cancelled += 1;
    }
    return cancelled;
  },

  assertPurgePreconditions(database: DatabaseSync, agentId: string): { attachedWorkAttemptId: string | null; preservedWorkspacePath: string | null } {
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
      database.prepare("SELECT 1 FROM supervised_agent_inbox WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user') LIMIT 1").get(agentId),
      database.prepare("SELECT 1 FROM supervised_agent_effects WHERE agent_id=? AND state IN ('prepared','executing') LIMIT 1").get(agentId),
      database.prepare("SELECT 1 FROM supervised_agent_ingress_health WHERE agent_id=? AND state NOT IN ('stopped','blocked') LIMIT 1").get(agentId),
      database.prepare("SELECT 1 FROM agent_room_moves WHERE agent_id=? AND phase NOT IN ('active','failed') LIMIT 1").get(agentId),
    ];
    if (blockers.some(Boolean)) throw new Error("Purge has a durable provider, credential, turn, effect, ingress, or room-move blocker.");
    return { attachedWorkAttemptId, preservedWorkspacePath };
  },
});
