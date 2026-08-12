export interface BoardGovernanceApiResponse {
  room_id: string;
  settings: {
    room_id: string;
    manager_mode: "off" | "manager_optional" | "intent_required";
    updated_by: string | null;
    created_at: string;
    updated_at: string;
  };
  active_manager: {
    id: string;
    room_id: string;
    agent_session_id: string;
    agent_key: string;
    actor_label: string;
    runtime_source: "desktop_managed" | "open_model" | "external" | "unknown";
    assigned_by: string;
    status: "active" | "released";
    last_heartbeat_at: string | null;
    released_by: string | null;
    release_reason: string | null;
    released_at: string | null;
    created_at: string;
    updated_at: string;
  } | null;
  candidates: Array<{
    agent_session_id: string;
    agent_key: string;
    actor_label: string;
    display_name: string;
    runtime: string;
    runtime_source: "desktop_managed" | "open_model" | "external" | "unknown";
    last_seen_at: string;
    is_active_manager: boolean;
  }>;
  pending_intents: Array<{
    id: string;
    room_id: string;
    task_id: string | null;
    action_type: string;
    payload: Record<string, unknown>;
    payload_hash: string;
    status: string;
    proposer_actor_label: string | null;
    proposer_actor_key: string | null;
    proposer_actor_instance_id: string | null;
    proposer_agent_session_id: string | null;
    decision_by: string | null;
    decision_reason: string | null;
    approval_token_hash: string | null;
    decided_at: string | null;
    expires_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  pending_intent_count: number;
  audit: Array<{
    id: string;
    kind: "coordination_event" | "manager_assignment" | "board_intent_decision";
    event_type: string;
    actor_label: string | null;
    reason: string | null;
    created_at: string;
    metadata: Record<string, unknown> | null;
  }>;
  warnings: Array<{
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
  }>;
  capabilities: {
    can_view_governance: boolean;
    can_assign_manager: boolean;
    can_release_manager: boolean;
    can_set_manager_mode: boolean;
    can_decide_intents: boolean;
  };
}
