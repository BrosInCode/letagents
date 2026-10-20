/**
 * Builds the daemon's authority, stores and their first coordinators: the
 * manifest, durability, worker bindings, inbox, live sharing, state watch and
 * worker authority.
 */
import { isLocalRoomApi } from "../local-room-runtime.js";
import { dirname, join } from "node:path";
import { AuditLog } from "../audit-log.js";
import { AgentStreamRegistry } from "../agent-stream-registry.js";
import { ReplyAttachmentSpool } from "../reply-attachment-spool.js";
import { createLiveActivitySession, updateLiveActivitySession, withdrawLiveActivity } from "../cloud-http.js";
import { sanitizeDaemonActivityEvent } from "../credential-redaction.js";
import { DaemonAuthority } from "../daemon-authority.js";
import { DeliveryCutoverCoordinator } from "../delivery-cutover-coordinator.js";
import { schedulerErrorDetail } from "../daemon-error-policy.js";
import { DaemonStateWatch, STATE_WATCH_NOTIFICATION_COALESCE_MS } from "../daemon-state-watch.js";
import { WorkDurabilityStore } from "../durability-store.js";
import { EntryConcurrencyGate } from "../entry-concurrency-gate.js";
import { EphemeralWorkspaceProvisioner } from "../ephemeral-workspace-provisioner.js";
import { LifecycleAdministrationCoordinator } from "../lifecycle-administration-coordinator.js";
import { projectDaemonCreateRequestReplayParameters } from "../manifest-entry-projection.js";
import { ManifestAdministrationCoordinator } from "../manifest-administration-coordinator.js";
import { ManifestStore } from "../manifest-store.js";
import { DaemonActivityWrites } from "../activity-write-batcher.js";
import { ManifestTransitionCoordinator } from "../manifest-transition-coordinator.js";
import { NativeActivityPublicationCoordinator } from "../native-activity-publication-coordinator.js";
import { LiveRoomSharePublisher } from "../live-room-share-publisher.js";
import { ConvergencePacer } from "../convergence-pacer.js";
import { DaemonSingleton } from "../singleton.js";
import { deriveProviderConfigurationSnapshot } from "../provider-configuration.js";
import { supervisedPermissionProfilesForProvider } from "../supervised-permission-profiles.js";
import { createGitCommand, WorkspaceProvisioner, type GitCommand } from "../workspace-provisioner.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { WorkerAuthorityCoordinator } from "../worker-authority-coordinator.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { RoomTurnAttachmentStager } from "../room-turn-attachments.js";
import { SupervisorDaemonLifecycle } from "./lifecycle.js";
import type { SupervisorDaemonArgs } from "./state.js";

export abstract class SupervisorDaemonStores extends SupervisorDaemonLifecycle {
  protected readonly stateDatabasePath: string;
  protected readonly singleton: DaemonSingleton;
  protected readonly authority: DaemonAuthority;
  protected readonly store: ManifestStore;
  /** Native activity events wait here briefly and are written in batches. */
  protected readonly activityWrites: DaemonActivityWrites;
  protected readonly manifestAdministration: ManifestAdministrationCoordinator;
  protected readonly manifestTransitions: ManifestTransitionCoordinator;
  protected readonly lifecycleAdministration: LifecycleAdministrationCoordinator;
  protected readonly audit: AuditLog;
  protected readonly durability: WorkDurabilityStore;
  protected readonly provisioner: WorkspaceProvisioner;
  protected readonly ephemeralProvisioner: EphemeralWorkspaceProvisioner;
  protected readonly gitCommand: GitCommand;
  protected readonly workerBindings: WorkerBindingStore;
  protected readonly nativeActivity: NativeActivityPublicationCoordinator;
  protected readonly workerAuthority: WorkerAuthorityCoordinator;
  protected readonly convergencePacer: ConvergencePacer;
  /** Shares the daemon's SQLite durability path; delivery orchestration owns no secrets. */
  protected readonly supervisedInbox: SupervisedAgentInboxStore;
  /** Daemon-owned copies of files agents attach to their final replies. */
  protected readonly replyAttachmentSpool: ReplyAttachmentSpool;
  /** Images on the message that wakes an agent, staged for one turn under the daemon's own folder. */
  protected readonly roomTurnAttachments: RoomTurnAttachmentStager;
  protected readonly stateWatch: DaemonStateWatch;
  protected readonly entryConcurrency: EntryConcurrencyGate;
  protected readonly deliveryCutovers: DeliveryCutoverCoordinator;
  protected readonly agentStreamRegistry: AgentStreamRegistry;
  protected readonly liveRoomShare: LiveRoomSharePublisher;

  constructor(...args: SupervisorDaemonArgs) {
    super(...args);
    const [paths, platform, providerPort, , , , recoveryClock] = args;
    this.stateDatabasePath = paths.manifestPath;
    this.singleton = new DaemonSingleton(paths.lockPath, platform);
    const daemonAuthority = {
      currentGeneration: () => this.singleton.currentGeneration,
      isHandoffScheduled: () => this.handoffScheduled,
      assertCurrent: () => this.singleton.assertCurrent(),
      fenceCommit: (commit: () => Promise<void>) => this.fenceDaemonCommit(commit),
    };
    this.authority = new DaemonAuthority({
      ...daemonAuthority,
      notifyStateChanged: (captureAgentId) => this.notifyStateChanged(captureAgentId),
    });
    this.entryConcurrency = new EntryConcurrencyGate({
      isHandoffScheduled: () => this.handoffScheduled || this.handoffDraining,
    });
    this.deliveryCutovers = new DeliveryCutoverCoordinator({
      isHandoffScheduled: () => this.handoffScheduled,
      drive: (entryId, signal) => this.deliveryCutoverExecution.drive(entryId, signal),
    });
    this.store = new ManifestStore(paths.manifestPath, paths.legacyManifestPath, undefined, undefined, /* schemaPrepared */ true);
    this.activityWrites = new DaemonActivityWrites({ authority: this.authority, store: this.store,
      isHandoffScheduled: () => this.handoffScheduled, admittedFence: (commit) => this.fenceAdmittedTransitionCommit(commit) });
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
        deriveProviderConfiguration: deriveProviderConfigurationSnapshot,
        permissionProfilesForProvider: supervisedPermissionProfilesForProvider,
        sanitizeActivity: sanitizeDaemonActivityEvent,
        safeErrorDetail: schedulerErrorDetail,
      },
      convergence: {
        request: (entryId) => this.requestConvergence(entryId),
      },
      activity: this.activityWrites.admission,
      liveSharing: {
        changed: (entryId, saved) => this.liveRoomShare.setSharing(entryId, saved),
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
    this.roomTurnAttachments = new RoomTurnAttachmentStager(join(root, "room-turn-attachments"));
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
      paths.manifestPath, undefined, /* schemaPrepared */ true,
    );
    this.provisioner = new WorkspaceProvisioner(root, gitCommand);
    this.ephemeralProvisioner = new EphemeralWorkspaceProvisioner(root);
    this.workerBindings = new WorkerBindingStore(
      paths.workerBindingsPath ?? `${paths.manifestPath}.worker-bindings`,
      (commit, notification) => this.fenceDaemonCommit(commit, notification),
      paths.manifestPath, undefined, /* schemaPrepared */ true,
    );
    this.nativeActivity = new NativeActivityPublicationCoordinator({
      bindings: this.workerBindings,
      updateEntry: (entryId, update, options) => this.updateManifestEntry(entryId, update, undefined, options),
      startDelivery: (entryId) => this.startSupervisedDelivery(entryId),
    });
    this.stateWatch = new DaemonStateWatch({
      ...daemonAuthority, coalesceMs: STATE_WATCH_NOTIFICATION_COALESCE_MS,
      entries: async () => this.readModel.entriesWithDerivedLiveness((await this.store.load("summary")).entries, { reuseUnchangedInboxInputs: true }),
    });
    this.agentStreamRegistry = new AgentStreamRegistry({
      isHandoffScheduled: () => this.handoffScheduled,
    });
    // The room's view of each agent's turn, published only while its owner shares it.
    this.liveRoomShare = new LiveRoomSharePublisher({
      sharing: async (entryId) => (await this.store.getAgentConfiguration(entryId))?.live_sharing ?? "off",
      withdrawn: async (entryId) => {
        await this.serializeManifestMutation(async () => {
          await this.singleton.assertCurrent();
          await this.store.markLiveSharingWithdrawn(entryId, (commit) => this.fenceDaemonCommit(commit));
        });
      },
      target: async (entryId) => {
        const binding = await this.workerBindings.get(entryId);
        if (!binding || isLocalRoomApi(binding.api_url)) return null;
        const bearer = await this.workerBindings.credentialFor(binding);
        return bearer ? { apiUrl: binding.api_url, roomId: binding.room_id, bearer } : null;
      },
      feed: {
        highWater: (entryId) => this.agentStreamRegistry.highWater(entryId),
        retainedAfter: (entryId, afterSequence) => this.agentStreamRegistry.retainedAfter(entryId, afterSequence),
      },
      http: {
        create: (target, body) => createLiveActivitySession({ ...target, body }),
        update: (target, sessionId, body) => updateLiveActivitySession({ ...target, sessionId, body }),
        withdraw: (target) => withdrawLiveActivity(target),
      },
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
      deleteAgentStream: (entryId) => { this.agentStreamRegistry.delete(entryId); this.liveRoomShare.forget(entryId); },
      ephemeralProvisioner: this.ephemeralProvisioner,
      nowMs: () => this.nowMs(),
    });
    // Inbox state belongs to the canonical daemon database. The worker-binding
    // path is a legacy JSON import source and must never become a second SQLite
    // authority for delivery receipts.
    this.supervisedInbox = new SupervisedAgentInboxStore(
      paths.manifestPath, undefined, (agentId) => this.notifyStateChanged(agentId), /* schemaPrepared */ true,
    );
    this.replyAttachmentSpool = new ReplyAttachmentSpool(join(dirname(paths.manifestPath), "reply-attachments"));
    this.convergencePacer = new ConvergencePacer({ nowMs: recoveryClock.nowMs, random: recoveryClock.random,
      hasPendingWork: async (entryId) => { const head = await this.supervisedInbox.head(entryId); return Boolean(head && head.state !== "blocked"); },
    });
    this.workerAuthority = new WorkerAuthorityCoordinator({
      store: this.store,
      durability: this.durability,
      bindings: this.workerBindings,
      custody: this.workerRuntimeCustody, audit: this.audit,
      inbox: this.supervisedInbox,
      supervisorGrantHttp: this.supervisorGrantHttp,
      deliveryHttp: this.supervisedDeliveryHttp,
      authority: daemonAuthority,
      concurrency: this.entryConcurrency,
      serializeEntry: (entryId, operation, signal) => this.serializeEntryTick(entryId, operation, signal),
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
        holdIngressForBearerRotation: (entryId) => this.supervisedDelivery?.holdIngressForBearerRotation(entryId) ?? (() => {}),
        bearerSuccessorBinding: (entryId) => this.supervisedDelivery?.bearerSuccessorBinding(entryId),
        bearerSuccessorAbandoned: (entryId) => this.supervisedDelivery?.bearerSuccessorAbandoned(entryId),
      },
      convergence: {
        request: (entryId, kind) => this.requestConvergence(entryId, kind),
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
      sleep: recoveryClock.sleep, random: recoveryClock.random, pacing: this.convergencePacer,
    });
  }
}
