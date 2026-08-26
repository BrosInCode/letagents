import { lastRoomMessageId } from "./cloud-http.js";
import {
  authoritativeRoomJoinRejection,
  schedulerErrorDetail,
} from "./daemon-error-policy.js";
import type { EntryConcurrencyGate } from "./entry-concurrency-gate.js";
import type { ManifestStore } from "./manifest-store.js";
import type { ProviderActionHandle } from "./provider-action-port.js";
import { DaemonFenceLostError } from "./singleton.js";
import type {
  SupervisedAgentInboxStore,
  SupervisedEffectRecord,
} from "./supervised-agent-inbox-store.js";
import type {
  SupervisedDeliveryHttp,
  SupervisedIngressAgent,
} from "./supervised-agent-delivery.js";
import type { DaemonManifestEntry, DaemonRoomMoveRecord } from "./types.js";
import type { WorkerBindingStore } from "./worker-binding-store.js";
import type { WorkerRuntimeCustody } from "./worker-runtime-custody.js";

type CommitFence = (commit: () => Promise<void>) => Promise<void>;

export type RoomMoveStorePort = Pick<ManifestStore,
  "advanceRoomMove" | "getEntry" | "getRoomMove" | "pendingRoomMoves" | "prepareRoomMove"
>;

export type RoomMoveInboxPort = Pick<SupervisedAgentInboxStore,
  | "commitRoomMoveCursor"
  | "commitRoomMoveQueue"
  | "get"
  | "preparedRoomMove"
  | "preparedRoomMoves"
  | "providerTurnBinding"
  | "receipts"
  | "rollbackRoomMoveIngress"
>;

export type RoomMoveBindingPort = Pick<WorkerBindingStore, "credentialFor" | "get" | "unbind">;

export type RoomMoveRuntimeCustodyPort = Pick<WorkerRuntimeCustody,
  | "deleteLiveBinding"
  | "deleteWorkerAuthorization"
  | "destroyHostGrantIfCurrent"
  | "hostGrant"
>;

export type RoomMoveAuthorityPort = {
  currentGeneration: () => number;
  isHandoffScheduled: () => boolean;
  assertCurrent: () => Promise<void>;
  ownsDaemonGeneration: (expectedGeneration: number) => Promise<boolean>;
  fenceCommit: CommitFence;
};

export type RoomMoveCoordinatorPorts = {
  store: RoomMoveStorePort;
  inbox: RoomMoveInboxPort;
  bindings: RoomMoveBindingPort;
  runtimeCustody: RoomMoveRuntimeCustodyPort;
  deliveryHttp: Pick<SupervisedDeliveryHttp, "joinRoom" | "latest">;
  authority: RoomMoveAuthorityPort;
  entryConcurrency: Pick<EntryConcurrencyGate, "runRoomMove">;
  serializeEntry: <T>(entryId: string, operation: () => Promise<T>) => Promise<T>;
  updateManifestEntry: (
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
  ) => Promise<DaemonManifestEntry>;
  currentHandle: (entryId: string) => ProviderActionHandle | null | undefined;
  pauseIngress: (entryId: string) => void;
  restartDelivery: (entryId: string) => Promise<void>;
  scheduleRecovery: (entryId: string, delayMs: number) => void;
  nowIso?: () => string;
  externalEffectSignal?: () => AbortSignal;
};

export type PrepareInspectorRoomMoveInput = {
  entryId: string;
  destinationRoomId: string;
  requestId: string;
  daemonGeneration: number;
};

export type CommitInspectorRoomMoveInput = {
  operationId: string;
  entryId: string;
  daemonGeneration: number;
};

export type AcknowledgeInspectorRoomMoveSourceRevocationInput = CommitInspectorRoomMoveInput & {
  sourceAgentSessionId: string;
};

export type RollbackInspectorRoomMoveInput = CommitInspectorRoomMoveInput & {
  detail: string;
};

/**
 * Owns the durable room-move phase machine and compensation saga. Process
 * authority, durable stores, worker secrets, delivery loops, and lifecycle
 * exclusion remain explicit ports owned by SupervisorDaemon.
 */
export class RoomMoveCoordinator {
  private readonly nowIso: () => string;
  private readonly externalEffectSignal: () => AbortSignal;

  constructor(private readonly ports: RoomMoveCoordinatorPorts) {
    this.nowIso = ports.nowIso ?? (() => new Date().toISOString());
    this.externalEffectSignal = ports.externalEffectSignal ?? (() => AbortSignal.timeout(10_000));
  }

  async commitPreparedRoomMove(input: {
    agent: SupervisedIngressAgent;
    inboxItemId: string;
  }): Promise<void> {
    const item = await this.ports.inbox.get(input.inboxItemId);
    if (!item?.provider_turn_id || !["acknowledged", "acknowledged_no_reply"].includes(item.state)) return;
    try {
      for (const move of await this.ports.store.pendingRoomMoves(input.agent.agentId)) {
        await this.reconcile(move);
      }
    } catch {
      this.ports.scheduleRecovery(input.agent.agentId, 1_000);
    }
  }

  async reconcilePrepared(agentId?: string): Promise<void> {
    // Effect-first repair is required because terminal moves are omitted from
    // pendingRoomMoves even when their prepared join effect was not settled.
    for (const effect of await this.ports.inbox.preparedRoomMoves(agentId)) {
      await this.reconcilePreparedEffect(effect).catch(() => {
        this.ports.scheduleRecovery(effect.agent_id, 1_000);
      });
    }
    for (const move of await this.ports.store.pendingRoomMoves(agentId)) {
      await this.reconcile(move).catch(() => {
        this.ports.scheduleRecovery(move.agent_id, 1_000);
      });
    }
  }

  async reconcilePreparedEffect(effect: SupervisedEffectRecord): Promise<void> {
    const move = await this.ports.store.getRoomMove(`room_move:${effect.effect_id}`);
    if (!move) return;
    if (move.phase === "active" || move.phase === "failed") {
      await this.ports.store.advanceRoomMove({
        operationId: move.operation_id,
        agentId: move.agent_id,
        expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id,
        from: [move.phase],
        to: move.phase,
        error: move.error,
      }, this.commitFence);
      return;
    }
    await this.reconcile(move);
  }

  /** Run one idempotent reconciliation through the existing entry admission gate. */
  async reconcile(initial: DaemonRoomMoveRecord): Promise<DaemonRoomMoveRecord> {
    try {
      return await this.ports.entryConcurrency.runRoomMove(
        initial.agent_id,
        initial,
        () => this.reconcileAdmitted(initial),
      );
    } catch (error) {
      if (this.ports.authority.isHandoffScheduled() && error instanceof DaemonFenceLostError) {
        return initial;
      }
      throw error;
    }
  }

  async prepareInspector(input: PrepareInspectorRoomMoveInput): Promise<DaemonRoomMoveRecord> {
    if (!input.entryId.trim()
      || !input.destinationRoomId.trim()
      || input.destinationRoomId.length > 1_024
      || /[\u0000-\u001f\u007f]/.test(input.destinationRoomId)
      || !input.requestId.trim()
      || input.requestId.length > 256
      || !Number.isSafeInteger(input.daemonGeneration)
      || input.daemonGeneration !== this.ports.authority.currentGeneration()) {
      throw new Error("Room-move preparation is stale or invalid.");
    }
    return this.ports.serializeEntry(input.entryId, async () => {
      await this.ports.authority.assertCurrent();
      const entry = await this.ports.store.getEntry(input.entryId);
      const binding = await this.ports.bindings.get(input.entryId);
      const credential = binding ? await this.ports.bindings.credentialFor(binding) : null;
      const handle = this.ports.currentHandle(input.entryId);
      if (!entry
        || input.destinationRoomId.trim() === entry.room_id
        || !entry.work_attempt_id
        || !entry.provider_ref
        || !binding
        || !credential
        || !handle
        || binding.room_id !== entry.room_id
        || binding.work_attempt_id !== entry.work_attempt_id
        || binding.execution_generation_id !== entry.provider_ref.execution_generation_id
        || handle.workAttemptId !== entry.work_attempt_id
        || handle.providerContinuationId !== entry.provider_ref.provider_continuation_id) {
        throw new Error("Room move requires the exact current live provider and source-room credential binding.");
      }
      const operationId = `inspector-room-move:${input.entryId}:${input.requestId}`;
      const prepared = await this.ports.store.prepareRoomMove({
        operation_id: operationId,
        request_id: `inspector:${input.requestId}`,
        agent_id: entry.id,
        source_room_id: entry.room_id,
        destination_room_id: input.destinationRoomId.trim(),
        daemon_generation: input.daemonGeneration,
        work_attempt_id: entry.work_attempt_id,
        execution_generation_id: entry.provider_ref.execution_generation_id,
        agent_session_id: binding.agent_session_id,
        activating_inbox_item_id: null,
        provider_turn_id: null,
        effect_id: null,
        phase: "prepared",
      }, this.commitFence);
      return prepared.move;
    });
  }

  async commitInspector(input: CommitInspectorRoomMoveInput): Promise<DaemonRoomMoveRecord> {
    this.assertInspectorCoordinates(input, "Room-move commit is stale or invalid.");
    const move = await this.ports.store.getRoomMove(input.operationId);
    if (!move || move.agent_id !== input.entryId) {
      throw new Error("Unknown room-move operation for this agent.");
    }
    return this.reconcile(move);
  }

  async acknowledgeSourceRevocation(
    input: AcknowledgeInspectorRoomMoveSourceRevocationInput,
  ): Promise<DaemonRoomMoveRecord> {
    if (!input.operationId.trim()
      || !input.entryId.trim()
      || !input.sourceAgentSessionId.trim()
      || !Number.isSafeInteger(input.daemonGeneration)
      || input.daemonGeneration !== this.ports.authority.currentGeneration()) {
      throw new Error("Room-move credential acknowledgement is stale or invalid.");
    }
    return this.ports.serializeEntry(input.entryId, async () => {
      await this.ports.authority.assertCurrent();
      const move = await this.ports.store.getRoomMove(input.operationId);
      if (!move || move.agent_id !== input.entryId) {
        throw new Error("Unknown room-move operation for this agent.");
      }
      if (move.agent_session_id !== input.sourceAgentSessionId) {
        throw new Error("Room-move credential acknowledgement does not match the exact source session.");
      }
      if (move.source_credentials_revoked) return move;
      if (move.phase !== "rotating_credentials") {
        throw new Error("Room-move source credentials can only be acknowledged during credential rotation.");
      }
      return this.ports.store.advanceRoomMove({
        operationId: move.operation_id,
        agentId: move.agent_id,
        expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id,
        from: ["rotating_credentials"],
        to: "rotating_credentials",
        sourceCredentialsRevoked: true,
      }, this.commitFence);
    });
  }

  async rollbackInspector(input: RollbackInspectorRoomMoveInput): Promise<DaemonRoomMoveRecord> {
    if (!input.operationId.trim()
      || !input.entryId.trim()
      || !input.detail.trim()
      || !Number.isSafeInteger(input.daemonGeneration)
      || input.daemonGeneration !== this.ports.authority.currentGeneration()) {
      throw new Error("Room-move rollback is stale or invalid.");
    }
    return this.ports.serializeEntry(input.entryId, async () => {
      await this.ports.authority.assertCurrent();
      let move = await this.ports.store.getRoomMove(input.operationId);
      if (!move || move.agent_id !== input.entryId) {
        throw new Error("Unknown room-move operation for this agent.");
      }
      if (["active", "failed"].includes(move.phase)) return move;
      if (move.phase !== "rollback_required") {
        if (!["joining_destination", "membership_committed", "rotating_credentials", "bootstrapping_destination_tail"].includes(move.phase)) {
          throw new Error("Room move cannot be rolled back before destination membership commits.");
        }
        move = await this.ports.store.advanceRoomMove({
          operationId: move.operation_id,
          agentId: move.agent_id,
          expectedDaemonGeneration: move.daemon_generation,
          expectedExecutionGenerationId: move.execution_generation_id,
          from: [move.phase],
          to: "rollback_required",
          error: `Destination credential preparation failed: ${schedulerErrorDetail(new Error(input.detail))}`,
        }, this.commitFence);
      }
      const destination = move.remote_room_id ?? move.destination_room_id;
      await this.ports.updateManifestEntry(move.agent_id, (current) => {
        if (![move.source_room_id, destination, move.destination_room_id].includes(current.room_id)) {
          return current;
        }
        return {
          ...current,
          room_id: move.source_room_id,
          condition: "coordination_blocked",
          last_error: "Room move rollback is waiting for source-room owner authority.",
          workplace_liveness: {
            state: "unknown",
            observed_at: this.nowIso(),
            detail: "Destination credential preparation failed; source authority is being restored.",
          },
          last_worker_binding: current.room_id === move.source_room_id
            ? current.last_worker_binding
            : null,
        };
      });
      return move;
    });
  }

  async getInspector(input: CommitInspectorRoomMoveInput): Promise<DaemonRoomMoveRecord> {
    this.assertInspectorCoordinates(input, "Room-move status is stale or invalid.");
    const move = await this.ports.store.getRoomMove(input.operationId);
    if (!move || move.agent_id !== input.entryId) {
      throw new Error("Unknown room-move operation for this agent.");
    }
    return move;
  }

  async getCurrentInspector(input: {
    entryId: string;
    daemonGeneration: number;
  }): Promise<DaemonRoomMoveRecord | null> {
    if (!input.entryId.trim()
      || !Number.isSafeInteger(input.daemonGeneration)
      || input.daemonGeneration !== this.ports.authority.currentGeneration()) {
      throw new Error("Current room-move discovery is stale or invalid.");
    }
    const moves = await this.ports.store.pendingRoomMoves(input.entryId);
    if (moves.length > 1) {
      throw new Error("More than one nonterminal room move exists for this agent.");
    }
    const move = moves[0] ?? null;
    return move?.daemon_generation === input.daemonGeneration ? move : null;
  }

  private readonly commitFence: CommitFence = (commit) => this.ports.authority.fenceCommit(commit);

  private async reconcileAdmitted(initial: DaemonRoomMoveRecord): Promise<DaemonRoomMoveRecord> {
    if (this.ports.authority.isHandoffScheduled()) return initial;
    const storedMove = await this.ports.store.getRoomMove(initial.operation_id);
    if (!storedMove || ["active", "failed"].includes(storedMove.phase)) return storedMove ?? initial;
    let move: DaemonRoomMoveRecord = storedMove;
    if (move.daemon_generation !== this.ports.authority.currentGeneration()) {
      await this.ports.authority.assertCurrent();
      move = await this.ports.store.advanceRoomMove({
        operationId: move.operation_id,
        agentId: move.agent_id,
        expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id,
        from: [move.phase],
        to: move.phase,
        adoptDaemonGeneration: this.ports.authority.currentGeneration(),
      }, this.commitFence);
    }
    if (move.phase === "rollback_required") return this.compensateRollback(move);

    let entry = await this.ports.store.getEntry(move.agent_id);
    const membershipCommitted = [
      "membership_committed",
      "rotating_credentials",
      "bootstrapping_destination_tail",
    ].includes(move.phase);
    const externalJoinMayHaveCommitted = move.phase === "joining_destination" || membershipCommitted;
    const runtimeExact = Boolean(entry
      && entry.desired_state === "running"
      && move.work_attempt_id
      && move.execution_generation_id
      && entry.work_attempt_id === move.work_attempt_id
      && entry.provider_ref?.execution_generation_id === move.execution_generation_id);
    if (!entry
      || !runtimeExact
      || (membershipCommitted
        ? entry.room_id !== (move.remote_room_id ?? move.destination_room_id)
        : ![move.source_room_id, move.destination_room_id, move.remote_room_id].includes(entry.room_id))) {
      const phase = externalJoinMayHaveCommitted ? "rollback_required" : "failed";
      move = await this.ports.store.advanceRoomMove({
        operationId: move.operation_id,
        agentId: move.agent_id,
        expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id,
        from: [move.phase],
        to: phase,
        error: "The exact provider generation or room membership changed during the move.",
      }, this.commitFence);
      if (phase === "rollback_required") this.ports.scheduleRecovery(move.agent_id, 1_000);
      return move;
    }

    const advance = async (
      from: DaemonRoomMoveRecord["phase"],
      to: DaemonRoomMoveRecord["phase"],
      extra: Partial<Pick<DaemonRoomMoveRecord,
        "remote_room_id" | "destination_cursor" | "source_credentials_revoked" | "error"
      >> = {},
    ): Promise<void> => {
      move = await this.ports.store.advanceRoomMove({
        operationId: move.operation_id,
        agentId: move.agent_id,
        expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id,
        from: [from],
        to,
        remoteRoomId: extra.remote_room_id,
        destinationCursor: extra.destination_cursor,
        sourceCredentialsRevoked: extra.source_credentials_revoked,
        error: extra.error,
      }, this.commitFence);
    };
    const runtimeIsExact = async (roomIds: readonly string[]): Promise<boolean> => {
      if (!await this.ports.authority.ownsDaemonGeneration(move.daemon_generation)) return false;
      const current = await this.ports.store.getEntry(move.agent_id);
      return Boolean(current
        && roomIds.includes(current.room_id)
        && current.work_attempt_id === move.work_attempt_id
        && current.provider_ref?.execution_generation_id === move.execution_generation_id);
    };
    const failFence = async (
      terminal: "failed" | "rollback_required",
      detail: string,
    ): Promise<DaemonRoomMoveRecord> => {
      await advance(move.phase, terminal, { error: detail });
      if (terminal === "rollback_required") this.ports.scheduleRecovery(move.agent_id, 1_000);
      return move;
    };

    if (move.phase === "prepared") await advance("prepared", "waiting_for_current_turn");
    if (move.phase === "waiting_for_current_turn") {
      if (move.activating_inbox_item_id) {
        const item = await this.ports.inbox.get(move.activating_inbox_item_id);
        const providerTurnBinding = item
          ? await this.ports.inbox.providerTurnBinding(item.inbox_item_id)
          : null;
        const effect = move.effect_id && move.provider_turn_id && providerTurnBinding
          ? await this.ports.inbox.preparedRoomMove(
            move.agent_id,
            providerTurnBinding.origin_execution_generation_id,
            move.provider_turn_id,
          )
          : null;
        const exactActivatingAuthority = Boolean(item
          && item.agent_id === move.agent_id
          && item.room_id === move.source_room_id
          && item.provider_turn_id === move.provider_turn_id
          && providerTurnBinding
          && providerTurnBinding.provider_turn_id === item.provider_turn_id
          && effect
          && effect.effect_id === move.effect_id
          && effect.room_id === move.source_room_id
          && effect.execution_generation_id === providerTurnBinding.origin_execution_generation_id);
        if (!exactActivatingAuthority) {
          return failFence(
            "failed",
            "The activating provider-turn authority changed before destination membership was joined.",
          );
        }
        if (["cancelled_by_room_move", "cancelled_by_user"].includes(item!.state)) {
          return failFence(
            "failed",
            "The activating provider turn was cancelled before destination membership was joined.",
          );
        }
        if (!["acknowledged", "acknowledged_no_reply"].includes(item!.state)) return move;
      } else {
        const receipts = await this.ports.inbox.receipts(move.agent_id);
        if (receipts.some((receipt) => [
          "dispatching",
          "awaiting_result",
          "result_recovery",
          "publishing",
          "retryable",
        ].includes(receipt.state) || (receipt.state === "pending" && receipt.provider_turn_id !== null))) {
          return move;
        }
      }
      if (!await runtimeIsExact([move.source_room_id])) {
        return failFence("failed", "Runtime authority changed before destination membership was joined.");
      }
      await advance("waiting_for_current_turn", "joining_destination");
    }

    if (move.phase === "joining_destination") {
      this.ports.pauseIngress(move.agent_id);
      const binding = await this.ports.bindings.get(move.agent_id);
      const credential = binding ? await this.ports.bindings.credentialFor(binding) : null;
      if (!binding
        || !credential
        || binding.room_id !== move.source_room_id
        || binding.work_attempt_id !== move.work_attempt_id
        || binding.execution_generation_id !== move.execution_generation_id
        || (move.agent_session_id !== null && binding.agent_session_id !== move.agent_session_id)) {
        return move;
      }
      let remoteRoomId: string;
      try {
        if (!this.ports.deliveryHttp.joinRoom) {
          throw new Error("Durable room join transport is unavailable.");
        }
        await this.assertExternalAuthority();
        remoteRoomId = (await this.ports.deliveryHttp.joinRoom({
          roomId: move.destination_room_id,
          apiUrl: binding.api_url,
          bearer: credential,
          signal: this.externalEffectSignal(),
        })).roomId.trim();
        await this.assertExternalAuthority();
        if (!remoteRoomId
          || remoteRoomId === move.source_room_id
          || remoteRoomId.length > 1_024
          || /[\u0000-\u001f\u007f]/.test(remoteRoomId)) {
          throw new Error("Destination join response omitted a valid distinct canonical room identity.");
        }
      } catch (error) {
        if (this.ports.authority.isHandoffScheduled() && error instanceof DaemonFenceLostError) throw error;
        if (!authoritativeRoomJoinRejection(error)) {
          await advance("joining_destination", "joining_destination", {
            error: `Destination join outcome was ambiguous and will retry: ${schedulerErrorDetail(error)}`,
          });
          this.ports.scheduleRecovery(move.agent_id, 1_000);
          return move;
        }
        await advance("joining_destination", "failed", {
          error: `Destination join was authoritatively rejected before local membership changed: ${schedulerErrorDetail(error)}`,
        });
        this.restartDelivery(move.agent_id);
        return move;
      }

      await advance("joining_destination", "joining_destination", { remote_room_id: remoteRoomId });
      entry = await this.ports.store.getEntry(move.agent_id);
      if (!entry
        || entry.work_attempt_id !== move.work_attempt_id
        || entry.provider_ref?.execution_generation_id !== move.execution_generation_id) {
        try {
          await this.assertExternalAuthority();
          await this.ports.deliveryHttp.joinRoom({
            roomId: move.source_room_id,
            apiUrl: binding.api_url,
            bearer: credential,
            signal: this.externalEffectSignal(),
          });
          await this.assertExternalAuthority();
          await advance("joining_destination", "failed", {
            error: "Runtime authority changed after remote join; remote membership was rolled back to the source room.",
          });
        } catch (error) {
          await advance("joining_destination", "rollback_required", {
            error: `Runtime authority changed after remote join and remote rollback failed: ${schedulerErrorDetail(error)}`,
          });
          this.ports.scheduleRecovery(move.agent_id, 1_000);
        }
        return move;
      }
      if (entry.room_id === move.source_room_id) {
        const fencedMove = move;
        await this.ports.updateManifestEntry(fencedMove.agent_id, (current) => (
          current.work_attempt_id === fencedMove.work_attempt_id
          && current.provider_ref?.execution_generation_id === fencedMove.execution_generation_id
          && current.room_id === fencedMove.source_room_id
            ? {
              ...current,
              room_id: remoteRoomId,
              condition: "coordination_blocked",
              last_error: "Room membership moved; waiting for destination credential rotation.",
              workplace_liveness: {
                state: "unknown",
                observed_at: this.nowIso(),
                detail: "Destination membership committed; destination ingress is not active yet.",
              },
              last_worker_binding: null,
            }
            : current
        ));
      }
      entry = await this.ports.store.getEntry(move.agent_id);
      if (!entry
        || entry.room_id !== remoteRoomId
        || entry.work_attempt_id !== move.work_attempt_id
        || entry.provider_ref?.execution_generation_id !== move.execution_generation_id) {
        try {
          await this.assertExternalAuthority();
          await this.ports.deliveryHttp.joinRoom({
            roomId: move.source_room_id,
            apiUrl: binding.api_url,
            bearer: credential,
            signal: this.externalEffectSignal(),
          });
          await this.assertExternalAuthority();
          await advance("joining_destination", "failed", {
            error: "Local membership commit lost its fence; remote membership was rolled back to the source room.",
          });
        } catch (error) {
          await advance("joining_destination", "rollback_required", {
            error: `Local membership commit and remote rollback both failed: ${schedulerErrorDetail(error)}`,
          });
          this.ports.scheduleRecovery(move.agent_id, 1_000);
        }
        return move;
      }
      await advance("joining_destination", "membership_committed", { remote_room_id: remoteRoomId });
    }

    if (move.phase === "membership_committed") {
      const binding = await this.ports.bindings.get(move.agent_id);
      const destination = move.remote_room_id ?? move.destination_room_id;
      if (!binding
        || ![move.source_room_id, destination].includes(binding.room_id)
        || binding.work_attempt_id !== move.work_attempt_id
        || binding.execution_generation_id !== move.execution_generation_id) {
        return failFence("rollback_required", "Credential binding changed after membership commit.");
      }
      const activating = move.activating_inbox_item_id
        ? await this.ports.inbox.get(move.activating_inbox_item_id)
        : null;
      await this.ports.inbox.commitRoomMoveQueue({
        operation_id: move.operation_id,
        agent_id: move.agent_id,
        old_room_id: move.source_room_id,
        after_fifo_sequence: activating?.fifo_sequence ?? 0,
      }, this.commitFence);
      if (!await runtimeIsExact([destination])) {
        return failFence("rollback_required", "Runtime authority changed after membership commit.");
      }
      await advance("membership_committed", "rotating_credentials");
    }

    if (move.phase === "rotating_credentials") {
      const destination = move.remote_room_id ?? move.destination_room_id;
      if (!await runtimeIsExact([destination])) {
        return failFence("rollback_required", "Runtime authority changed during credential rotation.");
      }
      if (!move.source_credentials_revoked || !move.agent_session_id) return move;
      const binding = await this.ports.bindings.get(move.agent_id);
      const credential = binding ? await this.ports.bindings.credentialFor(binding) : null;
      const grant = this.ports.runtimeCustody.hostGrant(move.agent_id) ?? null;
      if (!binding
        || !credential
        || binding.room_id !== destination
        || binding.work_attempt_id !== move.work_attempt_id
        || binding.execution_generation_id !== move.execution_generation_id
        || !grant
        || grant.entryId !== move.agent_id
        || grant.roomId !== destination
        || grant.daemonGeneration !== move.daemon_generation) {
        return move;
      }
      await advance("rotating_credentials", "bootstrapping_destination_tail");
    }

    if (move.phase === "bootstrapping_destination_tail") {
      const current = await this.ports.store.getEntry(move.agent_id);
      const binding = await this.ports.bindings.get(move.agent_id);
      const credential = binding ? await this.ports.bindings.credentialFor(binding) : null;
      const destination = move.remote_room_id ?? move.destination_room_id;
      if (!current
        || current.room_id !== destination
        || current.work_attempt_id !== move.work_attempt_id
        || current.provider_ref?.execution_generation_id !== move.execution_generation_id) {
        return failFence(
          "rollback_required",
          "Runtime authority changed before destination ingress activation.",
        );
      }
      if (!binding
        || !credential
        || binding.room_id !== destination
        || binding.work_attempt_id !== move.work_attempt_id
        || binding.execution_generation_id !== move.execution_generation_id
        || !this.ports.deliveryHttp.latest) {
        return move;
      }
      await this.assertExternalAuthority();
      const tail = await this.ports.deliveryHttp.latest({
        roomId: destination,
        apiUrl: binding.api_url,
        bearer: credential,
        signal: this.externalEffectSignal(),
      });
      await this.assertExternalAuthority();
      if (!await runtimeIsExact([destination])) {
        return failFence("rollback_required", "Runtime authority changed while destination tail was observed.");
      }
      const exactBinding = await this.ports.bindings.get(move.agent_id);
      if (!exactBinding
        || exactBinding.room_id !== destination
        || exactBinding.work_attempt_id !== move.work_attempt_id
        || exactBinding.execution_generation_id !== move.execution_generation_id
        || exactBinding.agent_session_id !== binding.agent_session_id) {
        return move;
      }
      const cursor = lastRoomMessageId(tail.messages ?? []);
      await this.ports.inbox.commitRoomMoveCursor({
        agent_id: move.agent_id,
        source_room_id: move.source_room_id,
        destination_room_id: destination,
        last_observed_message_id: cursor,
      }, this.commitFence);
      if (!await runtimeIsExact([destination])) {
        return failFence(
          "rollback_required",
          "Runtime authority changed before destination ingress activation committed.",
        );
      }
      await advance("bootstrapping_destination_tail", "active", { destination_cursor: cursor });
      this.restartDelivery(move.agent_id);
    }
    return move;
  }

  private async compensateRollback(initial: DaemonRoomMoveRecord): Promise<DaemonRoomMoveRecord> {
    let move = initial;
    const destination = move.remote_room_id ?? move.destination_room_id;
    const retry = async (detail: string): Promise<DaemonRoomMoveRecord> => {
      move = await this.ports.store.advanceRoomMove({
        operationId: move.operation_id,
        agentId: move.agent_id,
        expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id,
        from: ["rollback_required"],
        to: "rollback_required",
        error: detail,
      }, this.commitFence);
      this.ports.scheduleRecovery(move.agent_id, 1_000);
      return move;
    };

    this.ports.pauseIngress(move.agent_id);
    const entry = await this.ports.store.getEntry(move.agent_id);
    if (!entry) return move;
    if (![move.source_room_id, destination, move.destination_room_id].includes(entry.room_id)) {
      const detail = `Room-move rollback was superseded by operator membership ${entry.room_id}; no local membership was overwritten.`;
      move = await this.ports.store.advanceRoomMove({
        operationId: move.operation_id,
        agentId: move.agent_id,
        expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id,
        from: ["rollback_required"],
        to: "failed",
        error: detail,
      }, this.commitFence);
      return move;
    }

    const binding = await this.ports.bindings.get(move.agent_id);
    const credential = binding ? await this.ports.bindings.credentialFor(binding) : null;
    if (!binding
      || !credential
      || ![move.source_room_id, destination, move.destination_room_id].includes(binding.room_id)) {
      return retry("Room-move rollback is waiting for a current source-or-destination credential.");
    }
    if (!this.ports.deliveryHttp.joinRoom) {
      return retry("Room-move rollback transport is unavailable.");
    }
    try {
      await this.assertExternalAuthority();
      const joined = await this.ports.deliveryHttp.joinRoom({
        roomId: move.source_room_id,
        apiUrl: binding.api_url,
        bearer: credential,
        signal: this.externalEffectSignal(),
      });
      await this.assertExternalAuthority();
      if (joined.roomId.trim() !== move.source_room_id) {
        throw new Error("Source rejoin returned a different canonical room identity.");
      }
    } catch (error) {
      if (this.ports.authority.isHandoffScheduled() && error instanceof DaemonFenceLostError) throw error;
      return retry(`Source-room rollback join failed and will retry: ${schedulerErrorDetail(error)}`);
    }

    await this.ports.updateManifestEntry(move.agent_id, (current) => {
      if (![move.source_room_id, destination, move.destination_room_id].includes(current.room_id)) {
        return current;
      }
      return {
        ...current,
        room_id: move.source_room_id,
        condition: "coordination_blocked",
        last_error: "Room move rolled back; waiting for source-room credential and ingress convergence.",
        workplace_liveness: {
          state: "unknown",
          observed_at: this.nowIso(),
          detail: "Source membership restored after room-move compensation.",
        },
        last_worker_binding: binding.room_id === move.source_room_id
          ? current.last_worker_binding
          : null,
      };
    });
    const restored = await this.ports.store.getEntry(move.agent_id);
    if (!restored || restored.room_id !== move.source_room_id) {
      return retry(
        "Source-room external membership was restored, but local membership is awaiting an operator-safe retry.",
      );
    }

    const activating = move.activating_inbox_item_id
      ? await this.ports.inbox.get(move.activating_inbox_item_id)
      : null;
    await this.ports.inbox.rollbackRoomMoveIngress({
      operation_id: move.operation_id,
      agent_id: move.agent_id,
      source_room_id: move.source_room_id,
      destination_room_id: destination,
      source_cursor_present: move.source_cursor_present,
      source_cursor: move.source_cursor,
      after_fifo_sequence: activating?.fifo_sequence ?? 0,
    }, this.commitFence);
    if (binding.room_id !== move.source_room_id) {
      await this.ports.bindings.unbind(
        move.agent_id,
        binding.agent_session_id,
        binding.execution_generation_id,
      );
      this.ports.runtimeCustody.deleteLiveBinding(move.agent_id);
      this.ports.runtimeCustody.deleteWorkerAuthorization(move.agent_id);
    }
    const grant = this.ports.runtimeCustody.hostGrant(move.agent_id);
    if (grant && grant.roomId !== move.source_room_id) {
      this.ports.runtimeCustody.destroyHostGrantIfCurrent(move.agent_id, grant);
    }

    const detail = "Room move failed after destination join and was durably restored to the source room.";
    move = await this.ports.store.advanceRoomMove({
      operationId: move.operation_id,
      agentId: move.agent_id,
      expectedDaemonGeneration: move.daemon_generation,
      expectedExecutionGenerationId: move.execution_generation_id,
      from: ["rollback_required"],
      to: "failed",
      error: detail,
    }, this.commitFence);
    this.restartDelivery(move.agent_id);
    return move;
  }

  private async assertExternalAuthority(): Promise<void> {
    if (this.ports.authority.isHandoffScheduled()) {
      throw new DaemonFenceLostError("Supervisor handoff fenced a stale room-move effect.");
    }
    await this.ports.authority.assertCurrent();
    if (this.ports.authority.isHandoffScheduled()) {
      throw new DaemonFenceLostError("Supervisor handoff fenced a stale room-move effect.");
    }
  }

  private assertInspectorCoordinates(input: CommitInspectorRoomMoveInput, message: string): void {
    if (!input.operationId.trim()
      || !input.entryId.trim()
      || !Number.isSafeInteger(input.daemonGeneration)
      || input.daemonGeneration !== this.ports.authority.currentGeneration()) {
      throw new Error(message);
    }
  }

  private restartDelivery(entryId: string): void {
    void this.ports.restartDelivery(entryId).catch(() => undefined);
  }
}
