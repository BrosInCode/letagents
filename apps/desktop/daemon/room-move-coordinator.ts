import type { DatabaseSync } from "node:sqlite";
import { codexAgentIsReadOnly } from "./bounded-effect-coordinator.js";
import { lastRoomMessageId } from "./cloud-http.js";
import {
  authoritativeRoomJoinRejection,
  schedulerErrorDetail,
} from "./daemon-error-policy.js";
import {
  checkRoomMoveSagaPhaseInTransaction,
  classifyRoomMoveEffectError,
  completeEffectInTransaction,
  computeEffectBackoffMs,
  EffectClaimRefusedError,
  EffectExecutor,
  EffectFenceError,
  failEffect,
  failEffectInTransaction,
  getEffectByIdempotencyKey,
  parseRoomMoveBootstrapTailPayload,
  parseRoomMoveJoinDestinationPayload,
  parseRoomMoveRollbackSourcePayload,
  pruneTerminalRoomMoveEffectsInTransaction,
  rescheduleEffectForRetry,
  ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND,
  ROOM_MOVE_EFFECT_BACKOFF,
  ROOM_MOVE_EFFECT_MAX_ATTEMPTS,
  ROOM_MOVE_EFFECT_RETRY_DELAY_MS,
  ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
  ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND,
  roomMoveBootstrapTailIdempotencyKey,
  roomMoveJoinDestinationIdempotencyKey,
  roomMoveRollbackSourceIdempotencyKey,
  withFencedEffectTransaction,
  type EffectHandler,
  type EffectRecord,
  type RoomMoveBootstrapTailEffectPayload,
  type RoomMoveJoinDestinationEffectPayload,
  type RoomMoveRollbackSourceEffectPayload,
} from "./effect-journal/index.js";
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
  | "nativeFailure"
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
  nowMs?: () => number;
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

type RoomMoveDispatchContext = {
  apiUrl: string;
  bearer: string;
  roomId: string;
  agentSessionId: string;
  workAttemptId: string | null;
  executionGenerationId: string | null;
};

class RoomMoveSettlementStorageError extends Error {
  constructor(cause: unknown) {
    super("Room-move effect settlement storage write failed.", { cause });
    this.name = "RoomMoveSettlementStorageError";
  }
}

/**
 * Owns the durable room-move phase machine and compensation saga. Process
 * authority, durable stores, worker secrets, delivery loops, and lifecycle
 * exclusion remain explicit ports owned by SupervisorDaemon. Outbound HTTP
 * sub-actions (`room_move_join_destination`, `room_move_rollback_source`,
 * `room_move_bootstrap_tail`) execute through the shared `EffectExecutor`.
 */
export class RoomMoveCoordinator {
  private readonly nowMs: () => number;
  private readonly nowIso: () => string;
  private readonly externalEffectSignal: () => AbortSignal;
  private effectExecutor: EffectExecutor | null = null;
  private effectDatabase: DatabaseSync | null = null;
  private effectWriteFence: () => void = () => {};
  private readonly pendingDispatchContext = new Map<string, RoomMoveDispatchContext>();
  private readonly lastSanitizedDiagnostic = new Map<string, string>();

  constructor(private readonly ports: RoomMoveCoordinatorPorts) {
    this.nowMs = ports.nowMs ?? (ports.nowIso
      ? () => {
          const parsed = Date.parse(ports.nowIso!());
          return Number.isFinite(parsed) ? parsed : Date.now();
        }
      : () => Date.now());
    this.nowIso = ports.nowIso ?? (() => new Date(this.nowMs()).toISOString());
    this.externalEffectSignal = ports.externalEffectSignal ?? (() => AbortSignal.timeout(10_000));
  }

  /** Attaches the shared process-wide EffectExecutor and registers all room-move HTTP sub-action handlers. */
  attachEffectExecutor(
    executor: EffectExecutor,
    database: DatabaseSync,
    assertWriteFence: () => void = () => {},
  ): void {
    this.effectExecutor = executor;
    this.effectDatabase = database;
    this.effectWriteFence = assertWriteFence;
    executor.registerHandler(ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND, this.createJoinDestinationHandler());
    executor.registerHandler(ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND, this.createRollbackSourceHandler());
    executor.registerHandler(ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND, this.createBootstrapTailHandler());
  }

  async commitPreparedRoomMove(input: {
    agent: SupervisedIngressAgent;
    inboxItemId: string;
  }): Promise<void> {
    const item = await this.ports.inbox.get(input.inboxItemId);
    if (!item?.provider_turn_id || (!["acknowledged", "acknowledged_no_reply"].includes(item.state)
      && !await this.ports.inbox.nativeFailure(item.inbox_item_id))) return;
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
      if (this.ports.authority.isHandoffScheduled()
        && (error instanceof DaemonFenceLostError || error instanceof EffectFenceError)) {
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
      if (entry?.local_room_id) throw new Error("Moving a local agent to another room is not supported yet. Start an agent in the destination room.");
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
        if (await this.ports.inbox.nativeFailure(item!.inbox_item_id)) {
          return failFence(
            "failed",
            "The activating provider turn ended unsuccessfully before destination membership was joined.",
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
      // A move the agent asked for is a room tool call that is applied later, here. Its owner may have
      // saved Read-only since the call was prepared, and that level does not let the agent move rooms,
      // so the move is not made. A move its owner makes in the Inspector has no effect of the agent's
      // and is not held to the agent's level.
      const savedNow = move.effect_id ? await this.ports.store.getEntry(move.agent_id) : null;
      if (savedNow && codexAgentIsReadOnly(savedNow)) {
        return failFence("failed", "The agent's access level is now Read-only, which does not let it move to another room.");
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
        const joinOutcome = await this.executeDestinationJoinEffect(move, {
          apiUrl: binding.api_url,
          bearer: credential,
          roomId: binding.room_id,
          agentSessionId: binding.agent_session_id,
          workAttemptId: move.work_attempt_id,
          executionGenerationId: move.execution_generation_id,
        });
        if (joinOutcome.kind === "rejected") {
          await advance("joining_destination", "failed", {
            error: `Destination join was authoritatively rejected before local membership changed: ${joinOutcome.detail}`,
          });
          this.restartDelivery(move.agent_id);
          return move;
        }
        if (joinOutcome.kind === "rollback_required") {
          await advance("joining_destination", "rollback_required", {
            error: `Destination join retry was rejected after a prior attempt may have committed remote membership; compensating back to source room: ${joinOutcome.detail}`,
          });
          this.ports.scheduleRecovery(move.agent_id, ROOM_MOVE_EFFECT_RETRY_DELAY_MS);
          return move;
        }
        if (joinOutcome.kind === "retry") {
          if (!joinOutcome.backedOff) {
            await advance("joining_destination", "joining_destination", {
              error: `Destination join outcome was ambiguous and will retry: ${joinOutcome.detail}`,
            });
          }
          this.ports.scheduleRecovery(move.agent_id, joinOutcome.retryAfterMs);
          return move;
        }
        remoteRoomId = joinOutcome.remoteRoomId;
      } catch (error) {
        if (this.ports.authority.isHandoffScheduled()
          && (error instanceof DaemonFenceLostError || error instanceof EffectFenceError)) {
          throw error;
        }
        await advance("joining_destination", "joining_destination", {
          error: `Destination join outcome was ambiguous and will retry: ${schedulerErrorDetail(error)}`,
        });
        this.ports.scheduleRecovery(move.agent_id, 1_000);
        return move;
      }

      await advance("joining_destination", "joining_destination", { remote_room_id: remoteRoomId });
      entry = await this.ports.store.getEntry(move.agent_id);
      if (!entry
        || entry.work_attempt_id !== move.work_attempt_id
        || entry.provider_ref?.execution_generation_id !== move.execution_generation_id) {
        try {
          const rollbackOutcome = await this.executeRollbackSourceEffect(move, {
            apiUrl: binding.api_url,
            bearer: credential,
            roomId: binding.room_id,
            agentSessionId: binding.agent_session_id,
            workAttemptId: move.work_attempt_id,
            executionGenerationId: move.execution_generation_id,
          });
          if (rollbackOutcome.kind === "completed") {
            await advance("joining_destination", "failed", {
              error: "Runtime authority changed after remote join; remote membership was rolled back to the source room.",
            });
          } else {
            await advance("joining_destination", "rollback_required", {
              error: `Runtime authority changed after remote join and remote rollback failed: ${rollbackOutcome.detail}`,
            });
            this.ports.scheduleRecovery(move.agent_id, rollbackOutcome.retryAfterMs);
          }
        } catch (error) {
          if (this.ports.authority.isHandoffScheduled()
            && (error instanceof DaemonFenceLostError || error instanceof EffectFenceError)) {
            throw error;
          }
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
          const rollbackOutcome = await this.executeRollbackSourceEffect(move, {
            apiUrl: binding.api_url,
            bearer: credential,
            roomId: binding.room_id,
            agentSessionId: binding.agent_session_id,
            workAttemptId: move.work_attempt_id,
            executionGenerationId: move.execution_generation_id,
          });
          if (rollbackOutcome.kind === "completed") {
            await advance("joining_destination", "failed", {
              error: "Local membership commit lost its fence; remote membership was rolled back to the source room.",
            });
          } else {
            await advance("joining_destination", "rollback_required", {
              error: `Local membership commit and remote rollback both failed: ${rollbackOutcome.detail}`,
            });
            this.ports.scheduleRecovery(move.agent_id, rollbackOutcome.retryAfterMs);
          }
        } catch (error) {
          if (this.ports.authority.isHandoffScheduled()
            && (error instanceof DaemonFenceLostError || error instanceof EffectFenceError)) {
            throw error;
          }
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
      const tailOutcome = await this.executeBootstrapTailEffect(move, destination, {
        apiUrl: binding.api_url,
        bearer: credential,
        roomId: binding.room_id,
        agentSessionId: binding.agent_session_id,
        workAttemptId: move.work_attempt_id,
        executionGenerationId: move.execution_generation_id,
      });
      if (tailOutcome.kind === "retry") {
        this.ports.scheduleRecovery(move.agent_id, tailOutcome.retryAfterMs);
        return move;
      }
      const cursor = tailOutcome.cursor;
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
    const retry = async (
      detail: string,
      delayMs = ROOM_MOVE_EFFECT_RETRY_DELAY_MS,
    ): Promise<DaemonRoomMoveRecord> => {
      move = await this.ports.store.advanceRoomMove({
        operationId: move.operation_id,
        agentId: move.agent_id,
        expectedDaemonGeneration: move.daemon_generation,
        expectedExecutionGenerationId: move.execution_generation_id,
        from: ["rollback_required"],
        to: "rollback_required",
        error: detail,
      }, this.commitFence);
      this.ports.scheduleRecovery(move.agent_id, delayMs);
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
      const rollbackOutcome = await this.executeRollbackSourceEffect(move, {
        apiUrl: binding.api_url,
        bearer: credential,
        roomId: binding.room_id,
        agentSessionId: binding.agent_session_id,
        workAttemptId: move.work_attempt_id,
        executionGenerationId: move.execution_generation_id,
      });
      if (rollbackOutcome.kind !== "completed") {
        if (rollbackOutcome.backedOff) {
          this.ports.scheduleRecovery(move.agent_id, rollbackOutcome.retryAfterMs);
          return move;
        }
        return retry(
          `Source-room rollback join failed and will retry: ${rollbackOutcome.detail}`,
          rollbackOutcome.retryAfterMs,
        );
      }
    } catch (error) {
      if (this.ports.authority.isHandoffScheduled()
        && (error instanceof DaemonFenceLostError || error instanceof EffectFenceError)) {
        throw error;
      }
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

  private requireEffectHost(): { executor: EffectExecutor; database: DatabaseSync } {
    if (!this.effectExecutor || !this.effectDatabase || !this.effectDatabase.isOpen) {
      throw new EffectFenceError("Room-move effect executor is unavailable.");
    }
    return { executor: this.effectExecutor, database: this.effectDatabase };
  }

  private recordSanitizedDiagnostic(effectId: string, error: unknown): void {
    if (!this.pendingDispatchContext.has(effectId)) return;
    this.lastSanitizedDiagnostic.set(
      effectId,
      typeof error === "string" ? error : schedulerErrorDetail(error),
    );
  }

  private retryDelayMsFor(effect: EffectRecord | null): number {
    if (effect?.next_attempt_at_ms !== null && effect?.next_attempt_at_ms !== undefined) {
      return Math.max(1, effect.next_attempt_at_ms - this.nowMs());
    }
    return ROOM_MOVE_EFFECT_RETRY_DELAY_MS;
  }

  private async resolveDispatchContext(
    claimed: EffectRecord,
    allowedBindingRooms: readonly string[],
    workAttemptId: string | null,
    executionGenerationId: string | null,
  ): Promise<RoomMoveDispatchContext | null> {
    const cached = this.pendingDispatchContext.get(claimed.id);
    if (cached) return cached;
    const binding = await this.ports.bindings.get(claimed.agent_id);
    const credential = binding ? await this.ports.bindings.credentialFor(binding) : null;
    if (!binding
      || !credential
      || !allowedBindingRooms.includes(binding.room_id)
      || (workAttemptId !== null && binding.work_attempt_id !== workAttemptId)
      || (executionGenerationId !== null && binding.execution_generation_id !== executionGenerationId)) {
      return null;
    }
    return {
      apiUrl: binding.api_url,
      bearer: credential,
      roomId: binding.room_id,
      agentSessionId: binding.agent_session_id,
      workAttemptId: binding.work_attempt_id,
      executionGenerationId: binding.execution_generation_id,
    };
  }

  private createJoinDestinationHandler(): EffectHandler {
    return {
      retryable: true,
      autoPump: false,
      defaultMaxAttempts: ROOM_MOVE_EFFECT_MAX_ATTEMPTS,
      backoff: ROOM_MOVE_EFFECT_BACKOFF,
      authorizeClaim: (database, effect) => {
        const payload = parseRoomMoveJoinDestinationPayload(effect.payload);
        if (!payload) return "invalid_payload";
        return checkRoomMoveSagaPhaseInTransaction(database, {
          operationId: payload.operation_id,
          agentId: effect.agent_id,
          workAttemptId: payload.work_attempt_id,
          executionGenerationId: payload.execution_generation_id,
          allowedPhases: ["joining_destination"],
        });
      },
      execute: async (claimed, context) => {
        const payload = parseRoomMoveJoinDestinationPayload(claimed.payload);
        if (!payload) {
          return { status: "failed", error: "invalid_payload" };
        }
        let dispatch: RoomMoveDispatchContext | null;
        try {
          dispatch = await this.resolveDispatchContext(
            claimed,
            [payload.source_room_id],
            payload.work_attempt_id,
            payload.execution_generation_id,
          );
        } catch (error) {
          if (error instanceof DaemonFenceLostError || error instanceof EffectFenceError) throw error;
          this.recordSanitizedDiagnostic(claimed.id, error);
          return { status: "retry", error: "dispatch_context_resolution_failed" };
        }
        if (!dispatch) {
          this.recordSanitizedDiagnostic(claimed.id, "Room-move source credential binding is unavailable.");
          return { status: "retry", error: "dispatch_context_unavailable" };
        }
        try {
          if (!this.ports.deliveryHttp.joinRoom) {
            this.recordSanitizedDiagnostic(claimed.id, "Durable room join transport is unavailable.");
            return { status: "retry", error: "transport_unavailable" };
          }
          await this.assertExternalAuthority();
          const signal = AbortSignal.any([context.signal, this.externalEffectSignal()]);
          const remoteRoomId = (await this.ports.deliveryHttp.joinRoom({
            roomId: payload.destination_room_id,
            apiUrl: dispatch.apiUrl,
            bearer: dispatch.bearer,
            signal,
          })).roomId.trim();
          await this.assertExternalAuthority();
          if (!remoteRoomId
            || remoteRoomId === payload.source_room_id
            || remoteRoomId.length > 1_024
            || /[\u0000-\u001f\u007f]/.test(remoteRoomId)) {
            this.recordSanitizedDiagnostic(
              claimed.id,
              "Destination join response omitted a valid distinct canonical room identity.",
            );
            return { status: "retry", error: "invalid_remote_room_id" };
          }
          return { status: "completed", outcome: { remote_room_id: remoteRoomId } };
        } catch (error) {
          if (error instanceof DaemonFenceLostError || error instanceof EffectFenceError) throw error;
          this.recordSanitizedDiagnostic(claimed.id, error);
          const errorCode = classifyRoomMoveEffectError(error);
          if (authoritativeRoomJoinRejection(error)) {
            if (claimed.attempt_count === 1) {
              return { status: "failed", error: errorCode, outcome: { authoritative_rejection: true } };
            }
            // Attempt >= 2: a prior attempt (lost response, crash, or failed
            // settlement write) may already have moved remote membership.
            // Never claim pre-membership rejection; require source compensation.
            return {
              status: "failed",
              error: errorCode,
              outcome: { authoritative_rejection: false, ambiguous_prior_attempt: true },
            };
          }
          return { status: "retry", error: errorCode };
        }
      },
      settle: async (claimed, executionResult, defaultSettle) => {
        const payload = parseRoomMoveJoinDestinationPayload(claimed.payload);
        return this.settleRoomMoveEffect(claimed, executionResult, defaultSettle, payload
          ? {
              operationId: payload.operation_id,
              agentId: claimed.agent_id,
              workAttemptId: payload.work_attempt_id,
              executionGenerationId: payload.execution_generation_id,
              allowedPhases: ["joining_destination"],
            }
          : null);
      },
    };
  }

  private createRollbackSourceHandler(): EffectHandler {
    return {
      retryable: true,
      autoPump: false,
      defaultMaxAttempts: ROOM_MOVE_EFFECT_MAX_ATTEMPTS,
      backoff: ROOM_MOVE_EFFECT_BACKOFF,
      authorizeClaim: (database, effect) => {
        const payload = parseRoomMoveRollbackSourcePayload(effect.payload);
        if (!payload) return "invalid_payload";
        return checkRoomMoveSagaPhaseInTransaction(database, {
          operationId: payload.operation_id,
          agentId: effect.agent_id,
          workAttemptId: payload.work_attempt_id,
          executionGenerationId: payload.execution_generation_id,
          allowedPhases: ["joining_destination", "rollback_required"],
        });
      },
      execute: async (claimed, context) => {
        const payload = parseRoomMoveRollbackSourcePayload(claimed.payload);
        if (!payload) {
          return { status: "failed", error: "invalid_payload" };
        }
        let dispatch: RoomMoveDispatchContext | null;
        try {
          const allowedRooms = [payload.source_room_id, payload.destination_room_id];
          if (!this.pendingDispatchContext.has(claimed.id)) {
            const moveRow = await this.ports.store.getRoomMove(payload.operation_id);
            if (moveRow?.remote_room_id) allowedRooms.push(moveRow.remote_room_id);
          }
          dispatch = await this.resolveDispatchContext(
            claimed,
            allowedRooms,
            null,
            null,
          );
        } catch (error) {
          if (error instanceof DaemonFenceLostError || error instanceof EffectFenceError) throw error;
          this.recordSanitizedDiagnostic(claimed.id, error);
          return { status: "retry", error: "dispatch_context_resolution_failed" };
        }
        if (!dispatch) {
          this.recordSanitizedDiagnostic(
            claimed.id,
            "Room-move rollback is waiting for a current source-or-destination credential.",
          );
          return { status: "retry", error: "dispatch_context_unavailable" };
        }
        try {
          if (!this.ports.deliveryHttp.joinRoom) {
            this.recordSanitizedDiagnostic(claimed.id, "Room-move rollback transport is unavailable.");
            return { status: "retry", error: "transport_unavailable" };
          }
          await this.assertExternalAuthority();
          const signal = AbortSignal.any([context.signal, this.externalEffectSignal()]);
          const joined = await this.ports.deliveryHttp.joinRoom({
            roomId: payload.source_room_id,
            apiUrl: dispatch.apiUrl,
            bearer: dispatch.bearer,
            signal,
          });
          await this.assertExternalAuthority();
          if (joined.roomId.trim() !== payload.source_room_id) {
            this.recordSanitizedDiagnostic(
              claimed.id,
              "Source rejoin returned a different canonical room identity.",
            );
            return { status: "retry", error: "source_rejoin_room_mismatch" };
          }
          return { status: "completed", outcome: { remote_room_id: payload.source_room_id } };
        } catch (error) {
          if (error instanceof DaemonFenceLostError || error instanceof EffectFenceError) throw error;
          this.recordSanitizedDiagnostic(claimed.id, error);
          return { status: "retry", error: classifyRoomMoveEffectError(error) };
        }
      },
      settle: async (claimed, executionResult, defaultSettle) => {
        const payload = parseRoomMoveRollbackSourcePayload(claimed.payload);
        return this.settleRoomMoveEffect(claimed, executionResult, defaultSettle, payload
          ? {
              operationId: payload.operation_id,
              agentId: claimed.agent_id,
              workAttemptId: payload.work_attempt_id,
              executionGenerationId: payload.execution_generation_id,
              allowedPhases: ["joining_destination", "rollback_required"],
            }
          : null);
      },
    };
  }

  private createBootstrapTailHandler(): EffectHandler {
    return {
      retryable: true,
      autoPump: false,
      defaultMaxAttempts: ROOM_MOVE_EFFECT_MAX_ATTEMPTS,
      backoff: ROOM_MOVE_EFFECT_BACKOFF,
      authorizeClaim: (database, effect) => {
        const payload = parseRoomMoveBootstrapTailPayload(effect.payload);
        if (!payload) return "invalid_payload";
        return checkRoomMoveSagaPhaseInTransaction(database, {
          operationId: payload.operation_id,
          agentId: effect.agent_id,
          workAttemptId: payload.work_attempt_id,
          executionGenerationId: payload.execution_generation_id,
          allowedPhases: ["bootstrapping_destination_tail"],
        });
      },
      execute: async (claimed, context) => {
        const payload = parseRoomMoveBootstrapTailPayload(claimed.payload);
        if (!payload) {
          return { status: "failed", error: "invalid_payload" };
        }
        let dispatch: RoomMoveDispatchContext | null;
        try {
          dispatch = await this.resolveDispatchContext(
            claimed,
            [payload.destination_room_id],
            payload.work_attempt_id,
            payload.execution_generation_id,
          );
        } catch (error) {
          if (error instanceof DaemonFenceLostError || error instanceof EffectFenceError) throw error;
          this.recordSanitizedDiagnostic(claimed.id, error);
          return { status: "retry", error: "dispatch_context_resolution_failed" };
        }
        if (!dispatch) {
          this.recordSanitizedDiagnostic(claimed.id, "Room-move destination credential binding is unavailable.");
          return { status: "retry", error: "dispatch_context_unavailable" };
        }
        try {
          if (!this.ports.deliveryHttp.latest) {
            this.recordSanitizedDiagnostic(claimed.id, "Destination tail transport is unavailable.");
            return { status: "retry", error: "transport_unavailable" };
          }
          await this.assertExternalAuthority();
          const signal = AbortSignal.any([context.signal, this.externalEffectSignal()]);
          const tail = await this.ports.deliveryHttp.latest({
            roomId: payload.destination_room_id,
            apiUrl: dispatch.apiUrl,
            bearer: dispatch.bearer,
            signal,
          });
          await this.assertExternalAuthority();
          const cursor = lastRoomMessageId(tail.messages ?? []);
          return { status: "completed", outcome: { destination_cursor: cursor } };
        } catch (error) {
          if (error instanceof DaemonFenceLostError || error instanceof EffectFenceError) throw error;
          this.recordSanitizedDiagnostic(claimed.id, error);
          return { status: "retry", error: classifyRoomMoveEffectError(error) };
        }
      },
      settle: async (claimed, executionResult, defaultSettle) => {
        const payload = parseRoomMoveBootstrapTailPayload(claimed.payload);
        return this.settleRoomMoveEffect(claimed, executionResult, defaultSettle, payload
          ? {
              operationId: payload.operation_id,
              agentId: claimed.agent_id,
              workAttemptId: payload.work_attempt_id,
              executionGenerationId: payload.execution_generation_id,
              allowedPhases: ["bootstrapping_destination_tail"],
            }
          : null);
      },
    };
  }

  private settleRoomMoveEffect(
    claimed: EffectRecord,
    executionResult: Parameters<NonNullable<EffectHandler["settle"]>>[1],
    defaultSettle: () => EffectRecord,
    sagaCheck: {
      operationId: string;
      agentId: string;
      workAttemptId: string | null;
      executionGenerationId: string | null;
      allowedPhases: readonly string[];
    } | null,
  ): EffectRecord {
    if (this.ports.authority.isHandoffScheduled()) {
      throw new EffectFenceError("Supervisor handoff fenced a stale room-move effect settlement.");
    }
    const { database } = this.requireEffectHost();
    if (executionResult.status === "retry" || executionResult.status === "uncertain") {
      try {
        return defaultSettle();
      } catch (error) {
        if (error instanceof DaemonFenceLostError || error instanceof EffectFenceError) throw error;
        throw new RoomMoveSettlementStorageError(error);
      }
    }
    try {
      return withFencedEffectTransaction(database, this.effectWriteFence, () => {
        if (this.ports.authority.isHandoffScheduled()) {
          throw new EffectFenceError("Supervisor handoff fenced a stale room-move effect settlement.");
        }
        const phaseRefusal = sagaCheck
          ? checkRoomMoveSagaPhaseInTransaction(database, sagaCheck)
          : null;
        const settled = phaseRefusal !== null
          ? failEffectInTransaction(database, {
              id: claimed.id,
              expectedEpoch: claimed.epoch,
              expectedAttemptCount: claimed.attempt_count,
              error: phaseRefusal,
              outcome: null,
              nowIso: this.nowIso(),
            })
          : executionResult.status === "completed"
            ? completeEffectInTransaction(database, {
                id: claimed.id,
                expectedEpoch: claimed.epoch,
                expectedAttemptCount: claimed.attempt_count,
                outcome: executionResult.outcome,
                nowIso: this.nowIso(),
              })
            : failEffectInTransaction(database, {
                id: claimed.id,
                expectedEpoch: claimed.epoch,
                expectedAttemptCount: claimed.attempt_count,
                error: executionResult.error,
                outcome: executionResult.outcome,
                nowIso: this.nowIso(),
              });
        pruneTerminalRoomMoveEffectsInTransaction(database, claimed.agent_id);
        return settled;
      });
    } catch (error) {
      if (error instanceof DaemonFenceLostError || error instanceof EffectFenceError) throw error;
      return this.rescheduleExecutingEffectSafe(claimed, "settlement_write_failed", error);
    }
  }

  private rescheduleExecutingEffectSafe(
    claimed: EffectRecord,
    errorCode: string,
    originalError?: unknown,
  ): EffectRecord {
    const { database } = this.requireEffectHost();
    try {
      if (claimed.attempt_count < claimed.max_attempts) {
        const retryDelayMs = computeEffectBackoffMs(
          Math.max(1, claimed.attempt_count),
          ROOM_MOVE_EFFECT_BACKOFF,
        );
        return rescheduleEffectForRetry(database, this.effectWriteFence, {
          id: claimed.id,
          expectedEpoch: claimed.epoch,
          expectedAttemptCount: claimed.attempt_count,
          nextAttemptAtMs: Math.max(0, this.nowMs()) + retryDelayMs,
          error: errorCode,
          nowIso: this.nowIso(),
        });
      }
      return failEffect(database, this.effectWriteFence, {
        id: claimed.id,
        expectedEpoch: claimed.epoch,
        expectedAttemptCount: claimed.attempt_count,
        error: errorCode,
        nowIso: this.nowIso(),
      });
    } catch (retryError) {
      if (retryError instanceof DaemonFenceLostError || retryError instanceof EffectFenceError) throw retryError;
      throw new RoomMoveSettlementStorageError(originalError ?? retryError);
    }
  }

  private async runRoomMoveEffect(input: {
    agentId: string;
    kind:
      | typeof ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND
      | typeof ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND
      | typeof ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND;
    idempotencyKey: string;
    payload:
      | RoomMoveJoinDestinationEffectPayload
      | RoomMoveRollbackSourceEffectPayload
      | RoomMoveBootstrapTailEffectPayload;
    dispatch: RoomMoveDispatchContext;
  }): Promise<{ effect: EffectRecord; diagnostic: string | null; backedOff: boolean }> {
    const { executor, database } = this.requireEffectHost();
    const existing = getEffectByIdempotencyKey(database, input.agentId, input.kind, input.idempotencyKey);
    if (existing?.state === "executing") {
      if (executor.isEffectActive(existing.id)) {
        const activeSettled = await executor.runEffect(existing.id);
        return { effect: activeSettled, diagnostic: null, backedOff: false };
      }
      if (existing.epoch > this.ports.authority.currentGeneration()) {
        throw new EffectFenceError(
          `Room-move effect ${existing.id} belongs to future daemon generation ${existing.epoch}.`,
        );
      }
      if (existing.attempt_count >= 1) {
        const recovered = this.rescheduleExecutingEffectSafe(existing, "recovered_inactive_executing_effect");
        return { effect: recovered, diagnostic: null, backedOff: true };
      }
    }
    const prepared = await executor.prepare({
      agent_id: input.agentId,
      kind: input.kind,
      idempotency_key: input.idempotencyKey,
      payload: input.payload,
      retryable: true,
      max_attempts: ROOM_MOVE_EFFECT_MAX_ATTEMPTS,
    });
    if (prepared.effect.state === "completed" || prepared.effect.state === "failed") {
      return { effect: prepared.effect, diagnostic: null, backedOff: false };
    }
    if (prepared.effect.state === "prepared"
      && prepared.effect.next_attempt_at_ms !== null
      && prepared.effect.next_attempt_at_ms > this.nowMs()) {
      return { effect: prepared.effect, diagnostic: null, backedOff: true };
    }
    const effectId = prepared.effect.id;
    this.pendingDispatchContext.set(effectId, input.dispatch);
    this.lastSanitizedDiagnostic.delete(effectId);
    try {
      const settled = await executor.runEffect(effectId);
      const diagnostic = this.lastSanitizedDiagnostic.get(effectId) ?? null;
      return { effect: settled, diagnostic, backedOff: false };
    } finally {
      this.pendingDispatchContext.delete(effectId);
      this.lastSanitizedDiagnostic.delete(effectId);
    }
  }

  private async executeDestinationJoinEffect(
    move: DaemonRoomMoveRecord,
    dispatch: RoomMoveDispatchContext,
  ): Promise<
    | { kind: "completed"; remoteRoomId: string }
    | { kind: "rejected"; detail: string }
    | { kind: "rollback_required"; detail: string }
    | { kind: "retry"; detail: string; retryAfterMs: number; backedOff?: boolean }
  > {
    const payload: RoomMoveJoinDestinationEffectPayload = {
      operation_id: move.operation_id,
      source_room_id: move.source_room_id,
      destination_room_id: move.destination_room_id,
      work_attempt_id: move.work_attempt_id,
      execution_generation_id: move.execution_generation_id,
    };
    const idempotencyKey = roomMoveJoinDestinationIdempotencyKey({
      operationId: move.operation_id,
      destinationRoomId: move.destination_room_id,
    });
    let runResult: { effect: EffectRecord; diagnostic: string | null; backedOff: boolean };
    try {
      runResult = await this.runRoomMoveEffect({
        agentId: move.agent_id,
        kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
        idempotencyKey,
        payload,
        dispatch,
      });
    } catch (error) {
      if (error instanceof DaemonFenceLostError) throw error;
      if (error instanceof EffectFenceError) {
        if (this.ports.authority.isHandoffScheduled()) throw error;
        return { kind: "retry", detail: schedulerErrorDetail(error), retryAfterMs: ROOM_MOVE_EFFECT_RETRY_DELAY_MS };
      }
      if (error instanceof EffectClaimRefusedError || error instanceof RoomMoveSettlementStorageError) {
        return { kind: "retry", detail: schedulerErrorDetail(error), retryAfterMs: ROOM_MOVE_EFFECT_RETRY_DELAY_MS };
      }
      throw error;
    }
    const { effect: settled, diagnostic, backedOff } = runResult;
    const detail = diagnostic ?? settled.last_error ?? "destination join did not complete";
    if (settled.state === "completed") {
      const outcome = settled.outcome as { remote_room_id?: unknown } | null;
      const remoteRoomId = typeof outcome?.remote_room_id === "string" ? outcome.remote_room_id.trim() : "";
      if (!remoteRoomId || remoteRoomId === move.source_room_id) {
        return {
          kind: "retry",
          detail: "Destination join response omitted a valid distinct canonical room identity.",
          retryAfterMs: this.retryDelayMsFor(settled),
        };
      }
      return { kind: "completed", remoteRoomId };
    }
    const outcome = settled.outcome as {
      authoritative_rejection?: unknown;
      ambiguous_prior_attempt?: unknown;
    } | null;
    if (settled.state === "failed" && outcome?.authoritative_rejection === true && settled.attempt_count === 1) {
      return { kind: "rejected", detail: diagnostic ?? settled.last_error ?? "authoritative join rejection" };
    }
    if (settled.state === "failed" && outcome?.ambiguous_prior_attempt === true) {
      return { kind: "rollback_required", detail: diagnostic ?? settled.last_error ?? "retry join rejection" };
    }
    return {
      kind: "retry",
      detail,
      retryAfterMs: this.retryDelayMsFor(settled),
      backedOff,
    };
  }

  private async executeRollbackSourceEffect(
    move: DaemonRoomMoveRecord,
    dispatch: RoomMoveDispatchContext,
  ): Promise<{ kind: "completed" } | { kind: "retry"; detail: string; retryAfterMs: number; backedOff?: boolean }> {
    const payload: RoomMoveRollbackSourceEffectPayload = {
      operation_id: move.operation_id,
      source_room_id: move.source_room_id,
      destination_room_id: move.destination_room_id,
      work_attempt_id: move.work_attempt_id,
      execution_generation_id: move.execution_generation_id,
    };
    const idempotencyKey = roomMoveRollbackSourceIdempotencyKey({
      operationId: move.operation_id,
      sourceRoomId: move.source_room_id,
    });
    let runResult: { effect: EffectRecord; diagnostic: string | null; backedOff: boolean };
    try {
      runResult = await this.runRoomMoveEffect({
        agentId: move.agent_id,
        kind: ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND,
        idempotencyKey,
        payload,
        dispatch,
      });
    } catch (error) {
      if (error instanceof DaemonFenceLostError) throw error;
      if (error instanceof EffectFenceError) {
        if (this.ports.authority.isHandoffScheduled()) throw error;
        return { kind: "retry", detail: schedulerErrorDetail(error), retryAfterMs: ROOM_MOVE_EFFECT_RETRY_DELAY_MS };
      }
      if (error instanceof EffectClaimRefusedError || error instanceof RoomMoveSettlementStorageError) {
        return { kind: "retry", detail: schedulerErrorDetail(error), retryAfterMs: ROOM_MOVE_EFFECT_RETRY_DELAY_MS };
      }
      throw error;
    }
    const { effect: settled, diagnostic, backedOff } = runResult;
    if (settled.state === "completed") return { kind: "completed" };
    return {
      kind: "retry",
      detail: diagnostic ?? settled.last_error ?? "source rollback join did not complete",
      retryAfterMs: this.retryDelayMsFor(settled),
      backedOff,
    };
  }

  private async executeBootstrapTailEffect(
    move: DaemonRoomMoveRecord,
    destination: string,
    dispatch: RoomMoveDispatchContext,
  ): Promise<
    | { kind: "completed"; cursor: string | null }
    | { kind: "retry"; detail: string; retryAfterMs: number; backedOff?: boolean }
  > {
    const payload: RoomMoveBootstrapTailEffectPayload = {
      operation_id: move.operation_id,
      destination_room_id: destination,
      work_attempt_id: move.work_attempt_id,
      execution_generation_id: move.execution_generation_id,
    };
    const idempotencyKey = roomMoveBootstrapTailIdempotencyKey({
      operationId: move.operation_id,
      destinationRoomId: destination,
    });
    let runResult: { effect: EffectRecord; diagnostic: string | null; backedOff: boolean };
    try {
      runResult = await this.runRoomMoveEffect({
        agentId: move.agent_id,
        kind: ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND,
        idempotencyKey,
        payload,
        dispatch,
      });
    } catch (error) {
      if (error instanceof DaemonFenceLostError) throw error;
      if (error instanceof EffectFenceError) {
        if (this.ports.authority.isHandoffScheduled()) throw error;
        return { kind: "retry", detail: schedulerErrorDetail(error), retryAfterMs: ROOM_MOVE_EFFECT_RETRY_DELAY_MS };
      }
      if (error instanceof EffectClaimRefusedError || error instanceof RoomMoveSettlementStorageError) {
        return { kind: "retry", detail: schedulerErrorDetail(error), retryAfterMs: ROOM_MOVE_EFFECT_RETRY_DELAY_MS };
      }
      throw error;
    }
    const { effect: settled, diagnostic, backedOff } = runResult;
    if (settled.state !== "completed") {
      return {
        kind: "retry",
        detail: diagnostic ?? settled.last_error ?? "Destination tail bootstrap did not complete.",
        retryAfterMs: this.retryDelayMsFor(settled),
        backedOff,
      };
    }
    const outcome = settled.outcome as { destination_cursor?: unknown } | null;
    return {
      kind: "completed",
      cursor: typeof outcome?.destination_cursor === "string" ? outcome.destination_cursor : null,
    };
  }

  private async assertExternalAuthority(): Promise<void> {
    if (this.ports.authority.isHandoffScheduled()) {
      throw new EffectFenceError("Supervisor handoff fenced a stale room-move effect.");
    }
    await this.ports.authority.assertCurrent();
    if (this.ports.authority.isHandoffScheduled()) {
      throw new EffectFenceError("Supervisor handoff fenced a stale room-move effect.");
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
