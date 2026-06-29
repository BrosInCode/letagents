export interface RoomAgentPresence {
  room_id: string
  actor_label: string
  agent_key: string | null
  agent_instance_id: string | null
  agent_session_id: string | null
  session_kind: 'controller' | 'worker'
  runtime: string
  display_name: string
  owner_label: string | null
  ide_label: string | null
  repo_branch?: string | null
  status: 'idle' | 'working' | 'reviewing' | 'blocked'
  status_text: string | null
  last_heartbeat_at: string
  created_at: string
  updated_at: string
  freshness: 'active' | 'stale'
  activity_state: 'active' | 'away' | 'offline'
  source_flags: ReadonlyArray<'delivery' | 'presence' | 'messages' | 'tasks'>
  liveness_observation: {
    room_id: string
    agent_session_id: string
    source: string
    host_id: string | null
    host_kind: string | null
    host_label: string | null
    liveness_capability: string
    tool_bridge_id: string | null
    last_observed_at: string
    last_tool_call_at: string | null
    detail: string | null
    created_at: string
    updated_at: string
  } | null
}

export interface RoomParticipant {
  room_id: string
  participant_key: string
  kind: 'human' | 'agent'
  actor_label: string | null
  agent_key: string | null
  github_login: string | null
  display_name: string
  owner_label: string | null
  ide_label: string | null
  hidden_at: string | null
  hidden_by: string | null
  last_seen_at: string
  last_room_activity_at: string | null
  last_live_heartbeat_at: string | null
  activity_state: 'active' | 'away' | 'offline' | null
  source_flags: ReadonlyArray<'delivery' | 'presence' | 'messages' | 'tasks'>
  created_at: string
  updated_at: string
}
