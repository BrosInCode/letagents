import {
  exhaustedTransientWorkerMint,
  providerRuntimeGoneFailure,
  schedulerErrorDetail,
  transientProviderStartFailure,
} from "./daemon-error-policy.js";
import { advanceReconciliationState } from "./reconciler-state.js";
import type {
  DaemonManifestEntry,
  ExecutionTerminalPayload,
  ObservedState,
  PolicyCondition,
  ReconciliationNotice,
} from "./types.js";
import { UnusableSourceRepositoryError } from "./workspace-provisioner.js";

const PROVIDER_START_RETRY_LIMIT = 3;
const WORKER_MINT_RECOVERY_RETRY_LIMIT = 5;

export type ProviderSchedulerFailurePorts = {
  nativeHeartbeatIntervalMs: number;
  currentDaemonGeneration(): number;
  nowMs(): number;
  serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  serializeManifest<T>(operation: () => Promise<T>): Promise<T>;
  manifest: {
    load(): Promise<{ entries: DaemonManifestEntry[] }>;
    updateEntry(
      entryId: string,
      update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
    ): Promise<DaemonManifestEntry>;
  };
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
  audit: {
    append(event: {
      at: string;
      entry_id: string;
      from: ObservedState;
      to: ObservedState;
      cause: string;
      actor: string;
      generation: number;
    }): Promise<void>;
  };
  scheduleRecovery(entryId: string, delayMs: number): void;
};

/** Owns bounded retry accounting and durable projection of scheduler failures. */
export class ProviderSchedulerFailureCoordinator {
  private readonly providerStartRetryAttempts = new Map<string, number>();
  private readonly workerMintRecoveryRetryAttempts = new Map<string, number>();

  constructor(private readonly ports: ProviderSchedulerFailurePorts) {}

  resetMintRecovery(entryId: string): void {
    this.workerMintRecoveryRetryAttempts.delete(entryId);
  }

  clearSuccessfulRecovery(entryId: string): void {
    this.providerStartRetryAttempts.delete(entryId);
    this.workerMintRecoveryRetryAttempts.delete(entryId);
  }

  async record(entryId: string, error: unknown, actor: string): Promise<void> {
    const message = schedulerErrorDetail(error);
    // A provably gone saved runtime cannot recover through another resume.
    // Retire its continuation and let ordinary crash-loop policy replace it.
    if (providerRuntimeGoneFailure(error)) {
      let didReset = false;
      await this.ports.serializeEntry(entryId, () => this.ports.manifest.updateEntry(entryId, (current) => {
        if (current.desired_state !== "running"
          || current.condition === "quarantined"
          || !current.provider_ref) return current;
        didReset = true;
        return {
          ...current,
          observed_state: "failed",
          condition: "none",
          last_error: "The previous provider runtime stopped; starting a replacement.",
          provider_ref: null,
          last_worker_binding: null,
          reconciliation: advanceReconciliationState(current.reconciliation, "failed", this.ports.nowMs()),
        };
      }));
      if (didReset) {
        await this.ports.audit.append({
          at: new Date().toISOString(),
          entry_id: entryId,
          from: "recovering",
          to: "failed",
          cause: "provider runtime is gone; recovering with a fresh runtime",
          actor,
          generation: this.ports.currentDaemonGeneration(),
        });
        this.ports.scheduleRecovery(entryId, 1_000);
      }
      return;
    }

    await this.ports.serializeEntry(entryId, () => this.ports.serializeManifest(async () => {
      const manifest = await this.ports.manifest.load();
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return;
      const condition = entry.condition === "quarantined" ? "quarantined" : "coordination_blocked";
      const observedState = !entry.work_attempt_id && !entry.provider_ref
        ? "failed"
        : entry.observed_state;
      const lastError = error instanceof UnusableSourceRepositoryError
        ? error.message
        : `convergence scheduler failure: ${message}`;
      await this.ports.transitionOnce(
        entryId,
        observedState,
        condition,
        lastError,
        actor,
        undefined,
        "coordination_escalation",
      );
    }));

    if (exhaustedTransientWorkerMint(error)) {
      const attempts = (this.workerMintRecoveryRetryAttempts.get(entryId) ?? 0) + 1;
      this.workerMintRecoveryRetryAttempts.set(entryId, attempts);
      if (attempts <= WORKER_MINT_RECOVERY_RETRY_LIMIT) {
        this.ports.scheduleRecovery(entryId, this.ports.nativeHeartbeatIntervalMs);
      }
      return;
    }
    if (transientProviderStartFailure(error)) {
      const attempts = (this.providerStartRetryAttempts.get(entryId) ?? 0) + 1;
      this.providerStartRetryAttempts.set(entryId, attempts);
      if (attempts <= PROVIDER_START_RETRY_LIMIT) {
        this.ports.scheduleRecovery(entryId, this.ports.nativeHeartbeatIntervalMs);
      }
    }
  }
}
