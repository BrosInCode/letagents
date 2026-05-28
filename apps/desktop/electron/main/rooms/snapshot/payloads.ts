import type { DesktopReasoningSession } from "../../../ipc-types.js";
import type { mapRoomMessagePayload } from "../messages.js";
import type { mapDesktopTaskSummaryPayload } from "../tasks.js";

export interface FocusRoomsResponse {
  focus_rooms?: Array<{
    room_id: string;
    name: string | null;
    display_name: string;
    code: string | null;
    source_task_id: string | null;
    focus_status: "active" | "concluded" | null;
    created_at: string;
  }>;
}

export interface ParticipantsResponse {
  participants?: Array<{
    participant_key: string;
    kind: "human" | "agent";
    display_name: string;
    actor_label: string | null;
    agent_key?: string | null;
    github_login?: string | null;
    owner_label?: string | null;
    ide_label?: string | null;
    hidden_at?: string | null;
    activity_state: "active" | "away" | "offline" | null;
    last_seen_at: string;
    last_room_activity_at?: string | null;
    last_live_heartbeat_at?: string | null;
    source_flags?: Array<"delivery" | "presence" | "messages" | "tasks">;
  }>;
  hidden_count?: number;
}

export interface PresenceResponse {
  presence?: Array<{
    room_id: string;
    actor_label: string;
    agent_key: string | null;
    agent_instance_id: string | null;
    agent_session_id: string | null;
    session_kind: "controller" | "worker";
    runtime: string;
    display_name: string;
    owner_label: string | null;
    ide_label: string | null;
    status: "idle" | "working" | "reviewing" | "blocked";
    status_text: string | null;
    last_heartbeat_at: string;
    freshness: "active" | "stale";
    activity_state: "active" | "away" | "offline";
    source_flags?: Array<"delivery" | "presence" | "messages" | "tasks">;
    liveness_observation?: {
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
    } | null;
  }>;
}

export interface ReasoningResponse {
  sessions?: ReasoningSessionPayload[];
  reasoning_sessions?: ReasoningSessionPayload[];
}

export interface ReasoningSessionPayload {
  id: string;
  room_id?: string | null;
  actor_label?: string | null;
  agent_key?: string | null;
  task_id?: string | null;
  title?: string | null;
  status?: string | null;
  summary?: string | null;
  latest_payload?: DesktopReasoningSession["latestPayload"];
  goal?: string | null;
  checking?: string | null;
  hypothesis?: string | null;
  blocker?: string | null;
  next_action?: string | null;
  milestone?: string | null;
  confidence?: number | null;
  closed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ActivityHistoryResponse {
  entries?: ActivityEntryPayload[];
}

export interface ActivityEntryPayload {
  id: string;
  room?: {
    id: string;
    display_name: string;
    kind: "main" | "focus";
    focus_status: "active" | "concluded" | null;
    source_task_id: string | null;
  };
  participant: {
    display_name: string;
    kind: "human" | "agent";
    actor_label?: string | null;
    owner_label?: string | null;
    ide_label?: string | null;
    activity_state: "active" | "away" | "offline" | null;
  };
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  last_room_activity_at: string;
  message_count?: number | null;
  reasoning_session_count?: number | null;
  current_tasks: ActivityTaskPayload[];
  completed_tasks: ActivityTaskPayload[];
  created_tasks?: ActivityTaskPayload[];
}

export interface ActivityTaskPayload {
  id: string;
  title: string;
  status: string;
  updated_at?: string | null;
  workflow_refs?: Array<{
    provider: string;
    kind: string;
    label: string;
    url: string;
  }>;
}

export interface MessagesResponse {
  messages?: Parameters<typeof mapRoomMessagePayload>[0][];
}

export interface RoomSnapshotData {
  focusRoomsData: FocusRoomsResponse;
  tasksData: { tasks?: Parameters<typeof mapDesktopTaskSummaryPayload>[0][] };
  participantsData: ParticipantsResponse;
  presenceData: PresenceResponse;
  reasoningData: ReasoningResponse;
  activityHistoryData: ActivityHistoryResponse;
  messagesData: MessagesResponse;
}
