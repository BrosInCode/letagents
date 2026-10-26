import type { ChildProcess } from "node:child_process";
import type {
  DesktopSupervisorActivityEvent,
  DesktopSupervisorDesiredState,
  DesktopSupervisorManifestEntry,
  DesktopSupervisorTurnControlResult,
} from "../../ipc-types.js";
import type { loadHostApprovalSigner } from "../host-approval-auth.js";

export type WireResponse = { version: number; id?: string; ok: boolean; result?: unknown; error?: string };
export type WireEntry = {
  provider_progress?: DesktopSupervisorManifestEntry["providerProgress"];
  launch_progress?: unknown;
  runtime_recovery?: DesktopSupervisorManifestEntry["runtimeRecovery"];
  local_room_id?: string;
  runtime_generation_id?: string | null;
  id: string;
  room_id: string;
  display_name: string;
  provider: string;
  model: string | null;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  config_revision?: number;
  runtime_configuration_revision?: number;
  charter: string;
  desired_state: DesktopSupervisorDesiredState;
  observed_state: DesktopSupervisorManifestEntry["observedState"];
  condition: DesktopSupervisorManifestEntry["condition"];
  last_error?: string | null;
  permission_profile_id: string | null;
  delivery_mode?: "mcp_polling" | "daemon_inbox";
  polling_contract?: "custodial_polling_v1" | null;
  home_harness?: string;
  permission_pending?: boolean;
  provider_launch_policy?: unknown;
  created_by: string;
  created_at: string;
  source_repo_path?: string | null;
  workspace_path?: string | null;
  work_attempt_id?: string | null;
  provider_ref?: {
    provider_continuation_id: string;
    execution_generation_id: string;
    provider_connection?: { pid?: number | null } | null;
  } | null;
  worker_binding?: {
    agent_session_id: string;
    work_attempt_id: string;
    execution_generation_id: string;
    updated_at: string;
  } | null;
  last_worker_binding?: {
    agent_session_id: string;
    work_attempt_id: string;
    execution_generation_id: string;
    updated_at: string;
  } | null;
  workplace_liveness?: { state: string; observed_at: string | null; detail: string | null };
  native_liveness?: { state: string; observed_at: string | null; detail: string | null };
  ready_reached_at?: string | null;
  activity?: WireActivityEvent[];
  last_turn_control_sequence?: number;
  reconciliation?: { exit_timestamps_ms?: number[]; last_terminal?: Record<string, unknown> };
  turn_control?: {
    action_id: string;
    action_sequence: number;
    work_attempt_id: string;
    execution_generation_id: string;
    target_room_id?: string | null;
    target_source_message_id?: string | null;
    target_provider_continuation_id?: string | null;
    inbox_item_id?: string | null;
    provider_turn_id?: string | null;
    // Older daemons can still report a turn-control journal while a desktop
    // handoff is in progress. Treat the extra display hint as additive.
    has_correction?: boolean;
    correction_text?: string | null;
    status: "prepared" | "dispatching" | "completed" | "retryable" | "uncertain";
    capability: "native_interrupt" | "restart_resume" | "unsupported";
    interrupted: boolean | null;
    resumed: boolean | null;
    state: "idle" | "working" | null;
    stages: DesktopSupervisorTurnControlResult["stages"];
    error: string | null;
    recorded_at: string;
    updated_at: string;
  } | null;
  room_agent_state?: {
    connection: { state: string; observed_at: string | null; detail: string | null };
    ingress: { state: string; observed_at: string | null; detail: string | null };
    inbox: { state: string; pending_count: number; blocked_by_message_id: string | null; detail: string | null };
    turn: { state: string; inbox_item_id: string | null; source_message_id: string | null; provider_turn_id: string | null; detail: string | null };
    task: { state: string; task_id: string | null; title: string | null };
  } | null;
  delivery_attention?: {
    reason: string; source_message_id: string; blocked_since: string; detail: string | null; waiting_count: number;
    provider_work_started: boolean; retry: string; can_skip: boolean; skip_unavailable_reason: string | null;
  } | null;
  delivery_receipts?: Array<{
    inbox_item_id: string; source_message_id: string; fifo_sequence?: number; reply_client_message_id: string; canonical_message_id?: string | null; state: string; attempt_count: number;
    provider_turn_id: string | null; blocked_by_message_id: string | null; error: string | null; failure_code?: string | null; terminal_reason?: string | null; updated_at: string;
    follow_up?: { for_message_id: string | null; state: string; reason?: string; later_person_turn?: boolean; scheduled: { at_ms: number; attempt: number; attempts: number; kind: string } | null };
    timeline?: Array<{ event_sequence?: number; phase: string; observed_at: string; detail: string | null }>;
  }>;
};
export type WireActivityEvent = {
  observed_at: string;
  sequence: number;
  provider: string;
  kind: string;
  method: string;
  summary: string;
  status: DesktopSupervisorActivityEvent["status"];
  payload: unknown;
  payload_truncated: boolean;
  payload_redacted: boolean;
  durable_payload_ref: string | null;
};

export type DaemonProcessState = "live" | "zombie";
export type DaemonProcessIdentity = {
  pid: number;
  kernelStartTime: string;
  command: string;
  state: DaemonProcessState;
  expectedScriptPath: string;
};

export type DaemonIdentityInspection = Omit<DaemonProcessIdentity, "expectedScriptPath">;
export type RetiredDaemonObservation =
  | { kind: "same"; identity: DaemonProcessIdentity }
  | { kind: "absent" }
  | { kind: "zombie" }
  | { kind: "unverifiable" }
  | { kind: "changed"; reason: string };

export type DaemonHandoffDiagnostic = {
  event: "supervisor_daemon_handoff";
  outcome: string;
  pid: number;
  implementationVersion: string;
  authorityReleased: boolean;
  detail: string;
};

export interface SupervisorDaemonLifecycleOptions {
  loadApprovalSigner?: typeof loadHostApprovalSigner;
  socketPath?: string;
  daemonScriptPath?: string;
  daemonWorkingDirectory?: string;
  lifecycleLogPath?: string;
  spawnDaemon?: (scriptPath: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
  /** @deprecated Prefer signalDaemon so tests can distinguish TERM from KILL. */
  terminateDaemon?: (pid: number) => void;
  signalDaemon?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  inspectDaemonProcess?: (pid: number) => DaemonIdentityInspection | null | undefined;
  reportHandoffDiagnostic?: (diagnostic: DaemonHandoffDiagnostic) => void;
  handoffTimeoutMs?: number;
  terminateTimeoutMs?: number;
  killTimeoutMs?: number;
  processPollIntervalMs?: number;
  startTimeoutMs?: number;
  statePreparationWaitMs?: number;
  requestTimeoutMs?: number;
  turnControlRequestTimeoutMs?: number;
  now?: () => Date;
  /**
   * How long a verified-ready status answers `ensureRunning` without a new
   * negotiation. Default 2000 ms. Zero turns the cache off.
   */
  readyStatusTtlMs?: number;
}
