import {
  NATIVE_LIVENESS_STALE_AFTER_MS,
  workplaceLivenessStaleAfterMs,
} from "./cloud-http.js";
import type { WorkDurabilityStore } from "./durability-store.js";
import type { ProviderActionHandle } from "./provider-action-port.js";
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

export type DaemonReadModelPorts = {
  currentDaemonGeneration(): number;
  nowMs(): number;
  startedAt: string;
  capabilities: {
    hasDelivery(): boolean;
    supportsRoomTurns(): boolean;
    supportsContinuationRepair(): boolean;
  };
  manifest: {
    load(): Promise<{ entries: DaemonManifestEntry[] }>;
    getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
  };
  bindings: Pick<WorkerBindingStore, "credentialFor" | "get" | "list">;
  inbox: Pick<
    SupervisedAgentInboxStore,
    "detail" | "ingressHealth" | "latestContinuationRepair" | "receipts"
  >;
  durability: Pick<WorkDurabilityStore, "getAttempt">;
  workerAuthority: Pick<WorkerAuthorityCoordinator, "currentHostGrant">;
  liveHandles: Map<string, ProviderActionHandle>;
  delivery: Pick<SupervisedAgentDelivery, "activeTurn"> | null;
};

/** Owns read-only control-surface projections over daemon authority state. */
export class DaemonReadModel {
  constructor(private readonly ports: DaemonReadModelPorts) {}

  status() {
    return {
      healthy: true,
      protocol_version: DAEMON_PROTOCOL_VERSION,
      implementation_version: DAEMON_IMPLEMENTATION_VERSION,
      runtime_environment_fingerprint:
        process.env.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT ?? null,
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
        agent_state_subscription_v1: true,
        agent_activity_stream_v1: true,
      },
      generation: this.ports.currentDaemonGeneration(),
      pid: process.pid,
      started_at: this.ports.startedAt,
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
    return this.ports.inbox.detail(entryId, roomId, sourceMessageId);
  }

  async entriesWithDerivedLiveness(
    entries: DaemonManifestEntry[],
  ): Promise<DaemonManifestEntryView[]> {
    const bindings = new Map(
      (await this.ports.bindings.list()).map((binding) => [binding.entry_id, binding]),
    );
    return Promise.all(entries.map((entry) =>
      this.entryWithDerivedLiveness(entry, bindings.get(entry.id) ?? null)));
  }

  async entryWithDerivedLiveness(
    entry: DaemonManifestEntry,
    projectedBinding?: WorkerSessionBinding | null,
  ): Promise<DaemonManifestEntryView> {
    const projectionNowMs = this.ports.nowMs();
    const binding = projectedBinding === undefined
      ? await this.ports.bindings.get(entry.id)
      : projectedBinding;
    const receipts = await this.ports.inbox.receipts(entry.id);
    const credential = bindingMatchesRoomAgentGeneration(entry, binding)
      ? await this.ports.bindings.credentialFor(binding)
      : null;
    const continuationRepair = await this.ports.inbox.latestContinuationRepair(entry.id);
    const currentHostGrantAvailable = Boolean(this.ports.workerAuthority.currentHostGrant(entry));
    const liveHandle = this.ports.liveHandles.get(entry.id);
    const persistedIngress = await this.ports.inbox.ingressHealth(entry.id);
    const authorityFacts = {
      entry,
      binding,
      credentialAvailable: Boolean(credential),
      liveHandle: liveHandle ?? null,
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
    return projectRoomAgentManifestEntry({
      ...authorityFacts,
      currentHostGrantAvailable,
      ingressHealth: persistedIngress,
      continuationRepair,
      receipts,
      activeTurn,
      nowMs: projectionNowMs,
      workplaceLivenessStaleAfterMs: workplaceLivenessStaleAfterMs(),
      nativeLivenessStaleAfterMs: NATIVE_LIVENESS_STALE_AFTER_MS,
    });
  }

  async attempt(entryId: string) {
    const entry = (await this.ports.manifest.load()).entries.find((candidate) =>
      candidate.id === entryId);
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
