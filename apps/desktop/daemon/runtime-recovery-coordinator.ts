import type { SupervisorGrantHttp } from "./cloud-http.js";
import type { WorkDurabilityStore } from "./durability-store.js";
import type { ManifestStore } from "./manifest-store.js";
import {
  type ProviderActionAttachTerminal,
  type ProviderActionHandle,
  type ProviderActionPort,
  type ProviderActionRef,
  type ProviderActionTerminal,
} from "./provider-action-port.js";
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
  store: ManifestStore;
  durability: WorkDurabilityStore;
  inbox: SupervisedAgentInboxStore;
  bindings: WorkerBindingStore;
  workerAuthority: WorkerAuthorityCoordinator;
  runtimeCustody: WorkerRuntimeCustody;
  delivery: SupervisedAgentDelivery | null;
  supervisorGrantHttp: SupervisorGrantHttp;
  provider?: ProviderActionPort;
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
  private readonly authority: RuntimeRecoveryAuthority;
  private readonly beginLifecycle: RuntimeRecoveryCoordinatorOptions["beginLifecycle"];
  private readonly bumpControlEpoch: RuntimeRecoveryCoordinatorOptions["bumpControlEpoch"];
  private readonly clearRecovery: RuntimeRecoveryCoordinatorOptions["clearRecovery"];
  private readonly serializeEntry: RuntimeRecoveryCoordinatorOptions["serializeEntry"];
  private readonly updateEntry: RuntimeRecoveryCoordinatorOptions["updateEntry"];
  private readonly requestConvergence: RuntimeRecoveryCoordinatorOptions["requestConvergence"];
  private readonly entryWithDerivedLiveness: RuntimeRecoveryCoordinatorOptions["entryWithDerivedLiveness"];
  private readonly nowMs: () => number;

  constructor(options: RuntimeRecoveryCoordinatorOptions) {
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

  async recoverAgentRuntime(entryId: string, daemonGeneration: number) {
    const release = this.beginLifecycle(entryId);
    try {
      return await this.recoverAgentRuntimeExclusive(entryId, daemonGeneration);
    } finally {
      release();
    }
  }

  private async recoverAgentRuntimeExclusive(entryId: string, daemonGeneration: number) {
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
      if (this.liveHandles.has(entryId)) {
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
            ...terminalPayload(attachment.terminal, execution.actor, this.authority.currentDaemonGeneration()),
            actor: execution.actor,
            generation: execution.generation,
          });
          await this.durability.releaseTerminalExecutionFence(ref.work_attempt_id, ref.execution_generation_id);
        }
      }

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

      entry = await this.updateEntry(entryId, (current) => ({
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
): ExecutionTerminalPayload {
  return {
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
