/**
 * Single authoritative RPC contract for every daemon control-socket method.
 *
 * Both the daemon router (`apps/desktop/daemon/control-request-router.ts`) and
 * the Electron client (`apps/desktop/electron/main/supervisor-daemon`) derive
 * their parameter types, result types, validation, timeouts, framing bounds,
 * and handoff admission rules from `DAEMON_RPC_METHODS`.
 *
 * Every schema here obeys the cross-process wire boundary rule in
 * `wire-boundary.ts` and compiles cleanly to Draft 2020-12 JSON Schema
 * (`rpc-contract.schema.json`) so a future Rust core can consume it directly.
 */
import { z } from "zod";
import {
  DAEMON_ASYNC_RPC_WAIT_TIMEOUTS,
  DAEMON_CONTROL_MAX_REQUEST_BYTES,
  DAEMON_LOCAL_BOARD_MAX_FRAME_BYTES,
  DAEMON_RPC_TIMEOUTS,
} from "./version.js";
import {
  assertPlainWireValue,
  EXACT_NON_EMPTY_STRING_PATTERN,
  exactNonEmptyString,
  jsonRecordSchema,
  jsonValueSchema,
  looseJsonObject,
  nonNegativeSafeInt,
  positiveSafeInt,
} from "./wire-boundary.js";
import {
  daemonAgentConfigurationApplyResultSchema,
  daemonAgentConfigurationUpdateResultSchema,
  daemonAgentConfigurationViewSchema,
  daemonAgentStreamEventSchema,
  daemonAsyncRpcAcceptedSchema,
  daemonAttemptDetailSchema,
  daemonBootstrapRoomIngressResultSchema,
  daemonInspectorDetailSchema,
  daemonInstallHostGrantResultSchema,
  daemonManifestEntrySchema,
  daemonManifestEntryViewSchema,
  daemonPurgeAgentResultSchema,
  daemonRecoverAgentRuntimeResultSchema,
  daemonRetireAgentResultSchema,
  daemonRoomMoveRecordSchema,
  daemonRpcEffectViewSchema,
  daemonStateWatchResultSchema,
  daemonStatusSchema,
  daemonTurnControlResultSchema,
  desiredStateSchema,
  hostApprovalChallengeSchema,
  retiredRuntimeEvidenceListSchema,
  signedHostApprovalRequestSchema,
  workplaceReachabilitySchema,
  type DaemonAsyncRpcEffectKind,
} from "./wire-types.js";

export type RpcFixedTimeoutClass =
  | "default"
  | "rich_read"
  | "turn_control"
  | "room_move_commit"
  | "local_board";

export type RpcTimeoutSpec =
  | { readonly kind: "fixed"; readonly ms: number; readonly class: RpcFixedTimeoutClass }
  | { readonly kind: "none" }
  | {
      readonly kind: "long_poll";
      readonly waitParam: "wait_ms";
      readonly defaultWaitMs: number;
      readonly maxWaitMs: number;
      readonly overheadMs: number;
    };

export interface DaemonRpcMethodDefinition<
  TParams extends z.ZodType = z.ZodType,
  TResult extends z.ZodType = z.ZodType,
  TOutcome extends z.ZodType = z.ZodType,
> {
  readonly params: TParams;
  readonly result: TResult;
  readonly timeout: RpcTimeoutSpec;
  /**
   * When present, the RPC returns `{ effect_id, daemon_generation }` at once
   * under the short default timeout and delivers its typed domain outcome
   * asynchronously through `manifest.watch_state` (`rpc_effects`).
   */
  readonly asyncEffect?: {
    readonly kind: DaemonAsyncRpcEffectKind;
    readonly outcome: TOutcome;
    /** Client-side wait budget after `{ effect_id, daemon_generation }` is accepted (`0` = no deadline). */
    readonly waitTimeoutMs: number;
  };
  /** Admitted even after `prepare_handoff` schedules daemon retirement. */
  readonly handoffLifecycle?: boolean;
  /** Admitted while reversible handoff drain waits for in-flight turns. */
  readonly handoffDrainAllowed?: boolean;
  /** Admitted regardless of client protocol version (negotiation only). */
  readonly versionAgnostic?: boolean;
  /** Requires an active socket disconnect AbortSignal (long-lived watch). */
  readonly requiresLiveConnection?: boolean;
  /** Maximum accepted request frame size in UTF-8 bytes. */
  readonly maxRequestBytes?: number;
  /** Optional domain-specific error message when parameter validation fails. */
  readonly invalidParamsMessage?: string;
}

function defineMethod<
  TParams extends z.ZodType,
  TResult extends z.ZodType,
  TOutcome extends z.ZodType = z.ZodNever,
>(
  spec: DaemonRpcMethodDefinition<TParams, TResult, TOutcome>,
): DaemonRpcMethodDefinition<TParams, TResult, TOutcome> {
  return spec;
}

const FIXED_DEFAULT: RpcTimeoutSpec = {
  kind: "fixed",
  ms: DAEMON_RPC_TIMEOUTS.defaultMs,
  class: "default",
};
const FIXED_RICH_READ: RpcTimeoutSpec = {
  kind: "fixed",
  ms: DAEMON_RPC_TIMEOUTS.richReadMs,
  class: "rich_read",
};
const FIXED_TURN_CONTROL: RpcTimeoutSpec = {
  kind: "fixed",
  ms: DAEMON_RPC_TIMEOUTS.turnControlMs,
  class: "turn_control",
};
const FIXED_ROOM_MOVE_COMMIT: RpcTimeoutSpec = {
  kind: "fixed",
  ms: DAEMON_RPC_TIMEOUTS.roomMoveCommitMs,
  class: "room_move_commit",
};
const FIXED_LOCAL_BOARD: RpcTimeoutSpec = {
  kind: "fixed",
  ms: DAEMON_RPC_TIMEOUTS.localBoardMs,
  class: "local_board",
};
const NO_TIMEOUT: RpcTimeoutSpec = { kind: "none" };
const LONG_POLL_TIMEOUT: RpcTimeoutSpec = {
  kind: "long_poll",
  waitParam: "wait_ms",
  defaultWaitMs: DAEMON_RPC_TIMEOUTS.longPollDefaultWaitMs,
  maxWaitMs: DAEMON_RPC_TIMEOUTS.longPollMaxWaitMs,
  overheadMs: DAEMON_RPC_TIMEOUTS.defaultMs,
};

// Reusable method parameter building blocks
const emptyParamsSchema = z.object({}).nullable().optional();

const manifestListRoomIdError = "manifest.list room_id must be an exact non-empty room identifier.";
const manifestListActivityError = 'manifest.list activity must be "full" or "summary".';

const roomDeliveryControlParamsSchema = z.object({
  entry_id: z.string(),
  room_id: z.string(),
  source_message_id: z.string(),
  work_attempt_id: z.string(),
  execution_generation_id: z.string(),
  agent_session_id: z.string(),
  daemon_generation: z.number(),
});

const roomMoveIdentityParamsSchema = z.object({
  operation_id: exactNonEmptyString,
  entry_id: exactNonEmptyString,
  daemon_generation: positiveSafeInt,
});

const workerSessionBindParamsSchema = z.object({
  entry_id: z.string(),
  room_id: z.string(),
  work_attempt_id: z.string(),
  execution_generation_id: z.string(),
  agent_session_id: z.string(),
  agent_session_token: z.string(),
  api_url: z.string(),
});

const retireOrPurgeParamsSchema = z.union([
  z.object({
    entry_id: exactNonEmptyString,
    daemon_generation: positiveSafeInt,
    revoked_agent_session_id: exactNonEmptyString,
    grant_revoked_without_worker_session: z.literal(false).optional(),
  }),
  z.object({
    entry_id: exactNonEmptyString,
    daemon_generation: positiveSafeInt,
    revoked_agent_session_id: z.null().optional(),
    grant_revoked_without_worker_session: z.boolean().optional(),
  }),
]);

const recoverAgentRuntimeParamsSchema = z.union([
  z.strictObject({
    entry_id: exactNonEmptyString,
    daemon_generation: positiveSafeInt,
  }),
  z.strictObject({
    entry_id: exactNonEmptyString,
    daemon_generation: positiveSafeInt,
    mode: z.literal("reconnect"),
    operation_id: exactNonEmptyString,
    room_id: exactNonEmptyString,
    execution_generation_id: exactNonEmptyString,
    runtime_generation_id: exactNonEmptyString,
  }),
  z.strictObject({
    entry_id: exactNonEmptyString,
    daemon_generation: positiveSafeInt,
    mode: z.enum(["resume", "fresh"]),
    operation_id: exactNonEmptyString,
    room_id: exactNonEmptyString,
    execution_generation_id: exactNonEmptyString,
    runtime_generation_id: exactNonEmptyString,
    retired_runtime_evidence: retiredRuntimeEvidenceListSchema.optional(),
  }),
]);

// Loose entry input preserves all fields for manifestAdministration's domain
// validator (and existing legacy test fixtures) while still publishing the
// manifest entry shape in JSON Schema.
const manifestPutEntrySchema = looseJsonObject({
  ...daemonManifestEntrySchema.partial().shape,
  observed_state: z.string().optional(),
  provider_ref: looseJsonObject({
    work_attempt_id: z.string().optional(),
    provider_continuation_id: z.string().optional(),
    provider_connection: jsonRecordSchema.nullable().optional(),
    execution_generation_id: z.string().optional(),
  }).nullable().optional(),
});

const localBoardMutateParamsSchema = z.union([
  looseJsonObject({
    domain: z.literal("desktop"),
    databasePath: z.string(),
    operation: z.string(),
    args: z.array(jsonValueSchema),
  }),
  looseJsonObject({
    domain: z.literal("mcp"),
    databasePath: z.string(),
    statePath: z.string(),
    operation: z.string(),
    args: z.array(jsonValueSchema),
    worker: jsonRecordSchema.nullable(),
  }),
]);

export const DAEMON_RPC_METHODS = {
  "attempt.read": defineMethod({
    params: z.object({ id: z.string() }),
    result: daemonAttemptDetailSchema,
    timeout: FIXED_RICH_READ,
    handoffDrainAllowed: true,
  }),

  "daemon.negotiate": defineMethod({
    params: emptyParamsSchema,
    result: daemonStatusSchema,
    timeout: FIXED_DEFAULT,
    handoffLifecycle: true,
    handoffDrainAllowed: true,
    versionAgnostic: true,
  }),

  "daemon.prepare_handoff": defineMethod({
    params: emptyParamsSchema,
    result: z.object({
      accepted: z.literal(true),
      generation: nonNegativeSafeInt.optional(),
    }),
    timeout: NO_TIMEOUT,
    handoffLifecycle: true,
    handoffDrainAllowed: true,
  }),

  "daemon.status": defineMethod({
    params: emptyParamsSchema,
    result: daemonStatusSchema,
    timeout: FIXED_DEFAULT,
    handoffLifecycle: true,
    handoffDrainAllowed: true,
  }),

  "local_board.mutate": defineMethod({
    params: localBoardMutateParamsSchema,
    result: jsonValueSchema,
    timeout: FIXED_LOCAL_BOARD,
    maxRequestBytes: DAEMON_LOCAL_BOARD_MAX_FRAME_BYTES,
  }),

  "local_board.watch": defineMethod({
    params: looseJsonObject({
      roomId: z.string().min(1).max(1024),
      generation: z.number().optional(),
      revision: z.number().optional(),
    }),
    result: z.object({
      generation: nonNegativeSafeInt,
      revision: nonNegativeSafeInt,
      tasks: z.array(jsonValueSchema),
    }),
    timeout: NO_TIMEOUT,
    handoffDrainAllowed: true,
    requiresLiveConnection: true,
    invalidParamsMessage: "Choose a board to watch.",
  }),

  "manifest.compare_and_set_desired_state": defineMethod({
    params: z.object({
      id: exactNonEmptyString,
      expected_desired_state: desiredStateSchema,
      desired_state: desiredStateSchema,
    }),
    result: z.object({
      applied: z.boolean(),
      entry: daemonManifestEntryViewSchema,
    }),
    timeout: FIXED_DEFAULT,
    invalidParamsMessage: "Agent lifecycle compare-and-set requires exact typed fields.",
  }),

  "manifest.control_turn": defineMethod({
    params: z.object({
      id: z.string(),
      room_id: z.string({ error: "Turn control room_id is required." }),
      daemon_generation: z.number(),
      work_attempt_id: z.string(),
      execution_generation_id: z.string(),
      provider_continuation_id: z.string(),
      provider_turn_id: z.string(),
      inbox_item_id: z.string(),
      source_message_id: z.string(),
      action_id: z.string(),
      action_sequence: z.number(),
      correction: z.string().nullable().optional(),
    }),
    result: daemonTurnControlResultSchema,
    timeout: FIXED_TURN_CONTROL,
  }),

  "manifest.get_entry": defineMethod({
    params: z.object({
      entry_id: exactNonEmptyString,
    }),
    result: daemonManifestEntryViewSchema.nullable(),
    timeout: FIXED_RICH_READ,
    handoffDrainAllowed: true,
    invalidParamsMessage: "manifest.get_entry requires an exact non-empty entry_id.",
  }),

  "manifest.list": defineMethod({
    params: z.object({
      room_id: z.string({ error: manifestListRoomIdError })
        .min(1, { error: manifestListRoomIdError })
        .regex(EXACT_NON_EMPTY_STRING_PATTERN, { error: manifestListRoomIdError })
        .nullable()
        .optional(),
      activity: z.enum(["full", "summary"], { error: manifestListActivityError })
        .nullable()
        .optional(),
    }).nullable().optional(),
    result: z.array(daemonManifestEntryViewSchema),
    timeout: FIXED_RICH_READ,
    handoffDrainAllowed: true,
  }),

  "manifest.put": defineMethod({
    params: z.object({
      entry: manifestPutEntrySchema,
    }),
    result: daemonManifestEntryViewSchema,
    timeout: FIXED_DEFAULT,
    invalidParamsMessage: "manifest.put requires an entry.",
  }),

  "manifest.resolve_turn_control": defineMethod({
    params: z.object({
      id: z.string(),
      work_attempt_id: z.string(),
      execution_generation_id: z.string(),
      action_id: z.string(),
      resolution: z.string(),
    }),
    result: daemonManifestEntryViewSchema,
    timeout: FIXED_DEFAULT,
  }),

  "manifest.set_desired_state": defineMethod({
    params: z.object({
      id: exactNonEmptyString,
      desired_state: desiredStateSchema,
    }),
    result: daemonManifestEntryViewSchema,
    timeout: FIXED_DEFAULT,
    invalidParamsMessage: "Agent lifecycle requires an exact identity and desired state.",
  }),

  "manifest.set_display_name": defineMethod({
    params: z.object({
      id: exactNonEmptyString,
      display_name: exactNonEmptyString,
    }),
    result: daemonManifestEntryViewSchema,
    timeout: FIXED_DEFAULT,
    invalidParamsMessage: "Agent naming requires an exact identity and display name.",
  }),

  "manifest.update_workplace_liveness": defineMethod({
    params: z.object({
      id: z.string(),
      state: workplaceReachabilitySchema.optional(),
      detail: z.string().nullable().optional(),
      observed_at: z.string().optional(),
    }),
    result: daemonManifestEntryViewSchema,
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
  }),

  "manifest.watch_state": defineMethod({
    params: z.object({
      after_daemon_generation: z.number().optional(),
      after_sequence: z.number().optional(),
      wait_ms: z.number().optional(),
      changed_only: z.boolean().optional(),
    }),
    result: daemonStateWatchResultSchema,
    timeout: LONG_POLL_TIMEOUT,
    handoffLifecycle: true,
    handoffDrainAllowed: true,
  }),

  "supervisor.acknowledge_room_move_source_revocation": defineMethod({
    params: roomMoveIdentityParamsSchema.extend({
      source_agent_session_id: exactNonEmptyString,
    }),
    result: daemonRoomMoveRecordSchema,
    timeout: FIXED_DEFAULT,
    invalidParamsMessage: "Room-move credential acknowledgement requires exact typed coordinates.",
  }),

  "supervisor.apply_agent_configuration": defineMethod({
    params: z.object({
      entry_id: exactNonEmptyString,
      daemon_generation: positiveSafeInt,
      expected_configuration_revision: positiveSafeInt,
    }),
    result: daemonAsyncRpcAcceptedSchema,
    timeout: FIXED_DEFAULT,
    asyncEffect: {
      kind: "rpc_apply_agent_configuration",
      outcome: daemonAgentConfigurationApplyResultSchema,
      waitTimeoutMs: DAEMON_ASYNC_RPC_WAIT_TIMEOUTS.applyAgentConfigurationMs,
    },
    invalidParamsMessage: "Agent configuration apply requires exact typed coordinates.",
  }),

  "supervisor.bind_worker_session": defineMethod({
    params: workerSessionBindParamsSchema,
    result: z.object({
      bound: z.literal(true),
      entry_id: z.string(),
      agent_session_id: z.string(),
    }),
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
  }),

  "supervisor.bootstrap_room_ingress": defineMethod({
    params: z.object({
      entry_id: z.string(),
      daemon_generation: z.number(),
      initial_message: z.string().optional(),
    }),
    result: daemonAsyncRpcAcceptedSchema,
    timeout: FIXED_DEFAULT,
    asyncEffect: {
      kind: "rpc_bootstrap_room_ingress",
      outcome: daemonBootstrapRoomIngressResultSchema,
      waitTimeoutMs: DAEMON_ASYNC_RPC_WAIT_TIMEOUTS.bootstrapRoomIngressMs,
    },
  }),

  "supervisor.borrow_worker_credential": defineMethod({
    params: z.object({
      entry_id: z.string(),
      room_id: z.string(),
      work_attempt_id: z.string(),
      execution_generation_id: z.string(),
      agent_session_id: z.string(),
      daemon_generation: z.number(),
      provider_turn_id: z.string().optional(),
      api_url: z.string(),
    }),
    result: z.object({
      agent_session_token: z.string(),
      api_url: z.string(),
      room_id: z.string(),
      agent_session_id: z.string(),
    }),
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
  }),

  "supervisor.checkpoint_worker_cursor": defineMethod({
    params: z.object({
      entry_id: z.string(),
      work_attempt_id: z.string(),
      execution_generation_id: z.string(),
      agent_session_id: z.string(),
      room_cursor: z.string(),
    }),
    result: z.object({
      checkpointed: z.literal(true),
      entry_id: z.string(),
      room_cursor: z.string(),
    }),
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
  }),

  "supervisor.commit_room_move": defineMethod({
    params: roomMoveIdentityParamsSchema,
    result: daemonRoomMoveRecordSchema,
    timeout: FIXED_ROOM_MOVE_COMMIT,
    invalidParamsMessage: "Room-move commit requires exact typed coordinates.",
  }),

  "supervisor.complete_bounded_effect": defineMethod({
    params: z.object({
      entry_id: z.string(),
      work_attempt_id: z.string(),
      execution_generation_id: z.string(),
      daemon_generation: z.number(),
      provider_turn_id: z.string().optional(),
      effect_id: z.string(),
      result: jsonValueSchema.optional(),
      error: z.string().optional(),
    }),
    result: z.object({ completed: z.literal(true) }),
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
  }),

  "supervisor.execute_bounded_tool": defineMethod({
    params: z.object({
      entry_id: exactNonEmptyString,
      work_attempt_id: exactNonEmptyString,
      execution_generation_id: exactNonEmptyString,
      daemon_generation: positiveSafeInt,
      provider_turn_id: z.string().optional(),
      mcp_request_id: exactNonEmptyString,
      tool_name: exactNonEmptyString,
      input: jsonValueSchema.optional(),
    }),
    result: jsonRecordSchema,
    timeout: NO_TIMEOUT,
    handoffDrainAllowed: true,
    invalidParamsMessage: "Supervised tool execution requires exact typed coordinates.",
  }),

  "supervisor.get_agent_configuration": defineMethod({
    params: z.object({
      entry_id: exactNonEmptyString,
      daemon_generation: positiveSafeInt,
    }),
    result: daemonAgentConfigurationViewSchema,
    timeout: FIXED_RICH_READ,
    handoffDrainAllowed: true,
    invalidParamsMessage: "Agent configuration requires exact typed coordinates.",
  }),

  "supervisor.get_agent_inspector_detail": defineMethod({
    params: z.object({
      entry_id: z.string(),
      room_id: z.string(),
      source_message_id: z.string().nullable(),
      /** The owner opened the Overview: the provider's account limits may be read again. */
      refresh_account_usage: z.boolean().optional(),
    }),
    result: daemonInspectorDetailSchema,
    timeout: FIXED_RICH_READ,
    handoffDrainAllowed: true,
    invalidParamsMessage:
      "Agent inspector detail requires string entry_id, string room_id, and source_message_id as string or null.",
  }),

  "supervisor.get_current_room_move": defineMethod({
    params: z.object({
      entry_id: exactNonEmptyString,
      daemon_generation: positiveSafeInt,
    }),
    result: daemonRoomMoveRecordSchema.nullable(),
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
    invalidParamsMessage: "Current room-move discovery requires exact typed coordinates.",
  }),

  "supervisor.get_room_move": defineMethod({
    params: roomMoveIdentityParamsSchema,
    result: daemonRoomMoveRecordSchema,
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
    invalidParamsMessage: "Room-move status requires exact typed coordinates.",
  }),

  "supervisor.get_rpc_effect": defineMethod({
    params: z.object({
      effect_id: exactNonEmptyString,
      daemon_generation: positiveSafeInt,
    }),
    result: daemonRpcEffectViewSchema.nullable(),
    timeout: FIXED_DEFAULT,
    handoffLifecycle: true,
    handoffDrainAllowed: true,
    invalidParamsMessage: "Async RPC effect lookup requires an exact effect_id and daemon_generation.",
  }),

  "supervisor.host_approval_challenge": defineMethod({
    params: emptyParamsSchema,
    result: hostApprovalChallengeSchema.nullable(),
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
  }),

  "supervisor.host_approval_request": defineMethod({
    params: signedHostApprovalRequestSchema,
    result: jsonValueSchema,
    timeout: FIXED_RICH_READ,
    handoffDrainAllowed: true,
    invalidParamsMessage: "Host approvals are unavailable or this request could not be authenticated.",
  }),

  "supervisor.install_host_grant": defineMethod({
    params: z.object({
      entry_id: z.string(),
      room_id: z.string(),
      agent_key: z.string(),
      grant_id: z.string(),
      supervisor_grant: z.string(),
      grant_generation: z.number(),
      api_url: z.string(),
      host_id: z.string(),
      installation_id: z.string(),
      owner_account_id: z.string().nullable().optional(),
      scope_key: z.string().nullable().optional(),
      grant_expires_at: z.string(),
      daemon_generation: z.number(),
      credential_only: z.boolean().optional(),
      recovery_only: z.boolean().optional(),
    }),
    result: daemonAsyncRpcAcceptedSchema,
    timeout: FIXED_DEFAULT,
    asyncEffect: {
      kind: "rpc_install_host_grant",
      outcome: daemonInstallHostGrantResultSchema,
      waitTimeoutMs: DAEMON_ASYNC_RPC_WAIT_TIMEOUTS.installHostGrantMs,
    },
    handoffDrainAllowed: true,
  }),

  "supervisor.install_open_model_credential": defineMethod({
    params: z.object({
      entry_id: z.string(),
      api_key: z.string().nullable(),
      base_url: z.string(),
      model: z.string(),
      context_window: z.number({ error: "The model context window must be a positive whole number." })
        .int({ error: "The model context window must be a positive whole number." })
        .min(1, { error: "The model context window must be a positive whole number." })
        .max(Number.MAX_SAFE_INTEGER, { error: "The model context window must be a positive whole number." })
        .optional(),
      daemon_generation: z.number(),
    }),
    result: z.object({
      status: z.enum(["installed", "stale"]),
    }),
    timeout: FIXED_DEFAULT,
  }),

  "supervisor.install_worker_credential": defineMethod({
    params: z.object({
      entry_id: z.string(),
      room_id: z.string(),
      work_attempt_id: z.string(),
      execution_generation_id: z.string(),
      agent_session_id: z.string(),
      agent_session_token: z.string(),
      daemon_generation: z.number(),
    }),
    result: z.object({
      status: z.enum(["installed", "stale"]),
    }),
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
  }),

  "supervisor.prepare_bounded_effect": defineMethod({
    params: z.object({
      entry_id: z.string(),
      work_attempt_id: z.string(),
      execution_generation_id: z.string(),
      daemon_generation: z.number(),
      provider_turn_id: z.string().optional(),
      mcp_request_id: z.string(),
      tool_name: z.string(),
      input: jsonValueSchema.optional(),
      mutation: z.boolean().optional(),
    }),
    result: jsonRecordSchema,
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
  }),

  "supervisor.prepare_room_move": defineMethod({
    params: z.object({
      entry_id: exactNonEmptyString,
      destination_room_id: exactNonEmptyString,
      request_id: exactNonEmptyString,
      daemon_generation: positiveSafeInt,
    }),
    result: daemonRoomMoveRecordSchema,
    timeout: FIXED_DEFAULT,
    invalidParamsMessage: "Room-move preparation requires exact typed coordinates.",
  }),

  "supervisor.purge_agent": defineMethod({
    params: retireOrPurgeParamsSchema,
    result: daemonPurgeAgentResultSchema,
    timeout: FIXED_DEFAULT,
    invalidParamsMessage: "Purge requires exact typed coordinates.",
  }),

  "supervisor.recover_agent_runtime": defineMethod({
    params: recoverAgentRuntimeParamsSchema,
    result: daemonAsyncRpcAcceptedSchema,
    timeout: FIXED_DEFAULT,
    asyncEffect: {
      kind: "rpc_recover_agent_runtime",
      outcome: daemonRecoverAgentRuntimeResultSchema,
      waitTimeoutMs: DAEMON_ASYNC_RPC_WAIT_TIMEOUTS.recoverAgentRuntimeMs,
    },
    invalidParamsMessage: "Agent runtime recovery requires exact typed coordinates.",
  }),

  "supervisor.restore_agent_conversation": defineMethod({
    params: roomDeliveryControlParamsSchema,
    result: z.object({ accepted: z.literal(true) }),
    timeout: FIXED_TURN_CONTROL,
  }),

  "supervisor.retire_agent": defineMethod({
    params: retireOrPurgeParamsSchema,
    result: daemonAsyncRpcAcceptedSchema,
    timeout: FIXED_DEFAULT,
    asyncEffect: {
      kind: "rpc_retire_agent",
      outcome: daemonRetireAgentResultSchema,
      waitTimeoutMs: DAEMON_ASYNC_RPC_WAIT_TIMEOUTS.retireAgentMs,
    },
    invalidParamsMessage: "Retire requires exact typed coordinates.",
  }),

  "supervisor.retry_room_delivery": defineMethod({
    params: roomDeliveryControlParamsSchema,
    result: z.object({ accepted: z.literal(true) }),
    timeout: FIXED_TURN_CONTROL,
  }),

  "supervisor.rollback_room_move": defineMethod({
    params: roomMoveIdentityParamsSchema.extend({
      error: exactNonEmptyString,
    }),
    result: daemonRoomMoveRecordSchema,
    timeout: FIXED_DEFAULT,
    invalidParamsMessage: "Room-move rollback requires exact typed coordinates.",
  }),

  "supervisor.skip_room_delivery": defineMethod({
    params: roomDeliveryControlParamsSchema,
    result: z.object({ accepted: z.literal(true) }),
    timeout: FIXED_TURN_CONTROL,
  }),

  "supervisor.sync_execution_delegations": defineMethod({
    params: z.object({
      room_id: z.string({ error: "Execution delegation sync requires a room." })
        .min(1, { error: "Execution delegation sync requires a room." })
        .regex(EXACT_NON_EMPTY_STRING_PATTERN, { error: "Execution delegation sync requires a room." }),
      daemon_generation: z.number({ error: "Execution delegation sync requires a daemon generation." })
        .int({ error: "Execution delegation sync requires a daemon generation." })
        .min(1, { error: "Execution delegation sync requires a daemon generation." })
        .max(Number.MAX_SAFE_INTEGER, { error: "Execution delegation sync requires a daemon generation." }),
    }),
    result: z.object({
      status: z.enum(["queued", "stale"]),
    }),
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
  }),

  "supervisor.update_agent_configuration": defineMethod({
    params: z.object({
      entry_id: exactNonEmptyString,
      daemon_generation: positiveSafeInt,
      expected_revision: positiveSafeInt,
      configuration: jsonRecordSchema,
    }),
    result: daemonAgentConfigurationUpdateResultSchema,
    timeout: FIXED_DEFAULT,
    invalidParamsMessage: "Agent configuration update requires exact typed coordinates.",
  }),

  "supervisor.verify_worker_session": defineMethod({
    params: workerSessionBindParamsSchema,
    result: z.object({
      verified: z.literal(true),
      entry_id: z.string(),
      agent_session_id: z.string(),
    }),
    timeout: FIXED_DEFAULT,
    handoffDrainAllowed: true,
  }),

  "supervisor.watch_agent_stream": defineMethod({
    params: z.object({
      entry_id: z.string(),
      after_sequence: z.number().optional(),
      wait_ms: z.number().optional(),
    }),
    result: z.object({
      sequence: nonNegativeSafeInt,
      stream_generation: nonNegativeSafeInt,
      dropped_events: nonNegativeSafeInt,
      events: z.array(daemonAgentStreamEventSchema),
      ended: z.boolean(),
    }),
    timeout: LONG_POLL_TIMEOUT,
    handoffDrainAllowed: true,
  }),

  "supervisor.watch_background_commands": defineMethod({
    params: z.object({
      entry_id: z.string(),
      after_version: z.number().optional(),
      wait_ms: z.number().optional(),
    }),
    result: z.object({
      version: nonNegativeSafeInt,
      commands: z.array(jsonValueSchema),
      ended: z.boolean(),
    }),
    timeout: LONG_POLL_TIMEOUT,
    handoffDrainAllowed: true,
  }),
} as const satisfies Record<string, DaemonRpcMethodDefinition>;

export const DAEMON_ASYNC_RPC_OUTCOMES = {
  "supervisor.apply_agent_configuration": daemonAgentConfigurationApplyResultSchema,
  "supervisor.bootstrap_room_ingress": daemonBootstrapRoomIngressResultSchema,
  "supervisor.install_host_grant": daemonInstallHostGrantResultSchema,
  "supervisor.recover_agent_runtime": daemonRecoverAgentRuntimeResultSchema,
  "supervisor.retire_agent": daemonRetireAgentResultSchema,
} as const;

export type DaemonAsyncRpcMethod = keyof typeof DAEMON_ASYNC_RPC_OUTCOMES;
export type DaemonAsyncRpcOutcome<M extends DaemonAsyncRpcMethod> = z.output<(typeof DAEMON_ASYNC_RPC_OUTCOMES)[M]>;

export const DAEMON_ASYNC_RPC_METHOD_NAMES: readonly DaemonAsyncRpcMethod[] = Object.freeze(
  (Object.keys(DAEMON_ASYNC_RPC_OUTCOMES) as DaemonAsyncRpcMethod[]).sort(),
);

export function isAsyncDaemonRpcMethod(method: string): method is DaemonAsyncRpcMethod {
  return Object.hasOwn(DAEMON_ASYNC_RPC_OUTCOMES, method);
}

export function isDaemonAsyncRpcAccepted(value: unknown): value is z.output<typeof daemonAsyncRpcAcceptedSchema> {
  return daemonAsyncRpcAcceptedSchema.safeParse(value).success;
}

/**
 * Resolves the caller-side wait deadline (ms) for an async RPC effect after
 * `{ effect_id, daemon_generation }` is accepted. Returns `0` for methods
 * without a caller deadline (such as `supervisor.apply_agent_configuration`).
 */
export function resolveDaemonAsyncRpcWaitTimeoutMs(
  method: DaemonAsyncRpcMethod,
  overrides?: Partial<Record<DaemonAsyncRpcMethod, number>>,
): number {
  const override = overrides?.[method];
  if (override !== undefined && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const spec = DAEMON_RPC_METHODS[method].asyncEffect;
  if (!spec) {
    throw new Error(`RPC method ${method} does not declare asyncEffect metadata.`);
  }
  return spec.waitTimeoutMs;
}

export type DaemonRpcMethod = keyof typeof DAEMON_RPC_METHODS;
export type DaemonRpcParams<M extends DaemonRpcMethod> = z.input<(typeof DAEMON_RPC_METHODS)[M]["params"]>;
export type DaemonRpcParsedParams<M extends DaemonRpcMethod> = z.output<(typeof DAEMON_RPC_METHODS)[M]["params"]>;
export type DaemonRpcResult<M extends DaemonRpcMethod> = z.output<(typeof DAEMON_RPC_METHODS)[M]["result"]>;

export const DAEMON_RPC_METHOD_NAMES: readonly DaemonRpcMethod[] = Object.freeze(
  (Object.keys(DAEMON_RPC_METHODS) as DaemonRpcMethod[]).sort(),
);

export const HANDOFF_LIFECYCLE_METHODS: ReadonlySet<string> = new Set(
  DAEMON_RPC_METHOD_NAMES.filter((method) => DAEMON_RPC_METHODS[method].handoffLifecycle === true),
);

export const HANDOFF_DRAIN_METHODS: ReadonlySet<string> = new Set(
  DAEMON_RPC_METHOD_NAMES.filter((method) => DAEMON_RPC_METHODS[method].handoffDrainAllowed === true),
);

export const VERSION_AGNOSTIC_METHODS: ReadonlySet<string> = new Set(
  DAEMON_RPC_METHOD_NAMES.filter((method) => DAEMON_RPC_METHODS[method].versionAgnostic === true),
);

export function isDaemonRpcMethod(method: string): method is DaemonRpcMethod {
  return Object.hasOwn(DAEMON_RPC_METHODS, method);
}

export function maxRequestBytesForMethod(method: string): number {
  if (!isDaemonRpcMethod(method)) return DAEMON_CONTROL_MAX_REQUEST_BYTES;
  return DAEMON_RPC_METHODS[method].maxRequestBytes ?? DAEMON_CONTROL_MAX_REQUEST_BYTES;
}

const GENERIC_ZOD_MESSAGE_PATTERN = /^(?:Invalid |Too small:|Too big:|Unrecognized key)/;

function formatParamIssueMessage(method: DaemonRpcMethod, issue: z.core.$ZodIssue): string {
  const message = issue.message;
  if (!GENERIC_ZOD_MESSAGE_PATTERN.test(message)) {
    return message;
  }
  if (issue.path.length > 0) {
    return `${method} ${issue.path.join(".")}: ${message}`;
  }
  if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
    for (const branchIssues of issue.errors) {
      const branchFirst = branchIssues[0];
      if (!branchFirst) continue;
      if (branchFirst.path.length > 0) {
        return `${method} ${branchFirst.path.join(".")}: ${branchFirst.message}`;
      }
    }
  }
  return `${method}: ${message}`;
}

/**
 * Validate and parse raw JSON request params against the single contract.
 * Throws a clean, caller-facing Error when params do not satisfy the method's
 * schema or contain non-plain wire values (including on extra forward-compatible
 * fields or own `"__proto__"` keys).
 */
export function parseDaemonRpcParams<M extends DaemonRpcMethod>(
  method: M,
  rawParams: unknown,
): DaemonRpcParsedParams<M> {
  const spec = DAEMON_RPC_METHODS[method];
  const parsed = spec.params.safeParse(rawParams);
  if (parsed.success) {
    if (rawParams !== undefined) {
      assertPlainWireValue(rawParams, { path: method, allowUndefinedProperties: true });
    }
    return rawParams as DaemonRpcParsedParams<M>;
  }

  const firstIssue = parsed.error.issues[0];
  if (
    method !== "supervisor.host_approval_request"
    && firstIssue?.path.length === 0
    && firstIssue.code === "invalid_type"
  ) {
    throw new Error("Daemon request params must be an object.");
  }
  if (spec.invalidParamsMessage) {
    throw new Error(spec.invalidParamsMessage);
  }
  if (firstIssue?.message) {
    throw new Error(formatParamIssueMessage(method, firstIssue));
  }
  throw new Error(`Invalid parameters for ${method}.`);
}

export interface RpcTimeoutOverrides {
  /** Overrides `class: "default"` fixed timeouts and long-poll overhead. */
  defaultTimeoutMs?: number;
  /** Overrides `class: "turn_control"` fixed timeouts. */
  turnControlTimeoutMs?: number;
}

/**
 * Derive the client socket timeout (in ms; 0 = unlimited) directly from the
 * method's contract definition and request params.
 */
export function resolveDaemonRpcTimeoutMs<M extends DaemonRpcMethod>(
  method: M,
  params?: unknown,
  overrides: RpcTimeoutOverrides = {},
): number {
  const timeout = DAEMON_RPC_METHODS[method].timeout;
  if (timeout.kind === "none") return 0;
  if (timeout.kind === "long_poll") {
    const rawWait = params !== null && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)[timeout.waitParam]
      : undefined;
    const waitMs = typeof rawWait === "number" && Number.isFinite(rawWait)
      ? Math.max(0, Math.min(timeout.maxWaitMs, rawWait))
      : timeout.defaultWaitMs;
    return waitMs + (overrides.defaultTimeoutMs ?? timeout.overheadMs);
  }
  if (timeout.class === "default") return overrides.defaultTimeoutMs ?? timeout.ms;
  if (timeout.class === "turn_control") return overrides.turnControlTimeoutMs ?? timeout.ms;
  return timeout.ms;
}
