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
