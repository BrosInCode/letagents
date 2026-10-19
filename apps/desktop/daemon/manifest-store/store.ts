/**
 * The ManifestStore class: fields, constructor, ensureDatabase, and the method composition.
 *
 * Modules:
 * - entry-reads.ts: Manifest and entry reads, runtime lifecycle authority, and typed lifecycle effects.
 * - approvals.ts: Execution approvals, host tool rules, managed-runtime checks and execution delegation.
 * - delivery-and-polling.ts: Delivery drains, agent configuration reads, live sharing, and custodial polling activation and offers.
 * - room-moves-and-purges.ts: Room-move and purge journals.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import { PreparedReadStatements } from "../prepared-reads.js";
import type { ProcessIdentity } from "../process-identity.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { chmod, readFile, rename } from "node:fs/promises";
import { DaemonStateSchema, openDaemonStateDatabase, openPreparedDaemonStateDatabase } from "../daemon-state-database.js";
import { sameProviderActionConnectionSnapshot } from "../provider-action-port.js";
import { prepareRetiredRuntimePlan, archiveRetiredRuntimes, archiveExitedRuntimes, exitedRuntimesToArchive, type RetiredRuntimeEvidence, type RetiredRuntimePlan, prepareRuntimeRecovery, checkpointRuntimeStopped, readRuntimeRecovery, recordInterruptedCursorRecovery, type RuntimeRestartRequest, type RuntimeRecoveryRecord } from "../runtime-recovery-journal.js";
import { assertNoPollingActivation } from "../custodial-polling-activation.js";
import { assertNoDeliveryDrain } from "../delivery-drain.js";
import { MAX_PROJECTED_COMPLETED_ACTION_IDS } from "../reconciler-state.js";
import { STATE_WATCH_ACTIVITY_SUMMARY_LIMIT } from "../state-watch-projection.js";
import { cancelInterruptedSupervisedTurn, pruneSupervisedAgentHistory, readDurableNativeFailure, settleSupervisedTerminalItem } from "../supervised-agent-history-retention.js";
import type { SupervisedProviderTurnBinding } from "../supervised-agent-inbox-store.js";
import { composeDaemonManifestEntry, projectDaemonManifestEntry, type DaemonManifestDomainProjection } from "../manifest-entry-projection.js";
import { executionRuntimeStorageIdentity, materializeRuntimeIdentity } from "../execution-shadow-store.js";
import { lifecycleAuthorityProviderSchema, type LifecycleAuthorityMode } from "../lifecycle-authority-mode.js";
import type { DaemonActivityEvent, DaemonAgentConfiguration, DaemonAgentDeliveryMode, DaemonManifest, DaemonManifestEntry, DaemonProviderConnection, DaemonProviderRuntimeReference, DaemonTurnControlEffect, ExecutionTerminalPayload, ReconciliationNotice, ReconciliationState } from "../types.js";
import { type StoredManifest, type Row, type ActivityRuntimeUpdate, type ActivityWrite, type CommittedActivityWrite, type StoredAgentConfiguration, liveSharingState, type PreMembershipRoomMoveCancellation, ManifestConflictError, checksum, bool, nullableString, nullableNumber, json, parseJson, activityEventFromRow, committedActivityEvent, importedWithoutHomeHarness, canonicalManifestEntry, run, MANIFEST_READS } from "./shared.js";
import { entryReads } from "./entry-reads.js";
import { approvals } from "./approvals.js";
import { deliveryAndPolling } from "./delivery-and-polling.js";
import { roomMovesAndPurges } from "./room-moves-and-purges.js";

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
  }

  readEntryFromDatabase(database: DatabaseSync, agentId: string, activityMode: "full" | "summary" = "full"): DaemonManifestEntry | undefined {
    const row = this.reads.get(database, "entry").get(agentId) as Row | undefined;
    return row ? composeDaemonManifestEntry(this.projectionFromRow(database, row, activityMode)) : undefined;
  }

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
  }

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
  }

  /**
   * Atomically install an accepted turn-control barrier and classify the exact
   * FIFO head at that same SQLite boundary. If claimHead won first, the journal
   * links that already-admitted row; if this transaction wins first, a pending
   * row remains unlinked and the journal barrier prevents it from starting.
   */
  async getRuntimeRecovery(operationId: string): Promise<RuntimeRecoveryRecord | null> {
    return readRuntimeRecovery(await this.getDatabase(), operationId);
  }

  async pendingRuntimeRecovery(agentId: string): Promise<RuntimeRecoveryRecord | null> {
    return this.reads.get(await this.getDatabase(), "pendingRuntimeRecovery").get(agentId) as RuntimeRecoveryRecord | undefined ?? null;
  }

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
  }

  async prepareRetiredRuntimePlan(request: RuntimeRestartRequest, supplied: RetiredRuntimeEvidence[] = [], identity?: ProcessIdentity) {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      return prepareRetiredRuntimePlan(database, request, this.readEntryFromDatabase(database, request.entryId), supplied, identity);
    });
  }

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
  }

  /** Archive what the agent's exited runtimes left unfinished in its execution record; see the journal. */
  async archiveExitedRuntimes(agentId: string, commitFence: (commit: () => Promise<void>) => Promise<void>, identity?: ProcessIdentity): Promise<string[]> {
    // Asked on every convergence pass, and nearly always with nothing to do: look before taking the write lock.
    const database = await this.getDatabase();
    if (!exitedRuntimesToArchive(database, this.readEntryFromDatabase(database, agentId), identity).length) return [];
    return this.writeOperationalJournal(current => archiveExitedRuntimes(current, this.readEntryFromDatabase(current, agentId), identity), commitFence);
  }

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
  }

  async prepareTurnControlState(
    expectedGeneration: number,
    input: {
      agentId: string;
      roomId: string;
      expectedInboxItemId: string;
      expectedSourceMessageId: string;
      expectedProviderTurnId: string;
      actionId: string;
      actionSequence: number;
      workAttemptId: string;
      executionGenerationId: string;
      providerContinuationId: string;
      providerConnection: DaemonProviderConnection | null;
      deliveryMode: DaemonAgentDeliveryMode;
      hasCorrection: boolean;
      correctionText: string | null;
      correctionStrategy: "native" | "stop_then_resend" | null;
      capability: DaemonTurnControlEffect["capability"];
      recordedAt: string;
    },
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry; linkedInboxItemId: string | null; providerTurnId: string | null; linkedState: string | null }> {
    if (!Number.isSafeInteger(input.actionSequence) || input.actionSequence < 1) {
      throw new Error("Turn-control preparation requires a positive exact action sequence.");
    }
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const current = this.readEntryFromDatabase(database, input.agentId);
      assertNoDeliveryDrain(database, input.agentId);
      assertNoPollingActivation(database, input.agentId);
      if (!current
        || current.room_id !== input.roomId
        || current.desired_state !== "running"
        || current.condition !== "none"
        || current.work_attempt_id !== input.workAttemptId
        || current.provider_ref?.execution_generation_id !== input.executionGenerationId
        || current.provider_ref.provider_continuation_id !== input.providerContinuationId
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, input.providerConnection)
        || (current.delivery_mode ?? "mcp_polling") !== input.deliveryMode) {
        throw new ManifestConflictError("Turn-control preparation lost its exact execution authority.");
      }
      if (database.prepare("SELECT 1 FROM agent_room_moves WHERE agent_id=? AND phase NOT IN ('active','failed') LIMIT 1").get(input.agentId)) {
        throw new ManifestConflictError("Turn-control preparation is blocked by a pending room move.");
      }
      if (current.delivery_cutover) {
        throw new ManifestConflictError("Turn-control preparation is blocked by an unresolved delivery cutover.");
      }
      const existing = current.turn_control;
      if (existing?.action_id === input.actionId) {
        if (existing.work_attempt_id !== input.workAttemptId
          || existing.execution_generation_id !== input.executionGenerationId
          || existing.target_room_id !== input.roomId
          || existing.target_source_message_id !== input.expectedSourceMessageId
          || existing.target_provider_continuation_id !== input.providerContinuationId
          || existing.inbox_item_id !== input.expectedInboxItemId
          || existing.provider_turn_id !== input.expectedProviderTurnId
          || existing.action_sequence !== input.actionSequence
          || existing.has_correction !== input.hasCorrection
          || (existing.correction_text ?? null) !== input.correctionText
          || (existing.correction_strategy ?? null) !== input.correctionStrategy
          || existing.status !== "retryable") {
          throw new ManifestConflictError("Turn-control action id was reused with different or non-retryable authority.");
        }
      } else if (existing && existing.status !== "completed") {
        throw new ManifestConflictError(`Turn control action '${existing.action_id}' is unresolved.`);
      }
      const watermarkRow = database.prepare("SELECT last_sequence FROM turn_control_sequence_watermarks WHERE agent_id=?")
        .get(input.agentId) as Row | undefined;
      const lastSequence = watermarkRow ? Number(watermarkRow.last_sequence) : 0;
      if (existing?.action_id === input.actionId) {
        if (input.actionSequence !== lastSequence) {
          throw new ManifestConflictError("Turn-control retry no longer owns the latest exact action sequence.");
        }
      } else {
        if (input.actionSequence !== lastSequence + 1) {
          throw new ManifestConflictError("Turn-control action sequence must be the exact next durable value.");
        }
        run(database.prepare(`INSERT INTO turn_control_sequence_watermarks(agent_id,last_sequence) VALUES (?,?)
          ON CONFLICT(agent_id) DO UPDATE SET last_sequence=excluded.last_sequence`), input.agentId, input.actionSequence);
      }

      if (current.delivery_mode !== "daemon_inbox") {
        throw new ManifestConflictError("Turn control requires a daemon-owned exact room turn.");
      }
      const linkedRow = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?")
        .get(input.expectedInboxItemId) as Row | undefined;
      const linkedState = linkedRow ? String(linkedRow.state) : null;
      if (!linkedRow
        || String(linkedRow.agent_id) !== input.agentId
        || String(linkedRow.room_id) !== input.roomId
        || String(linkedRow.source_message_id) !== input.expectedSourceMessageId
        || nullableString(linkedRow.provider_turn_id) !== input.expectedProviderTurnId) {
        throw new ManifestConflictError("Turn control lost the exact room message and provider turn selected by the operator.");
      }
      const turnBinding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
        .get(input.expectedInboxItemId) as Row | undefined;
      if (!turnBinding
        || String(turnBinding.agent_id) !== input.agentId
        || String(turnBinding.room_id) !== input.roomId
        || String(turnBinding.work_attempt_id) !== input.workAttemptId
        || String(turnBinding.origin_execution_generation_id) !== input.executionGenerationId
        || String(turnBinding.provider_continuation_id) !== input.providerContinuationId
        || String(turnBinding.provider_turn_id) !== input.expectedProviderTurnId) {
        throw new ManifestConflictError("Turn control lost the durable authority binding for its exact provider turn.");
      }
      // This transaction is the Stop/correction admission edge. Whichever
      // journal wins first owns the turn: effects not yet authorized to run
      // are failed here, while already-executing effects remain completable.
      run(database.prepare(`UPDATE supervised_agent_effects
        SET state='failed',error='The exact room turn was fenced by human turn control before this effect was authorized.',updated_at=?
        WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=? AND state='prepared' AND tool_name<>'join_room'`),
      input.recordedAt, input.agentId, String(turnBinding.origin_execution_generation_id), input.expectedProviderTurnId);
      const retryingExactAction = existing?.action_id === input.actionId;
      const terminalOrPublishing = Boolean(readDurableNativeFailure(database, input.expectedInboxItemId))
        || ["publishing", "acknowledged", "acknowledged_no_reply", "cancelled_by_user"].includes(linkedState ?? "");
      if (!retryingExactAction || !terminalOrPublishing) {
        const head = database.prepare(`SELECT inbox_item_id FROM supervised_agent_inbox
          WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
          ORDER BY fifo_sequence LIMIT 1`).get(input.agentId) as Row | undefined;
        if (!head || String(head.inbox_item_id) !== input.expectedInboxItemId
          || !["dispatching", "awaiting_result"].includes(linkedState ?? "")) {
          throw new ManifestConflictError("The selected room turn is no longer the active FIFO invocation.");
        }
      }
      const linkedInboxItemId = input.expectedInboxItemId;
      const providerTurnId = input.expectedProviderTurnId;
      const recordedAt = existing?.action_id === input.actionId ? existing.recorded_at : input.recordedAt;
      const normalized = canonicalManifestEntry({
        ...current,
        turn_control: {
          ...(existing?.action_id === input.actionId ? existing : {}),
          action_id: input.actionId,
          action_sequence: input.actionSequence,
          work_attempt_id: input.workAttemptId,
          execution_generation_id: input.executionGenerationId,
          target_room_id: input.roomId,
          target_source_message_id: input.expectedSourceMessageId,
          target_provider_continuation_id: input.providerContinuationId,
          inbox_item_id: linkedInboxItemId,
          provider_turn_id: providerTurnId,
          has_correction: input.hasCorrection,
          correction_text: input.correctionText,
          correction_strategy: input.correctionStrategy,
          operator_resolution: null,
          status: "prepared",
          capability: input.capability,
          interrupted: null,
          resumed: null,
          state: null,
          stages: [],
          error: null,
          recorded_at: recordedAt,
          updated_at: input.recordedAt,
        },
      });
      const order = database.prepare("SELECT sort_order FROM agent_identities WHERE agent_id=?").get(input.agentId) as Row;
      const configuration = database.prepare("SELECT * FROM agent_configurations WHERE agent_id=?").get(input.agentId) as Row;
      const projection = projectDaemonManifestEntry(normalized);
      this.preserveInspectorConfiguration(projection, configuration);
      run(database.prepare("DELETE FROM agent_identities WHERE agent_id=?"), input.agentId);
      this.insertProjection(database, projection, Number(order.sort_order));
      pruneSupervisedAgentHistory(database, input.agentId, () => input.recordedAt);
      const persisted = this.readEntryFromDatabase(database, input.agentId);
      if (!persisted) throw new Error("Turn-control entry disappeared during atomic preparation.");
      return { entry: persisted, linkedInboxItemId, providerTurnId, linkedState: linkedRow ? String(linkedRow.state) : null };
    }, commitFence);
    return { generation: result.generation, ...result.value };
  }

  /**
   * Atomically bind an accepted control action to the one native turn it may
   * ever address. A linked daemon-inbox row receives the same identity in the
   * same transaction, so retry cannot split journal and FIFO authority.
   */
  async checkpointTurnControlTarget(
    expectedGeneration: number,
    input: {
      agentId: string;
      roomId: string;
      actionId: string;
      workAttemptId: string;
      executionGenerationId: string;
      providerContinuationId: string;
      providerConnection: DaemonProviderConnection | null;
      deliveryMode: DaemonAgentDeliveryMode;
      providerTurnId: string;
      observedAt: string;
    },
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry }> {
    if (!input.providerTurnId.trim()) throw new Error("Turn-control target checkpoint requires an exact provider turn id.");
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const current = this.readEntryFromDatabase(database, input.agentId);
      const control = current?.turn_control;
      if (!current
        || current.room_id !== input.roomId
        || current.desired_state !== "running"
        || current.condition !== "none"
        || current.work_attempt_id !== input.workAttemptId
        || current.provider_ref?.execution_generation_id !== input.executionGenerationId
        || current.provider_ref.provider_continuation_id !== input.providerContinuationId
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, input.providerConnection)
        || (current.delivery_mode ?? "mcp_polling") !== input.deliveryMode
        || !control
        || control.action_id !== input.actionId
        || control.work_attempt_id !== input.workAttemptId
        || control.execution_generation_id !== input.executionGenerationId
        || control.status !== "prepared"
        || (control.provider_turn_id && control.provider_turn_id !== input.providerTurnId)) {
        throw new ManifestConflictError("Turn-control target checkpoint lost its exact prepared authority.");
      }
      if (control.inbox_item_id) {
        const linked = database.prepare("SELECT agent_id,room_id,state,provider_turn_id FROM supervised_agent_inbox WHERE inbox_item_id=?")
          .get(control.inbox_item_id) as Row | undefined;
        const binding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
          .get(control.inbox_item_id) as Row | undefined;
        if (!linked
          || String(linked.agent_id) !== input.agentId
          || String(linked.room_id) !== input.roomId
          || ["acknowledged", "acknowledged_no_reply", "acknowledged_failed", "cancelled_by_room_move", "cancelled_by_user"].includes(String(linked.state))
          || (nullableString(linked.provider_turn_id) && nullableString(linked.provider_turn_id) !== input.providerTurnId)) {
          throw new ManifestConflictError("Turn-control target checkpoint lost its exact linked FIFO invocation.");
        }
        if (!nullableString(linked.provider_turn_id)) {
          run(database.prepare("UPDATE supervised_agent_inbox SET provider_turn_id=?,updated_at=? WHERE inbox_item_id=?"),
            input.providerTurnId, input.observedAt, control.inbox_item_id);
          run(database.prepare(`INSERT INTO supervised_agent_provider_turn_bindings
            (inbox_item_id,agent_id,room_id,work_attempt_id,origin_execution_generation_id,provider_continuation_id,provider_turn_id)
            VALUES (?,?,?,?,?,?,?)`), control.inbox_item_id, input.agentId, input.roomId, input.workAttemptId,
          input.executionGenerationId, input.providerContinuationId, input.providerTurnId);
        } else if (!binding
          || String(binding.agent_id) !== input.agentId
          || String(binding.room_id) !== input.roomId
          || String(binding.work_attempt_id) !== input.workAttemptId
          || String(binding.origin_execution_generation_id) !== input.executionGenerationId
          || String(binding.provider_continuation_id) !== input.providerContinuationId
          || String(binding.provider_turn_id) !== input.providerTurnId) {
          throw new ManifestConflictError("Turn-control target checkpoint found a different or unverifiable provider-turn authority binding.");
        }
      }
      const normalized = canonicalManifestEntry({
        ...current,
        turn_control: { ...control, provider_turn_id: input.providerTurnId, updated_at: input.observedAt },
      });
      const order = database.prepare("SELECT sort_order FROM agent_identities WHERE agent_id=?").get(input.agentId) as Row;
      const configuration = database.prepare("SELECT * FROM agent_configurations WHERE agent_id=?").get(input.agentId) as Row;
      const projection = projectDaemonManifestEntry(normalized);
      this.preserveInspectorConfiguration(projection, configuration);
      run(database.prepare("DELETE FROM agent_identities WHERE agent_id=?"), input.agentId);
      this.insertProjection(database, projection, Number(order.sort_order));
      const persisted = this.readEntryFromDatabase(database, input.agentId);
      if (!persisted) throw new Error("Turn-control entry disappeared during exact target checkpoint.");
      return persisted;
    }, commitFence);
    return { generation: result.generation, entry: result.value };
  }

  /**
   * Commit the durable half of turn control as one state-machine transition.
   * Publication arbitration, exact-row cancellation/recovery, correction
   * enqueue, and the manifest journal either all commit or none do. Provider
   * wake/abort is deliberately outside and must happen only after this returns.
   */
  async commitTurnControlState(
    expectedGeneration: number,
    input: {
      agentId: string;
      roomId: string;
      actionId: string;
      workAttemptId: string;
      executionGenerationId: string;
      mode: "native_applied" | "operator_applied" | "operator_not_applied" | "runtime_recovered";
      settleOriginal: boolean;
      activateCorrection: boolean;
      observedAt: string;
    },
    buildEntry: (
      current: DaemonManifestEntry,
      outcome: { original: "cancelled" | "publication_won" | "terminal_won" | "resumed" | "none"; inboxItemId: string | null; correctionInboxItemId: string | null; providerTurnId: string | null },
    ) => DaemonManifestEntry,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry; original: "cancelled" | "publication_won" | "terminal_won" | "resumed" | "none"; correctionInboxItemId: string | null; providerTurnId: string | null }> {
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const current = this.readEntryFromDatabase(database, input.agentId);
      const control = current?.turn_control;
      const exactExecution = current
        ? database.prepare("SELECT terminal_json FROM work_attempt_executions WHERE work_attempt_id=? AND execution_generation_id=?")
          .get(input.workAttemptId, input.executionGenerationId) as Row | undefined
        : undefined;
      const historicalTerminalResolution = Boolean(
        exactExecution?.terminal_json !== null
        && exactExecution?.terminal_json !== undefined
        && ["runtime_recovered", "operator_applied", "operator_not_applied"].includes(input.mode),
      );
      const runtimeRecoveryHasTerminalEvidence = input.mode !== "runtime_recovered"
        || exactExecution?.terminal_json !== null && exactExecution?.terminal_json !== undefined;
      const permittedStatus = control
        && (["dispatching", "uncertain", "retryable"].includes(control.status)
          || (control.status === "prepared"
            && ((input.mode === "native_applied" && !input.settleOriginal) || input.mode === "runtime_recovered")));
      if (!current
        || current.room_id !== input.roomId
        || current.work_attempt_id !== input.workAttemptId
        || (current.provider_ref?.execution_generation_id !== input.executionGenerationId
          && !historicalTerminalResolution)
        || !control
        || control.action_id !== input.actionId
        || control.work_attempt_id !== input.workAttemptId
        || control.execution_generation_id !== input.executionGenerationId
        || !runtimeRecoveryHasTerminalEvidence
        || !permittedStatus) {
        throw new ManifestConflictError("Turn-control commit lost its exact durable action authority.");
      }
      if (database.prepare("SELECT 1 FROM agent_room_moves WHERE agent_id=? AND phase NOT IN ('active','failed') LIMIT 1").get(input.agentId)) {
        throw new ManifestConflictError("Turn-control commit is blocked by a pending room move.");
      }

      let linkedRow = control.inbox_item_id
        ? database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(control.inbox_item_id) as Row | undefined
        : undefined;
      if (control.inbox_item_id && (!linkedRow
        || String(linkedRow.agent_id) !== input.agentId
        || String(linkedRow.room_id) !== input.roomId
        || (control.provider_turn_id && nullableString(linkedRow.provider_turn_id) !== control.provider_turn_id))) {
        throw new ManifestConflictError("Turn-control commit lost its exact linked FIFO invocation.");
      }
      const linkedState = linkedRow ? String(linkedRow.state) : null;
      const linkedProviderTurnId = linkedRow ? nullableString(linkedRow.provider_turn_id) : null;
      const linkedNativeFailure = linkedRow
        ? readDurableNativeFailure(database, String(linkedRow.inbox_item_id))
        : null;
      let durableOutcomeKind: "reply" | "no_reply" | null = null;
      if (linkedRow?.outcome) {
        try {
          const parsed = JSON.parse(String(linkedRow.outcome)) as { kind?: unknown; text?: unknown };
          if (parsed.kind === "reply" && typeof parsed.text === "string" && parsed.text.trim()) durableOutcomeKind = "reply";
          else if (parsed.kind === "no_reply") durableOutcomeKind = "no_reply";
        } catch { /* Invalid legacy outcome is not authority. */ }
      }
      const linkedHasPublicationOnlyOutcome = durableOutcomeKind !== null;
      const linkedIsTerminal = linkedState !== null
        && (linkedHasPublicationOnlyOutcome || linkedNativeFailure !== null
          || ["publishing", "acknowledged", "acknowledged_no_reply", "cancelled_by_room_move", "cancelled_by_user"].includes(linkedState));
      const linkedWasV16MigrationCancelled = Boolean(linkedRow
        && linkedState === "cancelled_by_user"
        && database.prepare(`SELECT 1 FROM supervised_agent_inbox_events
          WHERE inbox_item_id=? AND idempotency_key='v16_missing_authority_cancelled' LIMIT 1`)
          .get(String(linkedRow.inbox_item_id)));
      // Only a nonterminal row carrying a native turn can be made recoverable
      // by "not applied". Bind that decision to the turn's immutable origin
      // scope; publication-only, unlinked legacy, and proven pre-native rows
      // perform no provider recovery and therefore need no continuation gate.
      if (input.mode === "operator_not_applied" && linkedRow && linkedProviderTurnId && !linkedIsTerminal) {
        const binding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
          .get(String(linkedRow.inbox_item_id)) as Row | undefined;
        if (!binding
          || String(binding.agent_id) !== input.agentId
          || String(binding.room_id) !== input.roomId
          || String(binding.work_attempt_id) !== input.workAttemptId
          || String(binding.origin_execution_generation_id) !== input.executionGenerationId
          || String(binding.provider_turn_id) !== linkedProviderTurnId
          || String(binding.provider_continuation_id) !== current.provider_ref?.provider_continuation_id) {
          throw new ManifestConflictError("Not-applied resolution cannot recover through a different or unverifiable provider-turn authority binding.");
        }
      }
      // Never infer an old journal's target from whichever FIFO row happens to
      // be first now. Predecessor versions did not persist inbox_item_id, and
      // A may have settled before B acquired the head. Historical resolution
      // can retire the control barrier, but it may mutate a FIFO row only when
      // the journal carries that row's exact durable identity.
      if (linkedRow && !["acknowledged", "acknowledged_no_reply", "acknowledged_failed", "cancelled_by_room_move", "cancelled_by_user"].includes(String(linkedRow.state))) {
        const head = database.prepare(`SELECT inbox_item_id FROM supervised_agent_inbox
          WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
          ORDER BY fifo_sequence LIMIT 1`).get(input.agentId) as Row | undefined;
        if (!head || String(head.inbox_item_id) !== String(linkedRow.inbox_item_id)) {
          throw new ManifestConflictError("Turn-control commit target is no longer the exact FIFO head.");
        }
      }
      const requiresCorrectionActivation = control.correction_strategy === "stop_then_resend";
      if (input.mode !== "operator_not_applied" && input.activateCorrection !== requiresCorrectionActivation) {
        throw new ManifestConflictError("Turn-control completion does not match its durable correction strategy.");
      }
      if (control.has_correction
        && (!control.correction_text?.trim() || !control.correction_strategy)
        && input.mode !== "operator_not_applied"
        && input.mode !== "runtime_recovered") {
        throw new ManifestConflictError("Turn-control correction semantics were not durably prepared.");
      }

      let original: "cancelled" | "publication_won" | "terminal_won" | "resumed" | "none" = "none";
      if (linkedRow && String(linkedRow.state) === "cancelled_by_room_move") {
        throw new ManifestConflictError("Turn-control target was cancelled by a committed room move.");
      } else if (linkedRow && String(linkedRow.state) === "cancelled_by_user") {
        if (input.mode === "operator_not_applied" && !linkedWasV16MigrationCancelled) {
          throw new ManifestConflictError("A cancelled turn cannot be recovered by marking its native control not applied.");
        }
        // v16 fail-closed migration cancelled active legacy rows whose native
        // turn binding could not be proven. An operator may still retire the
        // matching uncertain journal as not applied, but that decision must
        // never resurrect or replay the synthetically-cancelled provider turn.
        original = "cancelled";
      } else if (linkedRow && durableOutcomeKind === "reply") {
        const state = String(linkedRow.state);
        if (!["publishing", "acknowledged"].includes(state)) {
          run(database.prepare(`UPDATE supervised_agent_inbox
            SET state='pending',last_error=NULL,failure_code=NULL,blocked_by_inbox_item_id=NULL,
                next_attempt_at_ms=NULL,acknowledged_at=NULL,updated_at=? WHERE inbox_item_id=?`),
          input.observedAt, String(linkedRow.inbox_item_id));
        }
        // Terminal provider truth always beats an uncertain native interrupt.
        // The stable client id makes publication safe to resume exactly once.
        original = "publication_won";
      } else if (linkedRow && durableOutcomeKind === "no_reply") {
        if (String(linkedRow.state) !== "acknowledged_no_reply") {
          run(database.prepare(`UPDATE supervised_agent_inbox
            SET state='acknowledged_no_reply',last_error=NULL,failure_code=NULL,
                blocked_by_inbox_item_id=NULL,next_attempt_at_ms=NULL,updated_at=?,acknowledged_at=?
            WHERE inbox_item_id=?`), input.observedAt, input.observedAt, String(linkedRow.inbox_item_id));
        }
        original = "publication_won";
      } else if (linkedRow && linkedNativeFailure !== null) {
        // Exact native failure is terminal authority, not proof that Stop
        // cancelled anything or that a reply was published. Never resurrect
        // the original prompt when resolving an uncertain native control.
        if (String(linkedRow.state) !== "acknowledged_failed") {
          const detail = linkedNativeFailure === "interrupted"
            ? "The provider turn was interrupted before completing this room request."
            : "The provider turn failed before completing this room request.";
          run(database.prepare(`UPDATE supervised_agent_inbox
            SET state='acknowledged_failed',last_error=?,failure_code=NULL,
                blocked_by_inbox_item_id=NULL,next_attempt_at_ms=NULL,updated_at=?,acknowledged_at=?
            WHERE inbox_item_id=?`), detail, input.observedAt, input.observedAt, String(linkedRow.inbox_item_id));
          linkedRow = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(String(linkedRow.inbox_item_id)) as Row;
        }
        original = "terminal_won";
      } else if (input.mode === "operator_not_applied" && linkedRow) {
        const state = String(linkedRow.state);
        if (["publishing", "acknowledged", "acknowledged_no_reply"].includes(state)) {
          // Publication is already the authoritative outcome. "Not applied"
          // means the native Stop did not change it, so leave it untouched.
          original = "publication_won";
        } else if (["cancelled_by_room_move", "cancelled_by_user"].includes(state)) {
          throw new ManifestConflictError("The exact turn was settled while its native control outcome was unresolved.");
        } else {
          const providerTurnId = nullableString(linkedRow.provider_turn_id);
          const cursorProvenUnstarted = current.provider === "cursor"
            && providerTurnId === null
            && Number(linkedRow.attempt_count) === 0
            && linkedRow.outcome === null
            && ["dispatching", "retryable"].includes(state);
          if (!providerTurnId && !cursorProvenUnstarted) {
            throw new ManifestConflictError("A null-turn control cannot be resumed without Cursor's pre-native checkpoint proof.");
          }
          if (!["pending", "dispatching", "awaiting_result", "result_recovery", "retryable", "blocked"].includes(state)) {
            throw new ManifestConflictError("Turn-control target is not safely recoverable.");
          }
          const linkedInboxItemId = String(linkedRow.inbox_item_id);
          // A blocked row has no active provider authority to resume. Preserve
          // its manual recovery state while completing the operator decision;
          // an accepted correction remains causally queued behind it.
          if (state !== "pending" && state !== "blocked") {
            run(database.prepare(`UPDATE supervised_agent_inbox
              SET state='pending',last_error=NULL,failure_code=NULL,blocked_by_inbox_item_id=NULL,
                  next_attempt_at_ms=NULL,updated_at=? WHERE inbox_item_id=?`), input.observedAt, linkedInboxItemId);
            const sequence = Number((database.prepare("SELECT COALESCE(MAX(event_sequence),0)+1 AS value FROM supervised_agent_inbox_events WHERE inbox_item_id=?").get(linkedInboxItemId) as Row).value);
            run(database.prepare(`INSERT INTO supervised_agent_inbox_events
              (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
              VALUES (?,?,?,?,?,?)`), linkedInboxItemId, sequence,
            `turn_control_not_applied:${control.action_id}`, "queued", input.observedAt,
            "Operator verified that the native control was not applied; recovering the exact provider turn.");
          }
          original = "resumed";
        }
      } else if (input.settleOriginal && linkedRow) {
        const state = String(linkedRow.state);
        if (["pending", "dispatching", "awaiting_result", "result_recovery", "retryable", "blocked"].includes(state)) {
          const linkedInboxItemId = String(linkedRow.inbox_item_id);
          run(database.prepare(`UPDATE supervised_agent_inbox
            SET state='cancelled_by_user',last_error='Stopped by the user.',failure_code=NULL,
                updated_at=?,acknowledged_at=? WHERE inbox_item_id=?`), input.observedAt, input.observedAt, linkedInboxItemId);
          const sequence = Number((database.prepare("SELECT COALESCE(MAX(event_sequence),0)+1 AS value FROM supervised_agent_inbox_events WHERE inbox_item_id=?").get(linkedInboxItemId) as Row).value);
          run(database.prepare(`INSERT INTO supervised_agent_inbox_events
            (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
            VALUES (?,?,?,?,?,?)`), linkedInboxItemId, sequence,
          `user_cancelled:turn_control:${control.action_id}`, "user_cancelled", input.observedAt, "Stopped by the user.");
          original = "cancelled";
        } else if (state === "publishing" || state === "acknowledged" || state === "acknowledged_no_reply") {
          original = "publication_won";
        } else if (state === "cancelled_by_user") {
          original = "cancelled";
        } else if (state === "cancelled_by_room_move") {
          throw new ManifestConflictError("Turn-control target was cancelled by a concurrent room move.");
        }
      }
      if (original === "none" && linkedRow
        && ["publishing", "acknowledged", "acknowledged_no_reply"].includes(String(linkedRow.state))) {
        original = "publication_won";
      } else if (original === "none" && linkedRow && String(linkedRow.state) === "cancelled_by_user") {
        original = "cancelled";
      }

      let correctionInboxItemId: string | null = null;
      if (input.activateCorrection) {
        const correction = control.correction_text?.trim() || null;
        if (!control.has_correction || !correction) {
          throw new ManifestConflictError("Turn-control correction payload was not durably prepared.");
        }
        let correctionPredecessor = linkedRow;
        if (!correctionPredecessor
          && current.delivery_mode === "daemon_inbox"
          && input.mode !== "native_applied") {
          // An unlinked historical journal cannot establish whether the
          // current head is old A or an already-admitted successor B. Never
          // reorder or cancel it; place the accepted correction behind it.
          correctionPredecessor = database.prepare(`SELECT * FROM supervised_agent_inbox
            WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
            ORDER BY fifo_sequence LIMIT 1`).get(input.agentId) as Row | undefined;
          if (correctionPredecessor && String(correctionPredecessor.room_id) !== input.roomId) {
            throw new ManifestConflictError("Historical turn-control correction found a current FIFO head in a different room.");
          }
        }
        if (linkedRow && ["acknowledged", "acknowledged_no_reply", "acknowledged_failed", "cancelled_by_room_move", "cancelled_by_user"].includes(String(linkedRow.state))) {
          const successor = database.prepare(`SELECT * FROM supervised_agent_inbox
            WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
            ORDER BY fifo_sequence LIMIT 1`).get(input.agentId) as Row | undefined;
          const pristinePendingSuccessor = successor
            && String(successor.state) === "pending"
            && successor.provider_turn_id === null
            && Number(successor.attempt_count) === 0
            && successor.outcome === null;
          if (successor && !pristinePendingSuccessor) {
            if (String(successor.room_id) !== input.roomId) {
              throw new ManifestConflictError("Turn-control correction found an admitted successor in a different room.");
            }
            // This shape can only come from a predecessor implementation: the
            // current atomic journal barrier never admits B after accepting the
            // control. Preserve B's already-acquired authority and queue the
            // correction immediately behind it instead of deadlocking the
            // accepted action or reordering an in-flight/blocked invocation.
            correctionPredecessor = successor;
          }
        }
        const sourceMessageId = `correction:${control.action_id}`;
        const sourceMessage = { text: correction, sender: { kind: "supervisor_correction" } };
        const activation = { decision: "activate", reason: "human_correction", addressed: true };
        const sequenceBounds = database.prepare(`SELECT
            MIN(CASE WHEN state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user') THEN fifo_sequence END) AS first_active,
            COALESCE(MAX(fifo_sequence),0) AS maximum
          FROM supervised_agent_inbox WHERE agent_id=?`).get(input.agentId) as Row;
        const insertionSequence = correctionPredecessor
          ? Number(correctionPredecessor.fifo_sequence) + 1
          : sequenceBounds.first_active === null
            ? Number(sequenceBounds.maximum) + 1
            : Number(sequenceBounds.first_active);
        const existing = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? AND room_id=? AND source_message_id=?").get(input.agentId, input.roomId, sourceMessageId) as Row | undefined;
        if (existing) {
          if (String(existing.source_message_json) !== JSON.stringify(sourceMessage)
            || String(existing.activation_json) !== JSON.stringify(activation)) {
            throw new ManifestConflictError("Turn-control action id is already bound to different correction content.");
          }
          const existingState = String(existing.state);
          if (["cancelled_by_room_move", "cancelled_by_user"].includes(existingState)) {
            throw new ManifestConflictError("Turn-control correction was cancelled before its journal could complete.");
          }
          const existingSequence = Number(existing.fifo_sequence);
          if (existingSequence !== insertionSequence
            && !["acknowledged", "acknowledged_no_reply", "acknowledged_failed"].includes(existingState)) {
            const pristinePending = existingState === "pending"
              && Number(existing.attempt_count) === 0
              && existing.provider_turn_id === null
              && existing.outcome === null;
            if (!pristinePending || existingSequence < insertionSequence) {
              throw new ManifestConflictError("Turn-control correction no longer occupies its exact causal FIFO position.");
            }
            // Recover the predecessor implementation's enqueue-before-journal
            // crash: move its untouched correction immediately behind A and
            // shift only the intervening suffix. Two positive temporary ranges
            // preserve both the UNIQUE(agent,fifo_sequence) constraint and the
            // CHECK(fifo_sequence > 0) invariant at every SQLite update step.
            const maximumSequence = Number(sequenceBounds.maximum);
            if (!Number.isSafeInteger(maximumSequence) || maximumSequence < 0 || maximumSequence > (Number.MAX_SAFE_INTEGER - 2) / 2) {
              throw new ManifestConflictError("Turn-control correction cannot safely repair its FIFO sequence.");
            }
            const parkedSequence = maximumSequence + 1;
            const temporaryOffset = parkedSequence + 1;
            run(database.prepare("UPDATE supervised_agent_inbox SET fifo_sequence=? WHERE inbox_item_id=?"), parkedSequence, String(existing.inbox_item_id));
            run(database.prepare(`UPDATE supervised_agent_inbox SET fifo_sequence=fifo_sequence+?
              WHERE agent_id=? AND fifo_sequence>=? AND fifo_sequence<?`), temporaryOffset, input.agentId, insertionSequence, existingSequence);
            run(database.prepare(`UPDATE supervised_agent_inbox SET fifo_sequence=fifo_sequence-?+1
              WHERE agent_id=? AND fifo_sequence>=? AND fifo_sequence<?`), temporaryOffset, input.agentId,
            insertionSequence + temporaryOffset, existingSequence + temporaryOffset);
            run(database.prepare("UPDATE supervised_agent_inbox SET fifo_sequence=? WHERE inbox_item_id=?"), insertionSequence, String(existing.inbox_item_id));
          }
          correctionInboxItemId = String(existing.inbox_item_id);
        } else {
          // Preserve positivity and uniqueness while inserting the correction
          // immediately after its original row (ahead of unrelated queued
          // successors). Move the suffix above the current maximum first, then
          // map it back one slot later; negative sentinels violate the schema's
          // CHECK(fifo_sequence > 0).
          const maximumSequence = Number((database.prepare("SELECT COALESCE(MAX(fifo_sequence),0) AS value FROM supervised_agent_inbox WHERE agent_id=?").get(input.agentId) as Row).value);
          if (!Number.isSafeInteger(maximumSequence) || maximumSequence < 0 || maximumSequence > (Number.MAX_SAFE_INTEGER - 1) / 2) {
            throw new ManifestConflictError("Turn-control correction cannot safely allocate another FIFO sequence.");
          }
          const temporaryOffset = maximumSequence + 1;
          run(database.prepare("UPDATE supervised_agent_inbox SET fifo_sequence=fifo_sequence+? WHERE agent_id=? AND fifo_sequence>=?"), temporaryOffset, input.agentId, insertionSequence);
          run(database.prepare("UPDATE supervised_agent_inbox SET fifo_sequence=fifo_sequence-?+1 WHERE agent_id=? AND fifo_sequence>=?"), temporaryOffset, input.agentId, insertionSequence + temporaryOffset);
          correctionInboxItemId = randomUUID();
          const actionId = `supervised-room:${input.agentId}:${input.roomId}:${sourceMessageId}:action:v1`;
          const replyId = `supervised-room:${input.agentId}:${input.roomId}:${sourceMessageId}:reply:v1`;
          run(database.prepare(`INSERT INTO supervised_agent_inbox
            (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,failure_code,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
            VALUES (?,?,?,?,?,?,?,'pending',0,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?,NULL)`),
          correctionInboxItemId, input.agentId, input.roomId, sourceMessageId, JSON.stringify(sourceMessage), JSON.stringify(activation), insertionSequence, actionId, replyId, input.observedAt, input.observedAt);
          run(database.prepare(`INSERT INTO supervised_agent_inbox_events
            (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
            VALUES (?,?,?,?,?,NULL),(?,?,?,?,?,NULL)`), correctionInboxItemId, 1, "received:0", "received", input.observedAt,
          correctionInboxItemId, 2, "queued:0", "queued", input.observedAt);
        }
      }

      const inboxItemId = linkedRow ? String(linkedRow.inbox_item_id) : control.inbox_item_id ?? null;
      const providerTurnId = linkedRow
        ? nullableString(linkedRow.provider_turn_id) ?? control.provider_turn_id ?? null
        : control.provider_turn_id ?? null;
      const outcome = { original, inboxItemId, correctionInboxItemId, providerTurnId };
      const normalized = canonicalManifestEntry(buildEntry(current, outcome));
      if (normalized.id !== input.agentId
        || normalized.room_id !== input.roomId
        || normalized.provider !== current.provider
        || normalized.work_attempt_id !== input.workAttemptId
        || normalized.provider_ref?.work_attempt_id !== current.provider_ref?.work_attempt_id
        || normalized.provider_ref?.execution_generation_id !== current.provider_ref?.execution_generation_id
        || normalized.provider_ref?.provider_continuation_id !== current.provider_ref?.provider_continuation_id
        // This guard proves the builder preserved the durable snapshot; it is
        // not the place to re-attest a potentially legacy runtime identity.
        // `sameProviderActionConnectionSnapshot` intentionally rejects an
        // unverifiable pid/identity pair even when both inputs are identical,
        // which would make an unrelated journal completion impossible. The
        // canonical projections are JSON values, so structural equality is
        // the exact preservation check required here.
        || JSON.stringify(normalized.provider_ref?.provider_connection ?? null)
          !== JSON.stringify(current.provider_ref?.provider_connection ?? null)
        || normalized.turn_control?.action_id !== input.actionId
        || normalized.turn_control.work_attempt_id !== input.workAttemptId
        || normalized.turn_control.execution_generation_id !== input.executionGenerationId
        || (normalized.turn_control.inbox_item_id ?? null) !== inboxItemId
        || (normalized.turn_control.provider_turn_id ?? null) !== providerTurnId
        || normalized.turn_control.has_correction !== control.has_correction
        || (normalized.turn_control.correction_text ?? null) !== (control.correction_text ?? null)
        || (normalized.turn_control.correction_strategy ?? null) !== (control.correction_strategy ?? null)
        || (input.mode.startsWith("operator_")
          && (normalized.turn_control.operator_resolution ?? null) !== (input.mode === "operator_applied" ? "applied" : "not_applied"))) {
        throw new ManifestConflictError("Turn-control completion attempted to rewrite its durable action identity.");
      }
      const order = database.prepare("SELECT sort_order FROM agent_identities WHERE agent_id=?").get(input.agentId) as Row;
      const configuration = database.prepare("SELECT * FROM agent_configurations WHERE agent_id=?").get(input.agentId) as Row;
      const projection = projectDaemonManifestEntry(normalized);
      this.preserveInspectorConfiguration(projection, configuration);
      run(database.prepare("DELETE FROM agent_identities WHERE agent_id=?"), input.agentId);
      this.insertProjection(database, projection, Number(order.sort_order));
      if (control.inbox_item_id) {
        const terminal = database.prepare(`SELECT inbox_item_id,agent_id,provider_turn_id,state
          FROM supervised_agent_inbox WHERE inbox_item_id=?`).get(control.inbox_item_id) as Row | undefined;
        if (terminal && ["acknowledged", "acknowledged_no_reply", "acknowledged_failed", "cancelled_by_room_move", "cancelled_by_user"].includes(String(terminal.state))) {
          settleSupervisedTerminalItem(database, {
            inboxItemId: String(terminal.inbox_item_id),
            agentId: String(terminal.agent_id),
            providerTurnId: nullableString(terminal.provider_turn_id),
          }, input.observedAt);
        }
      }
      pruneSupervisedAgentHistory(database, input.agentId, () => input.observedAt);
      const persisted = this.readEntryFromDatabase(database, input.agentId);
      if (!persisted) throw new Error("Turn-control entry disappeared during atomic completion.");
      return { entry: persisted, ...outcome };
    }, commitFence);
    return { generation: result.generation, ...result.value };
  }

  /**
   * Atomically bind one paused Cursor wrapper to its exact FIFO turn. Cursor
   * cannot release native work until this transaction has committed, so a
   * crash can never leave "turn started" and wrapper authority on opposite
   * sides of the durable boundary.
   */
  async checkpointCursorPreparedTurn(
    expectedGeneration: number,
    input: {
      agentId: string;
      roomId: string;
      inboxItemId: string;
      providerTurnId: string;
      providerContinuationId: string;
      workAttemptId: string;
      executionGenerationId: string;
      agentSessionId: string;
      credentialRef: string;
      apiUrl: string;
      expectedProviderContinuationId: string;
      expectedProviderConnection: DaemonProviderConnection | null;
      providerConnection: Extract<DaemonProviderConnection, { kind: "cursor_cli" }>;
      configurationRevision: number;
      requestedAuthorityMode: LifecycleAuthorityMode;
      observedAt: string;
    },
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry; authorityMode: LifecycleAuthorityMode }> {
    if (!input.providerTurnId.trim() || !input.inboxItemId.trim() || !input.providerContinuationId.trim()) {
      throw new Error("Cursor prepared-turn checkpoint requires exact inbox and provider turn ids.");
    }
    if (input.providerConnection.pid === null || !input.providerConnection.processIdentity?.trim()) {
      throw new Error("Cursor prepared-turn checkpoint requires a verified wrapper process birth.");
    }
    if (!Number.isSafeInteger(input.configurationRevision) || input.configurationRevision < 1) {
      throw new Error("Cursor prepared-turn checkpoint requires an exact applied configuration revision.");
    }
    const processPid = input.providerConnection.pid;
    const processIdentity = input.providerConnection.processIdentity;
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const entry = this.readEntryFromDatabase(database, input.agentId);
      if (!entry
        || entry.room_id !== input.roomId
        || entry.provider !== "cursor"
        || entry.desired_state !== "running"
        || entry.delivery_mode !== "daemon_inbox"
        || entry.work_attempt_id !== input.workAttemptId
        || entry.provider_ref?.work_attempt_id !== input.workAttemptId
        || entry.provider_ref.execution_generation_id !== input.executionGenerationId
        || entry.provider_ref.provider_continuation_id !== input.expectedProviderContinuationId) {
        throw new ManifestConflictError("Cursor prepared turn lost its immutable lane lease.");
      }
      const binding = database.prepare("SELECT * FROM worker_session_bindings WHERE entry_id=?").get(input.agentId) as Row | undefined;
      if (!binding
        || String(binding.room_id) !== input.roomId
        || String(binding.work_attempt_id) !== input.workAttemptId
        || String(binding.execution_generation_id) !== input.executionGenerationId
        || String(binding.agent_session_id) !== input.agentSessionId
        || String(binding.credential_ref) !== input.credentialRef
        || String(binding.api_url) !== input.apiUrl) {
        throw new ManifestConflictError("Cursor prepared turn lost its exact worker binding.");
      }
      const configuration = database.prepare(`SELECT config_revision,runtime_configuration_revision
        FROM agent_configurations WHERE agent_id=?`).get(input.agentId) as Row | undefined;
      if (!configuration
        || Number(configuration.runtime_configuration_revision) !== input.configurationRevision
        || input.configurationRevision > Number(configuration.config_revision)) {
        throw new ManifestConflictError("Cursor prepared turn lost its exact applied configuration.");
      }
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(input.inboxItemId) as Row | undefined;
      if (!row
        || String(row.agent_id) !== input.agentId
        || String(row.room_id) !== input.roomId
        || String(row.state) !== "dispatching") {
        throw new ManifestConflictError("Cursor prepared turn no longer owns the exact dispatching FIFO item.");
      }
      const head = database.prepare(`SELECT inbox_item_id FROM supervised_agent_inbox
        WHERE agent_id=? AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
        ORDER BY fifo_sequence LIMIT 1`).get(input.agentId) as Row | undefined;
      if (!head || String(head.inbox_item_id) !== input.inboxItemId) {
        throw new ManifestConflictError("Cursor prepared turn is no longer the exact FIFO head.");
      }
      const persistedTurnId = nullableString(row.provider_turn_id);
      const persistedBinding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
        .get(input.inboxItemId) as Row | undefined;
      if (persistedTurnId && persistedTurnId !== input.providerTurnId) {
        throw new ManifestConflictError("Cursor prepared turn conflicts with another durable provider turn.");
      }
      if (persistedTurnId && (!persistedBinding
        || String(persistedBinding.agent_id) !== input.agentId
        || String(persistedBinding.room_id) !== input.roomId
        || String(persistedBinding.work_attempt_id) !== input.workAttemptId
        || String(persistedBinding.origin_execution_generation_id) !== input.executionGenerationId
        || String(persistedBinding.provider_continuation_id) !== input.providerContinuationId
        || String(persistedBinding.provider_turn_id) !== input.providerTurnId)) {
        throw new ManifestConflictError("Cursor prepared turn conflicts with its durable provider-turn authority binding.");
      }
      const currentConnection = entry.provider_ref.provider_connection;
      const matchesExpected = sameProviderActionConnectionSnapshot(
        currentConnection,
        input.expectedProviderConnection,
      );
      const matchesPrepared = sameProviderActionConnectionSnapshot(
        currentConnection,
        input.providerConnection,
      );
      if (!matchesExpected && !(persistedTurnId === input.providerTurnId && matchesPrepared)) {
        throw new ManifestConflictError("Cursor prepared turn lost its expected provider-state revision.");
      }
      if (!matchesPrepared) {
        run(database.prepare(`UPDATE runtime_deployments
          SET provider_connection_kind='cursor_cli', provider_connection_url=NULL,
              provider_server_auth_path=NULL, provider_connection_pid=?,
              provider_process_identity_present=1, provider_process_identity=?
          WHERE agent_id=? AND provider_execution_generation_id=?`),
        input.providerConnection.pid, input.providerConnection.processIdentity,
        input.agentId, input.executionGenerationId);
      }
      const runtimeGenerationId = executionRuntimeStorageIdentity(input.agentId,
        input.executionGenerationId, input.providerConnection.kind,
        processPid, processIdentity);
      const authorityMode = materializeRuntimeIdentity(database, {
        agentId: input.agentId,
        executionGenerationId: input.executionGenerationId,
        runtimeGenerationId,
        provider: "cursor",
        authorityMode: input.requestedAuthorityMode,
        configRevision: input.configurationRevision,
        createdAtMs: Date.parse(input.observedAt),
      });
      if (!persistedTurnId) {
        const nextAttemptCount = Number(row.attempt_count) + 1;
        run(database.prepare(`UPDATE supervised_agent_inbox
          SET provider_turn_id=?, attempt_count=?, updated_at=?
          WHERE inbox_item_id=? AND state='dispatching' AND provider_turn_id IS NULL`),
        input.providerTurnId, nextAttemptCount, input.observedAt, input.inboxItemId);
        run(database.prepare(`INSERT INTO supervised_agent_provider_turn_bindings
          (inbox_item_id,agent_id,room_id,work_attempt_id,origin_execution_generation_id,provider_continuation_id,provider_turn_id)
          VALUES (?,?,?,?,?,?,?)`), input.inboxItemId, input.agentId, input.roomId, input.workAttemptId,
        input.executionGenerationId, input.providerContinuationId, input.providerTurnId);
        const sequence = Number((database.prepare("SELECT COALESCE(MAX(event_sequence),0)+1 AS value FROM supervised_agent_inbox_events WHERE inbox_item_id=?").get(input.inboxItemId) as Row).value);
        run(database.prepare(`INSERT INTO supervised_agent_inbox_events
          (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
          VALUES (?,?,?,?,?,NULL)`), input.inboxItemId, sequence,
        `turn_started:${nextAttemptCount}:${input.providerTurnId}`, "turn_started", input.observedAt);
      }
      const persisted = this.readEntryFromDatabase(database, input.agentId);
      if (!persisted) throw new Error("Cursor prepared-turn entry disappeared during checkpoint.");
      return { entry: persisted, authorityMode };
    }, commitFence);
    return { generation: result.generation, ...result.value };
  }

  /** CAS a later Cursor runtime edge against the exact durable inbox turn. */
  async checkpointCursorProviderState(
    expectedGeneration: number,
    input: {
      agentId: string;
      roomId: string;
      inboxItemId: string;
      providerTurnId: string;
      workAttemptId: string;
      executionGenerationId: string;
      agentSessionId: string;
      credentialRef: string;
      apiUrl: string;
      expectedProviderContinuationId: string;
      expectedProviderConnection: DaemonProviderConnection | null;
      providerContinuationId: string;
      providerConnection: Extract<DaemonProviderConnection, { kind: "cursor_cli" }>;
      observedAt: string;
    },
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry }> {
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const entry = this.readEntryFromDatabase(database, input.agentId);
      if (!entry
        || entry.room_id !== input.roomId
        || entry.provider !== "cursor"
        || entry.desired_state !== "running"
        || entry.delivery_mode !== "daemon_inbox"
        || entry.work_attempt_id !== input.workAttemptId
        || entry.provider_ref?.work_attempt_id !== input.workAttemptId
        || entry.provider_ref.execution_generation_id !== input.executionGenerationId) {
        throw new ManifestConflictError("Cursor provider-state transition lost its immutable lane lease.");
      }
      const binding = database.prepare("SELECT * FROM worker_session_bindings WHERE entry_id=?").get(input.agentId) as Row | undefined;
      if (!binding
        || String(binding.room_id) !== input.roomId
        || String(binding.work_attempt_id) !== input.workAttemptId
        || String(binding.execution_generation_id) !== input.executionGenerationId
        || String(binding.agent_session_id) !== input.agentSessionId
        || String(binding.credential_ref) !== input.credentialRef
        || String(binding.api_url) !== input.apiUrl) {
        throw new ManifestConflictError("Cursor provider-state transition lost its exact worker binding.");
      }
      const inbox = database.prepare("SELECT agent_id,room_id,state,provider_turn_id FROM supervised_agent_inbox WHERE inbox_item_id=?").get(input.inboxItemId) as Row | undefined;
      if (!inbox
        || String(inbox.agent_id) !== input.agentId
        || String(inbox.room_id) !== input.roomId
        || nullableString(inbox.provider_turn_id) !== input.providerTurnId
        || !["dispatching", "awaiting_result", "result_recovery"].includes(String(inbox.state))) {
        throw new ManifestConflictError("Cursor provider-state transition lost its exact durable turn.");
      }
      const turnBinding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?")
        .get(input.inboxItemId) as Row | undefined;
      if (!turnBinding
        || String(turnBinding.agent_id) !== input.agentId
        || String(turnBinding.room_id) !== input.roomId
        || String(turnBinding.work_attempt_id) !== input.workAttemptId
        || String(turnBinding.origin_execution_generation_id) !== input.executionGenerationId
        || String(turnBinding.provider_turn_id) !== input.providerTurnId) {
        throw new ManifestConflictError("Cursor provider-state transition lost its durable provider-turn authority binding.");
      }
      const matchesExpected = entry.provider_ref.provider_continuation_id === input.expectedProviderContinuationId
        && sameProviderActionConnectionSnapshot(entry.provider_ref.provider_connection, input.expectedProviderConnection);
      const matchesNext = entry.provider_ref.provider_continuation_id === input.providerContinuationId
        && sameProviderActionConnectionSnapshot(entry.provider_ref.provider_connection, input.providerConnection);
      const bindingMatchesExpected = String(turnBinding.provider_continuation_id) === input.expectedProviderContinuationId;
      const bindingMatchesNext = String(turnBinding.provider_continuation_id) === input.providerContinuationId;
      const control = entry.turn_control;
      const controlTargetsTurn = control?.inbox_item_id === input.inboxItemId
        && control.provider_turn_id === input.providerTurnId;
      const controlMatchesNext = !controlTargetsTurn
        || control.target_provider_continuation_id === input.providerContinuationId;
      const controlCanAdvanceFromPending = controlTargetsTurn
        && control.target_provider_continuation_id?.startsWith("cursor-pending:")
        && !input.providerContinuationId.startsWith("cursor-pending:");
      if ((!matchesExpected || !bindingMatchesExpected) && (!matchesNext || !bindingMatchesNext)) {
        throw new ManifestConflictError("Cursor provider-state transition lost its expected state revision.");
      }
      if (!controlMatchesNext && !controlCanAdvanceFromPending) {
        throw new ManifestConflictError("Cursor provider-state transition found a stale turn-control target revision.");
      }
      if (!matchesNext) {
        run(database.prepare(`UPDATE runtime_deployments
          SET provider_continuation_id=?, provider_connection_kind='cursor_cli',
              provider_connection_url=NULL, provider_server_auth_path=NULL,
              provider_connection_pid=?, provider_process_identity_present=?,
              provider_process_identity=?
          WHERE agent_id=? AND provider_execution_generation_id=?`),
        input.providerContinuationId, input.providerConnection.pid,
        Number(input.providerConnection.processIdentity !== undefined),
        input.providerConnection.processIdentity ?? null,
        input.agentId, input.executionGenerationId);
        run(database.prepare(`UPDATE supervised_agent_provider_turn_bindings
          SET provider_continuation_id=?
          WHERE inbox_item_id=? AND provider_turn_id=? AND provider_continuation_id=?`),
        input.providerContinuationId, input.inboxItemId, input.providerTurnId, input.expectedProviderContinuationId);
      }
      if (controlTargetsTurn && !controlMatchesNext && controlCanAdvanceFromPending) {
        // A human control can be admitted after the paused wrapper is bound
        // but before Cursor publishes its real session id. The runtime,
        // provider-turn binding, and that exact control target are one
        // mutable same-turn revision and must advance atomically; otherwise
        // retry and reopen would observe different authority coordinates.
        // Keep this outside `!matchesNext`: an idempotent callback also heals
        // the exact predecessor state where runtime+binding committed first.
        run(database.prepare(`UPDATE turn_control_journals
          SET target_provider_continuation_id=?,updated_at=?
          WHERE agent_id=? AND turn_control_present=1 AND inbox_item_id=?
            AND provider_turn_id=? AND target_provider_continuation_id LIKE 'cursor-pending:%'`),
        input.providerContinuationId, input.observedAt, input.agentId,
        input.inboxItemId, input.providerTurnId);
      }
      const persisted = this.readEntryFromDatabase(database, input.agentId);
      if (!persisted) throw new Error("Cursor provider-state entry disappeared during checkpoint.");
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
      run(database.prepare("DELETE FROM turn_control_sequence_watermarks WHERE agent_id=?"), agentId);
      run(database.prepare("DELETE FROM reconciliation_action_tombstones WHERE agent_id=?"), agentId);
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

  async getActivityState(agentId: string): Promise<{
    observed_state: DaemonManifestEntry["observed_state"]; last_sequence: number;
  } | undefined> {
    const database = await this.getDatabase();
    const row = this.reads.get(database, "activityState").get(agentId, agentId) as Row | undefined;
    return row ? { observed_state: String(row.observed_state) as DaemonManifestEntry["observed_state"],
      last_sequence: row.last_sequence == null ? -1 : Number(row.last_sequence) } : undefined;
  }

  /** Persist presentation detail without acquiring any runtime lifecycle field. */
  async appendActivityOnly(
    expectedGeneration: number,
    agentId: string,
    event: DaemonActivityEvent,
    limit = 200,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; entry: DaemonManifestEntry }> {
    const result = await this.writeActivity(expectedGeneration, agentId, event, null, limit,
      database => this.activityEntry(database, agentId), commitFence);
    return { generation: result.generation, entry: result.value };
  }

  /** Native stream consumers do not need a fresh full-history return value. */
  async recordActivity(
    expectedGeneration: number,
    agentId: string,
    event: DaemonActivityEvent,
    runtimeUpdate: { observedState: DaemonManifestEntry["observed_state"];
      nativeLiveness: NonNullable<DaemonManifestEntry["native_liveness"]> } | null,
    limit = 200,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number }> {
    const result = await this.writeActivity(expectedGeneration, agentId, event, runtimeUpdate, limit,
      () => undefined, commitFence);
    return { generation: result.generation };
  }

  /**
   * Writes several admitted activity events in one transaction, in the given
   * order, with one generation bump. Each event is applied exactly as
   * recordActivity applies it. An event whose entry is gone, or whose sequence
   * is no longer newer than the stored one, is skipped rather than failing the
   * other agents' events in the same batch.
   */
  async recordActivityBatch(
    expectedGeneration: number,
    items: readonly ActivityWrite[],
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
    /** Checked inside the transaction; an event of an entry it refuses is skipped. */
    mayWrite?: (agentId: string) => boolean,
  ): Promise<{ generation: number; written: number; skipped: number; events: CommittedActivityWrite[] }> {
    const normalized = items.map((item) => {
      const encoded = json(item.event);
      return { ...item, event: parseJson<DaemonActivityEvent>(encoded), bytes: encoded.length };
    });
    const result = await this.writeTargeted(expectedGeneration, (database) => {
      const written: CommittedActivityWrite[] = [];
      for (const item of normalized) {
        if (mayWrite && !mayWrite(item.agentId)) continue;
        const latest = this.reads.get(database, "lastSequence").get(item.agentId) as Row | undefined;
        if (latest && item.event.sequence <= Number(latest.sequence)) continue;
        if (!this.applyActivityRuntime(database, item.agentId, item.runtimeUpdate)) continue;
        this.appendActivityEvent(database, item.agentId, item.event, item.limit);
        written.push({ agentId: item.agentId, event: committedActivityEvent(item.event), limit: item.limit, bytes: item.bytes });
      }
      return written;
    }, commitFence);
    return { generation: result.generation, written: result.value.length,
      skipped: items.length - result.value.length, events: result.value };
  }

  applyActivityRuntime(database: DatabaseSync, agentId: string, runtimeUpdate: ActivityRuntimeUpdate | null): boolean {
    const updated = runtimeUpdate
      ? database.prepare(`UPDATE runtime_deployments
          SET observed_state = ?, native_liveness_present = 1, native_liveness_state = ?,
              native_liveness_observed_at = ?, native_liveness_detail = ?, activity_present = 1
          WHERE agent_id = ?`).run(runtimeUpdate.observedState, runtimeUpdate.nativeLiveness.state,
        runtimeUpdate.nativeLiveness.observed_at ?? null, runtimeUpdate.nativeLiveness.detail ?? null, agentId)
      : database.prepare("UPDATE runtime_deployments SET activity_present = 1 WHERE agent_id = ?").run(agentId);
    return Number(updated.changes) === 1;
  }

  activityEntry(database: DatabaseSync, agentId: string): DaemonManifestEntry {
    const persisted = this.readEntryFromDatabase(database, agentId);
    if (!persisted) throw new Error(`Daemon manifest entry disappeared during activity append: ${agentId}`);
    return persisted;
  }

  writeActivity<T>(
    expectedGeneration: number,
    agentId: string,
    event: DaemonActivityEvent,
    runtimeUpdate: { observedState: DaemonManifestEntry["observed_state"];
      nativeLiveness: NonNullable<DaemonManifestEntry["native_liveness"]> } | null,
    limit: number,
    project: (database: DatabaseSync) => T,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; value: T }> {
    const normalizedEvent = parseJson<DaemonActivityEvent>(json(event));
    return this.writeTargeted(expectedGeneration, database => {
      if (!this.applyActivityRuntime(database, agentId, runtimeUpdate)) throw new Error(`Unknown daemon manifest entry: ${agentId}`);
      this.appendActivityEvent(database, agentId, normalizedEvent, limit);
      return project(database);
    }, commitFence);
  }

  appendActivityEvent(
    database: DatabaseSync,
    agentId: string,
    event: DaemonActivityEvent,
    limit: number,
  ): void {
    const latest = this.reads.get(database, "lastSequence").get(agentId) as Row | undefined;
    const lastSequence = latest ? Number(latest.sequence) : -1;
    if (event.sequence <= lastSequence) throw new Error(`Native activity sequence ${event.sequence} is not newer than ${lastSequence}.`);
    const order = Number((database.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM activity_events WHERE agent_id = ?").get(agentId) as Row).next_order);
    run(database.prepare(`
      INSERT INTO activity_events(
        agent_id, sort_order, observed_at, sequence, provider, kind, method, summary,
        status, payload_json, payload_truncated, payload_redacted, durable_payload_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `), agentId, order, event.observed_at, event.sequence, event.provider,
    event.kind, event.method, event.summary, event.status,
    json(event.payload), Number(event.payload_truncated), Number(event.payload_redacted),
    event.durable_payload_ref);
    run(database.prepare(`
      DELETE FROM activity_events
      WHERE agent_id = ? AND sort_order NOT IN (
        SELECT sort_order FROM activity_events WHERE agent_id = ? ORDER BY sort_order DESC LIMIT ?
      )
    `), agentId, agentId, limit);
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
export interface ManifestStore extends EntryReadsMethods, ApprovalsMethods, DeliveryAndPollingMethods, RoomMovesAndPurgesMethods {}
for (const methods of [entryReads, approvals, deliveryAndPolling, roomMovesAndPurges]) {
  for (const [name, value] of Object.entries(methods)) {
    // Two modules defining one name would silently keep the later definition.
    if (name in ManifestStore.prototype) throw new Error(`ManifestStore method ${name} is defined twice.`);
    Object.defineProperty(ManifestStore.prototype, name, { value, writable: true, configurable: true, enumerable: false });
  }
}
