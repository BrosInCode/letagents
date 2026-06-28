import { readLocalState, updateLocalState } from "./storage.js";
import type { RoomSessionState } from "./types.js";
import type { JoinedVia } from "../room-id.js";

export function getStoredCurrentRoom(): RoomSessionState | null {
  const state = readLocalState();
  return state.current_room ?? null;
}

export function getStoredRoomSession(roomId: string): RoomSessionState | null {
  const state = readLocalState();
  return state.room_sessions?.[roomId] ?? null;
}

export function saveRoomSession(input: {
  room_id: string;
  project_id?: string | null;
  code?: string | null;
  display_name?: string | null;
  git_room?: unknown;
  joined_via: JoinedVia;
  last_message_id?: string;
}): RoomSessionState {
  const now = new Date().toISOString();
  const existing = getStoredRoomSession(input.room_id);
  const session: RoomSessionState = {
    room_id: input.room_id,
    project_id: input.project_id ?? existing?.project_id ?? null,
    code: input.code ?? existing?.code ?? null,
    display_name: input.display_name ?? existing?.display_name ?? null,
    git_room: input.git_room !== undefined ? input.git_room : existing?.git_room ?? null,
    joined_via: input.joined_via,
    joined_at: existing?.joined_at ?? now,
    last_seen_at: now,
    last_message_id: input.last_message_id ?? existing?.last_message_id,
  };

  updateLocalState((state) => {
    state.room_sessions = state.room_sessions ?? {};
    state.room_sessions[input.room_id] = session;
    state.current_room = session;
    return state;
  });

  return session;
}

export function touchRoomSession(roomId: string, lastMessageId?: string): RoomSessionState | null {
  const existing = getStoredRoomSession(roomId);
  if (!existing) {
    return null;
  }

  const updated: RoomSessionState = {
    ...existing,
    last_seen_at: new Date().toISOString(),
    last_message_id: lastMessageId ?? existing.last_message_id,
  };

  updateLocalState((state) => {
    state.room_sessions = state.room_sessions ?? {};
    state.room_sessions[roomId] = updated;
    if (state.current_room?.room_id === roomId) {
      state.current_room = updated;
    }
    return state;
  });

  return updated;
}
