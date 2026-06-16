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
  owner_label: string;
  ide_label: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  ended_at?: string | null;
}

export interface LetagentsLocalState {
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
