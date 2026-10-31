/**
 * Turn-control preparation, target checkpoints and commit.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import { randomUUID } from "node:crypto";
import { sameProviderActionConnectionSnapshot } from "../provider-action-port.js";
import { assertNoPollingActivation } from "../custodial-polling-activation.js";
import { assertNoDeliveryDrain } from "../delivery-drain.js";
import { pruneSupervisedAgentHistory, readDurableNativeFailure, settleSupervisedTerminalItem } from "../supervised-agent-history-retention.js";
import { projectDaemonManifestEntry } from "../manifest-entry-projection.js";
import type { DaemonAgentDeliveryMode, DaemonManifestEntry, DaemonProviderConnection, DaemonTurnControlEffect } from "../types.js";
import { type Row, ManifestConflictError, nullableString, canonicalManifestEntry, run, storeMethods } from "./shared.js";

export const turnControl = storeMethods({
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
  },

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
  },

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
  },
});
