export const DAEMON_PROTOCOL_VERSION = 1;

export type DesiredState = "running" | "paused" | "stopped";
export type ObservedState = "absent" | "starting" | "idle" | "working" | "checkpointing" | "pausing" | "paused" | "recovering" | "stopping" | "stopped" | "failed";
export type PolicyCondition = "none" | "quarantined" | "coordination_blocked" | "auth_blocked" | "budget_blocked" | "security_blocked";

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
  permission_profile_id: string | null;
  created_by: string;
  created_at: string;
};

export type DaemonManifest = {
  generation: number;
  entries: DaemonManifestEntry[];
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

export type WorkAttemptState = "active" | "ambiguous" | "quarantined" | "unreviewed" | "cleanly_concluded" | "abandoned";

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

export type TaskWorkAttempt = {
  work_attempt_id: string;
  task_id: string;
  lease_id: string;
  current_lease_epoch: number;
  epoch_history: LeaseEpoch[];
  workspace_path: string;
  state: WorkAttemptState;
  created_at: string;
  concluded_at: string | null;
  conclusion_cause: string | null;
  postmortem_diff: string | null;
  checkpoints: WorkAttemptCheckpoint[];
  execution_generations: ExecutionGeneration[];
};
