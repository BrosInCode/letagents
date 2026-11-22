import {
  DAEMON_RPC_TIMEOUTS,
  HANDOFF_DRAIN_METHODS,
  HANDOFF_LIFECYCLE_METHODS,
  hostApprovalOperationSchemas,
  isDaemonRpcMethod,
  parseDaemonRpcParams,
  type DaemonManifestEntry,
  type DaemonRequest,
  type DaemonRpcMethod,
  type DaemonRpcParsedParams,
  type DesiredState,
  type ManifestActivityMode,
} from "#daemon-contract/index.js";
import type { createHostApprovalBridge } from "./host-approval-broker.js";

export type { ManifestActivityMode };

/**
 * The socket router owns protocol dispatch derived from the shared RPC
 * contract (`#daemon-contract/index.js`). Parameter validation, framing bounds,
 * and handoff admission sets come directly from the contract; operations are
 * bound by SupervisorDaemon, which remains the authority owner.
 */
export interface DaemonControlOperations {
  mutateLocalBoard(input: unknown): Promise<unknown>;
  watchLocalBoard(input: unknown, signal: AbortSignal): Promise<unknown>;
  hostApprovals: Pick<ReturnType<typeof createHostApprovalBridge>, "challenge" | "verify" | "list" | "decide" | "listToolRules" | "revokeToolRule">;
  status(): unknown;
  prepareHandoff(): unknown;
  /**
   * Null lists every entry; a room identifier scopes the read to that room.
   * `"full"` keeps each entry's whole activity history; `"summary"` keeps the
   * newest events without payloads, as the state watch publishes them.
   */
  listManifest(roomId: string | null, activity: ManifestActivityMode): unknown;
  /** One entry as listManifest reads it in full mode, or null when no such entry exists. */
  getManifestEntry(entryId: string): unknown;
  watchState(input: { afterDaemonGeneration: number; afterSequence: number; waitMs: number; changedOnly?: boolean }): unknown;
  watchAgentStream(input: { entryId: string; afterSequence: number; waitMs: number }): unknown;
  /** The newest values of an agent's background commands (the room's activity strip reads these). */
  watchBackgroundCommands(input: { entryId: string; afterVersion: number; waitMs: number }): unknown;
  /** Only the desktop app's signed request reaches this. */
  stopBackgroundCommand(input: { entryId: string; daemonGeneration: number; taskId: string }): unknown;
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
    /** Only the desktop app's signed request may carry this. */
    homeHarness?: boolean;
  }): unknown;
  applyAgentConfiguration(input: {
    entryId: string; daemonGeneration: number; expectedConfigurationRevision: number;
  }): unknown;
  submitApplyAgentConfiguration(input: {
    entryId: string; daemonGeneration: number; expectedConfigurationRevision: number;
  }): unknown;
  /** Only the desktop app's signed request reaches this. */
  setLiveSharing(input: { entryId: string; daemonGeneration: number; enabled: boolean }): unknown;
  prepareInspectorRoomMove(input: { entryId: string; destinationRoomId: string; requestId: string; daemonGeneration: number }): unknown;
  commitInspectorRoomMove(input: RoomMoveIdentity): unknown;
  acknowledgeInspectorRoomMoveSourceRevocation(input: RoomMoveIdentity & { sourceAgentSessionId: string }): unknown;
  rollbackInspectorRoomMove(input: RoomMoveIdentity & { detail: string }): unknown;
  getInspectorRoomMove(input: RoomMoveIdentity): unknown;
  getCurrentInspectorRoomMove(input: { entryId: string; daemonGeneration: number }): unknown;
  recoverAgentRuntime(entryId: string, daemonGeneration: number, recovery?: import("./runtime-recovery-coordinator.js").AgentRuntimeRecoveryRequest): unknown;
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
  updateWorkplaceLiveness(id: string, state: "reachable" | "stale" | "unknown", detail: string | null, observedAt: string): unknown;
  bindWorkerSession(input: WorkerSessionCoordinates & { agent_session_token: string; api_url: string }): unknown;
  verifyWorkerSession(input: WorkerSessionCoordinates & { agent_session_token: string; api_url: string }): unknown;
  installWorkerCredential(input: WorkerSessionCoordinates & { agent_session_token: string; daemon_generation: number }): unknown;
  installHostGrant(input: {
    entry_id: string; room_id: string; agent_key: string; grant_id: string; supervisor_grant: string;
    grant_generation: number; api_url: string; host_id: string; installation_id: string;
    owner_account_id: string | null; scope_key: string | null;
    grant_expires_at: string; daemon_generation: number; credential_only: boolean; recovery_only: boolean;
  }): unknown;
  syncExecutionDelegations(input: { room_id: string; daemon_generation: number }): unknown;
  installOpenModelCredential(input: {
    entry_id: string; api_key: string | null; base_url: string; model: string; context_window?: number; daemon_generation: number;
  }): unknown;
  bootstrapRoomIngress(input: { entry_id: string; daemon_generation: number; initial_message?: string }): unknown;
  borrowWorkerCredential(input: WorkerSessionCoordinates & { daemon_generation: number; provider_turn_id: string; api_url: string }): unknown;
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
  isHandoffDraining?(): boolean;
  requestBarrier?: (request: DaemonRequest) => Promise<void>;
}

type DaemonRpcHandlerTable = {
  [M in DaemonRpcMethod]: (
    params: DaemonRpcParsedParams<M>,
    disconnected?: AbortSignal,
  ) => Promise<unknown> | unknown;
};

function parseSignedHostOperation<
  K extends "list" | "set_home_harness" | "set_live_sharing" | "stop_background_command",
>(operation: K, input: unknown): import("zod").output<(typeof hostApprovalOperationSchemas)[K]["input"]> {
  const spec = hostApprovalOperationSchemas[operation];
  const parsed = spec.input.safeParse(input);
  if (!parsed.success) throw new Error(spec.invalidInputMessage);
  return parsed.data as import("zod").output<(typeof hostApprovalOperationSchemas)[K]["input"]>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toRoomDeliveryControl(
  params: DaemonRpcParsedParams<"supervisor.retry_room_delivery">,
): RoomDeliveryControl {
  return {
    entryId: params.entry_id,
    roomId: params.room_id,
    sourceMessageId: params.source_message_id,
    workAttemptId: params.work_attempt_id,
    executionGenerationId: params.execution_generation_id,
    agentSessionId: params.agent_session_id,
    daemonGeneration: params.daemon_generation,
  };
}

export function createDaemonControlRequestHandler(
  context: DaemonControlContext,
  operations: DaemonControlOperations,
): (request: DaemonRequest, disconnected?: AbortSignal) => Promise<unknown> {
  const handlers: DaemonRpcHandlerTable = {
    "daemon.negotiate": () => operations.status(),
    "daemon.status": () => operations.status(),
    "daemon.prepare_handoff": async () => {
      await operations.prepareHandoff();
      return { accepted: true, generation: context.currentGeneration() };
    },
    "manifest.list": (params) => operations.listManifest(
      params?.room_id ?? null,
      params?.activity ?? "full",
    ),
    "manifest.get_entry": (params) => operations.getManifestEntry(params.entry_id),
    "local_board.mutate": (params) => operations.mutateLocalBoard(params),
    "local_board.watch": async (params, disconnected) => {
      if (!disconnected) throw new Error("A board subscription requires a live connection.");
      const result = await operations.watchLocalBoard(params, disconnected);
      await context.assertCurrent();
      if (context.isHandoffScheduled()) throw new Error("The board service is restarting.");
      return result;
    },
    "supervisor.host_approval_challenge": () => operations.hostApprovals.challenge(),
    "supervisor.host_approval_request": async (params) => {
      const authenticated = operations.hostApprovals.verify(params);
      if (!authenticated) throw new Error("Host approvals are unavailable or this request could not be authenticated.");
      if (authenticated.operation === "list") {
        const input = parseSignedHostOperation("list", authenticated.input);
        return operations.hostApprovals.list(input.roomId);
      }
      if (authenticated.operation === "list_tool_rules") {
        return operations.hostApprovals.listToolRules(authenticated.input);
      }
      if (authenticated.operation === "revoke_tool_rule") {
        return operations.hostApprovals.revokeToolRule(authenticated.input);
      }
      if (authenticated.operation === "set_home_harness") {
        if (context.isHandoffDraining?.()) {
          throw new Error("An update is waiting for current agent work to finish. Try this action after the update completes or is deferred.");
        }
        const input = parseSignedHostOperation("set_home_harness", authenticated.input);
        const result = asRecord(await operations.updateAgentConfiguration({
          entryId: input.entryId,
          daemonGeneration: input.daemonGeneration,
          expectedRevision: input.expectedRevision,
          configuration: {},
          homeHarness: input.enabled,
        }));
        const saved = asRecord(result?.configuration);
        if (input.enabled || result?.outcome !== "updated" || saved?.home_harness_pending !== true) return result;
        let apply: Record<string, unknown> | null = null;
        try {
          apply = asRecord(await operations.applyAgentConfiguration({
            entryId: input.entryId,
            daemonGeneration: input.daemonGeneration,
            expectedConfigurationRevision: saved.config_revision as number,
          }));
        } catch {
          // The choice is saved. A restart that failed is reported as not done.
        }
        return { ...result, apply: typeof apply?.outcome === "string" ? apply.outcome : "unavailable" };
      }
      if (authenticated.operation === "set_live_sharing") {
        const input = parseSignedHostOperation("set_live_sharing", authenticated.input);
        return operations.setLiveSharing(input);
      }
      if (authenticated.operation === "stop_background_command") {
        const input = parseSignedHostOperation("stop_background_command", authenticated.input);
        return operations.stopBackgroundCommand(input);
      }
      const input = asRecord(authenticated.input);
      if (input?.actorId !== `host-${operations.hostApprovals.challenge()!.keyFingerprint}`) {
        throw new Error("The approval actor is not the enrolled host.");
      }
      return operations.hostApprovals.decide(authenticated.input);
    },
    "manifest.watch_state": (params) => operations.watchState({
      afterDaemonGeneration: params.after_daemon_generation ?? 0,
      afterSequence: params.after_sequence ?? 0,
      waitMs: params.wait_ms ?? DAEMON_RPC_TIMEOUTS.longPollDefaultWaitMs,
      changedOnly: params.changed_only === true,
    }),
    "supervisor.watch_agent_stream": (params) => operations.watchAgentStream({
      entryId: params.entry_id,
      afterSequence: params.after_sequence ?? 0,
      waitMs: params.wait_ms ?? DAEMON_RPC_TIMEOUTS.longPollDefaultWaitMs,
    }),
    "supervisor.watch_background_commands": (params) => operations.watchBackgroundCommands({
      entryId: params.entry_id,
      afterVersion: params.after_version ?? 0,
      waitMs: params.wait_ms ?? DAEMON_RPC_TIMEOUTS.longPollDefaultWaitMs,
    }),
    "supervisor.retry_room_delivery": async (params) => {
      await operations.retryRoomDelivery(toRoomDeliveryControl(params));
      return { accepted: true };
    },
    "supervisor.restore_agent_conversation": async (params) => {
      await operations.restoreAgentConversation(toRoomDeliveryControl(params));
      return { accepted: true };
    },
    "supervisor.skip_room_delivery": async (params) => {
      await operations.skipRoomDelivery(toRoomDeliveryControl(params));
      return { accepted: true };
    },
    "supervisor.get_agent_inspector_detail": (params) => operations.getAgentInspectorDetail(
      params.entry_id,
      params.room_id,
      params.source_message_id,
    ),
    "supervisor.prepare_bounded_effect": (params) => operations.prepareBoundedEffect({
      entryId: params.entry_id,
      workAttemptId: params.work_attempt_id,
      executionGenerationId: params.execution_generation_id,
      daemonGeneration: params.daemon_generation,
      providerTurnId: params.provider_turn_id ?? "",
      mcpRequestId: params.mcp_request_id,
      toolName: params.tool_name,
      input: params.input,
      mutation: params.mutation === true,
    }),
    "supervisor.execute_bounded_tool": (params) => operations.executeBoundedTool({
      entryId: params.entry_id,
      workAttemptId: params.work_attempt_id,
      executionGenerationId: params.execution_generation_id,
      daemonGeneration: params.daemon_generation,
      providerTurnId: params.provider_turn_id ?? "",
      mcpRequestId: params.mcp_request_id,
      toolName: params.tool_name,
      input: params.input,
    }),
    "supervisor.complete_bounded_effect": (params) => operations.completeBoundedEffect({
      entryId: params.entry_id,
      workAttemptId: params.work_attempt_id,
      executionGenerationId: params.execution_generation_id,
      daemonGeneration: params.daemon_generation,
      providerTurnId: params.provider_turn_id ?? "",
      effectId: params.effect_id,
      result: params.result,
      error: params.error,
    }),
    "supervisor.get_agent_configuration": (params) => operations.getAgentConfiguration(
      params.entry_id,
      params.daemon_generation,
    ),
    "supervisor.update_agent_configuration": (params) => operations.updateAgentConfiguration({
      entryId: params.entry_id,
      daemonGeneration: params.daemon_generation,
      expectedRevision: params.expected_revision,
      configuration: params.configuration,
    }),
    "supervisor.apply_agent_configuration": (params) => operations.submitApplyAgentConfiguration({
      entryId: params.entry_id,
      daemonGeneration: params.daemon_generation,
      expectedConfigurationRevision: params.expected_configuration_revision,
    }),
    "supervisor.prepare_room_move": (params) => operations.prepareInspectorRoomMove({
      entryId: params.entry_id,
      destinationRoomId: params.destination_room_id,
      requestId: params.request_id,
      daemonGeneration: params.daemon_generation,
    }),
    "supervisor.commit_room_move": (params) => operations.commitInspectorRoomMove({
      operationId: params.operation_id,
      entryId: params.entry_id,
      daemonGeneration: params.daemon_generation,
    }),
    "supervisor.acknowledge_room_move_source_revocation": (params) => operations.acknowledgeInspectorRoomMoveSourceRevocation({
      operationId: params.operation_id,
      entryId: params.entry_id,
      sourceAgentSessionId: params.source_agent_session_id,
      daemonGeneration: params.daemon_generation,
    }),
    "supervisor.rollback_room_move": (params) => operations.rollbackInspectorRoomMove({
      operationId: params.operation_id,
      entryId: params.entry_id,
      detail: params.error,
      daemonGeneration: params.daemon_generation,
    }),
    "supervisor.get_room_move": (params) => operations.getInspectorRoomMove({
      operationId: params.operation_id,
      entryId: params.entry_id,
      daemonGeneration: params.daemon_generation,
    }),
    "supervisor.get_current_room_move": (params) => operations.getCurrentInspectorRoomMove({
      entryId: params.entry_id,
      daemonGeneration: params.daemon_generation,
    }),
    "supervisor.recover_agent_runtime": (params) => operations.recoverAgentRuntime(
      params.entry_id,
      params.daemon_generation,
      "mode" in params
        ? {
            ...("retired_runtime_evidence" in params && params.retired_runtime_evidence !== undefined
              ? { retiredRuntimeEvidence: params.retired_runtime_evidence }
              : {}),
            mode: params.mode,
            operationId: params.operation_id,
            roomId: params.room_id,
            executionGenerationId: params.execution_generation_id,
            runtimeGenerationId: params.runtime_generation_id,
          }
        : undefined,
    ),
    "supervisor.retire_agent": (params) => operations.retireAgent(
      params.entry_id,
      params.daemon_generation,
      params.revoked_agent_session_id ?? null,
      params.grant_revoked_without_worker_session === true,
    ),
    "supervisor.purge_agent": (params) => operations.purgeAgent(
      params.entry_id,
      params.daemon_generation,
      params.revoked_agent_session_id ?? null,
      params.grant_revoked_without_worker_session === true,
    ),
    "manifest.put": (params) => operations.putManifestEntry(params.entry as DaemonManifestEntry),
    "manifest.set_desired_state": async (params) => operations.entryWithDerivedLiveness(
      await operations.setDesiredState(params.id, params.desired_state),
    ),
    "manifest.set_display_name": async (params) => operations.entryWithDerivedLiveness(
      await operations.setDisplayName(params.id, params.display_name),
    ),
    "manifest.compare_and_set_desired_state": async (params) => {
      const result = await operations.compareAndSetDesiredState(
        params.id,
        params.expected_desired_state,
        params.desired_state,
      );
      return { applied: result.applied, entry: await operations.entryWithDerivedLiveness(result.entry) };
    },
    "manifest.control_turn": (params) => operations.controlTurn({
      entryId: params.id,
      daemonGeneration: params.daemon_generation,
      roomId: params.room_id,
      workAttemptId: params.work_attempt_id,
      executionGenerationId: params.execution_generation_id,
      providerContinuationId: params.provider_continuation_id,
      providerTurnId: params.provider_turn_id,
      inboxItemId: params.inbox_item_id,
      sourceMessageId: params.source_message_id,
      actionId: params.action_id,
      actionSequence: params.action_sequence,
      correction: params.correction ?? null,
    }),
    "manifest.resolve_turn_control": (params) => operations.resolveTurnControl({
      entryId: params.id,
      workAttemptId: params.work_attempt_id,
      executionGenerationId: params.execution_generation_id,
      actionId: params.action_id,
      resolution: params.resolution as "not_applied" | "applied",
    }),
    "manifest.update_workplace_liveness": (params) => operations.updateWorkplaceLiveness(
      params.id,
      params.state ?? "unknown",
      params.detail ?? null,
      params.observed_at ?? new Date().toISOString(),
    ),
    "supervisor.bind_worker_session": (params) => operations.bindWorkerSession(params),
    "supervisor.verify_worker_session": (params) => operations.verifyWorkerSession(params),
    "supervisor.install_worker_credential": (params) => operations.installWorkerCredential(params),
    "supervisor.install_host_grant": (params) => operations.installHostGrant({
      ...params,
      owner_account_id: params.owner_account_id ?? null,
      scope_key: params.scope_key ?? null,
      credential_only: params.credential_only === true,
      recovery_only: params.recovery_only === true,
    }),
    "supervisor.sync_execution_delegations": (params) => operations.syncExecutionDelegations(params),
    "supervisor.install_open_model_credential": (params) => operations.installOpenModelCredential(params),
    "supervisor.bootstrap_room_ingress": (params) => operations.bootstrapRoomIngress(params),
    "supervisor.borrow_worker_credential": (params) => operations.borrowWorkerCredential({
      ...params,
      provider_turn_id: params.provider_turn_id ?? "",
    }),
    "supervisor.checkpoint_worker_cursor": (params) => operations.checkpointWorkerCursor(params),
    "attempt.read": (params) => operations.readAttempt(params.id),
  };

  return async (request, disconnected) => {
    await context.assertCurrent();
    const isLifecycleRequest = HANDOFF_LIFECYCLE_METHODS.has(request.method);
    if (context.isHandoffScheduled() && !isLifecycleRequest) {
      throw new Error("Supervisor handoff has fenced new daemon mutations.");
    }
    const assertDrainAdmission = () => {
      if (context.isHandoffDraining?.() && !HANDOFF_DRAIN_METHODS.has(request.method)) {
        throw new Error("An update is waiting for current agent work to finish. Try this action after the update completes or is deferred.");
      }
    };
    assertDrainAdmission();
    await context.requestBarrier?.(request);
    assertDrainAdmission();
    // A request may have been admitted before prepare_handoff and paused in
    // an injected/native barrier. Re-check after that await so it cannot
    // perform provider effects once handoff begins.
    if (context.isHandoffScheduled() && !isLifecycleRequest) {
      throw new Error("Supervisor handoff has fenced new daemon mutations.");
    }
    if (!isDaemonRpcMethod(request.method)) {
      throw new Error(`Unsupported daemon method: ${request.method}`);
    }
    const method = request.method;
    const parsedParams = parseDaemonRpcParams(method, request.params);
    const handler = handlers[method] as (params: unknown, signal?: AbortSignal) => Promise<unknown> | unknown;
    return handler(parsedParams, disconnected);
  };
}
