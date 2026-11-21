/**
 * Shared wire-type Zod schemas for the daemon control socket contract.
 *
 * Every schema in this file obeys the cross-process wire boundary rule
 * (`wire-boundary.ts`) and compiles to Draft 2020-12 JSON Schema with
 * `unrepresentable: "throw"`.
 */
import { z } from "zod";
import {
  AGENT_AVATAR_CHARACTERS,
  AGENT_AVATAR_COLORS,
  type AgentAvatar,
} from "../../../shared/agent-avatar.mjs";
import {
  exactNonEmptyString,
  jsonRecordSchema,
  jsonValueSchema,
  nonNegativeSafeInt,
  positiveSafeInt,
} from "./wire-boundary.js";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const daemonRequestEnvelopeSchema = z.object({
  version: z.number().int(),
  id: z.string().optional(),
  method: z.string(),
  params: jsonValueSchema.optional(),
});
export type DaemonRequest = z.infer<typeof daemonRequestEnvelopeSchema>;

export const daemonResponseEnvelopeSchema = z.object({
  version: z.number().int(),
  id: z.string().optional(),
  ok: z.boolean(),
  result: jsonValueSchema.optional(),
  error: z.string().optional(),
});
export type DaemonResponse = z.infer<typeof daemonResponseEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Core lifecycle & liveness enums
// ---------------------------------------------------------------------------

export const desiredStateSchema = z.enum(["running", "paused", "stopped"]);
export type DesiredState = z.infer<typeof desiredStateSchema>;

export const observedStateSchema = z.enum([
  "absent",
  "starting",
  "idle",
  "working",
  "checkpointing",
  "pausing",
  "paused",
  "recovering",
  "stopping",
  "stopped",
  "failed",
]);
export type ObservedState = z.infer<typeof observedStateSchema>;

export const policyConditionSchema = z.enum([
  "none",
  "quarantined",
  "coordination_blocked",
  "auth_blocked",
  "budget_blocked",
  "security_blocked",
]);
export type PolicyCondition = z.infer<typeof policyConditionSchema>;

export const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const workplaceReachabilitySchema = z.enum(["reachable", "stale", "unknown"]);
export type WorkplaceReachability = z.infer<typeof workplaceReachabilitySchema>;

export const nativeExecutionActivitySchema = z.enum(["active", "idle", "stale", "terminal", "unknown"]);
export type NativeExecutionActivity = z.infer<typeof nativeExecutionActivitySchema>;

export const manifestActivityModeSchema = z.enum(["full", "summary"]);
export type ManifestActivityMode = z.infer<typeof manifestActivityModeSchema>;

export const daemonAgentDeliveryModeSchema = z.literal("daemon_inbox");
export type DaemonAgentDeliveryMode = z.infer<typeof daemonAgentDeliveryModeSchema>;

export const homeHarnessStateSchema = z.enum(["on", "after_restart", "until_restart"]);
export type HomeHarnessState = z.infer<typeof homeHarnessStateSchema>;

export const FOLLOW_UP_REASONS = [
  "stopped_by_owner",
  "skipped",
  "agent_changed",
  "task_not_held",
  "uncertain_action",
  "uncertain_resolved",
  "attempts_failed",
  "ownership_unverified",
  "other",
] as const;
export const followUpReasonSchema = z.enum(FOLLOW_UP_REASONS);
export type FollowUpReason = z.infer<typeof followUpReasonSchema>;

export const agentAvatarSchema: z.ZodType<AgentAvatar> = z.union([
  z.strictObject({
    kind: z.literal("character"),
    character: z.enum(AGENT_AVATAR_CHARACTERS),
    color: z.enum(AGENT_AVATAR_COLORS),
  }),
  z.strictObject({
    kind: z.literal("initials"),
    color: z.enum(AGENT_AVATAR_COLORS),
  }),
  z.strictObject({
    kind: z.literal("image"),
    dataUrl: z.string(),
  }),
]);

// ---------------------------------------------------------------------------
// Daemon status / negotiate
// ---------------------------------------------------------------------------

export const daemonCapabilitiesSchema = z.object({
  room_delivery_retry: z.boolean(),
  provider_continuation_repair: z.boolean(),
  room_delivery_skip: z.boolean(),
  agent_inspector_detail_v1: z.boolean(),
  agent_inspector_settings_v1: z.boolean(),
  agent_room_move_v1: z.boolean(),
  agent_lifecycle_v1: z.boolean(),
  agent_runtime_recovery_v1: z.boolean(),
  agent_runtime_recovery_v2: z.boolean(),
  agent_state_subscription_v1: z.boolean(),
  agent_activity_stream_v1: z.boolean(),
});
export type DaemonCapabilities = z.infer<typeof daemonCapabilitiesSchema>;

export const daemonStatusSchema = z.object({
  healthy: z.boolean(),
  protocol_version: positiveSafeInt,
  implementation_version: z.string(),
  runtime_environment_fingerprint: z.string().nullable(),
  compatibility_fingerprint: z.string().nullable(),
  capabilities: daemonCapabilitiesSchema,
  generation: nonNegativeSafeInt,
  pid: positiveSafeInt,
  started_at: z.string(),
  maintenance_hold_id: z.string().nullable().optional(),
});
export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

// ---------------------------------------------------------------------------
// Execution / terminal / provider connection / activity wire records
// ---------------------------------------------------------------------------

export const executionIdentitySchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);

export const nativeRuntimeDeathSchema = z.strictObject({
  kind: z.enum(["claude_cli", "codex_app_server"]),
  pid: positiveSafeInt,
  processIdentity: z.string().min(1).max(512),
});
export type NativeRuntimeDeath = z.infer<typeof nativeRuntimeDeathSchema>;

export const retiredRuntimeEvidenceSchema = z.strictObject({
  executionGenerationId: executionIdentitySchema,
  runtimeGenerationId: executionIdentitySchema,
  death: nativeRuntimeDeathSchema,
});
export type RetiredRuntimeEvidence = z.infer<typeof retiredRuntimeEvidenceSchema>;

export const retiredRuntimeEvidenceListSchema = z.array(retiredRuntimeEvidenceSchema).max(32);

export const executionTerminalPayloadSchema = z.object({
  native_runtime_death: nativeRuntimeDeathSchema.optional(),
  ended_at: z.string(),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdio_archive_ref: z.string().nullable(),
  stdio_tail: z.string(),
  terminal_cause: z.string(),
  actor: z.string(),
  generation: nonNegativeSafeInt,
  provider_continuation_id: z.string().nullable(),
});
export type ExecutionTerminalPayload = z.infer<typeof executionTerminalPayloadSchema>;

export const daemonProviderConnectionSchema = z.union([
  z.object({
    kind: z.literal("codex_app_server"),
    url: z.string(),
    pid: z.number().int().nullable(),
    processIdentity: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal("claude_cli"),
    pid: z.number().int().nullable(),
    processIdentity: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal("cursor_cli"),
    pid: z.number().int().nullable(),
    processIdentity: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal("opencode_server"),
    url: z.string(),
    pid: z.number().int().nullable(),
    processIdentity: z.string().nullable().optional(),
    serverAuthPath: z.string(),
  }),
]);
export type DaemonProviderConnection = z.infer<typeof daemonProviderConnectionSchema>;

export const daemonProviderRuntimeReferenceSchema = z.object({
  work_attempt_id: z.string(),
  provider_continuation_id: z.string(),
  provider_connection: daemonProviderConnectionSchema.nullable(),
  execution_generation_id: z.string(),
});
export type DaemonProviderRuntimeReference = z.infer<typeof daemonProviderRuntimeReferenceSchema>;

export const daemonWorkerBindingProjectionSchema = z.object({
  agent_session_id: z.string(),
  work_attempt_id: z.string(),
  execution_generation_id: z.string(),
  updated_at: z.string(),
});
export type DaemonWorkerBindingProjection = z.infer<typeof daemonWorkerBindingProjectionSchema>;

export const daemonActivityEventSchema = z.object({
  observed_at: z.string(),
  sequence: z.number().int(),
  provider: z.string(),
  kind: z.string(),
  method: z.string(),
  summary: z.string(),
  status: z.enum(["idle", "working", "reviewing", "blocked"]),
  payload: jsonValueSchema,
  payload_truncated: z.boolean(),
  payload_redacted: z.boolean(),
  durable_payload_ref: z.string().nullable(),
});
export type DaemonActivityEvent = z.infer<typeof daemonActivityEventSchema>;

export const daemonAgentStreamEventSchema = z.object({
  sequence: z.number().int(),
  observed_at: z.string(),
  kind: z.string(),
  method: z.string(),
  summary: z.string().nullable(),
  payload: jsonValueSchema,
  latest_key: z.string().optional(),
});
export type DaemonAgentStreamEvent = z.infer<typeof daemonAgentStreamEventSchema>;

export const runningBackgroundCommandSchema = z.object({
  task_id: z.string(),
  tool_use_id: z.string().nullable(),
  command: z.string(),
  started_at: z.string().nullable(),
});
export type RunningBackgroundCommand = z.infer<typeof runningBackgroundCommandSchema>;

export const launchPhaseSchema = z.enum([
  "prepare",
  "runtime_verify",
  "slot_wait",
  "admission",
  "process",
  "bootstrap",
  "install",
]);

export const launchProgressViewSchema = z.object({
  attempt: positiveSafeInt,
  started_at: z.string(),
  state: z.enum(["running", "launched", "failed"]),
  current: launchPhaseSchema.nullable(),
  phases: z.array(z.object({
    phase: launchPhaseSchema,
    started_at: z.string(),
    ms: nonNegativeSafeInt.nullable(),
  })),
  ended_at: z.string().nullable(),
  first_output_at: z.string().nullable(),
  failure: z.object({
    phase: launchPhaseSchema,
    action: z.enum(["sign_in", "install", "retry"]),
  }).nullable(),
  slot_ahead: nonNegativeSafeInt.nullable(),
});
export type LaunchProgressView = z.infer<typeof launchProgressViewSchema>;

export const turnControlStageSchema = z.enum([
  "delivered",
  "interrupting",
  "applied",
  "resumed",
  "already_applied",
]);

export const daemonTurnControlEffectSchema = z.object({
  action_id: z.string(),
  action_sequence: positiveSafeInt,
  work_attempt_id: z.string(),
  execution_generation_id: z.string(),
  target_room_id: z.string().nullable().optional(),
  target_source_message_id: z.string().nullable().optional(),
  target_provider_continuation_id: z.string().nullable().optional(),
  inbox_item_id: z.string().nullable().optional(),
  provider_turn_id: z.string().nullable().optional(),
  has_correction: z.boolean(),
  correction_text: z.string().nullable().optional(),
  correction_strategy: z.enum(["native", "stop_then_resend"]).nullable().optional(),
  operator_resolution: z.enum(["applied", "not_applied"]).nullable().optional(),
  status: z.enum(["prepared", "dispatching", "completed", "retryable", "uncertain"]),
  capability: z.enum(["native_interrupt", "restart_resume", "unsupported"]),
  interrupted: z.boolean().nullable(),
  resumed: z.boolean().nullable(),
  state: z.enum(["idle", "working"]).nullable(),
  stages: z.array(turnControlStageSchema),
  error: z.string().nullable(),
  recorded_at: z.string(),
  updated_at: z.string(),
});
export type DaemonTurnControlEffect = z.infer<typeof daemonTurnControlEffectSchema>;

export const daemonTurnControlResultSchema = z.object({
  entryId: z.string(),
  workAttemptId: z.string(),
  executionGenerationId: z.string(),
  actionId: z.string(),
  capability: z.enum(["native_interrupt", "restart_resume", "unsupported"]),
  interrupted: z.boolean(),
  resumed: z.boolean(),
  state: z.enum(["idle", "working"]),
  duplicate: z.boolean(),
  stages: z.array(turnControlStageSchema),
});
export type DaemonTurnControlResult = z.infer<typeof daemonTurnControlResultSchema>;

export const reconciliationStateSchema = z.object({
  exit_timestamps_ms: z.array(z.number()),
  consecutive_action_failures: nonNegativeSafeInt,
  last_observed_state: observedStateSchema,
  next_restart_at_ms: z.number().nullable(),
  completed_action_ids: z.array(z.string()),
  last_action_sequence: nonNegativeSafeInt,
  pending_action: z.object({
    id: z.string(),
    sequence: nonNegativeSafeInt,
    kind: z.enum(["poke", "restart_fresh", "restart_with_resume", "stop"]),
    recorded_at_ms: z.number(),
  }).nullable(),
  last_terminal: executionTerminalPayloadSchema.optional(),
});
export type ReconciliationState = z.infer<typeof reconciliationStateSchema>;

export const reconciliationNoticeSchema = z.object({
  at: z.string(),
  kind: z.enum(["quarantine_death", "coordination_escalation"]),
  cause: z.string(),
  terminal: executionTerminalPayloadSchema.optional(),
});
export type ReconciliationNotice = z.infer<typeof reconciliationNoticeSchema>;

export const roomAgentStateSchema = z.object({
  connection: z.object({
    state: z.enum(["connected", "reconnecting", "disconnected"]),
    observed_at: z.string().nullable(),
    detail: z.string().nullable(),
  }),
  ingress: z.object({
    state: z.enum(["starting", "observing", "backoff", "blocked", "stopped"]),
    observed_at: z.string().nullable(),
    detail: z.string().nullable(),
  }),
  inbox: z.object({
    state: z.enum(["empty", "queued", "blocked", "restoring_conversation", "waiting_for_desktop_credentials"]),
    pending_count: nonNegativeSafeInt,
    blocked_by_message_id: z.string().nullable(),
    detail: z.string().nullable(),
  }),
  turn: z.object({
    state: z.enum(["idle", "dispatching", "responding", "publishing", "retrying", "failed"]),
    inbox_item_id: z.string().nullable(),
    source_message_id: z.string().nullable(),
    provider_turn_id: z.string().nullable(),
    detail: z.string().nullable(),
  }),
  task: z.object({
    state: z.enum(["none", "assigned", "working", "blocked"]),
    task_id: z.string().nullable(),
    title: z.string().nullable(),
  }),
});

export const deliveryAttentionSchema = z.object({
  reason: z.literal("message_blocked"),
  source_message_id: z.string(),
  blocked_since: z.string(),
  detail: z.string().nullable(),
  waiting_count: nonNegativeSafeInt,
  provider_work_started: z.boolean(),
  retry: z.enum(["reread_saved_turn", "publish_saved_reply", "start_turn", "restore_conversation"]),
  can_skip: z.boolean(),
  skip_unavailable_reason: z.string().nullable(),
});

export const deliveryReceiptTimelinePhaseSchema = z.enum([
  "received",
  "queued",
  "turn_started",
  "turn_finished",
  "result_unreadable",
  "publish_started",
  "published",
  "no_reply",
  "retry_scheduled",
  "blocked",
  "room_move_cancelled",
  "conversation_restoring",
  "conversation_restored",
  "user_cancelled",
]);

export const deliveryReceiptSchema = z.object({
  inbox_item_id: z.string(),
  source_message_id: z.string(),
  fifo_sequence: positiveSafeInt,
  reply_client_message_id: z.string(),
  canonical_message_id: z.string().nullable(),
  state: z.enum([
    "pending",
    "dispatching",
    "awaiting_result",
    "result_recovery",
    "publishing",
    "acknowledged",
    "acknowledged_no_reply",
    "acknowledged_failed",
    "retryable",
    "blocked",
    "restoring_conversation",
    "cancelled_by_room_move",
    "cancelled_by_user",
    "queued_behind_blocked",
  ]),
  attempt_count: nonNegativeSafeInt,
  provider_turn_id: z.string().nullable(),
  blocked_by_message_id: z.string().nullable(),
  error: z.string().nullable(),
  failure_code: z.literal("provider_continuation_missing").nullable(),
  terminal_reason: z.literal("upgrade_authority_unavailable").nullable(),
  updated_at: z.string(),
  follow_up: z.object({
    for_message_id: z.string().nullable(),
    state: z.enum(["scheduled", "waiting_for_owner", "ended"]),
    reason: followUpReasonSchema.optional(),
    later_person_turn: z.boolean().optional(),
    scheduled: z.object({
      at_ms: positiveSafeInt,
      attempt: positiveSafeInt,
      attempts: positiveSafeInt,
      kind: z.enum(["provider_fault", "no_reply"]),
    }).nullable(),
  }).optional(),
  timeline: z.array(z.object({
    event_sequence: positiveSafeInt,
    phase: deliveryReceiptTimelinePhaseSchema,
    observed_at: z.string(),
    detail: z.string().nullable(),
  })),
});

export const daemonManifestEntrySchema = z.object({
  id: z.string(),
  avatar: agentAvatarSchema.nullable().optional(),
  room_id: z.string(),
  local_room_id: z.string().optional(),
  display_name: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  reasoning_effort: reasoningEffortSchema.nullable().optional(),
  charter: z.string(),
  config_revision: positiveSafeInt.optional(),
  runtime_configuration_revision: positiveSafeInt.optional(),
  desired_state: desiredStateSchema,
  observed_state: observedStateSchema,
  condition: policyConditionSchema,
  last_error: z.string().nullable().optional(),
  permission_profile_id: z.string().nullable(),
  delivery_mode: daemonAgentDeliveryModeSchema.optional(),
  provider_launch_policy: jsonValueSchema.optional(),
  created_by: z.string(),
  created_at: z.string(),
  source_repo_path: z.string().nullable().optional(),
  workspace_path: z.string().nullable().optional(),
  work_attempt_id: z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
  deployment_id: z.string().nullable().optional(),
  provider_ref: daemonProviderRuntimeReferenceSchema.nullable().optional(),
  workplace_liveness: z.object({
    state: workplaceReachabilitySchema,
    observed_at: z.string().nullable(),
    detail: z.string().nullable(),
  }).optional(),
  native_liveness: z.object({
    state: nativeExecutionActivitySchema,
    observed_at: z.string().nullable(),
    detail: z.string().nullable(),
  }).optional(),
  ready_reached_at: z.string().nullable().optional(),
  activity: z.array(daemonActivityEventSchema).optional(),
  last_turn_control_sequence: nonNegativeSafeInt.optional(),
  turn_control: daemonTurnControlEffectSchema.nullable().optional(),
  last_worker_binding: daemonWorkerBindingProjectionSchema.nullable().optional(),
  reconciliation: reconciliationStateSchema.optional(),
  reconciliation_notices: z.array(reconciliationNoticeSchema).optional(),
});
export type DaemonManifestEntry = z.infer<typeof daemonManifestEntrySchema>;

export const daemonManifestEntryViewSchema = daemonManifestEntrySchema.extend({
  provider_progress: z.object({
    state: z.literal("compacting"),
    startedAt: z.string(),
  }).nullable().optional(),
  launch_progress: launchProgressViewSchema.nullable().optional(),
  background_commands: z.array(runningBackgroundCommandSchema).optional(),
  runtime_recovery: z.object({
    operationId: z.string(),
    roomId: z.string(),
    executionGenerationId: z.string(),
    runtimeGenerationId: z.string(),
    mode: z.enum(["resume", "fresh"]),
    phase: z.enum(["prepared", "stopped"]),
  }).nullable().optional(),
  runtime_generation_id: z.string().nullable().optional(),
  home_harness: homeHarnessStateSchema.optional(),
  permission_pending: z.literal(true).optional(),
  worker_binding: daemonWorkerBindingProjectionSchema.nullable().optional(),
  room_agent_state: roomAgentStateSchema.nullable().optional(),
  delivery_attention: deliveryAttentionSchema.nullable().optional(),
  delivery_receipts: z.array(deliveryReceiptSchema).optional(),
});
export type DaemonManifestEntryView = z.infer<typeof daemonManifestEntryViewSchema>;

// ---------------------------------------------------------------------------
// State watch, stream watch, room move, configuration, attempt, inspector
// ---------------------------------------------------------------------------

export const daemonStateWatchSnapshotSchema = z.object({
  daemon_generation: positiveSafeInt,
  sequence: positiveSafeInt,
  entries: z.array(daemonManifestEntryViewSchema),
});

export const daemonStateWatchChangesSchema = z.object({
  daemon_generation: positiveSafeInt,
  sequence: positiveSafeInt,
  complete: z.literal(false),
  entries: z.array(daemonManifestEntryViewSchema),
  removed_entry_ids: z.array(z.string()),
  entry_order: z.array(z.string()),
});

export const daemonStateWatchResultSchema = z.union([
  daemonStateWatchChangesSchema,
  daemonStateWatchSnapshotSchema,
]);
export type DaemonStateWatchWireResult = z.infer<typeof daemonStateWatchResultSchema>;

export const daemonRoomMovePhaseSchema = z.enum([
  "prepared",
  "waiting_for_current_turn",
  "joining_destination",
  "membership_committed",
  "rotating_credentials",
  "bootstrapping_destination_tail",
  "active",
  "failed",
  "rollback_required",
]);
export type DaemonRoomMovePhase = z.infer<typeof daemonRoomMovePhaseSchema>;

export const daemonRoomMoveRecordSchema = z.object({
  operation_id: z.string(),
  request_id: z.string(),
  agent_id: z.string(),
  source_room_id: z.string(),
  destination_room_id: z.string(),
  daemon_generation: positiveSafeInt,
  work_attempt_id: z.string().nullable(),
  execution_generation_id: z.string().nullable(),
  agent_session_id: z.string().nullable(),
  activating_inbox_item_id: z.string().nullable(),
  provider_turn_id: z.string().nullable(),
  effect_id: z.string().nullable(),
  phase: daemonRoomMovePhaseSchema,
  remote_room_id: z.string().nullable(),
  destination_cursor: z.string().nullable(),
  source_credentials_revoked: z.boolean(),
  source_cursor_present: z.boolean(),
  source_cursor: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type DaemonRoomMoveRecord = z.infer<typeof daemonRoomMoveRecordSchema>;

export const supervisedPermissionProfileSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  status: z.enum(["available", "gated", "unsupported"]),
  risk: z.enum(["low", "medium", "high"]),
  detail: z.string().nullable(),
  isDefault: z.boolean(),
});

export const daemonAgentConfigurationViewSchema = z.object({
  entry_id: z.string(),
  daemon_generation: positiveSafeInt,
  provider: z.string(),
  model: z.string().nullable(),
  reasoning_effort: reasoningEffortSchema.nullable(),
  charter: z.string(),
  permission_profile_id: z.string().nullable(),
  supervised_permission_profiles: z.array(supervisedPermissionProfileSchema),
  provider_launch_policy: jsonRecordSchema,
  config_revision: positiveSafeInt,
  runtime_configuration_revision: positiveSafeInt,
  home_harness: z.boolean().optional(),
  home_harness_pending: z.boolean().optional(),
  home_harness_availability: z.enum(["available", "rental", "unsupported", "polling"]).optional(),
  image_input: z.boolean().optional(),
  image_input_available: z.boolean().optional(),
  share_live_activity: z.boolean().optional(),
  live_sharing_availability: z.enum(["available", "rental", "polling"]).optional(),
});
export type DaemonAgentConfigurationView = z.infer<typeof daemonAgentConfigurationViewSchema>;

export const daemonAgentConfigurationUpdateResultSchema = z.union([
  z.object({
    outcome: z.enum(["updated", "conflict"]),
    configuration: daemonAgentConfigurationViewSchema,
  }),
  z.object({
    outcome: z.literal("invalid"),
    error: z.string(),
  }),
]);

export const daemonAgentConfigurationApplyResultSchema = z.object({
  outcome: z.enum(["already_applied", "restarting", "busy_active_turn", "conflict", "unsupported"]),
});

export const daemonRetireAgentResultSchema = z.union([
  z.object({ outcome: z.literal("retired") }),
  z.object({
    outcome: z.literal("revocation_required"),
    revocation_kind: z.literal("worker_session"),
    agent_session_id: z.string(),
  }),
  z.object({
    outcome: z.literal("revocation_required"),
    revocation_kind: z.literal("grant_only"),
  }),
  z.object({
    outcome: z.literal("invalid"),
    error: z.string(),
  }),
]);

export const daemonPurgeAgentResultSchema = z.union([
  z.object({
    outcome: z.literal("purged"),
    purged_work_attempt_id: z.string().optional(),
  }),
  z.object({
    outcome: z.literal("revocation_required"),
    operation_id: z.string(),
    revocation_kind: z.literal("worker_session"),
    agent_session_id: z.string(),
  }),
  z.object({
    outcome: z.literal("revocation_required"),
    operation_id: z.string(),
    revocation_kind: z.literal("grant_only"),
  }),
  z.object({
    outcome: z.literal("invalid"),
    error: z.string(),
  }),
]);

export const daemonAttemptDetailSchema = z.object({
  entry_id: z.string(),
  work_attempt_id: z.string().nullable(),
  workspace_path: z.string().nullable(),
  last_terminal: executionTerminalPayloadSchema.nullable(),
  restart_count: nonNegativeSafeInt,
  activity: z.array(daemonActivityEventSchema),
});

export const daemonInspectorDetailSchema = z.looseObject({
  availability: z.enum(["available", "pruned", "not_loaded"]),
  entry_id: z.string(),
  room_id: z.string(),
  requested_source_message_id: z.string().nullable(),
  inbox_item_id: z.string().nullable(),
  source_message: jsonRecordSchema.nullable(),
  receipt: jsonRecordSchema.nullable(),
  terminal: jsonRecordSchema.nullable(),
  publication: jsonRecordSchema.nullable(),
  continuation_repair: jsonRecordSchema.nullable().optional(),
  timeline: z.array(jsonRecordSchema),
  items: z.array(jsonRecordSchema),
  uncertain_effects: z.array(jsonRecordSchema).optional(),
  history_boundary: jsonRecordSchema.nullable(),
  recorded_execution: jsonRecordSchema.optional(),
  prepared_context: jsonRecordSchema.nullable().optional(),
  latest_intervention: jsonRecordSchema.nullable().optional(),
  runtime_control: jsonRecordSchema.nullable().optional(),
  usage: jsonRecordSchema.nullable().optional(),
});

// ---------------------------------------------------------------------------
// Host approval authentication & signed operations
// ---------------------------------------------------------------------------

export const hostApprovalIdSchema = z.string().min(1).max(256);
export const hostApprovalShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const hostApprovalStatusSchema = z.enum([
  "pending",
  "decision_recorded",
  "decision_sent",
  "uncertain",
  "request_closed",
  "resolved",
  "unavailable",
]);

export const hostApprovalChallengeSchema = z.strictObject({
  daemonGeneration: positiveSafeInt,
  bootNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  keyFingerprint: hostApprovalShaSchema,
});
export type HostApprovalChallengeWire = z.infer<typeof hostApprovalChallengeSchema>;

export const signedHostApprovalRequestSchema = z.strictObject({
  payload: z.string(),
  signature: z.string(),
});
export type SignedHostApprovalRequestWire = z.infer<typeof signedHostApprovalRequestSchema>;

export const hostToolLabelSchema = hostApprovalIdSchema.regex(
  /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/,
);

export const projectHostToolScopeSchema = z.strictObject({
  agentId: hostApprovalIdSchema,
  accountId: hostApprovalIdSchema,
  projectId: hostApprovalShaSchema,
  projectName: hostToolLabelSchema,
  sourceRepoPath: z.string().min(1).max(4096),
  canonicalSourcePath: z.string().min(1).max(4096),
  repository: z.string().min(1).max(4096),
  remoteUrl: z.string().min(1).max(4096),
  provider: z.enum(["codex", "claude-code", "open-model"]),
  toolId: hostApprovalIdSchema,
  toolLabel: hostToolLabelSchema,
  policySha256: hostApprovalShaSchema,
});

export const roomWorkspaceHostToolScopeSchema = z.strictObject({
  kind: z.literal("room_workspace"),
  version: z.literal(1),
  agentId: hostApprovalIdSchema,
  accountId: hostApprovalIdSchema,
  roomId: hostApprovalIdSchema,
  workAttemptId: z.string().uuid(),
  workspacePath: z.string().min(1).max(4096),
  canonicalWorkspacePath: z.string().min(1).max(4096),
  provider: z.enum(["codex", "claude-code", "open-model"]),
  toolId: hostApprovalIdSchema,
  toolLabel: hostToolLabelSchema,
  policySha256: hostApprovalShaSchema,
});

export const hostToolScopeSchema = z.union([
  projectHostToolScopeSchema,
  roomWorkspaceHostToolScopeSchema,
]);

export const hostToolRuleSchema = z.strictObject({
  id: hostApprovalIdSchema,
  revision: positiveSafeInt,
  ownerId: hostApprovalIdSchema,
  scope: hostToolScopeSchema,
  createdAtMs: nonNegativeSafeInt,
});

export const hostApprovalReferenceSchema = z.strictObject({
  requestId: hostApprovalIdSchema,
  requestVersion: positiveSafeInt,
  requestSha256: hostApprovalShaSchema,
  agentId: hostApprovalIdSchema,
  roomId: hostApprovalIdSchema,
  executionGenerationId: hostApprovalIdSchema,
  runtimeGenerationId: hostApprovalIdSchema,
  turnId: hostApprovalIdSchema,
  providerContinuationId: hostApprovalIdSchema,
  providerTurnId: hostApprovalIdSchema,
  connectionId: hostApprovalIdSchema,
  nativeRequestId: z.union([hostApprovalIdSchema, nonNegativeSafeInt]),
});

export const hostApprovalCandidateSchema = z.strictObject({
  reference: hostApprovalReferenceSchema.nullable(),
  presentation: z.strictObject({
    agentId: hostApprovalIdSchema,
    displayName: z.string().max(256),
    provider: z.enum(["codex", "open-model", "claude-code"]),
    title: z.enum(["Run a command", "Run a tool", "Change files", "Grant for this turn", "Approval unavailable"]),
    details: z.string().max(24 * 1024),
    denyScope: z.enum(["request", "session_pending"]),
    alwaysAllow: hostToolScopeSchema.optional(),
  }),
  status: hostApprovalStatusSchema,
  detail: z.string().max(1024).nullable(),
  recordedDecision: z.strictObject({
    decisionId: hostApprovalIdSchema,
    actorId: hostApprovalIdSchema,
    decision: z.enum(["allow_once", "deny"]),
    projectionSha256: hostApprovalShaSchema.nullable(),
  }).nullable(),
});

export const hostApprovalOperationSchemas = {
  list: {
    input: z.strictObject({ roomId: z.string() }),
    result: z.array(hostApprovalCandidateSchema),
    invalidInputMessage: "An exact approval room is required.",
  },
  decide: {
    input: z.strictObject({
      expected: hostApprovalReferenceSchema,
      decisionId: hostApprovalIdSchema,
      actorId: hostApprovalIdSchema,
      decision: z.enum(["allow_once", "deny", "allow_always"]),
      projectionSha256: hostApprovalShaSchema,
    }),
    result: hostApprovalStatusSchema,
  },
  list_tool_rules: {
    input: z.strictObject({ agentId: hostApprovalIdSchema }),
    result: z.array(hostToolRuleSchema),
  },
  revoke_tool_rule: {
    input: z.strictObject({
      agentId: hostApprovalIdSchema,
      ruleId: hostApprovalIdSchema,
      revision: positiveSafeInt,
    }),
    result: jsonValueSchema,
  },
  set_home_harness: {
    input: z.strictObject({
      entryId: exactNonEmptyString,
      daemonGeneration: positiveSafeInt,
      expectedRevision: positiveSafeInt,
      enabled: z.boolean(),
    }),
    result: z.union([
      z.object({
        outcome: z.enum(["updated", "conflict"]),
        configuration: daemonAgentConfigurationViewSchema,
        apply: z.string().optional(),
      }),
      z.object({
        outcome: z.literal("invalid"),
        error: z.string(),
      }),
    ]),
    invalidInputMessage:
      "Changing an agent's use of your own setup requires an exact agent, the current daemon generation, a positive expected revision and a choice.",
  },
  set_live_sharing: {
    input: z.strictObject({
      entryId: exactNonEmptyString,
      daemonGeneration: positiveSafeInt,
      enabled: z.boolean(),
    }),
    result: z.union([
      z.object({
        outcome: z.literal("updated"),
        configuration: daemonAgentConfigurationViewSchema,
      }),
      z.object({
        outcome: z.literal("invalid"),
        error: z.string(),
      }),
    ]),
    invalidInputMessage:
      "Sharing an agent's live activity requires an exact agent, the current daemon generation and a choice.",
  },
  stop_background_command: {
    input: z.strictObject({
      entryId: exactNonEmptyString,
      daemonGeneration: positiveSafeInt,
      taskId: exactNonEmptyString,
    }),
    result: z.union([
      z.object({ outcome: z.enum(["stopping", "not_running", "failed"]) }),
      z.object({ outcome: z.literal("invalid"), error: z.string() }),
    ]),
    invalidInputMessage:
      "Stopping a background command requires an exact agent, the current daemon generation and a command.",
  },
} as const;

export type HostApprovalSignedOperation = keyof typeof hostApprovalOperationSchemas;
