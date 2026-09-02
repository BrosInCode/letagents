import { randomUUID } from "node:crypto";

import { supervisedProviderLabel } from "./cloud-http.js";
import { devMcpServerEntryFromEnv } from "./dev-spawn-options.js";
import type { WorkDurabilityStore } from "./durability-store.js";
import {
  isEphemeralWorkspaceMarker,
  type EphemeralWorkspaceProvisioner,
} from "./ephemeral-workspace-provisioner.js";
import { serializeDaemonDeploymentId } from "./manifest-entry-projection.js";
import { ManifestConflictError } from "./manifest-store.js";
import {
  sameProviderActionConnectionIdentity,
  sameProviderActionConnectionSnapshot,
  type ProviderActionAttachTerminal,
  type ProviderActionHandle,
  type ProviderActionPort,
  type ProviderActionRef,
  type ProviderActionSpawn,
  type ProviderActionTerminal,
} from "./provider-action-port.js";
import { deriveProviderConfigurationSnapshot } from "./provider-configuration.js";
import {
  lifecycleAuthorityModeForProvider,
  lifecycleAuthorityProviderSchema,
  type LifecycleAuthorityMode,
} from "./lifecycle-authority-mode.js";
import { CRASH_LOOP_EXIT_LIMIT, CRASH_LOOP_WINDOW_MS } from "./reconciler-policy.js";
import { DaemonFenceLostError } from "./singleton.js";
import {
  assertSupervisedPermissionProfileAvailable,
  assertSupervisedRentalPermissionProfileAvailable,
} from "./supervised-permission-profiles.js";
import type {
  DaemonManifestEntry,
  ExecutionTerminalPayload,
  TaskWorkAttempt,
} from "./types.js";
import {
  repositoryStorageKey,
  resolveSourceRepositoryIdentity,
  type GitCommand,
  type WorkspaceProvisioner,
} from "./workspace-provisioner.js";
import type { WorkerBindingStore, WorkerSessionBinding } from "./worker-binding-store.js";
import type {
  BoundWorkerAuthorization,
  InstalledHostGrant,
  InstalledOpenModelCredential,
  MintedWorkerAuthorization,
} from "./worker-runtime-custody.js";
import type { ProviderInstallationToken } from "./provider-stream-coordinator.js";

import { deliveryDrainBlocksRuntime, type DeliveryDrainRecord } from "./delivery-drain.js";
import { matchesPollingActivationRuntime, type PollingActivationRecord } from "./custodial-polling-activation.js";

type CommitFence = (commit: () => Promise<void>) => Promise<void>;

export type ProviderExecutionConfiguration = {
  polling_contract?: "custodial_polling_v1" | null;
  provider: string;
  model: string | null;
  reasoning_effort: DaemonManifestEntry["reasoning_effort"];
  permission_profile_id: string | null;
  provider_launch_policy: unknown;
  config_revision: number;
  runtime_configuration_revision: number;
};

export type ProviderExecutionStore = {
  unresolvedDeliveryDrain(agentId: string): Promise<DeliveryDrainRecord | null>;
  unresolvedPollingActivation(agentId: string): Promise<PollingActivationRecord | null>;
  load(): Promise<{ generation: number; entries: DaemonManifestEntry[] }>;
  getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
  getAgentConfiguration(entryId: string): Promise<ProviderExecutionConfiguration | undefined>;
  readRuntimeLifecycleAuthority(input: {
    agentId: string;
    executionGenerationId: string;
    providerConnection: NonNullable<ProviderActionHandle["providerConnection"]>;
    configurationRevision: number;
  }): Promise<LifecycleAuthorityMode | null>;
  replaceEntry(
    expectedGeneration: number,
    entry: DaemonManifestEntry,
    commitFence: CommitFence,
  ): Promise<{ generation: number }>;
  markRuntimeConfigurationApplied(
    expectedGeneration: number,
    input: {
      agentId: string;
      executionGenerationId: string;
      appliedRevision: number;
    },
    commitFence: CommitFence,
  ): Promise<{ generation: number }>;
  checkpointProviderBirth(
    expectedGeneration: number,
    input: {
      entry: DaemonManifestEntry;
      executionGenerationId: string;
      providerConnection: NonNullable<ProviderActionHandle["providerConnection"]>;
      appliedRevision: number;
      requestedAuthorityMode: LifecycleAuthorityMode;
      observedAtMs: number;
    },
    commitFence: CommitFence,
  ): Promise<{ generation: number; entry: DaemonManifestEntry; authorityMode: LifecycleAuthorityMode | null }>;
};

export type ProviderExecutionDurability = Pick<
  WorkDurabilityStore,
  | "getAttempt"
  | "createAttempt"
  | "startGeneration"
  | "recordTerminal"
  | "releaseTerminalExecutionFence"
  | "recoverExecutionFence"
  | "checkpoint"
>;

export type ProviderExecutionStreams = {
  liveHandles: Map<string, ProviderActionHandle>;
  get(entryId: string): ProviderActionHandle | undefined;
  currentInstallation(entryId: string): ProviderInstallationToken | undefined;
  remove(installation: ProviderInstallationToken): boolean;
  install(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    mayStartDelivery?: () => boolean,
  ): Promise<void>;
  stageWorkerBindingAfterResume(
    entry: DaemonManifestEntry,
    priorBinding: WorkerSessionBinding,
    successorExecutionGenerationId: string,
    handle: ProviderActionHandle,
  ): Promise<void>;
  fenceTerminalOnce(handle: ProviderActionHandle, actionId: string): Promise<void>;
};

export type ProviderExecutionCoordinatorOptions = {
  provider: ProviderActionPort;
  store: ProviderExecutionStore;
  durability: ProviderExecutionDurability;
  bindings: Pick<WorkerBindingStore, "get" | "credentialFor" | "supervisedWorkerSession">;
  streams: ProviderExecutionStreams;
  authority: {
    isHandoffScheduled(): boolean;
    currentDaemonGeneration(): number;
    currentManifestGeneration(): number;
    acceptManifestGeneration(generation: number): void;
    assertCurrent(): Promise<void>;
    ownsDaemonGeneration(expectedGeneration: number): Promise<boolean>;
    fenceCommit: CommitFence;
    serializeManifestMutation<T>(operation: () => Promise<T>): Promise<T>;
    serializeManifestCommit<T>(operation: () => Promise<T>): Promise<T>;
  };
  concurrency: {
    currentControlEpoch(entryId: string): number;
    serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  };
  updateManifestEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
  ): Promise<DaemonManifestEntry>;
  transition(
    entryId: string,
    observedState: DaemonManifestEntry["observed_state"],
    condition: DaemonManifestEntry["condition"],
    cause: string,
    actor: string,
  ): Promise<void>;
  terminalPayload(terminal: ProviderActionTerminal, actor: string): ExecutionTerminalPayload;
  observeProviderExit(
    entryId: string,
    terminal: ProviderActionTerminal,
    actor: string,
    executionGenerationId?: string,
    handle?: ProviderActionHandle,
  ): Promise<void>;
  completeTurnControlForRuntimeRecovery(entry: DaemonManifestEntry): Promise<DaemonManifestEntry>;
  delivery: {
    stop(entryId: string): Promise<unknown>;
    start(entryId: string, mode?: "ensure" | "wake"): Promise<unknown>;
  };
  inbox: {
    cursor(entryId: string): Promise<{
      agent_id: string;
      room_id: string;
      last_observed_message_id: string | null;
    } | null>;
  };
  host: {
    requiresGrant(entry: DaemonManifestEntry): boolean | Promise<boolean>;
    currentGrant(entry: DaemonManifestEntry): InstalledHostGrant | null;
    ensureGrantFresh(entry: DaemonManifestEntry): Promise<InstalledHostGrant | null>;
    mintAuthorization(entry: DaemonManifestEntry): Promise<MintedWorkerAuthorization | null>;
    recordMintedSession(
      entry: DaemonManifestEntry,
      executionGenerationId: string,
      authorization: MintedWorkerAuthorization,
    ): Promise<BoundWorkerAuthorization | null>;
    mintSession(
      entry: DaemonManifestEntry,
      executionGenerationId: string,
    ): Promise<BoundWorkerAuthorization | null>;
    bindMintedSession(
      entryId: string,
      session: BoundWorkerAuthorization,
      mayPublish?: () => boolean,
    ): Promise<void>;
    bearerNeedsRotation(entry: DaemonManifestEntry, binding: WorkerSessionBinding): Promise<boolean>;
    blockExpiredAuthority(entry: DaemonManifestEntry, detail: string): Promise<void>;
    currentOpenModelCredential(
      entryId: string,
      daemonGeneration: number,
    ): InstalledOpenModelCredential | null;
    recordBindingRecoveryFailure(
      entryId: string,
      executionGenerationId: string,
      error: unknown,
    ): Promise<void>;
    clearSuccessfulRecovery(entryId: string): void;
  };
  workspace: {
    ephemeral: Pick<EphemeralWorkspaceProvisioner, "provision">;
    git: Pick<WorkspaceProvisioner, "provision">;
    gitCommand: GitCommand;
  };
  socketPath: string;
  autoConverge: boolean;
  nowMs(): number;
  recordSchedulerFailure(entryId: string, error: unknown, actor: string): Promise<void>;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

type DispatchReservation = {
  entryId: string;
  executionGenerationId: string;
  daemonGeneration: number;
};

/**
 * Owns provider execution identity from convergence admission through exact
 * dispatch persistence, attach/install, terminal fencing, and recovery retry.
 */
export class ProviderExecutionCoordinator {
  private readonly convergenceRequests = new Map<string, Promise<void>>();
  private readonly recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dispatchReservations = new Set<Promise<void>>();
  private readonly activeDispatches = new Map<symbol, DispatchReservation>();
  private fatalDispatchError: unknown = null;
  private readonly setRecoveryTimeout: typeof setTimeout;
  private readonly clearRecoveryTimeout: typeof clearTimeout;

  constructor(private readonly options: ProviderExecutionCoordinatorOptions) {
    this.setRecoveryTimeout = options.setTimeout ?? setTimeout;
    this.clearRecoveryTimeout = options.clearTimeout ?? clearTimeout;
  }

  providerRef(
    entry: DaemonManifestEntry,
    lifecycleAuthorityMode?: LifecycleAuthorityMode,
  ): ProviderActionRef {
    const ref = entry.provider_ref;
    if (!ref) throw new Error("Manifest entry has no durable provider ref.");
    return {
      workAttemptId: ref.work_attempt_id,
      providerContinuationId: ref.provider_continuation_id,
      provider: entry.provider,
      providerConnection: ref.provider_connection,
      ...(lifecycleAuthorityMode ? { lifecycleAuthorityMode } : {}),
    };
  }

  isAttachTerminal(
    attachment: ProviderActionHandle | ProviderActionAttachTerminal,
  ): attachment is ProviderActionAttachTerminal {
    return "state" in attachment && attachment.state === "terminal";
  }

  request(entryId: string): void {
    if (this.options.authority.isHandoffScheduled() || !this.options.autoConverge) return;
    const previous = this.convergenceRequests.get(entryId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.options.concurrency.serializeEntry(
        entryId,
        () => this.converge(entryId),
      ))
      .catch(async (error) => {
        await this.options.recordSchedulerFailure(
          entryId,
          error,
          "daemon-convergence",
        ).catch(() => undefined);
      })
      .finally(() => {
        if (this.convergenceRequests.get(entryId) === next) {
          this.convergenceRequests.delete(entryId);
        }
      });
    this.convergenceRequests.set(entryId, next);
  }

  scheduleRecovery(entryId: string, delayMs: number): void {
    if (this.recoveryTimers.has(entryId)) return;
    const timer = this.setRecoveryTimeout(() => {
      this.recoveryTimers.delete(entryId);
      this.request(entryId);
    }, Math.max(1, delayMs));
    timer.unref?.();
    this.recoveryTimers.set(entryId, timer);
  }

  clearRecovery(entryId: string): void {
    const timer = this.recoveryTimers.get(entryId);
    if (!timer) return;
    this.clearRecoveryTimeout(timer);
    this.recoveryTimers.delete(entryId);
  }

  async drainConvergence(): Promise<void> {
    await Promise.all([...this.convergenceRequests.values()]);
  }

  /** In-flight convergence is authority-fenced; handoff never waits on its transport. */
  detachConvergence(): void {
    this.convergenceRequests.clear();
  }

  clearRecoveryTimers(): void {
    for (const timer of this.recoveryTimers.values()) this.clearRecoveryTimeout(timer);
    this.recoveryTimers.clear();
  }

  async drainDispatches(): Promise<void> {
    if (this.fatalDispatchError) throw this.fatalDispatchError;
    await Promise.all([...this.dispatchReservations]);
    if (this.fatalDispatchError) throw this.fatalDispatchError;
  }

  private reserveDispatch(
    entryId: string,
    executionGenerationId: string,
  ): { token: symbol; release(error?: unknown): void } {
    const token = Symbol(`provider-dispatch:${entryId}`);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const reservation = new Promise<void>((resolveReservation, rejectReservation) => {
      resolve = resolveReservation;
      reject = rejectReservation;
    });
    void reservation.catch(() => undefined);
    this.dispatchReservations.add(reservation);
    this.activeDispatches.set(token, {
      entryId,
      executionGenerationId,
      daemonGeneration: this.options.authority.currentDaemonGeneration(),
    });
    return {
      token,
      release: (error) => {
        this.activeDispatches.delete(token);
        this.dispatchReservations.delete(reservation);
        if (error === undefined) resolve();
        else {
          this.fatalDispatchError ??= error;
          reject(error);
        }
      },
    };
  }

  private async launchEntryIfCurrent(
    entryId: string,
    expectedEpoch: number,
  ): Promise<DaemonManifestEntry | null> {
    if (this.options.authority.isHandoffScheduled()
      || this.options.concurrency.currentControlEpoch(entryId) !== expectedEpoch) return null;
    const current = await this.options.store.getEntry(entryId);
    if (deliveryDrainBlocksRuntime(await this.options.store.unresolvedDeliveryDrain(entryId))) return null;
    if (this.options.authority.isHandoffScheduled()
      || this.options.concurrency.currentControlEpoch(entryId) !== expectedEpoch
      || current?.desired_state !== "running") return null;
    return current;
  }

  async ensureWorkAttempt(entry: DaemonManifestEntry): Promise<DaemonManifestEntry> {
    if (entry.work_attempt_id) {
      await this.options.durability.getAttempt(entry.work_attempt_id);
      return entry;
    }
    const sourcePath = entry.source_repo_path?.trim() || entry.workspace_path?.trim();
    if (!sourcePath) {
      const workAttemptId = randomUUID();
      const provisioned = await this.options.workspace.ephemeral.provision({
        workAttemptId,
        taskId: entry.id,
      });
      const attempt = await this.options.durability.createAttempt({
        taskId: entry.id,
        leaseId: entry.id,
        leaseEpoch: 0,
        workspacePath: provisioned.path,
        workAttemptId,
      });
      return this.options.updateManifestEntry(entry.id, (current) => ({
        ...current,
        source_repo_path: null,
        workspace_path: attempt.workspace_path,
        work_attempt_id: attempt.work_attempt_id,
      }));
    }
    const { remoteUrl: remote, revision } = await resolveSourceRepositoryIdentity(
      sourcePath,
      this.options.workspace.gitCommand,
    );
    const repo = repositoryStorageKey(remote);
    const workAttemptId = randomUUID();
    const provisioned = await this.options.workspace.git.provision({
      repo,
      workAttemptId,
      taskId: entry.id,
      remoteUrl: remote,
      revision,
      sourceRepoPath: sourcePath,
    });
    const attempt = await this.options.durability.createAttempt({
      taskId: entry.id,
      leaseId: entry.id,
      leaseEpoch: 0,
      workspacePath: provisioned.path,
      workAttemptId,
    });
    return this.options.updateManifestEntry(entry.id, (current) => ({
      ...current,
      source_repo_path: sourcePath,
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
    }));
  }

  private async terminalizeUnlaunchedGeneration(
    attempt: TaskWorkAttempt,
    executionGenerationId: string,
    generation: number,
  ): Promise<void> {
    const terminal = this.options.terminalPayload({
      endedAt: new Date().toISOString(),
      exitCode: 0,
      signal: null,
      terminalCause: "stopped",
      providerContinuationId: null,
    }, "daemon-provider");
    await this.options.durability.recordTerminal(
      attempt.work_attempt_id,
      executionGenerationId,
      { ...terminal, generation, actor: "daemon-provider" },
    );
    await this.options.durability.releaseTerminalExecutionFence(
      attempt.work_attempt_id,
      executionGenerationId,
    );
  }

  private async fenceUnpersistedReturnedProvider(
    attempt: TaskWorkAttempt,
    executionGenerationId: string,
    generation: number,
    handle: ProviderActionHandle,
  ): Promise<void> {
    const terminal = await this.options.provider.stop(handle, {
      actionId: `manifest:unjournaled-dispatch-fence:${executionGenerationId}`,
    });
    await this.options.durability.recordTerminal(
      attempt.work_attempt_id,
      executionGenerationId,
      {
        ...this.options.terminalPayload(terminal, "daemon-provider"),
        generation,
        actor: "daemon-provider",
      },
    );
    await this.options.durability.releaseTerminalExecutionFence(
      attempt.work_attempt_id,
      executionGenerationId,
    );
  }

  private async fenceReturnedProviderAfterControl(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    generation: number,
  ): Promise<boolean> {
    await this.options.authority.serializeManifestMutation(async () => undefined);
    const current = await this.options.store.getEntry(entryId);
    if (!current || current.desired_state === "running") return false;
    await this.options.delivery.stop(entryId).catch(() => undefined);
    await this.options.transition(
      entryId,
      "stopping",
      current.condition,
      `desired state changed to ${current.desired_state} during provider dispatch`,
      "daemon-convergence",
    );
    const installation = this.options.streams.currentInstallation(entryId);
    const terminal = await this.options.provider.stop(handle, {
      actionId: `manifest:${entryId}:${current.desired_state}:dispatch-fence:${generation}`,
    });
    if (installation?.handle === handle
      && installation.executionGenerationId === executionGenerationId) {
      this.options.streams.remove(installation);
    }
    const attempt = current.work_attempt_id
      ? await this.options.durability.getAttempt(current.work_attempt_id)
      : null;
    const execution = attempt?.execution_generations.find(
      (candidate) => candidate.execution_generation_id === executionGenerationId,
    );
    if (attempt && execution && !execution.terminal) {
      await this.options.durability.recordTerminal(
        attempt.work_attempt_id,
        executionGenerationId,
        {
          ...this.options.terminalPayload(terminal, execution.actor),
          generation: execution.generation,
        },
      );
      if (current.desired_state === "stopped") {
        await this.options.durability.releaseTerminalExecutionFence(
          attempt.work_attempt_id,
          executionGenerationId,
        );
      }
    }
    await this.options.observeProviderExit(
      entryId,
      terminal,
      "daemon-provider",
      executionGenerationId,
      handle,
    );
    return true;
  }

  private async revalidateReturnedProviderControl(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    generation: number,
    expectedEpoch: number,
  ): Promise<"current" | "fenced" | "handoff"> {
    if (this.options.authority.isHandoffScheduled()) return "handoff";
    if (this.options.concurrency.currentControlEpoch(entryId) === expectedEpoch) return "current";
    return await this.fenceReturnedProviderAfterControl(
      entryId,
      handle,
      executionGenerationId,
      generation,
    )
      ? "fenced"
      : this.options.authority.isHandoffScheduled() ? "handoff" : "current";
  }

  async persistProviderHandle(
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    appliedRevision: number,
    requestedAuthorityMode: LifecycleAuthorityMode,
  ): Promise<void> {
    const providerConnection = handle.providerConnection;
    if (!handle.providerContinuationId || !providerConnection) {
      throw new Error("Provider launch did not return an exact durable native birth.");
    }
    await this.options.authority.serializeManifestMutation(async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await this.options.authority.assertCurrent();
        const snapshot = await this.options.store.load();
        const current = snapshot.entries.find((candidate) => candidate.id === entryId);
        if (!current || current.work_attempt_id !== handle.workAttemptId) {
          throw new DaemonFenceLostError("Provider birth no longer matches the durable work attempt.");
        }
        try {
          const next = await this.options.store.checkpointProviderBirth(
            snapshot.generation,
            {
              entry: this.providerBirthEntry(current, handle, executionGenerationId),
              executionGenerationId,
              providerConnection,
              appliedRevision,
              requestedAuthorityMode,
              observedAtMs: this.options.nowMs(),
            },
            this.options.authority.fenceCommit,
          );
          this.options.authority.acceptManifestGeneration(next.generation);
          return;
        } catch (error) {
          if (!(error instanceof ManifestConflictError)) throw error;
        }
      }
      throw new DaemonFenceLostError("Provider birth could not converge on the latest manifest generation.");
    });
  }

  private providerBirthEntry(
    current: DaemonManifestEntry,
    handle: ProviderActionHandle,
    executionGenerationId: string,
  ): DaemonManifestEntry {
    if (!handle.providerContinuationId || !handle.providerConnection) {
      throw new Error("Provider launch did not return an exact durable native birth.");
    }
    return {
      ...current,
      run_id: executionGenerationId,
      deployment_id: serializeDaemonDeploymentId(current.id, executionGenerationId),
      provider_ref: {
        work_attempt_id: handle.workAttemptId,
        provider_continuation_id: handle.providerContinuationId,
        provider_connection: structuredClone(handle.providerConnection),
        execution_generation_id: executionGenerationId,
        ...(handle.custodyLaunchAgentSessionId ? { custodial_launch_agent_session_id: handle.custodyLaunchAgentSessionId } : {}),
      },
    };
  }

  private async persistDispatchedProvider(
    token: symbol,
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    appliedRevision: number,
    requestedAuthorityMode: LifecycleAuthorityMode,
  ): Promise<void> {
    if (this.options.authority.isHandoffScheduled()) {
      await this.persistReturnedProviderForHandoff(
        token,
        entryId,
        handle,
        executionGenerationId,
        appliedRevision,
        requestedAuthorityMode,
      );
      return;
    }
    try {
      await this.persistProviderHandle(
        entryId,
        handle,
        executionGenerationId,
        appliedRevision,
        requestedAuthorityMode,
      );
    } catch (error) {
      if (!this.options.authority.isHandoffScheduled()
        || !(error instanceof DaemonFenceLostError)) throw error;
      await this.persistReturnedProviderForHandoff(
        token,
        entryId,
        handle,
        executionGenerationId,
        appliedRevision,
        requestedAuthorityMode,
      );
    }
  }

  private async persistReturnedProviderForHandoff(
    token: symbol,
    entryId: string,
    handle: ProviderActionHandle,
    executionGenerationId: string,
    appliedRevision: number,
    requestedAuthorityMode: LifecycleAuthorityMode,
  ): Promise<void> {
    if (!handle.providerContinuationId) {
      throw new Error("Provider launch did not return a durable continuation id.");
    }
    const reservation = this.activeDispatches.get(token);
    if (!this.options.authority.isHandoffScheduled()
      || !reservation
      || reservation.entryId !== entryId
      || reservation.executionGenerationId !== executionGenerationId
      || reservation.daemonGeneration !== this.options.authority.currentDaemonGeneration()) {
      throw new DaemonFenceLostError("Retiring provider dispatch reservation is no longer exact.");
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.options.authority.assertCurrent();
      const activeBeforeRead = this.activeDispatches.get(token);
      if (!this.options.authority.isHandoffScheduled()
        || activeBeforeRead !== reservation
        || activeBeforeRead.daemonGeneration !== this.options.authority.currentDaemonGeneration()) {
        throw new DaemonFenceLostError("Retiring provider dispatch persistence gate closed.");
      }
      const snapshot = await this.options.store.load();
      const current = snapshot.entries.find((candidate) => candidate.id === entryId);
      if (!current || current.work_attempt_id !== handle.workAttemptId) {
        throw new DaemonFenceLostError(
          "Retiring provider dispatch no longer matches the durable work attempt.",
        );
      }
      if (!handle.providerConnection) throw new Error("Provider handoff requires an exact native birth.");
      const updated = this.providerBirthEntry(current, handle, executionGenerationId);
      try {
        // Deliberately bypass the ordinary manifest-mutation lane: handoff has
        // fenced new mutations, but the retiring daemon must still journal an
        // already-returned native birth before yielding singleton authority.
        const next = await this.options.store.checkpointProviderBirth(
          snapshot.generation,
          {
            entry: updated,
            executionGenerationId,
            providerConnection: handle.providerConnection,
            appliedRevision,
            requestedAuthorityMode,
            observedAtMs: this.options.nowMs(),
          },
          (commit) => this.options.authority.serializeManifestCommit(async () => {
            const active = this.activeDispatches.get(token);
            if (!this.options.authority.isHandoffScheduled()
              || active !== reservation
              || active.daemonGeneration !== this.options.authority.currentDaemonGeneration()) {
              throw new DaemonFenceLostError(
                "Retiring provider dispatch persistence gate closed.",
              );
            }
            await this.options.authority.assertCurrent();
            await commit();
          }),
        );
        this.options.authority.acceptManifestGeneration(next.generation);
        return;
      } catch (error) {
        if (!(error instanceof ManifestConflictError)) throw error;
      }
    }
    throw new DaemonFenceLostError(
      "Retiring provider dispatch persistence could not converge on the latest manifest generation.",
    );
  }

  async attachLiveProvider(
    entry: DaemonManifestEntry,
    mayStartDelivery: () => boolean = () => true,
  ): Promise<ProviderActionHandle | null> {
    if (deliveryDrainBlocksRuntime(await this.options.store.unresolvedDeliveryDrain(entry.id))) return null;
    const activation = await this.options.store.unresolvedPollingActivation(entry.id);
    if (activation && !matchesPollingActivationRuntime(activation, entry)) return null;
    const ref = entry.provider_ref;
    if (!ref) return null;
    const attempt = await this.options.durability.getAttempt(ref.work_attempt_id);
    const execution = attempt.execution_generations.find(
      (candidate) => candidate.execution_generation_id === ref.execution_generation_id,
    );
    if (!execution) {
      throw new Error("Manifest provider reference has no matching durable execution generation.");
    }
    if (execution.terminal) return null;
    const configuration = await this.options.store.getAgentConfiguration(entry.id);
    const appliedRevision = configuration?.runtime_configuration_revision;
    if (!Number.isSafeInteger(appliedRevision) || appliedRevision! < 1) {
      throw new Error("Attached provider has no exact durable applied configuration.");
    }
    const frozenAuthority = ref.provider_connection
      ? await this.options.store.readRuntimeLifecycleAuthority({
          agentId: entry.id,
          executionGenerationId: ref.execution_generation_id,
          providerConnection: ref.provider_connection,
          configurationRevision: appliedRevision!,
        })
      : null;
    const attachment = await this.options.provider.attach(
      this.providerRef(entry, frozenAuthority ?? undefined),
    );
    if (!attachment) return null;
    if (this.isAttachTerminal(attachment)) {
      const terminal = attachment.terminal;
      if (terminal.providerContinuationId
        && terminal.providerContinuationId !== ref.provider_continuation_id) {
        throw new Error(
          "Provider attach terminal evidence belongs to a different durable continuation.",
        );
      }
      await this.options.durability.recordTerminal(
        ref.work_attempt_id,
        execution.execution_generation_id,
        {
          ...this.options.terminalPayload(terminal, execution.actor),
          actor: execution.actor,
          generation: execution.generation,
        },
      );
      await this.options.durability.releaseTerminalExecutionFence(
        ref.work_attempt_id,
        execution.execution_generation_id,
      );
      return null;
    }
    const handle = attachment;
    if (activation && !matchesPollingActivationRuntime(activation, entry, handle)) {
      throw new Error("Attached provider does not match the unresolved polling activation.");
    }
    if (handle.workAttemptId !== ref.work_attempt_id
      || handle.providerContinuationId !== ref.provider_continuation_id) {
      throw new Error("Attached provider does not match the durable provider continuation.");
    }
    let authoritativeEntry = entry;
    if (handle.providerConnection && ref.provider_connection
      && !sameProviderActionConnectionIdentity(
        ref.provider_connection,
        handle.providerConnection,
      )) {
      throw new Error(
        "Attached provider returned connection evidence that conflicts with the durable manifest.",
      );
    }
    if (handle.appliedConfigurationRevision !== undefined
      && handle.appliedConfigurationRevision !== appliedRevision) {
      throw new Error("Attached provider has no exact durable applied configuration.");
    }
    handle.appliedConfigurationRevision = appliedRevision;
    const recoveredConnection = handle.providerConnection;
    const recoveredAuthority = recoveredConnection
      ? await this.options.store.readRuntimeLifecycleAuthority({
          agentId: entry.id,
          executionGenerationId: ref.execution_generation_id,
          providerConnection: recoveredConnection,
          configurationRevision: appliedRevision!,
        })
      : null;
    if (recoveredConnection && (!ref.provider_connection || recoveredAuthority === null)) {
      authoritativeEntry = await this.options.authority.serializeManifestMutation(async () => {
        for (let attemptIndex = 0; attemptIndex < 8; attemptIndex += 1) {
          await this.options.authority.assertCurrent();
          const snapshot = await this.options.store.load();
          const current = snapshot.entries.find((candidate) => candidate.id === entry.id);
          const currentRef = current?.provider_ref;
          if (!current || current.work_attempt_id !== ref.work_attempt_id
            || currentRef?.work_attempt_id !== ref.work_attempt_id
            || currentRef.execution_generation_id !== ref.execution_generation_id
            || currentRef.provider_continuation_id !== ref.provider_continuation_id) {
            throw new DaemonFenceLostError(
              "Provider authority changed before recovered connection evidence could be checkpointed.",
            );
          }
          if (currentRef.provider_connection
            && !sameProviderActionConnectionSnapshot(
              currentRef.provider_connection,
              recoveredConnection,
            )) {
            throw new Error(
              "Recovered provider connection conflicts with the durable manifest.",
            );
          }
          try {
            const next = await this.options.store.checkpointProviderBirth(
              snapshot.generation,
              {
                entry: {
                  ...current,
                  provider_ref: {
                    ...currentRef,
                    provider_connection: structuredClone(recoveredConnection),
                  },
                },
                executionGenerationId: ref.execution_generation_id,
                providerConnection: recoveredConnection,
                appliedRevision: appliedRevision!,
                // This process predates native-birth capture. Recovering its
                // connection must not infer authority from the current release.
                requestedAuthorityMode: "legacy",
                observedAtMs: this.options.nowMs(),
              },
              this.options.authority.fenceCommit,
            );
            this.options.authority.acceptManifestGeneration(next.generation);
            return next.entry;
          } catch (error) {
            if (!(error instanceof ManifestConflictError)) throw error;
          }
        }
        throw new DaemonFenceLostError(
          "Recovered provider birth could not converge on the latest manifest generation.",
        );
      });
    }
    await this.options.durability.recoverExecutionFence(ref.work_attempt_id);
    await this.options.streams.install(
      authoritativeEntry.id,
      handle,
      ref.execution_generation_id,
      mayStartDelivery,
    );
    const binding = await this.options.bindings.get(authoritativeEntry.id);
    if ((authoritativeEntry.delivery_mode ?? "mcp_polling") === "mcp_polling"
      && !await this.options.host.requiresGrant(authoritativeEntry)
      && binding && binding.execution_generation_id !== ref.execution_generation_id) {
      try {
        await this.options.streams.stageWorkerBindingAfterResume(
          authoritativeEntry,
          binding,
          ref.execution_generation_id,
          handle,
        );
        await this.options.transition(
          authoritativeEntry.id,
          "recovering",
          "coordination_blocked",
          "reattached resumed provider awaits exact worker wait evidence",
          "daemon-convergence",
        );
      } catch (error) {
        await this.options.transition(
          authoritativeEntry.id,
          "recovering",
          "coordination_blocked",
          `reattached provider worker binding could not be staged: ${error instanceof Error ? error.message : "unknown binding recovery failure"}`,
          "daemon-convergence",
        );
      }
    }
    return handle;
  }

  async converge(entryId: string): Promise<void> {
    if (this.options.authority.isHandoffScheduled()) return;
    if (deliveryDrainBlocksRuntime(await this.options.store.unresolvedDeliveryDrain(entryId))) return;
    let entry = await this.options.store.getEntry(entryId);
    if (!entry) return;
    let launchControlEpoch = this.options.concurrency.currentControlEpoch(entryId);

    const historicalControl = entry.turn_control;
    if (historicalControl && historicalControl.status !== "completed"
      && entry.work_attempt_id === historicalControl.work_attempt_id) {
      const attempt = await this.options.durability.getAttempt(historicalControl.work_attempt_id);
      const controlledExecution = attempt.execution_generations.find(
        (candidate) => candidate.execution_generation_id
          === historicalControl.execution_generation_id,
      );
      if (controlledExecution?.terminal) {
        entry = await this.options.completeTurnControlForRuntimeRecovery(entry);
      }
    }

    if (entry.desired_state === "running") {
      await this.convergeRunning(entry, launchControlEpoch);
      return;
    }
    await this.convergeStopped(entry);
  }

  private async convergeRunning(
    initialEntry: DaemonManifestEntry,
    initialControlEpoch: number,
  ): Promise<void> {
    let entry = initialEntry;
    const activation = await this.options.store.unresolvedPollingActivation(entry.id);
    if (activation && !matchesPollingActivationRuntime(activation, entry, this.options.streams.get(entry.id))) return;
    let launchControlEpoch = initialControlEpoch;
    if (entry.condition === "quarantined") return;
    if (entry.id.startsWith("supervised_rental_")) {
      const rentalConfiguration = await this.options.store.getAgentConfiguration(entry.id);
      try {
        if (!rentalConfiguration) throw new Error("Rental agent configuration is unavailable.");
        assertSupervisedRentalPermissionProfileAvailable(
          rentalConfiguration.provider,
          rentalConfiguration.permission_profile_id,
        );
      } catch (error) {
        await this.options.delivery.stop(entry.id).catch(() => undefined);
        await this.options.transition(
          entry.id,
          "failed",
          "quarantined",
          error instanceof Error ? error.message : "Unsafe rental permission profile.",
          "daemon-convergence",
        );
        return;
      }
    }
    if (await this.options.host.requiresGrant(entry) && !this.options.host.currentGrant(entry)) return;
    if (entry.delivery_mode === "daemon_inbox") {
      const cursor = await this.options.inbox.cursor(entry.id);
      if (!cursor || cursor.agent_id !== entry.id || cursor.room_id !== entry.room_id) return;
    }
    if (await this.options.host.requiresGrant(entry) && !await this.options.host.ensureGrantFresh(entry)) return;
    const currentAfterGrant = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
    if (!currentAfterGrant) return;
    entry = currentAfterGrant;
    if (entry.desired_state !== "running"
      || this.options.concurrency.currentControlEpoch(entry.id) !== launchControlEpoch
      || this.options.authority.isHandoffScheduled()) return;
    if (entry.observed_state === "failed") {
      const now = this.options.nowMs();
      const exitsInWindow = (entry.reconciliation?.exit_timestamps_ms ?? [])
        .filter((at) => at >= now - CRASH_LOOP_WINDOW_MS).length;
      if (exitsInWindow >= CRASH_LOOP_EXIT_LIMIT) {
        await this.options.transition(
          entry.id,
          "failed",
          "quarantined",
          "crash-loop threshold reached before provider restart",
          "daemon-convergence",
        );
        return;
      }
      const restartAt = entry.reconciliation?.next_restart_at_ms;
      if (typeof restartAt === "number" && restartAt > now) {
        this.scheduleRecovery(entry.id, restartAt - now);
        return;
      }
    }
    entry = await this.ensureWorkAttempt(entry);
    const currentAfterAttempt = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
    if (!currentAfterAttempt) return;
    entry = currentAfterAttempt;
    let handle = this.options.streams.get(entry.id) ?? null;
    if (!handle && entry.provider_ref) {
      try {
        handle = await this.attachLiveProvider(entry);
      } catch (error) {
        if ((error as { providerAttachOutcome?: unknown })?.providerAttachOutcome !== "in_progress") {
          throw error;
        }
        await this.options.transition(
          entry.id,
          "recovering",
          "none",
          "exact Cursor turn wrapper is still finishing; retrying without launching a successor",
          "daemon-convergence",
        );
        this.scheduleRecovery(entry.id, 250);
        return;
      }
      entry = await this.options.store.getEntry(entry.id) ?? entry;
    }
    if (handle) {
      await this.convergeAttachedHandle(entry, handle);
      return;
    }
    await this.launchProvider(entry, launchControlEpoch);
  }

  private async convergeAttachedHandle(
    initialEntry: DaemonManifestEntry,
    handle: ProviderActionHandle,
  ): Promise<void> {
    let entry = initialEntry;
    const activation = await this.options.store.unresolvedPollingActivation(entry.id);
    if (activation && !matchesPollingActivationRuntime(activation, entry, handle)) return;
    const grant = this.options.host.currentGrant(entry);
    const daemonGeneration = this.options.authority.currentDaemonGeneration();
    const controlEpoch = this.options.concurrency.currentControlEpoch(entry.id);
    const requiresGrant = await this.options.host.requiresGrant(entry);
    if (requiresGrant) {
      if (!grant) return;
      const binding = await this.options.bindings.get(entry.id);
      const exactBinding = await this.hasExactHostBinding(entry, handle);
      const supervisedSession = binding
        ? await this.options.bindings.supervisedWorkerSession(entry.id)
        : null;
      const expiring = binding
        ? await this.options.host.bearerNeedsRotation(entry, binding)
        : false;
      let minted: BoundWorkerAuthorization | null = null;
      if ((!exactBinding || expiring) && entry.provider_ref?.execution_generation_id) {
        const executionGenerationId = entry.provider_ref.execution_generation_id;
        try {
          minted = await this.options.host.mintSession(entry, executionGenerationId);
          if (minted) {
            await this.options.host.bindMintedSession(entry.id, minted);
            entry = await this.options.store.getEntry(entry.id) ?? entry;
          }
        } catch (error) {
          const bearerExpiry = supervisedSession?.expires_at
            ? Date.parse(supervisedSession.expires_at)
            : Number.NaN;
          if (!exactBinding) {
            await this.options.host.recordBindingRecoveryFailure(
              entry.id,
              executionGenerationId,
              error,
            );
            return;
          }
          if (Number.isFinite(bearerExpiry) && bearerExpiry <= this.options.nowMs()) {
            await this.options.host.blockExpiredAuthority(
              entry,
              `Worker bearer rotation failed after expiry: ${error instanceof Error ? error.message : "unknown error"}`,
            );
            return;
          }
        }
      }
      if (this.options.authority.isHandoffScheduled()
        || this.options.authority.currentDaemonGeneration() !== daemonGeneration
        || this.options.concurrency.currentControlEpoch(entry.id) !== controlEpoch
        || this.options.host.currentGrant(entry) !== grant) return;
      if (!await this.hasExactHostBinding(entry, handle, minted ?? undefined)) {
        if (entry.provider_ref?.execution_generation_id) {
          await this.options.host.recordBindingRecoveryFailure(entry.id,
            entry.provider_ref.execution_generation_id,
            new Error("Provider is running; its exact worker authority is not yet bound."));
        }
        return;
      }
    }
    const installation = this.options.streams.currentInstallation(entry.id);
    const typed = entry.delivery_mode === "daemon_inbox"
      && installation?.handle === handle
      && installation.authorityMode === "typed";
    if (!typed && entry.observed_state !== handle.observedState) {
      await this.options.transition(
        entry.id,
        handle.observedState,
        entry.condition,
        "reattached durable provider handle",
        "daemon-convergence",
      );
    }
    const terminal = (typed && ["failed", "stopped"].includes(entry.observed_state))
      || (!typed && (["failed", "stopped"].includes(handle.observedState)
        || (handle.observedState === "idle" && !requiresGrant)));
    if (terminal) {
      await this.options.streams.fenceTerminalOnce(
        handle,
        `manifest:${entry.id}:reattached-terminal:${entry.provider_ref?.execution_generation_id ?? "unknown"}`,
      );
      return;
    }
    if (entry.desired_state === "running" && entry.delivery_mode === "daemon_inbox") {
      await this.options.delivery.start(entry.id, "ensure");
    }
  }

  /** Delivery readiness comes from durable worker authority, never provider polling output. */
  private async hasExactHostBinding(
    entry: DaemonManifestEntry,
    handle: ProviderActionHandle,
    minted?: BoundWorkerAuthorization,
  ): Promise<boolean> {
    const ref = entry.provider_ref;
    const grant = this.options.host.currentGrant(entry);
    const daemonGeneration = this.options.authority.currentDaemonGeneration();
    const controlEpoch = this.options.concurrency.currentControlEpoch(entry.id);
    if (!ref || !grant || entry.work_attempt_id !== ref.work_attempt_id
      || this.options.streams.get(entry.id) !== handle
      || handle.workAttemptId !== ref.work_attempt_id
      || handle.providerContinuationId !== ref.provider_continuation_id
      || !sameProviderActionConnectionSnapshot(ref.provider_connection, handle.providerConnection)) return false;
    const binding = await this.options.bindings.get(entry.id);
    if (!binding || binding.entry_id !== entry.id || binding.room_id !== entry.room_id
      || binding.work_attempt_id !== ref.work_attempt_id
      || binding.execution_generation_id !== ref.execution_generation_id
      || binding.api_url !== grant.apiUrl) return false;
    const credential = await this.options.bindings.credentialFor(binding);
    if (!credential || (minted && (binding.agent_session_id !== minted.agentSessionId
      || binding.credential_ref !== minted.bearerId || credential !== minted.bearer))) return false;
    const attempt = await this.options.durability.getAttempt(ref.work_attempt_id);
    if (!attempt.execution_generations.some((candidate) =>
      candidate.execution_generation_id === ref.execution_generation_id && !candidate.terminal)) return false;
    if (entry.delivery_mode === "daemon_inbox") {
      const cursor = await this.options.inbox.cursor(entry.id);
      if (!cursor || cursor.agent_id !== entry.id || cursor.room_id !== entry.room_id) return false;
    } else if (!await this.options.host.requiresGrant(entry) || !binding.room_cursor) return false;
    if (!await this.options.authority.ownsDaemonGeneration(daemonGeneration)) return false;
    const current = await this.options.store.getEntry(entry.id);
    return Boolean(current && current.desired_state === "running"
      && current.delivery_mode === entry.delivery_mode && current.room_id === entry.room_id
      && current.work_attempt_id === ref.work_attempt_id
      && current.provider_ref?.work_attempt_id === ref.work_attempt_id
      && current.provider_ref.execution_generation_id === ref.execution_generation_id
      && current.provider_ref.provider_continuation_id === ref.provider_continuation_id
      && sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, ref.provider_connection)
      && handle.providerContinuationId === ref.provider_continuation_id
      && sameProviderActionConnectionSnapshot(handle.providerConnection, ref.provider_connection)
      && this.options.streams.get(entry.id) === handle
      && this.options.host.currentGrant(current) === grant
      && this.options.concurrency.currentControlEpoch(entry.id) === controlEpoch);
  }

  private async launchProvider(
    initialEntry: DaemonManifestEntry,
    initialControlEpoch: number,
  ): Promise<void> {
    // Unresolved native dispatch may recover its exact handle, never replay in a successor.
    if (await this.options.store.unresolvedDeliveryDrain(initialEntry.id)
      || await this.options.store.unresolvedPollingActivation(initialEntry.id)) return;
    let entry = initialEntry;
    let launchControlEpoch = initialControlEpoch;
    const attempt = await this.options.durability.getAttempt(entry.work_attempt_id!);
    const activeExecution = attempt.execution_generations.find(
      (candidate) => candidate.terminal === null,
    );
    const resumableCursorLane = entry.provider === "cursor"
      && entry.delivery_mode === "daemon_inbox"
      && entry.provider_ref?.provider_connection?.kind === "cursor_cli";
    if (activeExecution && !resumableCursorLane) {
      await this.options.transition(
        entry.id,
        "recovering",
        "coordination_blocked",
        "durable execution generation remains live without an attachable provider handle",
        "daemon-convergence",
      );
      return;
    }
    if (!activeExecution && entry.turn_control && entry.turn_control.status !== "completed") {
      entry = await this.options.completeTurnControlForRuntimeRecovery(entry);
    }
    const priorBinding = entry.provider_ref
      ? await this.options.bindings.get(entry.id)
      : null;
    const resumeWorker = priorBinding
      && priorBinding.room_id === entry.room_id
      && priorBinding.work_attempt_id === attempt.work_attempt_id
      ? {
          agentSessionId: priorBinding.agent_session_id,
          roomCursor: priorBinding.room_cursor ?? null,
        }
      : null;
    const ref = entry.provider_ref ? this.providerRef(entry) : null;
    const requiresGrant = await this.options.host.requiresGrant(entry);
    const mintedAuthorization = requiresGrant
      ? await this.options.host.mintAuthorization(entry)
      : null;
    if (requiresGrant && !mintedAuthorization) return;
    const currentAfterMint = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
    if (!currentAfterMint) return;
    entry = currentAfterMint;
    const capabilities = await this.options.provider.capabilities(
      attempt.work_attempt_id,
      entry.provider,
    );
    const currentAfterCapabilities = await this.launchEntryIfCurrent(
      entry.id,
      launchControlEpoch,
    );
    if (!currentAfterCapabilities) return;
    entry = currentAfterCapabilities;
    const deliveryMode = entry.delivery_mode ?? "mcp_polling";
    if (capabilities.deliveryModes && !capabilities.deliveryModes.includes(deliveryMode)) {
      await this.options.transition(
        entry.id,
        "failed",
        "coordination_blocked",
        `${supervisedProviderLabel(entry.provider)} does not support ${deliveryMode} room delivery.`,
        "daemon-convergence",
      );
      return;
    }
    const requestedAuthorityMode = lifecycleAuthorityModeForProvider(
      lifecycleAuthorityProviderSchema.parse(entry.provider),
      deliveryMode,
    );
    const resumed = Boolean(ref && capabilities.resume);
    if (requiresGrant) {
      const grant = this.options.host.currentGrant(entry);
      if (!grant || !await this.options.authority.ownsDaemonGeneration(grant.daemonGeneration)) return;
    }
    await this.options.transition(
      entry.id,
      entry.provider_ref ? "recovering" : "starting",
      "none",
      entry.provider_ref
        ? "recovering durable provider continuation"
        : "starting daemon-owned provider",
      "daemon-convergence",
    );
    const currentAfterTransition = await this.launchEntryIfCurrent(
      entry.id,
      launchControlEpoch,
    );
    if (!currentAfterTransition) return;
    entry = currentAfterTransition;
    if (requiresGrant) {
      const grant = this.options.host.currentGrant(entry);
      if (!grant || !await this.options.authority.ownsDaemonGeneration(grant.daemonGeneration)) return;
    }
    const launchConfiguration = await this.options.store.getAgentConfiguration(entry.id);
    if (!launchConfiguration) {
      throw new Error("Agent configuration disappeared before provider launch.");
    }
    const permissionProfileId = entry.id.startsWith("supervised_rental_")
      ? assertSupervisedRentalPermissionProfileAvailable(
          launchConfiguration.provider,
          launchConfiguration.permission_profile_id,
        )
      : assertSupervisedPermissionProfileAvailable(
          launchConfiguration.provider,
          launchConfiguration.permission_profile_id,
        );
    const launchSnapshot = deriveProviderConfigurationSnapshot({
      provider: launchConfiguration.provider,
      model: launchConfiguration.model,
      reasoningEffort: launchConfiguration.reasoning_effort ?? null,
      permissionProfileId,
      configurationRevision: launchConfiguration.config_revision,
    }, launchConfiguration.provider_launch_policy);
    const openModelCredential = entry.provider === "open-model"
      ? this.options.host.currentOpenModelCredential(
          entry.id,
          this.options.authority.currentDaemonGeneration(),
        )
      : null;
    if (entry.provider === "open-model"
      && (!openModelCredential
        || openModelCredential.daemonGeneration
          !== this.options.authority.currentDaemonGeneration())) {
      throw new Error("Waiting for desktop Open Model credential handoff.");
    }
    const reusesActiveCursorExecution = Boolean(resumableCursorLane && activeExecution);
    const generationNumber = reusesActiveCursorExecution
      ? activeExecution!.generation
      : attempt.execution_generations.reduce(
          (max, candidate) => Math.max(max, candidate.generation),
          0,
        ) + 1;
    const execution = reusesActiveCursorExecution
      ? activeExecution!
      : await this.options.durability.startGeneration(
          attempt.work_attempt_id,
          "daemon-provider",
          generationNumber,
        );
    if (reusesActiveCursorExecution && priorBinding
      && priorBinding.execution_generation_id !== execution.execution_generation_id) {
      throw new Error(
        "Process-less Cursor recovery found a worker binding for a different execution generation.",
      );
    }
    if (!await this.launchEntryIfCurrent(entry.id, launchControlEpoch)) {
      if (!reusesActiveCursorExecution) {
        await this.terminalizeUnlaunchedGeneration(
          attempt,
          execution.execution_generation_id,
          generationNumber,
        );
      }
      return;
    }
    const devMcpServerEntryPath = devMcpServerEntryFromEnv() ?? undefined;
    let mintedHostSession: BoundWorkerAuthorization | null = null;
    const spawn: ProviderActionSpawn = {
      workAttemptId: attempt.work_attempt_id,
      roomId: entry.room_id,
      cwd: attempt.workspace_path,
      // The validated work-attempt identity is the authority for the exact
      // workspace being launched, including entries with legacy launch intent.
      workspaceKind: isEphemeralWorkspaceMarker(attempt.workspace_identity)
        ? "room_scratch"
        : "git_worktree",
      launchPolicy: launchSnapshot.launchPolicy,
      provider: launchSnapshot.provider,
      model: launchSnapshot.model,
      reasoningEffort: launchSnapshot.reasoningEffort,
      permissionProfileId: launchSnapshot.permissionProfileId,
      configurationRevision: launchSnapshot.configurationRevision,
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
      lifecycleAuthorityMode: requestedAuthorityMode,
      ...(launchConfiguration.polling_contract ? { pollingContract: launchConfiguration.polling_contract } : {}),
      agentDisplayName: entry.display_name,
      actionId: `manifest:${entry.id}:generation:${generationNumber}`,
      supervisorEntryId: entry.id,
      supervisorSocketPath: this.options.socketPath,
      supervisorExecutionGenerationId: execution.execution_generation_id,
      ...(resumeWorker ? { supervisorWorkerSession: resumeWorker } : {}),
      ...(devMcpServerEntryPath && ["codex", "open-model", "cursor"].includes(entry.provider)
        ? { devMcpServerEntryPath }
        : {}),
      ...(openModelCredential ? {
        providerCredential: {
          apiKey: openModelCredential.apiKey,
          baseUrl: openModelCredential.baseUrl,
          model: launchSnapshot.model?.trim() || openModelCredential.model,
        },
      } : {}),
    };
    let handle: ProviderActionHandle | null = null;
    let providerPersisted = false;
    let providerDispatched = false;
    let unpersistedReturnedProviderFenced = false;
    try {
      if (mintedAuthorization) {
        mintedHostSession = await this.options.host.recordMintedSession(
          entry,
          execution.execution_generation_id,
          mintedAuthorization,
        );
        if (!mintedHostSession) throw new Error("Waiting for desktop credential handoff.");
        Object.assign(spawn, {
          supervisorWorkerSession: {
            agentSessionId: mintedHostSession.agentSessionId,
            ...(launchConfiguration.polling_contract ? { apiUrl: mintedHostSession.apiUrl } : {}),
            roomCursor: launchConfiguration.polling_contract
              ? resumeWorker?.roomCursor ?? attempt.checkpoints.at(-1)?.room_cursor ?? null
              : null,
          },
        });
      }
      if (!await this.launchEntryIfCurrent(entry.id, launchControlEpoch)) {
        if (!reusesActiveCursorExecution) {
          await this.terminalizeUnlaunchedGeneration(
            attempt,
            execution.execution_generation_id,
            generationNumber,
          );
        }
        return;
      }
      const dispatchReservation = this.reserveDispatch(
        entry.id,
        execution.execution_generation_id,
      );
      let fatalReservationError: unknown;
      try {
        try {
          handle = resumed
            ? await this.options.provider.resume(ref!, { ...spawn, resumeFrom: ref })
            : await this.options.provider.spawn(spawn);
          providerDispatched = true;
          if (handle.appliedConfigurationRevision !== launchSnapshot.configurationRevision) {
            throw new Error(
              "Provider launch did not attest the complete configuration snapshot.",
            );
          }
          await this.persistDispatchedProvider(
            dispatchReservation.token,
            entry.id,
            handle,
            execution.execution_generation_id,
            launchSnapshot.configurationRevision,
            requestedAuthorityMode,
          );
          providerPersisted = true;
          // A retiring daemon owns only the atomic provider-birth checkpoint.
          // Its successor can reconcile the secondary attempt checkpoint from
          // that durable manifest without extending the handoff boundary.
          if (this.options.authority.isHandoffScheduled()) return;
          await this.options.durability.checkpoint(attempt.work_attempt_id, {
            room_cursor: launchConfiguration.polling_contract
              ? spawn.supervisorWorkerSession?.roomCursor ?? null
              : null,
            provider_continuation_id: handle.providerContinuationId,
          });
          let control = await this.revalidateReturnedProviderControl(
            entry.id,
            handle,
            execution.execution_generation_id,
            generationNumber,
            launchControlEpoch,
          );
          if (control === "handoff" || control === "fenced") return;
          launchControlEpoch = this.options.concurrency.currentControlEpoch(entry.id);
          if (this.options.authority.isHandoffScheduled()) return;
          await this.options.streams.install(
            entry.id,
            handle,
            execution.execution_generation_id,
            () => !mintedHostSession
              && !this.options.authority.isHandoffScheduled()
              && this.options.concurrency.currentControlEpoch(entry.id) === launchControlEpoch,
          );
          if (this.options.authority.isHandoffScheduled()) return;
          control = await this.revalidateReturnedProviderControl(
            entry.id,
            handle,
            execution.execution_generation_id,
            generationNumber,
            launchControlEpoch,
          );
          if (control === "handoff" || control === "fenced") return;
          launchControlEpoch = this.options.concurrency.currentControlEpoch(entry.id);
          if (mintedHostSession) {
            control = await this.revalidateReturnedProviderControl(
              entry.id,
              handle,
              execution.execution_generation_id,
              generationNumber,
              launchControlEpoch,
            );
            if (control === "handoff" || control === "fenced") return;
            launchControlEpoch = this.options.concurrency.currentControlEpoch(entry.id);
            try {
              await this.options.host.bindMintedSession(
                entry.id,
                mintedHostSession,
                () => !this.options.authority.isHandoffScheduled()
                  && this.options.concurrency.currentControlEpoch(entry.id)
                    === launchControlEpoch,
              );
            } catch (error) {
              if (this.options.authority.isHandoffScheduled()) return;
              control = await this.revalidateReturnedProviderControl(
                entry.id,
                handle,
                execution.execution_generation_id,
                generationNumber,
                launchControlEpoch,
              );
              if (control === "handoff" || control === "fenced") return;
              await this.options.host.recordBindingRecoveryFailure(
                entry.id,
                execution.execution_generation_id,
                error,
              );
              return;
            }
            if (this.options.authority.isHandoffScheduled()) return;
            control = await this.revalidateReturnedProviderControl(
              entry.id,
              handle,
              execution.execution_generation_id,
              generationNumber,
              launchControlEpoch,
            );
            if (control === "handoff" || control === "fenced") return;
            launchControlEpoch = this.options.concurrency.currentControlEpoch(entry.id);
          }
          control = await this.revalidateReturnedProviderControl(
            entry.id,
            handle,
            execution.execution_generation_id,
            generationNumber,
            launchControlEpoch,
          );
          if (control === "handoff" || control === "fenced") return;
        } catch (error) {
          if (providerDispatched && !providerPersisted && handle) {
            try {
              await this.fenceUnpersistedReturnedProvider(
                attempt,
                execution.execution_generation_id,
                generationNumber,
                handle,
              );
              unpersistedReturnedProviderFenced = true;
            } catch (cleanupError) {
              fatalReservationError = cleanupError;
              throw new AggregateError(
                [error, cleanupError],
                "Returned provider could not be journaled or exactly fenced.",
              );
            }
          }
          throw error;
        }
      } finally {
        dispatchReservation.release(fatalReservationError);
      }
    } catch (error) {
      if (reusesActiveCursorExecution && !providerPersisted) {
        await this.options.host.recordBindingRecoveryFailure(
          entry.id,
          execution.execution_generation_id,
          error,
        );
        return;
      }
      if (providerPersisted && this.options.authority.isHandoffScheduled()) return;
      if (providerPersisted) {
        await this.options.host.recordBindingRecoveryFailure(
          entry.id,
          execution.execution_generation_id,
          error,
        );
        return;
      }
      if (providerDispatched || unpersistedReturnedProviderFenced) throw error;
      const terminal = this.options.terminalPayload({
        endedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        terminalCause: "protocol_error",
        providerContinuationId: entry.provider_ref?.provider_continuation_id ?? null,
      }, "daemon-provider");
      try {
        await this.options.durability.recordTerminal(
          attempt.work_attempt_id,
          execution.execution_generation_id,
          {
            ...terminal,
            generation: generationNumber,
            actor: "daemon-provider",
          },
        );
        await this.options.durability.releaseTerminalExecutionFence(
          attempt.work_attempt_id,
          execution.execution_generation_id,
        );
      } catch (cleanupError) {
        const launchMessage = error instanceof Error
          ? error.message
          : "unknown provider launch failure";
        const cleanupMessage = cleanupError instanceof Error
          ? cleanupError.message
          : "unknown failed-launch cleanup failure";
        throw new Error(
          `Provider launch failed (${launchMessage}) and durable cleanup failed (${cleanupMessage}).`,
          { cause: error },
        );
      }
      throw error;
    }
    if (!handle) throw new Error("Provider launch returned no handle.");
    if (requestedAuthorityMode !== "typed" && (["failed", "stopped"].includes(handle.observedState)
      || (handle.observedState === "idle" && !requiresGrant))) {
      await this.options.streams.fenceTerminalOnce(
        handle,
        `manifest:${entry.id}:returned-terminal:${generationNumber}`,
      );
      return;
    }
    if (requiresGrant) {
      const current = await this.options.store.getEntry(entry.id);
      if (current) await this.convergeAttachedHandle(current, handle);
      return;
    }
    if ((entry.delivery_mode ?? "mcp_polling") === "mcp_polling" && priorBinding && !resumed) {
      await this.options.transition(
        entry.id,
        "recovering",
        "coordination_blocked",
        "fresh provider generation cannot inherit a terminal worker credential; awaiting exact bind",
        "daemon-convergence",
      );
      return;
    }
    if ((entry.delivery_mode ?? "mcp_polling") === "mcp_polling"
      && resumed && priorBinding && !reusesActiveCursorExecution) {
      try {
        const current = await this.launchEntryIfCurrent(entry.id, launchControlEpoch);
        if (!current) return;
        await this.options.streams.stageWorkerBindingAfterResume(
          current,
          priorBinding,
          execution.execution_generation_id,
          handle,
        );
      } catch (error) {
        await this.options.transition(
          entry.id,
          "recovering",
          "coordination_blocked",
          `resumed provider worker binding could not be staged: ${error instanceof Error ? error.message : "unknown binding recovery failure"}`,
          "daemon-convergence",
        );
        return;
      }
      await this.options.transition(
        entry.id,
        "recovering",
        "coordination_blocked",
        "resumed provider awaits exact worker wait evidence",
        "daemon-convergence",
      );
      return;
    }
    this.options.host.clearSuccessfulRecovery(entry.id);
    await this.options.transition(
      entry.id,
      handle.observedState,
      "none",
      resumed
        ? "provider resumed under daemon authority"
        : "provider launched under daemon authority",
      "daemon-convergence",
    );
  }

  private async convergeStopped(entry: DaemonManifestEntry): Promise<void> {
    let handle = this.options.streams.get(entry.id) ?? null;
    const activation = await this.options.store.unresolvedPollingActivation(entry.id);
    if (activation && !matchesPollingActivationRuntime(activation, entry, handle ?? undefined)) return;
    if (activation && !this.options.provider.stopRef) throw new Error("Polling activation requires exact-reference provider stop.");
    const exactActivationRef = activation ? entry.provider_ref : null;
    const exactCursorRef = entry.provider_ref?.provider_connection?.kind === "cursor_cli"
      ? entry.provider_ref
      : null;
    const exactStopRef = exactActivationRef ?? (!handle ? exactCursorRef : null);
    if (exactStopRef && this.options.provider.stopRef) {
      await this.options.transition(
        entry.id,
        "stopping",
        entry.condition,
        `desired state changed to ${entry.desired_state}`,
        "daemon-convergence",
      );
      const terminal = await this.options.provider.stopRef(this.providerRef(entry), {
        actionId: `manifest:${entry.id}:${entry.desired_state}:${this.options.nowMs()}`,
      });
      const attempt = await this.options.durability.getAttempt(exactStopRef.work_attempt_id);
      const execution = attempt.execution_generations.find(
        (candidate) => candidate.execution_generation_id
          === exactStopRef.execution_generation_id,
      );
      if (!execution) {
        throw new Error(
          "Provider exact-reference stop has no matching durable execution generation.",
        );
      }
      if (!execution.terminal) {
        await this.options.durability.recordTerminal(
          exactStopRef.work_attempt_id,
          exactStopRef.execution_generation_id,
          {
            ...this.options.terminalPayload(terminal, execution.actor),
            actor: execution.actor,
            generation: execution.generation,
          },
        );
        if (entry.desired_state === "stopped") {
          await this.options.durability.releaseTerminalExecutionFence(
            exactStopRef.work_attempt_id,
            exactStopRef.execution_generation_id,
          );
        }
      }
      await this.options.observeProviderExit(
        entry.id,
        terminal,
        "daemon-provider",
        exactStopRef.execution_generation_id,
        handle ?? undefined,
      );
      return;
    }
    if (!handle && entry.provider_ref) handle = await this.attachLiveProvider(entry);
    if (handle) {
      await this.options.transition(
        entry.id,
        "stopping",
        entry.condition,
        `desired state changed to ${entry.desired_state}`,
        "daemon-convergence",
      );
      await this.options.provider.stop(handle, {
        actionId: `manifest:${entry.id}:${entry.desired_state}:${this.options.nowMs()}`,
      });
      return;
    }
    await this.options.transition(
      entry.id,
      entry.desired_state === "paused" ? "paused" : "stopped",
      "none",
      "desired state converged without a live provider",
      "daemon-convergence",
    );
  }
}
