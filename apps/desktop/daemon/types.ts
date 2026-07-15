export const DAEMON_PROTOCOL_VERSION = 2;
export const DAEMON_IMPLEMENTATION_VERSION = "2.0.11";

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

export type DaemonManifestEntry = {
  id: string;
  room_id: string;
  display_name: string;
  provider: string;
  model: string | null;
  charter: string;
  desired_state: DesiredState;
  observed_state: ObservedState;
  condition: PolicyCondition;
  /** Latest actionable lifecycle failure, retained for Inspector/conflict UX. */
  last_error?: string | null;
  permission_profile_id: string | null;
  /** Provider-native policy selected in Add Agent; passed through unchanged. */
  provider_launch_policy?: unknown;
  created_by: string;
  created_at: string;
  /** Read-only source checkout used only to resolve remote + revision. */
  source_repo_path?: string | null;
  workspace_path?: string | null;
  work_attempt_id?: string | null;
  provider_ref?: {
    work_attempt_id: string;
    provider_continuation_id: string;
    provider_connection:
      | { kind: "codex_app_server"; url: string; pid: number | null; processIdentity?: string | null }
      | { kind: "claude_cli"; pid: number | null; processIdentity?: string | null }
      | { kind: "cursor_cli"; pid: number | null; processIdentity?: string | null }
      | null;
    execution_generation_id: string;
  } | null;
  workplace_liveness?: DaemonLivenessAxis<WorkplaceReachability>;
  native_liveness?: DaemonLivenessAxis<NativeExecutionActivity>;
  activity?: DaemonActivityEvent[];
  /** Last verified exact room identity; retained when live credentials unbind. */
  last_worker_binding?: DaemonWorkerBindingProjection | null;
  reconciliation?: ReconciliationState;
  reconciliation_notices?: ReconciliationNotice[];
};

export type DaemonManifestEntryView = DaemonManifestEntry & {
  worker_binding?: DaemonWorkerBindingProjection | null;
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
