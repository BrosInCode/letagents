import {
  hostGrantApiOrigin,
  lastRoomMessageId,
  SupervisorGrantRequestError,
  type SupervisorGrantHttp,
} from "./cloud-http.js";
import { redactCredentialText } from "./credential-redaction.js";
import { deliveryDrainBlocksRuntime, type DeliveryDrainRecord } from "./delivery-drain.js";
import { matchesPollingActivationRuntime, type PollingActivationRecord } from "./custodial-polling-activation.js";
import {
  retryableWorkerMintFailure,
  schedulerErrorDetail,
  WorkerCredentialMintError,
} from "./daemon-error-policy.js";
import { sameProviderActionConnectionSnapshot, type ProviderActionHandle } from "./provider-action-port.js";
import { resolveReadyReachedAt } from "./provider-stream-policy.js";
import type { SupervisedDeliveryHttp } from "./supervised-agent-delivery.js";
import type { DaemonAgentConfiguration, DaemonManifestEntry, TaskWorkAttempt } from "./types.js";
import type { WorkerBindingStore, WorkerSessionBinding } from "./worker-binding-store.js";
import {
  WORKER_BEARER_ROTATION_LEAD_MS,
  type BoundWorkerAuthorization,
  type CachedWorkerAuthorization,
  type InstalledHostGrant,
  type MintedWorkerAuthorization,
  type WorkerRuntimeCustody,
} from "./worker-runtime-custody.js";

const HOST_GRANT_TTL_MS = 24 * 60 * 60 * 1_000;
const HOST_GRANT_RENEWAL_LEAD_MS = 60 * 60 * 1_000;
const BOOTSTRAP_ROOM_INGRESS_TIMEOUT_MS = 40_000;
const WORKER_MINT_TIMEOUT_MS = 10_000;
const WORKER_MINT_MAX_ATTEMPTS = 3;
const WORKER_MINT_RETRY_DELAY_MS = 100;
const WORKER_BIND_MAX_ATTEMPTS = 3;
const WORKER_BIND_RETRY_DELAYS_MS = [1_000, 3_000] as const;

class InvalidSupervisorGrantRenewalError extends Error {}

export type BootstrapOperation = {
  controller: AbortController;
  phase: "observing" | "committing";
  operation: Promise<unknown>;
};

export type BindWorkerSessionInput = {
  entry_id: string;
  room_id: string;
  work_attempt_id: string;
  execution_generation_id: string;
  agent_session_id: string;
  agent_session_token: string;
  credential_ref?: string;
  api_url: string;
};

export type VerifyWorkerSessionInput = Omit<BindWorkerSessionInput, "credential_ref">;

export type CustodialPollingAuthorizationInput = {
  entry_id: string; room_id: string; work_attempt_id: string; execution_generation_id: string;
  agent_session_id: string; daemon_generation: number; api_url: string;
  contract: string; phase: string; tool_name: string; expected_configuration_revision?: number;
};

export type InstallHostGrantInput = {
  entry_id: string;
  room_id: string;
  agent_key: string;
  grant_id: string;
  supervisor_grant: string;
  grant_generation: number;
  api_url: string;
  daemon_generation: number;
  host_id: string;
  installation_id: string;
  grant_expires_at: string;
  credential_only?: boolean;
  recovery_only?: boolean;
};

type WorkerAuthorityStore = {
  load(): Promise<{ entries: DaemonManifestEntry[] }>;
  getEntry(entryId: string): Promise<DaemonManifestEntry | null | undefined>;
  getAgentConfiguration(entryId: string): Promise<Pick<DaemonAgentConfiguration, "polling_contract" | "config_revision" | "runtime_configuration_revision"> | undefined>;
  unresolvedDeliveryDrain(agentId: string): Promise<DeliveryDrainRecord | null>;
  unresolvedPollingActivation(agentId: string): Promise<PollingActivationRecord | null>;
};

type WorkerAuthorityDurability = {
  getAttempt(workAttemptId: string): Promise<Pick<TaskWorkAttempt, "execution_generations" | "checkpoints">>;
  checkpoint(
    workAttemptId: string,
    checkpoint: { room_cursor: string | null; provider_continuation_id: string | null },
  ): Promise<unknown>;
};

type WorkerAuthorityBindings = Pick<WorkerBindingStore,
  | "get"
  | "bind"
  | "credentialFor"
  | "unbind"
  | "supervisedWorkerSession"
  | "beginSupervisedWorkerSessionMint"
  | "recordExactSupervisedWorkerSessionMint"
  | "recordSupervisedWorkerSession"
  | "installCredential"
  | "checkpointCursorMonotonic"
>;

type WorkerAuthorityCustody = Pick<WorkerRuntimeCustody,
  | "currentHostGrant"
  | "hostGrant"
  | "hostGrantIsCurrent"
  | "installHostGrant"
  | "replaceHostGrantIfCurrent"
  | "destroyHostGrantIfCurrent"
  | "destroyAllCredentials"
  | "installOpenModelCredential"
  | "currentWorkerAuthorization"
  | "installWorkerAuthorization"
  | "deleteWorkerAuthorization"
  | "installLiveBinding"
  | "deleteLiveBinding"
  | "deletePendingResumeBinding"
>;

type WorkerAuthorityInbox = {
  cursor(agentId: string): Promise<{ last_observed_message_id: string | null } | null>;
  enqueueInitialMessage(input: {
    agent_id: string;
    room_id: string;
    source_message_id: string;
    source_message: unknown;
    activation: unknown;
  }): Promise<unknown>;
  bootstrapCursor(input: {
    agent_id: string;
    room_id: string;
    last_observed_message_id: string | null;
  }): Promise<{ created: boolean; last_observed_message_id: string | null }>;
};

export type WorkerAuthorityCoordinatorOptions = {
  store: WorkerAuthorityStore;
  durability: WorkerAuthorityDurability;
  bindings: WorkerAuthorityBindings;
  custody: WorkerAuthorityCustody;
  inbox: WorkerAuthorityInbox;
  supervisorGrantHttp: SupervisorGrantHttp;
  deliveryHttp: Pick<SupervisedDeliveryHttp, "latest">;
  authority: {
    currentGeneration(): number;
    isHandoffScheduled(): boolean;
    assertCurrent(): Promise<void>;
  };
  serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  serializeCursorCheckpoint<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  manifest: {
    updateEntry(entryId: string, update: (entry: DaemonManifestEntry) => DaemonManifestEntry): Promise<DaemonManifestEntry>;
  };
  runtime: {
    currentHandle(entryId: string): ProviderActionHandle | undefined;
    attach(entry: DaemonManifestEntry, mayPublish: () => boolean): Promise<ProviderActionHandle | null>;
  };
  delivery: {
    stop(entryId: string): Promise<void>;
    start(entryId: string): Promise<void>;
  };
  convergence: {
    request(entryId: string): void;
    schedule(entryId: string, delayMs: number): void;
    clear(entryId: string): void;
    heartbeatIntervalMs: number;
  };
  recovery: {
    resetMintAttempts(entryId: string): void;
  };
  activity: {
    publishNative(entryId: string, method: string, status: "working" | "idle"): Promise<boolean>;
    transition(
      entryId: string,
      observedState: "recovering",
      condition: "coordination_blocked",
      detail: string,
      source: "daemon-convergence",
    ): Promise<unknown>;
  };
  boundedContext(input: {
    entryId: string;
    workAttemptId: string;
    executionGenerationId: string;
    daemonGeneration: number;
    providerTurnId: string;
  }): Promise<unknown>;
  nowMs(): number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

/** Owns process-memory worker credentials and every fence governing their use. */
export class WorkerAuthorityCoordinator {
  private readonly bindingRecoveryAttempts = new Map<string, {
    executionGenerationId: string;
    attempts: number;
  }>();

  constructor(private readonly options: WorkerAuthorityCoordinatorOptions) {}

  async pollingContract(entry: DaemonManifestEntry): Promise<"custodial_polling_v1" | null> {
    if ((entry.delivery_mode ?? "mcp_polling") !== "mcp_polling") return null;
    const configuration = await this.options.store.getAgentConfiguration(entry.id);
    if (!configuration) throw new Error("Agent credential custody configuration is unavailable.");
    return configuration.polling_contract ?? null;
  }

  private async assertRuntimeAdmission(entryId: string): Promise<void> {
    if (deliveryDrainBlocksRuntime(await this.options.store.unresolvedDeliveryDrain(entryId))) {
      throw new Error("Worker authority is frozen by delivery handoff.");
    }
  }

  /** Credentials may recover in-place; only a checkpointed explicit activation admits room effects. */
  private async checkPollingActivationWorker(entry: DaemonManifestEntry, agentSessionId: string, executionGenerationId: string, requireActive = false): Promise<PollingActivationRecord | null> {
    const activation = await this.options.store.unresolvedPollingActivation(entry.id);
    if (!activation && !requireActive) return null;
    const current = await this.options.store.getEntry(entry.id);
    const handle = this.options.runtime.currentHandle(entry.id);
    const configuration = await this.options.store.getAgentConfiguration(entry.id);
    if (!activation || !current || !handle || !matchesPollingActivationRuntime(activation, current, handle)
      || this.options.runtime.currentHandle(entry.id) !== handle
      || activation.agent_session_id !== agentSessionId || activation.execution_generation_id !== executionGenerationId
      || (handle.appliedConfigurationRevision !== undefined && handle.appliedConfigurationRevision !== activation.config_revision)
      || configuration?.polling_contract !== "custodial_polling_v1"
      || configuration.config_revision !== activation.config_revision
      || configuration.runtime_configuration_revision !== activation.config_revision
      || (requireActive && (activation.phase !== "active" || !activation.provider_turn_id
        || this.options.authority.isHandoffScheduled()
        || current.desired_state !== "running" || ["failed", "stopped", "stopping"].includes(handle.observedState)))) {
      throw new Error("Custodial polling requires its exact active activation and worker authority.");
    }
    return activation;
  }

  async requiresHostGrant(entry: DaemonManifestEntry): Promise<boolean> {
    return entry.delivery_mode === "daemon_inbox" || await this.pollingContract(entry) !== null;
  }

  currentHostGrant(entry: DaemonManifestEntry): InstalledHostGrant | null {
    return this.options.custody.currentHostGrant(
      { entryId: entry.id, roomId: entry.room_id },
      this.options.authority.currentGeneration(),
      this.options.authority.isHandoffScheduled(),
    );
  }

  private unexpiredHostGrant(entry: DaemonManifestEntry): InstalledHostGrant | null {
    const grant = this.currentHostGrant(entry);
    return grant && Date.parse(grant.expiresAt) > this.options.nowMs() ? grant : null;
  }

  private async hasUnexpiredWorkerSession(entryId: string): Promise<boolean> {
    const binding = await this.options.bindings.get(entryId);
    const session = await this.options.bindings.supervisedWorkerSession(entryId);
    return Boolean(binding && session && session.room_id === binding.room_id
      && session.agent_session_id === binding.agent_session_id
      && session.execution_generation_id === binding.execution_generation_id
      && session.credential_ref === binding.credential_ref
      && session.expires_at && Date.parse(session.expires_at) > this.options.nowMs());
  }

  async ownsDaemonGeneration(expectedGeneration: number): Promise<boolean> {
    if (this.options.authority.isHandoffScheduled()) {
      this.options.custody.destroyAllCredentials();
      return false;
    }
    if (expectedGeneration !== this.options.authority.currentGeneration()) return false;
    try {
      await this.options.authority.assertCurrent();
      if (this.options.authority.isHandoffScheduled()) {
        this.options.custody.destroyAllCredentials();
        return false;
      }
      return expectedGeneration === this.options.authority.currentGeneration();
    } catch {
      this.options.custody.destroyAllCredentials();
      return false;
    }
  }

  private revokeHostGrantIfCurrent(entryId: string, grant: InstalledHostGrant): void {
    this.options.custody.destroyHostGrantIfCurrent(entryId, grant);
  }

  async bindWorkerSession(input: BindWorkerSessionInput): Promise<{ bound: true; entry_id: string; agent_session_id: string }> {
    return this.options.serializeEntry(input.entry_id, () => this.bindWorkerSessionLocked(input));
  }

  private async bindWorkerSessionLocked(
    input: BindWorkerSessionInput,
    mayPublish: () => boolean = () => true,
    authorization?: MintedWorkerAuthorization,
  ): Promise<{ bound: true; entry_id: string; agent_session_id: string }> {
    await this.assertRuntimeAdmission(input.entry_id);
    const entry = (await this.options.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
    if (await this.pollingContract(entry) && !authorization) {
      throw new Error("Custodial polling binds only daemon-minted worker authority.");
    }
    if (entry.room_id !== input.room_id) throw new Error("Worker session room does not match the supervised manifest entry.");
    if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker session work attempt does not match the supervised manifest entry.");
    if (entry.provider_ref?.execution_generation_id !== input.execution_generation_id) {
      throw new Error("Worker session execution generation does not match the active supervised manifest entry.");
    }
    if (authorization && !this.hasMintAuthority(entry, authorization)) {
      throw new Error("Minted worker authority changed before binding.");
    }
    const daemonGeneration = this.options.authority.currentGeneration();
    const grant = this.currentHostGrant(entry);
    const handle = this.options.runtime.currentHandle(entry.id);
    const activation = await this.checkPollingActivationWorker(entry, input.agent_session_id, input.execution_generation_id);
    const providerContinuationId = entry.provider_ref.provider_continuation_id;
    const providerConnection = structuredClone(entry.provider_ref.provider_connection ?? null);
    const pid = handle?.pid;
    const assertEntryCurrent = (current: DaemonManifestEntry | null | undefined): void => {
      if (!current || current.room_id !== input.room_id
        || current.work_attempt_id !== input.work_attempt_id
        || current.provider_ref?.work_attempt_id !== input.work_attempt_id
        || current.provider_ref.execution_generation_id !== input.execution_generation_id
        || current.provider_ref.provider_continuation_id !== providerContinuationId
        || !sameProviderActionConnectionSnapshot(current.provider_ref.provider_connection, providerConnection)
        || current.desired_state !== entry.desired_state
        || current.delivery_mode !== entry.delivery_mode
        || this.options.authority.isHandoffScheduled()
        || this.options.authority.currentGeneration() !== daemonGeneration
        || this.currentHostGrant(current) !== grant
        || this.options.runtime.currentHandle(entry.id) !== handle
        || (handle && (handle.workAttemptId !== input.work_attempt_id
          || handle.providerContinuationId !== providerContinuationId
          || handle.pid !== pid
          || !sameProviderActionConnectionSnapshot(handle.providerConnection, providerConnection)))) {
        throw new Error("Worker binding authority changed before readiness.");
      }
    };
    const assertAuthorityCurrent = async (): Promise<void> => {
      if (!await this.ownsDaemonGeneration(daemonGeneration)) {
        throw new Error("Worker binding daemon authority changed before readiness.");
      }
      assertEntryCurrent(await this.options.store.getEntry(entry.id));
    };
    const attempt = await this.options.durability.getAttempt(input.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
    if (!execution || execution.terminal) throw new Error("Worker session execution generation is absent or terminal.");
    const currentBinding = await this.options.bindings.get(input.entry_id);
    const currentCredential = currentBinding
      ? await this.options.bindings.credentialFor(currentBinding)
      : null;
    const normalizedApiUrl = new URL(input.api_url).origin;
    const exactCurrentBinding = Boolean(currentBinding
      && currentBinding.entry_id === input.entry_id
      && currentBinding.room_id === input.room_id
      && currentBinding.work_attempt_id === input.work_attempt_id
      && currentBinding.execution_generation_id === input.execution_generation_id
      && currentBinding.agent_session_id === input.agent_session_id
      && (!input.credential_ref?.trim() || currentBinding.credential_ref === input.credential_ref.trim())
      && currentCredential === input.agent_session_token
      && currentBinding.api_url === normalizedApiUrl);
    await assertAuthorityCurrent();
    const binding = exactCurrentBinding && currentBinding
      ? currentBinding
      : await this.options.bindings.bind(input, await this.pollingContract(entry) ? {
          // A remint changes the bearer, not what this worker acknowledged.
          roomCursor: currentBinding?.room_id === entry.room_id
            && currentBinding.work_attempt_id === entry.work_attempt_id
            ? currentBinding.room_cursor
            : attempt.checkpoints.at(-1)?.room_cursor ?? null,
        } : undefined);
    this.options.custody.installLiveBinding(input.entry_id, {
      agentSessionId: binding.agent_session_id,
      executionGenerationId: binding.execution_generation_id,
      updatedAt: binding.updated_at,
    });
    if (mayPublish() && (!activation || activation.phase === "active")
      && (!exactCurrentBinding || entry.workplace_liveness?.state !== "reachable")) {
      await this.options.activity.publishNative(input.entry_id, "native_harness.bound", "working");
    }
    await assertAuthorityCurrent();
    const confirmed = await this.options.bindings.get(input.entry_id);
    if (!confirmed || confirmed.entry_id !== binding.entry_id || confirmed.room_id !== binding.room_id
      || confirmed.work_attempt_id !== binding.work_attempt_id
      || confirmed.execution_generation_id !== binding.execution_generation_id
      || confirmed.agent_session_id !== binding.agent_session_id
      || confirmed.credential_ref !== binding.credential_ref || confirmed.api_url !== binding.api_url
      || await this.options.bindings.credentialFor(confirmed) !== input.agent_session_token) {
      throw new Error("Worker binding changed before readiness could be confirmed.");
    }
    const confirmedAttempt = await this.options.durability.getAttempt(input.work_attempt_id);
    if (!confirmedAttempt.execution_generations.some((candidate) =>
      candidate.execution_generation_id === input.execution_generation_id && !candidate.terminal)) {
      throw new Error("Worker binding execution is no longer live.");
    }
    this.bindingRecoveryAttempts.delete(input.entry_id);
    this.options.recovery.resetMintAttempts(input.entry_id);
    this.options.convergence.clear(input.entry_id);
    await this.options.manifest.updateEntry(input.entry_id, (current) => {
      assertEntryCurrent(current);
      const clearsCoordinationLatch = current.desired_state === "running"
        && (!activation || activation.phase === "active")
        && (current.condition === "coordination_blocked" || current.condition === "auth_blocked");
      const manifestBindingIsCurrent = current.last_worker_binding?.agent_session_id === binding.agent_session_id
        && current.last_worker_binding?.work_attempt_id === binding.work_attempt_id
        && current.last_worker_binding?.execution_generation_id === binding.execution_generation_id;
      if (current.workplace_liveness?.state === "reachable"
        && !clearsCoordinationLatch
        && manifestBindingIsCurrent) return current;
      return {
        ...current,
        workplace_liveness: {
          state: "reachable" as const,
          observed_at: new Date().toISOString(),
          detail: exactCurrentBinding
            ? "exact supervised worker session binding confirmed"
            : "supervised worker session bound",
        },
        ...(clearsCoordinationLatch
          ? { observed_state: "working" as const, condition: "none" as const, last_error: null }
          : {}),
        ready_reached_at: resolveReadyReachedAt(current, clearsCoordinationLatch, new Date().toISOString()),
        last_worker_binding: {
          agent_session_id: binding.agent_session_id,
          work_attempt_id: binding.work_attempt_id,
          execution_generation_id: binding.execution_generation_id,
          updated_at: binding.updated_at,
        },
      };
    });
    this.options.custody.deletePendingResumeBinding(input.entry_id);
    if (mayPublish() && !await this.pollingContract(entry)) {
      void this.options.delivery.start(input.entry_id).catch(() => undefined);
    }
    return { bound: true, entry_id: input.entry_id, agent_session_id: input.agent_session_id };
  }

  hostGrantNeedsRenewal(grant: InstalledHostGrant): boolean {
    const expiresAt = Date.parse(grant.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= this.options.nowMs() + HOST_GRANT_RENEWAL_LEAD_MS;
  }

  private async blockHostGrantAuthority(entry: DaemonManifestEntry, grant: InstalledHostGrant, detail: string): Promise<void> {
    this.revokeHostGrantIfCurrent(entry.id, grant);
    this.options.custody.deleteWorkerAuthorization(entry.id);
    await this.options.delivery.stop(entry.id).catch(() => undefined);
    const binding = await this.options.bindings.get(entry.id);
    if (binding) await this.options.bindings.unbind(entry.id, binding.agent_session_id, binding.execution_generation_id);
    this.options.custody.deleteLiveBinding(entry.id);
    await this.options.manifest.updateEntry(entry.id, (current) => ({
      ...current,
      observed_state: current.desired_state === "running" ? "recovering" : current.observed_state,
      condition: "auth_blocked",
      last_error: redactCredentialText(detail).value,
      workplace_liveness: {
        state: "stale",
        observed_at: new Date(this.options.nowMs()).toISOString(),
        detail: "Supervisor host authority is unavailable; room delivery is paused.",
      },
    }));
  }

  async blockExpiredWorkerAuthority(entry: DaemonManifestEntry, detail: string): Promise<void> {
    this.options.custody.deleteWorkerAuthorization(entry.id);
    await this.options.delivery.stop(entry.id).catch(() => undefined);
    const binding = await this.options.bindings.get(entry.id);
    if (binding) await this.options.bindings.unbind(entry.id, binding.agent_session_id, binding.execution_generation_id);
    await this.options.manifest.updateEntry(entry.id, (current) => ({
      ...current,
      observed_state: current.desired_state === "running" ? "recovering" : current.observed_state,
      condition: "auth_blocked",
      last_error: redactCredentialText(detail).value,
      workplace_liveness: {
        state: "stale",
        observed_at: new Date(this.options.nowMs()).toISOString(),
        detail: "The worker bearer expired before rotation succeeded; room delivery is paused.",
      },
    }));
    this.options.convergence.schedule(entry.id, this.options.convergence.heartbeatIntervalMs);
  }

  async ensureHostGrantFresh(entry: DaemonManifestEntry): Promise<InstalledHostGrant | null> {
    const grant = this.currentHostGrant(entry);
    if (!grant) return null;
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.options.nowMs()) {
      await this.blockHostGrantAuthority(entry, grant, "Supervisor host grant expired; waiting for Electron owner recovery.");
      return null;
    }
    if (!this.hostGrantNeedsRenewal(grant)) return grant;
    try {
      if (!this.options.supervisorGrantHttp.renewHostGrant) throw new Error("Supervisor host grant renewal is unavailable.");
      const renewed = await this.options.supervisorGrantHttp.renewHostGrant({
        apiUrl: grant.apiUrl,
        grantId: grant.grantId,
        supervisorGrant: grant.supervisorGrant,
        grantGeneration: grant.grantGeneration,
        hostId: grant.hostId,
        installationId: grant.installationId,
        ttlMs: HOST_GRANT_TTL_MS,
      });
      const renewedExpiry = Date.parse(renewed.expiresAt);
      if (renewed.grantId !== grant.grantId || renewed.grantGeneration !== grant.grantGeneration
        || !renewed.supervisorGrant.trim() || !Number.isFinite(renewedExpiry) || renewedExpiry <= this.options.nowMs()) {
        throw new InvalidSupervisorGrantRenewalError("Supervisor host grant renewal returned a stale fence.");
      }
      if (!await this.ownsDaemonGeneration(grant.daemonGeneration)
        || !this.options.custody.hostGrantIsCurrent(entry.id, grant)) return null;
      const replacement: InstalledHostGrant = {
        ...grant,
        supervisorGrant: renewed.supervisorGrant,
        expiresAt: renewed.expiresAt,
      };
      if (!this.options.custody.replaceHostGrantIfCurrent(entry.id, grant, replacement)) return null;
      const current = await this.options.store.getEntry(entry.id);
      if (current?.provider_ref?.execution_generation_id && this.options.runtime.currentHandle(entry.id)) {
        try {
          const minted = await this.mintHostWorkerSession(current, current.provider_ref.execution_generation_id);
          if (!minted) throw new Error("Renewed host grant could not rotate the live worker bearer.");
          await this.bindMintedHostWorkerSession(entry.id, minted);
        } catch (error) {
          if (error instanceof SupervisorGrantRequestError && [401, 403, 409].includes(error.status)) throw error;
        }
      }
      return replacement;
    } catch (error) {
      const active = this.options.custody.hostGrant(entry.id);
      const definitiveRejection = error instanceof InvalidSupervisorGrantRenewalError
        || (error instanceof SupervisorGrantRequestError && [401, 403, 409].includes(error.status));
      if (definitiveRejection && active && active.grantId === grant.grantId && active.daemonGeneration === grant.daemonGeneration) {
        await this.blockHostGrantAuthority(
          entry,
          active,
          `Supervisor host grant renewal failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return null;
      }
      if (active && Date.parse(active.expiresAt) <= this.options.nowMs()) {
        await this.blockHostGrantAuthority(
          entry,
          active,
          `Supervisor host grant expired while renewal was pending: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return null;
      }
      this.options.convergence.schedule(entry.id, this.options.convergence.heartbeatIntervalMs);
      return this.currentHostGrant(entry);
    }
  }

  async hostWorkerBearerNeedsRotation(entry: DaemonManifestEntry, binding: WorkerSessionBinding): Promise<boolean> {
    const session = await this.options.bindings.supervisedWorkerSession(entry.id);
    if (!session
      || session.room_id !== entry.room_id
      || session.agent_session_id !== binding.agent_session_id
      || session.execution_generation_id !== binding.execution_generation_id) return false;
    if (session.credential_ref !== binding.credential_ref) return true;
    if (!session.expires_at) return false;
    const expiresAt = Date.parse(session.expires_at);
    return Number.isFinite(expiresAt) && expiresAt <= this.options.nowMs() + WORKER_BEARER_ROTATION_LEAD_MS;
  }

  private cachedWorkerAuthorization(entry: DaemonManifestEntry, grant: InstalledHostGrant): CachedWorkerAuthorization | null {
    return this.options.custody.currentWorkerAuthorization({
      entryId: entry.id,
      roomId: entry.room_id,
      workAttemptId: entry.work_attempt_id,
    }, grant, this.options.nowMs());
  }

  private async mintWorkerSessionWithRetry(
    entry: DaemonManifestEntry,
    grant: InstalledHostGrant,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<SupervisorGrantHttp["createWorkerSession"]>>> {
    let lastError: unknown = null;
    let attempts = 0;
    let lastRetryable = false;
    const agentInstanceId = `daemon:${entry.id}`;
    if (signal?.aborted) throw new Error("Worker credential mint was cancelled.");
    await this.options.bindings.beginSupervisedWorkerSessionMint({
      agent_id: entry.id,
      room_id: entry.room_id,
      agent_instance_id: agentInstanceId,
    });
    for (let attempt = 1; attempt <= WORKER_MINT_MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw new Error("Worker credential mint was cancelled.");
      attempts = attempt;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let timeoutReject!: (error: Error) => void;
      const timedOut = new Promise<never>((_resolve, reject) => { timeoutReject = reject; });
      const timeout = this.options.setTimeout(() => {
        controller.abort();
        timeoutReject(new Error(`Worker credential mint timed out after ${WORKER_MINT_TIMEOUT_MS}ms.`));
      }, WORKER_MINT_TIMEOUT_MS);
      timeout.unref();
      try {
        const request = (async () => {
          const minted = await this.options.supervisorGrantHttp.createWorkerSession({
            apiUrl: grant.apiUrl,
            grantId: grant.grantId,
            supervisorGrant: grant.supervisorGrant,
            grantGeneration: grant.grantGeneration,
            roomId: grant.roomId,
            agentKey: grant.agentKey,
            agentInstanceId,
            provider: entry.provider,
            displayName: entry.display_name,
            signal: controller.signal,
          });
          await this.options.bindings.recordExactSupervisedWorkerSessionMint({
            agent_id: entry.id,
            room_id: entry.room_id,
            agent_instance_id: agentInstanceId,
            agent_session_id: minted.sessionId,
          });
          return minted;
        })();
        return await Promise.race([request, timedOut]);
      } catch (error) {
        lastError = error;
        const retryable = retryableWorkerMintFailure(error);
        lastRetryable = retryable && !signal?.aborted;
        if (!retryable || signal?.aborted || attempt === WORKER_MINT_MAX_ATTEMPTS) break;
        await new Promise<void>((resolve) => this.options.setTimeout(resolve, WORKER_MINT_RETRY_DELAY_MS));
      } finally {
        this.options.clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    }
    throw new WorkerCredentialMintError(attempts, lastRetryable, lastError);
  }

  async mintHostWorkerAuthorization(
    entry: DaemonManifestEntry,
    signal?: AbortSignal,
    forceFresh = false,
  ): Promise<MintedWorkerAuthorization | null> {
    await this.assertRuntimeAdmission(entry.id);
    const grant = this.currentHostGrant(entry);
    if (!grant) return null;
    if (!await this.ownsDaemonGeneration(grant.daemonGeneration)
      || !this.options.custody.hostGrantIsCurrent(entry.id, grant)) {
      this.revokeHostGrantIfCurrent(entry.id, grant);
      return null;
    }
    const cached = forceFresh ? null : this.cachedWorkerAuthorization(entry, grant);
    const authority = { entryId: entry.id, roomId: entry.room_id, workAttemptId: entry.work_attempt_id ?? null, grant };
    if (cached) return {
      agentSessionId: cached.agentSessionId,
      bearer: cached.bearer,
      bearerId: cached.bearerId,
      expiresAt: cached.expiresAt,
      apiUrl: cached.apiUrl,
      agentSession: cached.agentSession,
      authority,
    };
    const minted = await this.mintWorkerSessionWithRetry(entry, grant, signal);
    if (!await this.ownsDaemonGeneration(grant.daemonGeneration)
      || !this.options.custody.hostGrantIsCurrent(entry.id, grant)) {
      this.revokeHostGrantIfCurrent(entry.id, grant);
      return null;
    }
    const current = await this.options.store.getEntry(entry.id);
    if (!current || current.work_attempt_id !== entry.work_attempt_id || this.currentHostGrant(current) !== grant) return null;
    this.options.custody.installWorkerAuthorization({
      entryId: entry.id,
      roomId: entry.room_id,
      agentKey: grant.agentKey,
      workAttemptId: entry.work_attempt_id ?? null,
      grantId: grant.grantId,
      grantGeneration: grant.grantGeneration,
      daemonGeneration: grant.daemonGeneration,
      apiUrl: grant.apiUrl,
      agentSessionId: minted.sessionId,
      bearer: minted.bearer,
      bearerId: minted.bearerId,
      expiresAt: minted.expiresAt,
      mintedAtMs: this.options.nowMs(),
      agentSession: minted.agentSession,
    });
    return {
      agentSessionId: minted.sessionId,
      bearer: minted.bearer,
      bearerId: minted.bearerId,
      expiresAt: minted.expiresAt,
      apiUrl: grant.apiUrl,
      agentSession: minted.agentSession,
      authority,
    };
  }

  private hasMintAuthority(entry: DaemonManifestEntry, minted: MintedWorkerAuthorization): boolean {
    const authority = minted.authority;
    return authority.entryId === entry.id && authority.roomId === entry.room_id
      && authority.workAttemptId === (entry.work_attempt_id ?? null)
      && minted.apiUrl === authority.grant.apiUrl
      && this.currentHostGrant(entry) === authority.grant;
  }

  async recordMintedHostWorkerSession(
    entry: DaemonManifestEntry,
    executionGenerationId: string,
    minted: MintedWorkerAuthorization,
  ): Promise<BoundWorkerAuthorization | null> {
    const grant = minted.authority.grant;
    if (!this.hasMintAuthority(entry, minted) || !entry.work_attempt_id
      || !await this.ownsDaemonGeneration(grant.daemonGeneration)) return null;
    const current = await this.options.store.getEntry(entry.id);
    if (!current || !this.hasMintAuthority(current, minted)) return null;
    const attempt = await this.options.durability.getAttempt(entry.work_attempt_id);
    if (!attempt.execution_generations.some((candidate) => candidate.execution_generation_id === executionGenerationId && !candidate.terminal)) return null;
    await this.checkPollingActivationWorker(current, minted.agentSessionId, executionGenerationId);
    await this.options.bindings.recordSupervisedWorkerSession({
      agent_id: entry.id,
      room_id: entry.room_id,
      agent_session_id: minted.agentSessionId,
      execution_generation_id: executionGenerationId,
      credential_ref: minted.bearerId,
      expires_at: minted.expiresAt,
    });
    const confirmed = await this.options.store.getEntry(entry.id);
    if (!await this.ownsDaemonGeneration(grant.daemonGeneration)
      || !confirmed || !this.hasMintAuthority(confirmed, minted)) {
      this.revokeHostGrantIfCurrent(entry.id, grant);
      return null;
    }
    return { ...minted, executionGenerationId };
  }

  async mintHostWorkerSession(
    entry: DaemonManifestEntry,
    executionGenerationId: string,
    forceFresh = false,
  ): Promise<BoundWorkerAuthorization | null> {
    const minted = await this.mintHostWorkerAuthorization(entry, undefined, forceFresh);
    return minted ? this.recordMintedHostWorkerSession(entry, executionGenerationId, minted) : null;
  }

  async bindMintedHostWorkerSession(
    entryId: string,
    session: BoundWorkerAuthorization,
    mayPublish: () => boolean = () => true,
  ): Promise<void> {
    const entry = await this.options.store.getEntry(entryId);
    if (!entry || !entry.work_attempt_id || !entry.provider_ref
      || entry.provider_ref.execution_generation_id !== session.executionGenerationId
      || !this.hasMintAuthority(entry, session)
      || !await this.ownsDaemonGeneration(session.authority.grant.daemonGeneration)
      || !this.options.runtime.currentHandle(entryId)) {
      throw new Error("Minted worker authority no longer matches the exact supervised provider.");
    }
    await this.bindWorkerSessionLocked({
      entry_id: entry.id,
      room_id: entry.room_id,
      work_attempt_id: entry.work_attempt_id,
      execution_generation_id: session.executionGenerationId,
      agent_session_id: session.agentSessionId,
      agent_session_token: session.bearer,
      credential_ref: session.bearerId,
      api_url: session.apiUrl,
    }, mayPublish, session);
  }

  async recordWorkerBindingRecoveryFailure(
    entryId: string,
    executionGenerationId: string,
    error: unknown,
  ): Promise<void> {
    const entry = await this.options.store.getEntry(entryId);
    const handle = this.options.runtime.currentHandle(entryId);
    if (!entry
      || entry.desired_state !== "running"
      || entry.provider_ref?.execution_generation_id !== executionGenerationId
      || !handle
      || handle.workAttemptId !== entry.work_attempt_id
      || handle.providerContinuationId !== entry.provider_ref.provider_continuation_id) return;
    const previous = this.bindingRecoveryAttempts.get(entryId);
    const attempts = previous?.executionGenerationId === executionGenerationId ? previous.attempts + 1 : 1;
    this.bindingRecoveryAttempts.set(entryId, { executionGenerationId, attempts });
    const safeError = schedulerErrorDetail(error);
    const retrying = attempts < WORKER_BIND_MAX_ATTEMPTS;
    const detail = retrying
      ? `Restoring room access (attempt ${attempts} of ${WORKER_BIND_MAX_ATTEMPTS}) failed: ${safeError}. Retrying automatically.`
      : `The provider is running, but room access could not be restored after ${WORKER_BIND_MAX_ATTEMPTS} attempts: ${safeError}. Use Reconnect to try the room handoff again.`;
    await this.options.activity.transition(entryId, "recovering", "coordination_blocked", detail, "daemon-convergence");
    if (retrying) {
      this.options.convergence.clear(entryId);
      this.options.convergence.schedule(
        entryId,
        WORKER_BIND_RETRY_DELAYS_MS[Math.min(attempts - 1, WORKER_BIND_RETRY_DELAYS_MS.length - 1)]!,
      );
    }
  }

  async installOpenModelCredential(input: {
    entry_id: string;
    api_key: string | null;
    base_url: string;
    model: string;
    daemon_generation: number;
  }): Promise<{ status: "installed" | "stale" }> {
    if (!input.entry_id.trim() || !input.base_url.trim() || !input.model.trim()) {
      throw new Error("Open Model credential handoff requires an entry, endpoint, and model.");
    }
    if (input.api_key !== null && !input.api_key.trim()) {
      throw new Error("Open Model API key must be non-empty or null.");
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(input.base_url);
    } catch {
      throw new Error("Open Model credential handoff contains an invalid endpoint.");
    }
    if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.hash) {
      throw new Error("Open Model credential handoff contains an unsafe endpoint.");
    }
    if (!await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale" };
    const entry = await this.options.store.getEntry(input.entry_id);
    if (!entry || entry.provider !== "open-model") return { status: "stale" };
    if (!await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale" };
    this.options.custody.installOpenModelCredential({
      entryId: entry.id,
      apiKey: input.api_key,
      baseUrl: input.base_url.replace(/\/+$/, ""),
      model: input.model.trim(),
      daemonGeneration: input.daemon_generation,
    });
    return { status: "installed" };
  }

  async installHostGrant(input: InstallHostGrantInput): Promise<{
    status: "installed" | "stale" | "provider_unavailable";
    agent_session_id?: string;
  }> {
    return this.options.serializeEntry(input.entry_id, async () => {
      if (input.credential_only && input.recovery_only) {
        throw new Error("Host grant installation cannot be both reconnect-only and recovery-only.");
      }
      for (const field of ["entry_id", "room_id", "agent_key", "grant_id", "supervisor_grant", "api_url", "host_id", "installation_id", "grant_expires_at"] as const) {
        if (!input[field].trim()) throw new Error(`Host grant ${field} is required.`);
      }
      if (!Number.isSafeInteger(input.grant_generation) || input.grant_generation < 1
        || !await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale" };
      const inputExpiry = Date.parse(input.grant_expires_at);
      if (!Number.isFinite(inputExpiry) || inputExpiry <= this.options.nowMs()) return { status: "stale" };
      let apiUrl: string;
      try {
        apiUrl = hostGrantApiOrigin(input.api_url);
      } catch {
        throw new Error("Host grant api_url must be HTTPS or exact loopback HTTP.");
      }
      let entry = await this.options.store.getEntry(input.entry_id);
      if (!entry || !await this.requiresHostGrant(entry) || entry.room_id !== input.room_id) return { status: "stale" };
      if (!await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale" };
      const currentGrant = this.currentHostGrant(entry);
      const currentGrantIsAtLeastInput = Boolean(currentGrant?.grantId === input.grant_id
        && (currentGrant.grantGeneration > input.grant_generation
          || (currentGrant.grantGeneration === input.grant_generation
            && Date.parse(currentGrant.expiresAt) >= inputExpiry)));
      const frozen = deliveryDrainBlocksRuntime(await this.options.store.unresolvedDeliveryDrain(entry.id));
      if (currentGrantIsAtLeastInput && currentGrant && !input.credential_only && !input.recovery_only) {
        if (!frozen && entry.desired_state === "running"
          && (entry.delivery_mode !== "daemon_inbox" || await this.options.inbox.cursor(entry.id))) {
          this.options.convergence.request(entry.id);
        }
        return { status: "installed" };
      }
      const grant: InstalledHostGrant = currentGrantIsAtLeastInput && currentGrant ? currentGrant : {
        entryId: entry.id,
        roomId: entry.room_id,
        agentKey: input.agent_key,
        grantId: input.grant_id,
        supervisorGrant: input.supervisor_grant,
        grantGeneration: input.grant_generation,
        apiUrl,
        daemonGeneration: input.daemon_generation,
        hostId: input.host_id,
        installationId: input.installation_id,
        expiresAt: input.grant_expires_at,
      };
      if (currentGrant && (currentGrant.grantId !== grant.grantId
        || currentGrant.grantGeneration !== grant.grantGeneration)) {
        this.options.custody.deleteWorkerAuthorization(entry.id);
      }
      if (input.recovery_only || frozen) {
        if (!this.options.custody.hostGrantIsCurrent(entry.id, grant)) this.options.custody.installHostGrant(grant);
        return { status: "installed" };
      }
      let live: ProviderActionHandle | null | undefined = this.options.runtime.currentHandle(entry.id);
      let hasExactLiveProvider = Boolean(entry.provider_ref && entry.work_attempt_id && live
        && live.workAttemptId === entry.work_attempt_id
        && live.providerContinuationId === entry.provider_ref.provider_continuation_id);
      if (input.credential_only && !hasExactLiveProvider && entry.provider_ref) {
        live = await this.options.runtime.attach(entry, () => false);
        entry = await this.options.store.getEntry(input.entry_id);
        if (!entry) return { status: "stale" };
        hasExactLiveProvider = Boolean(entry.provider_ref && entry.work_attempt_id && live
          && live.workAttemptId === entry.work_attempt_id
          && live.providerContinuationId === entry.provider_ref.provider_continuation_id);
      }
      if (input.credential_only && !hasExactLiveProvider) return { status: "provider_unavailable" };
      if (!this.options.custody.hostGrantIsCurrent(entry.id, grant)) this.options.custody.installHostGrant(grant);
      if (hasExactLiveProvider && entry.provider_ref && entry.work_attempt_id && live) {
        const attempt = await this.options.durability.getAttempt(entry.work_attempt_id);
        if (!await this.ownsDaemonGeneration(input.daemon_generation)
          || !this.options.custody.hostGrantIsCurrent(entry.id, grant)) {
          this.revokeHostGrantIfCurrent(entry.id, grant);
          return { status: "stale" };
        }
        const execution = attempt.execution_generations.find(
          (candidate) => candidate.execution_generation_id === entry!.provider_ref!.execution_generation_id,
        );
        if (execution && !execution.terminal) {
          const minted = await this.mintHostWorkerSession(entry, execution.execution_generation_id, input.credential_only === true);
          if (minted) {
            await this.bindMintedHostWorkerSession(entry.id, minted);
            if (!await this.ownsDaemonGeneration(input.daemon_generation)
              || !this.options.custody.hostGrantIsCurrent(entry.id, grant)) {
              this.revokeHostGrantIfCurrent(entry.id, grant);
              return { status: "stale" };
            }
            if (input.credential_only && entry.delivery_mode === "daemon_inbox") await this.options.delivery.start(entry.id);
            return { status: "installed", agent_session_id: minted.agentSessionId };
          }
        }
      }
      if (input.credential_only) {
        if (grant !== currentGrant) this.revokeHostGrantIfCurrent(entry.id, grant);
        return { status: "provider_unavailable" };
      }
      if (!await this.ownsDaemonGeneration(input.daemon_generation)
        || !this.options.custody.hostGrantIsCurrent(entry.id, grant)) {
        this.revokeHostGrantIfCurrent(entry.id, grant);
        return { status: "stale" };
      }
      if (entry.desired_state === "running"
        && (entry.delivery_mode !== "daemon_inbox" || await this.options.inbox.cursor(entry.id))) {
        this.options.convergence.request(entry.id);
      }
      return { status: "installed" };
    });
  }

  async bootstrapRoomIngress(
    input: { entry_id: string; daemon_generation: number; initial_message?: string },
    operation: BootstrapOperation,
  ): Promise<{ status: "bootstrapped" | "existing" | "stale"; last_observed_message_id: string | null }> {
    return this.options.serializeEntry(input.entry_id, async () => {
      await this.assertRuntimeAdmission(input.entry_id);
      if (!await this.ownsDaemonGeneration(input.daemon_generation)) return { status: "stale", last_observed_message_id: null };
      const entry = await this.options.store.getEntry(input.entry_id);
      if (!entry || entry.delivery_mode !== "daemon_inbox") return { status: "stale", last_observed_message_id: null };
      const initialMessage = input.initial_message?.trim() || null;
      if (input.initial_message !== undefined && !initialMessage) throw new Error("A non-empty initial agent message is required.");
      if (initialMessage) {
        const sourceMessageId = `desktop-initial-message:${entry.id}`;
        await this.options.inbox.enqueueInitialMessage({
          agent_id: entry.id,
          room_id: entry.room_id,
          source_message_id: sourceMessageId,
          source_message: {
            id: sourceMessageId,
            room_id: entry.room_id,
            sender: "Desktop user",
            text: initialMessage,
            timestamp: entry.created_at,
            source: "desktop_initial_message",
            thread_root_id: sourceMessageId,
          },
          activation: {
            for_current_agent: { decision: "activate", reason: "initial_message", addressed: true },
          },
        });
      }
      const existing = await this.options.inbox.cursor(entry.id);
      if (existing) {
        await this.requestAdmittedRunningConvergence(entry.id, input.daemon_generation);
        return { status: "existing", last_observed_message_id: existing.last_observed_message_id };
      }
      const grant = this.currentHostGrant(entry);
      const latest = this.options.deliveryHttp.latest;
      if (!grant || !latest) throw new Error("A supervised room tail reader is required before activation.");
      const timeout = setTimeout(() => {
        if (operation.phase === "observing") operation.controller.abort();
      }, BOOTSTRAP_ROOM_INGRESS_TIMEOUT_MS);
      timeout.unref();
      let tail: { messages?: Array<Record<string, unknown>> };
      try {
        const authorization = await this.mintHostWorkerAuthorization(entry, operation.controller.signal);
        if (!authorization) throw new Error("Room ingress bootstrap lost host grant authority before minting a worker credential.");
        if (operation.controller.signal.aborted) throw new Error("Room ingress bootstrap was cancelled before a room tail was observed.");
        tail = await latest({
          roomId: entry.room_id,
          apiUrl: grant.apiUrl,
          bearer: authorization.bearer,
          signal: operation.controller.signal,
        });
        if (operation.controller.signal.aborted) throw new Error("Room ingress bootstrap was cancelled before a room tail was observed.");
      } finally {
        clearTimeout(timeout);
      }
      const tailId = lastRoomMessageId(tail.messages ?? []);
      operation.phase = "committing";
      const result = await this.options.inbox.bootstrapCursor({
        agent_id: entry.id,
        room_id: entry.room_id,
        last_observed_message_id: tailId,
      });
      await this.requestAdmittedRunningConvergence(entry.id, input.daemon_generation);
      if (!result.created) return { status: "existing", last_observed_message_id: result.last_observed_message_id };
      return { status: "bootstrapped", last_observed_message_id: tailId };
    });
  }

  private async requestAdmittedRunningConvergence(entryId: string, daemonGeneration: number): Promise<void> {
    if (!await this.ownsDaemonGeneration(daemonGeneration)) return;
    const entry = await this.options.store.getEntry(entryId);
    if (!entry || entry.delivery_mode !== "daemon_inbox" || entry.desired_state !== "running") return;
    if (!await this.options.inbox.cursor(entryId)) return;
    this.options.convergence.request(entryId);
  }

  async verifyWorkerSession(input: VerifyWorkerSessionInput): Promise<{ verified: true; entry_id: string; agent_session_id: string }> {
    return this.options.serializeEntry(input.entry_id, () => this.verifyWorkerSessionLocked(input));
  }

  private async verifyWorkerSessionLocked(input: VerifyWorkerSessionInput): Promise<{ verified: true; entry_id: string; agent_session_id: string }> {
    const entry = (await this.options.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
    if (entry.room_id !== input.room_id) throw new Error("Worker session room does not match the supervised manifest entry.");
    if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker session work attempt does not match the supervised manifest entry.");
    if (entry.provider_ref?.execution_generation_id !== input.execution_generation_id) {
      throw new Error("Worker session execution generation does not match the active supervised manifest entry.");
    }
    const attempt = await this.options.durability.getAttempt(input.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
    if (!execution || execution.terminal) throw new Error("Worker session execution generation is absent or terminal.");
    const binding = await this.options.bindings.get(input.entry_id);
    const credential = binding ? await this.options.bindings.credentialFor(binding) : null;
    const normalizedApiUrl = new URL(input.api_url).origin;
    if (!binding
      || binding.entry_id !== input.entry_id
      || binding.room_id !== input.room_id
      || binding.work_attempt_id !== input.work_attempt_id
      || binding.execution_generation_id !== input.execution_generation_id
      || binding.agent_session_id !== input.agent_session_id
      || credential !== input.agent_session_token
      || binding.api_url !== normalizedApiUrl) {
      throw new Error("Worker session verification does not match the active supervised binding.");
    }
    return { verified: true, entry_id: input.entry_id, agent_session_id: input.agent_session_id };
  }

  async installWorkerCredential(input: {
    entry_id: string;
    room_id: string;
    work_attempt_id: string;
    execution_generation_id: string;
    agent_session_id: string;
    agent_session_token: string;
    daemon_generation: number;
  }): Promise<{ status: "installed" | "stale" }> {
    return this.options.serializeEntry(input.entry_id, async () => {
      if (!await this.isExactCredentialRoute(input)) return { status: "stale" };
      const entry = await this.options.store.getEntry(input.entry_id);
      if (entry && await this.pollingContract(entry)) return { status: "stale" };
      const installed = await this.options.bindings.installCredential(input);
      if (installed) void this.options.delivery.start(input.entry_id).catch(() => undefined);
      return { status: installed ? "installed" : "stale" };
    });
  }

  async borrowWorkerCredential(input: {
    entry_id: string;
    room_id: string;
    work_attempt_id: string;
    execution_generation_id: string;
    agent_session_id: string;
    daemon_generation: number;
    api_url: string;
    provider_turn_id: string;
  }): Promise<{ status: "available"; credential: string } | { status: "deferred" | "stale" }> {
    return this.options.serializeEntry(input.entry_id, async () => {
      if (!await this.isExactCredentialRoute(input)) return { status: "stale" };
      const entry = await this.options.store.getEntry(input.entry_id);
      const custodialPolling = entry && await this.pollingContract(entry);
      const grant = entry ? this.unexpiredHostGrant(entry) : null;
      if (custodialPolling) {
        if (entry.desired_state !== "running" || !grant
          || !await this.ownsDaemonGeneration(input.daemon_generation)
          || await this.options.store.unresolvedDeliveryDrain(entry.id)) return { status: "stale" };
        try { await this.checkPollingActivationWorker(entry, input.agent_session_id, input.execution_generation_id); }
        catch { return { status: "stale" }; }
      }
      if (entry?.provider === "cursor") {
        try {
          await this.options.boundedContext({
            entryId: input.entry_id,
            workAttemptId: input.work_attempt_id,
            executionGenerationId: input.execution_generation_id,
            daemonGeneration: input.daemon_generation,
            providerTurnId: input.provider_turn_id,
          });
        } catch {
          return { status: "stale" };
        }
      }
      const credential = await this.options.bindings.credentialFor(input);
      if (custodialPolling && (!await this.hasUnexpiredWorkerSession(input.entry_id)
        || !await this.isExactCredentialRoute(input)
        || !await this.ownsDaemonGeneration(input.daemon_generation)
        || this.unexpiredHostGrant(entry) !== grant)) return { status: "stale" };
      return credential ? { status: "available", credential } : { status: "deferred" };
    });
  }

  /** Negotiated read admission, never provider wait-output evidence or a new credential. */
  async authorizeCustodialPolling(input: CustodialPollingAuthorizationInput) {
    return this.options.serializeEntry(input.entry_id, async () => {
      if (input.contract !== "custodial_polling_v1"
        || !["before", "release"].includes(input.phase) || !input.tool_name.trim()
        || !await this.ownsDaemonGeneration(input.daemon_generation)
        || !await this.isExactCredentialRoute(input)) {
        throw new Error("Custodial polling authority is stale or unsupported.");
      }
      const entry = await this.options.store.getEntry(input.entry_id);
      const configuration = await this.options.store.getAgentConfiguration(input.entry_id);
      const handle = this.options.runtime.currentHandle(input.entry_id);
      const binding = await this.options.bindings.get(input.entry_id);
      const grant = entry ? this.unexpiredHostGrant(entry) : null;
      const activation = entry ? await this.checkPollingActivationWorker(entry, input.agent_session_id, input.execution_generation_id, true) : null;
      if (!entry || entry.provider !== "codex" || (entry.delivery_mode ?? "mcp_polling") !== "mcp_polling"
        || entry.desired_state !== "running" || configuration?.polling_contract !== input.contract
        || !Number.isSafeInteger(configuration.config_revision)
        || configuration.runtime_configuration_revision !== configuration.config_revision
        || (handle?.appliedConfigurationRevision !== undefined
          && handle.appliedConfigurationRevision !== configuration.config_revision)
        || (input.phase === "release" && input.expected_configuration_revision !== configuration.config_revision)
        || !grant || !binding?.room_cursor
        || !await this.options.bindings.credentialFor(binding)
        || !handle || handle.workAttemptId !== input.work_attempt_id
        || handle.providerContinuationId !== entry.provider_ref?.provider_continuation_id
        || !sameProviderActionConnectionSnapshot(handle.providerConnection, entry.provider_ref?.provider_connection)
        || ["failed", "stopped", "stopping"].includes(handle.observedState)
        || await this.options.store.unresolvedDeliveryDrain(entry.id)
        || !await this.ownsDaemonGeneration(input.daemon_generation)) {
        throw new Error("Custodial polling is not authorized by the current worker binding.");
      }
      // Provider exit/handoff can arrive while the durable checks await I/O.
      // Never authorize a successor just because it shares the saved entry.
      if (!await this.hasUnexpiredWorkerSession(input.entry_id)
        || !await this.isExactCredentialRoute(input)
        || this.options.runtime.currentHandle(entry.id) !== handle
        || this.unexpiredHostGrant(entry) !== grant
        || ["failed", "stopped", "stopping"].includes(handle.observedState)) {
        throw new Error("Custodial polling authority changed during admission.");
      }
      if ((await this.checkPollingActivationWorker(entry, input.agent_session_id, input.execution_generation_id, true))?.operation_id !== activation?.operation_id) {
        throw new Error("Custodial polling activation changed during admission.");
      }
      return {
        status: "authorized" as const, contract: "custodial_polling_v1" as const,
        room_id: entry.room_id, agent_session_id: binding.agent_session_id,
        room_cursor: binding.room_cursor, configuration_revision: configuration.config_revision!,
      };
    });
  }

  private async isExactCredentialRoute(input: {
    entry_id: string;
    room_id: string;
    work_attempt_id: string;
    execution_generation_id: string;
    agent_session_id: string;
    daemon_generation: number;
    api_url?: string;
  }): Promise<boolean> {
    if (deliveryDrainBlocksRuntime(await this.options.store.unresolvedDeliveryDrain(input.entry_id))) return false;
    if (!Number.isSafeInteger(input.daemon_generation)
      || input.daemon_generation !== this.options.authority.currentGeneration()) return false;
    const entry = await this.options.store.getEntry(input.entry_id);
    if (!entry || entry.room_id !== input.room_id || entry.work_attempt_id !== input.work_attempt_id
      || entry.provider_ref?.execution_generation_id !== input.execution_generation_id) return false;
    const attempt = await this.options.durability.getAttempt(input.work_attempt_id);
    const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
    if (!execution || execution.terminal) return false;
    const binding = await this.options.bindings.get(input.entry_id);
    let normalizedApiUrl: string | null = null;
    if (input.api_url !== undefined) {
      try {
        normalizedApiUrl = new URL(input.api_url).origin;
      } catch {
        return false;
      }
    }
    return Boolean(binding
      && binding.room_id === input.room_id
      && binding.work_attempt_id === input.work_attempt_id
      && binding.execution_generation_id === input.execution_generation_id
      && binding.agent_session_id === input.agent_session_id
      && (normalizedApiUrl === null || binding.api_url === normalizedApiUrl));
  }

  async checkpointWorkerCursor(input: {
    entry_id: string;
    work_attempt_id: string;
    execution_generation_id: string;
    agent_session_id: string;
    room_cursor: string;
  }): Promise<{ checkpointed: true; entry_id: string; room_cursor: string }> {
    return this.options.serializeEntry(input.entry_id, () => this.options.serializeCursorCheckpoint(input.entry_id, async () => {
      await this.assertRuntimeAdmission(input.entry_id);
      const entry = (await this.options.store.load()).entries.find((candidate) => candidate.id === input.entry_id);
      if (!entry) throw new Error(`Unknown daemon manifest entry: ${input.entry_id}`);
      if (await this.pollingContract(entry) && await this.options.store.unresolvedDeliveryDrain(entry.id)) {
        throw new Error("Custodial polling cursor is frozen by delivery drain.");
      }
      if (entry.work_attempt_id !== input.work_attempt_id) throw new Error("Worker cursor work attempt does not match the supervised manifest entry.");
      if (entry.provider_ref?.execution_generation_id !== input.execution_generation_id) {
        throw new Error("Worker cursor execution generation does not match the active supervised manifest entry.");
      }
      const attempt = await this.options.durability.getAttempt(input.work_attempt_id);
      const execution = attempt.execution_generations.find((candidate) => candidate.execution_generation_id === input.execution_generation_id);
      if (!execution || execution.terminal) throw new Error("Worker cursor execution generation is absent or terminal.");
      const currentBinding = await this.options.bindings.get(input.entry_id);
      if (!currentBinding
        || currentBinding.entry_id !== input.entry_id
        || currentBinding.room_id !== entry.room_id
        || currentBinding.work_attempt_id !== input.work_attempt_id
        || currentBinding.agent_session_id !== input.agent_session_id
        || currentBinding.execution_generation_id !== input.execution_generation_id) {
        throw new Error("Worker cursor checkpoint does not match the active supervised binding.");
      }
      if (await this.pollingContract(entry)) {
        if (!this.unexpiredHostGrant(entry) || !await this.hasUnexpiredWorkerSession(entry.id)
          || !await this.ownsDaemonGeneration(this.options.authority.currentGeneration())) throw new Error("Custodial polling cursor authority is unavailable.");
        await this.checkPollingActivationWorker(entry, input.agent_session_id, input.execution_generation_id, true);
      }
      const checkpoint = await this.options.bindings.checkpointCursorMonotonic(
        input.entry_id,
        input.agent_session_id,
        input.execution_generation_id,
        input.room_cursor,
      );
      if (!checkpoint.advanced) {
        const durableCursor = checkpoint.binding.room_cursor;
        if (durableCursor && attempt.checkpoints.at(-1)?.room_cursor !== durableCursor) {
          await this.options.durability.checkpoint(input.work_attempt_id, {
            room_cursor: durableCursor,
            provider_continuation_id: entry.provider_ref?.provider_continuation_id ?? null,
          });
        }
        return {
          checkpointed: true,
          entry_id: input.entry_id,
          room_cursor: checkpoint.binding.room_cursor ?? input.room_cursor,
        };
      }
      await this.options.durability.checkpoint(input.work_attempt_id, {
        room_cursor: input.room_cursor,
        provider_continuation_id: entry.provider_ref?.provider_continuation_id ?? null,
      });
      return { checkpointed: true, entry_id: input.entry_id, room_cursor: input.room_cursor };
    }));
  }
}
