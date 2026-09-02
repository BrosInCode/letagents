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

type PlannedConfigurationReplacement = {
  settled: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

/** Owns terminal evidence, exact-handle retirement, and exit-state projection. */
export class ProviderTerminalCoordinator {
  private readonly plannedConfigurationReplacements = new WeakMap<
    ProviderInstallationToken,
    PlannedConfigurationReplacement
  >();

  constructor(private readonly ports: ProviderTerminalPorts) {}

  /**
   * Stop one exact installation as an intentional configuration replacement.
   * The reservation is installed before native stop so an onExit callback that
   * wins the race receives the same classification as the returned terminal.
   */
  async replaceConfiguration(
    installation: ProviderInstallationToken,
    stop: () => Promise<ProviderActionTerminal>,
  ): Promise<void> {
    if (!this.ports.streams.isLatestInstallation(installation)
      || this.ports.liveHandles.get(installation.entryId) !== installation.handle) {
      throw new Error("Provider installation changed before configuration replacement.");
    }
    if (this.plannedConfigurationReplacements.has(installation)) {
      throw new Error("Configuration replacement is already in progress.");
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const settled = new Promise<void>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    void settled.catch(() => undefined);
    const replacement = { settled, resolve, reject };
    this.plannedConfigurationReplacements.set(installation, replacement);
    let terminal: ProviderActionTerminal;
    try {
      terminal = await stop();
    } catch (error) {
      if (this.ports.streams.isLatestInstallation(installation)
        && this.ports.liveHandles.get(installation.entryId) === installation.handle) {
        if (this.plannedConfigurationReplacements.get(installation) === replacement) {
          this.plannedConfigurationReplacements.delete(installation);
        }
        replacement.resolve();
        throw error;
      }
      // onExit removed the exact live installation before stop rejected.
      // Its terminal handler remains the sole source of durable classification.
      await replacement.settled;
      return;
    }
    await this.handleTerminal(installation, terminal);
    await replacement.settled;
  }

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
    const replacement = this.plannedConfigurationReplacements.get(installation);
    if (!this.ports.streams.remove(installation)) return;
    let replacementObserved = false;
    try {
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
          Boolean(replacement),
        );
        replacementObserved = Boolean(replacement);
        if (!this.ports.streams.isLatestInstallation(installation)
          || this.ports.liveHandles.get(entryId)) return;
        if (!replacement) {
          this.ports.requestConvergence(entryId);
          shouldStartDelivery = entry.desired_state === "running";
        }
      });
      if (replacement && !replacementObserved) {
        throw new Error("Configuration replacement lost exact provider coordinates.");
      }
      if (shouldStartDelivery && this.ports.streams.isLatestInstallation(installation)
        && !this.ports.liveHandles.get(entryId)) {
        void this.ports.delivery.start(entryId).catch(() => undefined);
      }
      replacement?.resolve();
    } catch (error) {
      replacement?.reject(error);
      throw error;
    } finally {
      if (replacement && this.plannedConfigurationReplacements.get(installation) === replacement) {
        this.plannedConfigurationReplacements.delete(installation);
      }
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
    plannedConfigurationReplacement = false,
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
      const intentional = plannedConfigurationReplacement
        || entry.desired_state === "stopped"
        || entry.desired_state === "paused"
        || completedStopTurn;
      const observedState = plannedConfigurationReplacement
        ? "recovering"
        : completedStopTurn
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
        plannedConfigurationReplacement
          ? "provider terminal completed intentional configuration replacement"
          : completedStopTurn
            ? "provider terminal completed intentional stop-turn"
            : `provider terminal: ${terminal.terminalCause}`,
        actor,
        reconciliation,
      );
    });
  }
}
