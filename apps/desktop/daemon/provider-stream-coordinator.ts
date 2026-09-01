import { publishWorkerNativeActivity } from "./cloud-http.js";
import { sanitizeDaemonActivityEvent } from "./credential-redaction.js";
import type { WorkDurabilityStore } from "./durability-store.js";
import type {
  ProviderActionHandle,
  ProviderActionConnectionRef,
  ProviderActionPort,
  ProviderActionStreamEvent,
  ProviderActionTerminal,
} from "./provider-action-port.js";
import { sameProviderActionConnectionSnapshot } from "./provider-action-port.js";
import {
  isAgentInspectorLiveDisplayEvent,
  isCorrelatedNonemptyWaitResult,
  isHumanRoomActivityEvent,
  isSupervisedQuietPollContinuation,
  isSupervisedWaitProviderEvent,
  providerStreamLifecycle,
  supervisedWaitEvidenceFromProviderEvent,
  type SupervisedWaitEvidence,
} from "./provider-stream-policy.js";
import type {
  DaemonActivityEvent,
  DaemonManifestEntry,
  ObservedState,
  PolicyCondition,
} from "./types.js";
import type { WorkerBindingStore, WorkerSessionBinding } from "./worker-binding-store.js";
import type {
  InstalledHostGrant,
  LiveBindingIdentity,
  WorkerRuntimeCustody,
} from "./worker-runtime-custody.js";
import {
  unavailableLifecycleProjectionDiagnostics,
  type LifecycleCaptureAdmissionDiagnostics,
  type LifecycleCaptureAdmissionStatus,
  type LifecycleProjectionDiagnostics,
  type LifecycleProjectionObservation,
  type LifecycleProjectionProvider,
} from "./lifecycle-projection-ledger.js";
import type { LifecycleAuthorityMode } from "./lifecycle-authority-mode.js";

/** Immutable identity for one exact durable provider installation. */
export type ProviderInstallationToken = Readonly<{
  nonce: symbol;
  listenerLeaseNonce: symbol;
  entryId: string;
  handle: ProviderActionHandle;
  executionGenerationId: string;
  workAttemptId: string;
  providerContinuationId: string;
  providerConnection: ProviderActionConnectionRef;
  configurationRevision: number;
  authorityMode: LifecycleAuthorityMode | null;
}>;

type ProviderListenerLease = {
  nonce: symbol;
  entryId: string;
  handle: ProviderActionHandle;
  executionGenerationId: string;
  disposers: Array<() => void>;
};

export type ProviderRecoveryDiagnostics = {
  daemon_inbox_wait_evidence_dependency: number;
  lifecycle_projection: LifecycleProjectionDiagnostics;
  lifecycle_capture_admission: LifecycleCaptureAdmissionDiagnostics;
  lifecycle_local_conformance_eligible: Record<LifecycleProjectionProvider, boolean>;
};

const lifecycleProjectionProviders = ["codex", "claude-code", "cursor"] as const;
function providerForLifecycleConnection(
  connection: ProviderActionHandle["providerConnection"],
): LifecycleProjectionProvider | null {
  if (connection?.kind === "codex_app_server") return "codex";
  if (connection?.kind === "claude_cli") return "claude-code";
  if (connection?.kind === "cursor_cli") return "cursor";
  return null;
}

/**
 * Evidence-present-and-clean is only a local conformance prerequisite. It is
 * not soak sufficiency or authority to flip a provider. Projection totals are
 * monotonic, so any recorded mismatch, conflict, or unavailable observation
 * keeps that provider ineligible until a separately designed evidence epoch
 * exists; this read-time predicate never caches or persists a second result.
 */
export function lifecycleLocalConformanceEligibility(
  projection: LifecycleProjectionDiagnostics,
  daemonInboxWaitEvidenceDependency: number,
  captureAdmission: LifecycleCaptureAdmissionDiagnostics,
): Record<LifecycleProjectionProvider, boolean> {
  const cleanWaitAuthority = Number.isSafeInteger(daemonInboxWaitEvidenceDependency)
    && daemonInboxWaitEvidenceDependency === 0;
  return Object.fromEntries(lifecycleProjectionProviders.map((provider) => {
    const evidence = projection.providers?.[provider];
    const counters = evidence && [
      evidence.comparedSegments,
      evidence.matched,
      evidence.missingInTyped,
      evidence.missingInLegacy,
      evidence.pairedButDifferent,
      evidence.conflicts,
      evidence.observationUnavailable,
    ];
    const validCounters = Boolean(counters?.every((value) => Number.isSafeInteger(value) && value >= 0));
    const eligible = projection.available === true
      && cleanWaitAuthority
      && captureAdmission[provider] === "ready"
      && validCounters
      && evidence.comparedSegments >= 1
      && evidence.missingInTyped === 0
      && evidence.missingInLegacy === 0
      && evidence.pairedButDifferent === 0
      && evidence.conflicts === 0
      && evidence.observationUnavailable === 0;
    return [provider, eligible];
  })) as Record<LifecycleProjectionProvider, boolean>;
}

export type ProviderStreamManifest = {
  getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
  load(): Promise<{ entries: DaemonManifestEntry[] }>;
  updateEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
  ): Promise<DaemonManifestEntry>;
  readRuntimeLifecycleAuthority(input: {
    agentId: string;
    executionGenerationId: string;
    providerConnection: ProviderActionConnectionRef;
    configurationRevision: number;
  }): Promise<LifecycleAuthorityMode | null>;
};

export type ProviderStreamBindings = Pick<
  WorkerBindingStore,
  | "get"
  | "credentialFor"
  | "verifyAndAdvanceExecutionGeneration"
  | "checkpointCursorMonotonic"
>;

export type ProviderStreamDurability = Pick<
  WorkDurabilityStore,
  "getAttempt" | "checkpoint"
>;

export type ProviderStreamRuntimeCustody = Pick<
  WorkerRuntimeCustody,
  | "liveBinding"
  | "installLiveBinding"
  | "deleteLiveBinding"
  | "pendingResumeBinding"
  | "hasPendingResumeBinding"
  | "installPendingResumeBinding"
  | "deletePendingResumeBinding"
>;

export type ProviderStreamTransition = (
  entryId: string,
  observedState: ObservedState,
  condition: PolicyCondition,
  cause: string,
  actor: string,
) => Promise<void>;

export type ProviderStreamCoordinatorOptions = {
  /** Optional compatibility map shared with the temporarily-thin daemon facade. */
  liveHandles?: Map<string, ProviderActionHandle>;
  provider?: Pick<ProviderActionPort, "stop" | "onExit" | "onStream" | "probeControl">;
  /** Optional non-authoritative capture; never awaited by provider delivery. */
  observeExecution?(installation: ProviderInstallationToken): () => void;
  /** Advance an existing capture lease to a newly committed Cursor child birth. */
  advanceExecution?(installation: ProviderInstallationToken): void;
  /** Raw legacy-classifier witness. This is comparison evidence, never lifecycle authority. */
  observeLegacyLifecycle?(observation: LifecycleProjectionObservation): void;
  markLifecycleProjectionUnavailable?(provider: LifecycleProjectionProvider): void;
  lifecycleProjectionDiagnostics?(): LifecycleProjectionDiagnostics;
  captureAdmission?(installation: ProviderInstallationToken): LifecycleCaptureAdmissionStatus;
  /** Operational approvals have their own lifetime, independent of optional capture. */
  observePermissions?: (entryId: string, handle: ProviderActionHandle, generation: string) => () => void;
  manifest: ProviderStreamManifest;
  bindings: ProviderStreamBindings;
  durability: ProviderStreamDurability;
  runtimeCustody: ProviderStreamRuntimeCustody;
  serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  transition: ProviderStreamTransition;
  appendActivity(
    entryId: string,
    event: DaemonActivityEvent,
  ): Promise<unknown>;
  publishNativeActivity(
    entryId: string,
    method: string,
    status: "working" | "idle",
    observedAt?: string,
  ): Promise<unknown>;
  handleTerminal(
    installation: ProviderInstallationToken,
    bindingIdentity: LiveBindingIdentity | undefined,
    terminal: ProviderActionTerminal,
  ): Promise<void>;
  streams: {
    reset(entryId: string): void;
    push(entryId: string, event: DaemonActivityEvent): void;
    end(entryId: string): void;
  };
  delivery: {
    start(entryId: string): Promise<unknown>;
    startCutover(entryId: string): Promise<unknown>;
  };
  heartbeat: {
    intervalMs: number;
    requiresHostGrant(entry: DaemonManifestEntry): boolean | Promise<boolean>;
    currentHostGrant(entry: DaemonManifestEntry): InstalledHostGrant | null;
    hostGrantNeedsRenewal(grant: InstalledHostGrant): boolean;
    hostWorkerBearerNeedsRotation(
      entry: DaemonManifestEntry,
      binding: WorkerSessionBinding,
    ): Promise<boolean>;
    requestConvergence(entryId: string): void;
  };
  publishWorkerActivity?: typeof publishWorkerNativeActivity;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

/**
 * Owns provider handles, listener lifetimes, ordered stream projection, wait
 * cursor persistence, terminal fencing, and exact worker-binding rollover.
 */
export class ProviderStreamCoordinator {
  /** Kept public as a temporary compatibility seam for main.ts tests/callers. */
  readonly liveHandles: Map<string, ProviderActionHandle>;

  private readonly listenerLeases = new Map<string, ProviderListenerLease>();
  private readonly streamQueues = new Map<string, Promise<void>>();
  private readonly cursorCheckpointQueues = new Map<string, Promise<void>>();
  private readonly callbacks = new Set<Promise<void>>();
  private readonly terminalFenceRequests = new WeakMap<ProviderInstallationToken, Promise<void>>();
  private readonly latestInstallations = new Map<string, ProviderInstallationToken>();
  private daemonInboxWaitEvidenceDependencies = 0;
  private readonly publishWorkerActivity: typeof publishWorkerNativeActivity;
  private readonly setHeartbeat: typeof setInterval;
  private readonly clearHeartbeat: typeof clearInterval;

  constructor(private readonly options: ProviderStreamCoordinatorOptions) {
    this.liveHandles = options.liveHandles ?? new Map<string, ProviderActionHandle>();
    this.publishWorkerActivity = options.publishWorkerActivity ?? publishWorkerNativeActivity;
    this.setHeartbeat = options.setInterval ?? setInterval;
    this.clearHeartbeat = options.clearInterval ?? clearInterval;
  }

  get(entryId: string): ProviderActionHandle | undefined {
    return this.liveHandles.get(entryId);
  }

  has(entryId: string): boolean {
    return this.liveHandles.has(entryId);
  }

  currentInstallation(entryId: string): ProviderInstallationToken | undefined {
    const installation = this.latestInstallations.get(entryId);
    return installation && this.isCurrentInstallation(installation) ? installation : undefined;
  }

  isLatestInstallation(installation: ProviderInstallationToken): boolean {
    return this.latestInstallations.get(installation.entryId) === installation;
  }

  recoveryDiagnostics(): ProviderRecoveryDiagnostics {
    const daemonInboxWaitEvidenceDependency = this.daemonInboxWaitEvidenceDependencies;
    const lifecycleProjection = this.options.lifecycleProjectionDiagnostics?.()
      ?? unavailableLifecycleProjectionDiagnostics();
    const lifecycleCaptureAdmission = this.lifecycleCaptureAdmission();
    return {
      daemon_inbox_wait_evidence_dependency: daemonInboxWaitEvidenceDependency,
      lifecycle_projection: lifecycleProjection,
      lifecycle_capture_admission: lifecycleCaptureAdmission,
      lifecycle_local_conformance_eligible: lifecycleLocalConformanceEligibility(
        lifecycleProjection,
        daemonInboxWaitEvidenceDependency,
        lifecycleCaptureAdmission,
      ),
    };
  }

  private lifecycleCaptureAdmission(): LifecycleCaptureAdmissionDiagnostics {
    const admissions = { codex: "unavailable", "claude-code": "unavailable", cursor: "unavailable" } as LifecycleCaptureAdmissionDiagnostics;
    const seen = new Set<LifecycleProjectionProvider>();
    const priority = { ready: 0, pending: 1, unavailable: 2 } as const;
    for (const [entryId, handle] of this.liveHandles) {
      const provider = providerForLifecycleConnection(handle.providerConnection);
      if (!provider) continue;
      const installation = this.currentInstallation(entryId);
      let current: LifecycleCaptureAdmissionStatus = "unavailable";
      if (installation && this.options.captureAdmission) {
        try { current = this.options.captureAdmission(installation); }
        catch { current = "unavailable"; }
      }
      if (!seen.has(provider) || priority[current] > priority[admissions[provider]]) admissions[provider] = current;
      seen.add(provider);
    }
    return admissions;
  }

  private acceptsLegacyWaitAuthority(entry: DaemonManifestEntry): boolean {
    if ((entry.delivery_mode ?? "mcp_polling") === "mcp_polling") return true;
    if (entry.delivery_mode === "daemon_inbox") this.daemonInboxWaitEvidenceDependencies += 1;
    return false;
  }

  /** Remove only one exact installation; handle identity alone is never enough. */
  remove(installation: ProviderInstallationToken): boolean {
    if (!this.isCurrentInstallation(installation)) return false;
    // Keep the inert latest-birth witness until a successor installation
    // replaces it. Terminal reconciliation uses that exact token after live
    // publication authority has been removed to reject stale exits without
    // rejecting the terminal event that performed this removal.
    this.liveHandles.delete(installation.entryId);
    this.options.runtimeCustody.deleteLiveBinding(installation.entryId);
    const failures = this.disposeEntryListeners(installation.entryId);
    this.throwCleanupFailures(failures, `Provider stream cleanup failed for ${installation.entryId}.`);
    return true;
  }

  async install(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    mayStartDelivery: () => boolean = () => true,
  ): Promise<void> {
    const provider = this.options.provider;
    if (!provider) throw new Error("Provider action port is unavailable");
    const lease: ProviderListenerLease = {
      nonce: Symbol(entryId), entryId, handle, executionGenerationId, disposers: [],
    };
    const installation = await this.prepareInstallation(
      entryId,
      handle,
      executionGenerationId,
      lease.nonce,
    );
    this.latestInstallations.set(entryId, installation);
    this.liveHandles.delete(entryId);
    const replacementCleanupFailures = this.disposeEntryListeners(entryId);
    this.throwCleanupFailures(
      replacementCleanupFailures,
      `Provider stream replacement cleanup failed for ${entryId}.`,
    );
    this.options.streams.reset(entryId);
    this.liveHandles.set(entryId, handle);
    this.listenerLeases.set(entryId, lease);
    let disposeExecution = () => {};
    try { disposeExecution = this.options.observeExecution?.(installation) ?? disposeExecution; }
    catch { /* optional observation must not reject provider installation */ }
    if (!this.adoptLeaseDisposer(lease, disposeExecution)) return;
    const disposeCapture = () => { try { disposeExecution(); } catch { /* observation owns no execution authority */ } };
    lease.disposers.splice(lease.disposers.indexOf(disposeExecution), 1, disposeCapture);
    const disposePermissions = this.options.observePermissions?.(entryId, handle, executionGenerationId) ?? (() => {});
    if (!this.adoptLeaseDisposer(lease, disposePermissions)) return;
    const binding = await this.options.bindings.get(entryId);
    if (!this.isCurrentListenerLease(lease)) return;
    const currentBinding = this.options.runtimeCustody.liveBinding(entryId);
    if (binding?.execution_generation_id === executionGenerationId) {
      if (!currentBinding || binding.updated_at >= currentBinding.updatedAt) {
        this.options.runtimeCustody.installLiveBinding(entryId, {
          agentSessionId: binding.agent_session_id,
          executionGenerationId: binding.execution_generation_id,
          updatedAt: binding.updated_at,
        });
      }
    } else if (currentBinding?.executionGenerationId !== executionGenerationId) {
      this.options.runtimeCustody.deleteLiveBinding(entryId);
    }
    const disposeExit = await provider.onExit(handle, (terminal) => {
      const currentInstallation = this.currentInstallationForLease(lease);
      if (!currentInstallation) return;
      const bindingIdentity = this.options.runtimeCustody.liveBinding(entryId);
      this.track(this.options.handleTerminal(
        currentInstallation,
        bindingIdentity,
        terminal,
      ));
    });
    if (!this.adoptLeaseDisposer(lease, disposeExit)) return;
    const disposeStream = provider.onStream
      ? await provider.onStream(handle, (event) => {
          const currentInstallation = this.currentInstallationForLease(lease);
          if (!currentInstallation) {
            this.markLifecycleProjectionUnavailableForEvent(event);
            return;
          }
          this.track(this.enqueueInstalled(currentInstallation, event));
        })
      : () => {};
    if (!this.adoptLeaseDisposer(lease, disposeStream)) return;
    const heartbeat = this.setHeartbeat(() => {
      const heartbeatInstallation = this.currentInstallationForLease(lease);
      if (!heartbeatInstallation) return;
      const current = heartbeatInstallation.handle;
      this.track((async () => {
        const manifestEntry = await this.options.manifest.getEntry(entryId);
        if (!manifestEntry || !this.entryMatchesInstallation(manifestEntry, heartbeatInstallation)
          || !this.isCurrentInstallation(heartbeatInstallation)) return;
        if (this.options.runtimeCustody.liveBinding(entryId)?.executionGenerationId
          !== manifestEntry.provider_ref?.execution_generation_id) return;
        const retriesCredentialHandoff = manifestEntry.desired_state === "running"
          && manifestEntry.observed_state === "recovering"
          && manifestEntry.condition === "coordination_blocked"
          && manifestEntry.last_error === "Provider is running; waiting for desktop credential handoff.";
        if (!["working", "idle"].includes(manifestEntry.observed_state)
          && !retriesCredentialHandoff) return;
        if (!["working", "idle"].includes(current.observedState)) return;
        if (manifestEntry.delivery_mode === "daemon_inbox"
          && ["working", "idle"].includes(manifestEntry.observed_state)
          && provider.probeControl) {
          try { await provider.probeControl(current); }
          catch { /* Shadow probes cannot interrupt operational heartbeats. */ }
          if (!this.isCurrentInstallation(heartbeatInstallation)
            || this.options.runtimeCustody.liveBinding(entryId)?.executionGenerationId
              !== manifestEntry.provider_ref?.execution_generation_id) return;
        }
        const hostGrant = await this.options.heartbeat.requiresHostGrant(manifestEntry)
          ? this.options.heartbeat.currentHostGrant(manifestEntry)
          : null;
        if (hostGrant && this.options.heartbeat.hostGrantNeedsRenewal(hostGrant)) {
          this.options.heartbeat.requestConvergence(entryId);
          return;
        }
        if (hostGrant) {
          const binding = await this.options.bindings.get(entryId);
          if (binding
            && await this.options.heartbeat.hostWorkerBearerNeedsRotation(manifestEntry, binding)) {
            this.options.heartbeat.requestConvergence(entryId);
            return;
          }
        }
        const status = current.observedState === "idle" ? "idle" : "working";
        await this.options.publishNativeActivity(
          entryId,
          "native_harness.heartbeat",
          status,
        );
      })().catch(() => undefined));
    }, this.options.heartbeat.intervalMs);
    heartbeat.unref?.();
    if (!this.adoptLeaseDisposer(lease, () => this.clearHeartbeat(heartbeat))) return;
    if (!this.adoptLeaseDisposer(lease, () => this.options.streams.end(entryId))) return;
    if (this.isCurrentListenerLease(lease)
      && this.currentInstallationForLease(lease)
      && mayStartDelivery()) {
      void this.options.delivery.start(entryId).catch(() => undefined);
    }
  }

  /**
   * Advance only the immutable token for an already-installed Cursor wrapper.
   * The caller must pass the exact entry returned by the committed checkpoint;
   * physical listeners remain attached to the stable handle lease.
   */
  activateCommittedCursorRuntime(input: {
    entry: DaemonManifestEntry;
    handle: ProviderActionHandle;
    executionGenerationId: string;
    authorityMode?: LifecycleAuthorityMode | null;
  }): ProviderInstallationToken {
    const { entry, handle, executionGenerationId } = input;
    const connection = entry.provider_ref?.provider_connection;
    const configurationRevision = handle.appliedConfigurationRevision;
    const lease = this.listenerLeases.get(entry.id);
    if (entry.provider !== "cursor" || connection?.kind !== "cursor_cli"
      || !lease || !this.isCurrentListenerLease(lease)
      || lease.handle !== handle || lease.executionGenerationId !== executionGenerationId
      || !Number.isSafeInteger(configurationRevision) || configurationRevision! < 1
      || !this.entryMatchesBirth(entry, handle, executionGenerationId, connection)) {
      throw new Error("Cursor runtime token no longer matches its committed listener lease.");
    }
    const prior = this.latestInstallations.get(entry.id);
    if (!prior || prior.handle !== handle
      || prior.listenerLeaseNonce !== lease.nonce
      || prior.executionGenerationId !== executionGenerationId
      || prior.workAttemptId !== handle.workAttemptId
      || prior.configurationRevision !== configurationRevision) {
      throw new Error("Cursor runtime token lost its stable listener lease.");
    }
    const idle = connection.pid === null && (connection.processIdentity ?? null) === null;
    const authorityMode = input.authorityMode === undefined
      && sameProviderActionConnectionSnapshot(prior.providerConnection, connection)
      ? prior.authorityMode
      : input.authorityMode;
    if (idle ? authorityMode !== null : !connection.processIdentity?.trim() || authorityMode == null) {
      throw new Error("Cursor runtime token requires authority for exactly one committed process birth.");
    }
    const frozenAuthorityMode = authorityMode as LifecycleAuthorityMode | null;
    if (this.entryMatchesInstallation(entry, prior)
      && prior.authorityMode === frozenAuthorityMode
      && this.matchesInstallationSnapshot(prior)) return prior;
    const installation = Object.freeze({
      nonce: Symbol(entry.id),
      listenerLeaseNonce: lease.nonce,
      entryId: entry.id,
      handle,
      executionGenerationId,
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId!,
      providerConnection: structuredClone(connection),
      configurationRevision: configurationRevision!,
      authorityMode: frozenAuthorityMode,
    });
    this.latestInstallations.set(entry.id, installation);
    try { this.options.advanceExecution?.(installation); }
    catch { /* optional observation cannot reject a committed provider birth */ }
    return installation;
  }

  private async prepareInstallation(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    listenerLeaseNonce: symbol,
  ): Promise<ProviderInstallationToken> {
    const continuation = handle.providerContinuationId;
    const connection = handle.providerConnection;
    const configurationRevision = handle.appliedConfigurationRevision;
    if (!continuation || !connection || !Number.isSafeInteger(configurationRevision)
      || configurationRevision! < 1) {
      throw new Error("Provider installation requires an exact durable provider birth.");
    }
    const first = await this.options.manifest.getEntry(entryId);
    if (!first || !this.entryMatchesBirth(first, handle, executionGenerationId, connection)) {
      throw new Error("Provider installation no longer matches its durable provider birth.");
    }
    const authorityMode = await this.options.manifest.readRuntimeLifecycleAuthority({
      agentId: entryId,
      executionGenerationId,
      providerConnection: connection,
      configurationRevision: configurationRevision!,
    });
    const idleCursor = connection.kind === "cursor_cli"
      && connection.pid === null
      && (connection.processIdentity ?? null) === null;
    if (!authorityMode && !idleCursor) {
      throw new Error("Provider installation has no frozen lifecycle authority.");
    }
    const second = await this.options.manifest.getEntry(entryId);
    if (!second || !this.entryMatchesBirth(second, handle, executionGenerationId, connection)) {
      throw new Error("Provider installation changed while verifying frozen lifecycle authority.");
    }
    return Object.freeze({
      nonce: Symbol(entryId),
      listenerLeaseNonce,
      entryId,
      handle,
      executionGenerationId,
      workAttemptId: handle.workAttemptId,
      providerContinuationId: continuation,
      providerConnection: structuredClone(connection),
      configurationRevision: configurationRevision!,
      authorityMode,
    });
  }

  private entryMatchesBirth(
    entry: DaemonManifestEntry,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    connection: ProviderActionConnectionRef,
  ): boolean {
    return entry.work_attempt_id === handle.workAttemptId
      && entry.provider_ref?.work_attempt_id === handle.workAttemptId
      && entry.provider_ref.provider_continuation_id === handle.providerContinuationId
      && entry.provider_ref.execution_generation_id === executionGenerationId
      && sameProviderActionConnectionSnapshot(entry.provider_ref.provider_connection, connection)
      && handle.appliedConfigurationRevision !== undefined;
  }

  private entryMatchesInstallation(
    entry: DaemonManifestEntry,
    installation: ProviderInstallationToken,
  ): boolean {
    return entry.id === installation.entryId
      && entry.work_attempt_id === installation.workAttemptId
      && entry.provider_ref?.work_attempt_id === installation.workAttemptId
      && entry.provider_ref.provider_continuation_id === installation.providerContinuationId
      && entry.provider_ref.execution_generation_id === installation.executionGenerationId
      && sameProviderActionConnectionSnapshot(
        entry.provider_ref.provider_connection,
        installation.providerConnection,
      );
  }

  private matchesInstallationSnapshot(installation: ProviderInstallationToken): boolean {
    return installation.handle.workAttemptId === installation.workAttemptId
      && installation.handle.appliedConfigurationRevision === installation.configurationRevision
      && (installation.providerConnection.kind === "cursor_cli"
        || installation.handle.providerContinuationId === installation.providerContinuationId)
      && sameProviderActionConnectionSnapshot(
        installation.handle.providerConnection,
        installation.providerConnection,
      );
  }

  private isCurrentInstallation(installation: ProviderInstallationToken): boolean {
    return this.isLatestInstallation(installation)
      && this.liveHandles.get(installation.entryId) === installation.handle
      && this.listenerLeases.get(installation.entryId)?.nonce === installation.listenerLeaseNonce
      && this.matchesInstallationSnapshot(installation);
  }

  private isCurrentListenerLease(lease: ProviderListenerLease): boolean {
    return this.listenerLeases.get(lease.entryId) === lease
      && this.liveHandles.get(lease.entryId) === lease.handle;
  }

  private currentInstallationForLease(lease: ProviderListenerLease): ProviderInstallationToken | undefined {
    if (!this.isCurrentListenerLease(lease)) return undefined;
    const installation = this.latestInstallations.get(lease.entryId);
    return installation?.listenerLeaseNonce === lease.nonce
      && this.isCurrentInstallation(installation) ? installation : undefined;
  }

  private adoptLeaseDisposer(
    lease: ProviderListenerLease,
    disposer: () => void,
  ): boolean {
    if (this.isCurrentListenerLease(lease)) {
      lease.disposers.push(disposer);
      return true;
    }
    try { disposer(); } catch { /* stale listener cleanup cannot regain authority */ }
    return false;
  }

  async stageWorkerBindingAfterResume(
    entry: DaemonManifestEntry,
    priorBinding: WorkerSessionBinding,
    successorExecutionGenerationId: string,
    handle: ProviderActionHandle,
  ): Promise<void> {
    if (!this.acceptsLegacyWaitAuthority(entry)) {
      throw new Error("Only legacy polling can await provider worker-wait evidence.");
    }
    const ref = entry.provider_ref;
    if (!ref
      || priorBinding.entry_id !== entry.id
      || priorBinding.room_id !== entry.room_id
      || priorBinding.work_attempt_id !== ref.work_attempt_id
      || ref.execution_generation_id !== successorExecutionGenerationId
      || handle.workAttemptId !== ref.work_attempt_id
      || handle.providerContinuationId !== ref.provider_continuation_id) {
      throw new Error("Resumed provider does not match the durable worker continuation identity.");
    }
    const attempt = await this.options.durability.getAttempt(ref.work_attempt_id);
    const predecessor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === priorBinding.execution_generation_id,
    );
    const successor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === successorExecutionGenerationId,
    );
    if (!predecessor?.terminal) {
      throw new Error("Worker binding predecessor execution is not durably terminal.");
    }
    if (predecessor.terminal.provider_continuation_id !== ref.provider_continuation_id) {
      throw new Error("Worker binding predecessor belongs to a different provider continuation.");
    }
    if (!successor || successor.terminal
      || attempt.execution_generations.filter((candidate) => candidate.terminal === null).length !== 1) {
      throw new Error("Worker binding successor is not the single live execution generation.");
    }
    const current = await this.options.manifest.getEntry(entry.id);
    if (!current || !this.acceptsLegacyWaitAuthority(current)
      || current.room_id !== entry.room_id
      || current.work_attempt_id !== ref.work_attempt_id
      || current.provider_ref?.execution_generation_id !== successorExecutionGenerationId
      || current.provider_ref.provider_continuation_id !== ref.provider_continuation_id) {
      throw new Error("Provider authority changed before legacy worker-wait staging.");
    }
    this.options.runtimeCustody.installPendingResumeBinding(entry.id, {
      roomId: entry.room_id,
      workAttemptId: ref.work_attempt_id,
      predecessorExecutionGenerationId: priorBinding.execution_generation_id,
      successorExecutionGenerationId,
      agentSessionId: priorBinding.agent_session_id,
      providerContinuationId: ref.provider_continuation_id,
    });
  }

  async restoreWorkerBindingFromWait(
    entryId: string,
    evidence: SupervisedWaitEvidence,
  ): Promise<boolean> {
    const entry = await this.options.manifest.getEntry(entryId);
    if (!entry || !this.acceptsLegacyWaitAuthority(entry)) return false;
    const pending = this.options.runtimeCustody.pendingResumeBinding(entryId);
    if (!pending || evidence.agentSessionId !== pending.agentSessionId) return false;
    const handle = this.liveHandles.get(entryId);
    if (!entry || !handle
      || entry.room_id !== pending.roomId
      || entry.work_attempt_id !== pending.workAttemptId
      || entry.provider_ref?.execution_generation_id !== pending.successorExecutionGenerationId
      || entry.provider_ref.provider_continuation_id !== pending.providerContinuationId
      || handle.workAttemptId !== pending.workAttemptId
      || handle.providerContinuationId !== pending.providerContinuationId) {
      throw new Error("Resumed wait evidence does not match the staged provider continuation.");
    }
    const attempt = await this.options.durability.getAttempt(pending.workAttemptId);
    const predecessor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === pending.predecessorExecutionGenerationId,
    );
    const successor = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === pending.successorExecutionGenerationId,
    );
    if (!predecessor?.terminal) {
      throw new Error("Worker binding predecessor execution is not durably terminal.");
    }
    if (predecessor.terminal.provider_continuation_id !== pending.providerContinuationId) {
      throw new Error("Worker binding predecessor belongs to a different provider continuation.");
    }
    if (!successor || successor.terminal
      || attempt.execution_generations.filter((candidate) => candidate.terminal === null).length !== 1) {
      throw new Error("Worker binding successor is not the single live execution generation.");
    }
    const method = "native_harness.resumed_binding";
    const result = await this.options.bindings.verifyAndAdvanceExecutionGeneration({
      entryId,
      roomId: pending.roomId,
      workAttemptId: pending.workAttemptId,
      fromExecutionGenerationId: pending.predecessorExecutionGenerationId,
      toExecutionGenerationId: pending.successorExecutionGenerationId,
      agentSessionId: pending.agentSessionId,
    }, async ({ binding, sequence, observed_at }) => {
      const credential = await this.options.bindings.credentialFor(binding);
      if (!credential) {
        throw new Error("Worker credential is unavailable until desktop credential delivery.");
      }
      return {
        accepted: await this.publishWorkerActivity({
          apiUrl: binding.api_url,
          roomId: binding.room_id,
          agentSessionId: binding.agent_session_id,
          bearer: credential,
          observedAt: observed_at,
          sequence,
          method,
          status: "working",
          operation: "resumed credential verification",
        }),
      };
    });
    if (!result.accepted) {
      throw new Error("Native activity endpoint rejected the retained worker credential.");
    }
    const verified = result.binding;
    this.options.runtimeCustody.installLiveBinding(entry.id, {
      agentSessionId: verified.agent_session_id,
      executionGenerationId: verified.execution_generation_id,
      updatedAt: verified.updated_at,
    });
    await this.options.manifest.updateEntry(entry.id, (current) => {
      if (!this.acceptsLegacyWaitAuthority(current)
        || current.room_id !== pending.roomId
        || current.work_attempt_id !== pending.workAttemptId
        || current.provider_ref?.execution_generation_id !== pending.successorExecutionGenerationId
        || current.provider_ref.provider_continuation_id !== pending.providerContinuationId) {
        throw new Error("Manifest moved while restoring the resumed worker binding.");
      }
      return {
        ...current,
        observed_state: "working" as const,
        condition: "none" as const,
        last_error: null,
        workplace_liveness: {
          state: "reachable" as const,
          observed_at: verified.updated_at,
          detail: "exact persisted worker session restored after native resume",
        },
        last_worker_binding: {
          agent_session_id: verified.agent_session_id,
          work_attempt_id: verified.work_attempt_id,
          execution_generation_id: verified.execution_generation_id,
          updated_at: verified.updated_at,
        },
      };
    });
    this.options.runtimeCustody.deletePendingResumeBinding(entryId);
    return true;
  }

  async enqueue(
    entryId: string,
    handle: ProviderActionHandle,
    event: ProviderActionStreamEvent,
    executionGenerationId?: string,
  ): Promise<void> {
    const installation = this.currentInstallation(entryId);
    if (!installation || installation.handle !== handle
      || (executionGenerationId && installation.executionGenerationId !== executionGenerationId)) {
      this.markLifecycleProjectionUnavailableForEvent(event);
      return;
    }
    return this.enqueueInstalled(installation, event);
  }

  private async enqueueInstalled(
    installation: ProviderInstallationToken,
    event: ProviderActionStreamEvent,
  ): Promise<void> {
    if (!this.eventMatchesInstallation(event, installation)) {
      this.markLifecycleProjectionUnavailableForEvent(event, true);
      return;
    }
    const entryId = installation.entryId;
    const previous = this.streamQueues.get(entryId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.handleInstalled(installation, event))
      .finally(() => {
        if (this.streamQueues.get(entryId) === next) this.streamQueues.delete(entryId);
      });
    this.streamQueues.set(entryId, next);
    return next;
  }

  /** Direct compatibility seam; installed listeners normally enter via enqueue(). */
  async handle(
    entryId: string,
    handle: ProviderActionHandle,
    event: ProviderActionStreamEvent,
    executionGenerationId?: string,
  ): Promise<void> {
    const installation = this.currentInstallation(entryId);
    if (!installation || installation.handle !== handle
      || (executionGenerationId && installation.executionGenerationId !== executionGenerationId)) {
      this.markLifecycleProjectionUnavailableForEvent(event);
      return;
    }
    return this.handleInstalled(installation, event);
  }

  private async handleInstalled(
    sourceInstallation: ProviderInstallationToken,
    event: ProviderActionStreamEvent,
  ): Promise<void> {
    const installation = this.resolveCurrentInstallation(sourceInstallation, event);
    if (!installation) {
      this.markLifecycleProjectionUnavailableForEvent(event);
      return;
    }
    const { entryId, handle, executionGenerationId } = installation;
    const observedLifecycle = providerStreamLifecycle(event);
    const entry = await this.options.manifest.getEntry(entryId);
    if (!entry || !this.entryMatchesInstallation(entry, installation)
      || !this.isCurrentInstallation(installation)) {
      this.markLifecycleProjectionUnavailableForEvent(event);
      return;
    }
    this.observeLegacyLifecycle(
      entry,
      sourceInstallation,
      installation,
      event,
      observedLifecycle,
      executionGenerationId,
    );
    const daemonInbox = entry.delivery_mode === "daemon_inbox";
    const custodialPolling = !daemonInbox && await this.options.heartbeat.requiresHostGrant(entry);
    const legacyCodexCutover = entry.provider === "codex"
      && (entry.delivery_mode ?? "mcp_polling") === "mcp_polling"
      && !custodialPolling
      && entry.desired_state === "running";
    const effectiveLifecycle = (daemonInbox || custodialPolling || legacyCodexCutover)
      && observedLifecycle === "terminal"
      ? "idle"
      : observedLifecycle;
    const addressedWaitResult = observedLifecycle === "idle"
      && isCorrelatedNonemptyWaitResult(event, entry.activity ?? []);
    const lifecycle = entry.observed_state === "failed"
      ? "failed"
      : addressedWaitResult ? "working" : effectiveLifecycle;
    const sequence = Math.max((entry.activity?.at(-1)?.sequence ?? 0) + 1, event.sequence);
    const quietlyPolling = isSupervisedWaitProviderEvent(event)
      || isSupervisedQuietPollContinuation(event, entry.activity ?? []);
    const status: DaemonActivityEvent["status"] = lifecycle === "failed"
      ? "blocked"
      : lifecycle === "terminal" || quietlyPolling ? "idle" : lifecycle;
    const sanitizedEvent = sanitizeDaemonActivityEvent({
      observed_at: event.observedAt,
      sequence,
      provider: event.provider,
      kind: event.kind,
      method: event.method,
      summary: (event.summary?.trim() || `${event.provider} · ${event.method}`).slice(0, 500),
      status,
      payload: event.payload,
      payload_truncated: event.payloadTruncated,
      payload_redacted: event.payloadRedacted,
      durable_payload_ref: event.durablePayloadRef,
    });
    if (event.provider === "cursor" && event.method === "system/init") {
      this.options.streams.reset(entryId);
    }
    if (isHumanRoomActivityEvent(event)) {
      if (isAgentInspectorLiveDisplayEvent(event)) {
        this.options.streams.push(entryId, sanitizedEvent);
      }
      await this.options.serializeEntry(entryId, async () => {
        if (!this.isCurrentInstallation(installation)) return;
        await this.options.appendActivity(entryId, sanitizedEvent);
      });
      if (!this.isCurrentInstallation(installation)) return;
    }
    const waitEvidence = (entry.delivery_mode ?? "mcp_polling") === "mcp_polling"
      && !custodialPolling
      ? supervisedWaitEvidenceFromProviderEvent(event)
      : null;
    if (waitEvidence) {
      const pending = this.options.runtimeCustody.pendingResumeBinding(entryId);
      if (pending && waitEvidence.agentSessionId === pending.agentSessionId) {
        try {
          await this.options.serializeEntry(
            entryId,
            () => this.restoreWorkerBindingFromWait(entryId, waitEvidence),
          );
        } catch (error) {
          await this.options.serializeEntry(entryId, () => this.options.transition(
            entryId,
            "recovering",
            "coordination_blocked",
            `resumed provider credential verification failed: ${error instanceof Error ? error.message : "unknown credential verification failure"}`,
            "daemon-provider-stream",
          ));
          return;
        }
      }
      if (!this.options.runtimeCustody.hasPendingResumeBinding(entryId)) {
        await this.checkpointObservedWaitCursor(
          entry,
          waitEvidence.roomCursor,
          waitEvidence.agentSessionId,
        );
      }
    }
    if (lifecycle === "failed" && entry.observed_state !== "failed") {
      await this.options.transition(
        entryId,
        "failed",
        entry.condition,
        `provider stream terminal failure: ${sanitizedEvent.method}`,
        "daemon-provider-stream",
      );
    }
    const liveBinding = this.options.runtimeCustody.liveBinding(entryId);
    if (liveBinding?.executionGenerationId === entry.provider_ref?.execution_generation_id) {
      await this.options.publishNativeActivity(
        entryId,
        sanitizedEvent.method,
        lifecycle === "working" && !quietlyPolling ? "working" : "idle",
        event.observedAt,
      ).catch(() => undefined);
    }
    if (legacyCodexCutover && observedLifecycle === "terminal") {
      void this.options.delivery.startCutover(entryId).catch(() => undefined);
    }
    if ((lifecycle === "failed" || lifecycle === "terminal")
      && this.isCurrentInstallation(installation)
      && !["stopping", "stopped"].includes(handle.observedState)) {
      try {
        await this.fenceTerminalInstallationOnce(
          installation,
          `manifest:${entryId}:terminal-turn:${event.sequence}`,
        );
      } catch (error) {
        await this.options.transition(
          entryId,
          "failed",
          "coordination_blocked",
          `failed to fence terminal provider turn: ${error instanceof Error ? error.message : "unknown error"}`,
          "daemon-provider-stream",
        );
      }
    }
  }

  private observeLegacyLifecycle(
    entry: DaemonManifestEntry,
    sourceInstallation: ProviderInstallationToken,
    currentInstallation: ProviderInstallationToken,
    event: ProviderActionStreamEvent, state: "failed" | "terminal" | "idle" | "working",
    executionGenerationId: string | undefined,
  ): void {
    if (!event.nativeEventId || !event.nativeLifecyclePhase || !this.options.observeLegacyLifecycle) return;
    const expectedProvider = entry.provider;
    if (!(expectedProvider === "codex" || expectedProvider === "claude-code" || expectedProvider === "cursor")) return;
    const providerRef = entry.provider_ref;
    // The listener closure owns the generation installed with this handle.
    // A mutable successor manifest must neither relabel nor erase its tail.
    if (entry.provider !== event.provider
      || event.workAttemptId !== sourceInstallation.workAttemptId
      || event.workAttemptId !== currentInstallation.workAttemptId
      || event.workAttemptId !== entry.work_attempt_id || event.workAttemptId !== providerRef?.work_attempt_id
      || !event.providerContinuationId
      || event.providerContinuationId !== sourceInstallation.providerContinuationId
      || providerRef.provider_continuation_id !== currentInstallation.providerContinuationId
      || sourceInstallation.executionGenerationId !== currentInstallation.executionGenerationId
      || !executionGenerationId) {
      this.options.markLifecycleProjectionUnavailable?.(expectedProvider);
      return;
    }
    try {
      this.options.observeLegacyLifecycle({
        agentId: entry.id,
        provider: expectedProvider,
        workAttemptId: event.workAttemptId,
        executionGenerationId,
        nativeEventId: event.nativeEventId,
        phase: event.nativeLifecyclePhase,
        state,
      });
    } catch {
      this.options.markLifecycleProjectionUnavailable?.(expectedProvider);
      // Optional shadow observation never changes provider delivery or lifecycle.
    }
  }

  private eventMatchesInstallation(
    event: ProviderActionStreamEvent,
    installation: ProviderInstallationToken,
  ): boolean {
    if (installation.providerConnection.kind !== "cursor_cli") return true;
    const birth = installation.providerConnection.processIdentity?.trim();
    const pid = installation.providerConnection.pid;
    return Boolean(birth) && pid !== null
      && event.nativeProcessPid === pid
      && event.nativeProcessIdentity === birth;
  }

  /**
   * Cursor adopts its real continuation after emitting system/init. A queued
   * event may therefore carry the prior immutable token, but only the same
   * listener lease and exact PID/birth may advance it to the current token.
   */
  private resolveCurrentInstallation(
    source: ProviderInstallationToken,
    event: ProviderActionStreamEvent,
  ): ProviderInstallationToken | null {
    if (this.isCurrentInstallation(source)) return source;
    const current = this.currentInstallation(source.entryId);
    if (!current
      || source.providerConnection.kind !== "cursor_cli"
      || current.providerConnection.kind !== "cursor_cli"
      || source.listenerLeaseNonce !== current.listenerLeaseNonce
      || source.handle !== current.handle
      || source.executionGenerationId !== current.executionGenerationId
      || source.workAttemptId !== current.workAttemptId
      || source.configurationRevision !== current.configurationRevision
      || source.authorityMode !== current.authorityMode
      || !sameProviderActionConnectionSnapshot(source.providerConnection, current.providerConnection)
      || !this.eventMatchesInstallation(event, source)
      || !this.eventMatchesInstallation(event, current)) return null;
    return current;
  }

  private markLifecycleProjectionUnavailableForEvent(
    event: ProviderActionStreamEvent,
    exactCursorBirthMissing = false,
  ): void {
    if (exactCursorBirthMissing && event.provider === "cursor") {
      this.options.markLifecycleProjectionUnavailable?.("cursor");
      return;
    }
    if (!event.nativeEventId || !event.nativeLifecyclePhase) return;
    if (!(event.provider === "codex" || event.provider === "claude-code" || event.provider === "cursor")) return;
    this.options.markLifecycleProjectionUnavailable?.(event.provider);
  }

  async checkpointObservedWaitCursor(
    entry: DaemonManifestEntry,
    roomCursor: string,
    agentSessionId: string,
  ): Promise<void> {
    if (!this.acceptsLegacyWaitAuthority(entry)) return;
    await this.options.serializeEntry(entry.id, () => this.serializeCursorCheckpoint(entry.id, async () => {
      const executionGenerationId = entry.provider_ref?.execution_generation_id;
      if (!entry.work_attempt_id || !executionGenerationId) return;
      const currentEntry = await this.options.manifest.getEntry(entry.id);
      if (!currentEntry
        || !this.acceptsLegacyWaitAuthority(currentEntry)
        || currentEntry.room_id !== entry.room_id
        || currentEntry.work_attempt_id !== entry.work_attempt_id
        || currentEntry.provider_ref?.execution_generation_id !== executionGenerationId) return;
      const binding = await this.options.bindings.get(entry.id);
      if (!binding
        || binding.entry_id !== entry.id
        || binding.room_id !== entry.room_id
        || binding.work_attempt_id !== entry.work_attempt_id
        || binding.agent_session_id !== agentSessionId
        || binding.execution_generation_id !== executionGenerationId) return;
      const checkpoint = await this.options.bindings.checkpointCursorMonotonic(
        entry.id,
        binding.agent_session_id,
        executionGenerationId,
        roomCursor,
      );
      const durableAttempt = await this.options.durability.getAttempt(entry.work_attempt_id);
      const durableCursor = checkpoint.binding.room_cursor;
      if (!durableCursor
        || (!checkpoint.advanced
          && durableAttempt.checkpoints.at(-1)?.room_cursor === durableCursor)) return;
      await this.options.durability.checkpoint(entry.work_attempt_id, {
        room_cursor: durableCursor,
        provider_continuation_id: entry.provider_ref?.provider_continuation_id ?? null,
      });
    }));
  }

  /** Shared compatibility lane for worker RPC and provider-stream cursor commits. */
  serializeCursorCheckpoint<T>(
    entryId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.cursorCheckpointQueues.get(entryId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined).finally(() => {
      if (this.cursorCheckpointQueues.get(entryId) === tail) {
        this.cursorCheckpointQueues.delete(entryId);
      }
    });
    this.cursorCheckpointQueues.set(entryId, tail);
    return result;
  }

  fenceTerminalOnce(handle: ProviderActionHandle, actionId: string): Promise<void> {
    const installation = [...this.latestInstallations.values()].find((candidate) =>
      candidate.handle === handle && this.isCurrentInstallation(candidate));
    if (!installation) return Promise.reject(new Error("Provider installation is unavailable."));
    return this.fenceTerminalInstallationOnce(installation, actionId);
  }

  private fenceTerminalInstallationOnce(
    installation: ProviderInstallationToken,
    actionId: string,
  ): Promise<void> {
    const existing = this.terminalFenceRequests.get(installation);
    if (existing) return existing;
    const provider = this.options.provider;
    const operation = provider
      ? provider.stop(installation.handle, { actionId }).then(() => undefined)
      : Promise.reject(new Error("Provider action port is unavailable"));
    this.terminalFenceRequests.set(installation, operation);
    return operation;
  }

  track(operation: Promise<void>): void {
    this.callbacks.add(operation);
    void operation.finally(() => this.callbacks.delete(operation));
  }

  async drainCallbacks(): Promise<void> {
    await Promise.all([...this.callbacks]);
  }

  async disposeAll(): Promise<void> {
    this.latestInstallations.clear();
    const failures = this.disposeEveryListener();
    try { await this.drainCallbacks(); } catch (error) { failures.push(error); }
    this.throwCleanupFailures(failures, "Provider stream disposal failed.");
  }

  /** Handoff drops local observers without waiting on generation-fenced callbacks. */
  detachAll(): void {
    this.latestInstallations.clear();
    const failures = this.disposeEveryListener();
    this.callbacks.clear();
    this.throwCleanupFailures(failures, "Provider stream handoff cleanup failed.");
  }

  private disposeEntryListeners(entryId: string): unknown[] {
    const disposers = this.listenerLeases.get(entryId)?.disposers ?? [];
    this.listenerLeases.delete(entryId);
    const failures: unknown[] = [];
    for (const dispose of disposers) {
      try { dispose(); } catch (error) { failures.push(error); }
    }
    return failures;
  }

  private disposeEveryListener(): unknown[] {
    const failures: unknown[] = [];
    for (const entryId of [...this.listenerLeases.keys()]) {
      failures.push(...this.disposeEntryListeners(entryId));
    }
    return failures;
  }

  private throwCleanupFailures(failures: unknown[], message: string): void {
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, message);
  }
}
