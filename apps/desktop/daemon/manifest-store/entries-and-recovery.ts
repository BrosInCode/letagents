/**
 * Agent configuration updates, entry replacement, provider birth checkpoints and runtime recovery.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import type { ProcessIdentity } from "../process-identity.js";
import type { DatabaseSync } from "node:sqlite";
import { sameProviderActionConnectionSnapshot } from "../provider-action-port.js";
import { prepareRetiredRuntimePlan, archiveRetiredRuntimes, archiveExitedRuntimes, exitedRuntimesToArchive, type RetiredRuntimeEvidence, type RetiredRuntimePlan, prepareRuntimeRecovery, checkpointRuntimeStopped, readRuntimeRecovery, recordInterruptedCursorRecovery, type RuntimeRestartRequest, type RuntimeRecoveryRecord } from "../runtime-recovery-journal.js";
import { assertNoPollingActivation } from "../custodial-polling-activation.js";
import { assertNoDeliveryDrain } from "../delivery-drain.js";
import { cancelInterruptedSupervisedTurn } from "../supervised-agent-history-retention.js";
import type { SupervisedProviderTurnBinding } from "../supervised-agent-inbox-store.js";
import { composeDaemonManifestEntry, projectDaemonManifestEntry } from "../manifest-entry-projection.js";
import { executionRuntimeStorageIdentity, materializeRuntimeIdentity } from "../execution-shadow-store.js";
import { lifecycleAuthorityProviderSchema, type LifecycleAuthorityMode } from "../lifecycle-authority-mode.js";
import type { DaemonAgentConfiguration, DaemonManifestEntry, DaemonProviderConnection } from "../types.js";
import { type Row, type StoredAgentConfiguration, type PreMembershipRoomMoveCancellation, ManifestConflictError, json, canonicalManifestEntry, run, storeMethods } from "./shared.js";

export const entriesAndRecovery = storeMethods({
  async updateAgentConfiguration(expectedGeneration: number, input: { agentId: string; expectedRevision: number; model: string | null; reasoningEffort: DaemonAgentConfiguration["reasoning_effort"]; charter: string; permissionProfileId: string | null; providerLaunchPolicy: unknown; imageInput: boolean }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<{ generation: number; outcome: "updated" | "conflict" | "invalid"; configuration?: StoredAgentConfiguration }> {
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
        assertNoDeliveryDrain(database, input.agentId);
        assertNoPollingActivation(database, input.agentId);
        const advanced = database.prepare("UPDATE manifest_metadata SET generation=generation+1 WHERE singleton=1 AND generation=?").run(expectedGeneration);
        if (Number(advanced.changes) !== 1) throw new ManifestConflictError("Manifest generation changed during configuration update.");
        const changed = database.prepare(`UPDATE agent_configurations SET model=?,reasoning_effort=?,charter=?,permission_profile_id=?,provider_launch_policy_present=1,provider_launch_policy_undefined=0,provider_launch_policy_json=?,image_input=?,config_revision=config_revision+1 WHERE agent_id=? AND config_revision=?`).run(input.model, input.reasoningEffort ?? null, input.charter, input.permissionProfileId, json(input.providerLaunchPolicy), input.imageInput ? 1 : 0, input.agentId, input.expectedRevision);
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
  },

  readEntryFromDatabase(database: DatabaseSync, agentId: string, activityMode: "full" | "summary" = "full"): DaemonManifestEntry | undefined {
    const row = this.reads.get(database, "entry").get(agentId) as Row | undefined;
    return row ? composeDaemonManifestEntry(this.projectionFromRow(database, row, activityMode)) : undefined;
  },

  async replaceEntry(
    expectedGeneration: number,
    entry: DaemonManifestEntry,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
    roomMoveCancellation?: PreMembershipRoomMoveCancellation,
    interruptedDelivery?: { turn: SupervisedProviderTurnBinding; detail: string; observedAt: string; cursorLaneRetirement?: import("../runtime-recovery-journal.js").CursorLaneRetirement },
  ): Promise<{ generation: number; entry: DaemonManifestEntry; recoveredRuntimeId?: string }> {
    const normalized = canonicalManifestEntry(entry);
    let recoveredRuntimeId: string | undefined;
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const row = database.prepare("SELECT sort_order FROM agent_identities WHERE agent_id = ?").get(normalized.id) as Row | undefined;
      if (!row) throw new Error(`Unknown daemon manifest entry: ${normalized.id}`);
      if (interruptedDelivery) {
        const { turn, detail, observedAt } = interruptedDelivery;
        const receipt = database.prepare("SELECT state,outcome,provider_turn_id FROM supervised_agent_inbox WHERE inbox_item_id=?").get(turn.inbox_item_id) as Row | undefined;
        const binding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?").get(turn.inbox_item_id) as Row | undefined;
        if (turn.agent_id !== normalized.id || turn.room_id !== normalized.room_id
          || !receipt || receipt.state !== "blocked" || receipt.outcome !== null
          || receipt.provider_turn_id !== turn.provider_turn_id
          || !binding || Object.entries(turn).some(([key, value]) => binding[key] !== value)) {
          throw new ManifestConflictError("Runtime recovery lost the exact blocked provider turn before settlement.");
        }
        recoveredRuntimeId = recordInterruptedCursorRecovery(database, turn, observedAt, interruptedDelivery.cursorLaneRetirement) ?? undefined;
        cancelInterruptedSupervisedTurn(database, turn.inbox_item_id, detail, observedAt,
          { agent_id: normalized.id, room_id: normalized.room_id });
      }
      if (roomMoveCancellation) this.failPreMembershipRoomMoves(database, roomMoveCancellation);
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
    return { generation: result.generation, entry: result.value, recoveredRuntimeId };
  },

  /**
   * Persist the provider reference, applied configuration, and exact native
   * process birth in one transaction. Cursor's idle lane has no process birth;
   * each paused child is materialized by checkpointCursorPreparedTurn instead.
   */
  async checkpointProviderBirth(
    expectedGeneration: number,
    input: {
      entry: DaemonManifestEntry;
      executionGenerationId: string;
      providerConnection: DaemonProviderConnection;
      appliedRevision: number;
      managedLaunchContract?: string;
      requestedAuthorityMode: LifecycleAuthorityMode;
      observedAtMs: number;
    },
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry; authorityMode: LifecycleAuthorityMode | null }> {
    const snapshot = structuredClone(input);
    const normalized = canonicalManifestEntry(snapshot.entry);
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const row = database.prepare("SELECT sort_order FROM agent_identities WHERE agent_id=?")
        .get(normalized.id) as Row | undefined;
      const configuration = database.prepare("SELECT * FROM agent_configurations WHERE agent_id=?")
        .get(normalized.id) as Row | undefined;
      const ref = normalized.provider_ref;
      if (!row || !configuration || !ref
        || normalized.work_attempt_id !== ref.work_attempt_id
        || ref.execution_generation_id !== snapshot.executionGenerationId
        || !sameProviderActionConnectionSnapshot(ref.provider_connection, snapshot.providerConnection)
        || !Number.isSafeInteger(snapshot.appliedRevision)
        || snapshot.appliedRevision < 1
        || snapshot.appliedRevision > Number(configuration.config_revision)
        || Number(configuration.runtime_configuration_revision) > snapshot.appliedRevision
        || !Number.isSafeInteger(snapshot.observedAtMs)
        || snapshot.observedAtMs < 0) {
        throw new ManifestConflictError("Provider birth lost its exact manifest or configuration authority.");
      }
      if (!database.prepare(`SELECT 1 FROM work_attempt_executions
        WHERE work_attempt_id=? AND execution_generation_id=?`)
        .get(ref.work_attempt_id, snapshot.executionGenerationId)) {
        throw new ManifestConflictError("Provider birth has no exact durable execution generation.");
      }
      const provider = lifecycleAuthorityProviderSchema.safeParse(normalized.provider);
      const expectedProvider = {
        codex_app_server: "codex",
        claude_cli: "claude-code",
        cursor_cli: "cursor",
        opencode_server: "open-model",
      } as const;
      if (!provider.success || provider.data !== expectedProvider[snapshot.providerConnection.kind]) {
        throw new ManifestConflictError("Provider birth connection does not match its provider.");
      }
      const projection = projectDaemonManifestEntry(normalized);
      this.preserveInspectorConfiguration(projection, configuration);
      run(database.prepare("DELETE FROM agent_identities WHERE agent_id=?"), normalized.id);
      this.insertProjection(database, projection, Number(row.sort_order));
      run(database.prepare("UPDATE agent_configurations SET runtime_configuration_revision=? WHERE agent_id=?"),
        snapshot.appliedRevision, normalized.id);

      const connection = snapshot.providerConnection;
      let authorityMode: LifecycleAuthorityMode | null = null;
      if (connection.pid === null || !connection.processIdentity) {
        if (connection.kind !== "cursor_cli" || connection.pid !== null || connection.processIdentity != null) {
          throw new ManifestConflictError("Provider birth requires an exact native process identity.");
        }
      } else {
        const runtimeGenerationId = executionRuntimeStorageIdentity(normalized.id,
          snapshot.executionGenerationId, connection.kind, connection.pid, connection.processIdentity);
        authorityMode = materializeRuntimeIdentity(database, {
          agentId: normalized.id,
          executionGenerationId: snapshot.executionGenerationId,
          runtimeGenerationId,
          provider: provider.data,
          authorityMode: snapshot.requestedAuthorityMode,
          configRevision: snapshot.appliedRevision,
          createdAtMs: snapshot.observedAtMs,
        });
        if (authorityMode !== snapshot.requestedAuthorityMode) {
          throw new Error("Provider birth retained an incompatible frozen lifecycle authority.");
        }
        if (snapshot.managedLaunchContract !== undefined) {
          if (!/^[a-f0-9]{64}$/.test(snapshot.managedLaunchContract)) throw new Error("Invalid managed launch contract.");
          const prior = database.prepare("SELECT contract_sha256 FROM managed_launch_contracts WHERE runtime_generation_id=?").get(runtimeGenerationId);
          if (prior && prior.contract_sha256 !== snapshot.managedLaunchContract) throw new Error("Native birth cannot change its managed launch contract.");
          database.prepare(`INSERT OR IGNORE INTO managed_launch_contracts
            (runtime_generation_id,agent_id,execution_generation_id,contract_sha256) VALUES(?,?,?,?)`)
            .run(runtimeGenerationId, normalized.id, snapshot.executionGenerationId, snapshot.managedLaunchContract);
        }
      }
      const persisted = this.readEntryFromDatabase(database, normalized.id);
      if (!persisted) throw new Error("Provider birth disappeared during its atomic checkpoint.");
      return { entry: persisted, authorityMode };
    }, commitFence);
    return { generation: result.generation, ...result.value };
  },

  /**
   * Atomically install an accepted turn-control barrier and classify the exact
   * FIFO head at that same SQLite boundary. If claimHead won first, the journal
   * links that already-admitted row; if this transaction wins first, a pending
   * row remains unlinked and the journal barrier prevents it from starting.
   */
  async getRuntimeRecovery(operationId: string): Promise<RuntimeRecoveryRecord | null> {
    return readRuntimeRecovery(await this.getDatabase(), operationId);
  },

  async pendingRuntimeRecovery(agentId: string): Promise<RuntimeRecoveryRecord | null> {
    return this.reads.get(await this.getDatabase(), "pendingRuntimeRecovery").get(agentId) as RuntimeRecoveryRecord | undefined ?? null;
  },

  async prepareRuntimeRecovery(expectedGeneration: number, input: RuntimeRestartRequest,
    commitFence: (commit: () => Promise<void>) => Promise<void>) {
    const result = await this.writeTargeted(expectedGeneration, database => {
      assertNoDeliveryDrain(database, input.entryId);
      assertNoPollingActivation(database, input.entryId);
      if (database.prepare("SELECT 1 FROM agent_room_moves WHERE agent_id=? AND phase NOT IN ('active','failed') LIMIT 1").get(input.entryId)) {
        throw new Error("Finish the room move before restarting this agent.");
      }
      const current = this.readEntryFromDatabase(database, input.entryId);
      if (current?.turn_control && current.turn_control.status !== "completed") {
        throw new Error("Resolve the pending turn control before restarting this agent.");
      }
      return prepareRuntimeRecovery(database, input, current);
    }, commitFence);
    return { generation: result.generation, record: result.value };
  },

  async prepareRetiredRuntimePlan(request: RuntimeRestartRequest, supplied: RetiredRuntimeEvidence[] = [], identity?: ProcessIdentity) {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      return prepareRetiredRuntimePlan(database, request, this.readEntryFromDatabase(database, request.entryId), supplied, identity);
    });
  },

  async checkpointRuntimeStopped(operationId: string, commitFence: (commit: () => Promise<void>) => Promise<void>, retired?: RetiredRuntimePlan, identity?: ProcessIdentity) {
    return this.writeOperationalJournal(database => {
      const record = readRuntimeRecovery(database, operationId);
      const entry = record ? this.readEntryFromDatabase(database, record.agent_id) : undefined;
      if (record?.phase === "prepared" && entry && retired) archiveRetiredRuntimes(database, {
        operationId, entryId: record.agent_id, roomId: record.room_id, executionGenerationId: record.execution_generation_id,
        runtimeGenerationId: record.runtime_generation_id, mode: record.mode,
      }, entry, retired, identity);
      return checkpointRuntimeStopped(database, operationId, entry);
    }, commitFence);
  },

  /** Archive what the agent's exited runtimes left unfinished in its execution record; see the journal. */
  async archiveExitedRuntimes(agentId: string, commitFence: (commit: () => Promise<void>) => Promise<void>, identity?: ProcessIdentity): Promise<string[]> {
    // Asked on every convergence pass, and nearly always with nothing to do: look before taking the write lock.
    const database = await this.getDatabase();
    if (!exitedRuntimesToArchive(database, this.readEntryFromDatabase(database, agentId), identity).length) return [];
    return this.writeOperationalJournal(current => archiveExitedRuntimes(current, this.readEntryFromDatabase(current, agentId), identity), commitFence);
  },

  async completeRuntimeRecovery(operationId: string, commitFence: (commit: () => Promise<void>) => Promise<void>) {
    return this.writeOperationalJournal(database => {
      const record = readRuntimeRecovery(database, operationId);
      if (!record || record.phase === "prepared") throw new Error("The old runtime has not been proven stopped.");
      const entry = this.readEntryFromDatabase(database, record.agent_id);
      if (!entry || entry.room_id !== record.room_id || entry.desired_state !== "running"
        || (record.mode === "fresh" ? entry.provider_ref != null : entry.provider_ref?.execution_generation_id !== record.execution_generation_id)) {
        throw new Error("The replacement runtime intent changed before recovery completed.");
      }
      database.prepare("UPDATE agent_runtime_recoveries SET phase='complete',updated_at=? WHERE operation_id=?")
        .run(new Date().toISOString(), operationId);
    }, commitFence);
  },
});
