import type {
  ProviderActionHandle,
  ProviderActionPort,
  ProviderActionTerminal,
} from "./provider-action-port.js";
import { ProviderReconciler, type ReconcilerExecutionInput } from "./reconciler-runner.js";
import {
  advanceReconciliationState,
  beginReconciliationAction,
  completeReconciliationAction,
  recordReconciliationActionFailure,
} from "./reconciler-state.js";
import type {
  DaemonManifestEntry,
  ExecutionTerminalPayload,
  ReconciliationNotice,
} from "./types.js";

export type DaemonReconcileInput = Omit<
  ReconcilerExecutionInput,
  "desiredState" | "observedState" | "condition" | "exitsInWindow" | "nextRestartAtMs"
> & {
  /** Durable provider-action identity; reused ticks must keep this value. */
  reconciliationActionId: string;
  reconciliationActionSequence: number;
};

type CommitFence = (commit: () => Promise<void>) => Promise<void>;

export type ProviderReconciliationStore = {
  getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
  load(): Promise<{ entries: DaemonManifestEntry[] }>;
  replaceEntriesBatch(
    expectedGeneration: number,
    entries: DaemonManifestEntry[],
    commitFence: CommitFence,
  ): Promise<{ generation: number }>;
};

export type ProviderReconciliationTransition = (
  entryId: string,
  observedState: DaemonManifestEntry["observed_state"],
  condition: DaemonManifestEntry["condition"],
  cause: string,
  actor: string,
  reconciliation?: DaemonManifestEntry["reconciliation"],
  notice?: ReconciliationNotice["kind"],
  terminal?: ExecutionTerminalPayload,
) => Promise<void>;

export type ProviderReconciliationCoordinatorOptions = {
  provider: ProviderActionPort;
  store: ProviderReconciliationStore;
  authority: {
    assertCurrent(): Promise<void>;
    currentManifestGeneration(): number;
    acceptManifestGeneration(generation: number): void;
    fenceCommit: CommitFence;
    serializeManifest<T>(operation: () => Promise<T>): Promise<T>;
  };
  serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  transitionOnce: ProviderReconciliationTransition;
  terminalPayload(terminal: ProviderActionTerminal, actor: string): ExecutionTerminalPayload;
  observeProviderExit(
    entryId: string,
    terminal: ProviderActionTerminal,
    actor?: string,
  ): Promise<void>;
  recordSchedulerFailure(entryId: string, error: unknown, actor: string): Promise<void>;
  nowMs(): number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

/**
 * A replacement handle becomes authoritative before its listener bridge is
 * installed. If installation fails, the prior listener remains active and the
 * next serialized tick retries the promoted handle; no second native action is
 * dispatched merely because listener registration was transiently unavailable.
 */
export class ReplacementProviderListenerInstallError extends Error {}

/** Owns durable provider-action reconciliation and its periodic listener bridge. */
export class ProviderReconciliationCoordinator {
  private readonly scheduled = new Map<string, Promise<{ dispose: () => Promise<void> }>>();
  private readonly scheduledCancels = new Map<string, () => void>();
  private readonly setTimer: typeof setInterval;
  private readonly clearTimer: typeof clearInterval;

  constructor(private readonly options: ProviderReconciliationCoordinatorOptions) {
    this.setTimer = options.setInterval ?? setInterval;
    this.clearTimer = options.clearInterval ?? clearInterval;
  }

  async reconcile(
    entryId: string,
    input: DaemonReconcileInput,
    watchdogThresholdMs: number,
    actor = "reconciler",
  ) {
    return this.options.serializeEntry(
      entryId,
      () => this.options.authority.serializeManifest(
        () => this.reconcileOnce(entryId, input, watchdogThresholdMs, actor),
      ),
    );
  }

  private async reconcileOnce(
    entryId: string,
    input: DaemonReconcileInput,
    watchdogThresholdMs: number,
    actor: string,
  ) {
    const { authority, provider, store, transitionOnce } = this.options;
    await authority.assertCurrent();
    const entry = await store.getEntry(entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);

    let reconciliation = advanceReconciliationState(
      entry.reconciliation,
      entry.observed_state,
      input.nowMs,
    );
    if (JSON.stringify(reconciliation) !== JSON.stringify(entry.reconciliation)) {
      const next = await store.replaceEntriesBatch(
        authority.currentManifestGeneration(),
        [{ ...entry, reconciliation }],
        authority.fenceCommit,
      );
      authority.acceptManifestGeneration(next.generation);
    }

    let redispatchPending = false;
    let redispatchKind: "poke" | "restart_fresh" | "restart_with_resume" | "stop" | undefined;
    let redispatchActionId = input.reconciliationActionId;
    let redispatchActionSequence = input.reconciliationActionSequence;
    if (reconciliation.pending_action) {
      const pending = reconciliation.pending_action;
      const attachment = await provider.attachAction(pending.id, input.workAttemptId);
      if (attachment.state === "attached") {
        reconciliation = completeReconciliationAction(reconciliation, pending.id);
        await transitionOnce(
          entryId,
          attachment.handle.observedState,
          entry.condition,
          "reconciled pending provider action",
          actor,
          reconciliation,
        );
      }
      if (attachment.state === "absent") {
        redispatchPending = true;
        redispatchActionId = pending.id;
        redispatchActionSequence = pending.sequence;
        redispatchKind = pending.kind;
      }
      if (attachment.state === "ambiguous") {
        const reason = `pending provider action ambiguous: ${attachment.reason}`;
        await transitionOnce(
          entryId,
          "recovering",
          "coordination_blocked",
          reason,
          actor,
          reconciliation,
        );
        return {
          decision: {
            action: "hold_coordination" as const,
            observedState: "recovering" as const,
            condition: "coordination_blocked" as const,
            reason,
          },
          disposition: "held" as const,
        };
      }
      if (attachment.state === "attached") {
        return {
          decision: {
            action: "hold_coordination" as const,
            observedState: attachment.handle.observedState,
            condition: entry.condition,
            reason: "pending provider action attached; await next convergence tick",
          },
          disposition: "held" as const,
        };
      }
    }

    if (redispatchPending && entry.desired_state === "stopped" && redispatchKind !== "stop") {
      reconciliation = completeReconciliationAction(reconciliation, redispatchActionId);
      redispatchPending = false;
      redispatchKind = undefined;
      redispatchActionId = input.reconciliationActionId;
      redispatchActionSequence = input.reconciliationActionSequence;
      await transitionOnce(
        entryId,
        entry.observed_state,
        entry.condition,
        "cancelled pending provider action because desired state is stopped",
        actor,
        reconciliation,
      );
    }
    if (redispatchPending && entry.condition === "quarantined") {
      reconciliation = completeReconciliationAction(reconciliation, redispatchActionId);
      await transitionOnce(
        entryId,
        entry.observed_state,
        "quarantined",
        "cancelled pending provider action because entry is quarantined",
        actor,
        reconciliation,
      );
      return {
        decision: {
          action: "quarantine" as const,
          observedState: entry.observed_state,
          condition: "quarantined" as const,
          reason: "quarantined entry cannot redispatch pending provider action",
        },
        disposition: "held" as const,
      };
    }
    if (redispatchPending
      && ["restart_fresh", "restart_with_resume"].includes(redispatchKind ?? "")
      && input.activeLease) {
      const reason = "pending provider action awaits fenced lease rebind";
      await transitionOnce(
        entryId,
        "recovering",
        "coordination_blocked",
        reason,
        actor,
        reconciliation,
      );
      return {
        decision: {
          action: "hold_coordination" as const,
          observedState: "recovering" as const,
          condition: "coordination_blocked" as const,
          reason,
        },
        disposition: "held" as const,
      };
    }

    const result = await new ProviderReconciler(provider).reconcile({
      ...input,
      actionId: redispatchActionId,
      forcedAction: redispatchKind,
      desiredState: entry.desired_state,
      observedState: entry.observed_state,
      condition: entry.condition,
      exitsInWindow: reconciliation.exit_timestamps_ms.length,
      nextRestartAtMs: reconciliation.next_restart_at_ms,
    }, watchdogThresholdMs, {
      beforeAction: async (kind) => {
        if (redispatchPending) return;
        reconciliation = beginReconciliationAction(reconciliation, {
          id: redispatchActionId,
          sequence: redispatchActionSequence,
          kind,
          recorded_at_ms: input.nowMs,
        });
        await transitionOnce(
          entryId,
          entry.observed_state,
          entry.condition,
          `persisted ${kind} action intent`,
          actor,
          reconciliation,
        );
      },
    });
    const finalReconciliation = result.disposition === "failed"
      ? recordReconciliationActionFailure(reconciliation, redispatchActionId, input.nowMs)
      : result.disposition === "executed"
        ? completeReconciliationAction(reconciliation, redispatchActionId)
        : reconciliation;
    const target = result.disposition === "failed"
      ? { observedState: "failed" as const, condition: "none" as const }
      : { observedState: result.decision.observedState, condition: result.decision.condition };
    if (target.observedState !== entry.observed_state
      || target.condition !== entry.condition
      || JSON.stringify(finalReconciliation) !== JSON.stringify(reconciliation)) {
      await transitionOnce(
        entryId,
        target.observedState,
        target.condition,
        result.decision.reason,
        actor,
        finalReconciliation,
      );
    }
    return result;
  }

  async schedule(
    entryId: string,
    handle: ProviderActionHandle,
    input: () => DaemonReconcileInput,
    watchdogThresholdMs: number,
    intervalMs: number,
    actor = "reconciler",
  ): Promise<() => Promise<void>> {
    const existing = this.scheduled.get(entryId);
    if (existing) return (await existing).dispose;
    let resolveReservation!: (control: { dispose: () => Promise<void> }) => void;
    const reservation = new Promise<{ dispose: () => Promise<void> }>((resolve) => {
      resolveReservation = resolve;
    });
    this.scheduled.set(entryId, reservation);
    let timer: ReturnType<typeof setInterval> | null = null;
    let unsubscribe = () => {};
    try {
      let stopped = false;
      let currentHandle = handle;
      let currentHandleGeneration = 0;
      let listenerInstalledGeneration = 0;
      let listenerInstallTail: Promise<void> = Promise.resolve();
      const activeCallbacks = new Set<Promise<void>>();
      const cancel = () => {
        if (stopped) return;
        stopped = true;
        const failures: unknown[] = [];
        if (timer) {
          try { this.clearTimer(timer); } catch (error) { failures.push(error); }
        }
        try { unsubscribe(); } catch (error) { failures.push(error); }
        if (this.scheduled.get(entryId) === reservation) this.scheduled.delete(entryId);
        if (this.scheduledCancels.get(entryId) === cancel) this.scheduledCancels.delete(entryId);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, `Provider reconciliation cleanup failed for ${entryId}.`);
        }
      };
      this.scheduledCancels.set(entryId, cancel);
      const trackCallback = (operation: Promise<void>) => {
        activeCallbacks.add(operation);
        void operation.then(
          () => activeCallbacks.delete(operation),
          () => activeCallbacks.delete(operation),
        );
      };
      const recordError = async (error: unknown) => {
        await this.options.recordSchedulerFailure(entryId, error, actor);
      };
      const sameHandle = (left: ProviderActionHandle, right: ProviderActionHandle) =>
        left.workAttemptId === right.workAttemptId
        && left.pid === right.pid
        && left.providerContinuationId === right.providerContinuationId;
      const recordStaleExit = async (
        staleHandle: ProviderActionHandle,
        terminal: ProviderActionTerminal,
      ) => {
        const payload = this.options.terminalPayload(terminal, actor);
        await this.options.serializeEntry(entryId, () => this.options.authority.serializeManifest(async () => {
          const entry = (await this.options.store.load()).entries.find(
            (candidate) => candidate.id === entryId,
          );
          if (!entry) return;
          await this.options.transitionOnce(
            entryId,
            entry.observed_state,
            entry.condition,
            `stale terminal from superseded provider handle pid=${staleHandle.pid ?? "unknown"}`,
            actor,
            {
              ...advanceReconciliationState(
                entry.reconciliation,
                entry.observed_state,
                this.options.nowMs(),
              ),
              last_terminal: payload,
            },
            "coordination_escalation",
            payload,
          );
        }));
      };
      const installExitListener = async (nextHandle: ProviderActionHandle, generation: number) => {
        let nextUnsubscribe: () => void;
        try {
          nextUnsubscribe = await this.options.provider.onExit(nextHandle, (terminal) => {
            const operation = (async () => {
              try {
                if (generation !== currentHandleGeneration || !sameHandle(nextHandle, currentHandle)) {
                  await recordStaleExit(nextHandle, terminal);
                  return;
                }
                await this.options.observeProviderExit(entryId, terminal, actor);
                await tick();
              } catch (error) {
                try {
                  await recordError(error);
                } catch {
                  // A fenced daemon cannot persist after losing authority.
                }
              }
            })();
            trackCallback(operation);
          });
        } catch (error) {
          if (generation > 1) {
            throw new ReplacementProviderListenerInstallError(
              error instanceof Error ? error.message : "replacement listener installation failed",
            );
          }
          throw error;
        }
        if (stopped || generation !== currentHandleGeneration || !sameHandle(nextHandle, currentHandle)) {
          nextUnsubscribe();
          return;
        }
        const previousUnsubscribe = unsubscribe;
        unsubscribe = nextUnsubscribe;
        listenerInstalledGeneration = generation;
        previousUnsubscribe();
      };
      const enqueueExitListenerInstall = (nextHandle: ProviderActionHandle, generation: number) => {
        const operation = listenerInstallTail.then(
          () => installExitListener(nextHandle, generation),
        );
        listenerInstallTail = operation.catch(() => undefined);
        return operation;
      };
      const queueExitListenerInstall = (nextHandle: ProviderActionHandle) => {
        currentHandle = nextHandle;
        currentHandleGeneration += 1;
        return enqueueExitListenerInstall(nextHandle, currentHandleGeneration);
      };
      let tickTail: Promise<void> = Promise.resolve();
      const tick = () => {
        const operation = tickTail.then(async () => {
          if (stopped) return;
          if (listenerInstalledGeneration !== currentHandleGeneration) {
            await enqueueExitListenerInstall(currentHandle, currentHandleGeneration);
          }
          const result = await this.reconcile(
            entryId,
            { ...input(), handle: currentHandle },
            watchdogThresholdMs,
            actor,
          );
          if (!stopped && result.replacementHandle) {
            await queueExitListenerInstall(result.replacementHandle);
          }
        });
        tickTail = operation.catch(() => undefined);
        return operation;
      };
      timer = this.setTimer(() => {
        trackCallback(tick().catch(async (error) => {
          try {
            await recordError(error);
          } catch {
            // See terminal callback.
          }
        }));
      }, intervalMs);
      timer.unref?.();
      await queueExitListenerInstall(handle);
      try {
        await tick();
      } catch (error) {
        if (error instanceof ReplacementProviderListenerInstallError) await recordError(error);
        else throw error;
      }
      const dispose = async () => {
        const failures: unknown[] = [];
        try { cancel(); } catch (error) { failures.push(error); }
        try { await Promise.all([...activeCallbacks]); } catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, `Provider reconciliation disposal failed for ${entryId}.`);
        }
      };
      resolveReservation({ dispose });
      return dispose;
    } catch (error) {
      let failure: unknown = error;
      try { this.scheduledCancels.get(entryId)?.(); } catch (cleanupError) {
        failure = new AggregateError(
          [error, cleanupError],
          `Provider reconciliation setup and cleanup failed for ${entryId}.`,
        );
      }
      try {
        await this.options.recordSchedulerFailure(entryId, failure, actor);
      } catch {
        // Preserve the original setup failure for the caller.
      }
      resolveReservation({ dispose: async () => {} });
      if (this.scheduled.get(entryId) === reservation) this.scheduled.delete(entryId);
      throw failure;
    }
  }

  async disposeAll(): Promise<void> {
    // Snapshot before invoking dispose: each dispose removes its own maps.
    // Promise.all intentionally preserves the daemon's HEAD failure semantics
    // while eagerly invoking every disposal and draining its active callbacks.
    const reservations = [...this.scheduled.values()];
    await Promise.all(reservations.map(async (reservation) => (await reservation).dispose()));
  }

  /** Handoff detaches observers but must not wait on a wedged provider callback. */
  detachAll(): void {
    const failures: unknown[] = [];
    for (const cancel of [...this.scheduledCancels.values()]) {
      try { cancel(); } catch (error) { failures.push(error); }
    }
    this.scheduledCancels.clear();
    this.scheduled.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Provider reconciliation handoff cleanup failed.");
    }
  }
}
