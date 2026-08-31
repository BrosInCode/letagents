import { dirname } from "node:path";

import { AuditLog } from "./audit-log.js";
import { AgentStreamRegistry } from "./agent-stream-registry.js";
import { BoundedEffectCoordinator } from "./bounded-effect-coordinator.js";
import { ContinuationRepairCoordinator } from "./continuation-repair-coordinator.js";
import {
  productionSupervisedDeliveryHttp,
  productionSupervisorGrantHttp,
  type SupervisorGrantHttp,
} from "./cloud-http.js";
import { DaemonControlSocket } from "./control-socket.js";
import { createDaemonControlRequestHandler, type DaemonControlOperations } from "./control-request-router.js";
import { redactCredentialText, sanitizeDaemonActivityEvent } from "./credential-redaction.js";
import { DaemonAuthority } from "./daemon-authority.js";
import { DaemonReadModel } from "./daemon-read-model.js";
import { DeliveryCutoverCoordinator } from "./delivery-cutover-coordinator.js";
import { DeliveryCutoverExecutionCoordinator } from "./delivery-cutover-execution-coordinator.js";
import { schedulerErrorDetail } from "./daemon-error-policy.js";
import { DaemonStateWatch } from "./daemon-state-watch.js";
import { ExecutionCaptureCoordinator } from "./execution-capture-coordinator.js";
import { DesiredStateCoordinator } from "./desired-state-coordinator.js";
import { WorkDurabilityStore } from "./durability-store.js";
import { EntryConcurrencyGate } from "./entry-concurrency-gate.js";
import { EphemeralWorkspaceProvisioner } from "./ephemeral-workspace-provisioner.js";
import { LifecycleAdministrationCoordinator } from "./lifecycle-administration-coordinator.js";
import { projectDaemonCreateRequestReplayParameters } from "./manifest-entry-projection.js";
import { ManifestAdministrationCoordinator } from "./manifest-administration-coordinator.js";
import { ManifestStore } from "./manifest-store.js";
import { withProtectedStateUpgrade, reportStateRecoveryReady, type StateRecoveryBootstrap } from "./state-recovery-key.js";
import { ManifestTransitionCoordinator } from "./manifest-transition-coordinator.js";
import { LegacyLaneCoordinator } from "./legacy-lane-coordinator.js";
import { DaemonLifecycleLog, daemonLifecycleErrorDetail } from "./lifecycle-log.js";
import { NativeActivityPublicationCoordinator } from "./native-activity-publication-coordinator.js";
import { assertMacOS } from "./platform.js";
import { type ProviderActionHandle, type ProviderActionPort, type ProviderActionStreamEvent, type ProviderActionTerminal } from "./provider-action-port.js";
import { ProviderCheckpointCoordinator } from "./provider-checkpoint-coordinator.js";
import { ProviderExecutionCoordinator } from "./provider-execution-coordinator.js";
import {
  ProviderReconciliationCoordinator,
  type DaemonReconcileInput,
} from "./provider-reconciliation-coordinator.js";
import { ProviderSchedulerFailureCoordinator } from "./provider-scheduler-failure-coordinator.js";
import { ProviderStreamCoordinator } from "./provider-stream-coordinator.js";
import { ProviderTerminalCoordinator } from "./provider-terminal-coordinator.js";
import { RoomDeliveryControl } from "./room-delivery-control.js";
import { RoomMoveCoordinator } from "./room-move-coordinator.js";
import { RuntimeRecoveryCoordinator } from "./runtime-recovery-coordinator.js";
import { DaemonFenceLostError, DaemonSingleton, defaultDaemonPaths } from "./singleton.js";
import { type DaemonActivityEvent, type DaemonAgentStreamEvent, type DaemonManifestEntry, type DaemonManifestEntryView, type DaemonRequest, type DaemonRoomMoveRecord, type ExecutionTerminalPayload, type LegacyLaneOwner, type ObservedState, type PolicyCondition, type ReconciliationNotice } from "./types.js";
import {
  deriveProviderConfigurationSnapshot,
  providerSupportsConcurrentSupervisedAgents,
} from "./provider-configuration.js";
import {
  supervisedPermissionProfilesForProvider,
} from "./supervised-permission-profiles.js";
import { createGitCommand, WorkspaceProvisioner, type GitCommand } from "./workspace-provisioner.js";
import { WorkerBindingStore, type WorkerSessionBinding } from "./worker-binding-store.js";
import { WorkerAuthorityCoordinator, type BootstrapOperation } from "./worker-authority-coordinator.js";
import {
  WorkerRuntimeCustody,
  type LiveBindingIdentity,
} from "./worker-runtime-custody.js";
import { structuredRoomTurnCompletion, SupervisedAgentInboxStore } from "./supervised-agent-inbox-store.js";
import { SupervisedAgentDelivery, type SupervisedDeliveryHttp, type SupervisedIngressAgent } from "./supervised-agent-delivery.js";
import { SupervisedDeliveryLifecycleCoordinator } from "./supervised-delivery-lifecycle-coordinator.js";
import { supervisedToolRuntime, type SupervisedToolRuntime } from "./supervised-tool-runtime.js";
import { TurnControlCoordinator } from "./turn-control-coordinator.js";

export {
  productionSupervisedDeliveryHttp,
  SupervisorGrantRequestError,
  workplaceLivenessStaleAfterMs,
  type SupervisorGrantHttp,
} from "./cloud-http.js";
export {
  isSupervisedQuietPollContinuation,
  isSupervisedWaitProviderEvent,
  providerStreamLifecycle,
  resolveReadyReachedAt,
  supervisedWaitCursorFromProviderEvent,
  supervisedWaitEvidenceFromProviderEvent,
} from "./provider-stream-policy.js";
export { sameProcessBirthIdentity } from "./process-identity.js";
export {
  CONTINUATION_REPAIR_EXHAUSTED_ERROR,
  continuationRepairExhaustionNeedsPersistence,
  continuationRepairMissingContinuation,
} from "./continuation-repair-policy.js";
export type { DaemonReconcileInput } from "./provider-reconciliation-coordinator.js";

type DaemonPaths = Pick<ReturnType<typeof defaultDaemonPaths>, "lockPath" | "socketPath" | "manifestPath" | "auditPath"> & Partial<Pick<ReturnType<typeof defaultDaemonPaths>, "legacyManifestPath" | "attemptsPath" | "attemptsRoot" | "workspaceRoot" | "workerBindingsPath">>;
type RecoveryClock = {
  nowMs?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};
export class SupervisorDaemon {
  private readonly stateDatabasePath: string;
  private readonly singleton: DaemonSingleton;
  private readonly authority: DaemonAuthority;
  private readonly store: ManifestStore;
  private readonly legacyLanes: LegacyLaneCoordinator;
  private readonly manifestAdministration: ManifestAdministrationCoordinator;
  private readonly manifestTransitions: ManifestTransitionCoordinator;
  private readonly readModel: DaemonReadModel;
  private readonly lifecycleAdministration: LifecycleAdministrationCoordinator;
  private readonly desiredStates: DesiredStateCoordinator;
  private readonly audit: AuditLog;
  private readonly durability: WorkDurabilityStore;
  private readonly provisioner: WorkspaceProvisioner;
  private readonly ephemeralProvisioner: EphemeralWorkspaceProvisioner;
  private readonly gitCommand: GitCommand;
  private readonly workerBindings: WorkerBindingStore;
  private readonly nativeActivity: NativeActivityPublicationCoordinator;
  private readonly workerAuthority: WorkerAuthorityCoordinator;
  /** Shares the daemon's SQLite durability path; delivery orchestration owns no secrets. */
  private readonly supervisedInbox: SupervisedAgentInboxStore;
  private readonly continuationRepairs: ContinuationRepairCoordinator;
  private readonly roomMoves: RoomMoveCoordinator;
  private readonly supervisedDelivery: SupervisedAgentDelivery | null;
  private readonly supervisedDeliveryLifecycle: SupervisedDeliveryLifecycleCoordinator;
  private readonly turnControls: TurnControlCoordinator;
  private readonly roomDeliveryControl: RoomDeliveryControl;
  private readonly runtimeRecovery: RuntimeRecoveryCoordinator;
  private readonly boundedEffects: BoundedEffectCoordinator;
  private readonly socket: DaemonControlSocket;
  private readonly stateWatch: DaemonStateWatch;
  private readonly entryConcurrency: EntryConcurrencyGate;
  private readonly deliveryCutovers: DeliveryCutoverCoordinator;
  private readonly deliveryCutoverExecution: DeliveryCutoverExecutionCoordinator;
  private readonly liveHandles = new Map<string, ProviderActionHandle>();
  private readonly providerStreams: ProviderStreamCoordinator;
  private executionCapture: ExecutionCaptureCoordinator | null = null;
  private readonly providerCheckpoints: ProviderCheckpointCoordinator;
  private readonly providerExecution: ProviderExecutionCoordinator | null;
  private readonly providerReconciliation: ProviderReconciliationCoordinator | null;
  private readonly providerSchedulerFailures: ProviderSchedulerFailureCoordinator;
  private readonly providerTerminals: ProviderTerminalCoordinator;
  /**
   * Control requests must be able to fence a launch while its per-entry
   * reconciliation lane is awaiting remote authorization or capabilities.
   * They therefore cannot rely on that same lane for ordering.
   */
  private readonly workerRuntimeCustody = new WorkerRuntimeCustody();
  /** Initial-tail reads are authority-bearing admission operations. */
  private readonly bootstrapOperations = new Set<BootstrapOperation>();
  private readonly nowMs: () => number;
  private readonly startedAt = new Date().toISOString();
  private readonly agentStreamRegistry: AgentStreamRegistry;
  private handoffScheduled = false;
  private handoffTeardownScheduled = false;
  /** Resolves only once this daemon has relinquished every authority surface. */
  private readonly handoffCompletion: Promise<void>;
  private resolveHandoffCompletion!: () => void;
  private rejectHandoffCompletion!: (error: unknown) => void;

  private get manifestGeneration(): number {
    return this.authority.generation;
  }

  private set manifestGeneration(generation: number) {
    this.authority.generation = generation;
  }

  constructor(paths: DaemonPaths = defaultDaemonPaths(), private readonly platform = process.platform, private readonly providerPort?: ProviderActionPort, private readonly autoConverge = providerPort?.constructor.name === "CodexProviderActionPort", private readonly nativeHeartbeatIntervalMs = 15_000, private readonly controlRequestBarrier?: (request: DaemonRequest) => Promise<void>, recoveryClock: RecoveryClock = {}, private readonly supervisedDeliveryHttp: SupervisedDeliveryHttp = productionSupervisedDeliveryHttp, private readonly supervisorGrantHttp: SupervisorGrantHttp = productionSupervisorGrantHttp, private readonly loadSupervisedToolRuntime: () => Promise<SupervisedToolRuntime> = supervisedToolRuntime) {
    this.stateDatabasePath = paths.manifestPath;
    this.handoffCompletion = new Promise<void>((resolve, reject) => {
      this.resolveHandoffCompletion = resolve;
      this.rejectHandoffCompletion = reject;
    });
    // A library consumer may prepare a handoff without awaiting its completion.
    // Keep the rejection observed while preserving it for waitForHandoff().
    void this.handoffCompletion.catch(() => undefined);
    this.singleton = new DaemonSingleton(paths.lockPath, platform);
    this.authority = new DaemonAuthority({
      assertCurrent: () => this.singleton.assertCurrent(),
      isHandoffScheduled: () => this.handoffScheduled,
      notifyStateChanged: () => this.notifyStateChanged(),
    });
    this.entryConcurrency = new EntryConcurrencyGate({
      isHandoffScheduled: () => this.handoffScheduled,
    });
    this.deliveryCutovers = new DeliveryCutoverCoordinator({
      isHandoffScheduled: () => this.handoffScheduled,
      drive: (entryId, signal) => this.deliveryCutoverExecution.drive(entryId, signal),
    });
    this.store = new ManifestStore(paths.manifestPath, paths.legacyManifestPath);
    this.legacyLanes = new LegacyLaneCoordinator({
      storage: { load: () => this.store.load() },
      commit: {
        currentGeneration: () => this.manifestGeneration,
        write: (expectedGeneration, entries, owners) => this.writeManifest(expectedGeneration, entries, owners),
        acceptGeneration: (generation) => { this.manifestGeneration = generation; },
      },
      authority: {
        serialize: (operation) => this.serializeManifestMutation(operation),
        assertCurrent: () => this.singleton.assertCurrent(),
      },
      isSupervisedLaneOwner: (entry) => this.isSupervisedLaneOwner(entry),
    });
    this.manifestAdministration = new ManifestAdministrationCoordinator({
      store: this.store,
      authority: {
        serialize: (operation) => this.serializeManifestMutation(operation),
        assertCurrent: () => this.singleton.assertCurrent(),
        currentDaemonGeneration: () => this.singleton.currentGeneration,
        currentManifestGeneration: () => this.manifestGeneration,
        acceptManifestGeneration: (generation) => { this.manifestGeneration = generation; },
        fenceCommit: (commit) => this.fenceDaemonCommit(commit),
      },
      policies: {
        projectCreateReplayParameters: projectDaemonCreateRequestReplayParameters,
        providerSupportsConcurrentAgents: providerSupportsConcurrentSupervisedAgents,
        deriveProviderConfiguration: deriveProviderConfigurationSnapshot,
        permissionProfilesForProvider: supervisedPermissionProfilesForProvider,
        sanitizeActivity: sanitizeDaemonActivityEvent,
        safeErrorDetail: schedulerErrorDetail,
      },
      lanes: {
        liveOwners: (owners) => this.legacyLanes.liveOwners(owners),
      },
      convergence: {
        request: (entryId) => this.requestConvergence(entryId),
      },
    });
    this.audit = new AuditLog(paths.auditPath);
    this.manifestTransitions = new ManifestTransitionCoordinator({
      store: this.store,
      authority: {
        currentManifestGeneration: () => this.manifestGeneration,
        acceptManifestGeneration: (generation) => { this.manifestGeneration = generation; },
        assertCurrent: () => this.singleton.assertCurrent(),
        serializeMutation: (operation) => this.serializeManifestMutation(operation),
        serializeCommit: (operation) => this.serializeManifestCommit(operation),
        fenceCommit: (commit) => this.fenceDaemonCommit(commit),
      },
      audit: this.audit,
      nowMs: () => this.nowMs(),
    });
    const root = paths.workspaceRoot ?? dirname(paths.manifestPath);
    const gitCommand = createGitCommand(root);
    this.gitCommand = gitCommand;
    this.durability = new WorkDurabilityStore(
      paths.attemptsPath ?? `${paths.manifestPath}.attempts`,
      paths.attemptsRoot ?? `${paths.manifestPath}.attempt-data`,
      undefined,
      `${root}/worktrees`,
      undefined,
      gitCommand,
      undefined,
      undefined,
      undefined,
      paths.manifestPath,
    );
    this.provisioner = new WorkspaceProvisioner(root, gitCommand);
    this.ephemeralProvisioner = new EphemeralWorkspaceProvisioner(root);
    this.workerBindings = new WorkerBindingStore(
      paths.workerBindingsPath ?? `${paths.manifestPath}.worker-bindings`,
      (commit) => this.fenceDaemonCommit(commit),
      paths.manifestPath,
    );
    this.nativeActivity = new NativeActivityPublicationCoordinator({
      bindings: this.workerBindings,
      updateEntry: (entryId, update) => this.updateManifestEntry(entryId, update),
      startDelivery: (entryId) => this.startSupervisedDelivery(entryId),
    });
    this.stateWatch = new DaemonStateWatch({
      currentGeneration: () => this.singleton.currentGeneration,
      isHandoffScheduled: () => this.handoffScheduled,
      assertCurrent: () => this.singleton.assertCurrent(),
      entries: async () => this.entriesWithDerivedLiveness((await this.store.load()).entries),
    });
    this.agentStreamRegistry = new AgentStreamRegistry({
      isHandoffScheduled: () => this.handoffScheduled,
    });
    this.lifecycleAdministration = new LifecycleAdministrationCoordinator({
      store: this.store,
      bindings: this.workerBindings,
      durability: this.durability,
      authority: {
        currentDaemonGeneration: () => this.singleton.currentGeneration,
        currentManifestGeneration: () => this.manifestGeneration,
        acceptManifestGeneration: (generation) => { this.manifestGeneration = generation; },
        assertCurrent: () => this.singleton.assertCurrent(),
        fenceCommit: (commit) => this.fenceDaemonCommit(commit),
        serializeManifestMutation: (operation) => this.serializeManifestMutation(operation),
      },
      beginLifecycle: (entryId) => this.entryConcurrency.beginLifecycle(entryId),
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      setDesiredStateExclusive: (entryId, desiredState) => this.desiredStates.setExclusive(entryId, desiredState),
      updateManifestEntry: (entryId, update) => this.updateManifestEntry(entryId, update),
      entryWithDerivedLiveness: (entry) => this.entryWithDerivedLiveness(entry),
      stopDelivery: async (entryId) => { await this.supervisedDelivery?.stop(entryId); },
      hasLiveHandle: (entryId) => this.liveHandles.has(entryId),
      ...(providerPort ? { provider: providerPort } : {}),
      runtimeCustody: this.workerRuntimeCustody,
      deleteAgentStream: (entryId) => this.agentStreamRegistry.delete(entryId),
      ephemeralProvisioner: this.ephemeralProvisioner,
      nowMs: () => this.nowMs(),
    });
    // Inbox state belongs to the canonical daemon database. The worker-binding
    // path is a legacy JSON import source and must never become a second SQLite
    // authority for delivery receipts.
    this.supervisedInbox = new SupervisedAgentInboxStore(
      paths.manifestPath,
      undefined,
      () => this.notifyStateChanged(),
    );
    this.workerAuthority = new WorkerAuthorityCoordinator({
      store: this.store,
      durability: this.durability,
      bindings: this.workerBindings,
      custody: this.workerRuntimeCustody,
      inbox: this.supervisedInbox,
      supervisorGrantHttp: this.supervisorGrantHttp,
      deliveryHttp: this.supervisedDeliveryHttp,
      authority: {
        currentGeneration: () => this.singleton.currentGeneration,
        isHandoffScheduled: () => this.handoffScheduled,
        assertCurrent: () => this.singleton.assertCurrent(),
        fenceCommit: (commit) => this.fenceDaemonCommit(commit),
      },
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      serializeCursorCheckpoint: (entryId, operation) => this.serializeCursorCheckpoint(entryId, operation),
      manifest: {
        updateEntry: (entryId, update) => this.updateManifestEntry(entryId, update),
      },
      runtime: {
        currentHandle: (entryId) => this.liveHandles.get(entryId),
        attach: (entry, mayPublish) => this.attachLiveProvider(entry, mayPublish),
      },
      delivery: {
        stop: async (entryId) => { await this.supervisedDelivery?.stop(entryId); },
        start: (entryId) => this.startSupervisedDelivery(entryId),
      },
      convergence: {
        request: (entryId) => this.requestConvergence(entryId),
        schedule: (entryId, delayMs) => this.scheduleRecoveryConvergence(entryId, delayMs),
        clear: (entryId) => this.clearRecoveryConvergence(entryId),
        heartbeatIntervalMs: this.nativeHeartbeatIntervalMs,
      },
      recovery: {
        resetMintAttempts: (entryId) => this.providerSchedulerFailures.resetMintRecovery(entryId),
      },
      activity: {
        publishNative: (entryId, method, status) => this.publishNativeActivity(entryId, method, status),
        transition: (entryId, state, condition, detail, source) => this.transition(entryId, state, condition, detail, source),
      },
      boundedContext: (input) => this.exactActiveBoundedContext(input),
      nowMs: recoveryClock.nowMs ?? Date.now,
      setTimeout: recoveryClock.setTimeout ?? setTimeout,
      clearTimeout: recoveryClock.clearTimeout ?? clearTimeout,
    });
    this.providerStreams = new ProviderStreamCoordinator({
      liveHandles: this.liveHandles,
      observeExecution: (entryId, handle, generation) => this.executionCapture?.install(entryId, handle, generation) ?? (() => {}),
      ...(providerPort ? { provider: providerPort } : {}),
      manifest: {
        getEntry: (entryId) => this.store.getEntry(entryId),
        load: () => this.store.load(),
        updateEntry: (entryId, update) => this.updateManifestEntry(entryId, update),
      },
      bindings: this.workerBindings,
      durability: this.durability,
      runtimeCustody: this.workerRuntimeCustody,
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      transition: (entryId, state, condition, detail, actor) =>
        this.transition(entryId, state, condition, detail, actor),
      appendActivity: (entryId, event) => this.appendActivity(entryId, event),
      publishNativeActivity: (entryId, method, status, observedAt) =>
        this.publishNativeActivity(entryId, method, status, observedAt),
      handleTerminal: (entryId, handle, executionGenerationId, bindingIdentity, terminal) =>
        this.handleProviderTerminal(entryId, handle, executionGenerationId, bindingIdentity, terminal),
      streams: {
        reset: (entryId) => this.resetAgentStream(entryId),
        push: (entryId, event) => this.pushAgentStreamEvent(entryId, event),
        end: (entryId) => this.endAgentStream(entryId),
      },
      delivery: {
        start: (entryId) => this.startSupervisedDelivery(entryId),
        startCutover: (entryId) => this.deliveryCutovers.start(entryId),
      },
      heartbeat: {
        intervalMs: this.nativeHeartbeatIntervalMs,
        requiresHostGrant: (entry) => this.workerAuthority.requiresHostGrant(entry),
        currentHostGrant: (entry) => this.workerAuthority.currentHostGrant(entry),
        hostGrantNeedsRenewal: (grant) => this.workerAuthority.hostGrantNeedsRenewal(grant),
        hostWorkerBearerNeedsRotation: (entry, binding) =>
          this.workerAuthority.hostWorkerBearerNeedsRotation(entry, binding),
        requestConvergence: (entryId) => this.requestConvergence(entryId),
      },
    });
    this.providerSchedulerFailures = new ProviderSchedulerFailureCoordinator({
      nativeHeartbeatIntervalMs: this.nativeHeartbeatIntervalMs,
      currentDaemonGeneration: () => this.singleton.currentGeneration,
      nowMs: () => this.nowMs(),
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      serializeManifest: (operation) => this.serializeManifestMutation(operation),
      manifest: {
        load: () => this.store.load(),
        updateEntry: (entryId, update) => this.updateManifestEntry(entryId, update),
      },
      transitionOnce: (entryId, state, condition, cause, actor, reconciliation, notice, terminal) =>
        this.transitionOnce(entryId, state, condition, cause, actor, reconciliation, notice, terminal),
      audit: this.audit,
      scheduleRecovery: (entryId, delayMs) => this.scheduleRecoveryConvergence(entryId, delayMs),
    });
    this.providerExecution = providerPort
      ? new ProviderExecutionCoordinator({
        provider: providerPort,
        store: this.store,
        durability: this.durability,
        bindings: this.workerBindings,
        streams: this.providerStreams,
        authority: {
          isHandoffScheduled: () => this.handoffScheduled,
          currentDaemonGeneration: () => this.singleton.currentGeneration,
          currentManifestGeneration: () => this.manifestGeneration,
          acceptManifestGeneration: (generation) => { this.manifestGeneration = generation; },
          assertCurrent: () => this.singleton.assertCurrent(),
          ownsDaemonGeneration: (generation) => this.workerAuthority.ownsDaemonGeneration(generation),
          fenceCommit: (commit) => this.fenceDaemonCommit(commit),
          serializeManifestMutation: (operation) => this.serializeManifestMutation(operation),
          serializeManifestCommit: (operation) => this.serializeManifestCommit(operation),
        },
        concurrency: {
          currentControlEpoch: (entryId) => this.entryConcurrency.currentControlEpoch(entryId),
          serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
        },
        updateManifestEntry: (entryId, update) => this.updateManifestEntry(entryId, update),
        transition: (entryId, state, condition, detail, actor) =>
          this.transition(entryId, state, condition, detail, actor),
        terminalPayload: (terminal, actor) => this.terminalPayload(terminal, actor),
        observeProviderExit: (entryId, terminal, actor, executionGenerationId, handle) =>
          this.observeProviderExitOnce(entryId, terminal, actor, executionGenerationId, handle),
        completeTurnControlForRuntimeRecovery: (entry) =>
          this.runtimeRecovery.completeTurnControl(entry),
        delivery: {
          stop: async (entryId) => { await this.supervisedDelivery?.stop(entryId); },
          start: (entryId, mode) => this.startSupervisedDelivery(entryId, mode ?? "refresh"),
        },
        inbox: {
          cursor: (entryId) => this.supervisedInbox.cursor(entryId),
        },
        host: {
          requiresGrant: (entry) => this.workerAuthority.requiresHostGrant(entry),
          currentGrant: (entry) => this.workerAuthority.currentHostGrant(entry),
          ensureGrantFresh: (entry) => this.workerAuthority.ensureHostGrantFresh(entry),
          mintAuthorization: (entry) => this.workerAuthority.mintHostWorkerAuthorization(entry),
          recordMintedSession: (entry, executionGenerationId, authorization) =>
            this.workerAuthority.recordMintedHostWorkerSession(entry, executionGenerationId, authorization),
          mintSession: (entry, executionGenerationId) =>
            this.workerAuthority.mintHostWorkerSession(entry, executionGenerationId),
          bindMintedSession: (entryId, session, mayPublish) =>
            this.workerAuthority.bindMintedHostWorkerSession(entryId, session, mayPublish),
          bearerNeedsRotation: (entry, binding) =>
            this.workerAuthority.hostWorkerBearerNeedsRotation(entry, binding),
          blockExpiredAuthority: (entry, detail) =>
            this.workerAuthority.blockExpiredWorkerAuthority(entry, detail),
          currentOpenModelCredential: (entryId, daemonGeneration) =>
            this.workerRuntimeCustody.currentOpenModelCredential(entryId, daemonGeneration),
          recordBindingRecoveryFailure: (entryId, executionGenerationId, error) =>
            this.workerAuthority.recordWorkerBindingRecoveryFailure(entryId, executionGenerationId, error),
          clearSuccessfulRecovery: (entryId) =>
            this.providerSchedulerFailures.clearSuccessfulRecovery(entryId),
        },
        workspace: {
          ephemeral: this.ephemeralProvisioner,
          git: this.provisioner,
          gitCommand: this.gitCommand,
        },
        socketPath: paths.socketPath,
        autoConverge: this.autoConverge,
        nowMs: () => this.nowMs(),
        recordSchedulerFailure: (entryId, error, actor) =>
          this.recordSchedulerFailure(entryId, error, actor),
        ...(recoveryClock.setTimeout ? { setTimeout: recoveryClock.setTimeout } : {}),
        ...(recoveryClock.clearTimeout ? { clearTimeout: recoveryClock.clearTimeout } : {}),
      })
      : null;
    this.providerReconciliation = providerPort
      ? new ProviderReconciliationCoordinator({
        provider: providerPort,
        store: this.store,
        authority: {
          assertCurrent: () => this.singleton.assertCurrent(),
          currentManifestGeneration: () => this.manifestGeneration,
          acceptManifestGeneration: (generation) => { this.manifestGeneration = generation; },
          fenceCommit: (commit) => this.fenceDaemonCommit(commit),
          serializeManifest: (operation) => this.serializeManifestMutation(operation),
        },
        serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
        transitionOnce: (entryId, state, condition, cause, actor, reconciliation, notice, terminal) =>
          this.transitionOnce(entryId, state, condition, cause, actor, reconciliation, notice, terminal),
        terminalPayload: (terminal, actor) => this.terminalPayload(terminal, actor),
        observeProviderExit: (entryId, terminal, actor) =>
          this.observeProviderExit(entryId, terminal, actor),
        recordSchedulerFailure: (entryId, error, actor) =>
          this.recordSchedulerFailure(entryId, error, actor),
        nowMs: () => this.nowMs(),
      })
      : null;
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
      )
      : null;
    this.readModel = new DaemonReadModel({
      currentDaemonGeneration: () => this.singleton.currentGeneration,
      nowMs: () => this.nowMs(),
      startedAt: this.startedAt,
      capabilities: {
        hasDelivery: () => Boolean(this.supervisedDelivery),
        supportsRoomTurns: () => Boolean(this.providerPort?.runRoomTurn),
        supportsContinuationRepair: () => Boolean(this.providerPort?.repairContinuation),
      },
      manifest: {
        load: () => this.store.load(),
        getEntry: (entryId) => this.store.getEntry(entryId),
      },
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
      delivery: {
        start: (entryId) => this.startSupervisedDelivery(entryId),
      },
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      serializeManifest: (operation) => this.serializeManifestMutation(operation),
      transitionOnce: (entryId, state, condition, cause, actor, reconciliation, notice, terminal) =>
        this.transitionOnce(entryId, state, condition, cause, actor, reconciliation, notice, terminal),
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
      legacyLanes: this.legacyLanes,
      manifestAdministration: this.manifestAdministration,
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
    this.runtimeRecovery = new RuntimeRecoveryCoordinator({
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
    });
    const controlOperations = {
      activateCustodialPolling: (input) => this.deliveryCutoverExecution.activatePolling(input),
      getPollingActivation: (input) => this.deliveryCutoverExecution.getPollingActivation(input),
      cancelPollingActivation: (input) => this.deliveryCutoverExecution.cancelPollingActivation(input),
      prepareDeliveryDrain: (input) => this.deliveryCutoverExecution.prepareDrain(input),
      getDeliveryDrain: (input) => this.deliveryCutoverExecution.getDrain(input),
      cancelDeliveryDrain: (input) => this.deliveryCutoverExecution.cancelDrain(input),
      acknowledgeInspectorRoomMoveSourceRevocation: (input) => this.roomMoves.acknowledgeSourceRevocation(input),
      activateLegacyLane: this.activateLegacyLane.bind(this),
      appendActivity: this.appendActivity.bind(this),
      bindWorkerSession: this.workerAuthority.bindWorkerSession.bind(this.workerAuthority),
      bootstrapRoomIngress: (input) => this.beginBootstrap(this.workerAuthority.bootstrapRoomIngress.bind(this.workerAuthority), input),
      borrowWorkerCredential: this.workerAuthority.borrowWorkerCredential.bind(this.workerAuthority),
      authorizeCustodialPolling: this.workerAuthority.authorizeCustodialPolling.bind(this.workerAuthority),
      checkpointWorkerCursor: this.workerAuthority.checkpointWorkerCursor.bind(this.workerAuthority),
      commitInspectorRoomMove: (input) => this.roomMoves.commitInspector(input),
      compareAndSetDesiredState: this.desiredStates.compareAndSet.bind(this.desiredStates),
      completeBoundedEffect: this.completeBoundedEffect.bind(this),
      executeBoundedTool: this.executeBoundedTool.bind(this),
      controlTurn: (input) => this.turnControls.control(input),
      entryWithDerivedLiveness: this.entryWithDerivedLiveness.bind(this),
      getAgentConfiguration: this.getAgentConfiguration.bind(this),
      getAgentInspectorDetail: this.getAgentInspectorDetail.bind(this),
      getCurrentInspectorRoomMove: (input) => this.roomMoves.getCurrentInspector(input),
      getInspectorRoomMove: (input) => this.roomMoves.getInspector(input),
      installHostGrant: this.workerAuthority.installHostGrant.bind(this.workerAuthority),
      installOpenModelCredential: this.workerAuthority.installOpenModelCredential.bind(this.workerAuthority),
      installWorkerCredential: this.workerAuthority.installWorkerCredential.bind(this.workerAuthority),
      listManifest: async () => this.entriesWithDerivedLiveness((await this.store.load()).entries),
      prepareBoundedEffect: this.prepareBoundedEffect.bind(this),
      prepareHandoff: this.prepareHandoff.bind(this),
      prepareInspectorRoomMove: (input) => this.roomMoves.prepareInspector(input),
      purgeAgent: this.lifecycleAdministration.purgeAgent.bind(this.lifecycleAdministration),
      putManifestEntry: this.putManifestEntry.bind(this),
      readAttempt: this.readAttempt.bind(this),
      recoverAgentRuntime: this.runtimeRecovery.recoverAgentRuntime.bind(this.runtimeRecovery),
      releaseLegacyLane: this.releaseLegacyLane.bind(this),
      reserveLegacyLane: this.reserveLegacyLane.bind(this),
      resolveTurnControl: (input) => this.turnControls.resolve(input),
      restoreAgentConversation: this.restoreAgentConversation.bind(this),
      retireAgent: this.lifecycleAdministration.retireAgent.bind(this.lifecycleAdministration),
      retryRoomDelivery: this.retryRoomDelivery.bind(this),
      rollbackInspectorRoomMove: (input) => this.roomMoves.rollbackInspector(input),
      setDesiredState: this.desiredStates.set.bind(this.desiredStates),
      setDisplayName: this.setDisplayName.bind(this),
      skipRoomDelivery: this.skipRoomDelivery.bind(this),
      status: this.status.bind(this),
      updateAgentConfiguration: this.updateAgentConfiguration.bind(this),
      updateWorkplaceLiveness: this.updateWorkplaceLiveness.bind(this),
      verifyWorkerSession: this.workerAuthority.verifyWorkerSession.bind(this.workerAuthority),
      watchAgentStream: this.watchAgentStream.bind(this),
      watchState: this.watchState.bind(this),
    } satisfies DaemonControlOperations;
    this.socket = new DaemonControlSocket(
      paths.socketPath,
      createDaemonControlRequestHandler({
        assertCurrent: () => this.singleton.assertCurrent(),
        currentGeneration: () => this.singleton.currentGeneration,
        isHandoffScheduled: () => this.handoffScheduled,
        requestBarrier: this.controlRequestBarrier,
      }, controlOperations),
      async (error) => { if (error instanceof DaemonFenceLostError) await this.stop(); },
    );
    this.nowMs = recoveryClock.nowMs ?? Date.now;
  }

  async start(storage: StateRecoveryBootstrap = {}): Promise<void> {
    assertMacOS(this.platform);
    await this.singleton.acquire();
    try {
      this.manifestGeneration = await withProtectedStateUpgrade(this.stateDatabasePath, async () => {
        this.durability.bindSupervisorFence(this.supervisorFenceIdentity());
        return (await this.store.load()).generation;
      }, storage);
    } catch (error) {
      await this.store.close();
      await this.singleton.release();
      throw error;
    }
    if (!this.handoffScheduled) this.executionCapture = ExecutionCaptureCoordinator.open(this.stateDatabasePath, this.providerPort, {
      currentHandle: (entryId) => this.liveHandles.get(entryId), daemonGeneration: () => this.singleton.currentGeneration,
    });
    await this.supervisedInbox.normalizeInterruptedEffects();
    await this.quarantineDuplicateSupervisedLaneOwners();
    await this.runtimeRecovery.recoverTurnControls();
    await this.recoverOrphanedLegacyReservations();
    await this.roomMoves.reconcilePrepared();
    await this.lifecycleAdministration.recoverPreparedPurges();
    await this.lifecycleAdministration.recoverEphemeralWorkspaces();
    await this.socket.start();
    for (const entry of (await this.store.load()).entries) {
      void this.startSupervisedDelivery(entry.id).catch(() => undefined);
      if (await this.store.unresolvedDeliveryDrain(entry.id) || await this.store.unresolvedPollingActivation(entry.id)) {
        void this.deliveryCutovers.start(entry.id).catch(() => undefined);
      }
    }
    if (this.providerPort && this.autoConverge) {
      for (const entry of (await this.store.load()).entries) this.requestConvergence(entry.id);
    }
  }

  async stop(): Promise<void> {
    // Stop is final for this daemon instance. Fence late delivery/cutover
    // continuations before awaiting any drain so they cannot retain a socket
    // or SQLite handle after the caller has observed shutdown.
    this.handoffScheduled = true;
    this.executionCapture?.close();
    this.supervisedDelivery?.fence();
    this.wakeRoomMoveReconciliationWaiters();
    this.notifyStateChanged();
    this.workerRuntimeCustody.destroyAllCredentials();
    await this.deliveryCutovers.fenceAndDrain();
    await this.supervisedDelivery?.fenceAndDrain();
    await this.fenceAndDrainRoomMoveReconciliations();
    await this.boundedEffects.drainJournalReservations();
    this.providerExecution?.clearRecoveryTimers();
    await this.providerReconciliation?.disposeAll();
    await this.providerExecution?.drainConvergence();
    await this.providerStreams.disposeAll();
    await this.socket.stop();
    await this.serializeManifestCommit(() => this.singleton.release());
    await this.store.close();
    await this.durability.close();
    await this.workerBindings.close();
    await this.supervisedInbox.close();
  }

  /**
   * Wait for a requested version handoff to finish. This is intentionally a
   * daemon-lifecycle promise rather than a socket response: prepare_handoff
   * must acknowledge before it tears down the connection carrying that reply.
   */
  async waitForHandoff(): Promise<void> {
    await this.handoffCompletion;
  }

  /**
   * Version handoff must release daemon authority independently of provider or
   * network callback latency. Provider work survives; only this daemon's
   * observers and control authority are detached.
   */
  private async stopForHandoff(): Promise<void> {
    // Fence first. Any callbacks that outlive this method are prevented from
    // committing daemon-owned state by fenceDaemonCommit().
    this.workerRuntimeCustody.destroyAllCredentials();
    this.wakeRoomMoveReconciliationWaiters();
    const failures: unknown[] = [];
    try { await this.deliveryCutovers.fenceAndDrain(); } catch (error) { failures.push(error); }
    try { await this.supervisedDelivery?.fenceAndDrain(); } catch (error) { failures.push(error); }
    try { await this.fenceAndDrainRoomMoveReconciliations(); } catch (error) { failures.push(error); }
    const captureSync = (operation: () => void): void => {
      try { operation(); } catch (error) { failures.push(error); }
    };
    captureSync(() => this.providerReconciliation?.detachAll());
    captureSync(() => this.providerExecution?.clearRecoveryTimers());
    // Remote grant/capability waits remain freely cancellable, but once a
    // native provider dispatch begins its exact returned identity must be
    // persisted before the shared stores are closed for successor attach.
    await this.providerExecution?.drainDispatches();
    await this.boundedEffects.drainJournalReservations();
    captureSync(() => this.providerStreams.detachAll());
    // Complete every local cleanup step even if one fails. The process-level
    // entrypoint will report the failure and exit non-zero, but should never
    // leave the singleton lock behind merely because (for example) socket
    // unlinking failed after the listener had already closed.
    const cleanup = async (operation: () => Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { failures.push(error); }
    };
    await cleanup(() => this.socket.stop());
    await cleanup(() => this.serializeManifestCommit(() => this.singleton.release()));
    await cleanup(() => this.store.close());
    await cleanup(() => this.durability.close());
    await cleanup(() => this.workerBindings.close());
    await cleanup(() => this.supervisedInbox.close());
    // Existing convergence/provider callbacks are generation-fenced below.
    // Do not await them: a wedged native transport must not block an upgrade.
    this.providerExecution?.detachConvergence();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Supervisor handoff cleanup did not complete cleanly.");
    }
  }

  /**
   * Retries one known blocked receipt. Every identity in the renderer request
   * is compared with the currently-owned runtime before the in-memory bearer
   * is read, so a historical binding cannot reanimate a replacement worker.
   */
  private async retryRoomDelivery(input: {
    entryId: string; roomId: string; sourceMessageId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; daemonGeneration: number;
  }): Promise<void> {
    await this.roomDeliveryControl.retry(input);
  }

  private async restoreAgentConversation(input: {
    entryId: string; roomId: string; sourceMessageId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; daemonGeneration: number;
  }): Promise<void> {
    await this.roomDeliveryControl.restoreConversation(input);
  }

  private async skipRoomDelivery(input: {
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
  private async restoreMissingProviderContinuation(input: {
    agent: SupervisedIngressAgent;
    item: import("./supervised-agent-inbox-store.js").SupervisedInboxItem;
    manual: boolean;
  }): Promise<"restored" | "replaced" | "authority_changed" | "failed"> {
    return this.continuationRepairs.restore(input);
  }

  /** Inspector reads are exact-entry scoped; a room mismatch never falls back to history. */
  private async getAgentInspectorDetail(entryId: string, roomId: string, sourceMessageId: string | null) {
    return this.readModel.inspectorDetail(entryId, roomId, sourceMessageId);
  }

  private async exactActiveBoundedContext(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number; providerTurnId?: string;
  }) {
    return this.supervisedDeliveryLifecycle.exactActiveBoundedContext(input);
  }

  private prepareBoundedEffect(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string;
    mcpRequestId: string; toolName: string; input: unknown; mutation: boolean;
  }): Promise<Record<string, unknown>> {
    return this.boundedEffects.prepare(input);
  }

  private async executeBoundedTool(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string; mcpRequestId: string; toolName: string; input: unknown;
  }): Promise<Record<string, unknown>> {
    return this.boundedEffects.execute(input);
  }

  private completeBoundedEffect(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string;
    effectId: string; result?: unknown; error?: string;
  }): Promise<{ completed: true }> {
    return this.boundedEffects.complete(input);
  }

  private async completeBoundedEffectOnce(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string;
    effectId: string; result?: unknown; error?: string;
  }, admittedDaemonExecution = false): Promise<{ completed: true }> {
    return this.boundedEffects.completeOnce(input, admittedDaemonExecution);
  }

  /** Compatibility seam for focused daemon integration tests; production callers use roomMoves directly. */
  private reconcileRoomMove(initial: DaemonRoomMoveRecord): Promise<DaemonRoomMoveRecord> {
    return this.roomMoves.reconcile(initial);
  }

  private async waitForActiveRoomMoveReconciliation(entryId: string): Promise<void> {
    await this.entryConcurrency.waitForActiveRoomMove(entryId);
  }

  private wakeRoomMoveReconciliationWaiters(): void {
    this.entryConcurrency.wakeRoomMoveWaiters();
  }

  /**
   * Handoff fences admission synchronously. Only reconciliation that already
   * entered its bounded critical section is drained; callbacks queued behind
   * unrelated entry work are woken and later return their captured snapshot
   * without touching a closed store.
   */
  private async fenceAndDrainRoomMoveReconciliations(): Promise<void> {
    await this.entryConcurrency.fenceAndDrainRoomMoves();
  }

  /** Build a delivery agent only from one current manifest, handle, binding, and memory credential tuple. */
  private async startSupervisedDelivery(entryId: string, mode: "refresh" | "ensure" | "wake" = "refresh"): Promise<void> {
    await this.supervisedDeliveryLifecycle.start(entryId, mode);
  }

  private async restartSupervisedDeliveryOrConverge(entryId: string): Promise<void> {
    await this.supervisedDeliveryLifecycle.restartOrConverge(entryId);
  }

  private status() {
    return this.readModel.status();
  }

  private async prepareHandoff(): Promise<void> {
    if (this.handoffTeardownScheduled) return;
    if (!this.handoffScheduled) this.handoffScheduled = true;
    this.executionCapture?.close();
    // Authority revocation and delivery cancellation are one synchronous
    // edge. No claimed FIFO item may observe the public fence before its
    // controller is aborted and its cleanup owner is established.
    this.supervisedDelivery?.fence();
    this.wakeRoomMoveReconciliationWaiters();
    this.notifyStateChanged();
    // A bootstrap that already read tail N must commit N before lock/socket
    // release. Otherwise a successor could establish a later tail and skip a
    // message that raced this handoff. New bootstrap requests are rejected by
    // the public fence above; this only drains operations admitted before it.
    for (const bootstrap of this.bootstrapOperations) {
      if (bootstrap.phase === "observing") bootstrap.controller.abort();
    }
    await Promise.allSettled([...this.bootstrapOperations].map((bootstrap) => bootstrap.operation));
    await this.fenceAndDrainRoomMoveReconciliations();
    // Retire secret custody synchronously with the public handoff fence. The
    // dispatch preflight then proves every native return is journaled before
    // the acknowledgement can authorize Electron to replace this daemon.
    this.workerRuntimeCustody.destroyOwnerCredentials();
    await this.providerExecution?.drainDispatches();
    await this.boundedEffects.drainJournalReservations();
    await this.boundedEffects.drainExternalExecutions();
    this.handoffTeardownScheduled = true;
    // Delayed teardown exists only to flush the successful socket reply.
    setTimeout(() => {
      void this.stopForHandoff().then(
        () => this.resolveHandoffCompletion(),
        (error) => this.rejectHandoffCompletion(error),
      );
    }, 25).unref();
  }

  private beginBootstrap<T>(run: (input: { entry_id: string; daemon_generation: number }, operation: BootstrapOperation) => Promise<T>, input: { entry_id: string; daemon_generation: number }): Promise<T> {
    const controller = new AbortController();
    const operation: BootstrapOperation = { controller, phase: "observing", operation: Promise.resolve() };
    const result = run(input, operation);
    operation.operation = result;
    this.bootstrapOperations.add(operation);
    const clear = () => this.bootstrapOperations.delete(operation);
    void result.then(clear, clear);
    return result;
  }

  private isSupervisedLaneOwner(entry: DaemonManifestEntry): boolean {
    return this.manifestAdministration.isSupervisedLaneOwner(entry);
  }

  /**
   * Providers whose entries own independently addressable runtimes may have
   * multiple supervised participants in one room. This only relaxes
   * supervised-vs-supervised admission; a live supervised entry still fences
   * an Electron-owned legacy runtime for that provider below.
   */
  private competingSupervisedLaneOwner(
    entries: readonly DaemonManifestEntry[],
    entry: DaemonManifestEntry,
  ): DaemonManifestEntry | undefined {
    return this.manifestAdministration.competingSupervisedLaneOwner(entries, entry);
  }

  private async quarantineDuplicateSupervisedLaneOwners(): Promise<void> {
    await this.manifestAdministration.quarantineDuplicateSupervisedLaneOwners();
  }

  /** Inspector configuration is a durable optimistic-concurrency resource. */
  private async getAgentConfiguration(entryId: string, daemonGeneration: number) {
    return this.manifestAdministration.getAgentConfiguration(entryId, daemonGeneration);
  }

  private async updateAgentConfiguration(input: { entryId: string; daemonGeneration: number; expectedRevision: number; configuration: Record<string, unknown> }) {
    return this.manifestAdministration.updateAgentConfiguration(input);
  }

  private async putManifestEntry(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    return this.manifestAdministration.putManifestEntry(entry);
  }

  /**
   * Repair mutable product identity without touching provider execution,
   * delivery cursors, credentials, or lifecycle authority.
   */
  private async setDisplayName(id: string, displayName: string): Promise<DaemonManifestEntry> {
    return this.manifestAdministration.setDisplayName(id, displayName);
  }

  private admitNewTurnControl(entryId: string): void {
    this.turnControls.admitNew(entryId);
  }

  private async reserveLegacyLane(input: { reservation_id: string; room_id: string; provider: string; owner_pid: number; owner_process_identity: string }): Promise<LegacyLaneOwner> {
    return this.legacyLanes.reserve(input);
  }

  private liveLegacyLaneOwners(owners: readonly LegacyLaneOwner[]): LegacyLaneOwner[] {
    return this.legacyLanes.liveOwners(owners);
  }

  private async recoverOrphanedLegacyReservations(): Promise<void> {
    await this.legacyLanes.recoverOrphanedReservations();
  }

  private async activateLegacyLane(reservationId: string, sessionId: string): Promise<LegacyLaneOwner> {
    return this.legacyLanes.activate(reservationId, sessionId);
  }

  private async releaseLegacyLane(input: { reservation_id: string | null; session_id: string | null; room_id: string | null; provider: string | null }): Promise<{ released: boolean }> {
    return this.legacyLanes.release(input);
  }

  private async appendActivity(id: string, event: DaemonActivityEvent): Promise<DaemonManifestEntry> {
    return this.manifestAdministration.appendActivity(id, event);
  }

  private async updateWorkplaceLiveness(id: string, state: "reachable" | "stale" | "unknown", detail: string | null, observedAt: string): Promise<DaemonManifestEntry> {
    return this.manifestAdministration.updateWorkplaceLiveness(id, state, detail, observedAt);
  }

  private async entriesWithDerivedLiveness(entries: DaemonManifestEntry[]): Promise<DaemonManifestEntryView[]> {
    return this.readModel.entriesWithDerivedLiveness(entries);
  }

  private notifyStateChanged(): void {
    this.stateWatch.notify();
    try { this.executionCapture?.refresh(); } catch { /* optional observation */ }
  }

  private pushAgentStreamEvent(entryId: string, event: DaemonActivityEvent): void {
    this.agentStreamRegistry.push(entryId, event);
  }

  private resetAgentStream(entryId: string): void {
    this.agentStreamRegistry.reset(entryId);
  }

  private endAgentStream(entryId: string): void {
    this.agentStreamRegistry.end(entryId);
  }

  private async watchAgentStream(input: {
    entryId: string;
    afterSequence: number;
    waitMs: number;
  }): Promise<{ sequence: number; stream_generation: number; dropped_events: number; events: DaemonAgentStreamEvent[]; ended: boolean }> {
    return this.agentStreamRegistry.watch(input);
  }

  private async watchState(input: {
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

  private async entryWithDerivedLiveness(
    entry: DaemonManifestEntry,
    projectedBinding?: WorkerSessionBinding | null,
  ): Promise<DaemonManifestEntryView> {
    return this.readModel.entryWithDerivedLiveness(entry, projectedBinding);
  }

  private async readAttempt(id: string) {
    return this.readModel.attempt(id);
  }

  /** Queue convergence without making a control-socket caller wait for launch. */
  private requestConvergence(entryId: string): void {
    this.providerExecution?.request(entryId);
  }

  private bumpEntryControlEpoch(entryId: string): number {
    return this.entryConcurrency.bumpControlEpoch(entryId);
  }

  private reserveBoundedEffectJournal<T>(operation: () => Promise<T>): Promise<T> {
    return this.boundedEffects.reserveJournal(operation);
  }

  private attachLiveProvider(
    entry: DaemonManifestEntry,
    mayStartDelivery: () => boolean = () => true,
  ): Promise<ProviderActionHandle | null> {
    if (!entry.provider_ref) return Promise.resolve(null);
    const coordinator = this.providerExecution;
    if (!coordinator) throw new Error("Provider action port is unavailable");
    return coordinator.attachLiveProvider(entry, mayStartDelivery);
  }

  private installProviderHandle(
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

  private stageWorkerBindingAfterResume(
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

  private handleProviderStream(
    entryId: string,
    handle: ProviderActionHandle,
    event: ProviderActionStreamEvent,
  ): Promise<void> {
    return this.providerStreams.handle(entryId, handle, event);
  }

  private serializeCursorCheckpoint<T>(
    entryId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.providerStreams.serializeCursorCheckpoint(entryId, operation);
  }

  private fenceTerminalProviderHandleOnce(
    handle: ProviderActionHandle,
    actionId: string,
  ): Promise<void> {
    return this.providerStreams.fenceTerminalOnce(handle, actionId);
  }

  private scheduleRecoveryConvergence(entryId: string, delayMs: number): void {
    this.providerExecution?.scheduleRecovery(entryId, delayMs);
  }

  private clearRecoveryConvergence(entryId: string): void {
    this.providerExecution?.clearRecovery(entryId);
  }

  private async publishNativeActivity(entryId: string, method: string, status: "working" | "idle", observedAt = new Date().toISOString()): Promise<boolean> {
    return this.nativeActivity.publish(entryId, method, status, observedAt);
  }

  private async handleProviderTerminal(entryId: string, handle: ProviderActionHandle, executionGenerationId: string, _terminalBinding: LiveBindingIdentity | undefined, terminal: ProviderActionTerminal): Promise<void> {
    await this.providerTerminals.handleTerminal(entryId, handle, executionGenerationId, terminal);
  }

  private async updateManifestEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
    roomMoveCancellation?: { agentId: string; detail: string },
  ): Promise<DaemonManifestEntry> {
    return this.manifestTransitions.updateEntry(entryId, update, roomMoveCancellation);
  }

  /** Identity P1b/P1d must pass into work-durability fencing. */
  supervisorFenceIdentity(): { supervisor_id: string; supervisor_generation: number } {
    return { supervisor_id: this.singleton.lockPath, supervisor_generation: this.singleton.currentGeneration };
  }

  async transition(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"]): Promise<void> {
    return this.manifestTransitions.transition(entryId, to, condition, cause, actor, reconciliation);
  }

  private async transitionOnce(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"], notice?: ReconciliationNotice["kind"], terminal?: ExecutionTerminalPayload): Promise<void> {
    await this.manifestTransitions.transitionOnce(
      entryId,
      to,
      condition,
      cause,
      actor,
      reconciliation,
      notice,
      terminal,
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

  private async serializeEntryTick<T>(entryId: string, operation: () => Promise<T>): Promise<T> {
    return this.entryConcurrency.run(entryId, operation);
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

  private async observeProviderExitOnce(entryId: string, terminal: ProviderActionTerminal, actor: string, expectedExecutionGenerationId?: string, expectedHandle?: ProviderActionHandle): Promise<void> {
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

  private async serializeManifestMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.authority.serializeManifestMutation(operation);
  }

  private writeManifest(
    expectedGeneration: number,
    entries: DaemonManifestEntry[],
    legacyOwners?: LegacyLaneOwner[],
    roomMoveCancellation?: { agentId: string; detail: string },
  ) {
    return this.store.write(
      expectedGeneration,
      entries,
      legacyOwners,
      (commit) => this.fenceDaemonCommit(commit),
      roomMoveCancellation,
    );
  }

  private fenceDaemonCommit(commit: () => Promise<void>): Promise<void> {
    return this.authority.fenceDaemonCommit(commit);
  }

  /**
   * Finish only an exact provider transition or tool journal completion
   * already admitted by this generation. Handoff has synchronously fenced new
   * work, but the old daemon still owns the singleton and must leave admitted
   * state honest before releasing it to a successor.
   */
  private fenceAdmittedTransitionCommit(commit: () => Promise<void>): Promise<void> {
    return this.authority.fenceAdmittedTransitionCommit(commit);
  }

  private async serializeManifestCommit<T>(operation: () => Promise<T>): Promise<T> {
    return this.authority.serializeManifestCommit(operation);
  }

  private terminalPayload(terminal: ProviderActionTerminal, actor: string): ExecutionTerminalPayload {
    return this.providerTerminals.terminalPayload(terminal, actor);
  }

  private async recordSchedulerFailure(entryId: string, error: unknown, actor: string): Promise<void> {
    await this.providerSchedulerFailures.record(entryId, error, actor);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = defaultDaemonPaths();
  const lifecycle = new DaemonLifecycleLog(paths.lifecycleLogPath);
  lifecycle.append({ event: "daemon_starting" });
  process.on("uncaughtExceptionMonitor", (error) => {
    lifecycle.append({ event: "fatal_exception", detail: daemonLifecycleErrorDetail(error) });
  });
  process.on("exit", (exitCode) => {
    lifecycle.append({ event: "process_exit", exitCode });
    lifecycle.close();
  });
  void (async () => {
    const { ProviderActionPortRouter } = await import("./provider-action-port-router.js");
    const daemon = new SupervisorDaemon(paths, process.platform, new ProviderActionPortRouter(), true);
    await daemon.start({ onPrepared: reportStateRecoveryReady });
    lifecycle.append({ event: "daemon_ready" });
    await daemon.waitForHandoff();
    lifecycle.append({ event: "handoff_complete" });
    process.exit(0);
  })().catch((error) => {
    const detail = daemonLifecycleErrorDetail(error);
    lifecycle.append({ event: "entrypoint_failure", detail });
    console.error("Supervisor daemon failed:", redactCredentialText(detail).value);
    process.exit(1);
  });
}
