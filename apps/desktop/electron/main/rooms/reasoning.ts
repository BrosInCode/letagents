import type {
  DesktopReasoningSession,
  DesktopReasoningSessionDetail,
  DesktopReasoningUpdate,
} from "../../ipc-types.js";
import { apiFetch } from "../auth.js";

export async function getDesktopReasoningSession(
  roomIdentifier: string,
  sessionId: string,
): Promise<DesktopReasoningSessionDetail> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedSessionId = sessionId.trim();
  if (!trimmedRoomIdentifier || !trimmedSessionId) {
    throw new Error("Choose a reasoning stream before opening details.");
  }

  const detail = await apiFetch<{
    session?: Parameters<typeof mapDesktopReasoningSessionPayload>[0];
    reasoning_session?: Parameters<typeof mapDesktopReasoningSessionPayload>[0];
    updates?: Array<{
      id: string;
      room_id?: string | null;
      session_id?: string | null;
      actor_label?: string | null;
      status?: string | null;
      summary?: string | null;
      milestone?: string | null;
      payload?: DesktopReasoningSession["latestPayload"];
      created_at?: string | null;
    }>;
  }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/reasoning-sessions/${encodeURIComponent(trimmedSessionId)}`,
  );
  const sessionPayload = detail.session || detail.reasoning_session;
  if (!sessionPayload) {
    throw new Error("Reasoning session details were not returned.");
  }

  return {
    session: mapDesktopReasoningSessionPayload(sessionPayload),
    updates: (detail.updates || []).map(mapDesktopReasoningUpdatePayload),
  };
}

export function mapDesktopReasoningSessionPayload(session: {
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
}): DesktopReasoningSession {
  return {
    id: session.id,
    roomId: session.room_id || null,
    actorLabel: session.actor_label || null,
    agentKey: session.agent_key || null,
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

export function mapDesktopReasoningUpdatePayload(update: {
  id: string;
  room_id?: string | null;
  session_id?: string | null;
  actor_label?: string | null;
  status?: string | null;
  summary?: string | null;
  milestone?: string | null;
  payload?: DesktopReasoningSession["latestPayload"];
  created_at?: string | null;
}): DesktopReasoningUpdate {
  return {
    id: update.id,
    roomId: update.room_id || null,
    sessionId: update.session_id || null,
    actorLabel: update.actor_label || null,
    status: update.status || null,
    summary: update.summary || null,
    milestone: update.milestone || null,
    payload: update.payload || null,
    createdAt: update.created_at || null,
  };
}
