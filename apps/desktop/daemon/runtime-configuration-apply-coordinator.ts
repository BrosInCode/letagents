import { ManagedRuntimeRefreshDeferred } from "./provider-action-port.js";
import { agentUsesHomeHarness } from "./provider-configuration.js";
import { devMcpServerEntryFromEnv } from "./dev-spawn-options.js";
import type { WorkerBindingStore } from "./worker-binding-store.js";
import type { EntryConcurrencyGate } from "./entry-concurrency-gate.js";
import type { ManifestStore } from "./manifest-store.js";
import type { ProviderActionPort } from "./provider-action-port.js";
import { sameProviderActionConnectionSnapshot } from "./provider-action-port.js";
import type { ProviderInstallationToken } from "./provider-stream-coordinator.js";
import type { ProviderTerminalCoordinator } from "./provider-terminal-coordinator.js";
import type { SupervisedAgentDelivery, SupervisedIngressAgent } from "./supervised-agent-delivery.js";
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
  roomId: string;
};

type ManagedReplacement = { contract: string; apiUrl: string };

type ApplyInspection = ReadyReplacement | ApplyAgentConfigurationResult;

/** The agent is still to be replaced: convergence should run again after this long. `notice` is for its activity. */
export type ManagedRefreshRetry = { retryAfterMs: number; notice?: string };

const OWNER_SETUP_END_RETRY_BASE_MS = 1_000;
const OWNER_SETUP_END_RETRY_MAX_MS = 30_000;
/** After this many tries that found the agent neither busy nor replaceable, its owner is told it is still waiting. */
const OWNER_SETUP_END_NOTICE_AFTER = 5;

export type RuntimeConfigurationApplyCoordinatorOptions = {
  store: Pick<ManifestStore,
    | "getEntry"
    | "getAgentConfiguration"
    | "pendingRoomMoves"
    | "unresolvedDeliveryDrain"
    | "unresolvedPollingActivation"
  >;
  inbox: Pick<SupervisedAgentInboxStore, "head">;
  delivery: Pick<SupervisedAgentDelivery, "reserveIdle"> | null;
  provider?: Pick<ProviderActionPort, "stop" | "stopIdle" | "describeManagedLaunchContract">;
  managed?: {
    store: Pick<ManifestStore, "readManagedLaunchContract" | "validateManagedRuntimeReplacement" | "hasUnclosedRuntimeApprovals">;
    bindings: Pick<WorkerBindingStore, "get">;
    reserveApprovalIdle(installation: ProviderInstallationToken): { assertCurrent(): void; release(): void } | null;
    resumeDelivery(entryId: string): Promise<void>;
  };
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
  private readonly desiredContracts = new Map<string, string>();
  private readonly admissionRefreshRequested = new WeakMap<object, ProviderInstallationToken>();
  private readonly ownerSetupEndTries = new WeakMap<ProviderInstallationToken, { all: number; unexplained: number }>();
  constructor(private readonly options: RuntimeConfigurationApplyCoordinatorOptions) {}

  /**
   * For a process that was started with its owner's setup: the agent's saved
   * configuration when the owner has turned the setup off since, or null
   * while it is still on. Such a process must take no further turn: it is
   * replaced as soon as it is idle. Only a process that was started with the
   * setup can owe this, so callers ask for no other agent, and for every
   * other agent nothing is read at all.
   */
  private async ownerSetupToEnd(entryId: string) {
    const configuration = await this.options.store.getAgentConfiguration(entryId);
    if (!configuration) return null;
    return agentUsesHomeHarness({ id: entryId, provider: configuration.provider, deliveryMode: configuration.delivery_mode },
      configuration.provider_launch_policy) ? null : configuration;
  }

  /**
   * Replace an idle process that still has the owner's setup after the owner
   * turned it off. It is the same path as "Restart to apply changes", so it
   * never interrupts a turn. When the process could not be replaced this
   * time, the answer says when to try again: later after each try, so an
   * agent whose turn was refused is never left waiting on some other event.
   * A replacement that fails outright is thrown, and shown as the agent's error.
   */
  private async endOwnerSetup(entryId: string): Promise<"replaced" | ManagedRefreshRetry | null> {
    const installation = this.options.streams.currentInstallation(entryId);
    if (installation?.handle.ownerSetup !== true) return null;
    let configuration: Awaited<ReturnType<RuntimeConfigurationApplyCoordinator["ownerSetupToEnd"]>>;
    try {
      configuration = await this.ownerSetupToEnd(entryId);
    } catch {
      // Whether the setup was turned off could not be read. Its turns wait meanwhile, so it is asked again.
      return this.ownerSetupEndRetry(installation, false);
    }
    if (!configuration) {
      this.ownerSetupEndTries.delete(installation);
      return null;
    }
    let outcome: ApplyAgentConfigurationResult["outcome"];
    try {
      outcome = (await this.applyInternal({ entryId, daemonGeneration: this.options.authority.currentDaemonGeneration(),
        expectedConfigurationRevision: configuration.config_revision }, undefined, true)).outcome;
    } catch (error) {
      // The agent cannot be restarted: that is an error its owner sees, not a quiet wait. What went
      // wrong stays its cause, which is shown after it and is what the scheduler decides from.
      throw new Error("LetAgents could not restart this agent to stop it running with your own setup, so its messages are waiting. "
        + "Pause the agent and resume it to finish switching your setup off", { cause: error });
    }
    if (outcome === "restarting") return "replaced";
    // A turn that is still running, or an agent that is paused, is waited for without comment.
    return this.ownerSetupEndRetry(installation, outcome === "busy_active_turn" || outcome === "unsupported");
  }

  private ownerSetupEndRetry(installation: ProviderInstallationToken, expected: boolean): ManagedRefreshRetry {
    const tries = this.ownerSetupEndTries.get(installation) ?? { all: 0, unexplained: 0 };
    tries.all += 1;
    if (!expected) tries.unexplained += 1;
    this.ownerSetupEndTries.set(installation, tries);
    return {
      retryAfterMs: Math.min(OWNER_SETUP_END_RETRY_MAX_MS, OWNER_SETUP_END_RETRY_BASE_MS * 2 ** Math.min(tries.all - 1, 10)),
      ...(!expected && tries.unexplained === OWNER_SETUP_END_NOTICE_AFTER ? {
        notice: "Still waiting to restart this agent so it stops running with your own setup. Its messages wait until then. "
          + "Pause the agent and resume it to do it now.",
      } : {}),
    };
  }

  /** Observe only: replacement drains the caller, so convergence must run separately. */
  async canAdmitManagedDelivery(agent: SupervisedIngressAgent, demand: object): Promise<boolean> {
    const current = this.options.streams.currentInstallation(agent.agentId);
    // An agent whose process was not started with its owner's setup is admitted as it always was: nothing is read for it.
    if (current?.handle.ownerSetup === true) {
      // Whether the setup was turned off could not be read: the turn waits rather than run with it.
      const mustEnd = await this.ownerSetupToEnd(agent.agentId).then((configuration) => configuration !== null, () => true);
      if (mustEnd) {
        // No new turn starts on a process that still has the setup its owner
        // turned off. Convergence replaces it, and the turn waits for the new one.
        if (this.admissionRefreshRequested.get(demand) !== current) {
          this.admissionRefreshRequested.set(demand, current);
          this.options.requestConvergence(agent.agentId);
        }
        return false;
      }
    }
    if (agent.provider !== "codex" || !this.options.managed || !this.options.provider?.describeManagedLaunchContract) return true;
    const installation = this.options.streams.currentInstallation(agent.agentId);
    const matches = () => Boolean(installation
      && this.options.streams.currentInstallation(agent.agentId) === installation
      && !this.options.authority.isHandoffScheduled()
      && this.options.authority.currentDaemonGeneration() === agent.daemonGeneration
      && installation.handle === agent.handle
      && installation.workAttemptId === agent.workAttemptId
      && installation.executionGenerationId === agent.executionGenerationId
      && installation.providerContinuationId === agent.providerContinuationId
      && sameProviderActionConnectionSnapshot(installation.providerConnection, agent.providerConnection));
    if (!matches()) return false;
    const contract = await this.desiredContract(agent.apiUrl);
    if (!matches()) return false;
    if (!contract) return true; // Explicit development runtimes have no managed contract.
    const launched = await this.options.managed.store.readManagedLaunchContract({
      agentId: agent.agentId, executionGenerationId: installation!.executionGenerationId,
      providerConnection: installation!.providerConnection,
    });
    if (!matches()) return false;
    if (launched === contract) return true;
    // Internal restart after deferral retains the demand; an independent
    // delivery wake may retry this same installation. Capture each demand
    // separately so a late read cannot consume a newer wake.
    if (this.admissionRefreshRequested.get(demand) !== installation) {
      this.admissionRefreshRequested.set(demand, installation!);
      this.options.requestConvergence(agent.agentId);
    }
    return false;
  }

  private async desiredContract(apiUrl: string): Promise<string | null> {
    const contract = this.desiredContracts.get(apiUrl) ?? await this.options.provider!.describeManagedLaunchContract!({
      provider: "codex", apiUrl, devMcpServerEntryPath: devMcpServerEntryFromEnv() ?? undefined,
    });
    if (contract) this.desiredContracts.set(apiUrl, contract);
    return contract;
  }

  async refreshManaged(entryId: string): Promise<void | ManagedRefreshRetry> {
    // Runs after every convergence, so also when a turn has just ended.
    const ownerSetup = await this.endOwnerSetup(entryId);
    if (ownerSetup) return ownerSetup === "replaced" ? undefined : ownerSetup;
    const managed = this.options.managed;
    const provider = this.options.provider;
    if (!managed || !provider?.stopIdle || !provider.describeManagedLaunchContract) return;
    const entry = await this.options.store.getEntry(entryId);
    const configuration = await this.options.store.getAgentConfiguration(entryId);
    const installation = this.options.streams.currentInstallation(entryId);
    if (!entry || entry.provider !== "codex" || entry.observed_state !== "idle"
      || entry.desired_state !== "running" || entry.condition !== "none"
      || entry.delivery_mode !== "daemon_inbox" || !installation || !configuration
      || configuration.config_revision !== configuration.runtime_configuration_revision) return;
    const binding = await managed.bindings.get(entryId);
    if (!binding || binding.room_id !== entry.room_id || binding.work_attempt_id !== entry.work_attempt_id
      || binding.execution_generation_id !== installation.executionGenerationId) return;
    const contract = await this.desiredContract(binding.api_url);
    if (!contract) return;
    await this.applyInternal({ entryId, daemonGeneration: this.options.authority.currentDaemonGeneration(),
      expectedConfigurationRevision: configuration.config_revision }, { contract, apiUrl: binding.api_url });
  }

  async apply(input: ApplyAgentConfigurationInput): Promise<ApplyAgentConfigurationResult> {
    return this.applyInternal(input);
  }

  /** `retriedByCaller`: a replacement that did not happen is tried again later by the caller, not by an immediate convergence. */
  private async applyInternal(input: ApplyAgentConfigurationInput, managed?: ManagedReplacement, retriedByCaller = false): Promise<ApplyAgentConfigurationResult> {
    if (!input.entryId.trim()
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1
      || !Number.isSafeInteger(input.expectedConfigurationRevision)
      || input.expectedConfigurationRevision < 1) return { outcome: "conflict" };
    if (input.daemonGeneration !== this.options.authority.currentDaemonGeneration()) {
      return { outcome: "conflict" };
    }
    const preflight = await this.inspect(input, managed);
    if (preflight.outcome !== "ready") return preflight;
    if (!this.options.delivery || !this.options.provider) return { outcome: "unsupported" };
    let release: (() => void) | null = null;
    let releaseDelivery: (() => void) | null = null;
    let approvalReservation: { assertCurrent(): void; release(): void } | null = null;
    let replaced = false;
    try {
      release = this.options.entryConcurrency.beginLifecycle(input.entryId);
    } catch {
      return { outcome: "conflict" };
    }
    try {
      await this.options.entryConcurrency.waitForActiveRoomMove(input.entryId);
      const before = await this.inspect(input, managed);
      if (before.outcome !== "ready") return before;
      if (managed) {
        approvalReservation = this.options.managed!.reserveApprovalIdle(before.installation);
        if (!approvalReservation) return { outcome: "busy_active_turn" };
      }
      this.options.entryConcurrency.bumpControlEpoch(input.entryId);
      releaseDelivery = await this.options.delivery.reserveIdle(input.entryId);
      if (!releaseDelivery) {
        return { outcome: "busy_active_turn" };
      }
      const after = await this.inspect(input, managed);
      if (after.outcome !== "ready") return after;
      if (after.installation !== before.installation) return { outcome: "conflict" };
      if (managed) {
        // Verify the sealed replacement immediately before retiring the old
        // process, even when routine comparison used this daemon's cached hash.
        const replacementContract = await this.options.provider!.describeManagedLaunchContract!({
          provider: "codex", apiUrl: managed.apiUrl,
          devMcpServerEntryPath: devMcpServerEntryFromEnv() ?? undefined,
        });
        if (replacementContract !== managed.contract) return { outcome: "conflict" };
        const assertDurable = await this.options.managed!.store.validateManagedRuntimeReplacement({
          agentId: input.entryId, executionGenerationId: after.installation.executionGenerationId,
          providerConnection: after.installation.providerConnection,
          configurationRevision: input.expectedConfigurationRevision, apiUrl: managed.apiUrl,
          roomId: after.roomId, workAttemptId: after.installation.workAttemptId,
          providerContinuationId: after.installation.providerContinuationId,
        });
        await this.options.authority.assertCurrent();
        await this.options.terminals.replaceConfiguration(after.installation, () =>
          this.options.provider!.stopIdle!(after.installation.handle, () => {
            if (this.options.authority.isHandoffScheduled()
              || input.daemonGeneration !== this.options.authority.currentDaemonGeneration()
              || this.options.streams.currentInstallation(input.entryId) !== after.installation) {
              throw new ManagedRuntimeRefreshDeferred("Managed runtime replacement lost its installation authority.");
            }
            try { approvalReservation!.assertCurrent(); }
            catch { throw new ManagedRuntimeRefreshDeferred("Managed runtime permissions changed before replacement."); }
            assertDurable();
          }));
      } else {
        await this.options.terminals.replaceConfiguration(after.installation, () =>
          this.options.provider!.stop(after.installation.handle, {
            actionId: `manifest:${input.entryId}:apply-configuration:${input.expectedConfigurationRevision}:${after.installation.executionGenerationId}`,
          }));
      }
      replaced = true;
      return { outcome: "restarting" };
    } catch (error) {
      if (managed && (error as { code?: unknown })?.code === "MANAGED_RUNTIME_REFRESH_DEFERRED") return { outcome: "conflict" };
      throw error;
    } finally {
      approvalReservation?.release();
      releaseDelivery?.();
      release();
      // Lifecycle admission may have excluded a room move that raced the
      // read-only preflight. Reconcile after exclusion ends even if the exact
      // second inspection prevented a provider fence. A caller that tries
      // again by itself is not converged at once for a try that changed
      // nothing, so its retries cannot become a loop; a try that had taken
      // delivery over still is, because convergence is what hands it back.
      if (replaced || (!managed && (!retriedByCaller || releaseDelivery))) this.options.requestConvergence(input.entryId);
      else if (managed && releaseDelivery) await this.options.managed!.resumeDelivery(input.entryId);
    }
  }

  private inspect(input: ApplyAgentConfigurationInput, managed?: ManagedReplacement): Promise<ApplyInspection> {
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
      if (managed && configuration.config_revision !== configuration.runtime_configuration_revision) {
        return { outcome: "conflict" };
      }
      if (!managed && configuration.config_revision === configuration.runtime_configuration_revision) {
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
      if (managed) {
        if (entry.provider !== "codex") return { outcome: "unsupported" };
        const binding = await this.options.managed!.bindings.get(input.entryId);
        if (!binding || binding.room_id !== entry.room_id || binding.work_attempt_id !== entry.work_attempt_id
          || binding.execution_generation_id !== installation.executionGenerationId
          || binding.api_url !== managed.apiUrl) return { outcome: "conflict" };
        const launched = await this.options.managed!.store.readManagedLaunchContract({
          agentId: input.entryId, executionGenerationId: installation.executionGenerationId,
          providerConnection: installation.providerConnection,
        });
        if (launched === managed.contract) return { outcome: "already_applied" };
        if (await this.options.managed!.store.hasUnclosedRuntimeApprovals({
          agentId: input.entryId, executionGenerationId: installation.executionGenerationId,
          providerConnection: installation.providerConnection,
        })) return { outcome: "busy_active_turn" };
      }
      return { outcome: "ready", installation, roomId: entry.room_id };
    });
  }
}
