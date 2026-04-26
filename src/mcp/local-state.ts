import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
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

export type CodexLiveSessionStatus =
  | "starting"
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "unknown";

export interface CodexLiveSessionState {
  session_id: string;
  room_id: string;
  room_identifier: string;
  room_code?: string | null;
  room_display_name?: string | null;
  joined_via: JoinedVia;
  cwd: string;
  stop_phrase: string;
  max_minutes: number;
  deadline_utc?: string | null;
  token: string;
  thread_id: string;
  turn_id: string;
  server_url: string;
  server_pid?: number | null;
  launched_server: boolean;
  codex_bin: string;
  status: CodexLiveSessionStatus;
  last_error?: string | null;
  started_at: string;
  updated_at: string;
}

export interface StoredAgentIdentityState {
  name: string;
  display_name: string;
  owner_label: string;
  owner_attribution?: string;
  ide_label?: string;
  actor_label: string;
  canonical_key?: string | null;
  runtime_key?: string | null;
  source: "api" | "local";
  resolved_at: string;
}

export interface StoredAgentIdentityLeaseState {
  namespace_key: string;
  pid: number;
  acquired_at: string;
  updated_at: string;
}

export interface StoredAgentSessionState {
  session_id: string;
  session_token: string;
  room_id: string;
  session_kind: "worker" | "controller";
  runtime: string;
  actor_label: string;
  agent_key: string;
  agent_instance_id?: string | null;
  display_name: string;
  owner_label: string;
  ide_label: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  ended_at?: string | null;
}

export interface LetagentsLocalState {
  auth?: StoredAuthState;
  pending_device_auth?: PendingDeviceAuthState;
  agent_identity?: StoredAgentIdentityState;
  agent_identities?: Record<string, StoredAgentIdentityState>;
  agent_identity_leases?: Record<string, StoredAgentIdentityLeaseState>;
  agent_sessions?: Record<string, StoredAgentSessionState>;
  current_agent_session_ids?: Record<string, string>;
  current_room?: RoomSessionState;
  room_sessions?: Record<string, RoomSessionState>;
  current_codex_live_session_ids?: Record<string, string>;
  codex_live_sessions?: Record<string, CodexLiveSessionState>;
}

const DEFAULT_STATE_PATH = join(homedir(), ".letagents", "mcp-state.json");
const STATE_LOCK_WAIT_MS = 25;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STATE_LOCK_STALE_MS = 10_000;
const STATE_LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function getLocalStatePath(): string {
  return process.env.LETAGENTS_STATE_PATH || DEFAULT_STATE_PATH;
}

function readLocalStateFromPath(statePath: string): LetagentsLocalState {
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

export function readLocalState(): LetagentsLocalState {
  const statePath = getLocalStatePath();
  return readLocalStateFromPath(statePath);
}

function sleepSync(ms: number): void {
  if (ms > 0) {
    Atomics.wait(STATE_LOCK_SLEEP_BUFFER, 0, 0, ms);
  }
}

function writeLocalStateUnlocked(statePath: string, state: LetagentsLocalState): void {
  const tempPath = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    renameSync(tempPath, statePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function withStateLock<T>(callback: (statePath: string) => T): T {
  const statePath = getLocalStatePath();
  mkdirSync(dirname(statePath), { recursive: true });

  const lockPath = `${statePath}.lock`;
  const startedAt = Date.now();

  while (true) {
    let lockFd: number | null = null;

    try {
      lockFd = openSync(lockPath, "wx");
      return callback(statePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = statSync(lockPath);
        if (Date.now() - stats.mtimeMs > STATE_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() - startedAt >= STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring local state lock at ${lockPath}`);
      }

      sleepSync(STATE_LOCK_WAIT_MS);
    } finally {
      if (lockFd !== null) {
        closeSync(lockFd);
        rmSync(lockPath, { force: true });
      }
    }
  }
}

export function writeLocalState(state: LetagentsLocalState): void {
  withStateLock((statePath) => {
    writeLocalStateUnlocked(statePath, state);
  });
}

export function updateLocalState(
  updater: (state: LetagentsLocalState) => LetagentsLocalState | void
): LetagentsLocalState {
  return withStateLock((statePath) => {
    const current = readLocalStateFromPath(statePath);
    const updated = updater(current) ?? current;
    writeLocalStateUnlocked(statePath, updated);
    return updated;
  });
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

export function getStoredAgentIdentity(identityKey?: string | null): StoredAgentIdentityState | null {
  const state = readLocalState();
  if (identityKey?.trim()) {
    const scoped = state.agent_identities?.[identityKey.trim()];
    if (scoped) {
      return scoped;
    }
    // For UUID-based identity keys, do NOT fall back to the shared global
    // agent_identity — that would cause different processes to inherit each
    // other's identity. Only legacy (non-UUID) keys use the global fallback.
    if (identityKey.startsWith("instance:")) {
      return null;
    }
  }
  return state.agent_identity ?? null;
}

export function setStoredAgentIdentity(
  agentIdentity: StoredAgentIdentityState,
  identityKey?: string | null
): StoredAgentIdentityState {
  updateLocalState((state) => {
    state.agent_identity = agentIdentity;
    if (identityKey?.trim()) {
      state.agent_identities = state.agent_identities ?? {};
      state.agent_identities[identityKey.trim()] = agentIdentity;
    }
    return state;
  });
  return agentIdentity;
}

export function getStoredAgentSession(sessionId: string | null | undefined): StoredAgentSessionState | null {
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
