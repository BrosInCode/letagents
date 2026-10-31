/**
 * Builds the provider side of the daemon: provider streams, scheduler
 * failures, provider execution and provider reconciliation.
 */
import { unavailableLifecycleProjectionDiagnostics } from "../lifecycle-projection-ledger.js";
import { ProviderExecutionCoordinator } from "../provider-execution-coordinator.js";
import { ProviderReconciliationCoordinator } from "../provider-reconciliation-coordinator.js";
import { ProviderSchedulerFailureCoordinator } from "../provider-scheduler-failure-coordinator.js";
import { ProviderStreamCoordinator } from "../provider-stream-coordinator.js";
import { SupervisorDaemonStores } from "./stores.js";
import type { SupervisorDaemonArgs } from "./state.js";

export abstract class SupervisorDaemonProviderExecution extends SupervisorDaemonStores {
  protected readonly providerStreams: ProviderStreamCoordinator;
  protected readonly providerExecution: ProviderExecutionCoordinator | null;
  protected readonly providerReconciliation: ProviderReconciliationCoordinator | null;
  protected readonly providerSchedulerFailures: ProviderSchedulerFailureCoordinator;

  constructor(...args: SupervisorDaemonArgs) {
    super(...args);
    const [paths, , providerPort, , , , recoveryClock] = args;
    this.providerStreams = new ProviderStreamCoordinator({
      liveHandles: this.liveHandles,
      observeExecution: (installation) => (this.typedLifecycleEffects?.changed(installation.entryId),
        this.executionCapture?.install(installation) ?? (() => {})),
      advanceExecution: (installation) => { this.typedLifecycleEffects?.changed(installation.entryId); this.executionCapture?.advance(installation); },
      observeLegacyLifecycle: (observation) => this.executionCapture?.recordLegacyLifecycle(observation),
      markLifecycleProjectionUnavailable: (provider) => this.executionCapture?.recordLifecycleProjectionUnavailable(provider),
      lifecycleProjectionDiagnostics: () => this.executionCapture?.lifecycleProjectionDiagnostics()
        ?? unavailableLifecycleProjectionDiagnostics(),
      captureAdmission: (installation) => this.executionCapture?.captureAdmission(installation) ?? "unavailable",
      typedLifecycleAdmission: (installation) => this.executionCapture?.typedLifecycleAdmission(installation) ?? "unavailable",
      recordBlock: (installation) => this.executionCapture?.recordBlock(installation) ?? null,
      observePermissions: (entryId, handle, generation) => this.hostApprovals.install(entryId, handle, generation),
      ...(providerPort ? { provider: providerPort } : {}),
      manifest: {
        getEntry: (entryId) => this.activityWrites.overlayEntry(this.store.getEntry(entryId)),
        getRecentEntry: (entryId) => this.activityWrites.readRecentEntry(entryId),
        getScalarEntry: (entryId) => this.activityWrites.overlayEntry(this.store.getEntry(entryId, "summary")),
        load: () => this.activityWrites.overlayManifest(this.store.load()),
        updateEntry: (entryId, update) => this.updateManifestEntry(entryId, update),
        readRuntimeLifecycleAuthority: (input) => this.store.readRuntimeLifecycleAuthority(input),
      },
      bindings: this.workerBindings,
      durability: this.durability,
      runtimeCustody: this.workerRuntimeCustody,
      serializeEntry: (entryId, operation) => this.serializeEntryTick(entryId, operation),
      serializeManifest: (operation) => this.serializeManifestMutation(operation),
      transition: (entryId, state, condition, detail, actor) => this.transition(entryId, state, condition, detail, actor),
      appendNativeActivity: (entryId, event, activityOnly, position) => this.manifestAdministration.appendNativeActivity(entryId, event, activityOnly, position),
      publishNativeActivity: (entryId, method, status, observedAt) => this.publishNativeActivity(entryId, method, status, observedAt),
      observeActivitySummary: (entryId, summary, status) => this.nativeActivity.observeActivitySummary(entryId, summary, status),
      handleTerminal: (installation, _bindingIdentity, terminal) =>
        this.providerTerminals.handleTerminal(installation, terminal),
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
      transitionOnce: (entryId, state, condition, cause, actor, reconciliation, notice, terminal) => this.transitionOnce(entryId, state, condition, cause, actor, reconciliation, notice, terminal),
      audit: this.audit,
      scheduleRecovery: (entryId, delayMs) => this.scheduleRecoveryConvergence(entryId, delayMs),
    });
    this.providerExecution = providerPort
      ? new ProviderExecutionCoordinator({
        notifyProgressChanged: () => this.notifyStateChanged(),
        notifyLaunchProgressChanged: () => this.notifyStateChanged(false),
        retirePendingActivity: (entryId) => this.activityWrites.retireEntry(entryId),
        refreshManagedRuntime: (entryId) => this.runtimeConfigurationApply.refreshManaged(entryId),
        exitSettling: (entryId) => this.providerTerminals.settling(entryId),
        settleRuntimeApprovals: (entryId) => this.settleRuntimeApprovals(entryId),
        provider: providerPort,
        store: this.store,
        durability: this.durability,
        bindings: this.workerBindings,
        streams: this.providerStreams,
        authority: {
          isHandoffScheduled: () => this.handoffScheduled,
          isDispatchPaused: () => this.handoffDraining,
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
        transition: (entryId, state, condition, detail, actor) => this.transition(entryId, state, condition, detail, actor),
        terminalPayload: (terminal, actor, connection) => this.providerTerminals.terminalPayload(terminal, actor, connection),
        observeProviderExit: (entryId, terminal, actor, executionGenerationId, handle) =>
          this.observeProviderExitOnce(entryId, terminal, actor, executionGenerationId, handle),
        completeTurnControlForRuntimeRecovery: (entry) => this.runtimeRecovery.completeTurnControl(entry),
        delivery: {
          stop: async (entryId) => { await this.supervisedDelivery?.stop(entryId); },
          start: (entryId, mode) => this.startSupervisedDelivery(entryId, mode ?? "refresh"),
          roomRefusesAccess: (entryId) => this.supervisedDelivery?.roomRefusesAccess(entryId) ?? false,
        },
        inbox: {
          head: (entryId) => this.supervisedInbox.head(entryId),
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
          awaitsBindingConfirmation: (entryId, generationId) => this.workerAuthority.awaitsBindingConfirmation(entryId, generationId),
          confirmExactBinding: (entryId, mayPublish) => this.workerAuthority.confirmExactBinding(entryId, mayPublish),
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
        pacing: this.convergencePacer,
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
        terminalPayload: (terminal, actor, connection) => this.providerTerminals.terminalPayload(terminal, actor, connection),
        observeProviderExit: (entryId, terminal, actor) =>
          this.observeProviderExit(entryId, terminal, actor),
        recordSchedulerFailure: (entryId, error, actor) =>
          this.recordSchedulerFailure(entryId, error, actor),
        nowMs: () => this.nowMs(),
      })
      : null;
  }
}
