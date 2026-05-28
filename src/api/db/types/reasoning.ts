import type { AgentPresenceStatus } from "../../../shared/agent-presence.js";
import type { ReasoningSnapshot } from "../schema.js";

export interface ReasoningSession {
  id: string;
  room_id: string;
  task_id: string | null;
  anchor_message_id: string | null;
  actor_label: string;
  agent_key: string | null;
  status: AgentPresenceStatus | null;
  summary: string;
  latest_payload: ReasoningSnapshot;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ReasoningSessionUpdate {
  id: string;
  room_id: string;
  session_id: string;
  actor_label: string;
  status: AgentPresenceStatus | null;
  summary: string;
  milestone: string | null;
  payload: ReasoningSnapshot;
  created_at: string;
}

export interface ReasoningSessionRow {
  id: string;
  room_id: string;
  task_id: string | null;
  anchor_message_id: string | null;
  actor_label: string;
  agent_key: string | null;
  status: AgentPresenceStatus | null;
  summary: string;
  latest_payload: ReasoningSnapshot;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ReasoningSessionUpdateRow {
  id: string;
  room_id: string;
  session_id: string;
  actor_label: string;
  status: AgentPresenceStatus | null;
  summary: string;
  milestone: string | null;
  payload: ReasoningSnapshot;
  created_at: string;
}
