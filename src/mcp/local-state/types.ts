import type { JoinedVia } from "../room-id.js";

export interface StoredAccount {
  id?: string;
  login: string;
  display_name?: string | null;
  avatar_url?: string | null;
}

export interface StoredAuthState {
  token: string;
  expires_at?: string;
  account?: StoredAccount;
  stored_at: string;
  source: "device_flow";
}

export interface PendingDeviceAuthState {
  request_id: string;
  user_code: string;
  verification_uri: string;
  interval_seconds: number;
  expires_at: string;
  started_at: string;
  suggested_room_id?: string;
}

export interface RoomSessionState {
  room_id: string;
  project_id?: string | null;
  code?: string | null;
  display_name?: string | null;
  git_room?: unknown;
  joined_via: JoinedVia;
  joined_at: string;
  last_seen_at: string;
  last_message_id?: string;
}

export type CodexLiveSessionStatus =
  | "starting"
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "unknown";

export interface CodexLiveSessionState {
  session_id: string;
  room_id: string;
  room_identifier: string;
  room_code?: string | null;
  room_display_name?: string | null;
  joined_via: JoinedVia;
  cwd: string;
  repo_branch?: string | null;
  stop_phrase: string;
  max_minutes: number;
  delivery_mode?: "mcp_polling" | "desktop_events";
  desktop_managed?: boolean;
  deadline_utc?: string | null;
  token: string;
  thread_id: string;
  turn_id: string;
  server_url: string;
  server_pid?: number | null;
  launched_server: boolean;
  codex_bin: string;
  agent_session_id?: string | null;
  reasoning_session_id?: string | null;
  status: CodexLiveSessionStatus;
  last_error?: string | null;
  started_at: string;
  updated_at: string;
}

export interface StoredAgentIdentityState {
  name: string;
  display_name: string;
  owner_label: string;
  owner_attribution?: string;
  ide_label?: string;
  actor_label: string;
  canonical_key?: string | null;
  runtime_key?: string | null;
  source: "api" | "local";
  resolved_at: string;
}

export interface StoredAgentIdentityLeaseState {
  namespace_key: string;
  pid: number;
  acquired_at: string;
  updated_at: string;
}

export interface StoredAgentSessionState {
  session_id: string;
  session_token: string;
  /**
   * Canonical daemon-owned worktree used to resolve the non-secret Codex
   * supervisor context after the MCP process or room loop restarts.
   *
   * This path is persisted only after the context has been validated and an
   * exact worker bind has succeeded. It is deliberately omitted from public
   * agent-session projections.
   */
  supervisor_context_cwd?: string | null;
  room_id: string;
  session_kind: "worker" | "controller";
  runtime: string;
  host_id?: string | null;
  host_kind?: string | null;
  host_label?: string | null;
  liveness_capability?: string | null;
  tool_bridge_id?: string | null;
  actor_label: string;
  agent_key: string;
  agent_instance_id?: string | null;
  display_name: string;
  /** The stable base label this client declared at registration (the intent
   * behind `display_name` before any server collision suffix). Re-registration
   * echoes it as `requested_base_display_name` so a replayed decorated label
   * converges server-side instead of compounding. */
  requested_base_display_name?: string | null;
  owner_label: string;
  ide_label: string;
  repo_branch?: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  ended_at?: string | null;
}

export interface StoredMcpWorker {
  worker_id: string;
  scope: string;
  registration_key_hash: string;
  display_name: string;
  rooms: Record<string, {
    session_id?: string;
    pending?: {
      operation_id: string;
      connection_token: string;
      predecessor_id?: string;
      predecessor_token?: string;
    };
  }>;
}

export interface LetagentsLocalState {
  mcp_workers?: Record<string, StoredMcpWorker>;
  auth?: StoredAuthState;
  pending_device_auth?: PendingDeviceAuthState;
  agent_identity?: StoredAgentIdentityState;
  agent_identities?: Record<string, StoredAgentIdentityState>;
  agent_identity_leases?: Record<string, StoredAgentIdentityLeaseState>;
  agent_sessions?: Record<string, StoredAgentSessionState>;
  current_agent_session_ids?: Record<string, string>;
  current_room?: RoomSessionState;
  room_sessions?: Record<string, RoomSessionState>;
  current_codex_live_session_ids?: Record<string, string>;
  codex_live_sessions?: Record<string, CodexLiveSessionState>;
  local_host_id?: string;
}
