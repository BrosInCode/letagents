import { readLocalState, updateLocalState } from "./storage.js";
import type { StoredAgentSessionState } from "./types.js";

export function getStoredAgentSession(
  sessionId: string | null | undefined
): StoredAgentSessionState | null {
  if (!sessionId) {
    return null;
  }
  const state = readLocalState();
  return state.agent_sessions?.[sessionId] ?? null;
}

export function getCurrentAgentSession(roomId?: string | null): StoredAgentSessionState | null {
  const state = readLocalState();
  const sessionIds = state.current_agent_session_ids;
  if (!sessionIds) {
    return null;
  }

  if (roomId) {
    const sessionId = sessionIds[roomId];
    const session = sessionId ? (state.agent_sessions?.[sessionId] ?? null) : null;
    return session && !session.ended_at ? session : null;
  }

  let best: StoredAgentSessionState | null = null;
  for (const id of Object.values(sessionIds)) {
    const session = state.agent_sessions?.[id];
    if (session && !session.ended_at && (!best || session.updated_at > best.updated_at)) {
      best = session;
    }
  }
  return best;
}

/**
 * Every stored session (active or ended) this identity had in the room,
 * most recently updated first. Re-registration consults the FULL lineage so a
 * replayed prior label reuses the base recorded when that exact label was
 * allocated — a latest-only lookup would lose an older concurrent sibling's
 * base and misread its restart as a deliberate rename.
 */
export function getStoredAgentSessionsForRoomIdentity(
  roomId: string,
  agentKey: string | null | undefined
): StoredAgentSessionState[] {
  if (!roomId || !agentKey) return [];
  const state = readLocalState();
  return Object.values(state.agent_sessions ?? {})
    .filter((session) => session.room_id === roomId && session.agent_key === agentKey)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export function saveAgentSession(
  session: StoredAgentSessionState,
  makeCurrent = true
): StoredAgentSessionState {
  updateLocalState((state) => {
    state.agent_sessions = state.agent_sessions ?? {};
    state.agent_sessions[session.session_id] = session;
    if (makeCurrent) {
      state.current_agent_session_ids = state.current_agent_session_ids ?? {};
      state.current_agent_session_ids[session.room_id] = session.session_id;
    }
    return state;
  });
  return session;
}

export function endStoredAgentSession(
  sessionId: string,
  endedAt = new Date().toISOString()
): StoredAgentSessionState | null {
  let endedSession: StoredAgentSessionState | null = null;
  updateLocalState((state) => {
    const session = state.agent_sessions?.[sessionId];
    if (!session) {
      return state;
    }

    endedSession = {
      ...session,
      ended_at: endedAt,
      updated_at: endedAt,
      last_seen_at: endedAt,
    };
    state.agent_sessions = state.agent_sessions ?? {};
    state.agent_sessions[sessionId] = endedSession;

    if (state.current_agent_session_ids) {
      for (const [roomId, currentSessionId] of Object.entries(state.current_agent_session_ids)) {
        if (currentSessionId === sessionId) {
          delete state.current_agent_session_ids[roomId];
        }
      }
    }

    return state;
  });
  return endedSession;
}
