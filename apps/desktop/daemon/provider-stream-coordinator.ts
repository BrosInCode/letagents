import { publishWorkerNativeActivity } from "./cloud-http.js";
import { sanitizeDaemonActivityEvent } from "./credential-redaction.js";
import type { WorkDurabilityStore } from "./durability-store.js";
import type {
  ProviderActionHandle,
  ProviderActionPort,
  ProviderActionStreamEvent,
  ProviderActionTerminal,
} from "./provider-action-port.js";
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
  observeExecution?(entryId: string, handle: ProviderActionHandle, executionGenerationId: string): () => void;
  /** Raw legacy-classifier witness. This is comparison evidence, never lifecycle authority. */
  observeLegacyLifecycle?(observation: LifecycleProjectionObservation): void;
  markLifecycleProjectionUnavailable?(provider: LifecycleProjectionProvider): void;
  lifecycleProjectionDiagnostics?(): LifecycleProjectionDiagnostics;
  captureAdmission?(entryId: string, handle: ProviderActionHandle, executionGenerationId: string): LifecycleCaptureAdmissionStatus;
  /** Operational approvals have their own lifetime, independent of optional capture. */
  observePermissions?: (entryId: string, handle: ProviderActionHandle, generation: string) => () => void;
  manifest: ProviderStreamManifest;
  bindings: ProviderStreamBindings;
  durability: ProviderStreamDurability;
  runtimeCustody: ProviderStreamRuntimeCustody;
  serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  transition: ProviderStreamTransition;
  appendActivity(entryId: string, event: DaemonActivityEvent): Promise<unknown>;
  publishNativeActivity(
    entryId: string,
    method: string,
    status: "working" | "idle",
    observedAt?: string,
  ): Promise<unknown>;
  handleTerminal(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
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

  private readonly liveDisposers = new Map<string, Array<() => void>>();
  private readonly streamQueues = new Map<string, Promise<void>>();
  private readonly cursorCheckpointQueues = new Map<string, Promise<void>>();
  private readonly callbacks = new Set<Promise<void>>();
  private readonly terminalFenceRequests = new WeakMap<ProviderActionHandle, Promise<void>>();
  private readonly installedExecutionGenerations = new WeakMap<ProviderActionHandle, string>();
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
      const generation = this.installedExecutionGenerations.get(handle);
      let current: LifecycleCaptureAdmissionStatus = "unavailable";
      if (generation && this.options.captureAdmission) {
        try { current = this.options.captureAdmission(entryId, handle, generation); }
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

  /** Remove only the expected generation and dispose every listener it owns. */
  remove(entryId: string, expectedHandle?: ProviderActionHandle): boolean {
    const current = this.liveHandles.get(entryId);
    if (!current || (expectedHandle && current !== expectedHandle)) return false;
    this.liveHandles.delete(entryId);
    this.options.runtimeCustody.deleteLiveBinding(entryId);
    const failures = this.disposeEntryListeners(entryId);
    this.throwCleanupFailures(failures, `Provider stream cleanup failed for ${entryId}.`);
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
    const replacementCleanupFailures = this.disposeEntryListeners(entryId);
    this.throwCleanupFailures(
      replacementCleanupFailures,
      `Provider stream replacement cleanup failed for ${entryId}.`,
    );
    this.options.streams.reset(entryId);
    this.liveHandles.set(entryId, handle);
    this.installedExecutionGenerations.set(handle, executionGenerationId);
    const disposePermissions = this.options.observePermissions?.(entryId, handle, executionGenerationId) ?? (() => {});
    let disposeExecution = () => {};
    try { disposeExecution = this.options.observeExecution?.(entryId, handle, executionGenerationId) ?? disposeExecution; }
    catch { /* optional observation must not reject provider installation */ }
    const disposeCapture = () => { try { disposeExecution(); } catch { /* observation owns no execution authority */ } };
    this.liveDisposers.set(entryId, [disposeCapture, disposePermissions]);
    const binding = await this.options.bindings.get(entryId);
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
      const bindingIdentity = this.options.runtimeCustody.liveBinding(entryId);
      this.track(this.options.handleTerminal(
        entryId,
        handle,
        executionGenerationId,
        bindingIdentity,
        terminal,
      ));
    });
    const disposeStream = provider.onStream
      ? await provider.onStream(handle, (event) => {
          this.track(this.enqueue(entryId, handle, event, executionGenerationId));
        })
      : () => {};
    const heartbeat = this.setHeartbeat(() => {
      const current = this.liveHandles.get(entryId);
      if (!current) return;
      this.track((async () => {
        const manifestEntry = await this.options.manifest.getEntry(entryId);
        if (!manifestEntry || this.liveHandles.get(entryId) !== current) return;
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
          if (this.liveHandles.get(entryId) !== current
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
    this.liveDisposers.set(entryId, [
      disposeExit,
      disposeStream,
      disposeCapture,
      disposePermissions,
      () => this.clearHeartbeat(heartbeat),
      () => this.options.streams.end(entryId),
    ]);
    if (mayStartDelivery()) void this.options.delivery.start(entryId).catch(() => undefined);
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
    executionGenerationId: string | undefined = this.installedExecutionGenerations.get(handle),
  ): Promise<void> {
    const previous = this.streamQueues.get(entryId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.handle(entryId, handle, event, executionGenerationId))
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
    executionGenerationId: string | undefined = this.installedExecutionGenerations.get(handle),
  ): Promise<void> {
    const observedLifecycle = providerStreamLifecycle(event);
    if (this.liveHandles.get(entryId) !== handle) {
      this.markLifecycleProjectionUnavailableForEvent(event);
      return;
    }
    const entry = await this.options.manifest.getEntry(entryId);
    if (!entry) {
      this.markLifecycleProjectionUnavailableForEvent(event);
      return;
    }
    this.observeLegacyLifecycle(entry, handle, event, observedLifecycle, executionGenerationId);
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
      await this.options.appendActivity(entryId, sanitizedEvent);
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
      && this.liveHandles.get(entryId) === handle
      && !["stopping", "stopped"].includes(handle.observedState)) {
      try {
        await this.fenceTerminalOnce(
          handle,
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

  private observeLegacyLifecycle(entry: DaemonManifestEntry, handle: ProviderActionHandle,
    event: ProviderActionStreamEvent, state: "failed" | "terminal" | "idle" | "working",
    executionGenerationId: string | undefined): void {
    if (!event.nativeEventId || !event.nativeLifecyclePhase || !this.options.observeLegacyLifecycle) return;
    const expectedProvider = entry.provider;
    if (!(expectedProvider === "codex" || expectedProvider === "claude-code" || expectedProvider === "cursor")) return;
    const providerRef = entry.provider_ref;
    // The listener closure owns the generation installed with this handle.
    // A mutable successor manifest must neither relabel nor erase its tail.
    if (entry.provider !== event.provider || event.workAttemptId !== handle.workAttemptId
      || event.workAttemptId !== entry.work_attempt_id || event.workAttemptId !== providerRef?.work_attempt_id
      || !event.providerContinuationId || event.providerContinuationId !== handle.providerContinuationId
      || event.providerContinuationId !== providerRef.provider_continuation_id
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

  private markLifecycleProjectionUnavailableForEvent(event: ProviderActionStreamEvent): void {
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
    const existing = this.terminalFenceRequests.get(handle);
    if (existing) return existing;
    const provider = this.options.provider;
    const operation = provider
      ? provider.stop(handle, { actionId }).then(() => undefined)
      : Promise.reject(new Error("Provider action port is unavailable"));
    this.terminalFenceRequests.set(handle, operation);
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
    const failures = this.disposeEveryListener();
    try { await this.drainCallbacks(); } catch (error) { failures.push(error); }
    this.throwCleanupFailures(failures, "Provider stream disposal failed.");
  }

  /** Handoff drops local observers without waiting on generation-fenced callbacks. */
  detachAll(): void {
    const failures = this.disposeEveryListener();
    this.callbacks.clear();
    this.throwCleanupFailures(failures, "Provider stream handoff cleanup failed.");
  }

  private disposeEntryListeners(entryId: string): unknown[] {
    const disposers = this.liveDisposers.get(entryId) ?? [];
    this.liveDisposers.delete(entryId);
    const failures: unknown[] = [];
    for (const dispose of disposers) {
      try { dispose(); } catch (error) { failures.push(error); }
    }
    return failures;
  }

  private disposeEveryListener(): unknown[] {
    const failures: unknown[] = [];
    for (const entryId of [...this.liveDisposers.keys()]) {
      failures.push(...this.disposeEntryListeners(entryId));
    }
    return failures;
  }

  private throwCleanupFailures(failures: unknown[], message: string): void {
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, message);
  }
}
