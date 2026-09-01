import type { WorkDurabilityStore } from "./durability-store.js";
import type {
  ProviderActionHandle,
  ProviderActionTerminal,
} from "./provider-action-port.js";
import { sameProviderActionConnectionSnapshot } from "./provider-action-port.js";
import type { ProviderInstallationToken } from "./provider-stream-coordinator.js";
import { advanceReconciliationState } from "./reconciler-state.js";
import type {
  DaemonManifestEntry,
  ExecutionTerminalPayload,
  ObservedState,
  PolicyCondition,
  ReconciliationNotice,
} from "./types.js";

export type ProviderTerminalPorts = {
  currentDaemonGeneration(): number;
  nowMs(): number;
  liveHandles: Map<string, ProviderActionHandle>;
  manifest: {
    getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
    load(): Promise<{ entries: DaemonManifestEntry[] }>;
  };
  durability: Pick<
    WorkDurabilityStore,
    "getAttempt" | "recordTerminal" | "releaseTerminalExecutionFence"
  >;
  runtimeCustody: {
    deletePendingResumeBinding(entryId: string): void;
  };
  streams: {
    remove(installation: ProviderInstallationToken): boolean;
    isLatestInstallation(installation: ProviderInstallationToken): boolean;
  };
  delivery: {
    start(entryId: string): Promise<void>;
  };
  serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  serializeManifest<T>(operation: () => Promise<T>): Promise<T>;
  transitionOnce(
    entryId: string,
    to: ObservedState,
    condition: PolicyCondition,
    cause: string,
    actor: string,
    reconciliation?: DaemonManifestEntry["reconciliation"],
    notice?: ReconciliationNotice["kind"],
    terminal?: ExecutionTerminalPayload,
  ): Promise<void>;
  requestConvergence(entryId: string): void;
};

/** Owns terminal evidence, exact-handle retirement, and exit-state projection. */
export class ProviderTerminalCoordinator {
  constructor(private readonly ports: ProviderTerminalPorts) {}

  terminalPayload(
    terminal: ProviderActionTerminal,
    actor: string,
  ): ExecutionTerminalPayload {
    return {
      ended_at: terminal.endedAt,
      exit_code: terminal.exitCode,
      signal: terminal.signal,
      stdio_archive_ref: null,
      stdio_tail: "",
      terminal_cause: terminal.terminalCause,
      actor,
      generation: this.ports.currentDaemonGeneration(),
      provider_continuation_id: terminal.providerContinuationId,
    };
  }

  async handleTerminal(
    installation: ProviderInstallationToken,
    terminal: ProviderActionTerminal,
  ): Promise<void> {
    const { entryId, handle, executionGenerationId } = installation;
    if (!this.ports.streams.remove(installation)) return;
    this.ports.runtimeCustody.deletePendingResumeBinding(entryId);
    let shouldStartDelivery = false;
    await this.ports.serializeEntry(entryId, async () => {
      if (!this.ports.streams.isLatestInstallation(installation)) return;
      const entry = (await this.ports.manifest.load()).entries.find((candidate) =>
        candidate.id === entryId);
      if (!entry || !this.matchesInstallation(entry, installation)) return;
      if (this.ports.liveHandles.get(entryId)) return;
      if (entry?.work_attempt_id) {
        const attempt = await this.ports.durability.getAttempt(entry.work_attempt_id);
        if (!this.ports.streams.isLatestInstallation(installation)
          || this.ports.liveHandles.get(entryId)) return;
        const execution = attempt.execution_generations.find((candidate) =>
          candidate.execution_generation_id === executionGenerationId);
        if (execution && !execution.terminal) {
          await this.ports.durability.recordTerminal(
            entry.work_attempt_id,
            execution.execution_generation_id,
            {
              ...this.terminalPayload(terminal, execution.actor),
              generation: execution.generation,
            },
          );
        }
        if (entry.desired_state === "stopped") {
          await this.ports.durability.releaseTerminalExecutionFence(
            entry.work_attempt_id,
            executionGenerationId,
          );
        }
      }
      if (!this.ports.streams.isLatestInstallation(installation)
        || this.ports.liveHandles.get(entryId)) return;
      // The owner-only credential remains available for an exact successor;
      // only its live publication authority was removed with the handle.
      await this.observeExitOnce(
        entryId,
        terminal,
        "daemon-provider",
        executionGenerationId,
        handle,
        installation,
      );
      if (!this.ports.streams.isLatestInstallation(installation)
        || this.ports.liveHandles.get(entryId)) return;
      this.ports.requestConvergence(entryId);
      shouldStartDelivery = entry.desired_state === "running";
    });
    if (shouldStartDelivery && this.ports.streams.isLatestInstallation(installation)
      && !this.ports.liveHandles.get(entryId)) {
      void this.ports.delivery.start(entryId).catch(() => undefined);
    }
  }

  private matchesInstallation(
    entry: DaemonManifestEntry,
    installation: ProviderInstallationToken,
  ): boolean {
    return entry.work_attempt_id === installation.workAttemptId
      && entry.provider_ref?.work_attempt_id === installation.workAttemptId
      && entry.provider_ref.provider_continuation_id === installation.providerContinuationId
      && entry.provider_ref.execution_generation_id === installation.executionGenerationId
      && sameProviderActionConnectionSnapshot(
        entry.provider_ref.provider_connection,
        installation.providerConnection,
      );
  }

  async observeExit(
    entryId: string,
    terminal: ProviderActionTerminal,
    actor = "provider",
    expectedExecutionGenerationId?: string,
    expectedHandle?: ProviderActionHandle,
  ): Promise<void> {
    await this.ports.serializeEntry(entryId, () =>
      this.observeExitOnce(
        entryId,
        terminal,
        actor,
        expectedExecutionGenerationId,
        expectedHandle,
      ));
  }

  async observeExitOnce(
    entryId: string,
    terminal: ProviderActionTerminal,
    actor: string,
    expectedExecutionGenerationId?: string,
    expectedHandle?: ProviderActionHandle,
    expectedInstallation?: ProviderInstallationToken,
  ): Promise<void> {
    await this.ports.serializeManifest(async () => {
      if (expectedInstallation
        && !this.ports.streams.isLatestInstallation(expectedInstallation)) return;
      const manifest = await this.ports.manifest.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
      if (expectedExecutionGenerationId
        && entry.provider_ref?.execution_generation_id !== expectedExecutionGenerationId) return;
      const currentHandle = this.ports.liveHandles.get(entryId);
      if (expectedHandle && currentHandle && currentHandle !== expectedHandle) return;
      if (expectedInstallation && !this.matchesInstallation(entry, expectedInstallation)) return;
      const payload = this.terminalPayload(terminal, actor);
      if (entry.condition === "quarantined") {
        await this.ports.transitionOnce(
          entryId,
          entry.observed_state,
          "quarantined",
          `late provider terminal: ${terminal.terminalCause}`,
          actor,
          {
            ...advanceReconciliationState(
              entry.reconciliation,
              entry.observed_state,
              this.ports.nowMs(),
            ),
            last_terminal: payload,
          },
          "quarantine_death",
          payload,
        );
        return;
      }
      const control = entry.turn_control;
      const completedStopTurn = entry.desired_state === "running"
        && terminal.terminalCause === "stopped"
        && control?.execution_generation_id === entry.provider_ref?.execution_generation_id
        && control?.status === "completed"
        && control?.has_correction === false
        && control?.interrupted === true
        && control?.resumed === false
        && control?.state === "idle";
      const intentional = entry.desired_state === "stopped"
        || entry.desired_state === "paused"
        || completedStopTurn;
      const observedState = completedStopTurn
        ? "idle"
        : entry.desired_state === "paused"
          ? "paused"
          : intentional
            ? "stopped"
            : "failed";
      const reconciliation = {
        ...advanceReconciliationState(entry.reconciliation, observedState, this.ports.nowMs()),
        last_terminal: payload,
      };
      await this.ports.transitionOnce(
        entryId,
        observedState,
        "none",
        completedStopTurn
          ? "provider terminal completed intentional stop-turn"
          : `provider terminal: ${terminal.terminalCause}`,
        actor,
        reconciliation,
      );
    });
  }
}
