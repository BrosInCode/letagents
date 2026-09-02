import type { DaemonActivityEvent, DaemonManifestEntry, DaemonRequest, DesiredState } from "./types.js";
import type { CustodialPollingAuthorizationInput } from "./worker-authority-coordinator.js";
import type { CustodialForwardRequest, DeliveryDrainIdentity, DeliveryDrainRequest, PollingActivationRequest } from "./delivery-cutover-execution-coordinator.js";
import type { createHostApprovalBridge } from "./host-approval-broker.js";

/**
 * The socket router owns protocol parsing and response shaping. Operations are
 * bound by SupervisorDaemon, which remains the authority owner.
 */
export interface DaemonControlOperations {
  hostApprovals: Pick<ReturnType<typeof createHostApprovalBridge>, "challenge" | "verify" | "list" | "decide">;
  activateCustodialPolling(input: PollingActivationRequest): unknown;
  getPollingActivation(input: DeliveryDrainIdentity): unknown;
  cancelPollingActivation(input: DeliveryDrainIdentity): unknown;
  prepareDeliveryDrain(input: DeliveryDrainRequest | CustodialForwardRequest): unknown;
  getDeliveryDrain(input: DeliveryDrainIdentity): unknown;
  cancelDeliveryDrain(input: DeliveryDrainIdentity): unknown;
  status(): unknown;
  prepareHandoff(): unknown;
  listManifest(): unknown;
  watchState(input: { afterDaemonGeneration: number; afterSequence: number; waitMs: number }): unknown;
  watchAgentStream(input: { entryId: string; afterSequence: number; waitMs: number }): unknown;
  retryRoomDelivery(input: RoomDeliveryControl): unknown;
  restoreAgentConversation(input: RoomDeliveryControl): unknown;
  skipRoomDelivery(input: RoomDeliveryControl): unknown;
  getAgentInspectorDetail(entryId: string, roomId: string, sourceMessageId: string | null): unknown;
  prepareBoundedEffect(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string; mcpRequestId: string; toolName: string; input: unknown; mutation: boolean;
  }): unknown;
  executeBoundedTool(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string; mcpRequestId: string; toolName: string; input: unknown;
  }): unknown;
  completeBoundedEffect(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; daemonGeneration: number;
    providerTurnId: string; effectId: string; result: unknown; error?: string;
  }): unknown;
  getAgentConfiguration(entryId: string, daemonGeneration: number): unknown;
  updateAgentConfiguration(input: {
    entryId: string; daemonGeneration: number; expectedRevision: number; configuration: Record<string, unknown>;
  }): unknown;
  applyAgentConfiguration(input: {
    entryId: string; daemonGeneration: number; expectedConfigurationRevision: number;
  }): unknown;
  prepareInspectorRoomMove(input: { entryId: string; destinationRoomId: string; requestId: string; daemonGeneration: number }): unknown;
  commitInspectorRoomMove(input: RoomMoveIdentity): unknown;
  acknowledgeInspectorRoomMoveSourceRevocation(input: RoomMoveIdentity & { sourceAgentSessionId: string }): unknown;
  rollbackInspectorRoomMove(input: RoomMoveIdentity & { detail: string }): unknown;
  getInspectorRoomMove(input: RoomMoveIdentity): unknown;
  getCurrentInspectorRoomMove(input: { entryId: string; daemonGeneration: number }): unknown;
  recoverAgentRuntime(entryId: string, daemonGeneration: number): unknown;
  retireAgent(entryId: string, daemonGeneration: number, revokedAgentSessionId: string | null, grantRevokedWithoutWorkerSession: boolean): unknown;
  purgeAgent(entryId: string, daemonGeneration: number, revokedAgentSessionId: string | null, grantRevokedWithoutWorkerSession: boolean): unknown;
  putManifestEntry(entry: DaemonManifestEntry): unknown;
  setDesiredState(id: string, desiredState: DesiredState): Promise<DaemonManifestEntry>;
  setDisplayName(id: string, displayName: string): Promise<DaemonManifestEntry>;
  entryWithDerivedLiveness(entry: DaemonManifestEntry): unknown;
  compareAndSetDesiredState(id: string, expected: DesiredState, desired: DesiredState): Promise<{ applied: boolean; entry: DaemonManifestEntry }>;
  controlTurn(input: {
    entryId: string; daemonGeneration: number; roomId: string; workAttemptId: string;
    executionGenerationId: string; providerContinuationId: string; providerTurnId: string;
    inboxItemId: string; sourceMessageId: string; actionId: string; actionSequence: number; correction: string | null;
  }): unknown;
  resolveTurnControl(input: {
    entryId: string; workAttemptId: string; executionGenerationId: string; actionId: string; resolution: "not_applied" | "applied";
  }): unknown;
  reserveLegacyLane(input: {
    reservation_id: string; room_id: string; provider: string; owner_pid: number; owner_process_identity: string;
  }): unknown;
  activateLegacyLane(reservationId: string, sessionId: string): unknown;
  releaseLegacyLane(input: {
    reservation_id: string | null; session_id: string | null; room_id: string | null; provider: string | null;
  }): unknown;
  appendActivity(id: string, event: DaemonActivityEvent): unknown;
  updateWorkplaceLiveness(id: string, state: "reachable" | "stale" | "unknown", detail: string | null, observedAt: string): unknown;
  bindWorkerSession(input: WorkerSessionCoordinates & { agent_session_token: string; api_url: string }): unknown;
  verifyWorkerSession(input: WorkerSessionCoordinates & { agent_session_token: string; api_url: string }): unknown;
  installWorkerCredential(input: WorkerSessionCoordinates & { agent_session_token: string; daemon_generation: number }): unknown;
  installHostGrant(input: {
    entry_id: string; room_id: string; agent_key: string; grant_id: string; supervisor_grant: string;
    grant_generation: number; api_url: string; host_id: string; installation_id: string;
    grant_expires_at: string; daemon_generation: number; credential_only: boolean; recovery_only: boolean;
  }): unknown;
  installOpenModelCredential(input: {
    entry_id: string; api_key: string | null; base_url: string; model: string; daemon_generation: number;
  }): unknown;
  bootstrapRoomIngress(input: { entry_id: string; daemon_generation: number; initial_message?: string }): unknown;
  borrowWorkerCredential(input: WorkerSessionCoordinates & { daemon_generation: number; provider_turn_id: string; api_url: string }): unknown;
  authorizeCustodialPolling(input: CustodialPollingAuthorizationInput): unknown;
  checkpointWorkerCursor(input: Omit<WorkerSessionCoordinates, "room_id"> & { room_cursor: string }): unknown;
  readAttempt(id: string): unknown;
}

type RoomDeliveryControl = {
  entryId: string; roomId: string; sourceMessageId: string; workAttemptId: string;
  executionGenerationId: string; agentSessionId: string; daemonGeneration: number;
};

type RoomMoveIdentity = { operationId: string; entryId: string; daemonGeneration: number };

type WorkerSessionCoordinates = {
  entry_id: string; room_id: string; work_attempt_id: string;
  execution_generation_id: string; agent_session_id: string;
};

export interface DaemonControlContext {
  assertCurrent(): Promise<void>;
  currentGeneration(): number;
  isHandoffScheduled(): boolean;
  requestBarrier?: (request: DaemonRequest) => Promise<void>;
}

function paramsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Daemon request params must be an object.");
  return value as Record<string, unknown>;
}

function requiredStringParam(params: Record<string, unknown>, key: string, error: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new Error(error);
  return value;
}

function positiveIntegerParam(params: Record<string, unknown>, key: string, error: string): number {
  const value = params[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(error);
  return value as number;
}

function desiredStateParam(params: Record<string, unknown>, key: string, error: string): DesiredState {
  const value = params[key];
  if (value !== "running" && value !== "paused" && value !== "stopped") throw new Error(error);
  return value;
}

function paramsEntry(value: unknown): DaemonManifestEntry {
  const params = paramsRecord(value);
  const entry = params.entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("manifest.put requires an entry.");
  return entry as DaemonManifestEntry;
}

export function createDaemonControlRequestHandler(
  context: DaemonControlContext,
  operations: DaemonControlOperations,
): (request: DaemonRequest) => Promise<unknown> {
  return async (request) => {
    await context.assertCurrent();
    const isLifecycleRequest = request.method === "daemon.negotiate"
      || request.method === "daemon.status"
      || request.method === "daemon.prepare_handoff"
      || request.method === "manifest.watch_state";
    if (context.isHandoffScheduled() && !isLifecycleRequest) {
      throw new Error("Supervisor handoff has fenced new daemon mutations.");
    }
    await context.requestBarrier?.(request);
    // A request may have been admitted before prepare_handoff and paused in
    // an injected/native barrier. Re-check after that await so it cannot
    // perform provider effects once handoff begins.
    if (context.isHandoffScheduled() && !isLifecycleRequest) {
      throw new Error("Supervisor handoff has fenced new daemon mutations.");
    }
    if (request.method === "daemon.negotiate") return operations.status();
    if (request.method === "daemon.status") return operations.status();
    if (request.method === "daemon.prepare_handoff") {
      await operations.prepareHandoff();
      return { accepted: true, generation: context.currentGeneration() };
    }
    if (request.method === "manifest.list") return operations.listManifest();
    if (request.method === "supervisor.host_approval_challenge") return operations.hostApprovals.challenge();
    if (request.method === "supervisor.host_approval_request") {
      const authenticated = operations.hostApprovals.verify(request.params);
      if (!authenticated) throw new Error("Host approvals are unavailable or this request could not be authenticated.");
      const input = authenticated.input as Record<string, unknown> | null;
      if (authenticated.operation === "list") {
        if (!input || Object.keys(input).length !== 1 || typeof input.roomId !== "string") throw new Error("An exact approval room is required.");
        return operations.hostApprovals.list(input.roomId);
      }
      if (input?.actorId !== `host-${operations.hostApprovals.challenge()!.keyFingerprint}`) throw new Error("The approval actor is not the enrolled host.");
      return operations.hostApprovals.decide(input);
    }
    if (request.method === "supervisor.activate_custodial_polling"
      || request.method === "supervisor.get_polling_activation"
      || request.method === "supervisor.cancel_polling_activation") {
      const params = paramsRecord(request.params);
      const error = "Polling activation requires exact typed coordinates and the current daemon generation.";
      if (positiveIntegerParam(params, "daemon_generation", error) !== context.currentGeneration()) throw new Error(error);
      const identity = {
        entryId: requiredStringParam(params, "entry_id", error),
        operationId: requiredStringParam(params, "operation_id", error),
      };
      if (request.method === "supervisor.get_polling_activation") return operations.getPollingActivation(identity);
      if (request.method === "supervisor.cancel_polling_activation") return operations.cancelPollingActivation(identity);
      return operations.activateCustodialPolling({ ...identity,
        requestId: requiredStringParam(params, "request_id", error),
        roomId: requiredStringParam(params, "room_id", error),
        executionGenerationId: requiredStringParam(params, "execution_generation_id", error),
        reverseOperationId: requiredStringParam(params, "reverse_operation_id", error),
      });
    }
    if (request.method === "supervisor.prepare_delivery_drain"
      || request.method === "supervisor.prepare_custodial_forward"
      || request.method === "supervisor.get_delivery_drain"
      || request.method === "supervisor.cancel_delivery_drain") {
      const params = paramsRecord(request.params);
      const error = "Delivery drain requires exact typed coordinates and the current daemon generation.";
      if (positiveIntegerParam(params, "daemon_generation", error) !== context.currentGeneration()) throw new Error(error);
      const identity = {
        entryId: requiredStringParam(params, "entry_id", error),
        operationId: requiredStringParam(params, "operation_id", error),
      };
      if (request.method === "supervisor.get_delivery_drain") return operations.getDeliveryDrain(identity);
      if (request.method === "supervisor.cancel_delivery_drain") return operations.cancelDeliveryDrain(identity);
      const coordinates = { ...identity,
        requestId: requiredStringParam(params, "request_id", error),
        roomId: requiredStringParam(params, "room_id", error),
        executionGenerationId: requiredStringParam(params, "execution_generation_id", error),
      };
      return request.method === "supervisor.prepare_custodial_forward"
        ? operations.prepareDeliveryDrain({ ...coordinates, reverseOperationId: requiredStringParam(params, "reverse_operation_id", error) })
        : operations.prepareDeliveryDrain(coordinates);
    }
    if (request.method === "manifest.watch_state") {
      const params = paramsRecord(request.params);
      return operations.watchState({
        afterDaemonGeneration: Number(params.after_daemon_generation ?? 0),
        afterSequence: Number(params.after_sequence ?? 0),
        waitMs: Number(params.wait_ms ?? 25_000),
      });
    }
    if (request.method === "supervisor.watch_agent_stream") {
      const params = paramsRecord(request.params);
      return operations.watchAgentStream({
        entryId: String(params.entry_id ?? ""),
        afterSequence: Number(params.after_sequence ?? 0),
        waitMs: Number(params.wait_ms ?? 25_000),
      });
    }
    if (request.method === "supervisor.retry_room_delivery") {
      const params = paramsRecord(request.params);
      await operations.retryRoomDelivery({
        entryId: String(params.entry_id ?? ""),
        roomId: String(params.room_id ?? ""),
        sourceMessageId: String(params.source_message_id ?? ""),
        workAttemptId: String(params.work_attempt_id ?? ""),
        executionGenerationId: String(params.execution_generation_id ?? ""),
        agentSessionId: String(params.agent_session_id ?? ""),
        daemonGeneration: Number(params.daemon_generation ?? NaN),
      });
      return { accepted: true };
    }
    if (request.method === "supervisor.restore_agent_conversation") {
      const params = paramsRecord(request.params);
      await operations.restoreAgentConversation({
        entryId: String(params.entry_id ?? ""),
        roomId: String(params.room_id ?? ""),
        sourceMessageId: String(params.source_message_id ?? ""),
        workAttemptId: String(params.work_attempt_id ?? ""),
        executionGenerationId: String(params.execution_generation_id ?? ""),
        agentSessionId: String(params.agent_session_id ?? ""),
        daemonGeneration: Number(params.daemon_generation ?? NaN),
      });
      return { accepted: true };
    }
    if (request.method === "supervisor.skip_room_delivery") {
      const params = paramsRecord(request.params);
      await operations.skipRoomDelivery({
        entryId: String(params.entry_id ?? ""),
        roomId: String(params.room_id ?? ""),
        sourceMessageId: String(params.source_message_id ?? ""),
        workAttemptId: String(params.work_attempt_id ?? ""),
        executionGenerationId: String(params.execution_generation_id ?? ""),
        agentSessionId: String(params.agent_session_id ?? ""),
        daemonGeneration: Number(params.daemon_generation ?? NaN),
      });
      return { accepted: true };
    }
    if (request.method === "supervisor.get_agent_inspector_detail") {
      const params = paramsRecord(request.params);
      const entryId = params.entry_id;
      const roomId = params.room_id;
      const sourceMessageId = params.source_message_id;
      if (typeof entryId !== "string" || typeof roomId !== "string"
        || !Object.hasOwn(params, "source_message_id")
        || !(sourceMessageId === null || typeof sourceMessageId === "string")) {
        throw new Error("Agent inspector detail requires string entry_id, string room_id, and source_message_id as string or null.");
      }
      return operations.getAgentInspectorDetail(entryId, roomId, sourceMessageId);
    }
    if (request.method === "supervisor.prepare_bounded_effect") {
      const params = paramsRecord(request.params);
      return operations.prepareBoundedEffect({
        entryId: String(params.entry_id ?? ""), workAttemptId: String(params.work_attempt_id ?? ""),
        executionGenerationId: String(params.execution_generation_id ?? ""), daemonGeneration: Number(params.daemon_generation ?? NaN),
        providerTurnId: String(params.provider_turn_id ?? ""),
        mcpRequestId: String(params.mcp_request_id ?? ""), toolName: String(params.tool_name ?? ""),
        input: params.input, mutation: params.mutation === true,
      });
    }
    if (request.method === "supervisor.execute_bounded_tool") {
      const params = paramsRecord(request.params);
      const error = "Supervised tool execution requires exact typed coordinates.";
      return operations.executeBoundedTool({
        entryId: requiredStringParam(params, "entry_id", error),
        workAttemptId: requiredStringParam(params, "work_attempt_id", error),
        executionGenerationId: requiredStringParam(params, "execution_generation_id", error),
        daemonGeneration: positiveIntegerParam(params, "daemon_generation", error),
        providerTurnId: typeof params.provider_turn_id === "string" ? params.provider_turn_id : "",
        mcpRequestId: requiredStringParam(params, "mcp_request_id", error),
        toolName: requiredStringParam(params, "tool_name", error),
        input: params.input,
      });
    }
    if (request.method === "supervisor.complete_bounded_effect") {
      const params = paramsRecord(request.params);
      return operations.completeBoundedEffect({
        entryId: String(params.entry_id ?? ""), workAttemptId: String(params.work_attempt_id ?? ""),
        executionGenerationId: String(params.execution_generation_id ?? ""), daemonGeneration: Number(params.daemon_generation ?? NaN),
        providerTurnId: String(params.provider_turn_id ?? ""),
        effectId: String(params.effect_id ?? ""), result: params.result,
        error: typeof params.error === "string" ? params.error : undefined,
      });
    }
    if (request.method === "supervisor.get_agent_configuration") {
      const params = paramsRecord(request.params);
      return operations.getAgentConfiguration(
        requiredStringParam(params, "entry_id", "Agent configuration requires exact typed coordinates."),
        positiveIntegerParam(params, "daemon_generation", "Agent configuration requires exact typed coordinates."),
      );
    }
    if (request.method === "supervisor.update_agent_configuration") {
      const params = paramsRecord(request.params);
      if (params.configuration === null || typeof params.configuration !== "object" || Array.isArray(params.configuration)) throw new Error("Agent configuration update requires exact typed coordinates.");
      return operations.updateAgentConfiguration({
        entryId: requiredStringParam(params, "entry_id", "Agent configuration update requires exact typed coordinates."),
        daemonGeneration: positiveIntegerParam(params, "daemon_generation", "Agent configuration update requires exact typed coordinates."),
        expectedRevision: positiveIntegerParam(params, "expected_revision", "Agent configuration update requires exact typed coordinates."),
        configuration: paramsRecord(params.configuration),
      });
    }
    if (request.method === "supervisor.apply_agent_configuration") {
      const params = paramsRecord(request.params);
      const error = "Agent configuration apply requires exact typed coordinates.";
      return operations.applyAgentConfiguration({
        entryId: requiredStringParam(params, "entry_id", error),
        daemonGeneration: positiveIntegerParam(params, "daemon_generation", error),
        expectedConfigurationRevision: positiveIntegerParam(
          params,
          "expected_configuration_revision",
          error,
        ),
      });
    }
    if (request.method === "supervisor.prepare_room_move") {
      const params = paramsRecord(request.params);
      const error = "Room-move preparation requires exact typed coordinates.";
      return operations.prepareInspectorRoomMove({
        entryId: requiredStringParam(params, "entry_id", error),
        destinationRoomId: requiredStringParam(params, "destination_room_id", error),
        requestId: requiredStringParam(params, "request_id", error),
        daemonGeneration: positiveIntegerParam(params, "daemon_generation", error),
      });
    }
    if (request.method === "supervisor.commit_room_move") {
      const params = paramsRecord(request.params);
      const error = "Room-move commit requires exact typed coordinates.";
      return operations.commitInspectorRoomMove({
        operationId: requiredStringParam(params, "operation_id", error),
        entryId: requiredStringParam(params, "entry_id", error),
        daemonGeneration: positiveIntegerParam(params, "daemon_generation", error),
      });
    }
    if (request.method === "supervisor.acknowledge_room_move_source_revocation") {
      const params = paramsRecord(request.params);
      const error = "Room-move credential acknowledgement requires exact typed coordinates.";
      return operations.acknowledgeInspectorRoomMoveSourceRevocation({
        operationId: requiredStringParam(params, "operation_id", error),
        entryId: requiredStringParam(params, "entry_id", error),
        sourceAgentSessionId: requiredStringParam(params, "source_agent_session_id", error),
        daemonGeneration: positiveIntegerParam(params, "daemon_generation", error),
      });
    }
    if (request.method === "supervisor.rollback_room_move") {
      const params = paramsRecord(request.params);
      const error = "Room-move rollback requires exact typed coordinates.";
      return operations.rollbackInspectorRoomMove({
        operationId: requiredStringParam(params, "operation_id", error),
        entryId: requiredStringParam(params, "entry_id", error),
        detail: requiredStringParam(params, "error", error),
        daemonGeneration: positiveIntegerParam(params, "daemon_generation", error),
      });
    }
    if (request.method === "supervisor.get_room_move") {
      const params = paramsRecord(request.params);
      const error = "Room-move status requires exact typed coordinates.";
      return operations.getInspectorRoomMove({
        operationId: requiredStringParam(params, "operation_id", error),
        entryId: requiredStringParam(params, "entry_id", error),
        daemonGeneration: positiveIntegerParam(params, "daemon_generation", error),
      });
    }
    if (request.method === "supervisor.get_current_room_move") {
      const params = paramsRecord(request.params);
      const error = "Current room-move discovery requires exact typed coordinates.";
      return operations.getCurrentInspectorRoomMove({
        entryId: requiredStringParam(params, "entry_id", error),
        daemonGeneration: positiveIntegerParam(params, "daemon_generation", error),
      });
    }
    if (request.method === "supervisor.recover_agent_runtime") {
      const params = paramsRecord(request.params);
      const error = "Agent runtime recovery requires exact typed coordinates.";
      return operations.recoverAgentRuntime(
        requiredStringParam(params, "entry_id", error),
        positiveIntegerParam(params, "daemon_generation", error),
      );
    }
    if (request.method === "supervisor.retire_agent") {
      const params = paramsRecord(request.params);
      const error = "Retire requires exact typed coordinates.";
      if (!(params.revoked_agent_session_id === undefined || params.revoked_agent_session_id === null
        || (typeof params.revoked_agent_session_id === "string" && params.revoked_agent_session_id.trim()
          && params.revoked_agent_session_id === params.revoked_agent_session_id.trim()))) throw new Error(error);
      if (!(params.grant_revoked_without_worker_session === undefined || params.grant_revoked_without_worker_session === false
        || params.grant_revoked_without_worker_session === true)
        || (typeof params.revoked_agent_session_id === "string" && params.grant_revoked_without_worker_session === true)) {
        throw new Error(error);
      }
      return operations.retireAgent(
        requiredStringParam(params, "entry_id", error),
        positiveIntegerParam(params, "daemon_generation", error),
        typeof params.revoked_agent_session_id === "string" ? params.revoked_agent_session_id : null,
        params.grant_revoked_without_worker_session === true,
      );
    }
    if (request.method === "supervisor.purge_agent") {
      const params = paramsRecord(request.params);
      const error = "Purge requires exact typed coordinates.";
      if (!(params.revoked_agent_session_id === undefined || params.revoked_agent_session_id === null
        || (typeof params.revoked_agent_session_id === "string" && params.revoked_agent_session_id.trim()
          && params.revoked_agent_session_id === params.revoked_agent_session_id.trim()))) throw new Error(error);
      if (!(params.grant_revoked_without_worker_session === undefined || params.grant_revoked_without_worker_session === false
        || params.grant_revoked_without_worker_session === true)
        || (typeof params.revoked_agent_session_id === "string" && params.grant_revoked_without_worker_session === true)) {
        throw new Error(error);
      }
      return operations.purgeAgent(
        requiredStringParam(params, "entry_id", error),
        positiveIntegerParam(params, "daemon_generation", error),
        typeof params.revoked_agent_session_id === "string" ? params.revoked_agent_session_id : null,
        params.grant_revoked_without_worker_session === true,
      );
    }
    if (request.method === "manifest.put") return operations.putManifestEntry(paramsEntry(request.params));
    if (request.method === "manifest.set_desired_state") {
      const params = paramsRecord(request.params);
      const error = "Agent lifecycle requires an exact identity and desired state.";
      const updated = await operations.setDesiredState(
        requiredStringParam(params, "id", error),
        desiredStateParam(params, "desired_state", error),
      );
      return operations.entryWithDerivedLiveness(updated);
    }
    if (request.method === "manifest.set_display_name") {
      const params = paramsRecord(request.params);
      const error = "Agent naming requires an exact identity and display name.";
      const updated = await operations.setDisplayName(
        requiredStringParam(params, "id", error),
        requiredStringParam(params, "display_name", error),
      );
      return operations.entryWithDerivedLiveness(updated);
    }
    if (request.method === "manifest.compare_and_set_desired_state") {
      const params = paramsRecord(request.params);
      const error = "Agent lifecycle compare-and-set requires exact typed fields.";
      const result = await operations.compareAndSetDesiredState(
        requiredStringParam(params, "id", error),
        desiredStateParam(params, "expected_desired_state", error),
        desiredStateParam(params, "desired_state", error),
      );
      return { applied: result.applied, entry: await operations.entryWithDerivedLiveness(result.entry) };
    }
    if (request.method === "manifest.control_turn") {
      const params = paramsRecord(request.params);
      return operations.controlTurn({
        entryId: String(params.id ?? ""),
        daemonGeneration: Number(params.daemon_generation ?? 0),
        roomId: String(params.room_id ?? ""),
        workAttemptId: String(params.work_attempt_id ?? ""),
        executionGenerationId: String(params.execution_generation_id ?? ""),
        providerContinuationId: String(params.provider_continuation_id ?? ""),
        providerTurnId: String(params.provider_turn_id ?? ""),
        inboxItemId: String(params.inbox_item_id ?? ""),
        sourceMessageId: String(params.source_message_id ?? ""),
        actionId: String(params.action_id ?? ""),
        actionSequence: Number(params.action_sequence ?? 0),
        correction: typeof params.correction === "string" ? params.correction : null,
      });
    }
    if (request.method === "manifest.resolve_turn_control") {
      const params = paramsRecord(request.params);
      return operations.resolveTurnControl({
        entryId: String(params.id ?? ""),
        workAttemptId: String(params.work_attempt_id ?? ""),
        executionGenerationId: String(params.execution_generation_id ?? ""),
        actionId: String(params.action_id ?? ""),
        resolution: String(params.resolution ?? "") as "not_applied" | "applied",
      });
    }
    if (request.method === "lane.reserve_legacy") {
      const params = paramsRecord(request.params);
      return operations.reserveLegacyLane({
        reservation_id: String(params.reservation_id ?? ""),
        room_id: String(params.room_id ?? ""),
        provider: String(params.provider ?? ""),
        owner_pid: Number(params.owner_pid ?? 0),
        owner_process_identity: String(params.owner_process_identity ?? ""),
      });
    }
    if (request.method === "lane.activate_legacy") {
      const params = paramsRecord(request.params);
      return operations.activateLegacyLane(String(params.reservation_id ?? ""), String(params.session_id ?? ""));
    }
    if (request.method === "lane.release_legacy") {
      const params = paramsRecord(request.params);
      return operations.releaseLegacyLane({
        reservation_id: typeof params.reservation_id === "string" ? params.reservation_id : null,
        session_id: typeof params.session_id === "string" ? params.session_id : null,
        room_id: typeof params.room_id === "string" ? params.room_id : null,
        provider: typeof params.provider === "string" ? params.provider : null,
      });
    }
    if (request.method === "manifest.append_activity") {
      const params = paramsRecord(request.params);
      return operations.appendActivity(String(params.id ?? ""), params.event as DaemonActivityEvent);
    }
    if (request.method === "manifest.update_workplace_liveness") {
      const params = paramsRecord(request.params);
      return operations.updateWorkplaceLiveness(
        String(params.id ?? ""),
        String(params.state ?? "unknown") as "reachable" | "stale" | "unknown",
        typeof params.detail === "string" ? params.detail : null,
        typeof params.observed_at === "string" ? params.observed_at : new Date().toISOString(),
      );
    }
    if (request.method === "supervisor.bind_worker_session") {
      const params = paramsRecord(request.params);
      return operations.bindWorkerSession({
        entry_id: String(params.entry_id ?? ""),
        room_id: String(params.room_id ?? ""),
        work_attempt_id: String(params.work_attempt_id ?? ""),
        execution_generation_id: String(params.execution_generation_id ?? ""),
        agent_session_id: String(params.agent_session_id ?? ""),
        agent_session_token: String(params.agent_session_token ?? ""),
        api_url: String(params.api_url ?? ""),
      });
    }
    if (request.method === "supervisor.verify_worker_session") {
      const params = paramsRecord(request.params);
      return operations.verifyWorkerSession({
        entry_id: String(params.entry_id ?? ""),
        room_id: String(params.room_id ?? ""),
        work_attempt_id: String(params.work_attempt_id ?? ""),
        execution_generation_id: String(params.execution_generation_id ?? ""),
        agent_session_id: String(params.agent_session_id ?? ""),
        agent_session_token: String(params.agent_session_token ?? ""),
        api_url: String(params.api_url ?? ""),
      });
    }
    if (request.method === "supervisor.install_worker_credential") {
      const params = paramsRecord(request.params);
      return operations.installWorkerCredential({
        entry_id: String(params.entry_id ?? ""), room_id: String(params.room_id ?? ""),
        work_attempt_id: String(params.work_attempt_id ?? ""), execution_generation_id: String(params.execution_generation_id ?? ""),
        agent_session_id: String(params.agent_session_id ?? ""), agent_session_token: String(params.agent_session_token ?? ""),
        daemon_generation: Number(params.daemon_generation ?? 0),
      });
    }
    if (request.method === "supervisor.install_host_grant") {
      const params = paramsRecord(request.params);
      return operations.installHostGrant({
        entry_id: String(params.entry_id ?? ""), room_id: String(params.room_id ?? ""), agent_key: String(params.agent_key ?? ""),
        grant_id: String(params.grant_id ?? ""), supervisor_grant: String(params.supervisor_grant ?? ""),
        grant_generation: Number(params.grant_generation ?? NaN), api_url: String(params.api_url ?? ""),
        host_id: String(params.host_id ?? ""), installation_id: String(params.installation_id ?? ""),
        grant_expires_at: String(params.grant_expires_at ?? ""),
        daemon_generation: Number(params.daemon_generation ?? NaN),
        credential_only: params.credential_only === true,
        recovery_only: params.recovery_only === true,
      });
    }
    if (request.method === "supervisor.install_open_model_credential") {
      const params = paramsRecord(request.params);
      return operations.installOpenModelCredential({
        entry_id: String(params.entry_id ?? ""),
        api_key: params.api_key === null ? null : String(params.api_key ?? ""),
        base_url: String(params.base_url ?? ""),
        model: String(params.model ?? ""),
        daemon_generation: Number(params.daemon_generation ?? NaN),
      });
    }
    if (request.method === "supervisor.bootstrap_room_ingress") {
      const params = paramsRecord(request.params);
      return operations.bootstrapRoomIngress({
        entry_id: String(params.entry_id ?? ""),
        daemon_generation: Number(params.daemon_generation ?? NaN),
        ...(typeof params.initial_message === "string" ? { initial_message: params.initial_message } : {}),
      });
    }
    if (request.method === "supervisor.borrow_worker_credential") {
      const params = paramsRecord(request.params);
      return operations.borrowWorkerCredential({
        entry_id: String(params.entry_id ?? ""), room_id: String(params.room_id ?? ""),
        work_attempt_id: String(params.work_attempt_id ?? ""), execution_generation_id: String(params.execution_generation_id ?? ""),
        agent_session_id: String(params.agent_session_id ?? ""), daemon_generation: Number(params.daemon_generation ?? 0),
        provider_turn_id: String(params.provider_turn_id ?? ""),
        api_url: String(params.api_url ?? ""),
      });
    }
    if (request.method === "supervisor.authorize_custodial_polling") {
      const params = paramsRecord(request.params);
      if (params.room_cursor !== undefined && params.room_cursor !== null && typeof params.room_cursor !== "string") {
        throw new Error("Custodial polling cursor must be a string or null.");
      }
      return operations.authorizeCustodialPolling({
        entry_id: String(params.entry_id ?? ""), room_id: String(params.room_id ?? ""),
        work_attempt_id: String(params.work_attempt_id ?? ""), execution_generation_id: String(params.execution_generation_id ?? ""),
        agent_session_id: String(params.agent_session_id ?? ""), daemon_generation: Number(params.daemon_generation ?? NaN),
        api_url: String(params.api_url ?? ""), contract: String(params.contract ?? ""),
        phase: String(params.phase ?? ""), tool_name: String(params.tool_name ?? ""),
        expected_configuration_revision: Number(params.expected_configuration_revision ?? NaN),
        process_incarnation_id: typeof params.process_incarnation_id === "string" ? params.process_incarnation_id : undefined,
        // JSON-RPC numeric and string request IDs belong to different invocations.
        mcp_request_id: typeof params.mcp_request_id === "string" || typeof params.mcp_request_id === "number" ? params.mcp_request_id : undefined,
        room_cursor: params.room_cursor as string | null | undefined,
        expected_activation_id: typeof params.expected_activation_id === "string" ? params.expected_activation_id : undefined,
        expected_binding_epoch: typeof params.expected_binding_epoch === "number" ? params.expected_binding_epoch : undefined,
        input_cursor: typeof params.input_cursor === "string" ? params.input_cursor : undefined,
        offered_frontier: typeof params.offered_frontier === "string" ? params.offered_frontier : undefined,
      });
    }
    if (request.method === "supervisor.checkpoint_worker_cursor") {
      const params = paramsRecord(request.params);
      return operations.checkpointWorkerCursor({
        entry_id: String(params.entry_id ?? ""),
        work_attempt_id: String(params.work_attempt_id ?? ""),
        execution_generation_id: String(params.execution_generation_id ?? ""),
        agent_session_id: String(params.agent_session_id ?? ""),
        room_cursor: String(params.room_cursor ?? ""),
      });
    }
    if (request.method === "attempt.read") return operations.readAttempt(String(paramsRecord(request.params).id ?? ""));
    throw new Error(`Unsupported daemon method: ${request.method}`);
  };
}
