import type { BoardIntentPayload } from "../../board-intent-payloads.js";

export type { BoardIntentPayload };

export type BoardManagerMode = "off" | "manager_optional" | "intent_required";

export type BoardManagerRuntimeSource =
  | "desktop_managed"
  | "open_model"
  | "external"
  | "unknown";

export type BoardManagerAssignmentStatus = "active" | "released";

export type BoardIntentActionType =
  | "task_create"
  | "task_claim"
  | "task_close"
  | "task_override"
  | "task_update";

export type BoardIntentStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "used";

export interface RoomBoardSettings {
  room_id: string;
  manager_mode: BoardManagerMode;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardManagerAssignment {
  id: string;
  room_id: string;
  agent_session_id: string;
  agent_key: string;
  actor_label: string;
  runtime_source: BoardManagerRuntimeSource;
  assigned_by: string;
  status: BoardManagerAssignmentStatus;
  last_heartbeat_at: string | null;
  released_by: string | null;
  release_reason: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardIntent {
  id: string;
  room_id: string;
  task_id: string | null;
  action_type: BoardIntentActionType;
  payload: BoardIntentPayload;
  payload_hash: string;
  status: BoardIntentStatus;
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
}

export interface BoardIntentConsumptionInput {
  room_id: string;
  action_type: BoardIntentActionType;
  payload: BoardIntentPayload;
  intent_id?: string | null;
  approval_token?: string | null;
  now?: Date;
}

export interface RoomBoardSettingsRow {
  room_id: string;
  manager_mode: BoardManagerMode;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardManagerAssignmentRow {
  id: string;
  room_id: string;
  agent_session_id: string;
  agent_key: string;
  actor_label: string;
  runtime_source: BoardManagerRuntimeSource;
  assigned_by: string;
  status: BoardManagerAssignmentStatus;
  last_heartbeat_at: string | null;
  released_by: string | null;
  release_reason: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardIntentRow {
  id: string;
  room_id: string;
  task_id: string | null;
  action_type: BoardIntentActionType;
  payload: BoardIntentPayload;
  payload_hash: string;
  status: BoardIntentStatus;
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
}
