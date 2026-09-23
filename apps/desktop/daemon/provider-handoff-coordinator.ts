import type { ManifestStore } from "./manifest-store.js";
import type { ProviderActionHandle, ProviderActionPort } from "./provider-action-port.js";
import { sameProviderActionConnectionSnapshot } from "./provider-action-port.js";
import type { ProviderExecutionCoordinator } from "./provider-execution-coordinator.js";
import type { SupervisedAgentDelivery } from "./supervised-agent-delivery.js";
import type { SupervisedAgentInboxStore } from "./supervised-agent-inbox-store.js";
import type { DaemonManifestEntry } from "./types.js";

type ProviderHandoffCoordinatorOptions = {
  provider?: Pick<ProviderActionPort, "capabilities" | "runtimeCustody">;
  manifest: Pick<ManifestStore, "load" | "getEntry">;
  inbox: Pick<SupervisedAgentInboxStore, "head" | "providerTurnBinding" | "detail">;
  execution: Pick<ProviderExecutionCoordinator, "drainDispatches"> | null;
  delivery(): Pick<SupervisedAgentDelivery, "pauseDispatch" | "drainAdmittedTurns" | "resumeDispatch"> | null;
  currentHandle(entryId: string): ProviderActionHandle | undefined;
  currentExecutionGeneration(entryId: string): string | undefined;
  isNativeControlActive(entryId: string): boolean;
  isRetiring(): boolean;
  setDraining(draining: boolean): void;
  beginRetirement(): void;
  retire(): Promise<void>;
  finish(): Promise<void>;
  requestConvergence(entryId: string): void;
};

/** Owns reversible update admission; current-turn authority retires only after proof. */
export class ProviderHandoffCoordinator {
  private preparation: Promise<void> | null = null;
  private prepared = false;

  /** Resolves only once the daemon has relinquished every authority surface. */
  private readonly completion: Promise<void>;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: unknown) => void;

  constructor(private readonly options: ProviderHandoffCoordinatorOptions) {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    // Preparing a handoff does not require its caller to observe process exit.
    void this.completion.catch(() => undefined);
  }

  waitForCompletion(): Promise<void> {
    return this.completion;
  }

  prepare(): Promise<void> {
    if (this.prepared) return Promise.resolve();
    if (!this.preparation) {
      this.preparation = this.prepareOnce().finally(() => { this.preparation = null; });
    }
    return this.preparation;
  }

  private async prepareOnce(): Promise<void> {
    this.options.setDraining(true);
    this.options.delivery()?.pauseDispatch();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      await Promise.race([
        this.drainNonSurvivingProviders(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Update deferred: agents are still finishing work. Their current turns and approvals remain available; try again when they finish.")), 30_000);
        }),
      ]);
      if (this.options.isRetiring()) return;
      this.options.beginRetirement();
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
      this.options.setDraining(false);
      if (!this.options.isRetiring()) {
        this.options.delivery()?.resumeDispatch();
        for (const entry of (await this.options.manifest.load()).entries) this.options.requestConvergence(entry.id);
      }
    }
    await this.options.retire();
    this.prepared = true;
    // Delayed teardown exists only to flush the successful socket reply.
    setTimeout(() => {
      void this.options.finish().then(
        () => this.resolveCompletion(),
        (error) => this.rejectCompletion(error),
      );
    }, 25).unref();
  }

  /** The approval/stdio owner stays live until non-surviving providers finish. */
  private async drainNonSurvivingProviders(signal: AbortSignal): Promise<void> {
    if (!this.options.provider) return;
    const entries = (await this.options.manifest.load()).entries.filter(entry => entry.work_attempt_id);
    const protectedEntries = (await Promise.all(entries.map(async entry =>
      (await this.options.provider!.capabilities(entry.work_attempt_id!, entry.provider)).survivesRestart ? null : entry)))
      .filter((entry): entry is DaemonManifestEntry => entry !== null);
    signal.throwIfAborted();
    const protectedIds = protectedEntries.map(entry => entry.id);
    await this.options.execution?.drainDispatches(protectedIds);
    signal.throwIfAborted();
    await this.options.delivery()?.drainAdmittedTurns(protectedIds);
    signal.throwIfAborted();
    for (const entry of protectedEntries) {
      signal.throwIfAborted();
      const current = await this.options.manifest.getEntry(entry.id);
      if (!current) continue;
      const handle = this.options.currentHandle(entry.id);
      const agent = `${current.display_name} (${current.id})`;
      if (this.options.isNativeControlActive(entry.id)) {
        throw new Error(`Update deferred: ${agent} has an active native control operation. Its work has been preserved.`);
      }
      const custody = this.options.provider.runtimeCustody?.(current.work_attempt_id!, current.provider)
        ?? (handle ? { state: "owned" as const, handle } : { state: "unknown" as const });
      if (custody.state === "absent" && !handle) {
        // This daemon owns no native channels for this entry. Its historical
        // receipts remain unresolved; retiring cannot interrupt their runtime.
        continue;
      }
      const ref = current.provider_ref;
      if (custody.state === "unknown" || custody.state === "absent" || !ref
        || ref.work_attempt_id !== current.work_attempt_id
        || custody.handle.workAttemptId !== ref.work_attempt_id
        || custody.handle.providerContinuationId !== ref.provider_continuation_id
        || !sameProviderActionConnectionSnapshot(custody.handle.providerConnection, ref.provider_connection)
        || (handle && (this.options.currentExecutionGeneration(entry.id) !== ref.execution_generation_id
          || custody.handle.workAttemptId !== handle.workAttemptId
          || custody.handle.providerContinuationId !== handle.providerContinuationId
          || !sameProviderActionConnectionSnapshot(custody.handle.providerConnection, handle.providerConnection)))
        || (custody.state === "owned" && !handle)) {
        throw new Error(`Update deferred: ${agent}'s native connection could not be confirmed (custody: ${custody.state}). Its work has been preserved.`);
      }
      if (custody.state === "retired") continue;
      // Observation can outlive the native channel. Only a connection still
      // owned by this daemon needs an idle state and exact turn completion.
      const state = handle!.observedState;
      if (!["idle", "stopped", "failed", "paused", "absent"].includes(state)) {
        throw new Error(`Update deferred: ${agent} still has work that cannot survive a background-service restart (state: ${state}). Try again after it finishes.`);
      }
      const head = await this.options.inbox.head(entry.id);
      if (!head) continue;
      if (!head.provider_turn_id) {
        if (head.state === "pending" || head.state === "retryable") continue;
        // A lost native acknowledgement can leave a blocked turn without an
        // ID or counted attempt. Neither is proof that dispatch never happened.
        throw new Error(`Update deferred: ${agent}'s current turn has no confirmed completion (no native turn ID). Resolve its blocked work before updating.`);
      }
      const binding = await this.options.inbox.providerTurnBinding(head.inbox_item_id);
      if (binding && binding.origin_execution_generation_id !== current.provider_ref?.execution_generation_id) continue;
      const detail = await this.options.inbox.detail(entry.id, current.room_id, head.source_message_id);
      if (!binding || !detail.terminal || detail.terminal.outcome === "unreadable" || detail.terminal.evidence_source === "none") {
        throw new Error(`Update deferred: ${agent}'s current turn has no confirmed completion (terminal evidence unavailable). Resolve its blocked work before updating.`);
      }
    }
  }

}
