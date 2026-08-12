import type { AgentPresenceFreshness, AgentPresenceStatus, RoomAgentDeliveryTransport, RoomAgentSessionKind } from "../../../shared/agent-presence.js";
import type { RoomActivitySourceFlag, RoomAgentActivityState } from "../../../shared/room-agent-activity.js";

export interface AgentIdentity {
  id: string;
  canonical_key: string;
  name: string;
  display_name: string;
  owner_account_id: string;
  owner_login: string;
  owner_label: string;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentPresence {
  room_id: string;
  actor_label: string;
  agent_key: string | null;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  repo_branch?: string | null;
  status: AgentPresenceStatus;
  status_text: string | null;
  last_heartbeat_at: string;
  created_at: string;
  updated_at: string;
  freshness: AgentPresenceFreshness;
  activity_state: RoomAgentActivityState;
  source_flags: RoomActivitySourceFlag[];
  liveness_observation: RoomAgentLivenessObservation | null;
}

export interface RoomAgentRegistrationLiveness {
  host_id?: string | null;
  host_kind?: string | null;
  host_label?: string | null;
  liveness_capability?: string | null;
  tool_bridge_id?: string | null;
}

export interface RoomAgentLivenessObservation {
  room_id: string;
  agent_session_id: string;
  source: string;
  host_id: string | null;
  host_kind: string | null;
  host_label: string | null;
  liveness_capability: string;
  tool_bridge_id: string | null;
  last_observed_at: string;
  last_tool_call_at: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentDeliverySession {
  room_id: string;
  delivery_key: string;
  actor_label: string;
  agent_key: string | null;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  repo_branch?: string | null;
  transport: RoomAgentDeliveryTransport;
  active_connection_count: number;
  last_connected_at: string;
  last_disconnected_at: string | null;
  reconnect_grace_expires_at: string | null;
  offline_announced_at: string | null;
  recovery_announced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentSession {
  session_id: string;
  room_id: string;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  host_id: string | null;
  host_kind: string | null;
  host_label: string | null;
  liveness_capability: string | null;
  tool_bridge_id: string | null;
  actor_label: string;
  agent_key: string;
  agent_instance_id: string | null;
  display_name: string;
  /** Server-resolved base label (before any collision suffix) recorded at
   * creation; clients echo it back as `requested_base_display_name` on
   * re-registration so replays converge. Null on legacy rows. */
  assigned_base_display_name?: string | null;
  owner_account_id: string;
  supervisor_grant_id: string | null;
  owner_label: string;
  ide_label: string;
  repo_branch?: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  ended_at: string | null;
}

export interface CreatedRoomAgentSession extends RoomAgentSession {
  session_token: string;
  worker_bearer: string | null;
}

export interface RoomAgentSessionBearer {
  bearer_id: string;
  session_id: string;
  room_id: string;
  generation: number;
  capabilities: string[];
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  rotated_from_bearer_id: string | null;
  supervisor_grant_id: string | null;
}

export interface SupervisorHostGrant {
  grant_id: string;
  owner_account_id: string;
  host_id: string;
  installation_id: string;
  scope_key: string;
  rental_session_id: string | null;
  token_version: number;
  allowed_room_ids: string[];
  allowed_agent_keys: string[];
  current_generation: number;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface RoomParticipant {
  room_id: string;
  participant_key: string;
  kind: "human" | "agent";
  actor_label: string | null;
  agent_key: string | null;
  github_login: string | null;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  hidden_at: string | null;
  hidden_by: string | null;
  last_seen_at: string;
  last_room_activity_at: string | null;
  last_live_heartbeat_at: string | null;
  activity_state: RoomAgentActivityState | null;
  source_flags: RoomActivitySourceFlag[];
  created_at: string;
  updated_at: string;
}

export interface RoomActivityActorCount {
  actor_label: string;
  count: number;
}

export interface RoomAgentPresenceRow {
  room_id: string;
  actor_label: string;
  agent_key: string | null;
  agent_session_id: string | null;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  repo_branch: string | null;
  status: AgentPresenceStatus;
  status_text: string | null;
  last_heartbeat_at: string;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentLivenessObservationRow {
  room_id: string;
  agent_session_id: string;
  source: string;
  host_id: string | null;
  host_kind: string | null;
  host_label: string | null;
  liveness_capability: string;
  tool_bridge_id: string | null;
  last_observed_at: string;
  last_tool_call_at: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentDeliverySessionRow {
  room_id: string;
  delivery_key: string;
  actor_label: string;
  agent_key: string | null;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  repo_branch: string | null;
  transport: RoomAgentDeliveryTransport;
  credential_fingerprint: string | null;
  credential_epoch: number | null;
  desktop_signal_sequence: number;
  active_connection_count: number;
  last_connected_at: string;
  last_disconnected_at: string | null;
  reconnect_grace_expires_at: string | null;
  offline_announced_at: string | null;
  recovery_announced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomAgentSessionRow {
  session_id: string;
  room_id: string;
  token_hash: string;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  host_id: string | null;
  host_kind: string | null;
  host_label: string | null;
  liveness_capability: string | null;
  tool_bridge_id: string | null;
  actor_label: string;
  agent_key: string;
  agent_instance_id: string | null;
  display_name: string;
  assigned_base_display_name?: string | null;
  owner_account_id: string;
  supervisor_grant_id: string | null;
  owner_label: string;
  ide_label: string;
  repo_branch: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  ended_at: string | null;
}

export interface RoomLiveAgentSuppressionRow {
  room_id: string;
  actor_label: string;
  suppressed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomParticipantRow {
  room_id: string;
  participant_key: string;
  kind: "human" | "agent";
  actor_label: string | null;
  agent_key: string | null;
  github_login: string | null;
  display_name: string;
  owner_label: string | null;
  ide_label: string | null;
  hidden_at: string | null;
  hidden_by: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}
