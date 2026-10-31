/**
 * Execution approvals, host tool rules, managed-runtime checks and execution delegation.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import { ManagedRuntimeRefreshDeferred, sameProviderActionConnectionSnapshot } from "../provider-action-port.js";
import { listHostToolRules, findHostToolRule, readHostToolContext, bindHostToolRule, assertDecisionToolRule, revokeHostToolRule, withdrawHostToolApproval, type WithdrawHostToolApproval, type HostToolRule, type HostToolScope } from "../host-tool-rules.js";
import type { DatabaseSync } from "node:sqlite";
import { beginExecutionApprovalDispatch, getExecutionApproval, loseExecutionApproval, closeExecutionApprovalRequest, witnessedRuntimeApprovalClosures, retiredRuntimeApprovals, settleWitnessedRuntimeApprovalClosures, recordExecutionApprovalOutcome, selectHostApproval, validateExecutionApprovalAuthority, readLatestExecutionApproval, listExecutionApprovals, type ApprovalAuthority, type ApprovalReference, type DispatchExecutionApproval, type ExecutionApprovalRecord, type LoseExecutionApproval, type RecordExecutionApprovalOutcome, type SelectHostApproval } from "../execution-approval-journal.js";
import { admitExecutionApprovalPlan, type ExecutionApprovalAdmission, type ExecutionApprovalAdmissionPlan } from "../execution-approval-admission.js";
import { prepareExecutionApprovalProjection, type ExecutionApprovalProjectionPreparation, type ExecutionApprovalProjectionSource, type PreparedExecutionApprovalProjection } from "../execution-approval-projection.js";
import { readExecutionApprovalProjection, type ExecutionApprovalProjectionRecord } from "../execution-approval-projection-journal.js";
import { listExecutionDelegationInstanceIds, listExecutionDelegationsForApprovalPublication, reconcileExecutionDelegation, validateExecutionDelegation, type ExecutionDelegationInventoryScope, type ExecutionDelegationReconciliation, type ExecutionApprovalPublicationDelegationScope, type LocalExecutionDelegation, type ReconcileExecutionDelegation, type ValidateExecutionDelegation } from "../execution-delegation-journal.js";
import { selectDelegatedApproval, type SelectDelegatedApproval } from "../execution-delegated-approval.js";
import { executionRuntimeStorageIdentity } from "../execution-shadow-store.js";
import type { DaemonManifestEntry, DaemonProviderConnection } from "../types.js";
import { type Row, storeMethods } from "./shared.js";

export const approvals = storeMethods({
  /** Filesystem preparation only; exact authority is revalidated at admission. */
  async prepareExecutionApprovalProjection(
    input: ExecutionApprovalProjectionPreparation,
    source: ExecutionApprovalProjectionSource,
  ): Promise<PreparedExecutionApprovalProjection> {
    const snapshot = structuredClone({ input, source });
    return prepareExecutionApprovalProjection(await this.getDatabase(), snapshot.input, snapshot.source);
  },

  /** Immutable classification and required projection settle in one fenced transaction. */
  async admitExecutionApprovalPlan(
    input: ExecutionApprovalAdmissionPlan,
    nowMs: () => number,
    commitFence: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<ExecutionApprovalAdmission> {
    if (typeof nowMs !== "function") throw new Error("Approval journal requires a transaction clock.");
    if (typeof commitFence !== "function") throw new Error("Approval journal requires a daemon ownership commit fence.");
    const snapshot = structuredClone(input);
    return this.writeOperationalJournal(db => admitExecutionApprovalPlan(
      db,
      snapshot,
      this.readEntryFromDatabase(db, snapshot.request.agentId),
      nowMs(),
    ), commitFence);
  },

  async getExecutionApproval(input: ApprovalReference): Promise<ExecutionApprovalRecord | null> {
    const snapshot = structuredClone(input);
    return getExecutionApproval(await this.getDatabase(), snapshot);
  },

  async readExecutionApprovalProjection(input: ApprovalReference): Promise<ExecutionApprovalProjectionRecord | null> {
    const snapshot = structuredClone(input);
    return readExecutionApprovalProjection(await this.getDatabase(), snapshot);
  },

  async readLatestExecutionApproval(requestId: string): Promise<ExecutionApprovalRecord | null> {
    return readLatestExecutionApproval(await this.getDatabase(), requestId);
  },

  async readManagedLaunchContract(input: {
    agentId: string; executionGenerationId: string; providerConnection: DaemonProviderConnection;
  }): Promise<string | null> {
    const connection = input.providerConnection;
    if (connection.pid === null || !connection.processIdentity) return null;
    const runtimeId = executionRuntimeStorageIdentity(input.agentId, input.executionGenerationId,
      connection.kind, connection.pid, connection.processIdentity);
    const row = (await this.getDatabase()).prepare(`SELECT contract_sha256 FROM managed_launch_contracts
      WHERE agent_id=? AND execution_generation_id=? AND runtime_generation_id=?`)
      .get(input.agentId, input.executionGenerationId, runtimeId);
    return typeof row?.contract_sha256 === "string" ? row.contract_sha256 : null;
  },

  /** Operational existence check; deliberately independent of the capped UI list. */
  async hasUnclosedRuntimeApprovals(input: {
    agentId: string; executionGenerationId: string; providerConnection: DaemonProviderConnection;
  }): Promise<boolean> {
    return this.runtimeHasUnclosedApprovals(await this.getDatabase(), structuredClone(input));
  },

  runtimeHasUnclosedApprovals(database: DatabaseSync, input: {
    agentId: string; executionGenerationId: string; providerConnection: DaemonProviderConnection;
  }): boolean {
    const connection = input.providerConnection;
    if (!input.agentId || !input.executionGenerationId
      || connection.pid === null || !connection.processIdentity) return true;
    const runtimeId = executionRuntimeStorageIdentity(input.agentId,
      input.executionGenerationId, connection.kind, connection.pid, connection.processIdentity);
    if (!database.prepare(`SELECT 1 FROM execution_runtime_generations
      WHERE agent_id=? AND execution_generation_id=? AND runtime_generation_id=?`)
      .get(input.agentId, input.executionGenerationId, runtimeId)) return true;
    return Boolean(database.prepare(`SELECT 1 FROM execution_approval_requests r
      WHERE r.agent_id=? AND r.execution_generation_id=? AND r.runtime_generation_id=?
        AND r.state IN ('requested','decision_recorded','dispatching','lost')
        AND NOT EXISTS (SELECT 1 FROM execution_approval_request_closures c
          WHERE c.request_id=r.request_id AND c.request_version=r.request_version)
      LIMIT 1`).get(input.agentId, input.executionGenerationId, runtimeId));
  },

  /** The committed manifest generation, read now. */
  async readGeneration(): Promise<number> {
    const database = await this.getDatabase();
    return Number((this.reads.get(database, "generation").get() as Row).generation);
  },

  /**
   * The daemon's batched activity: the newest runtime state of an entry's
   * admitted but uncommitted events. Durable-idle checks consult it, since a
   * pending working event is newer than the committed idle state.
   */
  setPendingActivityState(probe: ((agentId: string) => { observedState: DaemonManifestEntry["observed_state"] | null } | null) | null): void {
    this.pendingActivityState = probe;
  },

  /** Re-read durable authority synchronously at the native signal boundary. */
  async validateManagedRuntimeReplacement(input: {
    agentId: string; executionGenerationId: string; providerConnection: DaemonProviderConnection;
    configurationRevision: number; apiUrl: string; roomId: string;
    workAttemptId: string; providerContinuationId: string;
  }): Promise<() => void> {
    const snapshot = structuredClone(input);
    const database = await this.getDatabase();
    const assertCurrent = () => {
      if (this.closed || this.database !== database) throw new Error("Runtime authority store is unavailable.");
      const entry = this.readEntryFromDatabase(database, snapshot.agentId);
      const configuration = database.prepare(`SELECT config_revision,runtime_configuration_revision FROM agent_configurations WHERE agent_id=?`).get(snapshot.agentId);
      const binding = database.prepare(`SELECT room_id,work_attempt_id,execution_generation_id,api_url FROM worker_session_bindings WHERE entry_id=?`).get(snapshot.agentId);
      if (!entry || entry.room_id !== snapshot.roomId || entry.work_attempt_id !== snapshot.workAttemptId
        || entry.provider !== "codex" || entry.desired_state !== "running"
        || entry.delivery_mode !== "daemon_inbox" || entry.condition !== "none" || entry.observed_state !== "idle"
        || (this.pendingActivityState?.(snapshot.agentId)?.observedState ?? "idle") !== "idle"
        || (entry.turn_control && entry.turn_control.status !== "completed")
        || entry.provider_ref?.provider_continuation_id !== snapshot.providerContinuationId
        || entry.provider_ref?.execution_generation_id !== snapshot.executionGenerationId
        || !sameProviderActionConnectionSnapshot(entry.provider_ref.provider_connection, snapshot.providerConnection)
        || configuration?.config_revision !== snapshot.configurationRevision
        || configuration.runtime_configuration_revision !== snapshot.configurationRevision
        || binding?.room_id !== entry.room_id || binding.work_attempt_id !== entry.work_attempt_id
        || binding.execution_generation_id !== snapshot.executionGenerationId || binding.api_url !== snapshot.apiUrl
        || this.runtimeHasUnclosedApprovals(database, snapshot)) {
        throw new ManagedRuntimeRefreshDeferred("Managed runtime replacement lost its durable idle authority.");
      }
    };
    assertCurrent();
    return assertCurrent;
  },

  async listExecutionApprovals(roomId: string, limit = 64): Promise<ExecutionApprovalRecord[]> {
    return listExecutionApprovals(await this.getDatabase(), roomId, limit);
  },

  /** Recheck after native pending inspection, immediately before the exact provider response. */
  async validateExecutionApprovalAuthority(expected: ApprovalReference, authority: ApprovalAuthority): Promise<() => void> {
    const snapshot = structuredClone({ expected, authority });
    const db = await this.getDatabase();
    const assertCurrent = () => {
      if (this.closed || this.database !== db) throw new Error("Approval authority store is unavailable.");
      const entry = this.readEntryFromDatabase(db, snapshot.expected.agentId);
      validateExecutionApprovalAuthority(db, snapshot.expected, snapshot.authority, entry);
      const record = getExecutionApproval(db, snapshot.expected);
      if (record?.decision) assertDecisionToolRule(db, record.decision.decisionId, entry);
    };
    assertCurrent();
    return assertCurrent;
  },

  async readHostToolContext(workAttemptId: string) {
    return readHostToolContext(await this.getDatabase(), workAttemptId);
  },

  async listHostToolRules(ownerId: string, agentId: string): Promise<HostToolRule[]> {
    return listHostToolRules(await this.getDatabase(), ownerId, agentId);
  },

  async findHostToolRule(ownerId: string, scope: HostToolScope): Promise<HostToolRule | null> {
    return findHostToolRule(await this.getDatabase(), ownerId, scope);
  },

  async withdrawHostToolApproval(input: WithdrawHostToolApproval, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<void> {
    if (typeof commitFence !== "function") throw new Error("Approval journal requires a daemon ownership commit fence.");
    const snapshot = structuredClone(input);
    await this.writeOperationalJournal(db => {
      const record = getExecutionApproval(db, snapshot.expected);
      if (!record) throw new Error("Approval request is unavailable.");
      withdrawHostToolApproval(db, snapshot, record);
    }, commitFence);
  },

  async selectHostToolApproval(input: SelectHostApproval, rule: { scope: HostToolScope; create?: boolean; rule?: { id: string; revision: number } },
    commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<ExecutionApprovalRecord> {
    if (typeof commitFence !== "function") throw new Error("Approval journal requires a daemon ownership commit fence.");
    const snapshot = structuredClone({ input, rule });
    return this.writeOperationalJournal(db => {
      const entry = this.readEntryFromDatabase(db, snapshot.input.expected.agentId);
      if (snapshot.input.decision !== "allow_once") throw new Error("A tool rule can only select allow once.");
      const prior = getExecutionApproval(db, snapshot.input.expected);
      if (prior?.request.closedAtMs != null) throw new Error("This approval request has closed.");
      if (prior?.decision && !db.prepare("SELECT 1 FROM host_tool_rule_decisions WHERE decision_id=?").get(snapshot.input.decisionId)) {
        throw new Error("The existing decision did not create a saved tool permission.");
      }
      // A saved rule never answers on a saved edit that is not applied yet: the journal is told which path this is.
      const selected = selectHostApproval(db, snapshot.input, entry, true);
      bindHostToolRule(db, { ...snapshot.rule, decisionId: snapshot.input.decisionId, ownerId: snapshot.input.actorId,
        atMs: snapshot.input.atMs }, entry);
      return selected;
    }, commitFence);
  },

  async revokeHostToolRule(ownerId: string, agentId: string, ruleId: string, revision: number, atMs: number,
    commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<void> {
    if (typeof commitFence !== "function") throw new Error("Approval journal requires a daemon ownership commit fence.");
    await this.writeOperationalJournal(db => revokeHostToolRule(db, ownerId, agentId, ruleId, revision, atMs), commitFence);
  },

  async selectHostApproval(input: SelectHostApproval, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<ExecutionApprovalRecord> {
    if (typeof commitFence !== "function") throw new Error("Approval journal requires a daemon ownership commit fence.");
    const snapshot = structuredClone(input);
    return this.writeOperationalJournal(db => selectHostApproval(db, snapshot, this.readEntryFromDatabase(db, snapshot.expected.agentId)), commitFence);
  },

  async beginExecutionApprovalDispatch(input: DispatchExecutionApproval, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<{ dispatch: boolean; approval: ExecutionApprovalRecord }> {
    if (typeof commitFence !== "function") throw new Error("Approval journal requires a daemon ownership commit fence.");
    const snapshot = structuredClone(input);
    return this.writeOperationalJournal(db => beginExecutionApprovalDispatch(db, snapshot, this.readEntryFromDatabase(db, snapshot.expected.agentId)), commitFence);
  },

  async recordExecutionApprovalOutcome(input: RecordExecutionApprovalOutcome, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<ExecutionApprovalRecord> {
    if (typeof commitFence !== "function") throw new Error("Approval journal requires a daemon ownership commit fence.");
    const snapshot = structuredClone(input);
    return this.writeOperationalJournal(db => recordExecutionApprovalOutcome(db, snapshot), commitFence);
  },

  async closeExecutionApprovalRequest(expected: ApprovalReference, nowMs: () => number,
    commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<ExecutionApprovalRecord> {
    if (typeof commitFence !== "function" || typeof nowMs !== "function") throw new Error("Approval closure requires a clock and daemon ownership fence.");
    const snapshot = structuredClone(expected);
    // Receipt time belongs to this transaction, after any racing selection/dispatch.
    return this.writeOperationalJournal(db => closeExecutionApprovalRequest(db, { expected: snapshot, atMs: nowMs() }), commitFence);
  },

  async settleWitnessedRuntimeApprovalClosures(agentId: string, nowMs: () => number,
    commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<number> {
    if (typeof commitFence !== "function" || typeof nowMs !== "function") throw new Error("Approval closure requires a clock and daemon ownership fence.");
    // Most convergence passes have nothing to settle. Avoid taking a write lock
    // in that case; re-read all evidence under the fence when there is work.
    const pending = await this.serialize(async () => {
      const db = await this.getDatabase();
      return witnessedRuntimeApprovalClosures(db, agentId).length > 0
        || retiredRuntimeApprovals(db, agentId, nowMs(), () => this.readEntryFromDatabase(db, agentId)).length > 0;
    });
    if (!pending) return 0;
    return this.writeOperationalJournal(db => settleWitnessedRuntimeApprovalClosures(db, agentId, nowMs,
      () => this.readEntryFromDatabase(db, agentId)), commitFence);
  },

  async loseExecutionApproval(input: LoseExecutionApproval, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<ExecutionApprovalRecord> {
    if (typeof commitFence !== "function") throw new Error("Approval journal requires a daemon ownership commit fence.");
    const snapshot = structuredClone(input);
    return this.writeOperationalJournal(db => loseExecutionApproval(db, snapshot), commitFence);
  },

  /** Persist one server revision only while exact process-held host authority remains current. */
  async reconcileExecutionDelegation(
    input: ReconcileExecutionDelegation,
    assertCurrent: () => void,
    commitFence: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<ExecutionDelegationReconciliation> {
    if (typeof assertCurrent !== "function" || typeof commitFence !== "function") {
      throw new Error("Execution delegation journal requires current host authority and a daemon ownership commit fence.");
    }
    const snapshot = structuredClone(input);
    return this.writeOperationalJournal(
      (db) => {
        assertCurrent();
        return reconcileExecutionDelegation(db, snapshot, this.readEntryFromDatabase(db, snapshot.authority.agentId));
      },
      commitFence,
    );
  },

  /** Discovery only; exact server reads remain mandatory before use. */
  async listExecutionDelegationInstanceIds(
    input: ExecutionDelegationInventoryScope,
  ): Promise<string[]> {
    return listExecutionDelegationInstanceIds(await this.getDatabase(), structuredClone(input));
  },

  /** Current local delegation discovery only; publishers still exact-revalidate before upload. */
  async listExecutionDelegationsForApprovalPublication(
    input: ExecutionApprovalPublicationDelegationScope,
  ): Promise<LocalExecutionDelegation[]> {
    return listExecutionDelegationsForApprovalPublication(await this.getDatabase(), structuredClone(input));
  },

  /** Durable rows never suffice: callers must supply their current host-authority snapshot. */
  async validateExecutionDelegation(input: ValidateExecutionDelegation): Promise<LocalExecutionDelegation> {
    const snapshot = structuredClone(input);
    const db = await this.getDatabase();
    return validateExecutionDelegation(db, snapshot, this.readEntryFromDatabase(db, snapshot.agentId));
  },

  /** Record only; provider dispatch remains a separate, later authority edge. */
  async selectDelegatedApproval(
    input: Omit<SelectDelegatedApproval, "atMs">,
    nowMs: () => number,
    assertCurrent: () => void,
    commitFence: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<ExecutionApprovalRecord> {
    if (typeof nowMs !== "function" || typeof assertCurrent !== "function" || typeof commitFence !== "function") {
      throw new Error("Delegated approval selection requires current host/native authority and a daemon ownership commit fence.");
    }
    const snapshot = structuredClone(input);
    return this.writeOperationalJournal((db) => {
      assertCurrent();
      return selectDelegatedApproval(db, { ...snapshot, atMs: nowMs() }, this.readEntryFromDatabase(db, snapshot.expected.agentId));
    }, commitFence);
  },
});
