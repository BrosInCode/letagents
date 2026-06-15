import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import type {
  DesktopManagedAgentDeliveryMode,
  DesktopManagedAgentSession,
  DesktopManagedAgentSessionStatus,
} from "../../ipc-types.js";
import { getLetAgentsLocalStatePath } from "../paths.js";
import { suggestLetAgentsCodename } from "./codenames.js";

const STATE_LOCK_WAIT_MS = 25;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STATE_LOCK_STALE_MS = 10_000;
const STATE_LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export type DesktopCodexJoinedVia = "join_code" | "join_room";

export interface DesktopCodexLiveSessionState {
  session_id: string;
  room_id: string;
  room_identifier: string;
  room_display_name?: string | null;
  display_name?: string | null;
  joined_via: DesktopCodexJoinedVia;
  cwd: string;
  stop_phrase: string;
  max_minutes: number;
  delivery_mode?: DesktopManagedAgentDeliveryMode;
  desktop_managed?: boolean;
  deadline_utc?: string | null;
  token: string;
  thread_id: string;
  turn_id: string;
  server_url: string;
  server_pid?: number | null;
  launched_server: boolean;
  codex_bin: string;
  agent_session_id?: string | null;
  reasoning_session_id?: string | null;
  status: DesktopManagedAgentSessionStatus;
  last_error?: string | null;
  started_at: string;
  updated_at: string;
}

interface SharedLetAgentsState {
  agent_identity?: StoredAgentIdentityState;
  agent_identities?: Record<string, StoredAgentIdentityState>;
  local_host_id?: string;
  agent_sessions?: Record<string, StoredAgentSessionState>;
  current_agent_session_ids?: Record<string, string>;
  current_codex_live_session_ids?: Record<string, string>;
  codex_live_sessions?: Record<string, DesktopCodexLiveSessionState>;
}

export interface StoredAgentIdentityState {
  name: string;
  display_name: string;
  owner_label: string;
  owner_attribution?: string | null;
  ide_label?: string | null;
  actor_label: string;
  canonical_key?: string | null;
  runtime_key?: string | null;
  source?: "api" | "local" | string;
  resolved_at: string;
}

export interface StoredAgentSessionState {
  session_id: string;
  session_token?: string;
  room_id: string;
  session_kind: "worker" | "controller" | string;
  runtime?: string | null;
  host_id?: string | null;
  host_kind?: string | null;
  host_label?: string | null;
  liveness_capability?: string | null;
  tool_bridge_id?: string | null;
  actor_label?: string | null;
  agent_key?: string | null;
  agent_instance_id?: string | null;
  display_name?: string | null;
  owner_label?: string | null;
  ide_label?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_seen_at?: string | null;
  ended_at?: string | null;
}

interface BindCodexLiveSessionOptions {
  allowStaleSingleCandidate?: boolean;
}

function sleepSync(ms: number): void {
  if (ms > 0) {
    Atomics.wait(STATE_LOCK_SLEEP_BUFFER, 0, 0, ms);
  }
}

function readLocalStateFromPath(statePath: string): SharedLetAgentsState {
  if (!existsSync(statePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as SharedLetAgentsState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readAgentLocalState(): SharedLetAgentsState {
  return readLocalStateFromPath(getLetAgentsLocalStatePath());
}

function writeLocalStateUnlocked(statePath: string, state: SharedLetAgentsState): void {
  const tempPath = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let tempFd: number | null = null;
  try {
    tempFd = openSync(tempPath, "w", 0o600);
    writeFileSync(tempFd, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    closeSync(tempFd);
    tempFd = null;
    renameSync(tempPath, statePath);
    chmodSync(statePath, 0o600);
  } finally {
    if (tempFd !== null) {
      closeSync(tempFd);
    }
    rmSync(tempPath, { force: true });
  }
}

function withStateLock<T>(callback: (statePath: string) => T): T {
  const statePath = getLetAgentsLocalStatePath();
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

function updateAgentLocalState(
  updater: (state: SharedLetAgentsState) => SharedLetAgentsState | void,
): SharedLetAgentsState {
  return withStateLock((statePath) => {
    const current = readLocalStateFromPath(statePath);
    const updated = updater(current) ?? current;
    writeLocalStateUnlocked(statePath, updated);
    return updated;
  });
}

export function getStoredAgentIdentity(): StoredAgentIdentityState | null {
  return readAgentLocalState().agent_identity ?? null;
}

export function saveStoredAgentIdentity(identity: StoredAgentIdentityState): StoredAgentIdentityState {
  updateAgentLocalState((state) => {
    state.agent_identity = identity;
    if (identity.runtime_key) {
      state.agent_identities = state.agent_identities ?? {};
      state.agent_identities[identity.runtime_key] = identity;
    }
    return state;
  });
  return identity;
}

export function getOrCreateDesktopHostId(): string {
  const existing = readAgentLocalState().local_host_id;
  if (typeof existing === "string" && existing.trim()) {
    return existing;
  }

  const hostId = `host_${randomBytes(16).toString("hex")}`;
  let resolvedHostId = hostId;
  updateAgentLocalState((state) => {
    if (typeof state.local_host_id === "string" && state.local_host_id.trim()) {
      resolvedHostId = state.local_host_id;
      return state;
    }
    state.local_host_id = hostId;
    return state;
  });
  return resolvedHostId;
}

export function getStoredAgentSession(sessionId: string | null | undefined): StoredAgentSessionState | null {
  const trimmed = String(sessionId ?? "").trim();
  if (!trimmed) {
    return null;
  }
  return readAgentLocalState().agent_sessions?.[trimmed] ?? null;
}

export function saveAgentSession(session: StoredAgentSessionState): StoredAgentSessionState {
  updateAgentLocalState((state) => {
    state.agent_sessions = state.agent_sessions ?? {};
    state.agent_sessions[session.session_id] = session;
    if (session.session_kind === "worker") {
      state.current_agent_session_ids = state.current_agent_session_ids ?? {};
      state.current_agent_session_ids[session.room_id] = session.session_id;
    }
    return state;
  });
  return session;
}

export function markAgentSessionEnded(
  sessionId: string | null | undefined,
  endedAt = new Date().toISOString(),
): StoredAgentSessionState | null {
  const trimmed = String(sessionId ?? "").trim();
  if (!trimmed) {
    return null;
  }

  let endedSession: StoredAgentSessionState | null = null;
  updateAgentLocalState((state) => {
    const existing = state.agent_sessions?.[trimmed];
    if (!existing) {
      return state;
    }
    endedSession = {
      ...existing,
      ended_at: endedAt,
      updated_at: endedAt,
      last_seen_at: existing.last_seen_at || endedAt,
    };
    state.agent_sessions = state.agent_sessions ?? {};
    state.agent_sessions[trimmed] = endedSession;
    for (const [roomId, currentSessionId] of Object.entries(state.current_agent_session_ids ?? {})) {
      if (currentSessionId === trimmed) {
        delete state.current_agent_session_ids?.[roomId];
      }
    }
    return state;
  });
  return endedSession;
}

function normalizeRoomId(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function getCurrentCodexLiveSession(roomId?: string | null): DesktopCodexLiveSessionState | null {
  const state = readAgentLocalState();
  const sessionIds = state.current_codex_live_session_ids;
  if (!sessionIds) {
    return null;
  }

  if (roomId) {
    const normalizedRoomId = normalizeRoomId(roomId);
    const sessionId = Object.entries(sessionIds).find(([key]) => normalizeRoomId(key) === normalizedRoomId)?.[1];
    if (sessionId) {
      return state.codex_live_sessions?.[sessionId] ?? null;
    }
    return Object.values(state.codex_live_sessions ?? {})
      .filter((session) =>
        normalizeRoomId(session.room_id) === normalizedRoomId ||
        normalizeRoomId(session.room_identifier) === normalizedRoomId
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null;
  }

  let best: DesktopCodexLiveSessionState | null = null;
  for (const id of Object.values(sessionIds)) {
    const session = state.codex_live_sessions?.[id];
    if (session && (!best || session.updated_at > best.updated_at)) {
      best = session;
    }
  }
  return best;
}

export function getStoredCodexLiveSession(sessionId: string): DesktopCodexLiveSessionState | null {
  return readAgentLocalState().codex_live_sessions?.[sessionId] ?? null;
}

export function listStoredCodexLiveSessions(roomId?: string | null): DesktopCodexLiveSessionState[] {
  const normalizedRoom = normalizeRoomId(roomId) || null;
  return Object.values(readAgentLocalState().codex_live_sessions ?? {})
    .filter((session) =>
      !normalizedRoom ||
      normalizeRoomId(session.room_id) === normalizedRoom ||
      normalizeRoomId(session.room_identifier) === normalizedRoom
    )
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export function isDesktopManagedCodexLiveSession(session: DesktopCodexLiveSessionState): boolean {
  return session.desktop_managed === true || Boolean(session.delivery_mode);
}

export function listDesktopManagedCodexLiveSessions(roomId?: string | null): DesktopCodexLiveSessionState[] {
  return listStoredCodexLiveSessions(roomId).filter(isDesktopManagedCodexLiveSession);
}

export function listCodexDisplayNamesForRoom(roomId: string): string[] {
  const normalizedRoom = normalizeRoomId(roomId);
  if (!normalizedRoom) {
    return [];
  }

  const state = readAgentLocalState();
  const liveSessionNames = Object.values(state.codex_live_sessions ?? {})
    .filter((session) =>
      normalizeRoomId(session.room_id) === normalizedRoom ||
      normalizeRoomId(session.room_identifier) === normalizedRoom
    )
    .map((session) => session.display_name);
  const workerNames = Object.values(state.agent_sessions ?? {})
    .filter((session) =>
      normalizeRoomId(session.room_id) === normalizedRoom &&
      session.session_kind === "worker" &&
      !session.ended_at &&
      isCodexAgentSession(session)
    )
    .flatMap((session) => [session.display_name, session.actor_label]);

  return [...liveSessionNames, ...workerNames]
    .map((name) => String(name ?? "").trim())
    .filter(Boolean);
}

function isCodexAgentSession(session: StoredAgentSessionState): boolean {
  const runtime = String(session.runtime ?? "").trim().toLowerCase();
  const ideLabel = String(session.ide_label ?? "").trim().toLowerCase();
  const livenessCapability = String(session.liveness_capability ?? "").trim().toLowerCase();
  const toolBridgeId = String(session.tool_bridge_id ?? "").trim().toLowerCase();

  return runtime === "codex" ||
    runtime.startsWith("codex:") ||
    ideLabel === "codex" ||
    livenessCapability.includes("codex") ||
    /(^|:)codex(:|$)/.test(toolBridgeId);
}

function sessionTimestamp(value: string | null | undefined): number {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function codexWorkerSessionsForRoom(
  state: SharedLetAgentsState,
  roomId: string,
): StoredAgentSessionState[] {
  const normalizedRoomId = normalizeRoomId(roomId);
  return Object.values(state.agent_sessions ?? {})
    .filter((session) =>
      normalizeRoomId(session.room_id) === normalizedRoomId &&
      session.session_kind === "worker" &&
      session.session_id &&
      !session.ended_at &&
      isCodexAgentSession(session)
    )
    .sort((left, right) =>
      sessionTimestamp(left.created_at) - sessionTimestamp(right.created_at)
      || left.session_id.localeCompare(right.session_id)
    );
}

function codexWorkerSessionForLiveSession(
  state: SharedLetAgentsState,
  session: DesktopCodexLiveSessionState,
  options: BindCodexLiveSessionOptions = {},
): StoredAgentSessionState | null {
  const candidates = codexWorkerSessionsForRoom(state, session.room_id);
  if (!candidates.length) {
    return null;
  }

  if (session.agent_session_id) {
    const bound = state.agent_sessions?.[session.agent_session_id] ?? null;
    if (bound && candidates.some((candidate) => candidate.session_id === bound.session_id)) {
      return bound;
    }
  }

  const runtimeMarker = `codex:${session.token}`;
  const exactRuntimeMatches = candidates.filter((candidate) =>
    String(candidate.runtime ?? "").trim() === runtimeMarker
  );
  if (exactRuntimeMatches.length === 1) {
    return exactRuntimeMatches[0] ?? null;
  }

  const startedAt = sessionTimestamp(session.started_at);
  const afterLiveSessionStart = candidates.filter((candidate) =>
    startedAt > 0 &&
    sessionTimestamp(candidate.created_at) >= startedAt - 1_000
  );
  if (afterLiveSessionStart.length === 1) {
    return afterLiveSessionStart[0] ?? null;
  }

  const allowStaleSingleCandidate = options.allowStaleSingleCandidate === true;
  return allowStaleSingleCandidate && afterLiveSessionStart.length === 0 && candidates.length === 1
    ? candidates[0] ?? null
    : null;
}

export function bindCodexLiveSessionToWorker(
  session: DesktopCodexLiveSessionState,
  options: BindCodexLiveSessionOptions = {},
): DesktopCodexLiveSessionState {
  const state = readAgentLocalState();
  const workerSession = codexWorkerSessionForLiveSession(state, session, options);
  if (!workerSession || workerSession.session_id === session.agent_session_id) {
    return session;
  }

  return updateCodexLiveSession(session.session_id, (current) => ({
    ...current,
    agent_session_id: workerSession.session_id,
    updated_at: new Date().toISOString(),
  })) ?? {
    ...session,
    agent_session_id: workerSession.session_id,
  };
}

export function managedAgentDeliveryMode(
  session: DesktopCodexLiveSessionState,
): DesktopManagedAgentDeliveryMode {
  return session.delivery_mode || "mcp_polling";
}

export function saveCodexLiveSession(
  session: DesktopCodexLiveSessionState,
  makeCurrent = true,
): DesktopCodexLiveSessionState {
  updateAgentLocalState((state) => {
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
  updater: (session: DesktopCodexLiveSessionState) => DesktopCodexLiveSessionState,
): DesktopCodexLiveSessionState | null {
  let updatedSession: DesktopCodexLiveSessionState | null = null;
  updateAgentLocalState((state) => {
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

function nonGenericCodexName(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || /^codex(?:\s+\d+)?$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function publicDisplayNameForCodexSession(
  session: DesktopCodexLiveSessionState,
  workerSession: StoredAgentSessionState | null,
): string {
  return nonGenericCodexName(workerSession?.display_name) ||
    nonGenericCodexName(session.display_name) ||
    nonGenericCodexName(workerSession?.actor_label) ||
    suggestLetAgentsCodename(listCodexDisplayNamesForRoom(session.room_id), session.token || session.session_id);
}

export function toPublicManagedAgentSession(
  session: DesktopCodexLiveSessionState,
): DesktopManagedAgentSession {
  const state = readAgentLocalState();
  const workerSession = codexWorkerSessionForLiveSession(state, session);
  const persistedWorker = session.agent_session_id
    ? state.agent_sessions?.[session.agent_session_id] ?? null
    : null;
  const persistedWorkerActive = Boolean(persistedWorker && !persistedWorker.ended_at);
  const displayName = publicDisplayNameForCodexSession(session, workerSession);
  return {
    id: session.session_id,
    providerId: "codex",
    runtime: "codex",
    roomIdentifier: session.room_identifier || session.room_id,
    roomDisplayName: session.room_display_name ?? null,
    repoRootPath: session.cwd,
    status: session.status,
    deliveryMode: managedAgentDeliveryMode(session),
    canStop: session.status === "starting" ||
      session.status === "running" ||
      session.status === "unknown" ||
      (managedAgentDeliveryMode(session) === "desktop_events" && session.status === "completed"),
    agentSessionId: workerSession?.session_id ?? (persistedWorkerActive ? session.agent_session_id ?? null : null),
    actorLabel: nonGenericCodexName(workerSession?.actor_label) ?? displayName,
    agentKey: workerSession?.agent_key ?? "codex",
    displayName,
    ownerLabel: workerSession?.owner_label ?? "Local desktop",
    ideLabel: workerSession?.ide_label ?? "Codex",
    reasoningSessionId: session.reasoning_session_id ?? null,
    startedAt: session.started_at,
    updatedAt: session.updated_at,
    lastError: session.last_error ?? null,
  };
}
