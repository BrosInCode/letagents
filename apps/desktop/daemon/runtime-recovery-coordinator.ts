import type { SupervisorGrantHttp } from "./cloud-http.js";
import type { WorkDurabilityStore } from "./durability-store.js";
import type { ManifestStore } from "./manifest-store.js";
import {
  sameProviderActionConnectionSnapshot,
  validatedNativeRuntimeDeath,
  type ProviderActionAttachTerminal,
  type ProviderActionHandle,
  type ProviderActionPort,
  type ProviderActionRef,
  type ProviderActionTerminal,
} from "./provider-action-port.js";
import { isIdleCursorConnection } from "./provider-state-policy.js";
import type { ProviderStreamCoordinator } from "./provider-stream-coordinator.js";
import { advanceReconciliationState, rememberCompletedControlAction } from "./reconciler-state.js";
import type { SupervisedAgentDelivery } from "./supervised-agent-delivery.js";
import type { SupervisedAgentInboxStore } from "./supervised-agent-inbox-store.js";
import type {
  DaemonManifestEntry,
  DaemonManifestEntryView,
  ExecutionTerminalPayload,
} from "./types.js";
import type { WorkerAuthorityCoordinator } from "./worker-authority-coordinator.js";
import type { WorkerBindingStore } from "./worker-binding-store.js";
import type { WorkerRuntimeCustody } from "./worker-runtime-custody.js";
import { assertRecoveryCoordinates, type RuntimeRestartRequest } from "./runtime-recovery-journal.js";
import type { ProviderTerminalCoordinator } from "./provider-terminal-coordinator.js";
import { processBirthState, type ProcessIdentity } from "./process-identity.js";
import { serializeDaemonDeploymentId } from "./manifest-entry-projection.js";

export type AgentRuntimeRecoveryRequest = Omit<RuntimeRestartRequest, "entryId" | "mode"> & { mode: "reconnect" | "resume" | "fresh" };

type RuntimeRecoveryAuthority = {
  currentDaemonGeneration: () => number;
  currentManifestGeneration: () => number;
  acceptManifestGeneration: (generation: number) => void;
  isHandoffScheduled: () => boolean;
  assertCurrent: () => Promise<void>;
  serializeManifest: <T>(operation: () => Promise<T>) => Promise<T>;
  fenceCommit: (commit: () => Promise<void>) => Promise<void>;
};

export type RuntimeRecoveryCoordinatorOptions = {
  settleRuntimeApprovals: (entryId: string) => Promise<void>;
  store: ManifestStore;
  durability: WorkDurabilityStore;
  inbox: SupervisedAgentInboxStore;
  bindings: WorkerBindingStore;
  workerAuthority: WorkerAuthorityCoordinator;
  runtimeCustody: WorkerRuntimeCustody;
  delivery: SupervisedAgentDelivery | null;
  supervisorGrantHttp: SupervisorGrantHttp;
  provider?: ProviderActionPort;
  streams: Pick<ProviderStreamCoordinator, "currentInstallation" | "install" | "remove">;
  terminals?: Pick<ProviderTerminalCoordinator, "handleTerminal">;
  restartDelivery?: (entryId: string) => Promise<void>;
  releaseRecoveredObservation?: (entryId: string, runtimeId: string, stoppedCursorGeneration?: string) => void;
  processIdentity?: ProcessIdentity;
  liveHandles: Map<string, ProviderActionHandle>;
  authority: RuntimeRecoveryAuthority;
  beginLifecycle: (entryId: string) => () => void;
  bumpControlEpoch: (entryId: string) => number;
  clearRecovery: (entryId: string) => void;
  serializeEntry: <T>(entryId: string, operation: () => Promise<T>) => Promise<T>;
  updateEntry: (
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
    roomMoveCancellation?: { agentId: string; detail: string },
  ) => Promise<DaemonManifestEntry>;
  requestConvergence: (entryId: string) => void;
  entryWithDerivedLiveness: (entry: DaemonManifestEntry) => Promise<DaemonManifestEntryView>;
  nowMs: () => number;
};

/**
 * Owns restart recovery for turn-control journals and explicit replacement of
 * provider runtimes that are durably proven terminal.
 */
export class RuntimeRecoveryCoordinator {
  private readonly store: ManifestStore;
  private readonly durability: WorkDurabilityStore;
  private readonly inbox: SupervisedAgentInboxStore;
  private readonly bindings: WorkerBindingStore;
  private readonly workerAuthority: WorkerAuthorityCoordinator;
  private readonly runtimeCustody: WorkerRuntimeCustody;
  private readonly delivery: SupervisedAgentDelivery | null;
  private readonly supervisorGrantHttp: SupervisorGrantHttp;
  private readonly provider?: ProviderActionPort;
  private readonly liveHandles: Map<string, ProviderActionHandle>;
  private readonly streams: RuntimeRecoveryCoordinatorOptions["streams"];
  private readonly authority: RuntimeRecoveryAuthority;
  private readonly beginLifecycle: RuntimeRecoveryCoordinatorOptions["beginLifecycle"];
  private readonly bumpControlEpoch: RuntimeRecoveryCoordinatorOptions["bumpControlEpoch"];
  private readonly clearRecovery: RuntimeRecoveryCoordinatorOptions["clearRecovery"];
  private readonly serializeEntry: RuntimeRecoveryCoordinatorOptions["serializeEntry"];
  private readonly updateEntry: RuntimeRecoveryCoordinatorOptions["updateEntry"];
  private readonly requestConvergence: RuntimeRecoveryCoordinatorOptions["requestConvergence"];
  private readonly entryWithDerivedLiveness: RuntimeRecoveryCoordinatorOptions["entryWithDerivedLiveness"];
  private readonly nowMs: () => number;

  constructor(private readonly options: RuntimeRecoveryCoordinatorOptions) {
    this.store = options.store;
    this.durability = options.durability;
    this.inbox = options.inbox;
    this.bindings = options.bindings;
    this.workerAuthority = options.workerAuthority;
    this.runtimeCustody = options.runtimeCustody;
    this.delivery = options.delivery;
    this.supervisorGrantHttp = options.supervisorGrantHttp;
    this.provider = options.provider;
    this.liveHandles = options.liveHandles;
    this.streams = options.streams;
    this.authority = options.authority;
    this.beginLifecycle = options.beginLifecycle;
    this.bumpControlEpoch = options.bumpControlEpoch;
    this.clearRecovery = options.clearRecovery;
    this.serializeEntry = options.serializeEntry;
    this.updateEntry = options.updateEntry;
    this.requestConvergence = options.requestConvergence;
    this.entryWithDerivedLiveness = options.entryWithDerivedLiveness;
    this.nowMs = options.nowMs;
  }

  async recoverTurnControls(): Promise<void> {
    await this.authority.serializeManifest(async () => {
      const manifest = await this.store.load();
      const recoveredAt = new Date().toISOString();
      let changed = false;
      const entries: DaemonManifestEntry[] = [];
      for (const entry of manifest.entries) {
        const control = entry.turn_control;
        if (!control || control.status === "completed") {
          entries.push(entry);
          continue;
        }

        let correctionText = control.correction_text?.trim() || null;
        let correctionStrategy = control.correction_strategy ?? null;
        let exactLegacyCorrectionApplied = false;
        // The predecessor implementation could enqueue the correction before
        // it checkpointed the journal payload. That exact, action-derived row
        // is trustworthy recovery evidence; arbitrary room text is not.
        if (entry.delivery_mode === "daemon_inbox" && control.has_correction) {
          const legacyCorrection = await this.inbox.getBySourceMessage(
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
            // The deterministic predecessor row exists only after native Stop
            // and A settlement. It is completion evidence, not work to replay.
            exactLegacyCorrectionApplied = true;
          }
        }
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
        if (!controlChanged) {
          entries.push(entry);
          continue;
        }
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
            state: exactLegacyCorrectionApplied || retireWithoutClaimingEffect
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
      const next = await this.store.write(
        this.authority.currentManifestGeneration(),
        entries,
        manifest.legacy_lane_owners,
        (commit) => this.authority.fenceCommit(commit),
      );
      this.authority.acceptManifestGeneration(next.generation);
    });
  }

  async completeTurnControl(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
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
    const checkpoint = await this.authority.serializeManifest(async () => {
      await this.authority.assertCurrent();
      const committed = await this.store.commitTurnControlState(
        this.authority.currentManifestGeneration(),
        {
          agentId: entry.id,
          roomId: entry.room_id,
          actionId: control.action_id,
          workAttemptId: control.work_attempt_id,
          executionGenerationId: control.execution_generation_id,
          mode: "runtime_recovered",
          settleOriginal: Boolean(control.inbox_item_id),
          activateCorrection: control.correction_strategy === "stop_then_resend",
          observedAt,
        },
        (current, outcome) => ({
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
        }),
        (commit) => this.authority.fenceCommit(commit),
      );
      this.authority.acceptManifestGeneration(committed.generation);
      return committed;
    });
    return checkpoint.entry;
  }

  async recoverAgentRuntime(entryId: string, daemonGeneration: number, recovery?: AgentRuntimeRecoveryRequest) {
    const release = this.beginLifecycle(entryId);
    try {
      if (recovery) return await this.repairRuntime(entryId, daemonGeneration, recovery);
      return await this.recoverAgentRuntimeExclusive(entryId, daemonGeneration);
    } finally {
      release();
      if (recovery) {
        this.requestConvergence(entryId);
        void this.options.restartDelivery?.(entryId).catch(() => undefined);
      }
    }
  }

  private async repairRuntime(entryId: string, daemonGeneration: number, input: AgentRuntimeRecoveryRequest) {
    const assertAuthority = async () => {
      await this.authority.assertCurrent();
      if (daemonGeneration !== this.authority.currentDaemonGeneration() || this.authority.isHandoffScheduled()) {
        throw new Error("Runtime recovery lost daemon authority. Refresh checks and retry.");
      }
    };
    await assertAuthority();
    this.bumpControlEpoch(entryId);
    this.clearRecovery(entryId);
    const request = { ...input, entryId, mode: input.mode === "fresh" ? "fresh" as const : "resume" as const };
    const recorded = input.mode === "reconnect" ? null : await this.store.getRuntimeRecovery(input.operationId);
    if (recorded?.phase === "complete") {
      if (recorded.agent_id !== entryId || recorded.room_id !== input.roomId || recorded.mode !== input.mode
        || recorded.execution_generation_id !== input.executionGenerationId || recorded.runtime_generation_id !== input.runtimeGenerationId) {
        throw new Error("The recovery operation ID belongs to a different request.");
      }
      const entry = await this.store.getEntry(entryId);
      if (!entry) throw new Error("This agent is no longer available.");
      return { outcome: "recovering", entry: await this.entryWithDerivedLiveness(entry) };
    }
    let entry = await this.store.getEntry(entryId);
    const pending = await this.store.pendingRuntimeRecovery(entryId);
    if (pending?.phase !== "stopped") assertRecoveryCoordinates(entry, request);
    if (!entry || entry.delivery_mode !== "daemon_inbox" || entry.desired_state === "stopped") {
      throw new Error("Recovery is available for saved supervised agents.");
    }
    if (input.mode === "reconnect") {
      if (pending) throw new Error("A restart is paused partway through. Retry its original recovery action.");
      if (entry.desired_state !== "running" || !this.options.streams || !this.delivery) throw new Error("Resume this agent before reconnecting it.");
      const installation = this.options.streams.currentInstallation(entryId);
      if (!installation || installation.executionGenerationId !== input.executionGenerationId) {
        throw new Error("The saved runtime is no longer attached. Use Restart and resume.");
      }
      if (!await this.delivery.stopIfIdle(entryId)) throw new Error("The agent has an active turn. Wait for it to finish, or restart it to interrupt the turn.");
      await this.serializeEntry(entryId, async () => {
        await assertAuthority();
        assertRecoveryCoordinates(await this.store.getEntry(entryId), request);
        await this.options.streams!.install(entryId, installation.handle, input.executionGenerationId, () => false);
      });
      return { outcome: "reconnecting", entry: await this.entryWithDerivedLiveness((await this.store.getEntry(entryId))!) };
    }
    if (!this.provider) throw new Error("Provider recovery is unavailable.");
    const capabilities = await this.provider.capabilities(entry.work_attempt_id!, entry.provider);
    if (input.mode === "resume" && !capabilities.resume) {
      throw new Error("This provider cannot resume a saved conversation. Use Start fresh to keep the workspace and open a new conversation.");
    }
    const preflightRef = pending ? JSON.parse(pending.provider_ref_json) as NonNullable<DaemonManifestEntry["provider_ref"]> : entry.provider_ref!;
    const preflightBirth = processBirthState(preflightRef.provider_connection?.pid ?? null,
      preflightRef.provider_connection?.processIdentity ?? null, this.options.processIdentity);
    if (pending?.phase !== "stopped") {
      if (preflightBirth === "unknown") throw new Error("The saved process identity cannot be verified. Refresh checks before restarting it.");
      if (preflightBirth === "live" && (!capabilities.exactProcessStop || !this.provider.stopRef)) {
        throw new Error("This provider does not yet support stopping an unreachable runtime safely. Stop it in its provider app, then retry recovery.");
      }
    }
    const record = await this.serializeEntry(entryId, () => this.authority.serializeManifest(async () => {
      await assertAuthority();
      const prepared = await this.store.prepareRuntimeRecovery(this.authority.currentManifestGeneration(), request,
        commit => this.authority.fenceCommit(commit));
      this.authority.acceptManifestGeneration(prepared.generation);
      return prepared.record;
    }));
    const savedRef = JSON.parse(record.provider_ref_json) as NonNullable<DaemonManifestEntry["provider_ref"]>;
    const exactRef: ProviderActionRef = { workAttemptId: savedRef.work_attempt_id, provider: entry.provider,
      providerContinuationId: savedRef.provider_continuation_id, providerConnection: savedRef.provider_connection };
    const birthState = () => processBirthState(savedRef.provider_connection?.pid ?? null,
      savedRef.provider_connection?.processIdentity ?? null, this.options.processIdentity);
    if (record.phase === "prepared") {
      if (birthState() === "unknown") throw new Error("The saved process identity cannot be verified. Recovery is paused; no replacement will start until ownership is confirmed.");
      // Cancel ingress first; do not hold the entry lock while joining callbacks.
      // Stopping the process also releases a provider turn that cannot respond.
      const deliveryStopped = this.delivery?.stop(entryId) ?? Promise.resolve();
      void deliveryStopped.catch(() => undefined);
      await assertAuthority();
      assertRecoveryCoordinates(await this.store.getEntry(entryId), request);
      const installation = this.options.streams?.currentInstallation(entryId);
      const currentBirth = birthState();
      if (currentBirth === "unknown") throw new Error("The saved process identity changed before stopping. Recovery remains paused.");
      const terminal: ProviderActionTerminal = currentBirth === "gone"
        ? { endedAt: new Date(this.nowMs()).toISOString(), exitCode: null, signal: null, terminalCause: "stopped", providerContinuationId: savedRef.provider_continuation_id,
            ...((savedRef.provider_connection?.kind === "claude_cli" || savedRef.provider_connection?.kind === "codex_app_server")
              ? { nativeRuntimeDeath: { kind: savedRef.provider_connection.kind, pid: savedRef.provider_connection.pid!,
                  processIdentity: savedRef.provider_connection.processIdentity! } } : {}) }
        : await this.provider.stopRef!(exactRef, { force: true, graceMs: 5_000, actionId: record.operation_id });
      if (terminal.providerContinuationId && terminal.providerContinuationId !== savedRef.provider_continuation_id) {
        throw new Error("The stop result belongs to a different conversation. Recovery remains paused.");
      }
      if (birthState() !== "gone") throw new Error("The old process has not been proven stopped. Recovery remains paused; no replacement was started.");
      if (installation) await this.options.terminals?.handleTerminal(installation, terminal);
      await boundedRecoveryWait(deliveryStopped);
      await this.serializeEntry(entryId, async () => {
        await assertAuthority();
        assertRecoveryCoordinates(await this.store.getEntry(entryId), request);
        const attempt = await this.durability.getAttempt(savedRef.work_attempt_id);
        const execution = attempt.execution_generations.find(value => value.execution_generation_id === savedRef.execution_generation_id);
        if (!execution) throw new Error("The original execution record is missing. Recovery remains paused.");
        if (!execution.terminal) await this.durability.recordTerminal(savedRef.work_attempt_id, savedRef.execution_generation_id,
          terminalPayload(terminal, execution.actor, execution.generation, savedRef.provider_connection));
        await this.options.settleRuntimeApprovals(entryId);
        await this.durability.releaseTerminalExecutionFence(savedRef.work_attempt_id, savedRef.execution_generation_id);
        await this.store.checkpointRuntimeStopped(record.operation_id, commit => this.authority.fenceCommit(async () => {
          // The durable boundary requires current host proof, not a cached terminal.
          if (birthState() !== "gone") throw new Error("The old process has not been proven stopped. Recovery remains paused; no replacement was started.");
          await commit();
        }));
      });
    }
    await this.options.settleRuntimeApprovals(entryId);
    this.options.releaseRecoveredObservation?.(entryId, record.runtime_generation_id);
    entry = await this.serializeEntry(entryId, async () => {
      await assertAuthority();
      const current = await this.store.getEntry(entryId);
      if (!current || current.room_id !== record.room_id || current.work_attempt_id !== savedRef.work_attempt_id) {
        throw new Error("The agent moved during recovery. No replacement was started.");
      }
      const binding = await this.bindings.get(entryId);
      if (binding && binding.execution_generation_id !== record.execution_generation_id) throw new Error("A different worker binding is present. Recovery remains paused.");
      const sessionId = binding?.agent_session_id ?? current.last_worker_binding?.agent_session_id;
      if (sessionId) {
        const grant = this.workerAuthority.currentHostGrant(current);
        if (!grant || !this.supervisorGrantHttp.endWorkerSession) throw new Error("Desktop credentials are needed to finish recovery. Reconnect the desktop and retry.");
        await this.supervisorGrantHttp.endWorkerSession({ apiUrl: grant.apiUrl, grantId: grant.grantId,
          supervisorGrant: grant.supervisorGrant, grantGeneration: grant.grantGeneration, sessionId });
      }
      await assertAuthority();
      if (binding) await this.bindings.unbind(entryId, binding.agent_session_id, binding.execution_generation_id);
      this.runtimeCustody.deleteLiveBinding(entryId);
      this.runtimeCustody.deletePendingResumeBinding(entryId);
      this.runtimeCustody.deleteWorkerAuthorization(entryId);
      const updated = await this.updateEntry(entryId, currentEntry => ({ ...currentEntry,
        desired_state: "running", observed_state: "recovering", condition: "none", last_error: null,
        run_id: input.mode === "resume" ? savedRef.execution_generation_id : null,
        deployment_id: input.mode === "resume" ? serializeDaemonDeploymentId(entryId, savedRef.execution_generation_id) : null,
        last_worker_binding: null,
        provider_ref: input.mode === "resume" ? savedRef : null,
        native_liveness: { state: "unknown", observed_at: new Date(this.nowMs()).toISOString(),
          detail: input.mode === "resume" ? "Restarting the saved conversation." : "Starting a new conversation in the existing workspace." },
      }));
      await this.store.completeRuntimeRecovery(record.operation_id, commit => this.authority.fenceCommit(commit));
      return updated;
    });
    return { outcome: "recovering", entry: await this.entryWithDerivedLiveness(entry) };
  }

  private async recoverAgentRuntimeExclusive(entryId: string, daemonGeneration: number) {
    if (await this.store.pendingRuntimeRecovery(entryId)) throw new Error("Continue the recorded recovery action in Diagnostics.");
    if (!entryId || daemonGeneration !== this.authority.currentDaemonGeneration()) {
      throw new Error("Agent runtime recovery is fenced by a stale daemon generation.");
    }
    this.bumpControlEpoch(entryId);
    this.clearRecovery(entryId);
    const updated = await this.serializeEntry(entryId, async () => {
      await this.authority.assertCurrent();
      if (daemonGeneration !== this.authority.currentDaemonGeneration() || this.authority.isHandoffScheduled()) {
        throw new Error("Agent runtime recovery lost daemon authority.");
      }
      let entry = await this.store.getEntry(entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      if (entry.desired_state === "stopped") {
        throw new Error("A stopped agent must be resumed before its runtime can be recovered.");
      }
      const handle = this.liveHandles.get(entryId);
      const installation = this.streams.currentInstallation(entryId);
      const head = entry.provider === "cursor" && entry.delivery_mode === "daemon_inbox"
        ? await this.inbox.head(entryId)
        : null;
      const recoverIdleCursor = Boolean(handle
        && installation?.handle === handle
        && installation.executionGenerationId === entry.provider_ref?.execution_generation_id
        && head?.room_id === entry.room_id && head.state === "blocked"
        && handle.observedState === "idle" && handle.pid === null
        && handle.workAttemptId === entry.work_attempt_id
        && handle.providerContinuationId === entry.provider_ref?.provider_continuation_id
        && isIdleCursorConnection(entry.provider_ref?.provider_connection)
        && isIdleCursorConnection(handle.providerConnection)
        && sameProviderActionConnectionSnapshot(entry.provider_ref?.provider_connection, handle.providerConnection));
      if (handle && !recoverIdleCursor) {
        throw new Error("The provider runtime is still connected. Reconnect its credentials instead.");
      }
      const pendingRoomMoves = await this.store.pendingRoomMoves(entryId);
      if (pendingRoomMoves.length > 1) {
        throw new Error("Runtime recovery found more than one nonterminal room move for this agent.");
      }
      if (pendingRoomMoves.some((move) => !["prepared", "waiting_for_current_turn"].includes(move.phase))) {
        throw new Error("Agent runtime recovery is blocked while a room move may have changed destination membership.");
      }

      const ref = entry.provider_ref ?? null;
      let interruptedDelivery: Parameters<ManifestStore["replaceEntry"]>[4];
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
        if (head?.room_id === entry.room_id && head.state === "blocked"
          && head.provider_turn_id && !head.outcome) {
          const turn = await this.inbox.providerTurnBinding(head.inbox_item_id);
          const origin = turn && attempt.execution_generations.find((candidate) =>
            candidate.execution_generation_id === turn.origin_execution_generation_id);
          if (!turn || turn.agent_id !== entryId || turn.room_id !== entry.room_id
            || turn.work_attempt_id !== ref.work_attempt_id
            || turn.provider_continuation_id !== ref.provider_continuation_id
            || turn.provider_turn_id !== head.provider_turn_id
            || !origin || (!origin.terminal && origin.execution_generation_id !== execution.execution_generation_id)) {
            throw new Error("Runtime recovery cannot settle a blocked turn without its exact provider authority.");
          }
          interruptedDelivery = { turn,
            detail: `Stopped the failed turn during runtime recovery. ${head.last_error ?? ""}`.trim(),
            observedAt: new Date(this.nowMs()).toISOString() };
        }
        // Cursor's between-turn handle is a lane, not a connected process.
        // A blocked FIFO proves no new turn may dispatch. Stop that exact
        // lane before retiring its worker; never infer death from PID absence.
        if (recoverIdleCursor) {
          if (!this.provider) throw new Error("Provider recovery is unavailable.");
          await this.delivery?.stop(entryId);
          const terminal = await this.provider.stop(handle!);
          if (terminal.providerContinuationId !== ref.provider_continuation_id) {
            throw new Error("Provider recovery returned terminal evidence for a different continuation.");
          }
          if (!execution.terminal) {
            await this.durability.recordTerminal(ref.work_attempt_id, ref.execution_generation_id,
              terminalPayload(terminal, execution.actor, execution.generation));
          }
          await this.durability.releaseTerminalExecutionFence(ref.work_attempt_id, ref.execution_generation_id);
          if (installation) this.streams.remove(installation);
        }
        if (!execution.terminal && !recoverIdleCursor) {
          if (!this.provider) throw new Error("Provider recovery is unavailable.");
          const attachment = await this.provider.attach(providerRef(entry));
          if (!attachment) {
            throw new Error("LetAgents cannot prove that the previous provider process stopped. Recovery was not started.");
          }
          if (!isAttachTerminal(attachment)) {
            throw new Error("The provider runtime is still reachable. Reconnect its credentials instead.");
          }
          if (attachment.terminal.providerContinuationId
            && attachment.terminal.providerContinuationId !== ref.provider_continuation_id) {
            throw new Error("Provider recovery returned terminal evidence for a different continuation.");
          }
          await this.durability.recordTerminal(ref.work_attempt_id, ref.execution_generation_id, {
            ...terminalPayload(attachment.terminal, execution.actor, this.authority.currentDaemonGeneration(), ref.provider_connection),
            actor: execution.actor,
            generation: execution.generation,
          });
          await this.options.settleRuntimeApprovals(entryId);
          await this.durability.releaseTerminalExecutionFence(ref.work_attempt_id, ref.execution_generation_id);
        }
      }
      await this.options.settleRuntimeApprovals(entryId);

      await this.delivery?.stop(entryId).catch(() => undefined);
      entry = await this.completeTurnControl(await this.store.getEntry(entryId) ?? entry);
      const binding = await this.bindings.get(entryId);
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
        await this.bindings.unbind(entryId, binding.agent_session_id, binding.execution_generation_id);
      }
      this.runtimeCustody.deleteLiveBinding(entryId);
      this.runtimeCustody.deletePendingResumeBinding(entryId);
      this.runtimeCustody.deleteWorkerAuthorization(entryId);

      // Clear the runtime and settle its exact failed turn in one transaction.
      // A crash must leave either the old continuation AND its blocked FIFO,
      // or fresh-runtime intent AND a released FIFO, never a mix of the two.
      entry = await this.authority.serializeManifest(async () => {
        await this.authority.assertCurrent();
        const current = await this.store.getEntry(entryId);
        if (!current || current.provider_ref?.execution_generation_id !== ref?.execution_generation_id
          || current.provider_ref?.provider_continuation_id !== ref?.provider_continuation_id) {
          throw new Error("Runtime recovery lost the exact provider reference before replacement.");
        }
        const committed = await this.store.replaceEntry(this.authority.currentManifestGeneration(), {
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
        }, this.authority.fenceCommit, {
          agentId: entryId,
          detail: "Room move cancelled because its activating provider runtime ended before destination membership was joined.",
        }, interruptedDelivery);
        this.authority.acceptManifestGeneration(committed.generation);
        if (committed.recoveredRuntimeId) {
          this.options.releaseRecoveredObservation?.(entryId, committed.recoveredRuntimeId, ref?.execution_generation_id);
        }
        return committed.entry;
      });
      return entry;
    });
    this.requestConvergence(entryId);
    return { outcome: "recovering", entry: await this.entryWithDerivedLiveness(updated) };
  }
}

async function boundedRecoveryWait(pending: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The runtime stopped, but delivery cleanup has not finished. Recovery remains paused; retry shortly.")), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function providerRef(entry: DaemonManifestEntry): ProviderActionRef {
  if (!entry.work_attempt_id || !entry.provider_ref) {
    throw new Error("Provider reference is unavailable.");
  }
  return {
    workAttemptId: entry.work_attempt_id,
    providerContinuationId: entry.provider_ref.provider_continuation_id,
    provider: entry.provider,
    providerConnection: entry.provider_ref.provider_connection,
  };
}

function isAttachTerminal(
  result: ProviderActionHandle | ProviderActionAttachTerminal,
): result is ProviderActionAttachTerminal {
  return "state" in result && result.state === "terminal";
}

function terminalPayload(
  terminal: ProviderActionTerminal,
  actor: string,
  generation: number,
  connection?: ProviderActionHandle["providerConnection"],
): ExecutionTerminalPayload {
  const death = validatedNativeRuntimeDeath(terminal, connection);
  return {
    ...(death ? { native_runtime_death: death } : {}),
    ended_at: terminal.endedAt,
    exit_code: terminal.exitCode,
    signal: terminal.signal,
    stdio_archive_ref: null,
    stdio_tail: "",
    terminal_cause: terminal.terminalCause,
    actor,
    generation,
    provider_continuation_id: terminal.providerContinuationId,
  };
}
