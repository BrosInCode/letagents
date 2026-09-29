import { getLocalStatePath, readLocalState, readLocalStateSnapshot, updateLocalState } from "./storage.js";
import { isMcpWorkerId } from "../../shared/mcp-worker.js";
import { pinnedWorkerConnection } from "../worker-call-context.js";
import type { StoredAgentSessionState } from "./types.js";

export function getStoredAgentSession(
  sessionId: string | null | undefined
): StoredAgentSessionState | null {
  if (!sessionId) {
    return null;
  }
  const state = readLocalState();
  const stored = state.agent_sessions?.[sessionId] ?? null;
  if (stored && isMcpWorkerId(stored.agent_instance_id)) {
    // A replaced process must never borrow its successor's credential from disk.
    const pinned = pinnedWorkerConnection(getLocalStatePath(), sessionId);
    if (!pinned || stored.session_token !== pinned.session_token) {
      throw new Error("This worker connection was replaced. Reconnect explicitly with its worker_id.");
    }
    return { ...pinned, ended_at: stored.ended_at };
  }
  return stored;
}

export function getCurrentAgentSession(roomId?: string | null): StoredAgentSessionState | null {
  return getCurrentAgentSessionSnapshot(roomId).session;
}

export function getCurrentAgentSessionSnapshot(roomId?: string | null): {
  session: StoredAgentSessionState | null;
  complete: boolean;
} {
  const snapshot = readLocalStateSnapshot();
  const state = snapshot.state;
  const sessionIds = state.current_agent_session_ids;
  if (!sessionIds) {
    return { session: null, complete: snapshot.complete };
  }

  if (roomId) {
    const sessionId = sessionIds[roomId];
    const session = sessionId ? (state.agent_sessions?.[sessionId] ?? null) : null;
    return {
      session: session && !session.ended_at ? session : null,
      complete: snapshot.complete,
    };
  }

  let best: StoredAgentSessionState | null = null;
  for (const id of Object.values(sessionIds)) {
    const session = state.agent_sessions?.[id];
    if (session && !session.ended_at && (!best || session.updated_at > best.updated_at)) {
      best = session;
    }
  }
  return { session: best, complete: snapshot.complete };
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

/** Complete active local worker population for global routing ambiguity. */
export function getStoredActiveAgentSessionsForRoom(
  roomId: string,
): StoredAgentSessionState[] {
  return getStoredAgentRoutingStateSnapshot(roomId).sessions;
}

export function getStoredAgentRoutingStateSnapshot(roomId: string): {
  sessions: StoredAgentSessionState[];
  complete: boolean;
  accountReaderKey: string | null;
} {
  if (!roomId) return { sessions: [], complete: true, accountReaderKey: null };
  const snapshot = readLocalStateSnapshot();
  const sessions = Object.values(snapshot.state.agent_sessions ?? {})
    .filter((session) =>
      session.room_id === roomId
      && session.session_kind === "worker"
      && !session.ended_at)
    .sort((left, right) =>
      left.created_at.localeCompare(right.created_at)
      || left.session_id.localeCompare(right.session_id));
  const accountId = snapshot.state.auth?.account?.id?.trim() || "";
  return {
    sessions,
    complete: snapshot.complete,
    accountReaderKey: accountId ? `account:${accountId}` : null,
  };
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

/**
 * Local MCP rooms have one process-owned generation per durable worker key.
 * Replace it atomically so a crashed/restarted process cannot remain the
 * permanent oldest routing representative.
 */
export function replaceLocalWorkerAgentSession(
  session: StoredAgentSessionState,
): StoredAgentSessionState {
  updateLocalState((state) => {
    const endedAt = session.created_at;
    state.agent_sessions = state.agent_sessions ?? {};
    for (const [sessionId, existing] of Object.entries(state.agent_sessions)) {
      if (
        sessionId !== session.session_id
        && existing.room_id === session.room_id
        && existing.session_kind === "worker"
        && existing.agent_key === session.agent_key
        && !existing.ended_at
      ) {
        state.agent_sessions[sessionId] = {
          ...existing,
          ended_at: endedAt,
          updated_at: endedAt,
          last_seen_at: endedAt,
        };
      }
    }
    state.agent_sessions[session.session_id] = session;
    state.current_agent_session_ids = state.current_agent_session_ids ?? {};
    state.current_agent_session_ids[session.room_id] = session.session_id;
    return state;
  });
  return session;
}

export function endStoredAgentSession(
  sessionId: string,
  endedAt = new Date().toISOString(),
  expectedConnectionToken?: string,
): StoredAgentSessionState | null {
  let endedSession: StoredAgentSessionState | null = null;
  updateLocalState((state) => {
    const session = state.agent_sessions?.[sessionId];
    if (!session) {
      return state;
    }
    if (isMcpWorkerId(session.agent_instance_id)
      && expectedConnectionToken !== session.session_token) {
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
