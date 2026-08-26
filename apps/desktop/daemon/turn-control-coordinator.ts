import { redactCredentialText, sanitizeDaemonActivityEvent } from "./credential-redaction.js";
import type { WorkDurabilityStore } from "./durability-store.js";
import type { EntryConcurrencyGate } from "./entry-concurrency-gate.js";
import type { ManifestStore } from "./manifest-store.js";
import {
  sameProviderActionConnectionSnapshot,
  type ProviderActionHandle,
  type ProviderActionPort,
  type ProviderTurnControlResult,
} from "./provider-action-port.js";
import {
  advanceReconciliationState,
  rememberCompletedControlAction,
} from "./reconciler-state.js";
import type {
  SupervisedAgentDelivery,
  SupervisedDeliveryInterruptReservation,
  SupervisedIngressAgent,
} from "./supervised-agent-delivery.js";
import type { SupervisedAgentInboxStore } from "./supervised-agent-inbox-store.js";
import type { DaemonManifestEntry, DaemonManifestEntryView } from "./types.js";
import type { WorkerBindingStore } from "./worker-binding-store.js";

const MAX_TURN_CONTROL_CORRECTION_BYTES = 32 * 1024;
const MAX_TURN_CONTROL_ACTION_ID_BYTES = 256;
const TURN_CONTROL_ADMISSION_WINDOW_MS = 60_000;
const MAX_NEW_TURN_CONTROLS_PER_WINDOW = 24;

export type TurnControlInput = {
  entryId: string;
  daemonGeneration: number;
  roomId: string;
  workAttemptId: string;
  executionGenerationId: string;
  providerContinuationId: string;
  providerTurnId: string;
  inboxItemId: string;
  sourceMessageId: string;
  actionId: string;
  actionSequence: number;
  correction: string | null;
};

export type TurnControlResolutionInput = {
  entryId: string;
  workAttemptId: string;
  executionGenerationId: string;
  actionId: string;
  resolution: "not_applied" | "applied";
};

export type DaemonTurnControlResult = ProviderTurnControlResult & {
  entryId: string;
  workAttemptId: string;
  executionGenerationId: string;
  actionId: string;
  duplicate: boolean;
  stages: Array<"delivered" | "interrupting" | "applied" | "resumed" | "already_applied">;
};

type CommitFence = (commit: () => Promise<void>) => Promise<void>;

export type TurnControlCoordinatorPorts = {
  authority: {
    currentGeneration(): number;
    assertCurrent(): Promise<void>;
    manifestGeneration(): number;
    setManifestGeneration(generation: number): void;
    fenceCommit: CommitFence;
  };
  store: Pick<ManifestStore,
    "checkpointTurnControlTarget" | "commitTurnControlState" | "getEntry" | "load" | "prepareTurnControlState"
  >;
  durability: Pick<WorkDurabilityStore, "getAttempt">;
  workerBindings: Pick<WorkerBindingStore, "get">;
  inbox: Pick<SupervisedAgentInboxStore, "get">;
  delivery: Pick<SupervisedAgentDelivery,
    | "activeTurn"
    | "captureActiveDeliveryInterrupt"
    | "finishActiveDeliveryInterrupt"
    | "finishActiveDeliveryInterruptByAction"
    | "prepareActiveDeliveryInterrupt"
    | "resolveActiveDeliveryInterrupt"
  > | null;
  providerPort?: Pick<ProviderActionPort, "capabilities" | "controlTurn">;
  entryConcurrency: Pick<EntryConcurrencyGate, "beginTurnControl">;
  currentHandle(entryId: string): ProviderActionHandle | null | undefined;
  attachLiveProvider(entry: DaemonManifestEntry): Promise<ProviderActionHandle | null>;
  serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  serializeManifest<T>(operation: () => Promise<T>): Promise<T>;
  updateManifestEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
  ): Promise<DaemonManifestEntry>;
  entryWithDerivedLiveness(entry: DaemonManifestEntry): Promise<DaemonManifestEntryView>;
  wakeDelivery(entryId: string): Promise<void>;
  scheduleRecovery(entryId: string, delayMs: number): void;
  requestConvergence(entryId: string): void;
  nowMs?: () => number;
  delay?: (delayMs: number) => Promise<void>;
};

/**
 * Owns admission, deduplication, durable journaling, delivery interruption,
 * native provider dispatch, correction strategy, and operator resolution for
 * supervised turn control. All daemon authority and runtime surfaces remain
 * explicit ports.
 */
export class TurnControlCoordinator {
  private readonly turnControlRequests = new Map<string, {
    input: TurnControlInput;
    operation: Promise<DaemonTurnControlResult>;
  }>();
  private readonly turnControlAdmissions = new Map<string, number[]>();
  private readonly nowMs: () => number;
  private readonly delay: (delayMs: number) => Promise<void>;

  constructor(private readonly ports: TurnControlCoordinatorPorts) {
    this.nowMs = ports.nowMs ?? Date.now;
    this.delay = ports.delay ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  control(input: TurnControlInput): Promise<DaemonTurnControlResult> {
    for (const [field, value] of Object.entries({
      id: input.entryId,
      room_id: input.roomId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      provider_continuation_id: input.providerContinuationId,
      provider_turn_id: input.providerTurnId,
      inbox_item_id: input.inboxItemId,
      source_message_id: input.sourceMessageId,
      action_id: input.actionId,
    })) {
      if (!value.trim() || value !== value.trim()) throw new Error(`Turn control ${field} is required.`);
    }
    if (!Number.isSafeInteger(input.actionSequence) || input.actionSequence < 1) {
      throw new Error("Turn control action_sequence must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) {
      throw new Error("Turn control daemon_generation must be a positive safe integer.");
    }
    const correction = input.correction?.trim() || null;
    if (Buffer.byteLength(input.actionId, "utf8") > MAX_TURN_CONTROL_ACTION_ID_BYTES
      || !/^[A-Za-z0-9._:-]+$/.test(input.actionId)) {
      throw new Error("Turn control action_id must be at most 256 UTF-8 bytes and contain only letters, numbers, '.', '_', ':', or '-'.");
    }
    if (correction && Buffer.byteLength(correction, "utf8") > MAX_TURN_CONTROL_CORRECTION_BYTES) {
      throw new Error("Turn control correction exceeds the 32 KiB durable payload limit.");
    }
    const normalizedInput = { ...input, correction };
    const requestKey = JSON.stringify([normalizedInput.entryId, normalizedInput.actionId]);
    const existing = this.turnControlRequests.get(requestKey);
    if (existing) {
      const sameInput = existing.input.entryId === normalizedInput.entryId
        && existing.input.daemonGeneration === normalizedInput.daemonGeneration
        && existing.input.roomId === normalizedInput.roomId
        && existing.input.workAttemptId === normalizedInput.workAttemptId
        && existing.input.executionGenerationId === normalizedInput.executionGenerationId
        && existing.input.providerContinuationId === normalizedInput.providerContinuationId
        && existing.input.providerTurnId === normalizedInput.providerTurnId
        && existing.input.inboxItemId === normalizedInput.inboxItemId
        && existing.input.sourceMessageId === normalizedInput.sourceMessageId
        && existing.input.actionId === normalizedInput.actionId
        && existing.input.actionSequence === normalizedInput.actionSequence
        && existing.input.correction === normalizedInput.correction;
      if (!sameInput) throw new Error("An in-flight turn-control action id was reused with different fenced input.");
      return existing.operation;
    }
    const releaseTurnControl = this.ports.entryConcurrency.beginTurnControl(normalizedInput.entryId);
    const operation = this.controlOnce(normalizedInput).finally(() => {
      this.turnControlRequests.delete(requestKey);
      releaseTurnControl();
    });
    this.turnControlRequests.set(requestKey, { input: normalizedInput, operation });
    return operation;
  }

  async resolve(input: TurnControlResolutionInput): Promise<DaemonManifestEntryView> {
    if (!input.entryId || !input.workAttemptId || !input.executionGenerationId || !input.actionId) {
      throw new Error("Exact turn-control resolution identity is required.");
    }
    if (input.resolution !== "not_applied" && input.resolution !== "applied") {
      throw new Error("Turn-control resolution must be 'not_applied' or 'applied'.");
    }
    const prior = await this.ports.store.getEntry(input.entryId);
    const priorControl = prior?.turn_control;
    if (prior
      && prior.work_attempt_id === input.workAttemptId
      && priorControl?.action_id === input.actionId
      && priorControl.work_attempt_id === input.workAttemptId
      && priorControl.execution_generation_id === input.executionGenerationId
      && priorControl.status === "completed") {
      if (priorControl.operator_resolution !== input.resolution) {
        throw new Error("This turn-control action was already completed with a different operator resolution.");
      }
      return this.ports.entryWithDerivedLiveness(prior);
    }
    const updatedAt = new Date().toISOString();
    let committed: Awaited<ReturnType<ManifestStore["commitTurnControlState"]>>;
    try {
      committed = await this.ports.serializeEntry(input.entryId, () => this.ports.serializeManifest(async () => {
        await this.ports.authority.assertCurrent();
        const current = await this.ports.store.getEntry(input.entryId);
        const control = current?.turn_control;
        const currentRuntimeMatches = current?.provider_ref?.execution_generation_id === input.executionGenerationId;
        const controlledAttempt = current?.work_attempt_id === input.workAttemptId && !currentRuntimeMatches
          ? await this.ports.durability.getAttempt(input.workAttemptId)
          : null;
        const controlledExecutionTerminal = Boolean(controlledAttempt?.execution_generations.some((candidate) =>
          candidate.execution_generation_id === input.executionGenerationId && candidate.terminal));
        if (!current
          || !control
          || control.action_id !== input.actionId
          || control.work_attempt_id !== input.workAttemptId
          || control.execution_generation_id !== input.executionGenerationId
          || current.work_attempt_id !== input.workAttemptId
          || (!currentRuntimeMatches && !controlledExecutionTerminal)) {
          throw new Error("Turn-control resolution identity is stale or belongs to another execution.");
        }
        if (control.status !== "uncertain") {
          throw new Error("Only an uncertain turn-control outcome requires operator resolution.");
        }
        const checkpoint = await this.ports.store.commitTurnControlState(this.manifestGeneration, {
          agentId: current.id,
          roomId: current.room_id,
          actionId: input.actionId,
          workAttemptId: input.workAttemptId,
          executionGenerationId: input.executionGenerationId,
          mode: input.resolution === "applied" ? "operator_applied" : "operator_not_applied",
          settleOriginal: input.resolution === "applied" && Boolean(control.inbox_item_id),
          activateCorrection: control.correction_strategy === "stop_then_resend",
          observedAt: updatedAt,
        }, (entry, outcome) => {
          const publicationWon = outcome.original === "publication_won";
          const interrupted = input.resolution === "applied" && !publicationWon;
          const resumed = control.correction_strategy === "stop_then_resend"
            || (input.resolution === "applied" && control.has_correction);
          const activity = [...(entry.activity ?? []), sanitizeDaemonActivityEvent({
            observed_at: updatedAt,
            sequence: ((entry.activity ?? []).at(-1)?.sequence ?? 0) + 1,
            provider: entry.provider,
            kind: "turn_lifecycle",
            method: "supervisor/resolve-turn-control",
            summary: input.resolution === "not_applied"
              ? publicationWon
                ? "Operator verified the native control was not applied; the committed reply stands"
                : outcome.original === "cancelled"
                  ? "Operator verified the native control was not applied; the migration-cancelled legacy turn remains retired"
                  : "Operator verified the native control was not applied; the exact turn was recovered"
              : publicationWon
                ? "Operator verified the native control was applied after the reply had already committed"
                : control.correction_strategy === "stop_then_resend"
                  ? "Operator verified the stop was applied; the durable correction was queued"
                  : "Operator verified the ambiguous native effect was applied",
            status: entry.observed_state === "working" ? "working" : "idle",
            payload: { action_id: control.action_id, resolution: input.resolution },
            payload_truncated: false,
            payload_redacted: false,
            durable_payload_ref: null,
          })].slice(-200);
          return {
            ...entry,
            activity,
            reconciliation: rememberCompletedControlAction(
              advanceReconciliationState(entry.reconciliation, entry.observed_state, this.nowMs()),
              control.action_id,
            ),
            turn_control: {
              ...control,
              inbox_item_id: outcome.inboxItemId,
              provider_turn_id: outcome.providerTurnId,
              operator_resolution: input.resolution,
              status: "completed",
              interrupted,
              resumed,
              state: entry.observed_state === "working" ? "working" : "idle",
              stages: input.resolution === "applied" ? ["already_applied"] : [],
              error: input.resolution === "not_applied"
                ? control.has_correction && (!control.correction_text?.trim() || !control.correction_strategy)
                  ? "Operator verified that the prior native effect was not applied. The legacy correction payload was not durable and must be reissued."
                  : outcome.original === "cancelled"
                    ? "Operator verified that the prior native effect was not applied; the migration-cancelled legacy turn remains cancelled and was not replayed."
                    : "Operator verified that the prior native effect was not applied; the exact turn was recovered without replaying native Stop."
                : "Operator verified that the prior native effect was applied.",
              updated_at: updatedAt,
            },
          };
        }, this.ports.authority.fenceCommit);
        this.manifestGeneration = checkpoint.generation;
        return checkpoint;
      }));
    } catch (error) {
      const recoveredManifest = await this.ports.store.load().catch(() => null);
      const recoveredEntry = recoveredManifest?.entries.find((candidate) => candidate.id === input.entryId);
      const recoveredControl = recoveredEntry?.turn_control;
      if (!recoveredManifest
        || recoveredEntry?.work_attempt_id !== input.workAttemptId
        || recoveredControl?.action_id !== input.actionId
        || recoveredControl.work_attempt_id !== input.workAttemptId
        || recoveredControl.execution_generation_id !== input.executionGenerationId
        || recoveredControl.status !== "completed"
        || recoveredControl.operator_resolution !== input.resolution) {
        throw error;
      }
      const recoveredInbox = recoveredControl.inbox_item_id
        ? await this.ports.inbox.get(recoveredControl.inbox_item_id).catch(() => null)
        : null;
      const original = recoveredInbox?.state === "cancelled_by_user"
        ? "cancelled" as const
        : recoveredInbox && ["publishing", "acknowledged", "acknowledged_no_reply"].includes(recoveredInbox.state)
          ? "publication_won" as const
          : input.resolution === "not_applied" && recoveredInbox
            ? "resumed" as const
            : "none" as const;
      this.manifestGeneration = recoveredManifest.generation;
      committed = { generation: recoveredManifest.generation, entry: recoveredEntry, original, correctionInboxItemId: null, providerTurnId: recoveredControl.provider_turn_id ?? null };
    }

    this.ports.delivery?.finishActiveDeliveryInterruptByAction(
      input.entryId,
      input.actionId,
      committed.original === "cancelled" ? "cancelled" : "resume",
    );
    try {
      await this.ports.wakeDelivery(input.entryId);
    } catch {
      this.ports.scheduleRecovery(input.entryId, 250);
    }
    this.ports.requestConvergence(input.entryId);
    return this.ports.entryWithDerivedLiveness(committed.entry);
  }

  /** Bound renderer-originated durable control creation without rate-limiting exact recovery retries. */
  admitNew(entryId: string): void {
    const now = this.nowMs();
    const cutoff = now - TURN_CONTROL_ADMISSION_WINDOW_MS;
    const recent = (this.turnControlAdmissions.get(entryId) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= MAX_NEW_TURN_CONTROLS_PER_WINDOW) {
      this.turnControlAdmissions.set(entryId, recent);
      throw new Error("Turn control is temporarily rate limited for this supervised agent.");
    }
    recent.push(now);
    this.turnControlAdmissions.set(entryId, recent);
  }

  private get manifestGeneration(): number {
    return this.ports.authority.manifestGeneration();
  }

  private set manifestGeneration(generation: number) {
    this.ports.authority.setManifestGeneration(generation);
  }

  private async controlOnce(input: TurnControlInput): Promise<DaemonTurnControlResult> {
    await this.ports.authority.assertCurrent();
    if (input.daemonGeneration !== this.ports.authority.currentGeneration()) {
      throw new Error("Turn control belongs to a stale supervisor generation.");
    }
    const manifest = await this.ports.store.load();
    const entry = manifest.entries.find((candidate) => candidate.id === input.entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entryId}`);
    const ref = entry.provider_ref;
    if (entry.desired_state !== "running") throw new Error("Turn control requires desired_state=running.");
    if (entry.condition !== "none" || (entry.observed_state !== "working" && entry.observed_state !== "idle")) {
      throw new Error("Turn control requires a healthy working or idle supervised entry.");
    }
    if (!entry.work_attempt_id || entry.work_attempt_id !== input.workAttemptId || ref?.work_attempt_id !== input.workAttemptId) {
      throw new Error("Turn control work attempt is stale or belongs to a different entry.");
    }
    if (!ref || ref.execution_generation_id !== input.executionGenerationId) {
      throw new Error("Turn control execution generation is stale or incomplete.");
    }
    if (entry.room_id !== input.roomId || ref.provider_continuation_id !== input.providerContinuationId) {
      throw new Error("Turn control room or provider continuation is stale.");
    }
    const capabilities = await this.ports.providerPort?.capabilities(input.workAttemptId, entry.provider);
    const capability = capabilities?.turnControl ?? "unsupported";
    const correction = input.correction?.trim() || null;
    const stopThenResend = Boolean(correction) && (entry.delivery_mode ?? "mcp_polling") === "daemon_inbox";
    let nativeCorrection = stopThenResend ? null : correction;
    let correctionStrategy: "native" | "stop_then_resend" | null = correction
      ? stopThenResend ? "stop_then_resend" : "native"
      : null;
    const existingControl = entry.turn_control;
    const retryingControl = existingControl?.action_id === input.actionId
      && existingControl.status === "retryable";
    if (existingControl?.action_id === input.actionId) {
      if (existingControl.work_attempt_id !== input.workAttemptId
        || existingControl.execution_generation_id !== input.executionGenerationId
        || existingControl.target_room_id !== input.roomId
        || existingControl.target_source_message_id !== input.sourceMessageId
        || existingControl.target_provider_continuation_id !== input.providerContinuationId
        || existingControl.inbox_item_id !== input.inboxItemId
        || existingControl.provider_turn_id !== input.providerTurnId
        || existingControl.action_sequence !== input.actionSequence
        || existingControl.has_correction !== Boolean(correction)
        || (existingControl.correction_text ?? null) !== correction) {
        throw new Error("Turn control action id was reused with different fenced input.");
      }
      if (existingControl.status === "completed") {
        return {
          entryId: input.entryId,
          workAttemptId: input.workAttemptId,
          executionGenerationId: input.executionGenerationId,
          actionId: input.actionId,
          capability: existingControl.capability,
          interrupted: existingControl.interrupted === true,
          resumed: existingControl.resumed === true,
          state: existingControl.state ?? (entry.observed_state === "working" ? "working" : "idle"),
          duplicate: true,
          stages: [...existingControl.stages],
        };
      }
      if (!retryingControl) {
        throw new Error("Turn control was durably dispatched but its provider outcome is unresolved; it was not replayed.");
      }
      if (correction && !existingControl.correction_strategy) {
        throw new Error("Turn control retry is missing its durable correction strategy; it was not replayed.");
      }
      correctionStrategy = existingControl.correction_strategy ?? null;
      nativeCorrection = correctionStrategy === "stop_then_resend" ? null : correction;
    }
    if (existingControl
      && existingControl.work_attempt_id === input.workAttemptId
      && existingControl.execution_generation_id === input.executionGenerationId
      && existingControl.status !== "completed"
      && existingControl.status !== "retryable") {
      throw new Error(`Turn control action '${existingControl.action_id}' is unresolved; refusing a second action on the same execution generation.`);
    }
    if (existingControl
      && existingControl.action_id !== input.actionId
      && existingControl.work_attempt_id === input.workAttemptId
      && existingControl.execution_generation_id === input.executionGenerationId
      && existingControl.status === "retryable"
      && existingControl.inbox_item_id) {
      throw new Error(`Turn control action '${existingControl.action_id}' is accepted and retryable; refusing to replace its exact FIFO barrier with another action.`);
    }
    if (!retryingControl) {
      if (entry.observed_state === "idle" && correction === null) {
        throw new Error("There is no active supervised turn to stop.");
      }
      this.admitNew(entry.id);
    }
    if (!this.ports.providerPort?.controlTurn || capability === "unsupported") {
      throw new Error(`Provider '${entry.provider}' does not support supervised turn control.`);
    }
    const binding = await this.ports.workerBindings.get(entry.id);
    if (!binding
      || binding.room_id !== entry.room_id
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId) {
      throw new Error("Turn control requires the exact active worker binding for this execution generation.");
    }
    const attempt = await this.ports.durability.getAttempt(input.workAttemptId);
    const execution = attempt.execution_generations.find((candidate) =>
      candidate.execution_generation_id === input.executionGenerationId);
    if (!execution || execution.terminal) throw new Error("Turn control execution generation is no longer live.");
    let handle = this.ports.currentHandle(entry.id) ?? null;
    if (!handle) handle = await this.ports.attachLiveProvider(entry);
    if (!handle
      || handle.workAttemptId !== input.workAttemptId
      || handle.providerContinuationId !== ref.provider_continuation_id) {
      throw new Error("Turn control could not resolve the exact live provider continuation.");
    }
    const deliveryAgent: SupervisedIngressAgent = {
      agentId: entry.id,
      roomId: binding.room_id,
      provider: entry.provider,
      charter: entry.charter,
      apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id,
      bearer: "",
      handle,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: ref.provider_continuation_id ?? null,
      providerConnection: ref.provider_connection ?? null,
      executionGenerationId: binding.execution_generation_id,
      daemonGeneration: this.ports.authority.currentGeneration(),
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
    };
    const interruptedDelivery: { current: SupervisedDeliveryInterruptReservation | null } = { current: null };
    let foldCompletedRetryWithoutNativeControl = false;
    if (retryingControl && existingControl?.inbox_item_id && (entry.delivery_mode ?? "mcp_polling") === "daemon_inbox") {
      await this.ports.wakeDelivery(entry.id);
      for (let observation = 0; observation < 500; observation += 1) {
        const active = this.ports.delivery?.activeTurn(deliveryAgent);
        if (active?.inboxItemId === existingControl.inbox_item_id) break;
        const linked = await this.ports.inbox.get(existingControl.inbox_item_id);
        if (linked && ["publishing", "acknowledged", "acknowledged_no_reply"].includes(linked.state)) {
          foldCompletedRetryWithoutNativeControl = true;
          break;
        }
        await this.delay(10);
      }
    }
    const recordedAt = new Date().toISOString();
    let prepared: Awaited<ReturnType<ManifestStore["prepareTurnControlState"]>>;
    try {
      prepared = await this.ports.serializeEntry(entry.id, () => this.ports.serializeManifest(async () => {
        await this.ports.authority.assertCurrent();
        const checkpoint = await this.ports.store.prepareTurnControlState(this.manifestGeneration, {
          agentId: entry.id,
          roomId: entry.room_id,
          expectedInboxItemId: input.inboxItemId,
          expectedSourceMessageId: input.sourceMessageId,
          expectedProviderTurnId: input.providerTurnId,
          actionId: input.actionId,
          actionSequence: input.actionSequence,
          workAttemptId: input.workAttemptId,
          executionGenerationId: input.executionGenerationId,
          providerContinuationId: ref.provider_continuation_id,
          providerConnection: ref.provider_connection,
          deliveryMode: entry.delivery_mode ?? "mcp_polling",
          hasCorrection: Boolean(correction),
          correctionText: correction,
          correctionStrategy,
          capability,
          recordedAt,
        }, this.ports.authority.fenceCommit);
        this.manifestGeneration = checkpoint.generation;
        return checkpoint;
      }));
    } catch (error) {
      const recoveredManifest = await this.ports.store.load().catch(() => null);
      const recoveredEntry = recoveredManifest?.entries.find((candidate) => candidate.id === entry.id);
      const recovered = recoveredEntry?.turn_control;
      if (!recoveredManifest
        || recoveredEntry?.room_id !== entry.room_id
        || recoveredEntry.work_attempt_id !== input.workAttemptId
        || recoveredEntry.provider_ref?.execution_generation_id !== input.executionGenerationId
        || recoveredEntry.provider_ref.provider_continuation_id !== ref.provider_continuation_id
        || !sameProviderActionConnectionSnapshot(recoveredEntry.provider_ref.provider_connection, ref.provider_connection)
        || (recoveredEntry.delivery_mode ?? "mcp_polling") !== (entry.delivery_mode ?? "mcp_polling")
        || recovered?.action_id !== input.actionId
        || recovered.target_room_id !== input.roomId
        || recovered.target_source_message_id !== input.sourceMessageId
        || recovered.target_provider_continuation_id !== input.providerContinuationId
        || recovered.inbox_item_id !== input.inboxItemId
        || recovered.provider_turn_id !== input.providerTurnId
        || recovered.action_sequence !== input.actionSequence
        || recovered.work_attempt_id !== input.workAttemptId
        || recovered.execution_generation_id !== input.executionGenerationId
        || recovered.status !== "prepared"
        || recovered.has_correction !== Boolean(correction)
        || (recovered.correction_text ?? null) !== correction
        || (recovered.correction_strategy ?? null) !== correctionStrategy) {
        throw error;
      }
      const linked = recovered.inbox_item_id
        ? await this.ports.inbox.get(recovered.inbox_item_id).catch(() => null)
        : null;
      this.manifestGeneration = recoveredManifest.generation;
      prepared = {
        generation: recoveredManifest.generation,
        entry: recoveredEntry,
        linkedInboxItemId: recovered.inbox_item_id ?? null,
        providerTurnId: recovered.provider_turn_id ?? null,
        linkedState: linked?.state ?? null,
      };
    }
    if ((entry.delivery_mode ?? "mcp_polling") === "daemon_inbox") {
      if (prepared.linkedInboxItemId) {
        interruptedDelivery.current = this.ports.delivery?.captureActiveDeliveryInterrupt(deliveryAgent, input.actionId) ?? null;
        if (interruptedDelivery.current?.inboxItemId !== prepared.linkedInboxItemId) {
          this.ports.delivery?.finishActiveDeliveryInterrupt(interruptedDelivery.current, "resume");
          interruptedDelivery.current = null;
        }
        if (!interruptedDelivery.current) {
          const linked = await this.ports.inbox.get(prepared.linkedInboxItemId);
          if (linked && ["publishing", "acknowledged", "acknowledged_no_reply", "cancelled_by_user"].includes(linked.state)) {
            foldCompletedRetryWithoutNativeControl = true;
          } else {
            const message = "Turn control is waiting for its exact admitted FIFO invocation; no native latest-turn control was dispatched.";
            await this.ports.updateManifestEntry(entry.id, (current) => current.turn_control?.action_id === input.actionId
              && current.turn_control.status === "prepared"
              ? { ...current, turn_control: { ...current.turn_control, status: "retryable", error: message, updated_at: new Date().toISOString() } }
              : current);
            try { await this.ports.wakeDelivery(entry.id); } catch { this.ports.scheduleRecovery(entry.id, 250); }
            this.ports.requestConvergence(entry.id);
            throw new Error(message);
          }
        }
      } else {
        foldCompletedRetryWithoutNativeControl = true;
      }
    }
    let providerResult: ProviderTurnControlResult;
    let dispatchMarked = false;
    try {
      providerResult = foldCompletedRetryWithoutNativeControl
        ? { capability, interrupted: false, resumed: false, state: entry.observed_state === "working" ? "working" : "idle" }
        : await this.ports.providerPort.controlTurn(handle, nativeCorrection, {
          actionId: input.actionId,
          targetTurnId: prepared.providerTurnId,
          checkpointTurnStarted: async (turnId) => {
            if (!turnId.trim() || this.ports.currentHandle(entry.id) !== handle) {
              throw new Error("Turn control lost its exact live provider before target checkpoint.");
            }
            const checkpointedAt = new Date().toISOString();
            const checkpoint = await this.ports.serializeManifest(async () => {
              await this.ports.authority.assertCurrent();
              const result = await this.ports.store.checkpointTurnControlTarget(this.manifestGeneration, {
                agentId: entry.id,
                roomId: entry.room_id,
                actionId: input.actionId,
                workAttemptId: input.workAttemptId,
                executionGenerationId: input.executionGenerationId,
                providerContinuationId: ref.provider_continuation_id,
                providerConnection: ref.provider_connection,
                deliveryMode: entry.delivery_mode ?? "mcp_polling",
                providerTurnId: turnId,
                observedAt: checkpointedAt,
              }, this.ports.authority.fenceCommit);
              this.manifestGeneration = result.generation;
              return result;
            });
            if (this.ports.currentHandle(entry.id) !== handle) {
              throw new Error("Turn control provider changed after exact target checkpoint.");
            }
            prepared = { ...prepared, generation: checkpoint.generation, entry: checkpoint.entry, providerTurnId: turnId };
          },
          markDispatched: async () => {
            if (dispatchMarked) return;
            if ((entry.delivery_mode ?? "mcp_polling") === "daemon_inbox" && !interruptedDelivery.current) {
              throw new Error("Turn control cannot dispatch without reserving the exact active daemon-inbox invocation.");
            }
            await this.ports.updateManifestEntry(entry.id, (current) => {
              if (current.turn_control?.action_id !== input.actionId
                || current.desired_state !== "running"
                || current.condition !== "none"
                || current.work_attempt_id !== input.workAttemptId
                || current.provider_ref?.execution_generation_id !== input.executionGenerationId
                || current.provider_ref.provider_continuation_id !== ref.provider_continuation_id
                || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, ref.provider_connection)
                || (current.delivery_mode ?? "mcp_polling") !== (entry.delivery_mode ?? "mcp_polling")
                || this.ports.currentHandle(entry.id) !== handle) {
                throw new Error("Turn control lost its durable prepared journal before native dispatch.");
              }
              const durableInboxItemId = current.turn_control.inbox_item_id ?? null;
              const capturedInboxItemId = interruptedDelivery.current?.inboxItemId ?? null;
              if (durableInboxItemId !== null && durableInboxItemId !== capturedInboxItemId) {
                throw new Error("Turn control retry no longer owns its exact durable FIFO invocation.");
              }
              return {
                ...current,
                turn_control: {
                  ...current.turn_control,
                  inbox_item_id: interruptedDelivery.current?.inboxItemId ?? current.turn_control.inbox_item_id ?? null,
                  provider_turn_id: interruptedDelivery.current?.providerTurnId ?? current.turn_control.provider_turn_id ?? null,
                  status: "dispatching",
                  updated_at: new Date().toISOString(),
                },
              };
            });
            dispatchMarked = true;
          },
        });
      if ((providerResult.interrupted || providerResult.resumed) && !dispatchMarked) {
        throw Object.assign(
          new Error("Provider reported a turn-control effect without marking native dispatch."),
          { turnControlOutcome: "uncertain" as const },
        );
      }
    } catch (error) {
      const message = redactCredentialText(error instanceof Error ? error.message : String(error)).value;
      const outcome = error && typeof error === "object" && "turnControlOutcome" in error
        ? (error as { turnControlOutcome?: unknown }).turnControlOutcome
        : null;
      const mayResumeDelivery = outcome === "not_applied" || (!dispatchMarked && outcome !== "uncertain");
      if (!mayResumeDelivery) {
        this.ports.delivery?.resolveActiveDeliveryInterrupt(interruptedDelivery.current, "freeze");
      }
      try {
        await this.ports.updateManifestEntry(entry.id, (current) => current.turn_control?.action_id === input.actionId
          ? {
            ...current,
            turn_control: {
              ...current.turn_control,
              inbox_item_id: interruptedDelivery.current?.inboxItemId ?? current.turn_control.inbox_item_id ?? null,
              provider_turn_id: interruptedDelivery.current?.providerTurnId ?? current.turn_control.provider_turn_id ?? null,
              status: outcome === "not_applied" ? "retryable" : outcome === "uncertain" ? "uncertain" : dispatchMarked ? "uncertain" : "retryable",
              error: message,
              updated_at: new Date().toISOString(),
            },
          }
          : current);
      } catch (journalError) {
        this.ports.delivery?.resolveActiveDeliveryInterrupt(interruptedDelivery.current, "freeze");
        throw journalError;
      }
      if (mayResumeDelivery) {
        this.ports.delivery?.resolveActiveDeliveryInterrupt(interruptedDelivery.current, "resume");
      }
      throw error;
    }
    const reservation = interruptedDelivery.current;
    if (nativeCorrection === null && providerResult.interrupted && reservation && this.ports.delivery) {
      try {
        await this.ports.delivery.prepareActiveDeliveryInterrupt(reservation);
      } catch (error) {
        this.ports.delivery.finishActiveDeliveryInterrupt(reservation, "freeze");
        const message = redactCredentialText(error instanceof Error ? error.message : String(error)).value;
        await this.ports.updateManifestEntry(entry.id, (current) => current.turn_control?.action_id === input.actionId
          ? { ...current, turn_control: {
            ...current.turn_control,
            inbox_item_id: reservation.inboxItemId,
            provider_turn_id: reservation.providerTurnId ?? current.turn_control.provider_turn_id ?? null,
            status: "uncertain" as const,
            error: message,
            updated_at: new Date().toISOString(),
          } }
          : current);
        throw error;
      }
    }

    const observedAt = new Date().toISOString();
    let committed: Awaited<ReturnType<ManifestStore["commitTurnControlState"]>>;
    try {
      committed = await this.ports.serializeEntry(entry.id, () => this.ports.serializeManifest(async () => {
        await this.ports.authority.assertCurrent();
        const checkpoint = await this.ports.store.commitTurnControlState(this.manifestGeneration, {
          agentId: entry.id,
          roomId: entry.room_id,
          actionId: input.actionId,
          workAttemptId: input.workAttemptId,
          executionGenerationId: input.executionGenerationId,
          mode: "native_applied",
          settleOriginal: nativeCorrection === null && providerResult.interrupted && Boolean(reservation),
          activateCorrection: correctionStrategy === "stop_then_resend",
          observedAt,
        }, (current, outcome) => {
          const interrupted = outcome.original === "publication_won" ? false : providerResult.interrupted;
          const resumed = correctionStrategy === "stop_then_resend" ? true : providerResult.resumed;
          const stages: DaemonTurnControlResult["stages"] = ["delivered"];
          if (interrupted) stages.push("interrupting");
          stages.push("applied");
          if (resumed) stages.push("resumed");
          const nextReconciliation = rememberCompletedControlAction(
            advanceReconciliationState(current.reconciliation, providerResult.state, this.nowMs()),
            input.actionId,
          );
          const activity = [...(current.activity ?? []), sanitizeDaemonActivityEvent({
            observed_at: observedAt,
            sequence: ((current.activity ?? []).at(-1)?.sequence ?? 0) + 1,
            provider: current.provider,
            kind: "turn_lifecycle",
            method: correction ? "supervisor/steer" : "supervisor/stop-turn",
            summary: correctionStrategy === "stop_then_resend"
              ? "Active turn stopped; human correction queued as the next bounded turn"
              : correction
                ? "Human correction applied; same continuation resumed"
                : interrupted
                  ? "Active turn interrupted; worker remains available"
                  : "Turn already finished before the stop; its reply stands",
            status: providerResult.state === "working" ? "working" : "idle",
            payload: { action_id: input.actionId, capability, stages },
            payload_truncated: false,
            payload_redacted: false,
            durable_payload_ref: null,
          })].slice(-200);
          return {
            ...current,
            observed_state: providerResult.state,
            native_liveness: {
              state: providerResult.state === "working" ? "active" : "idle",
              observed_at: observedAt,
              detail: correctionStrategy === "stop_then_resend"
                ? "turn interrupted; correction queued on the same supervised lane"
                : correction
                  ? "human correction resumed on the same continuation"
                  : interrupted
                    ? "turn interrupted; worker available"
                    : "turn already finished; its reply stands",
            },
            activity,
            reconciliation: nextReconciliation,
            turn_control: {
              ...current.turn_control!,
              inbox_item_id: outcome.inboxItemId,
              provider_turn_id: outcome.providerTurnId,
              status: "completed",
              capability,
              interrupted,
              resumed,
              state: providerResult.state,
              stages,
              error: null,
              updated_at: observedAt,
            },
          };
        }, this.ports.authority.fenceCommit);
        this.manifestGeneration = checkpoint.generation;
        return checkpoint;
      }));
    } catch (error) {
      const recoveredManifest = await this.ports.store.load().catch(() => null);
      const recoveredEntry = recoveredManifest?.entries.find((candidate) => candidate.id === entry.id);
      const recoveredControl = recoveredEntry?.turn_control;
      const expectedInboxItemId = reservation?.inboxItemId
        ?? prepared.linkedInboxItemId
        ?? existingControl?.inbox_item_id
        ?? null;
      if (recoveredManifest
        && recoveredEntry?.room_id === entry.room_id
        && recoveredEntry.work_attempt_id === input.workAttemptId
        && recoveredEntry.provider_ref?.execution_generation_id === input.executionGenerationId
        && recoveredControl?.action_id === input.actionId
        && recoveredControl.work_attempt_id === input.workAttemptId
        && recoveredControl.execution_generation_id === input.executionGenerationId
        && recoveredControl.status === "completed"
        && (recoveredControl.inbox_item_id ?? null) === expectedInboxItemId
        && (recoveredControl.provider_turn_id ?? null) === (reservation?.providerTurnId ?? prepared.providerTurnId ?? null)
        && recoveredControl.has_correction === Boolean(correction)
        && (recoveredControl.correction_text ?? null) === correction
        && (recoveredControl.correction_strategy ?? null) === correctionStrategy) {
        const recoveredInbox = expectedInboxItemId
          ? await this.ports.inbox.get(expectedInboxItemId).catch(() => null)
          : null;
        const original = recoveredInbox?.state === "cancelled_by_user"
          ? "cancelled" as const
          : recoveredInbox && ["publishing", "acknowledged", "acknowledged_no_reply"].includes(recoveredInbox.state)
            ? "publication_won" as const
            : "none" as const;
        this.manifestGeneration = recoveredManifest.generation;
        committed = { generation: recoveredManifest.generation, entry: recoveredEntry, original, correctionInboxItemId: null, providerTurnId: recoveredControl.provider_turn_id ?? null };
      } else {
        const nativeOutcomeMayExist = dispatchMarked && !foldCompletedRetryWithoutNativeControl;
        this.ports.delivery?.finishActiveDeliveryInterrupt(
          reservation,
          nativeOutcomeMayExist ? "freeze" : "resume",
        );
        const message = redactCredentialText(error instanceof Error ? error.message : String(error)).value;
        try {
          await this.ports.updateManifestEntry(entry.id, (current) => current.turn_control?.action_id === input.actionId
            && current.turn_control.status !== "completed"
            ? { ...current, turn_control: {
              ...current.turn_control,
              inbox_item_id: reservation?.inboxItemId ?? current.turn_control.inbox_item_id ?? null,
              provider_turn_id: reservation?.providerTurnId ?? current.turn_control.provider_turn_id ?? null,
              status: nativeOutcomeMayExist ? "uncertain" as const : "retryable" as const,
              error: message,
              updated_at: new Date().toISOString(),
            } }
            : current);
        } catch { /* The durable dispatching journal still fails closed on restart. */ }
        if (!nativeOutcomeMayExist) {
          try { await this.ports.wakeDelivery(entry.id); } catch { this.ports.scheduleRecovery(entry.id, 250); }
          this.ports.requestConvergence(entry.id);
        }
        throw error;
      }
    }

    const interrupted = committed.entry.turn_control?.interrupted === true;
    const resumed = committed.entry.turn_control?.resumed === true;
    const stages = committed.entry.turn_control?.stages ?? ["applied"];
    this.ports.delivery?.finishActiveDeliveryInterrupt(
      reservation,
      committed.original === "cancelled" ? "cancelled" : "resume",
    );
    if (committed.correctionInboxItemId
      || (correctionStrategy === "stop_then_resend" && committed.entry.turn_control?.status === "completed")) {
      try {
        await this.ports.wakeDelivery(entry.id);
      } catch {
        this.ports.scheduleRecovery(entry.id, 250);
      }
      this.ports.requestConvergence(entry.id);
    }
    return {
      entryId: input.entryId,
      workAttemptId: input.workAttemptId,
      executionGenerationId: input.executionGenerationId,
      actionId: input.actionId,
      duplicate: false,
      stages,
      ...providerResult,
      interrupted,
      resumed,
    };
  }
}
