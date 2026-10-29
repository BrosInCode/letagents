/**
 * The concrete supervisor daemon. Its constructor builds runtime recovery,
 * turn controls, bounded effects, host approvals, delegations, handoff and the
 * control socket, after the layers it extends.
 */
import { localRoomRuntime } from "../local-room-runtime.js";
import { BoundedEffectCoordinator } from "../bounded-effect-coordinator.js";
import { productionSupervisedDeliveryHttp, productionSupervisorGrantHttp, type SupervisorGrantHttp } from "../cloud-http.js";
import { DaemonControlSocket } from "../control-socket.js";
import { createDaemonControlRequestHandler, type DaemonControlOperations } from "../control-request-router.js";
import { createHostApprovalBridge } from "../host-approval-broker.js";
import { createAutomaticPermissionReviewer } from "../automatic-permission-review.js";
import { ExecutionDelegationCoordinator } from "../execution-delegation-coordinator.js";
import type { ProviderActionPort } from "../provider-action-port.js";
import { ProviderHandoffCoordinator } from "../provider-handoff-coordinator.js";
import { RoomDeliveryControl } from "../room-delivery-control.js";
import { RuntimeRecoveryCoordinator } from "../runtime-recovery-coordinator.js";
import { DaemonFenceLostError, defaultDaemonPaths } from "../singleton.js";
import type { DaemonRequest } from "../types.js";
import { structuredRoomTurnCompletion } from "../supervised-agent-inbox-store.js";
import type { SupervisedDeliveryHttp } from "../supervised-agent-delivery.js";
import { supervisedToolRuntime, type SupervisedToolRuntime } from "../supervised-tool-runtime.js";
import { TurnControlCoordinator } from "../turn-control-coordinator.js";
import type { DaemonPaths, RecoveryClock } from "./types.js";
import { SupervisorDaemonDelivery } from "./delivery.js";

export class SupervisorDaemon extends SupervisorDaemonDelivery {
  protected readonly executionDelegations: ExecutionDelegationCoordinator;
  protected readonly turnControls: TurnControlCoordinator;
  protected readonly roomDeliveryControl: RoomDeliveryControl;
  protected readonly runtimeRecovery: RuntimeRecoveryCoordinator;
  protected readonly boundedEffects: BoundedEffectCoordinator;
  protected readonly socket: DaemonControlSocket;
  protected readonly hostApprovals: ReturnType<typeof createHostApprovalBridge>;
  protected readonly nowMs: () => number;
  protected readonly handoff: ProviderHandoffCoordinator;

  constructor(paths: DaemonPaths = defaultDaemonPaths(), platform = process.platform, providerPort?: ProviderActionPort, autoConverge = false, nativeHeartbeatIntervalMs = 15_000, controlRequestBarrier?: (request: DaemonRequest) => Promise<void>, recoveryClock: RecoveryClock = {}, supervisedDeliveryHttp: SupervisedDeliveryHttp = productionSupervisedDeliveryHttp, supervisorGrantHttp: SupervisorGrantHttp = productionSupervisorGrantHttp, loadSupervisedToolRuntime: () => Promise<SupervisedToolRuntime> = supervisedToolRuntime) {
    super(paths, platform, providerPort, autoConverge, nativeHeartbeatIntervalMs, controlRequestBarrier, recoveryClock, supervisedDeliveryHttp, supervisorGrantHttp, loadSupervisedToolRuntime);
    this.runtimeRecovery = new RuntimeRecoveryCoordinator({
      settleRuntimeApprovals: (entryId) => this.settleRuntimeApprovals(entryId),
      releaseRecoveredObservation: (entryId, runtimeId, stoppedCursorGeneration) => this.executionCapture?.releaseRecoveredRuntime(entryId, runtimeId, stoppedCursorGeneration),
      streams: this.providerStreams,
      terminals: this.providerTerminals,
      restartDelivery: (entryId) => this.restartSupervisedDeliveryOrConverge(entryId),
      store: this.store,
      durability: this.durability,
      inbox: this.supervisedInbox,
      bindings: this.workerBindings,
      workerAuthority: this.workerAuthority,
      runtimeCustody: this.workerRuntimeCustody,
      delivery: this.supervisedDelivery,
      supervisorGrantHttp: this.supervisorGrantHttp,
      ...(providerPort ? { provider: providerPort } : {}),
      liveHandles: this.liveHandles,
      authority: {
        currentDaemonGeneration: () => this.singleton.currentGeneration,
        currentManifestGeneration: () => this.manifestGeneration,
        acceptManifestGeneration: (generation) => { this.manifestGeneration = generation; },
        isHandoffScheduled: () => this.handoffScheduled,
        assertCurrent: () => this.singleton.assertCurrent(),
        serializeManifest: (operation) => this.serializeManifestMutation(operation),
        fenceCommit: (commit) => this.fenceDaemonCommit(commit),
      },
      beginLifecycle: (entryId) => this.entryConcurrency.beginLifecycle(entryId),
      bumpControlEpoch: (entryId) => this.bumpEntryControlEpoch(entryId),
      clearRecovery: (entryId) => this.clearRecoveryConvergence(entryId),
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      updateEntry: (entryId, update, roomMoveCancellation) =>
        this.updateManifestEntry(entryId, update, roomMoveCancellation),
      requestConvergence: (entryId) => this.requestConvergence(entryId),
      entryWithDerivedLiveness: (entry) => this.entryWithDerivedLiveness(entry),
      nowMs: () => this.nowMs(),
    });
    this.turnControls = new TurnControlCoordinator({
      authority: {
        currentGeneration: () => this.singleton.currentGeneration,
        assertCurrent: () => this.singleton.assertCurrent(),
        manifestGeneration: () => this.manifestGeneration,
        setManifestGeneration: (generation) => { this.manifestGeneration = generation; },
        fenceCommit: (commit) => this.fenceDaemonCommit(commit),
      },
      store: this.store,
      durability: this.durability,
      workerBindings: this.workerBindings,
      inbox: this.supervisedInbox,
      delivery: this.supervisedDelivery,
      providerPort: this.providerPort,
      entryConcurrency: this.entryConcurrency,
      currentHandle: (entryId) => this.liveHandles.get(entryId),
      attachLiveProvider: (entry) => this.attachLiveProvider(entry),
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      serializeManifest: (operation) => this.serializeManifestMutation(operation),
      updateManifestEntry: (entryId, update) => this.updateManifestEntry(entryId, update),
      entryWithDerivedLiveness: (entry) => this.entryWithDerivedLiveness(entry),
      wakeDelivery: (entryId) => this.startSupervisedDelivery(entryId, "wake"),
      scheduleRecovery: (entryId, delayMs) => this.scheduleRecoveryConvergence(entryId, delayMs),
      requestConvergence: (entryId) => this.requestConvergence(entryId),
      nowMs: () => this.nowMs(),
    });
    this.roomDeliveryControl = new RoomDeliveryControl({
      delivery: this.supervisedDelivery,
      supportsRunRoomTurn: () => Boolean(this.providerPort?.runRoomTurn),
      supportsRepairContinuation: () => Boolean(this.providerPort?.repairContinuation),
      currentGeneration: () => this.singleton.currentGeneration,
      getEntry: (entryId) => this.store.getEntry(entryId),
      getHandle: (entryId) => this.liveHandles.get(entryId) ?? null,
      getBinding: (entryId) => this.workerBindings.get(entryId),
      credentialFor: (binding) => this.workerBindings.credentialFor(binding),
      isExactAuthority: (agent) => this.providerCheckpoints.isExactAuthority(agent),
    });
    this.boundedEffects = new BoundedEffectCoordinator({
      context: { exactActive: (input) => this.exactActiveBoundedContext(input) },
      entries: { get: (entryId) => this.store.getEntry(entryId) },
      authorizations: { get: (entryId) => this.workerRuntimeCustody.workerAuthorization(entryId) },
      journal: {
        prepare: (input, fence) => this.supervisedInbox.prepareEffect(input, fence),
        markExecuting: (input, fence) => this.supervisedInbox.markEffectExecuting(input, fence),
        complete: (input, fence) => this.supervisedInbox.completeEffect(input, fence),
      },
      roomMoves: {
        prepare: (input, fence) => this.supervisedInbox.prepareRoomMoveEffect(input, fence),
      },
      runtime: { load: () => this.loadSupervisedToolRuntime() },
      executionCompletion: {
        complete: (input, admitted) => this.completeBoundedEffectOnce(input, admitted),
      },
      authority: {
        assertCurrent: () => this.singleton.assertCurrent(),
        currentGeneration: () => this.singleton.currentGeneration,
        fenceCommit: (commit) => this.fenceDaemonCommit(commit),
        fenceAdmittedTransitionCommit: (commit) => this.fenceAdmittedTransitionCommit(commit),
      },
      policy: { structuredRoomTurnCompletion },
      replyAttachments: {
        snapshot: (input) => this.replyAttachmentSpool.snapshot(input),
        keepOnly: (inboxItemId, spoolIds) => this.replyAttachmentSpool.keepOnly(inboxItemId, spoolIds),
      },
    });
    this.hostApprovals = createHostApprovalBridge({
      store: this.store, inbox: this.supervisedInbox, provider: this.providerPort,
      workerBindings: this.workerBindings, providerCheckpoints: this.providerCheckpoints,
      currentGeneration: () => this.singleton.currentGeneration,
      currentHandle: entryId => this.liveHandles.get(entryId),
      isCurrent: () => !this.handoffScheduled,
      fenceCommit: commit => this.fenceDaemonCommit(commit),
      onPermissionChanged: entryId => {
        this.executionDelegations.requestDecisions(entryId);
        this.requestConvergence(entryId);
        this.stateWatch.notify(); // a request or its resolution wakes the desktop's state watch
      },
      automaticReview: createAutomaticPermissionReviewer({ custody: this.workerRuntimeCustody, isClosing: () => this.handoffScheduled,
        daemonGeneration: () => this.singleton.currentGeneration, nowMs: () => this.nowMs() }),
    });
    this.executionDelegations = new ExecutionDelegationCoordinator({
      entries: this.store,
      authority: this.workerAuthority,
      approvals: this.hostApprovals,
      remote: this.supervisorGrantHttp,
      approvalPublication: { path: this.stateDatabasePath, custody: this.workerRuntimeCustody,
        inbox: this.supervisedInbox, daemonGeneration: () => this.singleton.currentGeneration, isClosing: () => this.handoffScheduled,
        assertCurrent: () => this.singleton.assertCurrent(), now: () => this.nowMs() },
      requestConvergence: (entryId, kind) => this.requestConvergence(entryId, kind),
      diagnostic: (domain, entryId, error) => console.warn(`[execution_delegation_${domain}_sync]`,
        JSON.stringify({ entryId, error: String(error) })),
    });
    this.handoff = new ProviderHandoffCoordinator({
      provider: providerPort, manifest: this.store, inbox: this.supervisedInbox,
      execution: this.providerExecution, delivery: () => this.supervisedDelivery,
      currentHandle: (entryId) => this.liveHandles.get(entryId),
      currentExecutionGeneration: (entryId) => this.providerStreams.currentInstallation(entryId)?.executionGenerationId,
      isNativeControlActive: (entryId) => this.entryConcurrency.isNativeControlActive(entryId),
      isRetiring: () => this.handoffScheduled,
      setDraining: (draining) => { this.handoffDraining = draining; },
      drainTerminals: () => this.providerTerminals.drain(),
      beginRetirement: () => {
        this.providerTerminals.beginRetirement();
        try { this.executionCapture?.sealForPlannedHandoff(); this.handoffScheduled = true; this.convergencePacer.close(); }
        catch (error) { this.providerTerminals.cancelRetirement(); throw error; }
      },
      retire: () => this.retireForHandoff(),
      finish: () => this.stopForHandoff(),
      requestConvergence: (entryId) => this.requestConvergence(entryId),
    });
    const controlOperations = {
      hostApprovals: this.hostApprovals,
      activateCustodialPolling: (input) => this.deliveryCutoverExecution.activatePolling(input),
      getPollingActivation: (input) => this.deliveryCutoverExecution.getPollingActivation(input),
      cancelPollingActivation: (input) => this.deliveryCutoverExecution.cancelPollingActivation(input),
      prepareDeliveryDrain: (input) => this.deliveryCutoverExecution.prepareDrain(input),
      getDeliveryDrain: (input) => this.deliveryCutoverExecution.getDrain(input),
      cancelDeliveryDrain: (input) => this.deliveryCutoverExecution.cancelDrain(input),
      acknowledgeInspectorRoomMoveSourceRevocation: (input) => this.roomMoves.acknowledgeSourceRevocation(input),
      applyAgentConfiguration: (input) => this.runtimeConfigurationApply.apply(input),
      bindWorkerSession: this.workerAuthority.bindWorkerSession.bind(this.workerAuthority),
      bootstrapRoomIngress: (input) => this.userAction(input.initial_message === undefined ? null : input.entry_id,
        () => this.beginBootstrap(this.workerAuthority.bootstrapRoomIngress.bind(this.workerAuthority), input)),
      borrowWorkerCredential: this.workerAuthority.borrowWorkerCredential.bind(this.workerAuthority),
      authorizeCustodialPolling: this.workerAuthority.authorizeCustodialPolling.bind(this.workerAuthority),
      checkpointWorkerCursor: this.workerAuthority.checkpointWorkerCursor.bind(this.workerAuthority),
      commitInspectorRoomMove: (input) => this.roomMoves.commitInspector(input),
      compareAndSetDesiredState: (id, expected, desired) => this.userAction(id, () => this.desiredStates.compareAndSet(id, expected, desired)),
      completeBoundedEffect: this.boundedEffects.complete.bind(this.boundedEffects),
      executeBoundedTool: this.boundedEffects.execute.bind(this.boundedEffects),
      controlTurn: (input) => this.turnControls.control(input),
      entryWithDerivedLiveness: this.entryWithDerivedLiveness.bind(this),
      getAgentConfiguration: this.getAgentConfiguration.bind(this),
      getAgentInspectorDetail: this.getAgentInspectorDetail.bind(this),
      getCurrentInspectorRoomMove: (input) => this.roomMoves.getCurrentInspector(input),
      getInspectorRoomMove: (input) => this.roomMoves.getInspector(input),
      installHostGrant: (input) => this.userAction(input.credential_only ? input.entry_id : null, () => this.executionDelegations.installHostGrant(input)),
      installOpenModelCredential: this.workerAuthority.installOpenModelCredential.bind(this.workerAuthority),
      installWorkerCredential: this.workerAuthority.installWorkerCredential.bind(this.workerAuthority),
      listManifest: async (roomId) => this.entriesWithDerivedLiveness(roomId
        ? await this.store.listRoomEntries(roomId)
        : (await this.store.load()).entries),
      prepareBoundedEffect: this.boundedEffects.prepare.bind(this.boundedEffects),
      prepareHandoff: () => this.handoff.prepare(),
      prepareInspectorRoomMove: (input) => this.roomMoves.prepareInspector(input),
      purgeAgent: this.lifecycleAdministration.purgeAgent.bind(this.lifecycleAdministration),
      putManifestEntry: (entry) => this.userAction(entry.id, () => this.putManifestEntry(entry)),
      readAttempt: this.readAttempt.bind(this),
      recoverAgentRuntime: (id, generation, recovery) => this.userAction(id, () => this.runtimeRecovery.recoverAgentRuntime(id, generation, recovery)),
      resolveTurnControl: (input) => this.turnControls.resolve(input),
      restoreAgentConversation: this.restoreAgentConversation.bind(this),
      retireAgent: this.lifecycleAdministration.retireAgent.bind(this.lifecycleAdministration),
      retryRoomDelivery: this.retryRoomDelivery.bind(this),
      rollbackInspectorRoomMove: (input) => this.roomMoves.rollbackInspector(input),
      setDesiredState: (id, desired) => this.userAction(id, () => this.desiredStates.set(id, desired)),
      setDisplayName: this.setDisplayName.bind(this),
      setLiveSharing: (input) => this.manifestAdministration.setLiveSharing(input),
      skipRoomDelivery: this.skipRoomDelivery.bind(this),
      status: this.status.bind(this),
      syncExecutionDelegations: (input) => {
        if (input.daemon_generation !== this.singleton.currentGeneration) return { status: "stale" };
        this.executionDelegations.requestRoom(input.room_id);
        return { status: "queued" };
      },
      updateAgentConfiguration: this.updateAgentConfiguration.bind(this),
      updateWorkplaceLiveness: this.updateWorkplaceLiveness.bind(this),
      verifyWorkerSession: this.workerAuthority.verifyWorkerSession.bind(this.workerAuthority),
      watchAgentStream: this.watchAgentStream.bind(this),
      watchState: this.watchState.bind(this),
      mutateLocalBoard: async input => {
        const runtime = await localRoomRuntime();
        let result: unknown;
        await this.fenceDaemonCommit(async () => { result = await runtime.executeLocalBoardMutation(input); });
        return result;
      },
      watchLocalBoard: async (input, signal) => (await localRoomRuntime()).watchLocalBoard(input, this.singleton.currentGeneration, signal),
    } satisfies DaemonControlOperations;
    this.socket = new DaemonControlSocket(
      paths.socketPath,
      (request, signal) => this.maintenance ? this.maintenance.handle(request) : createDaemonControlRequestHandler({
        assertCurrent: () => this.singleton.assertCurrent(),
        currentGeneration: () => this.singleton.currentGeneration,
        isHandoffScheduled: () => this.handoffScheduled,
        isHandoffDraining: () => this.handoffDraining,
        requestBarrier: this.controlRequestBarrier,
      }, controlOperations)(request, signal),
      async (error) => { if (error instanceof DaemonFenceLostError) await this.stop(); },
      undefined,
      { peerProofPath: paths.peerProofPath ?? null },
    );
    this.nowMs = recoveryClock.nowMs ?? Date.now;
  }
}
