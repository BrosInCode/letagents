/**
 * Cursor prepared-turn and provider-state checkpoints.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import { sameProviderActionConnectionSnapshot } from "../provider-action-port.js";
import { executionRuntimeStorageIdentity, materializeRuntimeIdentity } from "../execution-shadow-store.js";
import type { LifecycleAuthorityMode } from "../lifecycle-authority-mode.js";
import type { DaemonManifestEntry, DaemonProviderConnection } from "../types.js";
import { type Row, ManifestConflictError, nullableString, run, storeMethods } from "./shared.js";

export const cursorTurns = storeMethods({
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
  },

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
  },
});
