import type { AgentAvatar } from "../../../shared/agent-avatar.mjs";
import {
  DAEMON_IMPLEMENTATION_VERSION,
  DAEMON_PROTOCOL_VERSION,
  type DaemonActivityEvent,
  type DaemonAgentDeliveryMode,
  type DaemonAgentStreamEvent,
  type DaemonManifestEntry,
  type DaemonManifestEntryView,
  type DaemonProviderConnection,
  type DaemonProviderRuntimeReference,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonRoomMovePhase,
  type DaemonRoomMoveRecord,
  type DaemonTurnControlEffect,
  type DaemonWorkerBindingProjection,
  type DesiredState,
  type ExecutionTerminalPayload,
  type NativeExecutionActivity,
  type ObservedState,
  type PolicyCondition,
  type ReconciliationNotice,
  type ReconciliationState,
  type WorkplaceReachability,
} from "#daemon-contract/index.js";

export {
  DAEMON_IMPLEMENTATION_VERSION,
  DAEMON_PROTOCOL_VERSION,
};
export type {
  DaemonActivityEvent,
  DaemonAgentDeliveryMode,
  DaemonAgentStreamEvent,
  DaemonManifestEntry,
  DaemonManifestEntryView,
  DaemonProviderConnection,
  DaemonProviderRuntimeReference,
  DaemonRequest,
  DaemonResponse,
  DaemonRoomMovePhase,
  DaemonRoomMoveRecord,
  DaemonTurnControlEffect,
  DaemonWorkerBindingProjection,
  DesiredState,
  ExecutionTerminalPayload,
  NativeExecutionActivity,
  ObservedState,
  PolicyCondition,
  ReconciliationNotice,
  ReconciliationState,
  WorkplaceReachability,
};

export type DaemonLivenessAxis<TState extends string> = {
  state: TState;
  observed_at: string | null;
  detail: string | null;
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
  avatar?: AgentAvatar | null;
  display_name: string;
};

/** Room membership is durable but independent of both identity and runtime. */
export type DaemonAgentRoomMembership = {
  agent_id: string;
  room_id: string;
  /** Pinned local storage identity; absent means the existing cloud transport. */
  local_room_id?: string;
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
  /** Explicit inbox owner; daemon_inbox is the sole supervised delivery mode. */
  delivery_mode?: DaemonAgentDeliveryMode;
  /** Provider-native policy selected in Add Agent; passed through unchanged. */
  provider_launch_policy?: unknown;
  /**
   * The owner says this agent's model reads images. Only an Open Model agent
   * uses it; it applies the next time the agent starts. Inspector-owned, like
   * the revisions, so never taken from the flat manifest.
   */
  image_input?: boolean;
  /**
   * Whether the owner shares this agent's live activity with the room; while
   * "withdrawing", the room may still show earlier turns that the daemon must
   * remove. Off unless the owner turns it on in the desktop app;
   * database-owned, like the revisions, so never taken from the flat manifest.
   */
  live_sharing?: "off" | "on" | "withdrawing";
};

/** Requested launch/control state. This is intent, not agent identity or observed runtime. */
export type DaemonAgentLaunchIntent = {
  agent_id: string;
  desired_state: DesiredState;
  /** Read-only source checkout used only to resolve remote + revision. */
  source_repo_path?: string | null;
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
  last_turn_control_sequence: number;
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

export type DaemonManifest = {
  entries: DaemonManifestEntry[];
  /** Per-agent optimistic concurrency version from `agents.version`. */
  versions?: Record<string, number>;
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

export type WorkAttemptState = "active" | "ambiguous" | "coordination_blocked" | "quarantined" | "unreviewed" | "cleanly_concluded" | "abandoned" | "gc_pending" | "garbage_collected";

export type LeaseEpoch = { lease_id: string; epoch: number; recorded_at: string };

export type WorkAttemptCheckpoint = {
  at: string;
  room_cursor: string | null;
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
