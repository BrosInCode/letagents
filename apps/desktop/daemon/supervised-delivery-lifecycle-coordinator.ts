import type {
  BoundedEffectContext,
} from "./bounded-effect-coordinator.js";
import type { ProviderActionHandle } from "./provider-action-port.js";
import type { ProviderCheckpointCoordinator } from "./provider-checkpoint-coordinator.js";
import type { SupervisedAgentDelivery } from "./supervised-agent-delivery.js";
import type {
  SupervisedAgentInboxStore,
  SupervisedInboxItem,
} from "./supervised-agent-inbox-store.js";
import type { DaemonManifestEntry, DaemonRoomMoveRecord } from "./types.js";
import type { WorkerBindingStore } from "./worker-binding-store.js";

type DeliveryMode = "refresh" | "ensure" | "wake";
type ExactBoundedContextCoordinates = {
  entryId: string;
  workAttemptId: string;
  executionGenerationId: string;
  daemonGeneration: number;
  providerTurnId?: string;
};

export type SupervisedDeliveryLifecyclePorts = {
  isHandoffScheduled(): boolean;
  supportsRoomTurns(): boolean;
  isLifecycleActive(entryId: string): boolean;
  currentDaemonGeneration(): number;
  delivery: Pick<
    SupervisedAgentDelivery,
    "activeTurn" | "ensureStarted" | "refresh" | "wake"
  > | null;
  manifest: {
    getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
    getAgentConfiguration(entryId: string): Promise<{ polling_contract?: "custodial_polling_v1" | null } | undefined>;
    pendingRoomMoves(entryId: string): Promise<DaemonRoomMoveRecord[]>;
  };
  roomMoves: {
    reconcile(move: DaemonRoomMoveRecord): Promise<DaemonRoomMoveRecord>;
  };
  cutovers: {
    start(entryId: string): Promise<void>;
  };
  inbox: Pick<
    SupervisedAgentInboxStore,
    "get" | "preparedRoomMove" | "providerTurnBinding" | "receipts"
  >;
  bindings: Pick<WorkerBindingStore, "get" | "credentialFor">;
  liveHandle(entryId: string): ProviderActionHandle | undefined;
  providerAuthority: Pick<ProviderCheckpointCoordinator, "isExactAuthority">;
  scheduleRecovery(entryId: string, delayMs: number): void;
};

/**
 * Owns construction and recovery of the exact supervised delivery lane.
 * Provider execution, manifest mutation, and room-move persistence remain in
 * their existing domain coordinators; this class only proves that their
 * current identities agree before starting or exposing a bounded turn.
 */
export class SupervisedDeliveryLifecycleCoordinator {
  constructor(private readonly ports: SupervisedDeliveryLifecyclePorts) {}

  async exactActiveBoundedContext(
    input: ExactBoundedContextCoordinates,
  ): Promise<BoundedEffectContext> {
    if (!input.entryId
      || !input.workAttemptId
      || !input.executionGenerationId
      || input.daemonGeneration !== this.ports.currentDaemonGeneration()) {
      throw new Error("The supervised effect coordinates are stale.");
    }
    const delivery = this.ports.delivery;
    if (!delivery) throw new Error("Supervised bounded turns are unavailable.");
    const entry = await this.ports.manifest.getEntry(input.entryId);
    const handle = this.ports.liveHandle(input.entryId);
    const binding = await this.ports.bindings.get(input.entryId);
    const credential = binding ? await this.ports.bindings.credentialFor(binding) : null;
    if (!entry || !handle || !binding || !credential
      || entry.work_attempt_id !== input.workAttemptId
      || entry.provider_ref?.execution_generation_id !== input.executionGenerationId
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId) {
      throw new Error("The supervised effect no longer belongs to the exact live execution generation.");
    }
    const agent = {
      agentId: entry.id,
      roomId: entry.room_id,
      provider: entry.provider,
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
      apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id,
      bearer: credential,
      handle,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: handle.providerContinuationId,
      providerConnection: handle.providerConnection ?? null,
      executionGenerationId: binding.execution_generation_id,
      daemonGeneration: this.ports.currentDaemonGeneration(),
    };
    const active = delivery.activeTurn(agent);
    if (!active) throw new Error("No exact bounded room turn is currently active for this agent.");
    const inbox = await this.ports.inbox.get(active.inboxItemId);
    if (!inbox?.provider_turn_id) {
      throw new Error("The bounded room turn has not checkpointed its provider turn id yet.");
    }
    const providerTurnBinding = await this.ports.inbox.providerTurnBinding(inbox.inbox_item_id);
    if (!providerTurnBinding
      || providerTurnBinding.agent_id !== entry.id
      || providerTurnBinding.room_id !== entry.room_id
      || providerTurnBinding.work_attempt_id !== entry.work_attempt_id
      || providerTurnBinding.provider_continuation_id !== handle.providerContinuationId
      || providerTurnBinding.provider_turn_id !== inbox.provider_turn_id) {
      throw new Error("The bounded provider turn has a different or unverifiable durable authority binding.");
    }
    if ((entry.provider === "cursor" || input.providerTurnId)
      && input.providerTurnId !== inbox.provider_turn_id) {
      throw new Error("The supervised provider turn capability is stale.");
    }
    return { entry, agent, binding, active, inbox, providerTurnBinding };
  }

  /** Build a delivery agent only from one exact manifest, handle, binding, and credential tuple. */
  async start(entryId: string, mode: DeliveryMode = "refresh"): Promise<void> {
    const delivery = this.ports.delivery;
    if (this.ports.isHandoffScheduled() || !delivery || !this.ports.supportsRoomTurns()) return;
    if (this.ports.isLifecycleActive(entryId)) return;
    const entry = await this.ports.manifest.getEntry(entryId);
    // Legacy worker polling and daemon ingress are mutually exclusive across
    // every crash boundary; complete the durable cutover first.
    if (entry?.provider === "codex" && (entry.delivery_mode ?? "mcp_polling") === "mcp_polling") {
      const configuration = await this.ports.manifest.getAgentConfiguration(entry.id);
      if (!configuration || configuration.polling_contract) return;
      await this.ports.cutovers.start(entryId);
      return;
    }
    if (!entry || entry.delivery_mode !== "daemon_inbox") return;
    if (entry.turn_control?.inbox_item_id
      && ["prepared", "dispatching", "uncertain"].includes(entry.turn_control.status)) return;

    const pendingMoves = await this.ports.manifest.pendingRoomMoves(entryId);
    if (pendingMoves.length > 1) {
      throw new Error("More than one nonterminal room move exists for this agent.");
    }
    const pendingMove = pendingMoves[0] ?? null;
    if (pendingMove) {
      let move: DaemonRoomMoveRecord;
      try {
        move = await this.ports.roomMoves.reconcile(pendingMove);
      } catch (error) {
        this.ports.scheduleRecovery(pendingMove.agent_id, 1_000);
        throw error;
      }
      if (this.ports.isLifecycleActive(entryId) || move.phase !== "waiting_for_current_turn") return;
      const isRecoverableActivatingState = (
        candidate: Pick<SupervisedInboxItem, "state" | "provider_turn_id">,
      ): boolean => ["dispatching", "awaiting_result", "result_recovery", "publishing", "retryable"].includes(candidate.state)
        || (candidate.state === "pending" && candidate.provider_turn_id !== null);
      if (move.activating_inbox_item_id) {
        const item = await this.ports.inbox.get(move.activating_inbox_item_id);
        const binding = item ? await this.ports.inbox.providerTurnBinding(item.inbox_item_id) : null;
        const effect = move.effect_id && move.provider_turn_id && binding
          ? await this.ports.inbox.preparedRoomMove(
            move.agent_id,
            binding.origin_execution_generation_id,
            move.provider_turn_id,
          )
          : null;
        const exactWaiter = Boolean(item
          && isRecoverableActivatingState(item)
          && item.agent_id === move.agent_id
          && item.room_id === move.source_room_id
          && item.provider_turn_id === move.provider_turn_id
          && binding
          && binding.agent_id === move.agent_id
          && binding.room_id === move.source_room_id
          && binding.work_attempt_id === move.work_attempt_id
          && binding.provider_turn_id === move.provider_turn_id
          && effect
          && effect.effect_id === move.effect_id
          && effect.room_id === move.source_room_id
          && effect.execution_generation_id === binding.origin_execution_generation_id);
        if (!exactWaiter) return;
      } else {
        const receipts = await this.ports.inbox.receipts(move.agent_id);
        if (!receipts.some(isRecoverableActivatingState)) return;
      }
    }

    const handle = this.ports.liveHandle(entryId);
    const binding = await this.ports.bindings.get(entryId);
    if (!binding || !entry.work_attempt_id || !entry.provider_ref) return;
    const credential = await this.ports.bindings.credentialFor(binding);
    if (!credential) return;
    const agent = {
      agentId: entryId,
      roomId: binding.room_id,
      provider: entry.provider,
      charter: entry.charter,
      apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id,
      bearer: credential,
      handle: handle ?? null,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: entry.provider_ref.provider_continuation_id,
      providerConnection: entry.provider_ref.provider_connection ?? null,
      executionGenerationId: binding.execution_generation_id,
      daemonGeneration: this.ports.currentDaemonGeneration(),
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
    };
    if (!await this.ports.providerAuthority.isExactAuthority(agent)) return;
    if (mode === "ensure" || mode === "wake") {
      await delivery.ensureStarted(agent);
      if (mode === "wake") delivery.wake(agent);
    } else {
      await delivery.refresh(agent);
    }
  }

  async restartOrConverge(entryId: string): Promise<void> {
    if (this.ports.isLifecycleActive(entryId)) {
      // Lifecycle cleanup calls this before releasing exclusion. Defer one
      // turn so the exact room move and delivery owner may reacquire the lane.
      const timer = setTimeout(() => void this.restartOrConverge(entryId), 0);
      timer.unref();
      return;
    }
    try {
      await this.start(entryId, "ensure");
    } catch {
      this.ports.scheduleRecovery(entryId, 250);
    }
  }
}
