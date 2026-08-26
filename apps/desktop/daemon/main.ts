import { dirname } from "node:path";

import { AuditLog } from "./audit-log.js";
import { AgentStreamRegistry } from "./agent-stream-registry.js";
import { BoundedEffectCoordinator } from "./bounded-effect-coordinator.js";
import { ContinuationRepairCoordinator } from "./continuation-repair-coordinator.js";
import {
  NATIVE_LIVENESS_STALE_AFTER_MS,
  publishWorkerNativeActivity,
  productionSupervisedDeliveryHttp,
  productionSupervisorGrantHttp,
  workplaceLivenessStaleAfterMs,
  type SupervisorGrantHttp,
} from "./cloud-http.js";
import { DaemonControlSocket } from "./control-socket.js";
import { createDaemonControlRequestHandler, type DaemonControlOperations } from "./control-request-router.js";
import { redactCredentialText, sanitizeDaemonActivityEvent } from "./credential-redaction.js";
import { DaemonAuthority } from "./daemon-authority.js";
import { DeliveryCutoverCoordinator, DeliveryCutoverObservationDetached } from "./delivery-cutover-coordinator.js";
import {
  exhaustedTransientWorkerMint,
  providerRuntimeGoneFailure,
  schedulerErrorDetail,
  transientProviderStartFailure,
} from "./daemon-error-policy.js";
import { DaemonStateWatch } from "./daemon-state-watch.js";
import { WorkDurabilityStore } from "./durability-store.js";
import { EntryConcurrencyGate } from "./entry-concurrency-gate.js";
import { EphemeralWorkspaceProvisioner } from "./ephemeral-workspace-provisioner.js";
import { LifecycleAdministrationCoordinator } from "./lifecycle-administration-coordinator.js";
import { projectDaemonCreateRequestReplayParameters } from "./manifest-entry-projection.js";
import { ManifestAdministrationCoordinator } from "./manifest-administration-coordinator.js";
import { ManifestStore } from "./manifest-store.js";
import { LegacyLaneCoordinator } from "./legacy-lane-coordinator.js";
import { DaemonLifecycleLog, daemonLifecycleErrorDetail } from "./lifecycle-log.js";
import { assertMacOS } from "./platform.js";
import { sameProviderActionConnectionSnapshot, type ProviderActionAttachTerminal, type ProviderActionConnectionRef, type ProviderActionHandle, type ProviderActionPort, type ProviderActionRef, type ProviderActionStreamEvent, type ProviderActionTerminal } from "./provider-action-port.js";
import { ProviderExecutionCoordinator } from "./provider-execution-coordinator.js";
import {
  ProviderReconciliationCoordinator,
  type DaemonReconcileInput,
} from "./provider-reconciliation-coordinator.js";
import { ProviderStreamCoordinator } from "./provider-stream-coordinator.js";
import { isAllowedCursorProviderStateTransition, isIdleCursorConnection, isLiveCursorConnection } from "./provider-state-policy.js";
import {
  bindingMatchesRoomAgentGeneration,
  hasExactRoomAgentDeliveryOwner,
  projectRoomAgentManifestEntry,
} from "./room-agent-state-projection.js";
import { RoomDeliveryControl } from "./room-delivery-control.js";
import { RoomMoveCoordinator } from "./room-move-coordinator.js";
import { resolveReadyReachedAt } from "./provider-stream-policy.js";
import { advanceReconciliationState, rememberCompletedControlAction } from "./reconciler-state.js";
import { DaemonFenceLostError, DaemonSingleton, defaultDaemonPaths } from "./singleton.js";
import { DAEMON_IMPLEMENTATION_VERSION, DAEMON_PROTOCOL_VERSION, type DaemonActivityEvent, type DaemonAgentStreamEvent, type DaemonDeliveryCutover, type DaemonManifestEntry, type DaemonManifestEntryView, type DaemonRequest, type DaemonRoomMoveRecord, type DesiredState, type ExecutionTerminalPayload, type LegacyLaneOwner, type ObservedState, type PolicyCondition, type ReconciliationNotice } from "./types.js";
import {
  deriveProviderConfigurationSnapshot,
  providerSupportsConcurrentSupervisedAgents,
} from "./provider-configuration.js";
import {
  supervisedPermissionProfilesForProvider,
} from "./supervised-permission-profiles.js";
import { createGitCommand, UnusableSourceRepositoryError, WorkspaceProvisioner, type GitCommand } from "./workspace-provisioner.js";
import { WorkerBindingStore, type WorkerSessionBinding } from "./worker-binding-store.js";
import { WorkerAuthorityCoordinator, type BootstrapOperation } from "./worker-authority-coordinator.js";
import {
  WorkerRuntimeCustody,
  type LiveBindingIdentity,
} from "./worker-runtime-custody.js";
import { structuredRoomTurnCompletion, SupervisedAgentInboxStore } from "./supervised-agent-inbox-store.js";
import { SupervisedAgentDelivery, type SupervisedAuthorityScope, type SupervisedDeliveryAuthority, type SupervisedDeliveryHttp, type SupervisedIngressAgent } from "./supervised-agent-delivery.js";
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
const PROVIDER_START_RETRY_LIMIT = 3;
const WORKER_MINT_RECOVERY_RETRY_LIMIT = 5;

export class SupervisorDaemon {
  private readonly singleton: DaemonSingleton;
  private readonly authority: DaemonAuthority;
  private readonly store: ManifestStore;
  private readonly legacyLanes: LegacyLaneCoordinator;
  private readonly manifestAdministration: ManifestAdministrationCoordinator;
  private readonly lifecycleAdministration: LifecycleAdministrationCoordinator;
  private readonly audit: AuditLog;
  private readonly durability: WorkDurabilityStore;
  private readonly provisioner: WorkspaceProvisioner;
  private readonly ephemeralProvisioner: EphemeralWorkspaceProvisioner;
  private readonly gitCommand: GitCommand;
  private readonly workerBindings: WorkerBindingStore;
  private readonly workerAuthority: WorkerAuthorityCoordinator;
  /** Shares the daemon's SQLite durability path; delivery orchestration owns no secrets. */
  private readonly supervisedInbox: SupervisedAgentInboxStore;
  private readonly continuationRepairs: ContinuationRepairCoordinator;
  private readonly roomMoves: RoomMoveCoordinator;
  private readonly supervisedDelivery: SupervisedAgentDelivery | null;
  private readonly turnControls: TurnControlCoordinator;
  private readonly roomDeliveryControl: RoomDeliveryControl;
  private readonly boundedEffects: BoundedEffectCoordinator;
  private readonly socket: DaemonControlSocket;
  private readonly stateWatch: DaemonStateWatch;
  private readonly entryConcurrency: EntryConcurrencyGate;
  private readonly deliveryCutovers: DeliveryCutoverCoordinator;
  private readonly liveHandles = new Map<string, ProviderActionHandle>();
  private readonly providerStreams: ProviderStreamCoordinator;
  private readonly providerExecution: ProviderExecutionCoordinator | null;
  private readonly providerReconciliation: ProviderReconciliationCoordinator | null;
  /**
   * Control requests must be able to fence a launch while its per-entry
   * reconciliation lane is awaiting remote authorization or capabilities.
   * They therefore cannot rely on that same lane for ordering.
   */
  private readonly workerRuntimeCustody = new WorkerRuntimeCustody();
  /**
   * Consecutive transient provider-start failures per entry. A launch that
   * times out is retried automatically a bounded number of times instead of
   * parking the entry in "starting" until the next unrelated RPC arrives.
   */
  private readonly providerStartRetryAttempts = new Map<string, number>();
  /** Consecutive worker-mint recovery retries per entry; bounded, reset on success. */
  private readonly workerMintRecoveryRetryAttempts = new Map<string, number>();
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
      drive: (entryId, signal) => this.driveDeliveryCutover(entryId, signal),
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
      beginLifecycle: (entryId) => this.beginLifecycleExclusion(entryId),
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      setDesiredStateExclusive: (entryId, desiredState) => this.setDesiredStateExclusive(entryId, desiredState),
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
        resetMintAttempts: (entryId) => this.workerMintRecoveryRetryAttempts.delete(entryId),
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
        startCutover: (entryId) => this.startDeliveryCutover(entryId),
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
          this.completeTurnControlForRuntimeRecovery(entry),
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
          clearSuccessfulRecovery: (entryId) => {
            this.providerStartRetryAttempts.delete(entryId);
            this.workerMintRecoveryRetryAttempts.delete(entryId);
          },
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
    this.supervisedDelivery = providerPort
      ? new SupervisedAgentDelivery(
        this.supervisedInbox,
        providerPort,
        supervisedDeliveryHttp,
        (authority, scope) => this.isExactSupervisedDeliveryAuthority(authority, scope),
        undefined,
        undefined,
        undefined,
        (input) => this.roomMoves.commitPreparedRoomMove(input),
        undefined,
        (input) => this.restoreMissingProviderContinuation(input),
        (input) => this.checkpointDynamicProviderState(input),
        (input) => this.checkpointPreparedCursorTurn(input),
      )
      : null;
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
      isExactAuthority: (agent) => this.isExactSupervisedDeliveryAuthority(agent),
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
      acknowledgeInspectorRoomMoveSourceRevocation: (input) => this.roomMoves.acknowledgeSourceRevocation(input),
      activateLegacyLane: this.activateLegacyLane.bind(this),
      appendActivity: this.appendActivity.bind(this),
      bindWorkerSession: this.workerAuthority.bindWorkerSession.bind(this.workerAuthority),
      bootstrapRoomIngress: (input) => this.beginBootstrap(this.workerAuthority.bootstrapRoomIngress.bind(this.workerAuthority), input),
      borrowWorkerCredential: this.workerAuthority.borrowWorkerCredential.bind(this.workerAuthority),
      checkpointWorkerCursor: this.workerAuthority.checkpointWorkerCursor.bind(this.workerAuthority),
      commitInspectorRoomMove: (input) => this.roomMoves.commitInspector(input),
      compareAndSetDesiredState: this.compareAndSetDesiredState.bind(this),
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
      recoverAgentRuntime: this.recoverAgentRuntime.bind(this),
      releaseLegacyLane: this.releaseLegacyLane.bind(this),
      reserveLegacyLane: this.reserveLegacyLane.bind(this),
      resolveTurnControl: (input) => this.turnControls.resolve(input),
      restoreAgentConversation: this.restoreAgentConversation.bind(this),
      retireAgent: this.lifecycleAdministration.retireAgent.bind(this.lifecycleAdministration),
      retryRoomDelivery: this.retryRoomDelivery.bind(this),
      rollbackInspectorRoomMove: (input) => this.roomMoves.rollbackInspector(input),
      setDesiredState: this.setDesiredState.bind(this),
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

  async start(): Promise<void> {
    assertMacOS(this.platform);
    await this.singleton.acquire();
    this.durability.bindSupervisorFence(this.supervisorFenceIdentity());
    this.manifestGeneration = (await this.store.load()).generation;
    await this.supervisedInbox.normalizeInterruptedEffects();
    await this.quarantineDuplicateSupervisedLaneOwners();
    await this.recoverTurnControls();
    await this.recoverOrphanedLegacyReservations();
    await this.roomMoves.reconcilePrepared();
    await this.lifecycleAdministration.recoverPreparedPurges();
    await this.lifecycleAdministration.recoverEphemeralWorkspaces();
    await this.socket.start();
    for (const entry of (await this.store.load()).entries) {
      void this.startSupervisedDelivery(entry.id).catch(() => undefined);
    }
    if (this.providerPort && this.autoConverge) {
      for (const entry of (await this.store.load()).entries) this.requestConvergence(entry.id);
    }
  }

  private async recoverTurnControls(): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const recoveredAt = new Date().toISOString();
      let changed = false;
      const entries: DaemonManifestEntry[] = [];
      for (const entry of manifest.entries) {
        const control = entry.turn_control;
        if (!control || control.status === "completed") { entries.push(entry); continue; }

        let correctionText = control.correction_text?.trim() || null;
        let correctionStrategy = control.correction_strategy ?? null;
        let exactLegacyCorrectionApplied = false;
        // The predecessor implementation could enqueue the correction before
        // it checkpointed the journal payload. That exact, action-derived row
        // is trustworthy recovery evidence; arbitrary room text is not.
        if (entry.delivery_mode === "daemon_inbox" && control.has_correction) {
          const legacyCorrection = await this.supervisedInbox.getBySourceMessage(
            entry.id,
            entry.room_id,
            `correction:${control.action_id}`,
          ).catch(() => null);
          const source = legacyCorrection?.source_message;
          const sourceRecord = source && typeof source === "object" && !Array.isArray(source)
            ? source as Record<string, unknown>
            : null;
          const sender = sourceRecord?.sender && typeof sourceRecord.sender === "object" && !Array.isArray(sourceRecord.sender)
            ? sourceRecord.sender as Record<string, unknown>
            : null;
          const recoveredText = typeof sourceRecord?.text === "string" ? sourceRecord.text.trim() : "";
          const exactLegacyCorrection = Boolean(
            recoveredText
            && sender?.kind === "supervisor_correction"
            && legacyCorrection?.activation?.decision === "activate"
            && legacyCorrection.activation.reason === "human_correction"
            && legacyCorrection.activation.addressed === true
            && (!correctionText || correctionText === recoveredText)
            && (!correctionStrategy || correctionStrategy === "native" || correctionStrategy === "stop_then_resend"),
          );
          if (exactLegacyCorrection) {
            correctionText = recoveredText;
            correctionStrategy = "stop_then_resend";
            // In the predecessor implementation this deterministic row was
            // inserted only after native Stop and A settlement. Its existence
            // is exact durable completion evidence, not work to Stop again.
            // Preserve the row in every state (including active/blocked/final)
            // and tombstone the old journal without touching FIFO authority.
            exactLegacyCorrectionApplied = true;
          }
        }
        // Only a pre-dispatch/retryable legacy daemon action can be migrated
        // from native correction to the bounded Stop + FIFO correction model.
        // A dispatching/uncertain action may already have produced the native
        // effect and must retain its original semantics for operator review.
        if (entry.delivery_mode === "daemon_inbox"
          && control.has_correction
          && correctionText
          && ["prepared", "retryable"].includes(control.status)
          && (correctionStrategy === null || correctionStrategy === "native")) {
          correctionStrategy = "stop_then_resend";
        } else if ((entry.delivery_mode ?? "mcp_polling") !== "daemon_inbox"
          && control.has_correction
          && correctionText
          && correctionStrategy === null
          && ["prepared", "retryable"].includes(control.status)) {
          correctionStrategy = "native";
        }

        const missingCorrectionIntent = control.has_correction && (!correctionText || !correctionStrategy);
        const retireWithoutClaimingEffect = !exactLegacyCorrectionApplied && (control.status === "prepared"
          ? !control.has_correction || missingCorrectionIntent
          : control.status === "retryable" && missingCorrectionIntent);
        const nextStatus = exactLegacyCorrectionApplied || retireWithoutClaimingEffect
          ? "completed" as const
          : control.status === "prepared"
            ? "retryable" as const
            : control.status === "dispatching"
              ? "uncertain" as const
              : control.status;
        const nextError = exactLegacyCorrectionApplied
          ? "Recovered the predecessor supervisor's exact durable correction row; no provider control or FIFO mutation was replayed."
          : retireWithoutClaimingEffect
          ? control.has_correction
            ? "Supervisor restarted before a native effect was proven. The legacy correction payload was not durable, so no effect was claimed; reissue the correction."
            : "Supervisor restarted before native dispatch. The unapplied Stop was retired and the supervised lane was recovered."
          : control.status === "dispatching"
            ? "Supervisor restarted after native dispatch began; verify the provider outcome before resolving the action."
            : control.status === "prepared"
              ? correctionStrategy === "stop_then_resend"
                ? "Supervisor restarted before native dispatch; the accepted correction will retry through the daemon's bounded FIFO."
                : "Supervisor restarted before native dispatch; the exact action is safe to retry."
              : missingCorrectionIntent && control.status === "uncertain"
                ? "The native effect is uncertain and the legacy correction payload is unavailable. Resolve the effect; if it was not applied, reissue the correction."
                : control.error;
        const controlChanged = nextStatus !== control.status
          || correctionText !== (control.correction_text?.trim() || null)
          || correctionStrategy !== (control.correction_strategy ?? null)
          || nextError !== control.error
          || control.operator_resolution != null;
        if (!controlChanged) { entries.push(entry); continue; }
        changed = true;
        entries.push({
          ...entry,
          reconciliation: exactLegacyCorrectionApplied || retireWithoutClaimingEffect
            ? rememberCompletedControlAction(
              advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs()),
              control.action_id,
            )
            : entry.reconciliation,
          turn_control: {
            ...control,
            correction_text: correctionText,
            correction_strategy: correctionStrategy,
            operator_resolution: null,
            status: nextStatus,
            interrupted: exactLegacyCorrectionApplied ? true : retireWithoutClaimingEffect ? false : control.interrupted,
            resumed: exactLegacyCorrectionApplied ? true : retireWithoutClaimingEffect ? false : control.resumed,
            state: exactLegacyCorrectionApplied
              ? entry.observed_state === "working" ? "working" as const : "idle" as const
              : retireWithoutClaimingEffect
              ? entry.observed_state === "working" ? "working" as const : "idle" as const
              : control.state,
            stages: exactLegacyCorrectionApplied
              ? ["delivered", "applied", "resumed"]
              : retireWithoutClaimingEffect ? [] : control.stages,
            error: nextError,
            updated_at: recoveredAt,
          },
        });
      }
      if (!changed) return;
      const next = await this.writeManifest(this.manifestGeneration, entries, manifest.legacy_lane_owners);
      this.manifestGeneration = next.generation;
    });
  }

  async stop(): Promise<void> {
    // Stop is final for this daemon instance. Fence late delivery/cutover
    // continuations before awaiting any drain so they cannot retain a socket
    // or SQLite handle after the caller has observed shutdown.
    this.handoffScheduled = true;
    this.supervisedDelivery?.fence();
    this.wakeRoomMoveReconciliationWaiters();
    this.notifyStateChanged();
    this.workerRuntimeCustody.destroyAllCredentials();
    await this.fenceAndDrainDeliveryCutovers();
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
    try { await this.fenceAndDrainDeliveryCutovers(); } catch (error) { failures.push(error); }
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
    if (!entryId.trim() || !roomId.trim() || (sourceMessageId !== null && !sourceMessageId.trim())) throw new Error("Agent inspector detail requires an exact entry and room identity.");
    const entry = await this.store.getEntry(entryId);
    if (!entry) throw new Error("The exact supervisor entry is no longer present; inspector history is not queryable without its manifest fence.");
    if (entry.room_id !== roomId) throw new Error("The agent inspector room does not match the exact supervisor entry.");
    return this.supervisedInbox.detail(entryId, roomId, sourceMessageId);
  }

  private async exactActiveBoundedContext(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number; providerTurnId?: string;
  }) {
    if (!input.entryId || !input.workAttemptId || !input.executionGenerationId || input.daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("The supervised effect coordinates are stale.");
    }
    if (!this.supervisedDelivery) throw new Error("Supervised bounded turns are unavailable.");
    const entry = await this.store.getEntry(input.entryId);
    const handle = this.liveHandles.get(input.entryId);
    const binding = await this.workerBindings.get(input.entryId);
    const credential = binding ? await this.workerBindings.credentialFor(binding) : null;
    if (!entry || !handle || !binding || !credential
      || entry.work_attempt_id !== input.workAttemptId
      || entry.provider_ref?.execution_generation_id !== input.executionGenerationId
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId) {
      throw new Error("The supervised effect no longer belongs to the exact live execution generation.");
    }
    const agent = {
      agentId: entry.id, roomId: entry.room_id, provider: entry.provider, deliveryMode: entry.delivery_mode ?? "mcp_polling",
      apiUrl: binding.api_url, agentSessionId: binding.agent_session_id, bearer: credential, handle,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: handle.providerContinuationId,
      providerConnection: handle.providerConnection ?? null,
      executionGenerationId: binding.execution_generation_id, daemonGeneration: this.singleton.currentGeneration,
    };
    const active = this.supervisedDelivery.activeTurn(agent);
    if (!active) throw new Error("No exact bounded room turn is currently active for this agent.");
    const inbox = await this.supervisedInbox.get(active.inboxItemId);
    if (!inbox?.provider_turn_id) throw new Error("The bounded room turn has not checkpointed its provider turn id yet.");
    const providerTurnBinding = await this.supervisedInbox.providerTurnBinding(inbox.inbox_item_id);
    if (!providerTurnBinding
      || providerTurnBinding.agent_id !== entry.id
      || providerTurnBinding.room_id !== entry.room_id
      || providerTurnBinding.work_attempt_id !== entry.work_attempt_id
      || providerTurnBinding.provider_continuation_id !== handle.providerContinuationId
      || providerTurnBinding.provider_turn_id !== inbox.provider_turn_id) {
      throw new Error("The bounded provider turn has a different or unverifiable durable authority binding.");
    }
    if ((entry.provider === "cursor" || input.providerTurnId)
      && input.providerTurnId !== inbox.provider_turn_id) {
      throw new Error("The supervised provider turn capability is stale.");
    }
    return { entry, agent, binding, active, inbox, providerTurnBinding };
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
    if (this.handoffScheduled || !this.supervisedDelivery || !this.providerPort?.runRoomTurn) return;
    if (this.entryConcurrency.isLifecycleActive(entryId)) return;
    const entry = await this.store.getEntry(entryId);
    // A legacy worker-owned polling loop must be cut over before the daemon
    // can even read its bearer.  This keeps the two ingress systems mutually
    // exclusive across every crash boundary.
    if (entry?.provider === "codex" && (entry.delivery_mode ?? "mcp_polling") === "mcp_polling") {
      await this.startDeliveryCutover(entryId);
      return;
    }
    if (!entry || entry.delivery_mode !== "daemon_inbox") return;
    if (entry.turn_control?.inbox_item_id
      && ["prepared", "dispatching", "uncertain"].includes(entry.turn_control.status)) {
      // The native side effect is unresolved. Its linked FIFO invocation is a
      // durable quarantine boundary across restart, refresh, and handoff; no
      // startup normalization may recover or redispatch it before the journal
      // is atomically completed or explicitly resolved.
      return;
    }
    // A pending move owns successor ingress, but its exact activating turn may
    // still need the source-room delivery loop after restart. Reconcile first;
    // only a validated pre-join waiter may resume that exact FIFO head.
    const pendingMoves = await this.store.pendingRoomMoves(entryId);
    if (pendingMoves.length > 1) throw new Error("More than one nonterminal room move exists for this agent.");
    const pendingMove = pendingMoves[0] ?? null;
    if (pendingMove) {
      let move: DaemonRoomMoveRecord;
      try {
        move = await this.roomMoves.reconcile(pendingMove);
      } catch (error) {
        this.scheduleRecoveryConvergence(pendingMove.agent_id, 1_000);
        throw error;
      }
      if (this.entryConcurrency.isLifecycleActive(entryId) || move.phase !== "waiting_for_current_turn") return;
      const isRecoverableActivatingState = (candidate: { state: string; provider_turn_id: string | null }): boolean =>
        ["dispatching", "awaiting_result", "result_recovery", "publishing", "retryable"].includes(candidate.state)
        || (candidate.state === "pending" && candidate.provider_turn_id !== null);
      if (move.activating_inbox_item_id) {
        const item = await this.supervisedInbox.get(move.activating_inbox_item_id);
        const binding = item ? await this.supervisedInbox.providerTurnBinding(item.inbox_item_id) : null;
        const effect = move.effect_id && move.provider_turn_id && binding
          ? await this.supervisedInbox.preparedRoomMove(
            move.agent_id,
            binding.origin_execution_generation_id,
            move.provider_turn_id,
          )
          : null;
        const exactWaiter = Boolean(item
          && isRecoverableActivatingState(item)
          && item.agent_id === move.agent_id
          && item.room_id === move.source_room_id
          && item.provider_turn_id === move.provider_turn_id
          && binding
          && binding.agent_id === move.agent_id
          && binding.room_id === move.source_room_id
          && binding.work_attempt_id === move.work_attempt_id
          && binding.provider_turn_id === move.provider_turn_id
          && effect
          && effect.effect_id === move.effect_id
          && effect.room_id === move.source_room_id
          && effect.execution_generation_id === binding.origin_execution_generation_id);
        if (!exactWaiter) return;
      } else {
        const receipts = await this.supervisedInbox.receipts(move.agent_id);
        if (!receipts.some(isRecoverableActivatingState)) return;
      }
    }
    const handle = this.liveHandles.get(entryId);
    const binding = await this.workerBindings.get(entryId);
    if (!entry || !binding || !entry.work_attempt_id || !entry.provider_ref) return;
    const credential = await this.workerBindings.credentialFor(binding);
    if (!credential) return;
    const agent = {
      agentId: entryId,
      roomId: binding.room_id,
      provider: entry.provider,
      charter: entry.charter,
      apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id,
      bearer: credential,
      handle: handle ?? null,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: entry.provider_ref.provider_continuation_id,
      providerConnection: entry.provider_ref.provider_connection ?? null,
      executionGenerationId: binding.execution_generation_id,
      daemonGeneration: this.singleton.currentGeneration,
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
    };
    if (!await this.isExactSupervisedDeliveryAuthority({
      agentId: agent.agentId, roomId: agent.roomId, provider: agent.provider,
      apiUrl: agent.apiUrl, agentSessionId: agent.agentSessionId, bearer: agent.bearer,
      handle: agent.handle, workAttemptId: agent.workAttemptId,
      executionGenerationId: agent.executionGenerationId,
      daemonGeneration: agent.daemonGeneration,
      providerContinuationId: agent.providerContinuationId,
      providerConnection: agent.providerConnection,
    })) return;
    if (mode === "ensure" || mode === "wake") {
      // Recovery only fills an absent loop; it never tears down healthy work.
      await this.supervisedDelivery.ensureStarted(agent);
      if (mode === "wake") this.supervisedDelivery.wake(agent);
    } else {
      // Rebinding replaces the prior loop only after it has been cancelled and
      // joined. The new loop pumps durable work before its first long poll.
      await this.supervisedDelivery.refresh(agent);
    }
  }

  private async restartSupervisedDeliveryOrConverge(entryId: string): Promise<void> {
    if (this.entryConcurrency.isLifecycleActive(entryId)) {
      // Lifecycle callers invoke this from their failure/losing-CAS cleanup,
      // before their outer finally releases exclusion. Defer one turn so the
      // exact pending room move and delivery owner can actually reacquire the
      // lane instead of treating an exclusion no-op as successful recovery.
      const timer = setTimeout(() => void this.restartSupervisedDeliveryOrConverge(entryId), 0);
      timer.unref();
      return;
    }
    try {
      await this.startSupervisedDelivery(entryId, "ensure");
    } catch {
      // A running daemon-inbox entry now restarts delivery from ordinary
      // convergence even when its provider handle is already healthy.
      this.scheduleRecoveryConvergence(entryId, 250);
    }
  }

  /** Coalesce one durable legacy-polling -> daemon-inbox handoff per agent. */
  private startDeliveryCutover(entryId: string): Promise<void> {
    return this.deliveryCutovers.start(entryId);
  }

  /**
   * Fence the exact legacy polling turn before enabling daemon ingress.  The
   * manifest is the effect journal: once a target is recorded no later run may
   * inspect "latest" as a replacement target, and once native dispatch is
   * recorded an active/unknown result is deliberately left gated.
   */
  private async driveDeliveryCutover(entryId: string, detachSignal: AbortSignal): Promise<void> {
    if (this.handoffScheduled || !this.providerPort?.controlExactTurn) return;
    let entry = await this.store.getEntry(entryId);
    this.assertDeliveryCutoverObservation(detachSignal);
    if (!entry) return;

    // Terminal durability is the convergence boundary for every old cutover,
    // including predecessor states whose provider_ref was already detached or
    // replaced. A terminal current/no-runtime cutover can adopt daemon ingress;
    // a stale cutover beside a successor is only cleared, never allowed to flip
    // that successor's delivery mode.
    if (entry.delivery_cutover) {
      const saved = entry.delivery_cutover;
      const attempt = await this.durability.getAttempt(saved.work_attempt_id).catch(() => null);
      const terminal = attempt?.execution_generations.some((candidate) =>
        candidate.execution_generation_id === saved.execution_generation_id && candidate.terminal) ?? false;
      if (terminal) {
        entry = await this.updateManifestEntry(entryId, (current) => {
          const cutover = current.delivery_cutover;
          if (!cutover
            || cutover.work_attempt_id !== saved.work_attempt_id
            || cutover.execution_generation_id !== saved.execution_generation_id
            || cutover.provider_continuation_id !== saved.provider_continuation_id
            || cutover.provider_turn_id !== saved.provider_turn_id) return current;
          const sameRuntime = current.provider_ref?.execution_generation_id === saved.execution_generation_id
            && current.provider_ref.provider_continuation_id === saved.provider_continuation_id;
          const noRuntime = current.provider_ref == null;
          return {
            ...current,
            ...(sameRuntime || noRuntime ? { delivery_mode: "daemon_inbox" as const } : {}),
            delivery_cutover: null,
          };
        });
        this.assertDeliveryCutoverObservation(detachSignal);
        if (entry.delivery_mode === "daemon_inbox") {
          const timer = setTimeout(() => void this.startSupervisedDelivery(entryId).catch(() => undefined), 0);
          timer.unref();
          return;
        }
      }
    }

    const handle = this.liveHandles.get(entryId);
    if (!handle
      || entry.provider !== "codex"
      || (entry.delivery_mode ?? "mcp_polling") !== "mcp_polling"
      || entry.desired_state !== "running"
      || entry.condition !== "none"
      || !entry.work_attempt_id
      || !entry.provider_ref
      || handle.workAttemptId !== entry.work_attempt_id
      || handle.providerContinuationId !== entry.provider_ref.provider_continuation_id
      || !sameProviderActionConnectionSnapshot(handle.providerConnection, entry.provider_ref.provider_connection)) return;

    const identity = {
      work_attempt_id: entry.work_attempt_id,
      execution_generation_id: entry.provider_ref.execution_generation_id,
      provider_continuation_id: entry.provider_ref.provider_continuation_id,
    };
    if (!entry.delivery_cutover) {
      this.assertDeliveryCutoverObservation(detachSignal);
      entry = await this.updateManifestEntry(entryId, (current) => {
        this.assertDeliveryCutoverObservation(detachSignal);
        if (current.turn_control && current.turn_control.status !== "completed") {
          throw new Error(`Delivery cutover is blocked by unresolved turn-control action '${current.turn_control.action_id}'.`);
        }
        if (current.provider !== "codex" || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
          || current.work_attempt_id !== identity.work_attempt_id
          || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
          || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
          || this.liveHandles.get(entryId) !== handle
          || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)) return current;
        const cutover: DaemonDeliveryCutover = { ...identity, provider_turn_id: null, phase: "prepared", error: null, updated_at: new Date().toISOString() };
        return { ...current, delivery_cutover: cutover };
      });
      this.assertDeliveryCutoverObservation(detachSignal);
    }
    const cutover = entry.delivery_cutover;
    if (!cutover
      || cutover.work_attempt_id !== identity.work_attempt_id
      || cutover.execution_generation_id !== identity.execution_generation_id
      || cutover.provider_continuation_id !== identity.provider_continuation_id) return;

    if (cutover.phase === "dispatching" || cutover.phase === "uncertain") {
      if (!cutover.provider_turn_id || !this.providerPort.inspectTurn) {
        await this.markDeliveryCutoverUncertain(entryId, identity, "native interrupt dispatch is ambiguous without an exact turn id", handle, detachSignal);
        return;
      }
      const state = await this.observeDeliveryCutover(detachSignal, this.providerPort.inspectTurn(handle, cutover.provider_turn_id)).catch(() => "unknown" as const);
      this.assertDeliveryCutoverObservation(detachSignal);
      if (state === "terminal") {
        await this.completeDeliveryCutover(entryId, identity, handle, detachSignal);
        return;
      }
      if (state === "unknown") {
        await this.markDeliveryCutoverUncertain(entryId, identity, `native interrupt dispatch is ambiguous; exact turn remains ${state}`, handle, detachSignal);
        this.scheduleDeliveryCutoverRetry(entryId, 1_000);
        return;
      }
      // Exact A is still active. Re-driving the interrupt is safe because the
      // persisted target is immutable; no latest-turn discovery occurs.
    }

    let dispatchMarked = cutover.phase === "dispatching" || cutover.phase === "uncertain";
    try {
      const result = await this.observeDeliveryCutover(detachSignal, this.providerPort.controlExactTurn(handle, {
        targetTurnId: cutover.provider_turn_id,
        checkpointTargetTurn: async (turnId) => {
          this.assertDeliveryCutoverObservation(detachSignal);
          await this.updateManifestEntry(entryId, (current) => {
            this.assertDeliveryCutoverObservation(detachSignal);
            const currentCutover = current.delivery_cutover;
            if (!currentCutover
              || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
              || !["prepared", "retryable", "dispatching", "uncertain"].includes(currentCutover.phase)
              || current.desired_state !== "running"
              || current.condition !== "none"
              || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
              || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
              || this.liveHandles.get(entryId) !== handle
              || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
              || currentCutover.work_attempt_id !== identity.work_attempt_id
              || currentCutover.execution_generation_id !== identity.execution_generation_id
              || currentCutover.provider_continuation_id !== identity.provider_continuation_id
              || (currentCutover.provider_turn_id && currentCutover.provider_turn_id !== turnId)) {
              throw new Error("Legacy delivery cutover changed before exact turn checkpoint.");
            }
            return { ...current, delivery_cutover: { ...currentCutover, provider_turn_id: turnId, updated_at: new Date().toISOString() } };
          });
          this.assertDeliveryCutoverObservation(detachSignal);
        },
        markDispatched: async () => {
          this.assertDeliveryCutoverObservation(detachSignal);
          await this.updateManifestEntry(entryId, (current) => {
            this.assertDeliveryCutoverObservation(detachSignal);
            const currentCutover = current.delivery_cutover;
            if (!currentCutover
              || (current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
              || !["prepared", "retryable", "dispatching", "uncertain"].includes(currentCutover.phase)
              || current.desired_state !== "running"
              || current.condition !== "none"
              || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
              || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
              || this.liveHandles.get(entryId) !== handle
              || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
              || !currentCutover.provider_turn_id
              || currentCutover.work_attempt_id !== identity.work_attempt_id
              || currentCutover.execution_generation_id !== identity.execution_generation_id
              || currentCutover.provider_continuation_id !== identity.provider_continuation_id) {
              throw new Error("Legacy delivery cutover changed before native interrupt dispatch.");
            }
            return { ...current, delivery_cutover: { ...currentCutover, phase: "dispatching", updated_at: new Date().toISOString() } };
          });
          dispatchMarked = true;
          this.assertDeliveryCutoverObservation(detachSignal);
        },
        detachSignal,
      }));
      this.assertDeliveryCutoverObservation(detachSignal);
      // A no-active/terminal inspection is a completion fact. An adapter's
      // interrupt acknowledgement is not: independently re-inspect exactly
      // the persisted target before allowing daemon ingress.
      if (result.outcome === "no_active" || result.outcome === "terminal") {
        await this.completeDeliveryCutover(entryId, identity, handle, detachSignal);
      } else if (result.outcome === "interrupt_dispatched") {
        const targetTurnId = cutover.provider_turn_id ?? result.targetTurnId;
        if (!targetTurnId || !this.providerPort.inspectTurn) {
          await this.markDeliveryCutoverUncertain(entryId, identity, "native interrupt was acknowledged without exact terminal inspection", handle, detachSignal);
          return;
        }
        const state = await this.observeDeliveryCutover(detachSignal, this.providerPort.inspectTurn(handle, targetTurnId)).catch(() => "unknown" as const);
        this.assertDeliveryCutoverObservation(detachSignal);
        if (state === "terminal") await this.completeDeliveryCutover(entryId, identity, handle, detachSignal);
        else {
          await this.markDeliveryCutoverUncertain(entryId, identity, `native interrupt was acknowledged but exact turn remains ${state}`, handle, detachSignal);
          this.scheduleDeliveryCutoverRetry(entryId, 1_000);
        }
      }
    } catch (error) {
      if (error instanceof DeliveryCutoverObservationDetached) return;
      const outcome = error && typeof error === "object" && "turnControlOutcome" in error
        ? (error as { turnControlOutcome?: unknown }).turnControlOutcome
        : null;
      const ambiguous = dispatchMarked || outcome === "uncertain";
      if (ambiguous) {
        await this.markDeliveryCutoverUncertain(entryId, identity, error instanceof Error ? error.message : "exact legacy turn control failed", handle, detachSignal);
        this.scheduleDeliveryCutoverRetry(entryId, 1_000);
      } else {
        await this.markDeliveryCutoverRetryable(entryId, identity, error instanceof Error ? error.message : "exact legacy turn preparation failed", handle, detachSignal);
        this.scheduleDeliveryCutoverRetry(entryId, 250);
      }
    }
  }

  private async completeDeliveryCutover(entryId: string, identity: Omit<DaemonDeliveryCutover, "provider_turn_id" | "phase" | "updated_at">, handle: ProviderActionHandle, detachSignal: AbortSignal): Promise<void> {
    this.assertDeliveryCutoverObservation(detachSignal);
    const completed = await this.updateManifestEntry(entryId, (current) => {
      this.assertDeliveryCutoverObservation(detachSignal);
      const cutover = current.delivery_cutover;
      if ((current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
        || !cutover
        || current.desired_state !== "running"
        || current.condition !== "none"
        || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
        || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
        || this.liveHandles.get(entryId) !== handle
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
        || cutover.work_attempt_id !== identity.work_attempt_id
        || cutover.execution_generation_id !== identity.execution_generation_id
        || cutover.provider_continuation_id !== identity.provider_continuation_id) return current;
      const now = new Date().toISOString();
      return {
        ...current,
        delivery_mode: "daemon_inbox",
        delivery_cutover: null,
        // A terminal legacy turn is the successful boundary of the handoff,
        // not a dead worker. The retained app-server/thread is immediately a
        // healthy idle daemon-inbox session until its next bounded delivery.
        ...(current.observed_state === "working" || current.observed_state === "starting"
          ? { observed_state: "idle" as const, native_liveness: { state: "idle" as const, observed_at: now, detail: "legacy polling turn fenced; daemon inbox ready" } }
          : {}),
      };
    });
    this.assertDeliveryCutoverObservation(detachSignal);
    if (completed.delivery_mode === "daemon_inbox") {
      // This coordinator is still coalesced until its finally runs. Defer the
      // first inbox start one tick so it cannot mistake the cutover operation
      // for an already-running successor.
      const timer = setTimeout(() => void this.startSupervisedDelivery(entryId).catch(() => undefined), 0);
      timer.unref();
    }
  }

  private async markDeliveryCutoverRetryable(
    entryId: string,
    identity: Omit<DaemonDeliveryCutover, "provider_turn_id" | "phase" | "updated_at">,
    detail: string,
    handle: ProviderActionHandle,
    detachSignal: AbortSignal,
  ): Promise<void> {
    this.assertDeliveryCutoverObservation(detachSignal);
    await this.updateManifestEntry(entryId, (current) => {
      this.assertDeliveryCutoverObservation(detachSignal);
      const cutover = current.delivery_cutover;
      if ((current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
        || !cutover
        || cutover.phase === "dispatching"
        || cutover.phase === "uncertain"
        || current.desired_state !== "running"
        || current.condition !== "none"
        || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
        || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
        || this.liveHandles.get(entryId) !== handle
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
        || cutover.work_attempt_id !== identity.work_attempt_id
        || cutover.execution_generation_id !== identity.execution_generation_id
        || cutover.provider_continuation_id !== identity.provider_continuation_id) return current;
      return {
        ...current,
        delivery_cutover: {
          ...cutover,
          phase: "retryable",
          error: redactCredentialText(detail).value,
          updated_at: new Date().toISOString(),
        },
      };
    });
    this.assertDeliveryCutoverObservation(detachSignal);
  }

  private async markDeliveryCutoverUncertain(entryId: string, identity: Omit<DaemonDeliveryCutover, "provider_turn_id" | "phase" | "updated_at">, detail: string, handle: ProviderActionHandle, detachSignal: AbortSignal): Promise<void> {
    this.assertDeliveryCutoverObservation(detachSignal);
    await this.updateManifestEntry(entryId, (current) => {
      this.assertDeliveryCutoverObservation(detachSignal);
      const cutover = current.delivery_cutover;
      if ((current.delivery_mode ?? "mcp_polling") !== "mcp_polling"
        || !cutover
        || current.desired_state !== "running"
        || current.condition !== "none"
        || current.provider_ref?.execution_generation_id !== identity.execution_generation_id
        || current.provider_ref.provider_continuation_id !== identity.provider_continuation_id
        || this.liveHandles.get(entryId) !== handle
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, handle.providerConnection)
        || cutover.work_attempt_id !== identity.work_attempt_id
        || cutover.execution_generation_id !== identity.execution_generation_id
        || cutover.provider_continuation_id !== identity.provider_continuation_id) return current;
      const safeDetail = redactCredentialText(detail).value;
      const observedAt = new Date().toISOString();
      const activity: DaemonActivityEvent = {
        observed_at: observedAt,
        sequence: (current.activity?.at(-1)?.sequence ?? 0) + 1,
        provider: current.provider,
        kind: "delivery_cutover",
        method: "legacy_polling_interrupt",
        summary: "Daemon inbox cutover needs attention; legacy ingress remains fenced.",
        status: "blocked",
        payload: { phase: "uncertain", provider_turn_id: cutover.provider_turn_id, detail: safeDetail },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: null,
      };
      return {
        ...current,
        delivery_cutover: { ...cutover, phase: "uncertain", error: safeDetail, updated_at: observedAt },
        activity: [...(current.activity ?? []), activity].slice(-200),
      };
    });
    this.assertDeliveryCutoverObservation(detachSignal);
  }

  private scheduleDeliveryCutoverRetry(entryId: string, delayMs: number): void {
    this.deliveryCutovers.scheduleRetry(entryId, delayMs);
  }

  /** Retirement detaches local observation only; it never signals the provider. */
  private async fenceAndDrainDeliveryCutovers(): Promise<void> {
    await this.deliveryCutovers.fenceAndDrain();
  }

  private assertDeliveryCutoverObservation(detachSignal: AbortSignal): void {
    this.deliveryCutovers.assertObservation(detachSignal);
  }

  private observeDeliveryCutover<T>(detachSignal: AbortSignal, operation: Promise<T>): Promise<T> {
    return this.deliveryCutovers.observe(detachSignal, operation);
  }

  /** Re-check every authority component after delivery awaits; bearer equality stays memory-only. */
  private async checkpointPreparedCursorTurn(input: {
    agent: SupervisedIngressAgent;
    inboxItemId: string;
    providerTurnId: string;
    providerContinuationId: string;
    providerConnection: ProviderActionConnectionRef;
  }): Promise<void> {
    const { agent, inboxItemId, providerTurnId, providerContinuationId, providerConnection } = input;
    if (agent.provider !== "cursor"
      || providerConnection.kind !== "cursor_cli"
      || providerContinuationId !== agent.providerContinuationId
      || providerConnection.pid === null
      || !providerConnection.processIdentity?.trim()
      || !agent.handle) {
      throw new Error("Only an exact paused Cursor wrapper may cross the prepared-turn boundary.");
    }
    const expectedConnection = agent.providerConnection;
    if (!isIdleCursorConnection(expectedConnection)) {
      throw new DaemonFenceLostError("Cursor prepared turn did not begin from the exact idle runtime state.");
    }
    await this.serializeEntryTick(agent.agentId, () => this.serializeManifestMutation(async () => {
      if (this.handoffScheduled) throw new DaemonFenceLostError("Cursor prepared turn changed during daemon handoff.");
      await this.singleton.assertCurrent();
      const current = await this.store.getEntry(agent.agentId);
      const live = this.liveHandles.get(agent.agentId);
      const binding = await this.workerBindings.get(agent.agentId);
      const currentCredential = binding ? await this.workerBindings.credentialFor(binding) : null;
      if (!current
        || live !== agent.handle
        || current.room_id !== agent.roomId
        || current.desired_state !== "running"
        || current.provider !== "cursor"
        || current.delivery_mode !== "daemon_inbox"
        || current.work_attempt_id !== agent.workAttemptId
        || current.provider_ref?.work_attempt_id !== agent.workAttemptId
        || current.provider_ref.execution_generation_id !== agent.executionGenerationId
        || current.provider_ref.provider_continuation_id !== agent.providerContinuationId
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, expectedConnection)
        || !binding
        || binding.room_id !== agent.roomId
        || binding.api_url !== agent.apiUrl
        || binding.work_attempt_id !== agent.workAttemptId
        || binding.execution_generation_id !== agent.executionGenerationId
        || binding.agent_session_id !== agent.agentSessionId
        || currentCredential !== agent.bearer
        || live.workAttemptId !== agent.workAttemptId
        || live.providerContinuationId !== providerContinuationId
        || !sameProviderActionConnectionSnapshot(live.providerConnection, providerConnection)) {
        throw new DaemonFenceLostError("Cursor prepared turn no longer belongs to the exact supervised lane.");
      }
      try {
        const checkpoint = await this.store.checkpointCursorPreparedTurn(this.manifestGeneration, {
          agentId: agent.agentId,
          roomId: agent.roomId,
          inboxItemId,
          providerTurnId,
          providerContinuationId,
          workAttemptId: agent.workAttemptId,
          executionGenerationId: agent.executionGenerationId,
          agentSessionId: agent.agentSessionId,
          credentialRef: binding.credential_ref,
          apiUrl: agent.apiUrl,
          expectedProviderContinuationId: agent.providerContinuationId!,
          expectedProviderConnection: expectedConnection,
          providerConnection,
          observedAt: new Date(this.nowMs()).toISOString(),
        }, (commit) => this.fenceDaemonCommit(commit));
        this.manifestGeneration = checkpoint.generation;
        agent.providerConnection = providerConnection;
      } catch (error) {
        // A commit fence may report failure after SQLite committed. The paired
        // manifest+inbox read proves whether the atomic boundary won.
        const [persisted, inbox, recoveredBinding] = await Promise.all([
          this.store.getEntry(agent.agentId).catch(() => undefined),
          this.supervisedInbox.get(inboxItemId).catch(() => null),
          this.workerBindings.get(agent.agentId).catch(() => null),
        ]);
        const recoveredCredential = recoveredBinding
          ? await this.workerBindings.credentialFor(recoveredBinding).catch(() => null)
          : null;
        const recoveredLive = this.liveHandles.get(agent.agentId);
        if (persisted?.room_id === agent.roomId
          && persisted.desired_state === "running"
          && persisted.provider === "cursor"
          && persisted.delivery_mode === "daemon_inbox"
          && persisted.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref?.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref.execution_generation_id === agent.executionGenerationId
          && persisted.provider_ref.provider_continuation_id === providerContinuationId
          && sameProviderActionConnectionSnapshot(persisted.provider_ref.provider_connection, providerConnection)
          && inbox?.agent_id === agent.agentId
          && inbox.room_id === agent.roomId
          && inbox?.provider_turn_id === providerTurnId
          && ["dispatching", "awaiting_result", "result_recovery"].includes(inbox.state)
          && recoveredBinding?.entry_id === agent.agentId
          && recoveredBinding.room_id === agent.roomId
          && recoveredBinding.api_url === agent.apiUrl
          && recoveredBinding.work_attempt_id === agent.workAttemptId
          && recoveredBinding.execution_generation_id === agent.executionGenerationId
          && recoveredBinding.agent_session_id === agent.agentSessionId
          && recoveredCredential === agent.bearer
          && recoveredLive === agent.handle
          && recoveredLive.workAttemptId === agent.workAttemptId
          && recoveredLive.providerContinuationId === providerContinuationId
          && sameProviderActionConnectionSnapshot(recoveredLive.providerConnection, providerConnection)) {
          const manifest = await this.store.load();
          this.manifestGeneration = manifest.generation;
          agent.providerConnection = providerConnection;
          return;
        }
        throw error;
      }
    }));
  }

  /** Re-check every authority component after delivery awaits; bearer equality stays memory-only. */
  private async checkpointDynamicProviderState(input: {
    agent: SupervisedIngressAgent;
    inboxItemId: string;
    providerTurnId: string;
    providerContinuationId: string;
    providerConnection: ProviderActionConnectionRef;
  }): Promise<void> {
    const { agent, inboxItemId, providerTurnId, providerContinuationId, providerConnection } = input;
    if (agent.provider !== "cursor" || providerConnection.kind !== "cursor_cli"
      || !providerContinuationId.trim() || !agent.handle) {
      throw new Error("Only an exact live Cursor lane may checkpoint dynamic provider state.");
    }
    const completingAdmittedCursorState = isLiveCursorConnection(agent.providerConnection)
      && isAllowedCursorProviderStateTransition(
        agent.providerContinuationId,
        agent.providerConnection,
        providerContinuationId,
        providerConnection,
      );
    await this.serializeEntryTick(agent.agentId, () => this.serializeManifestMutation(async () => {
      if (this.handoffScheduled && !completingAdmittedCursorState) {
        throw new DaemonFenceLostError("Cursor provider state changed during daemon handoff.");
      }
      await this.singleton.assertCurrent();
      const current = await this.store.getEntry(agent.agentId);
      const live = this.liveHandles.get(agent.agentId);
      const binding = await this.workerBindings.get(agent.agentId);
      const currentCredential = binding ? await this.workerBindings.credentialFor(binding) : null;
      const currentProviderStateMatchesAgent = Boolean(current?.provider_ref
        && current.provider_ref.provider_continuation_id === agent.providerContinuationId
        && sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection ?? null, agent.providerConnection));
      const currentProviderStateMatchesCandidate = Boolean(current?.provider_ref
        && current.provider_ref.provider_continuation_id === providerContinuationId
        && sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection ?? null, providerConnection));
      const inbox = await this.supervisedInbox.get(inboxItemId);
      if (!current || live !== agent.handle
        || current.room_id !== agent.roomId
        || current.desired_state !== "running"
        || current.provider !== "cursor"
        || current.delivery_mode !== "daemon_inbox"
        || current.work_attempt_id !== agent.workAttemptId
        || current.provider_ref?.work_attempt_id !== agent.workAttemptId
        || current.provider_ref.execution_generation_id !== agent.executionGenerationId
        || (!currentProviderStateMatchesAgent && !currentProviderStateMatchesCandidate)
        || !inbox
        || inbox.agent_id !== agent.agentId
        || inbox.room_id !== agent.roomId
        || inbox.provider_turn_id !== providerTurnId
        || !["dispatching", "awaiting_result", "result_recovery"].includes(inbox.state)
        || !binding
        || binding.entry_id !== agent.agentId
        || binding.room_id !== agent.roomId
        || binding.api_url !== agent.apiUrl
        || binding.work_attempt_id !== agent.workAttemptId
        || binding.execution_generation_id !== agent.executionGenerationId
        || binding.agent_session_id !== agent.agentSessionId
        || currentCredential !== agent.bearer
        || live.workAttemptId !== agent.workAttemptId
        || live.providerContinuationId !== providerContinuationId
        || !sameProviderActionConnectionSnapshot(live.providerConnection, providerConnection)
        || !isAllowedCursorProviderStateTransition(
          agent.providerContinuationId,
          agent.providerConnection,
          providerContinuationId,
          providerConnection,
        )) {
        throw new DaemonFenceLostError("Cursor provider state no longer belongs to the exact supervised lane.");
      }
      try {
        if (current.provider_ref.provider_continuation_id !== providerContinuationId
          || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, providerConnection)) {
          const checkpoint = await this.store.checkpointCursorProviderState(this.manifestGeneration, {
            agentId: agent.agentId,
            roomId: agent.roomId,
            inboxItemId,
            providerTurnId,
            workAttemptId: agent.workAttemptId,
            executionGenerationId: agent.executionGenerationId,
            agentSessionId: agent.agentSessionId,
            credentialRef: binding.credential_ref,
            apiUrl: agent.apiUrl,
            expectedProviderContinuationId: agent.providerContinuationId!,
            expectedProviderConnection: agent.providerConnection,
            providerContinuationId,
            providerConnection,
            observedAt: new Date().toISOString(),
          }, (commit) => completingAdmittedCursorState
            ? this.fenceAdmittedTransitionCommit(commit)
            : this.fenceDaemonCommit(commit));
          this.manifestGeneration = checkpoint.generation;
        }
        // Manifest and live handle now agree. Advance the in-memory ingress
        // authority before the separate attempt checkpoint so a failure in the
        // latter cannot split manifest=new from agent/handle=old.
        agent.providerContinuationId = providerContinuationId;
        agent.providerConnection = providerConnection;
        const attempt = await this.durability.getAttempt(agent.workAttemptId);
        if (attempt.checkpoints.at(-1)?.provider_continuation_id !== providerContinuationId) {
          try {
            await this.durability.checkpoint(agent.workAttemptId, {
              room_cursor: null,
              provider_continuation_id: providerContinuationId,
            });
          } catch {
            // The manifest is the authoritative live runtime reference. A
            // secondary attempt-history checkpoint must not make the adapter
            // reap an already-authorized turn; convergence retries it.
            this.scheduleRecoveryConvergence(agent.agentId, 1_000);
          }
        }
      } catch (error) {
        // An SQLite/filesystem boundary can report failure after committing.
        // Re-read the manifest and converge in-memory authority when the exact
        // new handle/ref is already durable; the next retry then only needs to
        // finish the idempotent attempt checkpoint.
        const [persisted, recoveredInbox, recoveredBinding] = await Promise.all([
          this.store.getEntry(agent.agentId).catch(() => undefined),
          this.supervisedInbox.get(inboxItemId).catch(() => null),
          this.workerBindings.get(agent.agentId).catch(() => null),
        ]);
        const recoveredCredential = recoveredBinding
          ? await this.workerBindings.credentialFor(recoveredBinding).catch(() => null)
          : null;
        const recoveredLive = this.liveHandles.get(agent.agentId);
        if (persisted?.room_id === agent.roomId
          && persisted.desired_state === "running"
          && persisted.provider === "cursor"
          && persisted.delivery_mode === "daemon_inbox"
          && persisted.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref?.work_attempt_id === agent.workAttemptId
          && persisted.provider_ref.execution_generation_id === agent.executionGenerationId
          && persisted.provider_ref.provider_continuation_id === providerContinuationId
          && sameProviderActionConnectionSnapshot(persisted.provider_ref.provider_connection, providerConnection)
          && recoveredInbox?.agent_id === agent.agentId
          && recoveredInbox.room_id === agent.roomId
          && recoveredInbox.provider_turn_id === providerTurnId
          && ["dispatching", "awaiting_result", "result_recovery"].includes(recoveredInbox.state)
          && recoveredBinding?.entry_id === agent.agentId
          && recoveredBinding.room_id === agent.roomId
          && recoveredBinding.api_url === agent.apiUrl
          && recoveredBinding.work_attempt_id === agent.workAttemptId
          && recoveredBinding.execution_generation_id === agent.executionGenerationId
          && recoveredBinding.agent_session_id === agent.agentSessionId
          && recoveredCredential === agent.bearer
          && recoveredLive === agent.handle
          && recoveredLive.workAttemptId === agent.workAttemptId
          && recoveredLive.providerContinuationId === providerContinuationId
          && sameProviderActionConnectionSnapshot(recoveredLive.providerConnection, providerConnection)
          && isAllowedCursorProviderStateTransition(
            agent.providerContinuationId,
            agent.providerConnection,
            providerContinuationId,
            providerConnection,
          )) {
          const manifest = await this.store.load();
          this.manifestGeneration = manifest.generation;
          agent.providerContinuationId = providerContinuationId;
          agent.providerConnection = providerConnection;
          return;
        }
        throw error;
      }
    }));
  }

  /** Re-check every authority component after delivery awaits; bearer equality stays memory-only. */
  private async isExactSupervisedDeliveryAuthority(
    authority: SupervisedDeliveryAuthority,
    scope: SupervisedAuthorityScope = "settled_provider_state",
  ): Promise<boolean> {
    if (this.handoffScheduled) return false;
    try { await this.singleton.assertCurrent(); } catch { return false; }
    if (authority.daemonGeneration !== this.singleton.currentGeneration) return false;
    const entry = await this.store.getEntry(authority.agentId);
    const handle = this.liveHandles.get(authority.agentId);
    if (!entry
      || entry.id !== authority.agentId
      || entry.room_id !== authority.roomId
      || entry.desired_state !== "running"
      || entry.delivery_mode !== "daemon_inbox"
      || entry.provider !== authority.provider
      || entry.work_attempt_id !== authority.workAttemptId
      || entry.provider_ref?.work_attempt_id !== authority.workAttemptId
      || entry.provider_ref?.execution_generation_id !== authority.executionGenerationId
      ) return false;
    const binding = await this.workerBindings.get(authority.agentId);
    if (!binding
      || binding.entry_id !== authority.agentId
      || binding.room_id !== authority.roomId
      || binding.api_url !== authority.apiUrl
      || binding.work_attempt_id !== authority.workAttemptId
      || binding.execution_generation_id !== authority.executionGenerationId
      || binding.agent_session_id !== authority.agentSessionId) return false;
    if ((await this.workerBindings.credentialFor(binding)) !== authority.bearer) return false;
    // Ingress authority deliberately survives loss of provider execution. A
    // bounded turn requires the exact live handle in addition to this route.
    if (!authority.handle) return true;
    if (!handle
      || handle !== authority.handle
      || handle.workAttemptId !== authority.workAttemptId) return false;
    if (scope === "lane_lease") return true;
    if (handle.pid !== (authority.providerConnection?.pid ?? null)) return false;
    return entry.provider_ref?.provider_continuation_id === authority.providerContinuationId
      && sameProviderActionConnectionSnapshot(
        entry.provider_ref?.provider_connection ?? null,
        authority.providerConnection,
      )
      && handle.providerContinuationId === authority.providerContinuationId
      && sameProviderActionConnectionSnapshot(
        handle.providerConnection ?? null,
        authority.providerConnection,
      );
  }

  private status() {
    return {
      healthy: true,
      protocol_version: DAEMON_PROTOCOL_VERSION,
      implementation_version: DAEMON_IMPLEMENTATION_VERSION,
      runtime_environment_fingerprint: process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT ?? null,
      capabilities: {
        room_delivery_retry: Boolean(this.supervisedDelivery && this.providerPort?.runRoomTurn),
        provider_continuation_repair: Boolean(this.supervisedDelivery && this.providerPort?.repairContinuation),
        room_delivery_skip: Boolean(this.supervisedDelivery),
        agent_inspector_detail_v1: true,
        agent_inspector_settings_v1: true,
        agent_room_move_v1: true,
        agent_lifecycle_v1: true,
        agent_runtime_recovery_v1: true,
        agent_state_subscription_v1: true,
        agent_activity_stream_v1: true,
      },
      generation: this.singleton.currentGeneration,
      pid: process.pid,
      started_at: this.startedAt,
    };
  }

  private async prepareHandoff(): Promise<void> {
    if (this.handoffTeardownScheduled) return;
    if (!this.handoffScheduled) this.handoffScheduled = true;
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

  /**
   * Explicitly replace a provider runtime that is durably proven absent.
   *
   * Reconnect is intentionally credential-only and may never create a second
   * writer. Recovery crosses that boundary only after the saved execution is
   * terminal (or an attach returns exact terminal evidence), ends the prior
   * worker session, and retires every stale runtime/binding coordinate. The
   * durable agent, room, work attempt, workspace, configuration, inbox, and
   * cursor remain untouched; ordinary convergence then creates one successor
   * provider generation.
   */
  private async completeTurnControlForRuntimeRecovery(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    const control = entry.turn_control;
    if (!control || control.status === "completed") return entry;
    if (!entry.work_attempt_id || control.work_attempt_id !== entry.work_attempt_id) {
      throw new Error("Provider recovery found a turn-control barrier owned by a different work attempt.");
    }
    const attempt = await this.durability.getAttempt(control.work_attempt_id);
    const controlledExecution = attempt.execution_generations.find((candidate) =>
      candidate.execution_generation_id === control.execution_generation_id);
    if (!controlledExecution?.terminal) {
      throw new Error("Provider recovery cannot retire turn control before its exact execution generation is durably terminal.");
    }
    const observedAt = new Date(this.nowMs()).toISOString();
    const checkpoint = await this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const committed = await this.store.commitTurnControlState(this.manifestGeneration, {
        agentId: entry.id,
        roomId: entry.room_id,
        actionId: control.action_id,
        workAttemptId: control.work_attempt_id,
        executionGenerationId: control.execution_generation_id,
        mode: "runtime_recovered",
        // Terminal provider evidence retires the control barrier. FIFO state
        // is changed only when the journal persisted A's exact inbox identity;
        // an unlinked historical head may actually be successor B.
        settleOriginal: Boolean(control.inbox_item_id),
        activateCorrection: control.correction_strategy === "stop_then_resend",
        observedAt,
      }, (current, outcome) => ({
        ...current,
        reconciliation: rememberCompletedControlAction(
          advanceReconciliationState(current.reconciliation, current.observed_state, this.nowMs()),
          control.action_id,
        ),
        turn_control: {
          ...current.turn_control!,
          inbox_item_id: outcome.inboxItemId,
          provider_turn_id: outcome.providerTurnId,
          operator_resolution: null,
          status: "completed",
          interrupted: outcome.original === "cancelled",
          resumed: control.correction_strategy === "stop_then_resend",
          state: "idle",
          stages: outcome.inboxItemId
            ? control.correction_strategy === "stop_then_resend"
              ? ["delivered", "applied", "resumed"]
              : ["delivered", "applied"]
            : control.correction_strategy === "stop_then_resend"
              ? ["delivered", "resumed"]
              : [],
          error: control.has_correction && control.correction_strategy !== "stop_then_resend"
            ? "The previous provider was terminally recovered. Its legacy correction payload was not durably recoverable and must be reissued."
            : outcome.inboxItemId
              ? "The previous provider was terminally recovered; its exact linked turn-control barrier was settled before replacement."
              : "The previous provider was terminally recovered. The unlinked legacy control barrier was retired without guessing or mutating the current FIFO head.",
          updated_at: observedAt,
        },
      }), (commit) => this.fenceDaemonCommit(commit));
      this.manifestGeneration = committed.generation;
      return committed;
    });
    return checkpoint.entry;
  }

  private async recoverAgentRuntime(entryId: string, daemonGeneration: number) {
    const release = this.beginLifecycleExclusion(entryId);
    try {
      return await this.recoverAgentRuntimeExclusive(entryId, daemonGeneration);
    } finally {
      release();
    }
  }

  private async recoverAgentRuntimeExclusive(entryId: string, daemonGeneration: number) {
    if (!entryId || daemonGeneration !== this.singleton.currentGeneration) {
      throw new Error("Agent runtime recovery is fenced by a stale daemon generation.");
    }
    this.bumpEntryControlEpoch(entryId);
    this.clearRecoveryConvergence(entryId);
    const updated = await this.serializeEntryTick(entryId, async () => {
      await this.singleton.assertCurrent();
      if (daemonGeneration !== this.singleton.currentGeneration || this.handoffScheduled) {
        throw new Error("Agent runtime recovery lost daemon authority.");
      }
      let entry = await this.store.getEntry(entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      if (entry.desired_state === "stopped") {
        throw new Error("A stopped agent must be resumed before its runtime can be recovered.");
      }
      if (this.liveHandles.has(entryId)) {
        throw new Error("The provider runtime is still connected. Reconnect its credentials instead.");
      }
      // Runtime replacement is destructive: terminal evidence, the worker
      // session, and its credential binding are retired below. Prove first—
      // while lifecycle exclusion and the per-entry lane prevent any new room
      // move edge—that destination membership has not entered an ambiguous or
      // post-join phase. The final manifest mutation still performs the exact
      // atomic pre-membership cancellation; this early phase fence prevents us
      // from destroying the authority needed to compensate a later phase.
      const pendingRoomMoves = await this.store.pendingRoomMoves(entryId);
      if (pendingRoomMoves.length > 1) {
        throw new Error("Runtime recovery found more than one nonterminal room move for this agent.");
      }
      if (pendingRoomMoves.some((move) => !["prepared", "waiting_for_current_turn"].includes(move.phase))) {
        throw new Error("Agent runtime recovery is blocked while a room move may have changed destination membership.");
      }

      const ref = entry.provider_ref ?? null;
      if (ref) {
        if (!entry.work_attempt_id || ref.work_attempt_id !== entry.work_attempt_id) {
          throw new Error("The saved provider runtime no longer matches this agent’s durable work attempt.");
        }
        const attempt = await this.durability.getAttempt(ref.work_attempt_id);
        const execution = attempt.execution_generations.find((candidate) =>
          candidate.execution_generation_id === ref.execution_generation_id);
        if (!execution) {
          throw new Error("The saved provider runtime has no matching durable execution generation.");
        }
        if (!execution.terminal) {
          if (!this.providerPort) throw new Error("Provider recovery is unavailable.");
          const attachment = await this.providerPort.attach(this.providerRef(entry));
          if (!attachment) {
            throw new Error("LetAgents cannot prove that the previous provider process stopped. Recovery was not started.");
          }
          if (!this.isAttachTerminal(attachment)) {
            throw new Error("The provider runtime is still reachable. Reconnect its credentials instead.");
          }
          if (attachment.terminal.providerContinuationId
            && attachment.terminal.providerContinuationId !== ref.provider_continuation_id) {
            throw new Error("Provider recovery returned terminal evidence for a different continuation.");
          }
          await this.durability.recordTerminal(ref.work_attempt_id, ref.execution_generation_id, {
            ...this.terminalPayload(attachment.terminal, execution.actor),
            actor: execution.actor,
            generation: execution.generation,
          });
          await this.durability.releaseTerminalExecutionFence(ref.work_attempt_id, ref.execution_generation_id);
        }
      }

      await this.supervisedDelivery?.stop(entryId).catch(() => undefined);
      // Exact terminal evidence for the old provider is the generation-cutover
      // boundary. Settle its journal/FIFO effects before removing provider_ref;
      // otherwise an old unresolved action would freeze every future generation.
      entry = await this.completeTurnControlForRuntimeRecovery(await this.store.getEntry(entryId) ?? entry);
      const binding = await this.workerBindings.get(entryId);
      const retainedSessionId = binding?.agent_session_id
        ?? entry.last_worker_binding?.agent_session_id
        ?? null;
      if (retainedSessionId) {
        const grant = this.workerAuthority.currentHostGrant(entry);
        if (!grant || !this.supervisorGrantHttp.endWorkerSession) {
          throw new Error("Desktop credentials are required before this provider can be safely recovered.");
        }
        await this.supervisorGrantHttp.endWorkerSession({
          apiUrl: grant.apiUrl,
          grantId: grant.grantId,
          supervisorGrant: grant.supervisorGrant,
          grantGeneration: grant.grantGeneration,
          sessionId: retainedSessionId,
        });
      }
      if (binding) {
        await this.workerBindings.unbind(
          entryId,
          binding.agent_session_id,
          binding.execution_generation_id,
        );
      }
      this.workerRuntimeCustody.deleteLiveBinding(entryId);
      this.workerRuntimeCustody.deletePendingResumeBinding(entryId);
      this.workerRuntimeCustody.deleteWorkerAuthorization(entryId);

      entry = await this.updateManifestEntry(entryId, (current) => ({
        ...current,
        desired_state: "running",
        observed_state: "starting",
        condition: "none",
        last_error: null,
        run_id: null,
        deployment_id: null,
        provider_ref: null,
        last_worker_binding: null,
        workplace_liveness: {
          state: "unknown",
          observed_at: new Date(this.nowMs()).toISOString(),
          detail: "Preparing a replacement provider and exact worker binding.",
        },
        native_liveness: {
          state: "unknown",
          observed_at: new Date(this.nowMs()).toISOString(),
          detail: "The previous provider process stopped; a replacement is starting.",
        },
      }), {
        agentId: entryId,
        detail: "Room move cancelled because its activating provider runtime ended before destination membership was joined.",
      });
      return entry;
    });
    this.requestConvergence(entryId);
    return { outcome: "recovering", entry: await this.entryWithDerivedLiveness(updated) };
  }

  private async putManifestEntry(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    return this.manifestAdministration.putManifestEntry(entry);
  }

  private beginLifecycleExclusion(entryId: string): () => void {
    return this.entryConcurrency.beginLifecycle(entryId);
  }

  private async setDesiredState(id: string, desiredState: DesiredState): Promise<DaemonManifestEntry> {
    const release = this.beginLifecycleExclusion(id);
    try {
      return await this.setDesiredStateExclusive(id, desiredState);
    } finally {
      release();
    }
  }

  private async setDesiredStateExclusive(id: string, desiredState: DesiredState): Promise<DaemonManifestEntry> {
    if (!id) throw new Error("Manifest entry id is required.");
    if (!["running", "paused", "stopped"].includes(desiredState)) throw new Error("Invalid desired state.");
    this.bumpEntryControlEpoch(id);
    const deliveryStopped = desiredState !== "running" && Boolean(this.supervisedDelivery);
    if (deliveryStopped) {
      try {
        // Wait only for a room-move transition that was already active when
        // lifecycle exclusion began. Provider launch/capability work remains
        // fenceable and cannot make Stop/Pause wait on the broad entry lane.
        await this.waitForActiveRoomMoveReconciliation(id);
        this.clearRecoveryConvergence(id);
        await this.supervisedDelivery!.stop(id);
      } catch (error) {
        await this.restartSupervisedDeliveryOrConverge(id);
        throw error;
      }
    }
    let updated: DaemonManifestEntry;
    try {
      updated = await this.serializeManifestMutation(async () => {
        await this.singleton.assertCurrent();
        const manifest = await this.store.load();
        const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
        const entry = manifest.entries.find((candidate) => candidate.id === id);
        if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
        if (desiredState !== "stopped") {
          const supervisedOwner = this.competingSupervisedLaneOwner(manifest.entries, entry);
          if (supervisedOwner) {
            throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
          }
          const legacyOwner = legacyOwners.find((candidate) =>
            candidate.room_id === entry.room_id && candidate.provider === entry.provider);
          if (legacyOwner && desiredState === "running") {
            throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
          }
        }
        const updated = { ...entry, desired_state: desiredState };
        const next = await this.writeManifest(
          this.manifestGeneration,
          manifest.entries.map((candidate) => candidate.id === id ? updated : candidate),
          legacyOwners,
          desiredState === "running" ? undefined : {
            agentId: id,
            detail: `Room move cancelled because the agent lifecycle changed to ${desiredState} before destination membership was joined.`,
          },
        );
        this.manifestGeneration = next.generation;
        return updated;
      });
    } catch (error) {
      if (deliveryStopped) await this.restartSupervisedDeliveryOrConverge(id);
      throw error;
    }
    this.requestConvergence(id);
    return updated;
  }

  /**
   * Repair mutable product identity without touching provider execution,
   * delivery cursors, credentials, or lifecycle authority.
   */
  private async setDisplayName(id: string, displayName: string): Promise<DaemonManifestEntry> {
    return this.manifestAdministration.setDisplayName(id, displayName);
  }

  private async compareAndSetDesiredState(
    id: string,
    expectedDesiredState: DesiredState,
    desiredState: DesiredState,
  ): Promise<{ applied: boolean; entry: DaemonManifestEntry }> {
    const release = this.beginLifecycleExclusion(id);
    try {
      return await this.compareAndSetDesiredStateExclusive(id, expectedDesiredState, desiredState);
    } finally {
      release();
    }
  }

  private async compareAndSetDesiredStateExclusive(
    id: string,
    expectedDesiredState: DesiredState,
    desiredState: DesiredState,
  ): Promise<{ applied: boolean; entry: DaemonManifestEntry }> {
    if (!id) throw new Error("Manifest entry id is required.");
    if (!["running", "paused", "stopped"].includes(expectedDesiredState)) throw new Error("Invalid expected desired state.");
    if (!["running", "paused", "stopped"].includes(desiredState)) throw new Error("Invalid desired state.");
    const preflight = await this.store.getEntry(id);
    if (!preflight) throw new Error(`Unknown daemon manifest entry: ${id}`);
    if (preflight.desired_state !== expectedDesiredState) {
      return { applied: false, entry: preflight };
    }
    this.bumpEntryControlEpoch(id);
    const deliveryStopped = desiredState !== "running" && Boolean(this.supervisedDelivery);
    if (deliveryStopped) {
      try {
        await this.waitForActiveRoomMoveReconciliation(id);
        this.clearRecoveryConvergence(id);
        await this.supervisedDelivery!.stop(id);
      } catch (error) {
        await this.restartSupervisedDeliveryOrConverge(id);
        throw error;
      }
    }
    let result: { applied: boolean; entry: DaemonManifestEntry };
    try {
      result = await this.serializeManifestMutation(async () => {
        await this.singleton.assertCurrent();
        const manifest = await this.store.load();
        const legacyOwners = this.liveLegacyLaneOwners(manifest.legacy_lane_owners ?? []);
        const entry = manifest.entries.find((candidate) => candidate.id === id);
        if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
        if (entry.desired_state !== expectedDesiredState) return { applied: false, entry };
        if (desiredState !== "stopped") {
          const supervisedOwner = this.competingSupervisedLaneOwner(manifest.entries, entry);
          if (supervisedOwner) {
            throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by supervised entry '${supervisedOwner.id}'.`);
          }
          const legacyOwner = legacyOwners.find((candidate) =>
            candidate.room_id === entry.room_id && candidate.provider === entry.provider);
          if (legacyOwner && desiredState === "running") {
            throw new Error(`Provider lane '${entry.room_id}/${entry.provider}' is already owned by legacy reservation '${legacyOwner.reservation_id}'.`);
          }
        }
        const updated = { ...entry, desired_state: desiredState };
        const next = await this.writeManifest(
          this.manifestGeneration,
          manifest.entries.map((candidate) => candidate.id === id ? updated : candidate),
          legacyOwners,
          desiredState === "running" ? undefined : {
            agentId: id,
            detail: `Room move cancelled because the agent lifecycle changed to ${desiredState} before destination membership was joined.`,
          },
        );
        this.manifestGeneration = next.generation;
        return { applied: true, entry: updated };
      });
    } catch (error) {
      if (deliveryStopped) await this.restartSupervisedDeliveryOrConverge(id);
      throw error;
    }
    if (result.applied) {
      this.requestConvergence(id);
    } else {
      if (deliveryStopped) await this.restartSupervisedDeliveryOrConverge(id);
      // The speculative epoch bump may have fenced an in-flight launch even
      // though the CAS lost. Reconcile the unchanged durable state again.
      this.requestConvergence(id);
    }
    return result;
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
    const bindings = new Map((await this.workerBindings.list()).map((binding) => [binding.entry_id, binding]));
    return Promise.all(entries.map((entry) => this.entryWithDerivedLiveness(entry, bindings.get(entry.id) ?? null)));
  }

  private notifyStateChanged(): void {
    this.stateWatch.notify();
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
    const projectionNowMs = this.nowMs();
    const binding = projectedBinding === undefined ? await this.workerBindings.get(entry.id) : projectedBinding;
    const receipts = await this.supervisedInbox.receipts(entry.id);
    const credential = bindingMatchesRoomAgentGeneration(entry, binding)
      ? await this.workerBindings.credentialFor(binding)
      : null;
    const continuationRepair = await this.supervisedInbox.latestContinuationRepair(entry.id);
    const currentHostGrantAvailable = Boolean(this.workerAuthority.currentHostGrant(entry));
    const liveHandle = this.liveHandles.get(entry.id);
    const persistedIngress = await this.supervisedInbox.ingressHealth(entry.id);
    const authorityFacts = {
      entry,
      binding,
      credentialAvailable: Boolean(credential),
      liveHandle: liveHandle ?? null,
    };
    const activeTurn = hasExactRoomAgentDeliveryOwner(authorityFacts) && binding && credential && liveHandle
      ? this.supervisedDelivery?.activeTurn({
          agentId: entry.id, roomId: binding.room_id, provider: entry.provider, apiUrl: binding.api_url,
          agentSessionId: binding.agent_session_id, bearer: credential, handle: liveHandle,
          workAttemptId: binding.work_attempt_id,
          providerContinuationId: liveHandle.providerContinuationId,
          providerConnection: entry.provider_ref?.provider_connection ?? null,
          executionGenerationId: binding.execution_generation_id, daemonGeneration: this.singleton.currentGeneration,
          deliveryMode: entry.delivery_mode ?? "mcp_polling",
        }) ?? null
      : null;
    return projectRoomAgentManifestEntry({
      ...authorityFacts,
      currentHostGrantAvailable,
      ingressHealth: persistedIngress,
      continuationRepair,
      receipts,
      activeTurn,
      nowMs: projectionNowMs,
      workplaceLivenessStaleAfterMs: workplaceLivenessStaleAfterMs(),
      nativeLivenessStaleAfterMs: NATIVE_LIVENESS_STALE_AFTER_MS,
    });
  }

  private async readAttempt(id: string) {
    const entry = (await this.store.load()).entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${id}`);
    const attempt = entry.work_attempt_id ? await this.durability.getAttempt(entry.work_attempt_id) : null;
    const lastGeneration = attempt?.execution_generations.at(-1) ?? null;
    return {
      entry_id: entry.id,
      work_attempt_id: attempt?.work_attempt_id ?? null,
      workspace_path: attempt?.workspace_path ?? null,
      last_terminal: lastGeneration?.terminal ?? null,
      restart_count: Math.max(0, (attempt?.execution_generations.length ?? 0) - 1),
      execution_generations: attempt?.execution_generations ?? [],
      checkpoints: attempt?.checkpoints ?? [],
      activity: entry.activity ?? [],
    };
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

  private providerRef(entry: DaemonManifestEntry): ProviderActionRef {
    const coordinator = this.providerExecution;
    if (!coordinator) throw new Error("Provider action port is unavailable");
    return coordinator.providerRef(entry);
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

  private isAttachTerminal(
    attachment: ProviderActionHandle | ProviderActionAttachTerminal,
  ): attachment is ProviderActionAttachTerminal {
    return this.providerExecution?.isAttachTerminal(attachment)
      ?? ("state" in attachment && attachment.state === "terminal");
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
    const safeMethod = redactCredentialText(method, 160).value;
    const observedMs = Date.parse(observedAt);
    const currentBinding = await this.workerBindings.get(entryId);
    if (!currentBinding || !await this.workerBindings.credentialFor(currentBinding)) return false;
    const publication = await this.workerBindings.publish(entryId, observedMs, async ({ binding, sequence, observed_at }) => {
      const credential = await this.workerBindings.credentialFor(binding);
      if (!credential) throw new Error("Worker credential is unavailable until desktop credential delivery.");
      return { accepted: await publishWorkerNativeActivity({
        apiUrl: binding.api_url,
        roomId: binding.room_id,
        agentSessionId: binding.agent_session_id,
        bearer: credential,
        observedAt: observed_at,
        sequence,
        method: safeMethod,
        status,
        operation: "the daemon bridge",
      }) };
    });
    if (!publication) return false;
    if (!publication.accepted) throw new Error("Native activity endpoint rejected a stale daemon observation.");
    const verifiedBinding = await this.workerBindings.get(entryId);
    if (verifiedBinding
      && verifiedBinding.room_id === currentBinding.room_id
      && verifiedBinding.work_attempt_id === currentBinding.work_attempt_id
      && verifiedBinding.execution_generation_id === currentBinding.execution_generation_id
      && verifiedBinding.agent_session_id === currentBinding.agent_session_id) {
      // A successful scoped-bearer write is stronger evidence than the stale
      // launch-time credential-handoff latch. This also heals agents that were
      // blocked while an older server still rejected worker bearers.
      let recoveredCredentialHandoff = false;
      await this.updateManifestEntry(entryId, (current) => {
        const recoversCredentialHandoff = current.desired_state === "running"
          && current.condition === "coordination_blocked"
          && current.last_error === "Provider is running; waiting for desktop credential handoff."
          && current.room_id === verifiedBinding.room_id
          && current.work_attempt_id === verifiedBinding.work_attempt_id
          && current.provider_ref?.execution_generation_id === verifiedBinding.execution_generation_id;
        if (!recoversCredentialHandoff) return current;
        recoveredCredentialHandoff = true;
        const confirmedAt = publication.observed_at;
        return {
          ...current,
          observed_state: "working",
          condition: "none",
          last_error: null,
          ready_reached_at: resolveReadyReachedAt(current, true, confirmedAt),
          workplace_liveness: {
            state: "reachable",
            observed_at: confirmedAt,
            detail: "scoped worker bearer verified",
          },
        };
      });
      if (recoveredCredentialHandoff) {
        // The failed bind path suppresses initial inbox startup. A later
        // successful heartbeat must restore both the visible state and actual
        // room delivery, otherwise the agent appears healthy but hears nothing.
        void this.startSupervisedDelivery(entryId).catch(() => undefined);
      }
    }
    return true;
  }

  private async handleProviderTerminal(entryId: string, handle: ProviderActionHandle, executionGenerationId: string, _terminalBinding: LiveBindingIdentity | undefined, terminal: ProviderActionTerminal): Promise<void> {
    if (this.liveHandles.get(entryId) !== handle) return;
    this.workerRuntimeCustody.deletePendingResumeBinding(entryId);
    this.providerStreams.remove(entryId, handle);
    // Provider execution and room observation are separate authorities. Keep
    // polling only while the durable lifecycle still wants a provider. A
    // retired agent must not recreate delivery after its stop raced terminal
    // observation and worker-session revocation.
    const lifecycle = await this.store.getEntry(entryId);
    if (lifecycle?.desired_state === "running") {
      void this.startSupervisedDelivery(entryId).catch(() => undefined);
    }
    await this.serializeEntryTick(entryId, async () => {
      const entry = (await this.store.load()).entries.find((candidate) => candidate.id === entryId);
      const successorHandle = this.liveHandles.get(entryId);
      if (successorHandle && successorHandle !== handle) return;
      if (entry?.work_attempt_id) {
        const attempt = await this.durability.getAttempt(entry.work_attempt_id);
        if (this.liveHandles.get(entryId)) return;
        const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === executionGenerationId);
        if (execution && !execution.terminal) {
          await this.durability.recordTerminal(entry.work_attempt_id, execution.execution_generation_id, {
            ...this.terminalPayload(terminal, execution.actor),
            generation: execution.generation,
          });
        }
        if (entry.desired_state === "stopped") {
          await this.durability.releaseTerminalExecutionFence(entry.work_attempt_id, executionGenerationId);
        }
      }
      if (this.liveHandles.get(entryId)) return;
      // Do not erase the terminal binding here. installProviderHandle removed its
      // live publication authority above; retaining the owner-only (0600)
      // private credential is what permits an exact successor to verify and
      // roll it forward after an intentional stop/start or daemon replacement.
      await this.observeProviderExitOnce(entryId, terminal, "daemon-provider", executionGenerationId, handle);
      this.requestConvergence(entryId);
    });
  }

  private async updateManifestEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
    roomMoveCancellation?: { agentId: string; detail: string },
  ): Promise<DaemonManifestEntry> {
    return this.serializeManifestMutation(async () => {
      await this.singleton.assertCurrent();
      const entry = await this.store.getEntry(entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      const updated = update(entry);
      if (updated === entry) return entry;
      const next = await this.store.replaceEntry(
        this.manifestGeneration,
        updated,
        (commit) => this.fenceDaemonCommit(commit),
        roomMoveCancellation,
      );
      this.manifestGeneration = next.generation;
      return next.entry;
    });
  }

  /** Identity P1b/P1d must pass into work-durability fencing. */
  supervisorFenceIdentity(): { supervisor_id: string; supervisor_generation: number } {
    return { supervisor_id: this.singleton.lockPath, supervisor_generation: this.singleton.currentGeneration };
  }

  async transition(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"]): Promise<void> {
    return this.serializeManifestMutation(() => this.transitionOnce(entryId, to, condition, cause, actor, reconciliation));
  }

  private async transitionOnce(entryId: string, to: ObservedState, condition: PolicyCondition, cause: string, actor: string, reconciliation?: DaemonManifestEntry["reconciliation"], notice?: ReconciliationNotice["kind"], terminal?: ExecutionTerminalPayload): Promise<void> {
    await this.singleton.assertCurrent();
    const entry = await this.store.getEntry(entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
    const safeCause = redactCredentialText(cause).value;
    const safeActor = redactCredentialText(actor).value;
    const sanitizeTerminal = (value: ExecutionTerminalPayload | undefined): ExecutionTerminalPayload | undefined => value ? {
      ...value,
      signal: value.signal === null ? null : redactCredentialText(value.signal).value,
      stdio_archive_ref: value.stdio_archive_ref === null ? null : redactCredentialText(value.stdio_archive_ref).value,
      stdio_tail: redactCredentialText(value.stdio_tail, 64 * 1024).value,
      terminal_cause: redactCredentialText(value.terminal_cause).value,
      actor: redactCredentialText(value.actor).value,
      provider_continuation_id: value.provider_continuation_id === null ? null : redactCredentialText(value.provider_continuation_id).value,
    } : undefined;
    const candidateReconciliation = reconciliation ?? advanceReconciliationState(entry.reconciliation, to, this.nowMs());
    const nextReconciliation = {
      ...candidateReconciliation,
      last_terminal: sanitizeTerminal(candidateReconciliation.last_terminal),
    };
    const safeTerminal = sanitizeTerminal(terminal);
    const noticeKind = notice ?? (condition === "quarantined" ? "quarantine_death" : condition === "coordination_blocked" ? "coordination_escalation" : undefined);
    const notices = (entry.reconciliation_notices ?? []).map((candidate) => ({
      ...candidate,
      cause: redactCredentialText(candidate.cause).value,
      terminal: sanitizeTerminal(candidate.terminal),
    }));
    if (noticeKind) notices.push({ at: new Date().toISOString(), kind: noticeKind, cause: safeCause, terminal: safeTerminal ?? nextReconciliation.last_terminal ?? undefined });
    const lastError = to === "failed" || condition !== "none"
      ? safeCause
      : (["working", "idle", "stopped"].includes(to) ? null : entry.last_error === null || entry.last_error === undefined ? null : redactCredentialText(entry.last_error).value);
    const updated: DaemonManifestEntry = {
      ...entry,
      observed_state: to,
      condition,
      last_error: lastError,
      reconciliation: nextReconciliation,
      reconciliation_notices: notices.slice(-32),
    };
    const next = await this.store.replaceEntry(this.manifestGeneration, updated, (commit) => this.fenceDaemonCommit(commit));
    this.manifestGeneration = next.generation;
    await this.serializeManifestCommit(async () => {
      await this.singleton.assertCurrent();
      await this.audit.append({ at: new Date().toISOString(), entry_id: entryId, from: entry.observed_state, to, cause: safeCause, actor: safeActor, generation: next.generation });
    });
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
    await this.serializeEntryTick(entryId, () => this.observeProviderExitOnce(entryId, terminal, actor, expectedExecutionGenerationId, expectedHandle));
  }

  private async observeProviderExitOnce(entryId: string, terminal: ProviderActionTerminal, actor: string, expectedExecutionGenerationId?: string, expectedHandle?: ProviderActionHandle): Promise<void> {
    await this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      if (expectedExecutionGenerationId && entry.provider_ref?.execution_generation_id !== expectedExecutionGenerationId) return;
      const currentHandle = this.liveHandles.get(entryId);
      if (expectedHandle && currentHandle && currentHandle !== expectedHandle) return;
      const payload = this.terminalPayload(terminal, actor);
      if (entry.condition === "quarantined") {
        // A stale child cannot unquarantine the entry, but its immutable death
        // evidence must still reach the durable operator inbox.
        await this.transitionOnce(entryId, entry.observed_state, "quarantined", `late provider terminal: ${terminal.terminalCause}`, actor, { ...advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs()), last_terminal: payload }, "quarantine_death", payload);
        return;
      }
      const turnControl = entry.turn_control;
      const completedStopTurn = entry.desired_state === "running"
        && terminal.terminalCause === "stopped"
        && turnControl?.execution_generation_id === entry.provider_ref?.execution_generation_id
        && turnControl?.status === "completed"
        && turnControl?.has_correction === false
        && turnControl?.interrupted === true
        && turnControl?.resumed === false
        && turnControl?.state === "idle";
      const intentional = entry.desired_state === "stopped" || entry.desired_state === "paused" || completedStopTurn;
      const observedState = completedStopTurn ? "idle" : entry.desired_state === "paused" ? "paused" : intentional ? "stopped" : "failed";
      const reconciliation = { ...advanceReconciliationState(entry.reconciliation, observedState, this.nowMs()), last_terminal: payload };
      await this.transitionOnce(
        entryId,
        observedState,
        "none",
        completedStopTurn ? "provider terminal completed intentional stop-turn" : `provider terminal: ${terminal.terminalCause}`,
        actor,
        reconciliation,
      );
    });
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
    return {
      ended_at: terminal.endedAt,
      exit_code: terminal.exitCode,
      signal: terminal.signal,
      stdio_archive_ref: null,
      stdio_tail: "",
      terminal_cause: terminal.terminalCause,
      actor,
      generation: this.singleton.currentGeneration,
      provider_continuation_id: terminal.providerContinuationId,
    };
  }

  private async recordSchedulerFailure(entryId: string, error: unknown, actor: string): Promise<void> {
    const message = schedulerErrorDetail(error);
    // A resume that failed because the saved runtime is provably gone can never
    // succeed by retrying resume. Recover the way a manual Recover does: drop
    // the dead continuation so the next convergence starts a fresh runtime, and
    // record a failed edge so the crash-loop machinery bounds it — a single
    // crash self-heals in ~1s, a genuine crash-loop backs off then quarantines
    // (an actionable rest) instead of dead-ending silently in "recovering".
    if (providerRuntimeGoneFailure(error)) {
      let didReset = false;
      await this.serializeEntryTick(entryId, () => this.updateManifestEntry(entryId, (current) => {
        // Only the daemon-owned running entry with a live continuation to drop
        // is reset here; anything else (stopped, quarantined, already reset) is
        // left untouched so this cannot re-fire on a subsequent poke.
        if (current.desired_state !== "running" || current.condition === "quarantined" || !current.provider_ref) {
          return current;
        }
        didReset = true;
        return {
          ...current,
          observed_state: "failed",
          condition: "none",
          last_error: "The previous provider runtime stopped; starting a replacement.",
          provider_ref: null,
          last_worker_binding: null,
          reconciliation: advanceReconciliationState(current.reconciliation, "failed", this.nowMs()),
        };
      }));
      if (didReset) {
        await this.audit.append({
          at: new Date().toISOString(), entry_id: entryId, from: "recovering", to: "failed",
          cause: "provider runtime is gone; recovering with a fresh runtime", actor,
          generation: this.singleton.currentGeneration,
        });
        // Prompt first attempt; convergence honors the persisted backoff for
        // repeats and quarantines a true crash-loop into an actionable rest.
        this.scheduleRecoveryConvergence(entryId, 1_000);
      }
      return;
    }
    await this.serializeEntryTick(entryId, () => this.serializeManifestMutation(async () => {
      const manifest = await this.store.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return;
      const condition = entry.condition === "quarantined" ? "quarantined" : "coordination_blocked";
      // Before a work attempt exists there is no provider execution to
      // recover or reconnect. Preserve that distinction in durable state so
      // the desktop can offer an honest provisioning retry.
      const observedState = !entry.work_attempt_id && !entry.provider_ref
        ? "failed"
        : entry.observed_state;
      // An unusable source repository is a launch-input problem, not a
      // scheduler fault — surface its actionable message verbatim (no wrapper)
      // so the desktop can tell the user to pick a valid repository folder.
      const lastError = error instanceof UnusableSourceRepositoryError
        ? error.message
        : `convergence scheduler failure: ${message}`;
      await this.transitionOnce(entryId, observedState, condition, lastError, actor, undefined, "coordination_escalation");
    }));
    // A transient mint failure must converge again without waiting for another
    // Electron RPC — but only a bounded number of times: each retry re-runs up
    // to three 10s cloud mints, so an endpoint that stays unreachable must
    // rest at the blocked state instead of looping every heartbeat forever.
    if (exhaustedTransientWorkerMint(error)) {
      const attempts = (this.workerMintRecoveryRetryAttempts.get(entryId) ?? 0) + 1;
      this.workerMintRecoveryRetryAttempts.set(entryId, attempts);
      if (attempts <= WORKER_MINT_RECOVERY_RETRY_LIMIT) {
        this.scheduleRecoveryConvergence(entryId, this.nativeHeartbeatIntervalMs);
      }
      return;
    }
    // A launch that timed out left nothing durable behind; retry it a bounded
    // number of times instead of parking the entry in "starting" until an
    // unrelated RPC happens to converge it again.
    if (transientProviderStartFailure(error)) {
      const attempts = (this.providerStartRetryAttempts.get(entryId) ?? 0) + 1;
      this.providerStartRetryAttempts.set(entryId, attempts);
      if (attempts <= PROVIDER_START_RETRY_LIMIT) {
        this.scheduleRecoveryConvergence(entryId, this.nativeHeartbeatIntervalMs);
      }
    }
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
    await daemon.start();
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
