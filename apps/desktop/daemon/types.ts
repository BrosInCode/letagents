export const DAEMON_PROTOCOL_VERSION = 2;
export const DAEMON_IMPLEMENTATION_VERSION = "2.0.77";

export type DesiredState = "running" | "paused" | "stopped";
export type ObservedState = "absent" | "starting" | "idle" | "working" | "checkpointing" | "pausing" | "paused" | "recovering" | "stopping" | "stopped" | "failed";
export type PolicyCondition = "none" | "quarantined" | "coordination_blocked" | "auth_blocked" | "budget_blocked" | "security_blocked";

/** Persisted by the daemon so a restart cannot erase crash-loop/backoff state. */
export type ReconciliationState = {
  /** Terminal process exits only; this rolling window determines quarantine. */
  exit_timestamps_ms: number[];
  /** Consecutive failed recovery actions only; this determines retry backoff. */
  consecutive_action_failures: number;
  last_observed_state: ObservedState;
  next_restart_at_ms: number | null;
  /** Bounded action journal: rejects replayed or out-of-order provider calls. */
  completed_action_ids: string[];
  last_action_sequence: number;
  pending_action: { id: string; sequence: number; kind: "poke" | "restart_fresh" | "restart_with_resume" | "stop"; recorded_at_ms: number } | null;
  /** Most recent immutable provider death evidence; copied into escalations. */
  last_terminal?: ExecutionTerminalPayload;
};

export type ReconciliationNotice = { at: string; kind: "quarantine_death" | "coordination_escalation"; cause: string; terminal?: ExecutionTerminalPayload };

export type WorkplaceReachability = "reachable" | "stale" | "unknown";
export type NativeExecutionActivity = "active" | "idle" | "stale" | "terminal" | "unknown";

export type DaemonLivenessAxis<TState extends string> = {
  state: TState;
  observed_at: string | null;
  detail: string | null;
};

/** Bounded, redacted provider evidence. This is activity, never hidden thoughts. */
export type DaemonActivityEvent = {
  observed_at: string;
  sequence: number;
  provider: string;
  kind: string;
  method: string;
  summary: string;
  status: "idle" | "working" | "reviewing" | "blocked";
  payload: unknown;
  payload_truncated: boolean;
  payload_redacted: boolean;
  durable_payload_ref: string | null;
};

/**
 * Renderer-safe projection of the daemon-private worker binding. Credentials
 * and API authority never leave WorkerBindingStore; this identity-only view
 * lets UI controls resolve a room worker to one exact supervisor entry.
 */
export type DaemonWorkerBindingProjection = {
  agent_session_id: string;
  work_attempt_id: string;
  execution_generation_id: string;
  updated_at: string;
};

/** Stable identity plus creation provenance; everything else may change independently. */
export type DaemonAgentIdentity = {
  agent_id: string;
  created_by: string;
  created_at: string;
};

/** Mutable presentation metadata for one stable agent identity. */
export type DaemonAgentProfile = {
  agent_id: string;
  display_name: string;
};

/** Room membership is durable but independent of both identity and runtime. */
export type DaemonAgentRoomMembership = {
  agent_id: string;
  room_id: string;
};

export type DaemonRoomMovePhase = "prepared" | "waiting_for_current_turn" | "joining_destination" | "membership_committed" | "rotating_credentials" | "bootstrapping_destination_tail" | "active" | "failed" | "rollback_required";
export type DaemonRoomMoveRecord = {
  operation_id: string;
  request_id: string;
  agent_id: string;
  source_room_id: string;
  destination_room_id: string;
  daemon_generation: number;
  work_attempt_id: string | null;
  execution_generation_id: string | null;
  agent_session_id: string | null;
  activating_inbox_item_id: string | null;
  provider_turn_id: string | null;
  effect_id: string | null;
  phase: DaemonRoomMovePhase;
  remote_room_id: string | null;
  destination_cursor: string | null;
  /** Electron durably acknowledged revocation of the exact source session. */
  source_credentials_revoked: boolean;
  /** Exact pre-move ingress authority captured by the prepare transaction. */
  source_cursor_present: boolean;
  source_cursor: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type DaemonPurgePhase = "prepared" | "reprepare_credentials" | "revoking_credentials" | "local_commit" | "complete" | "failed";
export type DaemonPurgeWorkerSessionAttestation = "exact" | "none" | "unknown" | "not_required";
export type DaemonPurgeRecord = {
  operation_id: string;
  request_id: string;
  agent_id: string;
  daemon_generation: number;
  phase: DaemonPurgePhase;
  external_revoke_required: boolean;
  /** Exact runtime attachment captured by the preparation transaction. */
  attached_work_attempt_id: string | null;
  /** Filesystem location retained after its durable attempt row is removed. */
  preserved_workspace_path: string | null;
  /** Durable proof of an exact session, no minted session, or missing legacy evidence. */
  worker_session_attestation: DaemonPurgeWorkerSessionAttestation;
  /** Exact worker session whose bearer must be ended before purge commit. */
  agent_session_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

/** Provider behavior, charter, and authority selected for an agent. */
export type DaemonAgentConfiguration = {
  agent_id: string;
  provider: string;
  model: string | null;
  /** Provider-native reasoning setting, applied when a provider runtime starts. */
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  charter: string;
  permission_profile_id: string | null;
  /** Monotonic editor revision. Configuration is never inferred from runtime. */
  config_revision?: number;
  /** Revision most recently consumed by the current provider runtime. */
  runtime_configuration_revision?: number;
  /** Explicit inbox owner; never infer daemon delivery from native policy. */
  delivery_mode?: DaemonAgentDeliveryMode;
  /** Present only while a legacy Codex polling turn is being fenced. */
  delivery_cutover?: DaemonDeliveryCutover | null;
  /** Provider-native policy selected in Add Agent; passed through unchanged. */
  provider_launch_policy?: unknown;
};

/** Durable owner of room ingress for one supervised provider execution. */
export type DaemonAgentDeliveryMode = "mcp_polling" | "desktop_events" | "daemon_inbox";

/** Durable one-way handoff from legacy polling to daemon-owned ingress. */
export type DaemonDeliveryCutover = {
  work_attempt_id: string;
  execution_generation_id: string;
  provider_continuation_id: string;
  /** Null only before the one permitted active-turn discovery completes. */
  provider_turn_id: string | null;
  phase: "prepared" | "dispatching" | "uncertain";
  /** Redacted operator-facing reason when the handoff remains fenced. */
  error?: string | null;
  updated_at: string;
};

/** Requested launch/control state. This is intent, not agent identity or observed runtime. */
export type DaemonAgentLaunchIntent = {
  agent_id: string;
  desired_state: DesiredState;
  /** Read-only source checkout used only to resolve remote + revision. */
  source_repo_path?: string | null;
};

/** Process evidence owned by one replaceable provider deployment. */
export type DaemonProviderConnection =
  | { kind: "codex_app_server"; url: string; pid: number | null; processIdentity?: string | null }
  | { kind: "claude_cli"; pid: number | null; processIdentity?: string | null }
  | { kind: "cursor_cli"; pid: number | null; processIdentity?: string | null }
  | { kind: "opencode_server"; url: string; pid: number | null; processIdentity?: string | null; serverAuthPath: string };

export type DaemonProviderRuntimeReference = {
  work_attempt_id: string;
  provider_continuation_id: string;
  provider_connection: DaemonProviderConnection | null;
  execution_generation_id: string;
};

/** Durable human turn-control effect journal for one agent. */
export type DaemonTurnControlEffect = {
  action_id: string;
  work_attempt_id: string;
  execution_generation_id: string;
  /** Exact native turn fenced before the first interrupt side effect. */
  provider_turn_id?: string | null;
  has_correction: boolean;
  status: "prepared" | "dispatching" | "completed" | "retryable" | "uncertain";
  capability: "native_interrupt" | "restart_resume" | "unsupported";
  interrupted: boolean | null;
  resumed: boolean | null;
  state: "idle" | "working" | null;
  stages: Array<"delivered" | "interrupting" | "applied" | "resumed" | "already_applied">;
  error: string | null;
  recorded_at: string;
  updated_at: string;
};

/**
 * Replaceable runtime placement, process, and liveness facts.
 *
 * A launched deployment receives its own `run_id` and `deployment_id`, initially
 * derived from the provider execution generation and stable agent id. They are
 * durable deployment identity and survive detachment of the optional provider
 * reference. Both remain null before the first provider execution exists.
 */
export type DaemonRuntimeDeployment = {
  agent_id: string;
  run_id: string | null;
  deployment_id: string | null;
  observed_state: ObservedState;
  workspace_path?: string | null;
  work_attempt_id?: string | null;
  provider_ref?: DaemonProviderRuntimeReference | null;
  workplace_liveness?: DaemonLivenessAxis<WorkplaceReachability>;
  native_liveness?: DaemonLivenessAxis<NativeExecutionActivity>;
  activity?: DaemonActivityEvent[];
};

export type DaemonAgentLifecycleState = {
  agent_id: string;
  condition: PolicyCondition;
  /** Latest actionable lifecycle failure, retained for Inspector/conflict UX. */
  last_error?: string | null;
};

/** Set-once evidence that an agent launch reached ready. */
export type DaemonAgentReadinessRecord = {
  agent_id: string;
  ready_reached_at?: string | null;
};

/** Accepted turn-control effects are durable and are never blindly replayed. */
export type DaemonTurnControlJournalRecord = {
  agent_id: string;
  turn_control?: DaemonTurnControlEffect | null;
};

/** Last verified room-worker binding, retained after live credentials unbind. */
export type DaemonRetainedWorkerBindingRecord = {
  agent_id: string;
  last_worker_binding?: DaemonWorkerBindingProjection | null;
};

/** Crash-loop/backoff state and operator-visible reconciliation notices. */
export type DaemonReconciliationRecord = {
  agent_id: string;
  reconciliation?: ReconciliationState;
  reconciliation_notices?: ReconciliationNotice[];
};

/**
 * Backward-compatible flat manifest wire contract. Domain code should project
 * this transport record into the narrower records above before reasoning about
 * identity, configuration, runtime, or lifecycle ownership.
 */
export type DaemonManifestEntry = {
  id: string;
  room_id: string;
  display_name: string;
  provider: string;
  model: string | null;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  charter: string;
  config_revision?: number;
  runtime_configuration_revision?: number;
  desired_state: DesiredState;
  observed_state: ObservedState;
  condition: PolicyCondition;
  last_error?: string | null;
  permission_profile_id: string | null;
  delivery_mode?: DaemonAgentDeliveryMode;
  delivery_cutover?: DaemonDeliveryCutover | null;
  provider_launch_policy?: unknown;
  created_by: string;
  created_at: string;
  source_repo_path?: string | null;
  workspace_path?: string | null;
  work_attempt_id?: string | null;
  /** Durable runtime identity, explicit when it cannot be derived from provider_ref. */
  run_id?: string | null;
  deployment_id?: string | null;
  provider_ref?: DaemonProviderRuntimeReference | null;
  workplace_liveness?: DaemonLivenessAxis<WorkplaceReachability>;
  native_liveness?: DaemonLivenessAxis<NativeExecutionActivity>;
  ready_reached_at?: string | null;
  activity?: DaemonActivityEvent[];
  turn_control?: DaemonTurnControlEffect | null;
  last_worker_binding?: DaemonWorkerBindingProjection | null;
  reconciliation?: ReconciliationState;
  reconciliation_notices?: ReconciliationNotice[];
};

export type DaemonManifestEntryView = DaemonManifestEntry & {
  worker_binding?: DaemonWorkerBindingProjection | null;
  /** Ephemeral causal delivery projection; never persisted in the manifest. */
  room_agent_state?: {
    connection: { state: "connected" | "reconnecting" | "disconnected"; observed_at: string | null; detail: string | null };
    ingress: { state: "starting" | "observing" | "backoff" | "blocked" | "stopped"; observed_at: string | null; detail: string | null };
    inbox: { state: "empty" | "queued" | "blocked" | "restoring_conversation" | "waiting_for_desktop_credentials"; pending_count: number; blocked_by_message_id: string | null; detail: string | null };
    turn: { state: "idle" | "dispatching" | "responding" | "publishing" | "retrying" | "failed"; inbox_item_id: string | null; source_message_id: string | null; provider_turn_id: string | null; detail: string | null };
    task: { state: "none" | "assigned" | "working" | "blocked"; task_id: string | null; title: string | null };
  } | null;
  delivery_receipts?: Array<{
    inbox_item_id: string; source_message_id: string;
    /** Deterministic publication identity used even before a canonical id was checkpointed. */
    reply_client_message_id: string;
    /** Exact room message created by this inbox item's final-answer publication. */
    canonical_message_id: string | null;
    state: "pending" | "dispatching" | "awaiting_result" | "result_recovery" | "publishing" | "acknowledged" | "acknowledged_no_reply" | "retryable" | "blocked" | "restoring_conversation" | "cancelled_by_room_move" | "cancelled_by_user" | "queued_behind_blocked";
    attempt_count: number; provider_turn_id: string | null; blocked_by_message_id: string | null; error: string | null; failure_code: "provider_continuation_missing" | null; updated_at: string;
    timeline: Array<{ phase: "received" | "queued" | "turn_started" | "turn_finished" | "result_unreadable" | "publish_started" | "published" | "no_reply" | "retry_scheduled" | "blocked" | "room_move_cancelled" | "conversation_restoring" | "conversation_restored" | "user_cancelled"; observed_at: string; detail: string | null }>;
  }>;
};

/** Durable mixed-engine fence for a legacy Electron-owned provider lane. */
export type LegacyLaneOwner = {
  reservation_id: string;
  room_id: string;
  provider: string;
  /** Electron process that owns an in-flight reservation. */
  owner_pid: number;
  /** Birth identity prevents a recycled PID from preserving an orphan fence. */
  owner_process_identity: string;
  state: "reserved" | "active";
  session_id: string | null;
  created_at: string;
  updated_at: string;
};

export type DaemonManifest = {
  generation: number;
  entries: DaemonManifestEntry[];
  legacy_lane_owners?: LegacyLaneOwner[];
};

export type Transition = {
  at: string;
  entry_id: string;
  from: ObservedState;
  to: ObservedState;
  cause: string;
  actor: string;
  generation: number;
};

export type DaemonRequest = { version: number; id?: string; method: string; params?: unknown };
export type DaemonResponse = { version: number; id?: string; ok: boolean; result?: unknown; error?: string };

export type WorkAttemptState = "active" | "ambiguous" | "coordination_blocked" | "quarantined" | "unreviewed" | "cleanly_concluded" | "abandoned" | "gc_pending" | "garbage_collected";

export type LeaseEpoch = { lease_id: string; epoch: number; recorded_at: string };

export type WorkAttemptCheckpoint = {
  at: string;
  room_cursor: string | null;
  provider_continuation_id: string | null;
};

export type ExecutionTerminalPayload = {
  ended_at: string;
  exit_code: number | null;
  signal: string | null;
  stdio_archive_ref: string | null;
  stdio_tail: string;
  terminal_cause: string;
  actor: string;
  generation: number;
  provider_continuation_id: string | null;
};

export type ExecutionGeneration = {
  execution_generation_id: string;
  work_attempt_id: string;
  started_at: string;
  actor: string;
  generation: number;
  terminal: ExecutionTerminalPayload | null;
};

/** Immutable Git identity captured by the provisioner before a work attempt exists. */
export type WorkspaceIdentity = {
  repo: string;
  remote_url: string;
  resolved_revision: string;
  bare_path: string;
};

export type TaskWorkAttempt = {
  work_attempt_id: string;
  task_id: string;
  lease_id: string;
  current_lease_epoch: number;
  epoch_history: LeaseEpoch[];
  workspace_path: string;
  workspace_identity: WorkspaceIdentity;
  state: WorkAttemptState;
  created_at: string;
  concluded_at: string | null;
  conclusion_cause: string | null;
  postmortem_diff: string | null;
  checkpoints: WorkAttemptCheckpoint[];
  execution_generations: ExecutionGeneration[];
};
