/**
 * The supervisor daemon's operations: control-request handlers and the small
 * methods that forward to its coordinators.
 */
import { maintenanceStatus } from "../maintenance-service.js";
import { settleRuntimeApprovalRequests } from "../execution-approval-journal.js";
import type { DaemonCommitNotification } from "../daemon-authority.js";
import type { ProviderActionHandle, ProviderActionStreamEvent, ProviderActionTerminal } from "../provider-action-port.js";
import type { ConvergenceRequestKind } from "../provider-execution-coordinator.js";
import type { DaemonReconcileInput } from "../provider-reconciliation-coordinator.js";
import type { TerminalCommitFence } from "../provider-terminal-coordinator.js";
import type { DaemonActivityEvent, DaemonAgentStreamEvent, DaemonManifestEntry, DaemonManifestEntryView, DaemonRoomMoveRecord, ExecutionTerminalPayload, ObservedState, PolicyCondition, ReconciliationNotice } from "../types.js";
import type { WorkerSessionBinding } from "../worker-binding-store.js";
import type { SupervisedIngressAgent } from "../supervised-agent-delivery.js";
import { SupervisorDaemonState } from "./state.js";

export abstract class SupervisorDaemonOperations extends SupervisorDaemonState {
  /**
   * Retries one known blocked receipt. Every identity in the renderer request
   * is compared with the currently-owned runtime before the in-memory bearer
   * is read, so a historical binding cannot reanimate a replacement worker.
   */
  protected async retryRoomDelivery(input: {
    entryId: string; roomId: string; sourceMessageId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; daemonGeneration: number;
  }): Promise<void> {
    await this.roomDeliveryControl.retry(input);
  }

  protected async restoreAgentConversation(input: {
    entryId: string; roomId: string; sourceMessageId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; daemonGeneration: number;
  }): Promise<void> {
    await this.roomDeliveryControl.restoreConversation(input);
  }

  protected async skipRoomDelivery(input: {
    entryId: string; roomId: string; sourceMessageId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; daemonGeneration: number;
  }): Promise<void> {
    await this.roomDeliveryControl.skip(input);
  }

  /**
   * Repair one pre-turn missing provider conversation without replacing its
   * process, workspace, execution generation, worker session, or room route.
   * This lane is serialized with lifecycle convergence so persistence and
   * handle promotion cannot race a restart or handoff.
   */
  protected async restoreMissingProviderContinuation(input: {
    agent: SupervisedIngressAgent;
    item: import("../supervised-agent-inbox-store.js").SupervisedInboxItem;
    manual: boolean;
  }): Promise<"restored" | "replaced" | "authority_changed" | "failed"> {
    return this.continuationRepairs.restore(input);
  }

  /** Inspector reads are exact-entry scoped; a room mismatch never falls back to history. */
  protected async getAgentInspectorDetail(entryId: string, roomId: string, sourceMessageId: string | null) {
    return this.readModel.inspectorDetail(entryId, roomId, sourceMessageId);
  }

  protected async exactActiveBoundedContext(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number; providerTurnId?: string;
  }) {
    return this.supervisedDeliveryLifecycle.exactActiveBoundedContext(input);
  }

  protected async completeBoundedEffectOnce(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string;
    effectId: string; result?: unknown; error?: string;
  }, admittedDaemonExecution = false): Promise<{ completed: true }> {
    return this.boundedEffects.completeOnce(input, admittedDaemonExecution);
  }

  /** Compatibility seam for focused daemon integration tests; production callers use roomMoves directly. */
  protected reconcileRoomMove(initial: DaemonRoomMoveRecord): Promise<DaemonRoomMoveRecord> {
    return this.roomMoves.reconcile(initial);
  }

  protected async waitForActiveRoomMoveReconciliation(entryId: string): Promise<void> {
    await this.entryConcurrency.waitForActiveRoomMove(entryId);
  }

  protected wakeRoomMoveReconciliationWaiters(): void {
    this.entryConcurrency.wakeRoomMoveWaiters();
  }

  /**
   * Handoff fences admission synchronously. Only reconciliation that already
   * entered its bounded critical section is drained; callbacks queued behind
   * unrelated entry work are woken and later return their captured snapshot
   * without touching a closed store.
   */
  protected async fenceAndDrainRoomMoveReconciliations(): Promise<void> {
    await this.entryConcurrency.fenceAndDrainRoomMoves();
  }

  /** Build a delivery agent only from one current manifest, handle, binding, and memory credential tuple. */
  protected async startSupervisedDelivery(entryId: string, mode: "refresh" | "ensure" | "wake" = "refresh"): Promise<void> {
    await this.supervisedDeliveryLifecycle.start(entryId, mode);
  }

  protected async restartSupervisedDeliveryOrConverge(entryId: string): Promise<void> {
    await this.supervisedDeliveryLifecycle.restartOrConverge(entryId);
  }

  protected status() {
    return maintenanceStatus(this.readModel.status(), this.maintenance?.hold);
  }

  /** Inspector configuration is a durable optimistic-concurrency resource. */
  protected async getAgentConfiguration(entryId: string, daemonGeneration: number) {
    return this.manifestAdministration.getAgentConfiguration(entryId, daemonGeneration);
  }

  protected async updateAgentConfiguration(input: { entryId: string; daemonGeneration: number; expectedRevision: number; configuration: Record<string, unknown> }) {
    return this.manifestAdministration.updateAgentConfiguration(input);
  }

  protected async putManifestEntry(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    return this.manifestAdministration.putManifestEntry(entry);
  }

  /**
   * Repair mutable product identity without touching provider execution,
   * delivery cursors, credentials, or lifecycle authority.
   */
  protected async setDisplayName(id: string, displayName: string): Promise<DaemonManifestEntry> {
    return this.manifestAdministration.setDisplayName(id, displayName);
  }

  protected admitNewTurnControl(entryId: string): void {
    this.turnControls.admitNew(entryId);
  }

  protected async updateWorkplaceLiveness(id: string, state: "reachable" | "stale" | "unknown", detail: string | null, observedAt: string): Promise<DaemonManifestEntry> {
    return this.manifestAdministration.updateWorkplaceLiveness(id, state, detail, observedAt);
  }

  protected async entriesWithDerivedLiveness(entries: DaemonManifestEntry[]): Promise<DaemonManifestEntryView[]> {
    return this.readModel.entriesWithDerivedLiveness(entries);
  }

  protected notifyStateChanged(captureAgentId?: string | false): void {
    this.stateWatch.notify();
    if (captureAgentId === false) return;
    try { this.executionCapture?.refresh(captureAgentId); } catch { /* optional observation */ }
  }

  protected pushAgentStreamEvent(entryId: string, event: DaemonActivityEvent): void {
    this.liveRoomShare.observe(entryId, this.agentStreamRegistry.push(entryId, event));
  }

  protected resetAgentStream(entryId: string): void {
    this.agentStreamRegistry.reset(entryId);
  }

  protected endAgentStream(entryId: string): void {
    this.agentStreamRegistry.end(entryId);
  }

  protected async watchAgentStream(input: {
    entryId: string;
    afterSequence: number;
    waitMs: number;
  }): Promise<{ sequence: number; stream_generation: number; dropped_events: number; events: DaemonAgentStreamEvent[]; ended: boolean }> {
    return this.agentStreamRegistry.watch(input);
  }

  protected async watchState(input: {
    afterDaemonGeneration: number;
    afterSequence: number;
    waitMs: number;
  }): Promise<{
    daemon_generation: number;
    sequence: number;
    entries: DaemonManifestEntryView[];
  }> {
    return this.stateWatch.watch(input);
  }

  protected async entryWithDerivedLiveness(
    entry: DaemonManifestEntry,
    projectedBinding?: WorkerSessionBinding | null,
  ): Promise<DaemonManifestEntryView> {
    return this.readModel.entryWithDerivedLiveness(entry, projectedBinding);
  }

  protected async readAttempt(id: string) {
    return this.readModel.attempt(id);
  }

  /** Queue convergence without making a control-socket caller wait for launch. */
  protected requestConvergence(entryId: string, kind: ConvergenceRequestKind = "owned"): void {
    this.providerExecution?.request(entryId, kind);
  }

  protected bumpEntryControlEpoch(entryId: string): number {
    return this.entryConcurrency.bumpControlEpoch(entryId);
  }

  protected reserveBoundedEffectJournal<T>(operation: () => Promise<T>): Promise<T> {
    return this.boundedEffects.reserveJournal(operation);
  }

  protected attachLiveProvider(
    entry: DaemonManifestEntry,
    mayStartDelivery: () => boolean = () => true,
  ): Promise<ProviderActionHandle | null> {
    if (!entry.provider_ref) return Promise.resolve(null);
    const coordinator = this.providerExecution;
    if (!coordinator) throw new Error("Provider action port is unavailable");
    return coordinator.attachLiveProvider(entry, mayStartDelivery);
  }

  protected installProviderHandle(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    mayStartDelivery: () => boolean = () => true,
  ): Promise<void> {
    return this.providerStreams.install(
      entryId,
      handle,
      executionGenerationId,
      mayStartDelivery,
    );
  }

  protected stageWorkerBindingAfterResume(
    entry: DaemonManifestEntry,
    priorBinding: WorkerSessionBinding,
    successorExecutionGenerationId: string,
    handle: ProviderActionHandle,
  ): Promise<void> {
    return this.providerStreams.stageWorkerBindingAfterResume(
      entry,
      priorBinding,
      successorExecutionGenerationId,
      handle,
    );
  }

  protected handleProviderStream(
    entryId: string,
    handle: ProviderActionHandle,
    event: ProviderActionStreamEvent,
  ): Promise<void> {
    return this.providerStreams.handle(entryId, handle, event);
  }

  protected serializeCursorCheckpoint<T>(
    entryId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.providerStreams.serializeCursorCheckpoint(entryId, operation);
  }

  protected fenceTerminalProviderHandleOnce(
    handle: ProviderActionHandle,
    actionId: string,
  ): Promise<void> {
    return this.providerStreams.fenceTerminalOnce(handle, actionId);
  }

  protected scheduleRecoveryConvergence(entryId: string, delayMs: number): void {
    this.providerExecution?.scheduleRecovery(entryId, delayMs);
  }

  protected clearRecoveryConvergence(entryId: string): void {
    this.providerExecution?.clearRecovery(entryId);
  }

  protected async publishNativeActivity(entryId: string, method: string, status: "working" | "idle", observedAt = new Date().toISOString()): Promise<boolean> {
    return this.nativeActivity.publish(entryId, method, status, observedAt);
  }

  protected async updateManifestEntry(entryId: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
    roomMoveCancellation?: { agentId: string; detail: string }, options?: { readsNoActivity?: boolean },
  ): Promise<DaemonManifestEntry> {
    return this.manifestTransitions.updateEntry(entryId, update, roomMoveCancellation, options);
  }

  /** Identity P1b/P1d must pass into work-durability fencing. */
  supervisorFenceIdentity(): { supervisor_id: string; supervisor_generation: number } {
    return { supervisor_id: this.singleton.lockPath, supervisor_generation: this.singleton.currentGeneration };
  }

  async transition(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"]): Promise<void> {
    return this.manifestTransitions.transition(entryId, to, condition, cause, actor, reconciliation);
  }

  protected async transitionOnce(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"], notice?: ReconciliationNotice["kind"], terminal?: ExecutionTerminalPayload, fence?: TerminalCommitFence): Promise<void> {
    await this.manifestTransitions.transitionOnce(
      entryId,
      to,
      condition,
      cause,
      actor,
      reconciliation,
      notice,
      terminal,
      fence,
    );
  }

  /**
   * The daemon owns this convergence entry point: manifest state is the source
   * of truth, and every retry deadline survives a daemon restart. P1e supplies
   * the real control-socket port; tests may inject a fake port directly.
   */
  async reconcile(entryId: string, input: DaemonReconcileInput, watchdogThresholdMs: number, actor = "reconciler") {
    const coordinator = this.providerReconciliation;
    if (!coordinator) throw new Error("Provider action port is unavailable");
    return coordinator.reconcile(entryId, input, watchdogThresholdMs, actor);
  }

  protected async serializeEntryTick<T>(entryId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.entryConcurrency.run(entryId, operation, signal);
  }

  /** Provider terminal callback: records an actual exit edge before the next tick. */
  async observeProviderExit(entryId: string, terminal: ProviderActionTerminal, actor = "provider", expectedExecutionGenerationId?: string, expectedHandle?: ProviderActionHandle): Promise<void> {
    await this.providerTerminals.observeExit(
      entryId,
      terminal,
      actor,
      expectedExecutionGenerationId,
      expectedHandle,
    );
  }

  protected async observeProviderExitOnce(entryId: string, terminal: ProviderActionTerminal, actor: string, expectedExecutionGenerationId?: string, expectedHandle?: ProviderActionHandle): Promise<void> {
    await this.providerTerminals.observeExitOnce(
      entryId,
      terminal,
      actor,
      expectedExecutionGenerationId,
      expectedHandle,
    );
  }

  /** Starts periodic convergence and joins provider onExit to the same durable path. */
  async scheduleConvergence(
    entryId: string,
    handle: ProviderActionHandle,
    input: () => DaemonReconcileInput,
    watchdogThresholdMs: number,
    intervalMs: number,
    actor = "reconciler",
  ): Promise<() => Promise<void>> {
    const coordinator = this.providerReconciliation;
    if (!coordinator) throw new Error("Provider action port is unavailable");
    return coordinator.schedule(
      entryId,
      handle,
      input,
      watchdogThresholdMs,
      intervalMs,
      actor,
    );
  }

  protected async serializeManifestMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.authority.serializeManifestMutation(operation);
  }

  protected writeManifest(
    expectedGeneration: number,
    entries: DaemonManifestEntry[],
    roomMoveCancellation?: { agentId: string; detail: string },
  ) {
    return this.store.write(
      expectedGeneration,
      entries,
      (commit) => this.fenceDaemonCommit(commit),
      roomMoveCancellation,
    );
  }

  protected fenceDaemonCommit(commit: () => Promise<void>, notification?: DaemonCommitNotification): Promise<void> {
    return this.authority.fenceDaemonCommit(commit, notification);
  }

  /**
   * Finish only an exact provider transition or tool journal completion
   * already admitted by this generation. Handoff has synchronously fenced new
   * work, but the old daemon still owns the singleton and must leave admitted
   * state honest before releasing it to a successor.
   */
  protected fenceAdmittedTransitionCommit(commit: () => Promise<void>): Promise<void> {
    return this.authority.fenceAdmittedTransitionCommit(commit);
  }

  protected async serializeManifestCommit<T>(operation: () => Promise<T>): Promise<T> {
    return this.authority.serializeManifestCommit(operation);
  }

  protected settleRuntimeApprovals(entryId: string, fence?: TerminalCommitFence): Promise<void> {
    return settleRuntimeApprovalRequests(entryId, {
      settle: () => this.store.settleWitnessedRuntimeApprovalClosures(entryId, () => this.nowMs(), fence ?? (commit => this.fenceDaemonCommit(commit))),
      notifyChanged: () => this.notifyStateChanged(),
      isHandoffScheduled: () => this.handoffScheduled,
      assertCurrent: () => this.singleton.assertCurrent(),
      scheduleRecovery: (id, delayMs) => { if (!fence) this.scheduleRecoveryConvergence(id, delayMs); },
    });
  }

  /** A user's action on an agent goes ahead of background convergence in every pacing queue. */
  protected userAction<T>(entryId: string | null, operation: () => T): T {
    if (entryId) this.convergencePacer.markInteractive(entryId);
    return operation();
  }

  protected async recordSchedulerFailure(entryId: string, error: unknown, actor: string): Promise<void> {
    await this.providerSchedulerFailures.record(entryId, error, actor);
  }
}
