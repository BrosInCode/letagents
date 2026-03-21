import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { JoinedVia } from "./room-id.js";

export interface StoredAccount {
  id?: string;
  login: string;
  display_name?: string | null;
  avatar_url?: string | null;
}

export interface StoredAuthState {
  token: string;
  expires_at?: string;
  account?: StoredAccount;
  stored_at: string;
  source: "device_flow";
}

export interface PendingDeviceAuthState {
  request_id: string;
  user_code: string;
  verification_uri: string;
  interval_seconds: number;
  expires_at: string;
  started_at: string;
  suggested_room_id?: string;
}

export interface RoomSessionState {
  room_id: string;
  project_id?: string | null;
  code?: string | null;
  display_name?: string | null;
  joined_via: JoinedVia;
  joined_at: string;
  last_seen_at: string;
  last_message_id?: string;
}

export interface StoredAgentIdentityState {
  name: string;
  display_name: string;
  owner_label: string;
  actor_label: string;
  canonical_key?: string | null;
  source: "api" | "local";
  resolved_at: string;
}

export interface LetagentsLocalState {
  auth?: StoredAuthState;
  pending_device_auth?: PendingDeviceAuthState;
  agent_identity?: StoredAgentIdentityState;
  current_room?: RoomSessionState;
  room_sessions?: Record<string, RoomSessionState>;
}

const DEFAULT_STATE_PATH = join(homedir(), ".letagents", "mcp-state.json");

export function getLocalStatePath(): string {
  return process.env.LETAGENTS_STATE_PATH || DEFAULT_STATE_PATH;
}

export function readLocalState(): LetagentsLocalState {
  const statePath = getLocalStatePath();
  if (!existsSync(statePath)) {
    return {};
  }

  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as LetagentsLocalState;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function writeLocalState(state: LetagentsLocalState): void {
  const statePath = getLocalStatePath();
  mkdirSync(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tempPath, statePath);
}

export function updateLocalState(
  updater: (state: LetagentsLocalState) => LetagentsLocalState | void
): LetagentsLocalState {
  const current = readLocalState();
  const updated = updater(current) ?? current;
  writeLocalState(updated);
  return updated;
}

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }

  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

export function getStoredAuth(): StoredAuthState | null {
  const state = readLocalState();
  if (!state.auth) {
    return null;
  }

  if (isExpired(state.auth.expires_at)) {
    clearStoredAuth();
    return null;
  }

  return state.auth;
}

export function setStoredAuth(auth: StoredAuthState): StoredAuthState {
  updateLocalState((state) => {
    state.auth = auth;
    delete state.pending_device_auth;
    return state;
  });
  return auth;
}

export function clearStoredAuth(): void {
  updateLocalState((state) => {
    delete state.auth;
    return state;
  });
}

export function getPendingDeviceAuth(): PendingDeviceAuthState | null {
  const state = readLocalState();
  if (!state.pending_device_auth) {
    return null;
  }

  if (isExpired(state.pending_device_auth.expires_at)) {
    clearPendingDeviceAuth();
    return null;
  }

  return state.pending_device_auth;
}

export function setPendingDeviceAuth(
  pendingDeviceAuth: PendingDeviceAuthState
): PendingDeviceAuthState {
  updateLocalState((state) => {
    state.pending_device_auth = pendingDeviceAuth;
    return state;
  });
  return pendingDeviceAuth;
}

export function clearPendingDeviceAuth(): void {
  updateLocalState((state) => {
    delete state.pending_device_auth;
    return state;
  });
}

export function getStoredAgentIdentity(): StoredAgentIdentityState | null {
  const state = readLocalState();
  return state.agent_identity ?? null;
}

export function setStoredAgentIdentity(
  agentIdentity: StoredAgentIdentityState
): StoredAgentIdentityState {
  updateLocalState((state) => {
    state.agent_identity = agentIdentity;
    return state;
  });
  return agentIdentity;
}

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
