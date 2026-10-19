import {
  NATIVE_LIVENESS_STALE_AFTER_MS,
  workplaceLivenessStaleAfterMs,
} from "./cloud-http.js";
import type { WorkDurabilityStore } from "./durability-store.js";
import { executionRuntimeStorageIdentity } from "./execution-shadow-store.js";
import type { ProviderActionHandle } from "./provider-action-port.js";
import { homeHarnessAvailability, homeHarnessRosterState, latestPermissionChange, permissionChangedSince } from "./provider-configuration.js";
import type { ProviderRecoveryDiagnostics } from "./provider-stream-coordinator.js";
import type { LifecycleCaptureAdmissionStatus } from "./lifecycle-projection-ledger.js";
import {
  bindingMatchesRoomAgentGeneration,
  hasExactRoomAgentDeliveryOwner,
  projectRoomAgentManifestEntry,
} from "./room-agent-state-projection.js";
import type { SupervisedAgentDelivery } from "./supervised-agent-delivery.js";
import type { SupervisedAgentInboxStore } from "./supervised-agent-inbox-store.js";
import {
  DAEMON_IMPLEMENTATION_VERSION,
  DAEMON_PROTOCOL_VERSION,
  type DaemonManifestEntry,
  type DaemonManifestEntryView,
} from "./types.js";
import type { WorkerAuthorityCoordinator } from "./worker-authority-coordinator.js";
import type {
  WorkerBindingStore,
  WorkerSessionBinding,
} from "./worker-binding-store.js";

/** As long as the retries take before the agent's activity says it is still waiting (1 + 2 + 4 + 8 + 16 s). */
const OWNER_SETUP_END_ATTENTION_AFTER_MS = 30_000;

export type DaemonReadModelPorts = {
  readUsage?(handle: ProviderActionHandle): Promise<import("../shared/provider-usage.js").ProviderUsage | null>;
  compactionProgress?(entry: DaemonManifestEntry): DaemonManifestEntryView["provider_progress"];
  currentDaemonGeneration(): number;
  nowMs(): number;
  startedAt: string;
  capabilities: {
    hasDelivery(): boolean;
    supportsRoomTurns(): boolean;
    supportsContinuationRepair(): boolean;
  };
  recoveryDiagnostics(): ProviderRecoveryDiagnostics;
  deliveryAdmission(entry: DaemonManifestEntry): LifecycleCaptureAdmissionStatus | null;
  /**
   * For an entry whose delivery is held because its execution record cannot
   * be continued: null while the daemon is still going to restart the agent
   * by itself, or why it now waits for its owner. Undefined otherwise.
   */
  recordRecovery?(entry: DaemonManifestEntry): string | null | undefined;
  manifest: {
    pendingRuntimeRecovery(agentId: string): Promise<import("./runtime-recovery-journal.js").RuntimeRecoveryRecord | null>;
    load(): Promise<{ entries: DaemonManifestEntry[] }>;
    getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
    getAgentConfiguration(entryId: string): Promise<{ runtime_configuration_revision: number } | undefined>;
  };
  bindings: Pick<WorkerBindingStore, "credentialFor" | "get" | "list">;
  inbox: Pick<
    SupervisedAgentInboxStore,
    "detail" | "ingressHealth" | "latestContinuationRepair" | "receiptProjection"
  > & Partial<Pick<SupervisedAgentInboxStore, "blockedHeadSkip" | "committedStateVersion">>;
  durability: Pick<WorkDurabilityStore, "getAttempt">;
  workerAuthority: Pick<WorkerAuthorityCoordinator, "currentHostGrant" | "pollingContract">;
  liveHandles: Map<string, ProviderActionHandle>;
  delivery: Pick<SupervisedAgentDelivery, "activeTurn"> | null;
};

/**
 * The inputs of one entry's view that are read from the inbox tables, on the
 * inbox store's connection, and from nothing else: no clock, no memory.
 */
type StoredInboxInputs = {
  receipts: Awaited<ReturnType<SupervisedAgentInboxStore["receiptProjection"]>>;
  blockedHeadSkip: Awaited<ReturnType<SupervisedAgentInboxStore["blockedHeadSkip"]>>;
  continuationRepair: Awaited<ReturnType<SupervisedAgentInboxStore["latestContinuationRepair"]>>;
  ingressHealth: Awaited<ReturnType<SupervisedAgentInboxStore["ingressHealth"]>>;
};

/** Owns read-only control-surface projections over daemon authority state. */
export class DaemonReadModel {
  /**
   * The inbox inputs of the last projection that asked to keep them, and the
   * database version read before any of them. They are used again only while
   * that version is unchanged, that is while no row of the database has been
   * written since. They hold one item per entry of that projection, and
   * nothing reads or changes them in place.
   */
  private keptInboxInputs: { version: string; inputs: Map<string, StoredInboxInputs> } | null = null;

  constructor(private readonly ports: DaemonReadModelPorts) {}

  status() {
    return {
      healthy: true,
      protocol_version: DAEMON_PROTOCOL_VERSION,
      implementation_version: DAEMON_IMPLEMENTATION_VERSION,
      runtime_environment_fingerprint:
        process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT ?? null,
      compatibility_fingerprint:
        process.env.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT ?? null,
      capabilities: {
        room_delivery_retry: this.ports.capabilities.hasDelivery()
          && this.ports.capabilities.supportsRoomTurns(),
        provider_continuation_repair: this.ports.capabilities.hasDelivery()
          && this.ports.capabilities.supportsContinuationRepair(),
        room_delivery_skip: this.ports.capabilities.hasDelivery(),
        agent_inspector_detail_v1: true,
        agent_inspector_settings_v1: true,
        agent_room_move_v1: true,
        agent_lifecycle_v1: true,
        agent_runtime_recovery_v1: true,
        agent_runtime_recovery_v2: true,
        agent_state_subscription_v1: true,
        agent_activity_stream_v1: true,
        custodialPollingV1: true,
        custodialPollingOffersV1: true,
      },
      generation: this.ports.currentDaemonGeneration(),
      pid: process.pid,
      started_at: this.ports.startedAt,
      recovery_diagnostics: this.ports.recoveryDiagnostics(),
    };
  }

  async inspectorDetail(
    entryId: string,
    roomId: string,
    sourceMessageId: string | null,
  ) {
    if (!entryId.trim()
      || !roomId.trim()
      || (sourceMessageId !== null && !sourceMessageId.trim())) {
      throw new Error("Agent inspector detail requires an exact entry and room identity.");
    }
    const entry = await this.ports.manifest.getEntry(entryId);
    if (!entry) {
      throw new Error("The exact supervisor entry is no longer present; inspector history is not queryable without its manifest fence.");
    }
    if (entry.room_id !== roomId) {
      throw new Error("The agent inspector room does not match the exact supervisor entry.");
    }
    let runtimeFence: Parameters<SupervisedAgentInboxStore["detail"]>[3] = null;
    const runtimeGenerationId = this.runtimeGenerationId(entry);
    if (runtimeGenerationId && entry.provider_ref) {
      runtimeFence = { executionGenerationId: entry.provider_ref.execution_generation_id,
        runtimeGenerationId, daemonGenerationId: String(this.ports.currentDaemonGeneration()) };
    }
    const handle = this.ports.liveHandles.get(entryId);
    const generation = this.ports.currentDaemonGeneration();
    const continuation = entry.provider_ref?.provider_continuation_id;
    const execution = entry.provider_ref?.execution_generation_id;
    const [detail, usage] = await Promise.all([
      this.ports.inbox.detail(entryId, roomId, sourceMessageId, runtimeFence),
      handle && handle.workAttemptId === entry.work_attempt_id && handle.providerContinuationId === continuation
        ? this.ports.readUsage?.(handle).catch(() => null) ?? null : null,
    ]);
    const current = await this.ports.manifest.getEntry(entryId);
    const valid = current?.room_id === roomId && current.provider_ref?.execution_generation_id === execution
      && current.provider_ref?.provider_continuation_id === continuation && this.ports.liveHandles.get(entryId) === handle
      && this.ports.currentDaemonGeneration() === generation && usage?.providerContinuationId === continuation;
    return { ...detail, usage: valid && usage && execution
      ? { ...usage, executionGenerationId: execution, daemonGeneration: generation } : null };
  }

  private runtimeGenerationId(entry: DaemonManifestEntry): string | null {
    const ref = entry.provider_ref;
    const connection = ref?.provider_connection;
    if (!ref || !connection?.pid || !connection.processIdentity?.trim()) return null;
    try { return executionRuntimeStorageIdentity(entry.id, ref.execution_generation_id,
      connection.kind, connection.pid, connection.processIdentity); }
    catch { return null; }
  }

  /**
   * With `reuseUnchangedInboxInputs`, an entry's inbox inputs (its delivery
   * receipts, blocked-head skip, latest continuation repair and ingress health)
   * are read again only when the database has changed since the last such
   * projection. Every view is still derived again: liveness depends on the
   * clock, and the authority facts (binding, credential, host grant, live
   * handle, lifecycle admission) and every other stored input are read each time.
   */
  async entriesWithDerivedLiveness(
    entries: DaemonManifestEntry[],
    options: { reuseUnchangedInboxInputs?: boolean } = {},
  ): Promise<DaemonManifestEntryView[]> {
    // Read before every input: an input kept under it was read after it.
    const version = options.reuseUnchangedInboxInputs
      ? await this.ports.inbox.committedStateVersion?.().catch(() => null) ?? null
      : null;
    const kept = version !== null && this.keptInboxInputs?.version === version ? this.keptInboxInputs.inputs : undefined;
    const keep = version !== null ? new Map<string, StoredInboxInputs>() : undefined;
    const bindings = new Map(
      (await this.ports.bindings.list()).map((binding) => [binding.entry_id, binding]),
    );
    const views = await Promise.all(entries.map((entry) =>
      this.entryWithDerivedLiveness(entry, bindings.get(entry.id) ?? null, keep && { kept: kept?.get(entry.id), keep })));
    if (version !== null && keep) this.keptInboxInputs = { version, inputs: keep };
    return views;
  }

  private async inboxInputs(entryId: string): Promise<StoredInboxInputs> {
    const receipts = await this.ports.inbox.receiptProjection(entryId);
    const blockedHeadSkip = receipts.some((receipt) => receipt.receipt_state === "blocked")
      ? await this.ports.inbox.blockedHeadSkip?.(entryId) ?? null
      : null;
    const continuationRepair = await this.ports.inbox.latestContinuationRepair(entryId);
    const ingressHealth = await this.ports.inbox.ingressHealth(entryId);
    return { receipts, blockedHeadSkip, continuationRepair, ingressHealth };
  }

  async entryWithDerivedLiveness(
    entry: DaemonManifestEntry,
    projectedBinding?: WorkerSessionBinding | null,
    inboxInputs?: { kept: StoredInboxInputs | undefined; keep: Map<string, StoredInboxInputs> },
  ): Promise<DaemonManifestEntryView> {
    const projectionNowMs = this.ports.nowMs();
    const binding = projectedBinding === undefined
      ? await this.ports.bindings.get(entry.id)
      : projectedBinding;
    const stored = inboxInputs?.kept ?? await this.inboxInputs(entry.id);
    inboxInputs?.keep.set(entry.id, stored);
    const { receipts, blockedHeadSkip, continuationRepair, ingressHealth: persistedIngress } = stored;
    const credential = bindingMatchesRoomAgentGeneration(entry, binding)
      ? await this.ports.bindings.credentialFor(binding)
      : null;
    const currentHostGrantAvailable = Boolean(this.ports.workerAuthority.currentHostGrant(entry));
    const liveHandle = this.ports.liveHandles.get(entry.id);
    const authorityFacts = {
      entry,
      binding,
      credentialAvailable: Boolean(credential),
      liveHandle: liveHandle ?? null,
      lifecycleAdmission: this.ports.deliveryAdmission(entry),
      recordRecovery: this.ports.recordRecovery?.(entry),
    };
    const activeTurn = hasExactRoomAgentDeliveryOwner(authorityFacts)
      && binding
      && credential
      && liveHandle
      ? this.ports.delivery?.activeTurn({
          agentId: entry.id,
          roomId: binding.room_id,
          provider: entry.provider,
          apiUrl: binding.api_url,
          agentSessionId: binding.agent_session_id,
          bearer: credential,
          handle: liveHandle,
          workAttemptId: binding.work_attempt_id,
          providerContinuationId: liveHandle.providerContinuationId,
          providerConnection: entry.provider_ref?.provider_connection ?? null,
          executionGenerationId: binding.execution_generation_id,
          daemonGeneration: this.ports.currentDaemonGeneration(),
          deliveryMode: entry.delivery_mode ?? "mcp_polling",
        }) ?? null
      : null;
    const projected = projectRoomAgentManifestEntry({
      ...authorityFacts,
      currentHostGrantAvailable,
      ingressHealth: persistedIngress,
      continuationRepair,
      receipts,
      blockedHeadSkip,
      activeTurn,
      nowMs: projectionNowMs,
      workplaceLivenessStaleAfterMs: workplaceLivenessStaleAfterMs(),
      nativeLivenessStaleAfterMs: NATIVE_LIVENESS_STALE_AFTER_MS,
    });
    const pollingContract = await this.ports.workerAuthority.pollingContract(entry);
    const recovery = await this.ports.manifest.pendingRuntimeRecovery(entry.id);
    // The entry carries no revision: the one the agent last started at is the store's. Nothing is read for an agent that may not have the setup
    // and whose access level was never changed.
    const lastStartedAt = homeHarnessAvailability({ id: entry.id, provider: entry.provider, deliveryMode: entry.delivery_mode }) === "available"
      || latestPermissionChange(entry.provider_launch_policy) !== undefined
      ? (await this.ports.manifest.getAgentConfiguration(entry.id))?.runtime_configuration_revision : undefined;
    let homeHarness = homeHarnessRosterState(entry, lastStartedAt, liveHandle ? { startedAtRevision: liveHandle.appliedConfigurationRevision } : null);
    // A paused agent keeps the reference to its process for its conversation.
    // Its process is gone once the daemon has recorded its end, and not before.
    if (homeHarness && !liveHandle && entry.observed_state === "paused" && await this.processEnded(entry)) {
      homeHarness = homeHarnessRosterState({ ...entry, provider_ref: undefined }, lastStartedAt, null);
    }
    const permissionPending = lastStartedAt !== undefined && await this.accessLevelPending(entry, liveHandle, lastStartedAt);
    // The owner turned their setup off, the process that still has it is idle
    // and could not be replaced, and a message has been waiting for that. The
    // daemon keeps trying; meanwhile the agent is shown as needing attention,
    // as any stuck agent is. Nothing is stored, so it ends with the wait.
    // A queue that delivery could otherwise take from: the agent is meant to run and has its room access.
    const held = homeHarness === "until_restart" && entry.observed_state === "idle"
      && projected.condition === "none" && projected.room_agent_state?.inbox.state === "queued"
      ? receipts.find((receipt) => receipt.state === "pending") : undefined;
    const waiting = projected.room_agent_state?.inbox.pending_count ?? 0;
    return { ...projected,
      ...(held && projectionNowMs - Date.parse(held.updated_at) >= OWNER_SETUP_END_ATTENTION_AFTER_MS ? {
        condition: "coordination_blocked" as const,
        last_error: `This agent could not be restarted yet to turn your own setup off, so it is not taking messages. LetAgents keeps trying. `
          + `Pause and resume this agent to finish now; ${waiting} message${waiting === 1 ? " is" : "s are"} waiting.`,
      } : {}),
      provider_progress: entry.desired_state === "running" && entry.condition === "none"
        && !["stopped", "failed", "stopping"].includes(entry.observed_state)
        ? this.ports.compactionProgress?.(entry) ?? null : null,
      runtime_generation_id: this.runtimeGenerationId(entry),
      runtime_recovery: recovery ? { operationId: recovery.operation_id, roomId: recovery.room_id,
        executionGenerationId: recovery.execution_generation_id, runtimeGenerationId: recovery.runtime_generation_id,
        mode: recovery.mode, phase: recovery.phase as "prepared" | "stopped" } : null,
      ...(pollingContract ? { polling_contract: pollingContract } : {}),
      ...(homeHarness ? { home_harness: homeHarness } : {}),
      ...(permissionPending ? { permission_pending: true as const } : {}) };
  }

  /**
   * Whether a process of this agent runs with an older access level than its
   * owner saved. A paused agent keeps the reference to its process until the
   * daemon records its end, as for the owner's setup above.
   */
  private async accessLevelPending(entry: DaemonManifestEntry, liveHandle: ProviderActionHandle | undefined, lastStartedAt: number): Promise<boolean> {
    if (!permissionChangedSince(entry.provider_launch_policy, liveHandle?.appliedConfigurationRevision ?? lastStartedAt)) return false;
    if (liveHandle) return true;
    return Boolean(entry.provider_ref) && !["absent", "stopped", "failed"].includes(entry.observed_state)
      && !(entry.observed_state === "paused" && await this.processEnded(entry));
  }

  /** Whether the daemon has recorded the end of the process this entry refers to. Not known counts as not ended. */
  private async processEnded(entry: DaemonManifestEntry): Promise<boolean> {
    const ref = entry.provider_ref;
    if (!ref) return true;
    try {
      return Boolean((await this.ports.durability.getAttempt(ref.work_attempt_id)).execution_generations
        .find((generation) => generation.execution_generation_id === ref.execution_generation_id)?.terminal);
    } catch {
      return false;
    }
  }

  async attempt(entryId: string) {
    const entry = await this.ports.manifest.getEntry(entryId);
    if (!entry) throw new Error(`Unknown daemon manifest entry: ${entryId}`);
    const attempt = entry.work_attempt_id
      ? await this.ports.durability.getAttempt(entry.work_attempt_id)
      : null;
    const lastGeneration = attempt?.execution_generations.at(-1) ?? null;
    return {
      entry_id: entry.id,
      work_attempt_id: attempt?.work_attempt_id ?? null,
      workspace_path: attempt?.workspace_path ?? null,
      last_terminal: lastGeneration?.terminal ?? null,
      restart_count: Math.max(0, (attempt?.execution_generations.length ?? 0) - 1),
      execution_generations: attempt?.execution_generations ?? [],
      checkpoints: attempt?.checkpoints ?? [],
      activity: entry.activity ?? [],
    };
  }
}
