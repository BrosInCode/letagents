import { readLocalState, updateLocalState } from "./storage.js";
import type { CodexLiveSessionState } from "./types.js";

export function getCurrentCodexLiveSession(roomId?: string): CodexLiveSessionState | null {
  const state = readLocalState();
  const sessionIds = state.current_codex_live_session_ids;
  if (!sessionIds) {
    return null;
  }

  if (roomId) {
    const sessionId = sessionIds[roomId];
    return sessionId ? (state.codex_live_sessions?.[sessionId] ?? null) : null;
  }

  let best: CodexLiveSessionState | null = null;
  for (const id of Object.values(sessionIds)) {
    const session = state.codex_live_sessions?.[id];
    if (session && (!best || session.updated_at > best.updated_at)) {
      best = session;
    }
  }
  return best;
}

export function getStoredCodexLiveSession(sessionId: string): CodexLiveSessionState | null {
  const state = readLocalState();
  return state.codex_live_sessions?.[sessionId] ?? null;
}

export function listStoredCodexLiveSessions(): CodexLiveSessionState[] {
  const state = readLocalState();
  return Object.values(state.codex_live_sessions ?? {}).sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at)
  );
}

export function saveCodexLiveSession(
  session: CodexLiveSessionState,
  makeCurrent = true
): CodexLiveSessionState {
  updateLocalState((state) => {
    state.codex_live_sessions = state.codex_live_sessions ?? {};
    state.codex_live_sessions[session.session_id] = session;
    if (makeCurrent) {
      state.current_codex_live_session_ids = state.current_codex_live_session_ids ?? {};
      state.current_codex_live_session_ids[session.room_id] = session.session_id;
    }
    return state;
  });

  return session;
}

export function updateCodexLiveSession(
  sessionId: string,
  updater: (session: CodexLiveSessionState) => CodexLiveSessionState
): CodexLiveSessionState | null {
  let updatedSession: CodexLiveSessionState | null = null;

  updateLocalState((state) => {
    const existing = state.codex_live_sessions?.[sessionId];
    if (!existing) {
      return state;
    }

    const updated = updater(existing);
    state.codex_live_sessions = state.codex_live_sessions ?? {};
    state.codex_live_sessions[sessionId] = updated;
    state.current_codex_live_session_ids = state.current_codex_live_session_ids ?? {};
    if (!state.current_codex_live_session_ids[updated.room_id]) {
      state.current_codex_live_session_ids[updated.room_id] = sessionId;
    }
    updatedSession = updated;
    return state;
  });

  return updatedSession;
}
