/**
 * Builds room delivery: continuation repair, room moves, provider checkpoints,
 * supervised delivery, the read model, terminals, configuration apply,
 * cutovers and desired states.
 */
import { ContinuationRepairCoordinator } from "../continuation-repair-coordinator.js";
import { redactCredentialText } from "../credential-redaction.js";
import { DaemonReadModel } from "../daemon-read-model.js";
import { launchProgress } from "../launch-progress.js";
import { DeliveryCutoverExecutionCoordinator } from "../delivery-cutover-execution-coordinator.js";
import { DesiredStateCoordinator } from "../desired-state-coordinator.js";
import { ProviderCheckpointCoordinator } from "../provider-checkpoint-coordinator.js";
import { ProviderTerminalCoordinator } from "../provider-terminal-coordinator.js";
import { RoomMoveCoordinator } from "../room-move-coordinator.js";
import { RuntimeConfigurationApplyCoordinator } from "../runtime-configuration-apply-coordinator.js";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedDeliveryLifecycleCoordinator } from "../supervised-delivery-lifecycle-coordinator.js";
import { SupervisorDaemonProviderExecution } from "./provider-execution.js";
import type { SupervisorDaemonArgs } from "./state.js";

export abstract class SupervisorDaemonDelivery extends SupervisorDaemonProviderExecution {
  protected readonly readModel: DaemonReadModel;
  protected readonly desiredStates: DesiredStateCoordinator;
  protected readonly continuationRepairs: ContinuationRepairCoordinator;
  protected readonly roomMoves: RoomMoveCoordinator;
  protected readonly supervisedDelivery: SupervisedAgentDelivery | null;
  protected readonly supervisedDeliveryLifecycle: SupervisedDeliveryLifecycleCoordinator;
  protected readonly runtimeConfigurationApply: RuntimeConfigurationApplyCoordinator;
  protected readonly deliveryCutoverExecution: DeliveryCutoverExecutionCoordinator;
  protected readonly providerCheckpoints: ProviderCheckpointCoordinator;
  protected readonly providerTerminals: ProviderTerminalCoordinator;

  constructor(...args: SupervisorDaemonArgs) {
    super(...args);
    const [, , providerPort, , , , , supervisedDeliveryHttp] = args;
    this.continuationRepairs = new ContinuationRepairCoordinator({
      authority: {
        isHandoffScheduled: () => this.handoffScheduled,
        currentGeneration: () => this.singleton.currentGeneration,
        assertCurrent: () => this.singleton.assertCurrent(),
      },
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      inbox: {
        latest: (entryId) => this.supervisedInbox.latestContinuationRepair(entryId),
        exhaust: (inboxItemId, repairId, error) => this.supervisedInbox.exhaustCommittedContinuationRepair(inboxItemId, repairId, error),
        begin: (input) => this.supervisedInbox.beginContinuationRepair(input),
        checkpointReplacement: (repairId, continuation) => this.supervisedInbox.checkpointContinuationReplacement(repairId, continuation),
        commit: (repairId, continuation, reset) => this.supervisedInbox.commitContinuationRepair(repairId, continuation, reset),
        fail: (repairId, error) => this.supervisedInbox.failContinuationRepair(repairId, error),
      },
      manifest: {
        getEntry: async (entryId) => await this.store.getEntry(entryId) ?? null,
        updateEntry: (entryId, update) => this.updateManifestEntry(entryId, update),
      },
      bindings: {
        get: (entryId) => this.workerBindings.get(entryId),
        credentialFor: (binding) => this.workerBindings.credentialFor(binding),
      },
      durability: {
        getAttempt: (workAttemptId) => this.durability.getAttempt(workAttemptId),
        checkpoint: (workAttemptId, checkpoint) => this.durability.checkpoint(workAttemptId, checkpoint),
      },
      runtime: {
        getHandle: (entryId) => this.liveHandles.get(entryId),
        ...(providerPort?.repairContinuation
          ? { repair: (handle, request, options) => providerPort.repairContinuation!(handle, request, options) }
          : {}),
        promote: (entryId, handle, executionGenerationId) => this.installProviderHandle(entryId, handle, executionGenerationId),
      },
      recordNotices: async (entryId, notices) => { await this.providerExecution?.noteRepairNotices(entryId, notices); },
      notifyStateChanged: () => this.notifyStateChanged(),
    });
    this.roomMoves = new RoomMoveCoordinator({
      store: this.store,
      inbox: this.supervisedInbox,
      bindings: this.workerBindings,
      runtimeCustody: this.workerRuntimeCustody,
      deliveryHttp: this.supervisedDeliveryHttp,
      authority: {
        currentGeneration: () => this.singleton.currentGeneration,
        isHandoffScheduled: () => this.handoffScheduled,
        assertCurrent: () => this.singleton.assertCurrent(),
        ownsDaemonGeneration: (expected) => this.workerAuthority.ownsDaemonGeneration(expected),
        fenceCommit: (commit) => this.fenceDaemonCommit(commit),
      },
      entryConcurrency: this.entryConcurrency,
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      updateManifestEntry: (entryId, update) => this.updateManifestEntry(entryId, update),
      currentHandle: (entryId) => this.liveHandles.get(entryId),
      pauseIngress: (entryId) => this.supervisedDelivery?.pauseIngress(entryId),
      restartDelivery: (entryId) => this.startSupervisedDelivery(entryId),
      scheduleRecovery: (entryId, delayMs) => this.scheduleRecoveryConvergence(entryId, delayMs),
    });
    this.providerCheckpoints = new ProviderCheckpointCoordinator({
      observePreparedRuntime: (runtime) => this.executionCapture?.prepared(runtime),
      activateCommittedCursorRuntime: (input) => this.providerStreams.activateCommittedCursorRuntime(input),
      store: this.store,
      bindings: this.workerBindings,
      inbox: this.supervisedInbox,
      durability: this.durability,
      liveHandles: this.liveHandles,
      authority: {
        isHandoffScheduled: () => this.handoffScheduled,
        assertCurrent: () => this.singleton.assertCurrent(),
        currentDaemonGeneration: () => this.singleton.currentGeneration,
        currentManifestGeneration: () => this.manifestGeneration,
        acceptManifestGeneration: (generation) => { this.manifestGeneration = generation; },
        fenceCommit: (commit) => this.fenceDaemonCommit(commit),
        fenceAdmittedTransitionCommit: (commit) => this.fenceAdmittedTransitionCommit(commit),
      },
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      serializeManifest: (operation) => this.serializeManifestMutation(operation),
      scheduleRecovery: (entryId, delayMs) => this.scheduleRecoveryConvergence(entryId, delayMs),
      nowMs: () => this.nowMs(),
    });
    this.supervisedDelivery = providerPort
      ? new SupervisedAgentDelivery(
        this.supervisedInbox,
        providerPort,
        supervisedDeliveryHttp,
        (authority, scope) => this.providerCheckpoints.isExactAuthority(authority, scope),
        undefined,
        undefined,
        undefined,
        (input) => this.roomMoves.commitPreparedRoomMove(input),
        undefined,
        (input) => this.restoreMissingProviderContinuation(input),
        (input) => this.providerCheckpoints.checkpointDynamicState(input),
        (input) => this.providerCheckpoints.checkpointPreparedTurn(input),
        (agent) => this.roomWorkPublisher?.observeNewSources(agent),
        (agent) => this.providerStreams.settleCursorLifecycleBeforeIdle(agent, this.executionCapture, this.typedLifecycleEffects),
        async (agent, sourceMessageId, inboxItemId, summary, baseline) => {
          const installation = this.providerStreams.currentInstallation(agent.agentId);
          if (installation?.handle === agent.handle && installation.executionGenerationId === agent.executionGenerationId) {
            try { this.executionCapture?.flush(installation); } catch { /* Optional capture may already be retired. */ }
          }
          await this.roomWorkPublisher?.captureWorkspace(agent, sourceMessageId, inboxItemId, summary, baseline);
        },
        async (agent, source, inbox) => this.roomWorkPublisher?.beginWorkspace(agent, source, inbox),
        async (agent, source, inbox) => { await this.roomWorkPublisher?.releaseWorkspace(agent, source, inbox); },
        (agentId) => {
          this.roomWorkPublisher?.settled(agentId);
          this.requestConvergence(agentId);
        },
        (agent, demand) => this.runtimeConfigurationApply.canAdmitManagedDelivery(agent, demand),
        async (agentId) => { await this.providerExecution?.archiveEndedRuntimes(agentId); },
        this.replyAttachmentSpool,
        this.roomTurnAttachments,
        (agentId, change) => {
          if ("ended" in change) this.liveRoomShare.turnEnded(agentId, change.ended);
          else this.liveRoomShare.turnStarted(agentId, change.inboxItemId, change.sourceMessageId);
        },
      ) : null;
    this.readModel = new DaemonReadModel({
      readUsage: (handle) => this.providerPort?.readUsage?.(handle) ?? Promise.resolve(null),
      compactionProgress: (entry) => entry.work_attempt_id
        ? this.providerPort?.compactionProgress?.(entry.work_attempt_id, entry.provider) ?? null : null,
      launchProgress: (entry) => launchProgress.view(entry.id, this.convergencePacer.snapshot("launch")),
      deliveryAdmission: (entry) => this.providerStreams.deliveryAdmission(entry),
      recordRecovery: (entry) => this.runtimeConfigurationApply.recordRecovery(entry),
      currentDaemonGeneration: () => this.singleton.currentGeneration,
      nowMs: () => this.nowMs(),
      startedAt: this.startedAt,
      capabilities: {
        hasDelivery: () => Boolean(this.supervisedDelivery),
        supportsRoomTurns: () => Boolean(this.providerPort?.runRoomTurn),
        supportsContinuationRepair: () => Boolean(this.providerPort?.repairContinuation),
      },
      recoveryDiagnostics: () => this.providerStreams.recoveryDiagnostics(),
      manifest: this.store,
      bindings: this.workerBindings,
      inbox: this.supervisedInbox,
      durability: this.durability,
      workerAuthority: this.workerAuthority,
      liveHandles: this.liveHandles,
      delivery: this.supervisedDelivery,
    });
    this.supervisedDeliveryLifecycle = new SupervisedDeliveryLifecycleCoordinator({
      isHandoffScheduled: () => this.handoffScheduled,
      supportsRoomTurns: () => Boolean(this.providerPort?.runRoomTurn),
      isLifecycleActive: (entryId) => this.entryConcurrency.isLifecycleActive(entryId),
      isOperationallyAdmitted: (entryId) => this.providerStreams.isDeliveryAdmitted(entryId),
      currentDaemonGeneration: () => this.singleton.currentGeneration,
      delivery: this.supervisedDelivery,
      manifest: this.store,
      roomMoves: {
        reconcile: (move) => this.roomMoves.reconcile(move),
      },
      cutovers: {
        start: (entryId) => this.deliveryCutovers.start(entryId),
      },
      inbox: this.supervisedInbox,
      bindings: this.workerBindings,
      liveHandle: (entryId) => this.liveHandles.get(entryId),
      providerAuthority: this.providerCheckpoints,
      scheduleRecovery: (entryId, delayMs) => this.scheduleRecoveryConvergence(entryId, delayMs),
    });
    this.providerTerminals = new ProviderTerminalCoordinator({
      authority: {
        assertCurrent: () => this.singleton.assertCurrent(),
        isClosing: () => this.handoffScheduled,
        // The exact owner checks retirement admission inside the reserved commit.
        fenceCommit: commit => this.fenceAdmittedTransitionCommit(commit),
      },
      diagnostic: (entryId, error) => console.warn("[terminal_settlement]", entryId, redactCredentialText(String(error)).value),
      settleRuntimeApprovals: (entryId, fence) => this.settleRuntimeApprovals(entryId, fence),
      exitUnsettled: (entryId, exitId) => this.providerExecution?.noteExitUnsettled(entryId, exitId),
      currentDaemonGeneration: () => this.singleton.currentGeneration,
      nowMs: () => this.nowMs(),
      liveHandles: this.liveHandles,
      manifest: {
        getEntry: (entryId) => this.store.getEntry(entryId),
        load: () => this.store.load(),
      },
      durability: this.durability,
      runtimeCustody: this.workerRuntimeCustody,
      streams: this.providerStreams,
      delivery: { start: (entryId) => this.startSupervisedDelivery(entryId) },
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      serializeManifest: (operation) => this.serializeManifestMutation(operation),
      transitionOnce: (entryId, state, condition, cause, actor, reconciliation, notice, terminal, fence) =>
        this.transitionOnce(entryId, state, condition, cause, actor, reconciliation, notice, terminal, fence),
      requestConvergence: (entryId) => this.requestConvergence(entryId),
    });
    this.runtimeConfigurationApply = new RuntimeConfigurationApplyCoordinator({
      managed: {
        store: this.store,
        bindings: this.workerBindings,
        reserveApprovalIdle: (installation) => this.hostApprovals.reserveIdle(installation),
        resumeDelivery: (entryId) => this.startSupervisedDelivery(entryId),
      },
      store: this.store,
      inbox: this.supervisedInbox,
      delivery: this.supervisedDelivery,
      ...(providerPort ? { provider: providerPort } : {}),
      streams: this.providerStreams,
      terminals: this.providerTerminals,
      entryConcurrency: this.entryConcurrency,
      authority: {
        assertCurrent: () => this.singleton.assertCurrent(),
        currentDaemonGeneration: () => this.singleton.currentGeneration,
        isHandoffScheduled: () => this.handoffScheduled,
      },
      requestConvergence: (entryId) => this.requestConvergence(entryId),
    });
    this.deliveryCutoverExecution = new DeliveryCutoverExecutionCoordinator({
      isHandoffScheduled: () => this.handoffScheduled,
      ...(providerPort ? { provider: providerPort } : {}),
      getEntry: (entryId) => this.store.getEntry(entryId),
      getAttempt: (workAttemptId) => this.durability.getAttempt(workAttemptId),
      updateEntry: (entryId, update) => this.updateManifestEntry(entryId, update),
      getLiveHandle: (entryId) => this.liveHandles.get(entryId),
      startDelivery: (entryId) => this.startSupervisedDelivery(entryId, "wake"),
      observation: this.deliveryCutovers,
      drain: { store: this.store, authority: this.authority, entries: this.entryConcurrency, delivery: this.supervisedDelivery },
      polling: { bindings: this.workerBindings, currentHostGrant: (entry) => this.workerAuthority.currentHostGrant(entry) },
    });
    this.desiredStates = new DesiredStateCoordinator({
      store: this.store,
      entryConcurrency: this.entryConcurrency,
      delivery: this.supervisedDelivery,
      authority: {
        currentManifestGeneration: () => this.manifestGeneration,
        acceptManifestGeneration: (generation) => { this.manifestGeneration = generation; },
        assertCurrent: () => this.singleton.assertCurrent(),
        serializeManifest: (operation) => this.serializeManifestMutation(operation),
        fenceCommit: (commit) => this.fenceDaemonCommit(commit),
      },
      waitForActiveRoomMove: (entryId) => this.waitForActiveRoomMoveReconciliation(entryId),
      clearRecovery: (entryId) => this.clearRecoveryConvergence(entryId),
      restartDeliveryOrConverge: (entryId) => this.restartSupervisedDeliveryOrConverge(entryId),
      requestConvergence: (entryId) => this.requestConvergence(entryId),
    });
  }
}
