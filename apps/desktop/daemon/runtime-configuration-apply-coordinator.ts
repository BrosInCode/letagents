import { ManagedRuntimeRefreshDeferred } from "./provider-action-port.js";
import { agentUsesHomeHarness, permissionChangedSince } from "./provider-configuration.js";
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
import type { DaemonManifestEntry } from "./types.js";

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

/**
 * How long a runtime's delivery must stay blocked by its execution record
 * before the daemon restarts the runtime. A record that is only late, as it
 * is for a moment after every start, is admitted well within this.
 */
const RECORD_BLOCK_GRACE_MS = 10_000;
const RECORD_RESTART_RETRY_BASE_MS = 2_000;
const RECORD_RESTART_RETRY_MAX_MS = 30_000;
const RECORD_RESTART_RETURNED_DETAIL = "Part of this agent's activity record is missing, and restarting the agent did not get past it. Messages wait until you use Restart and resume in Diagnostics.";
/**
 * How long the restart for a blocked record may wait for the agent to be
 * idle before its owner is shown that it waits. Codex says whether a turn is
 * running; Claude Code and Open Model cannot be asked, so for them a turn
 * the record no longer sees may never be confirmed over. The daemon goes on
 * trying after this; it only stops presenting the wait as one it will end.
 */
const RECORD_RESTART_PENDING_LIMIT_MS = 5 * 60_000;
const RECORD_RESTART_OVERDUE_DETAIL = "Part of this agent's activity record is missing. LetAgents restarts the agent when no turn is running, and for several minutes it could not confirm that. A turn may still be running, and messages wait for it. Restart and resume in Diagnostics restarts the agent now and stops that turn.";

const OWNER_SETUP_END_RETRY_BASE_MS = 1_000;
const OWNER_SETUP_END_RETRY_MAX_MS = 30_000;
/** After this many tries that found the agent neither busy nor replaceable, its owner is told it is still waiting. */
const OWNER_SETUP_END_NOTICE_AFTER = 5;
/** Why an idle process is replaced before it takes another turn: its owner turned their setup off, or saved another access level. */
type OutdatedRuntime = "owner_setup" | "access_level";
const OUTDATED_RUNTIME_NOTICE: Record<OutdatedRuntime, string> = {
  owner_setup: "Still waiting to restart this agent so it stops running with your own setup. Its messages wait until then. "
    + "Pause the agent and resume it to do it now.",
  access_level: "Still waiting to restart this agent so it runs with the access level you saved. Its messages wait until then. "
    + "Pause the agent and resume it to do it now.",
};
const OUTDATED_RUNTIME_FAILURE: Record<OutdatedRuntime, string> = {
  owner_setup: "LetAgents could not restart this agent to stop it running with your own setup, so its messages are waiting. "
    + "Pause the agent and resume it to finish switching your setup off",
  access_level: "LetAgents could not restart this agent to apply the access level you saved, so its messages are waiting. "
    + "Pause the agent and resume it to finish applying it",
};

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
  provider?: Pick<ProviderActionPort, "stop" | "stopIdle" | "describeManagedLaunchContract" | "inspectTurnBoundary">;
  managed?: {
    store: Pick<ManifestStore, "readManagedLaunchContract" | "validateManagedRuntimeReplacement" | "hasUnclosedRuntimeApprovals">;
    bindings: Pick<WorkerBindingStore, "get">;
    reserveApprovalIdle(installation: ProviderInstallationToken): { assertCurrent(): void; release(): void } | null;
    resumeDelivery(entryId: string): Promise<void>;
  };
  streams: {
    currentInstallation(entryId: string): ProviderInstallationToken | undefined;
    /** Why the entry's running agent cannot be admitted for delivery: its execution record cannot be continued. */
    recordBlock?(entry: DaemonManifestEntry): string | null;
    deliveryAdmission?(entry: DaemonManifestEntry): "pending" | "ready" | "unavailable" | null;
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
  /** Since when each runtime's delivery has been blocked by its record, and how often it could not be replaced yet. */
  private readonly recordBlocks = new WeakMap<ProviderInstallationToken, { sinceMs: number; tries: number }>();
  /** Entries whose runtime was restarted to get past a blocked record, until a runtime of theirs is admitted again. */
  private readonly recordRestarts = new Set<string>();
  /** Why a blocked record now waits for the agent's owner, for the runtime it was decided for. */
  private readonly recordAttention = new Map<string, { installation: ProviderInstallationToken; detail: string }>();
  private recordBlockGraceMs = RECORD_BLOCK_GRACE_MS;
  private recordRestartPendingLimitMs = RECORD_RESTART_PENDING_LIMIT_MS;
  constructor(private readonly options: RuntimeConfigurationApplyCoordinatorOptions) {}

  /**
   * An agent that is running and idle takes no messages while its execution
   * record cannot be continued: a re-attach that could not bind its
   * observer, a fact the record cannot place. No later runtime is on its way
   * to carry on past that, so the daemon starts one: it replaces the idle
   * runtime, exactly as "Restart to apply changes" does, and the start of
   * the replacement archives the old record behind a recovery boundary.
   * Nothing queued is cancelled and no turn is interrupted.
   *
   * It does so once. A replacement that is blocked as well is left as it is,
   * and so is an agent whose restart failed: either one is shown to the
   * owner as needing attention, with the reason.
   */
  private async continuePastBlockedRecord(entryId: string): Promise<"replaced" | ManagedRefreshRetry | null> {
    const installation = this.options.streams.currentInstallation(entryId);
    const entry = installation && this.options.streams.recordBlock ? await this.options.store.getEntry(entryId) : undefined;
    if (!installation || !entry) return null;
    if (this.options.streams.recordBlock!(entry) === null) {
      this.recordBlocks.delete(installation);
      // A runtime that is admitted ends the episode; one that is still being admitted says nothing yet.
      if (this.options.streams.deliveryAdmission?.(entry) === "ready") {
        this.recordRestarts.delete(entryId);
        this.recordAttention.delete(entryId);
      }
      return null;
    }
    if (this.recordAttention.get(entryId)?.installation === installation) return null;
    const now = Date.now();
    const block = this.recordBlocks.get(installation) ?? { sinceMs: now, tries: 0 };
    this.recordBlocks.set(installation, block);
    if (now < block.sinceMs + this.recordBlockGraceMs) return { retryAfterMs: block.sinceMs + this.recordBlockGraceMs - now };
    if (this.recordRestarts.has(entryId)) {
      this.recordAttention.set(entryId, { installation, detail: RECORD_RESTART_RETURNED_DETAIL });
      return null;
    }
    const configuration = await this.options.store.getAgentConfiguration(entryId);
    if (!configuration) return null;
    let outcome: ApplyAgentConfigurationResult["outcome"];
    try {
      outcome = (await this.applyInternal({ entryId, daemonGeneration: this.options.authority.currentDaemonGeneration(),
        expectedConfigurationRevision: configuration.config_revision }, undefined, true, true)).outcome;
    } catch (error) {
      this.recordAttention.set(entryId, { installation, detail: "Part of this agent's activity record is missing, and LetAgents could not restart the agent to get past it"
        + ` (${error instanceof Error ? error.message : "the restart failed"}). Messages wait until you use Restart and resume in Diagnostics.` });
      return null;
    }
    if (outcome === "restarting") {
      this.recordRestarts.add(entryId);
      return "replaced";
    }
    // Paused, stopped or not a daemon-delivered agent: nothing is waiting on this runtime.
    if (outcome === "unsupported") return null;
    // A turn is running, or something else holds the agent for now: it is tried again, later after each try.
    block.tries += 1;
    return { retryAfterMs: Math.min(RECORD_RESTART_RETRY_MAX_MS, RECORD_RESTART_RETRY_BASE_MS * 2 ** Math.min(block.tries - 1, 10)) };
  }

  /**
   * For the read model. Undefined: the entry's record blocks nothing. Null:
   * it does, and the daemon is still going to restart the agent by itself.
   * Otherwise why it now waits for its owner.
   */
  recordRecovery(entry: DaemonManifestEntry): string | null | undefined {
    if (!this.options.streams.recordBlock?.(entry)) return undefined;
    const installation = this.options.streams.currentInstallation(entry.id);
    const attention = this.recordAttention.get(entry.id);
    if (attention && attention.installation === installation) return attention.detail;
    const block = installation ? this.recordBlocks.get(installation) : undefined;
    return block && Date.now() - block.sinceMs >= this.recordBlockGraceMs + this.recordRestartPendingLimitMs
      ? RECORD_RESTART_OVERDUE_DETAIL : null;
  }

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
   * For a process that started before the owner saved another access level:
   * the agent's saved configuration, or null while the process runs with the
   * level that is saved. The change is recorded in the stored policy against
   * the revision the process started at, so a restart of the daemon loses
   * nothing. A turn that is running is never interrupted: the process takes
   * no new turn, and is replaced as soon as it is idle.
   */
  private async accessLevelToApply(entryId: string, installation: ProviderInstallationToken) {
    const configuration = await this.options.store.getAgentConfiguration(entryId);
    // An agent that collects its own messages cannot be held back from its next turn, so it keeps its level until it starts again.
    return configuration?.delivery_mode === "daemon_inbox" && permissionChangedSince(configuration.provider_launch_policy,
      installation.handle.appliedConfigurationRevision ?? configuration.runtime_configuration_revision) ? configuration : null;
  }

  /**
   * Replace an idle process that runs differently from what its owner saved:
   * it still has the owner's setup after they turned it off, or it started
   * before they saved another access level. It is the same path as "Restart
   * to apply changes", so it never interrupts a turn. When the process could
   * not be replaced this time, the answer says when to try again: later after
   * each try, so an agent whose turn was refused is never left waiting on some
   * other event. A replacement that fails outright is thrown, and shown as the
   * agent's error.
   */
  private async endOutdatedRuntime(entryId: string): Promise<"replaced" | ManagedRefreshRetry | null> {
    const installation = this.options.streams.currentInstallation(entryId);
    if (!installation) return null;
    let configuration: Awaited<ReturnType<RuntimeConfigurationApplyCoordinator["ownerSetupToEnd"]>> = null;
    let why: OutdatedRuntime = "owner_setup";
    try {
      if (installation.handle.ownerSetup === true) configuration = await this.ownerSetupToEnd(entryId);
    } catch {
      // Whether the setup was turned off could not be read. Its turns wait meanwhile, so it is asked again.
      return this.outdatedRuntimeRetry(installation, false, why);
    }
    if (!configuration) {
      why = "access_level";
      // A saved level that cannot be read leaves the agent as it was: nothing new is held back on a guess.
      configuration = await this.accessLevelToApply(entryId, installation).catch(() => null);
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
      throw new Error(OUTDATED_RUNTIME_FAILURE[why], { cause: error });
    }
    if (outcome === "restarting") return "replaced";
    // An agent that is paused, or collects its own messages, takes the level when it starts again: there is nothing to retry.
    if (why === "access_level" && outcome === "unsupported") return null;
    // A turn that is still running, or an agent that is paused, is waited for without comment.
    return this.outdatedRuntimeRetry(installation, outcome === "busy_active_turn" || outcome === "unsupported", why);
  }

  private outdatedRuntimeRetry(installation: ProviderInstallationToken, expected: boolean, why: OutdatedRuntime): ManagedRefreshRetry {
    const tries = this.ownerSetupEndTries.get(installation) ?? { all: 0, unexplained: 0 };
    tries.all += 1;
    if (!expected) tries.unexplained += 1;
    this.ownerSetupEndTries.set(installation, tries);
    return {
      retryAfterMs: Math.min(OWNER_SETUP_END_RETRY_MAX_MS, OWNER_SETUP_END_RETRY_BASE_MS * 2 ** Math.min(tries.all - 1, 10)),
      ...(!expected && tries.unexplained === OWNER_SETUP_END_NOTICE_AFTER ? { notice: OUTDATED_RUNTIME_NOTICE[why] } : {}),
    };
  }

  /** Observe only: replacement drains the caller, so convergence must run separately. */
  async canAdmitManagedDelivery(agent: SupervisedIngressAgent, demand: object): Promise<boolean> {
    const current = this.options.streams.currentInstallation(agent.agentId);
    if (current) {
      // Whether the setup was turned off could not be read: the turn waits rather than run with it.
      let mustEnd = current.handle.ownerSetup === true
        && await this.ownerSetupToEnd(agent.agentId).then((configuration) => configuration !== null, () => true);
      // A saved level that cannot be read leaves the agent as it was: the turn is not held back on a guess.
      mustEnd ||= await this.accessLevelToApply(agent.agentId, current).then((configuration) => configuration !== null, () => false);
      if (mustEnd) {
        // No new turn starts on a process that still has the setup its owner
        // turned off, or the access level they changed. Convergence replaces
        // it, and the turn waits for the new one.
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
    const outdated = await this.endOutdatedRuntime(entryId);
    if (outdated === "replaced") return;
    // An agent that waits for its turn to end is still restarted for a blocked record, which has its own wait: the sooner of the two is kept.
    const blockedRecord = await this.continuePastBlockedRecord(entryId);
    if (blockedRecord === "replaced") return;
    if (blockedRecord) return outdated && outdated.retryAfterMs < blockedRecord.retryAfterMs ? outdated : blockedRecord;
    if (outdated) return outdated;
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

  /**
   * `retriedByCaller`: a replacement that did not happen is tried again later by the caller, not by an immediate convergence.
   * `restart`: the runtime is replaced whether or not a configuration change is waiting.
   */
  private async applyInternal(input: ApplyAgentConfigurationInput, managed?: ManagedReplacement, retriedByCaller = false, restart = false): Promise<ApplyAgentConfigurationResult> {
    if (!input.entryId.trim()
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1
      || !Number.isSafeInteger(input.expectedConfigurationRevision)
      || input.expectedConfigurationRevision < 1) return { outcome: "conflict" };
    if (input.daemonGeneration !== this.options.authority.currentDaemonGeneration()) {
      return { outcome: "conflict" };
    }
    const preflight = await this.inspect(input, managed, restart);
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
      const before = await this.inspect(input, managed, restart);
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
      const after = await this.inspect(input, managed, restart);
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

  private inspect(input: ApplyAgentConfigurationInput, managed?: ManagedReplacement, restart = false): Promise<ApplyInspection> {
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
      if (!managed && !restart && configuration.config_revision === configuration.runtime_configuration_revision) {
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
      // A record that blocks the runtime receives no facts, so the saved
      // state of a runtime whose turn ended in the meantime still says
      // working. A restart for that record asks the runtime itself below.
      if (entry.observed_state !== "idle" && !restart) return { outcome: "busy_active_turn" };
      if (entry.turn_control && entry.turn_control.status !== "completed") {
        return { outcome: "busy_active_turn" };
      }
      if ((await this.options.store.pendingRoomMoves(input.entryId)).length > 0
        || await this.options.store.unresolvedDeliveryDrain(input.entryId)
        || await this.options.store.unresolvedPollingActivation(input.entryId)) {
        return { outcome: "conflict" };
      }
      const head = await this.options.inbox.head(input.entryId);
      const startedHead = Boolean(head && (head.state !== "pending" || head.provider_turn_id !== null));
      // A message whose turn had started when its record stopped being
      // admitted: delivery cannot read how the turn ends, so the message would
      // wait for ever. Once the provider itself says that no turn is running,
      // the turn is over, and the runtime's replacement reads its ending by
      // its exact identity. The turn is never run again.
      const endedTurnAtHead = restart && startedHead && head!.provider_turn_id !== null
        && ["dispatching", "awaiting_result", "result_recovery"].includes(head!.state);
      if (startedHead && !endedTurnAtHead) return { outcome: "busy_active_turn" };
      const installation = this.options.streams.currentInstallation(input.entryId);
      // A runtime whose record has a gap can go on reporting a turn that ended
      // in the gap. Before it is restarted for that, the provider itself is
      // asked whether a turn is running.
      const providerSaysIdle = async () => installation !== undefined
        && (await this.options.provider?.inspectTurnBoundary?.(installation.handle).catch(() => null))?.state === "idle";
      // A restart for a record goes ahead on positive evidence only: the
      // provider says no turn is running, or both the saved state and the
      // runtime say idle. A provider that cannot be asked, with a saved state
      // that still says working, is waited for (and shown after a while).
      const idle = endedTurnAtHead ? await providerSaysIdle()
        : !restart ? installation?.handle.observedState === "idle"
          : (entry.observed_state === "idle" && installation?.handle.observedState === "idle") || await providerSaysIdle();
      if (endedTurnAtHead && !idle) return { outcome: "busy_active_turn" };
      if (!installation
        || installation.configurationRevision !== configuration.runtime_configuration_revision
        || installation.handle.appliedConfigurationRevision !== configuration.runtime_configuration_revision
        || !idle
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
