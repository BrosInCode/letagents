import type {
  DesktopReasoningSession,
  DesktopReasoningUpdate,
} from "../../../ipc-types.js";

export type DesktopReasoningSessionPayload = {
  id: string;
  room_id?: string | null;
  actor_label?: string | null;
  agent_key?: string | null;
  agent_session_id?: string | null;
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
};

export type DesktopReasoningUpdatePayload = {
  id: string;
  room_id?: string | null;
  session_id?: string | null;
  actor_label?: string | null;
  agent_session_id?: string | null;
  status?: string | null;
  summary?: string | null;
  milestone?: string | null;
  payload?: DesktopReasoningSession["latestPayload"];
  created_at?: string | null;
};

export function mapDesktopReasoningSessionPayload(
  session: DesktopReasoningSessionPayload,
): DesktopReasoningSession {
  return {
    id: session.id,
    roomId: session.room_id || null,
    actorLabel: session.actor_label || null,
    agentKey: session.agent_key || null,
    agentSessionId: session.agent_session_id || null,
    taskId: session.task_id || null,
    title: session.title || null,
    status: session.status || null,
    summary: session.summary || null,
    latestPayload: session.latest_payload || null,
    goal: session.goal || null,
    checking: session.checking || null,
    hypothesis: session.hypothesis || null,
    blocker: session.blocker || null,
    nextAction: session.next_action || null,
    milestone: session.milestone || null,
    confidence: session.confidence ?? null,
    closedAt: session.closed_at || null,
    createdAt: session.created_at || null,
    updatedAt: session.updated_at || null,
  };
}

export function mapDesktopReasoningUpdatePayload(
  update: DesktopReasoningUpdatePayload,
): DesktopReasoningUpdate {
  return {
    id: update.id,
    roomId: update.room_id || null,
    sessionId: update.session_id || null,
    actorLabel: update.actor_label || null,
    agentSessionId: update.agent_session_id || null,
    status: update.status || null,
    summary: update.summary || null,
    milestone: update.milestone || null,
    payload: update.payload || null,
    createdAt: update.created_at || null,
  };
}
