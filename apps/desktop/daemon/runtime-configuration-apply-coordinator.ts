import type { EntryConcurrencyGate } from "./entry-concurrency-gate.js";
import type { ManifestStore } from "./manifest-store.js";
import type { ProviderActionPort } from "./provider-action-port.js";
import { sameProviderActionConnectionSnapshot } from "./provider-action-port.js";
import type { ProviderInstallationToken } from "./provider-stream-coordinator.js";
import type { ProviderTerminalCoordinator } from "./provider-terminal-coordinator.js";
import type { SupervisedAgentDelivery } from "./supervised-agent-delivery.js";
import type { SupervisedAgentInboxStore } from "./supervised-agent-inbox-store.js";

export type ApplyAgentConfigurationInput = {
  entryId: string;
  daemonGeneration: number;
  expectedConfigurationRevision: number;
};

export type ApplyAgentConfigurationResult = {
  outcome: "already_applied" | "restarting" | "busy_active_turn" | "conflict" | "unsupported";
};

type ReadyReplacement = {
  outcome: "ready";
  installation: ProviderInstallationToken;
};

type ApplyInspection = ReadyReplacement | ApplyAgentConfigurationResult;

export type RuntimeConfigurationApplyCoordinatorOptions = {
  store: Pick<ManifestStore,
    | "getEntry"
    | "getAgentConfiguration"
    | "pendingRoomMoves"
    | "unresolvedDeliveryDrain"
    | "unresolvedPollingActivation"
  >;
  inbox: Pick<SupervisedAgentInboxStore, "head">;
  delivery: Pick<SupervisedAgentDelivery, "stopIfIdle"> | null;
  provider?: Pick<ProviderActionPort, "stop">;
  streams: {
    currentInstallation(entryId: string): ProviderInstallationToken | undefined;
  };
  terminals: Pick<ProviderTerminalCoordinator, "replaceConfiguration">;
  entryConcurrency: Pick<
    EntryConcurrencyGate,
    "beginLifecycle" | "bumpControlEpoch" | "waitForActiveRoomMove" | "run"
  >;
  authority: {
    assertCurrent(): Promise<void>;
    currentDaemonGeneration(): number;
    isHandoffScheduled(): boolean;
  };
  requestConvergence(entryId: string): void;
};

/** Applies a saved configuration only by replacing a provably idle runtime. */
export class RuntimeConfigurationApplyCoordinator {
  constructor(private readonly options: RuntimeConfigurationApplyCoordinatorOptions) {}

  async apply(input: ApplyAgentConfigurationInput): Promise<ApplyAgentConfigurationResult> {
    if (!input.entryId.trim()
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1
      || !Number.isSafeInteger(input.expectedConfigurationRevision)
      || input.expectedConfigurationRevision < 1) return { outcome: "conflict" };
    if (input.daemonGeneration !== this.options.authority.currentDaemonGeneration()) {
      return { outcome: "conflict" };
    }
    const preflight = await this.inspect(input);
    if (preflight.outcome !== "ready") return preflight;
    if (!this.options.delivery || !this.options.provider) return { outcome: "unsupported" };
    let release: (() => void) | null = null;
    try {
      release = this.options.entryConcurrency.beginLifecycle(input.entryId);
    } catch {
      return { outcome: "conflict" };
    }
    try {
      await this.options.entryConcurrency.waitForActiveRoomMove(input.entryId);
      const before = await this.inspect(input);
      if (before.outcome !== "ready") return before;
      this.options.entryConcurrency.bumpControlEpoch(input.entryId);
      if (!await this.options.delivery.stopIfIdle(input.entryId)) {
        return { outcome: "busy_active_turn" };
      }
      const after = await this.inspect(input);
      if (after.outcome !== "ready") return after;
      if (after.installation !== before.installation) return { outcome: "conflict" };
      await this.options.terminals.replaceConfiguration(after.installation, () =>
        this.options.provider!.stop(after.installation.handle, {
          actionId: `manifest:${input.entryId}:apply-configuration:${input.expectedConfigurationRevision}:${after.installation.executionGenerationId}`,
        }));
      return { outcome: "restarting" };
    } finally {
      release();
      // Lifecycle admission may have excluded a room move that raced the
      // read-only preflight. Reconcile after exclusion ends even if the exact
      // second inspection prevented a provider fence.
      this.options.requestConvergence(input.entryId);
    }
  }

  private inspect(input: ApplyAgentConfigurationInput): Promise<ApplyInspection> {
    return this.options.entryConcurrency.run(input.entryId, async () => {
      await this.options.authority.assertCurrent();
      if (this.options.authority.isHandoffScheduled()
        || input.daemonGeneration !== this.options.authority.currentDaemonGeneration()) {
        return { outcome: "conflict" };
      }
      const entry = await this.options.store.getEntry(input.entryId);
      const configuration = await this.options.store.getAgentConfiguration(input.entryId);
      if (!entry || !configuration
        || configuration.config_revision !== input.expectedConfigurationRevision) {
        return { outcome: "conflict" };
      }
      if (configuration.config_revision === configuration.runtime_configuration_revision) {
        return { outcome: "already_applied" };
      }
      if (configuration.config_revision < configuration.runtime_configuration_revision) {
        return { outcome: "conflict" };
      }
      if (entry.desired_state !== "running" || entry.delivery_mode !== "daemon_inbox") {
        return { outcome: "unsupported" };
      }
      if (entry.condition !== "none"
        || !entry.provider_ref
        || !entry.work_attempt_id
        || !["idle", "working"].includes(entry.observed_state)) {
        return { outcome: "conflict" };
      }
      if (entry.observed_state !== "idle") return { outcome: "busy_active_turn" };
      if (entry.turn_control && entry.turn_control.status !== "completed") {
        return { outcome: "busy_active_turn" };
      }
      if ((await this.options.store.pendingRoomMoves(input.entryId)).length > 0
        || await this.options.store.unresolvedDeliveryDrain(input.entryId)
        || await this.options.store.unresolvedPollingActivation(input.entryId)) {
        return { outcome: "conflict" };
      }
      const head = await this.options.inbox.head(input.entryId);
      if (head && (head.state !== "pending" || head.provider_turn_id !== null)) {
        return { outcome: "busy_active_turn" };
      }
      const installation = this.options.streams.currentInstallation(input.entryId);
      if (!installation
        || installation.configurationRevision !== configuration.runtime_configuration_revision
        || installation.handle.appliedConfigurationRevision !== configuration.runtime_configuration_revision
        || installation.handle.observedState !== "idle"
        || installation.workAttemptId !== entry.work_attempt_id
        || entry.provider_ref.work_attempt_id !== installation.workAttemptId
        || entry.provider_ref.execution_generation_id !== installation.executionGenerationId
        || entry.provider_ref.provider_continuation_id !== installation.providerContinuationId
        || !sameProviderActionConnectionSnapshot(
          entry.provider_ref.provider_connection,
          installation.providerConnection,
        )) return { outcome: "conflict" };
      return { outcome: "ready", installation };
    });
  }
}
