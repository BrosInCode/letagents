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
  DesktopCursorMcpPolicy,
  DesktopManagedAgentEffort,
  DesktopManagedAgentPermissionProfileId,
  DesktopManagedAgentDeliveryMode,
  DesktopManagedAgentPermissionRequest,
  DesktopManagedAgentSession,
  DesktopManagedAgentSessionStatus,
} from "../../ipc-types.js";
import { getLetAgentsLocalStatePath } from "../paths.js";
import { suggestLetAgentsCodename } from "./codenames.js";
import {
  managedAgentPermissionProfileForProvider,
} from "./managed-agent-permission-profiles.js";

const STATE_LOCK_WAIT_MS = 25;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STATE_LOCK_STALE_MS = 10_000;
const STATE_LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export type DesktopCodexJoinedVia = "join_code" | "join_room";

export type DesktopClaudeCodeJoinedVia = "join_code" | "join_room";

export type DesktopCursorJoinedVia = "join_code" | "join_room";


export interface DesktopManagedLiveSessionBase {
  session_id: string;
  room_id: string;
  room_identifier: string;
  room_display_name?: string | null;
  display_name?: string | null;
  cwd: string;
  repo_branch?: string | null;
  model?: string | null;
  effort?: DesktopManagedAgentEffort | null;
  stop_phrase: string;
  max_minutes: number;
  delivery_mode?: DesktopManagedAgentDeliveryMode;
  permission_profile_id?: DesktopManagedAgentPermissionProfileId | null;
  desktop_managed?: boolean;
  deadline_utc?: string | null;
  token: string;
  agent_session_id?: string | null;
  active_work?: {
    kind: "message" | "task_update";
    event_id?: string | null;
    started_at: string;
    summary?: string | null;
  } | null;
  status: DesktopManagedAgentSessionStatus;
  last_error?: string | null;
  started_at: string;
  updated_at: string;
}

export interface DesktopCodexLiveSessionState extends DesktopManagedLiveSessionBase {
  /** Which desktop provider owns this Codex-engine session. Absent means "codex". */
  provider_id?: string;
  joined_via: DesktopCodexJoinedVia;
  thread_id: string;
  turn_id: string;
  server_url: string;
  server_pid?: number | null;
  launched_server: boolean;
  codex_bin: string;
  reasoning_session_id?: string | null;
}

export interface DesktopClaudeCodeLiveSessionState extends DesktopManagedLiveSessionBase {
  joined_via: DesktopClaudeCodeJoinedVia;
  claude_session_id?: string | null;
  claude_bin: string;
  recent_items?: Array<Record<string, unknown>>;
  pending_permission_requests?: DesktopManagedAgentPermissionRequest[];
}

export interface DesktopCursorLiveSessionState extends DesktopManagedLiveSessionBase {
  joined_via: DesktopCursorJoinedVia;
  cursor_mcp_policy?: DesktopCursorMcpPolicy | null;
  cursor_session_id?: string | null;
  cursor_bin: string;
  recent_items?: Array<Record<string, unknown>>;
  pending_permission_requests?: DesktopManagedAgentPermissionRequest[];
}

export interface SharedLetAgentsState {
  agent_identity?: StoredAgentIdentityState;
  agent_identities?: Record<string, StoredAgentIdentityState>;
  local_host_id?: string;
  agent_sessions?: Record<string, StoredAgentSessionState>;
  current_agent_session_ids?: Record<string, string>;
  current_codex_live_session_ids?: Record<string, string>;
  codex_live_sessions?: Record<string, DesktopCodexLiveSessionState>;
  current_claude_code_live_session_ids?: Record<string, string>;
  claude_code_live_sessions?: Record<string, DesktopClaudeCodeLiveSessionState>;
  current_cursor_live_session_ids?: Record<string, string>;
  cursor_live_sessions?: Record<string, DesktopCursorLiveSessionState>;
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
  repo_branch?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_seen_at?: string | null;
  ended_at?: string | null;
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

export function getStoredAgentIdentityForRuntimeKey(runtimeKey: string): StoredAgentIdentityState | null {
  const trimmed = runtimeKey.trim();
  if (!trimmed) {
    return null;
  }
  return readAgentLocalState().agent_identities?.[trimmed] ?? null;
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

export function normalizeRoomId(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}


type LiveSessionMapKey = {
  sessions: "codex_live_sessions" | "claude_code_live_sessions" | "cursor_live_sessions";
  currentIds: "current_codex_live_session_ids" | "current_claude_code_live_session_ids" | "current_cursor_live_session_ids";
};

type LiveSessionCurrentLookup = "normalize-entries" | "direct-or-raw";

function createLiveSessionStore<TState extends DesktopManagedLiveSessionBase>(
  maps: LiveSessionMapKey,
  options: { currentLookup?: LiveSessionCurrentLookup } = {},
) {
  const currentLookup = options.currentLookup ?? "normalize-entries";

  function sessionsOf(state: SharedLetAgentsState): Record<string, TState> {
    return (state[maps.sessions] as Record<string, TState> | undefined) ?? {};
  }

  function currentIdsOf(state: SharedLetAgentsState): Record<string, string> {
    return (state[maps.currentIds] as Record<string, string> | undefined) ?? {};
  }

  function getCurrent(roomId?: string | null): TState | null {
    const state = readAgentLocalState();

    if (currentLookup === "direct-or-raw") {
      const sessionIds = currentIdsOf(state);
      const normalizedRoomId = normalizeRoomId(roomId);
      if (normalizedRoomId) {
        const directId = sessionIds[normalizedRoomId] ?? sessionIds[roomId ?? ""];
        const direct = directId ? sessionsOf(state)[directId] ?? null : null;
        if (direct) {
          return direct;
        }
        return Object.values(sessionsOf(state))
          .filter((session) =>
            normalizeRoomId(session.room_id) === normalizedRoomId ||
            normalizeRoomId(session.room_identifier) === normalizedRoomId
          )
          .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null;
      }

      let best: TState | null = null;
      for (const id of Object.values(sessionIds)) {
        const session = sessionsOf(state)[id];
        if (session && (!best || session.updated_at > best.updated_at)) {
          best = session;
        }
      }
      return best;
    }

    const sessionIds = state[maps.currentIds] as Record<string, string> | undefined;
    if (!sessionIds) {
      return null;
    }

    if (roomId) {
      const normalizedRoomId = normalizeRoomId(roomId);
      const sessionId = Object.entries(sessionIds).find(([key]) => normalizeRoomId(key) === normalizedRoomId)?.[1];
      if (sessionId) {
        return sessionsOf(state)[sessionId] ?? null;
      }
      return Object.values(sessionsOf(state))
        .filter((session) =>
          normalizeRoomId(session.room_id) === normalizedRoomId ||
          normalizeRoomId(session.room_identifier) === normalizedRoomId
        )
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null;
    }

    let best: TState | null = null;
    for (const id of Object.values(sessionIds)) {
      const session = sessionsOf(state)[id];
      if (session && (!best || session.updated_at > best.updated_at)) {
        best = session;
      }
    }
    return best;
  }

  function getStored(sessionId: string): TState | null {
    return sessionsOf(readAgentLocalState())[sessionId] ?? null;
  }

  function listStored(roomId?: string | null): TState[] {
    const normalizedRoom = normalizeRoomId(roomId) || null;
    return Object.values(sessionsOf(readAgentLocalState()))
      .filter((session) =>
        !normalizedRoom ||
        normalizeRoomId(session.room_id) === normalizedRoom ||
        normalizeRoomId(session.room_identifier) === normalizedRoom
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  function isManaged(session: TState): boolean {
    return session.desktop_managed === true || Boolean(session.delivery_mode);
  }

  function listManaged(roomId?: string | null): TState[] {
    return listStored(roomId).filter(isManaged);
  }

  function save(session: TState, makeCurrent = true): TState {
    updateAgentLocalState((state) => {
      const sessions = { ...sessionsOf(state), [session.session_id]: session };
      (state as SharedLetAgentsState)[maps.sessions] = sessions as never;
      if (makeCurrent) {
        const currentIds = { ...currentIdsOf(state), [session.room_id]: session.session_id };
        (state as SharedLetAgentsState)[maps.currentIds] = currentIds as never;
      }
      return state;
    });
    return session;
  }

  function update(
    sessionId: string,
    updater: (session: TState) => TState,
  ): TState | null {
    let updatedSession: TState | null = null;
    updateAgentLocalState((state) => {
      const existing = sessionsOf(state)[sessionId];
      if (!existing) {
        return state;
      }
      const updated = updater(existing);
      const sessions = { ...sessionsOf(state), [sessionId]: updated };
      (state as SharedLetAgentsState)[maps.sessions] = sessions as never;
      const currentIds = { ...currentIdsOf(state) };
      if (!currentIds[updated.room_id]) {
        currentIds[updated.room_id] = sessionId;
      }
      (state as SharedLetAgentsState)[maps.currentIds] = currentIds as never;
      updatedSession = updated;
      return state;
    });
    return updatedSession;
  }

  return {
    getCurrent,
    getStored,
    listStored,
    isManaged,
    listManaged,
    save,
    update,
  };
}

const codexLiveSessionStore = createLiveSessionStore<DesktopCodexLiveSessionState>({
  sessions: "codex_live_sessions",
  currentIds: "current_codex_live_session_ids",
});

const claudeCodeLiveSessionStore = createLiveSessionStore<DesktopClaudeCodeLiveSessionState>({
  sessions: "claude_code_live_sessions",
  currentIds: "current_claude_code_live_session_ids",
});

const cursorLiveSessionStore = createLiveSessionStore<DesktopCursorLiveSessionState>({
  sessions: "cursor_live_sessions",
  currentIds: "current_cursor_live_session_ids",
}, { currentLookup: "direct-or-raw" });

export function getCurrentCodexLiveSession(roomId?: string | null): DesktopCodexLiveSessionState | null {
  return codexLiveSessionStore.getCurrent(roomId);
}

export function getStoredCodexLiveSession(sessionId: string): DesktopCodexLiveSessionState | null {
  return codexLiveSessionStore.getStored(sessionId);
}

export function listStoredCodexLiveSessions(roomId?: string | null): DesktopCodexLiveSessionState[] {
  return codexLiveSessionStore.listStored(roomId);
}

export function isDesktopManagedCodexLiveSession(session: DesktopCodexLiveSessionState): boolean {
  return codexLiveSessionStore.isManaged(session);
}

export function listDesktopManagedCodexLiveSessions(roomId?: string | null): DesktopCodexLiveSessionState[] {
  return dedupeDesktopManagedCodexLiveSessions(
    codexLiveSessionStore.listManaged(roomId),
  );
}

export function codexLiveSessionProviderId(session: DesktopCodexLiveSessionState): string {
  return session.provider_id?.trim() || "codex";
}

export function listDesktopManagedCodexLiveSessionsForProvider(
  providerId: string,
  roomId?: string | null,
): DesktopCodexLiveSessionState[] {
  return listDesktopManagedCodexLiveSessions(roomId)
    .filter((session) => codexLiveSessionProviderId(session) === providerId);
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

export function isCodexAgentSession(session: StoredAgentSessionState): boolean {
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

function normalizedSessionText(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function sameSessionText(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftKey = normalizedSessionText(left);
  const rightKey = normalizedSessionText(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function desktopManagedSessionDedupeKey(session: DesktopCodexLiveSessionState): string {
  const agentSessionId = String(session.agent_session_id ?? "").trim();
  if (agentSessionId) {
    return `worker:${agentSessionId}`;
  }

  const displayName = normalizedSessionText(session.display_name);
  if (displayName) {
    return [
      "display",
      normalizeRoomId(session.room_identifier || session.room_id),
      displayName,
      normalizedSessionText(session.cwd),
      managedAgentDeliveryMode(session),
    ].join(":");
  }

  return `session:${session.session_id}`;
}

function statusSortWeight(status: DesktopManagedAgentSessionStatus): number {
  switch (status) {
    case "running":
      return 5;
    case "starting":
      return 4;
    case "completed":
      return 3;
    case "unknown":
      return 2;
    case "failed":
    case "interrupted":
      return 1;
    default:
      return 0;
  }
}

function betterDesktopManagedSession(
  current: DesktopCodexLiveSessionState,
  next: DesktopCodexLiveSessionState,
): DesktopCodexLiveSessionState {
  const currentTime = sessionTimestamp(current.updated_at);
  const nextTime = sessionTimestamp(next.updated_at);
  if (currentTime !== nextTime) {
    return nextTime > currentTime ? next : current;
  }

  const currentWeight = statusSortWeight(current.status);
  const nextWeight = statusSortWeight(next.status);
  if (currentWeight !== nextWeight) {
    return nextWeight > currentWeight ? next : current;
  }

  return next.session_id > current.session_id ? next : current;
}

function dedupeDesktopManagedCodexLiveSessions(
  sessions: DesktopCodexLiveSessionState[],
): DesktopCodexLiveSessionState[] {
  const byKey = new Map<string, DesktopCodexLiveSessionState>();
  for (const session of sessions) {
    const key = desktopManagedSessionDedupeKey(session);
    const existing = byKey.get(key);
    byKey.set(key, existing ? betterDesktopManagedSession(existing, session) : session);
  }
  return Array.from(byKey.values())
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export {
  bindCodexLiveSessionToWorker,
  codexWorkerSessionForLiveSession,
  persistedWorkerSessionIsInvalid,
  type BindCodexLiveSessionOptions,
} from "./codex-live-session-binding.js";

import {
  codexWorkerSessionForLiveSession,
  workerCanBindToLiveSession,
} from "./codex-live-session-binding.js";

export function managedAgentDeliveryMode(
  session: DesktopCodexLiveSessionState,
): DesktopManagedAgentDeliveryMode {
  return session.delivery_mode || "mcp_polling";
}

export function saveCodexLiveSession(
  session: DesktopCodexLiveSessionState,
  makeCurrent = true,
): DesktopCodexLiveSessionState {
  return codexLiveSessionStore.save(session, makeCurrent);
}

export function updateCodexLiveSession(
  sessionId: string,
  updater: (session: DesktopCodexLiveSessionState) => DesktopCodexLiveSessionState,
): DesktopCodexLiveSessionState | null {
  return codexLiveSessionStore.update(sessionId, updater);
}

export function getCurrentClaudeCodeLiveSession(roomId?: string | null): DesktopClaudeCodeLiveSessionState | null {
  return claudeCodeLiveSessionStore.getCurrent(roomId);
}

export function getStoredClaudeCodeLiveSession(sessionId: string): DesktopClaudeCodeLiveSessionState | null {
  return claudeCodeLiveSessionStore.getStored(sessionId);
}

export function listStoredClaudeCodeLiveSessions(roomId?: string | null): DesktopClaudeCodeLiveSessionState[] {
  return claudeCodeLiveSessionStore.listStored(roomId);
}

export function isDesktopManagedClaudeCodeLiveSession(session: DesktopClaudeCodeLiveSessionState): boolean {
  return claudeCodeLiveSessionStore.isManaged(session);
}

export function listDesktopManagedClaudeCodeLiveSessions(roomId?: string | null): DesktopClaudeCodeLiveSessionState[] {
  return claudeCodeLiveSessionStore.listManaged(roomId);
}

export function listClaudeCodeDisplayNamesForRoom(roomId: string): string[] {
  const normalizedRoom = normalizeRoomId(roomId);
  if (!normalizedRoom) {
    return [];
  }

  const state = readAgentLocalState();
  const liveSessionNames = Object.values(state.claude_code_live_sessions ?? {})
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
      isClaudeCodeAgentSession(session)
    )
    .flatMap((session) => [session.display_name, session.actor_label]);

  return [...liveSessionNames, ...workerNames]
    .map((name) => String(name ?? "").trim())
    .filter(Boolean);
}

export function getCurrentCursorLiveSession(roomId?: string | null): DesktopCursorLiveSessionState | null {
  return cursorLiveSessionStore.getCurrent(roomId);
}

export function getStoredCursorLiveSession(sessionId: string): DesktopCursorLiveSessionState | null {
  return cursorLiveSessionStore.getStored(sessionId);
}

export function listStoredCursorLiveSessions(roomId?: string | null): DesktopCursorLiveSessionState[] {
  return cursorLiveSessionStore.listStored(roomId);
}

export function isDesktopManagedCursorLiveSession(session: DesktopCursorLiveSessionState): boolean {
  return cursorLiveSessionStore.isManaged(session);
}

export function listDesktopManagedCursorLiveSessions(roomId?: string | null): DesktopCursorLiveSessionState[] {
  return cursorLiveSessionStore.listManaged(roomId);
}

export function listCursorDisplayNamesForRoom(roomId: string): string[] {
  const normalizedRoom = normalizeRoomId(roomId);
  if (!normalizedRoom) {
    return [];
  }

  const state = readAgentLocalState();
  const liveSessionNames = Object.values(state.cursor_live_sessions ?? {})
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
      isCursorAgentSession(session)
    )
    .flatMap((session) => [session.display_name, session.actor_label]);

  return [...liveSessionNames, ...workerNames]
    .map((name) => String(name ?? "").trim())
    .filter(Boolean);
}

function isClaudeCodeAgentSession(session: StoredAgentSessionState): boolean {
  const runtime = String(session.runtime ?? "").trim().toLowerCase();
  const ideLabel = String(session.ide_label ?? "").trim().toLowerCase();
  const livenessCapability = String(session.liveness_capability ?? "").trim().toLowerCase();
  const toolBridgeId = String(session.tool_bridge_id ?? "").trim().toLowerCase();

  return runtime === "claude-code" ||
    runtime.startsWith("claude-code:") ||
    ideLabel === "claude code" ||
    livenessCapability.includes("claude") ||
    /(^|:)claude-code(:|$)/.test(toolBridgeId);
}

function isCursorAgentSession(session: StoredAgentSessionState): boolean {
  const runtime = String(session.runtime ?? "").trim().toLowerCase();
  const ideLabel = String(session.ide_label ?? "").trim().toLowerCase();
  const livenessCapability = String(session.liveness_capability ?? "").trim().toLowerCase();
  const toolBridgeId = String(session.tool_bridge_id ?? "").trim().toLowerCase();

  return runtime === "cursor" ||
    runtime.startsWith("cursor:") ||
    ideLabel === "cursor" ||
    livenessCapability.includes("cursor") ||
    /(^|:)cursor(:|$)/.test(toolBridgeId);
}

export function saveClaudeCodeLiveSession(
  session: DesktopClaudeCodeLiveSessionState,
  makeCurrent = true,
): DesktopClaudeCodeLiveSessionState {
  return claudeCodeLiveSessionStore.save(session, makeCurrent);
}

export function updateClaudeCodeLiveSession(
  sessionId: string,
  updater: (session: DesktopClaudeCodeLiveSessionState) => DesktopClaudeCodeLiveSessionState,
): DesktopClaudeCodeLiveSessionState | null {
  return claudeCodeLiveSessionStore.update(sessionId, updater);
}

export function saveCursorLiveSession(
  session: DesktopCursorLiveSessionState,
  makeCurrent = true,
): DesktopCursorLiveSessionState {
  return cursorLiveSessionStore.save(session, makeCurrent);
}

export function updateCursorLiveSession(
  sessionId: string,
  updater: (session: DesktopCursorLiveSessionState) => DesktopCursorLiveSessionState,
): DesktopCursorLiveSessionState | null {
  return cursorLiveSessionStore.update(sessionId, updater);
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
  const persistedWorkerActive = Boolean(
    persistedWorker &&
    !persistedWorker.ended_at &&
    workerCanBindToLiveSession(persistedWorker, session),
  );
  const activeWorkerSessionId = workerSession?.session_id ?? (persistedWorkerActive ? session.agent_session_id ?? null : null);
  const displayName = publicDisplayNameForCodexSession(session, workerSession);
  const providerId = codexLiveSessionProviderId(session);
  const permissionProfile = managedAgentPermissionProfileForProvider(providerId, session.permission_profile_id);
  return {
    id: session.session_id,
    providerId,
    runtime: providerId,
    roomIdentifier: session.room_identifier || session.room_id,
    roomDisplayName: session.room_display_name ?? null,
    repoRootPath: session.cwd,
    repoBranch: session.repo_branch ?? null,
    status: session.status,
    deliveryMode: managedAgentDeliveryMode(session),
    permissionProfileId: permissionProfile.id,
    permissionProfile,
    canStop: Boolean(activeWorkerSessionId) &&
      (
        session.status === "starting" ||
        session.status === "running" ||
        session.status === "unknown" ||
        (managedAgentDeliveryMode(session) === "desktop_events" && session.status === "completed")
      ),
    agentSessionId: activeWorkerSessionId,
    actorLabel: nonGenericCodexName(workerSession?.actor_label) ?? displayName,
    agentKey: workerSession?.agent_key ?? providerId,
    displayName,
    ownerLabel: workerSession?.owner_label ?? "Local desktop",
    ideLabel: workerSession?.ide_label ?? (providerId === "open-model" ? "Open Model" : "Codex"),
    model: session.model ?? null,
    effort: session.effort ?? null,
    reasoningSessionId: session.reasoning_session_id ?? null,
    activeWork: session.active_work
      ? {
        kind: session.active_work.kind,
        eventId: session.active_work.event_id ?? null,
        startedAt: session.active_work.started_at,
        summary: session.active_work.summary ?? null,
      }
      : null,
    pendingPermissionRequests: [],
    startedAt: session.started_at,
    updatedAt: session.updated_at,
    lastError: session.last_error ?? null,
  };
}

function nonGenericClaudeCodeName(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || /^claude(?:\s+code)?(?:\s+\d+)?$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function workerHasExactClaudeCodeMarker(
  worker: StoredAgentSessionState,
  session: DesktopClaudeCodeLiveSessionState,
): boolean {
  const token = String(session.token ?? "").trim();
  if (!token) {
    return false;
  }
  const runtimeMarker = `claude-code:${token}`;
  const instanceMarker = `desktop-claude-code:${token}`;
  return String(worker.runtime ?? "").trim() === runtimeMarker ||
    String(worker.agent_instance_id ?? "").trim() === instanceMarker ||
    String(worker.tool_bridge_id ?? "").includes(runtimeMarker) ||
    String(worker.tool_bridge_id ?? "").includes(instanceMarker);
}

function workerCanRepresentClaudeCodeSession(
  worker: StoredAgentSessionState,
  session: DesktopClaudeCodeLiveSessionState,
): boolean {
  if (
    normalizeRoomId(worker.room_id) !== normalizeRoomId(session.room_id) ||
    worker.session_kind !== "worker" ||
    worker.ended_at ||
    !isClaudeCodeAgentSession(worker)
  ) {
    return false;
  }
  return worker.session_id === session.agent_session_id ||
    workerHasExactClaudeCodeMarker(worker, session) ||
    sameSessionText(worker.display_name, session.display_name) ||
    sameSessionText(worker.actor_label, session.display_name);
}

function publicDisplayNameForClaudeCodeSession(
  session: DesktopClaudeCodeLiveSessionState,
  workerSession: StoredAgentSessionState | null,
): string {
  return nonGenericClaudeCodeName(workerSession?.display_name) ||
    nonGenericClaudeCodeName(session.display_name) ||
    nonGenericClaudeCodeName(workerSession?.actor_label) ||
    suggestLetAgentsCodename(listClaudeCodeDisplayNamesForRoom(session.room_id), session.token || session.session_id);
}

export function toPublicClaudeCodeManagedAgentSession(
  session: DesktopClaudeCodeLiveSessionState,
): DesktopManagedAgentSession {
  const state = readAgentLocalState();
  const persistedWorker = session.agent_session_id
    ? state.agent_sessions?.[session.agent_session_id] ?? null
    : null;
  const persistedWorkerActive = Boolean(
    persistedWorker &&
    workerCanRepresentClaudeCodeSession(persistedWorker, session),
  );
  const activeWorkerSessionId = persistedWorkerActive ? session.agent_session_id ?? null : null;
  const workerSession = persistedWorkerActive ? persistedWorker : null;
  const displayName = publicDisplayNameForClaudeCodeSession(session, workerSession);
  const deliveryMode = session.delivery_mode || "desktop_events";
  const permissionProfile = managedAgentPermissionProfileForProvider("claude-code", session.permission_profile_id);
  return {
    id: session.session_id,
    providerId: "claude-code",
    runtime: "claude-code",
    roomIdentifier: session.room_identifier || session.room_id,
    roomDisplayName: session.room_display_name ?? null,
    repoRootPath: session.cwd,
    repoBranch: session.repo_branch ?? null,
    status: session.status,
    deliveryMode,
    permissionProfileId: permissionProfile.id,
    permissionProfile,
    canStop: Boolean(activeWorkerSessionId) &&
      (
        session.status === "starting" ||
        session.status === "running" ||
        session.status === "unknown" ||
        (deliveryMode === "desktop_events" && session.status === "completed")
      ),
    agentSessionId: activeWorkerSessionId,
    actorLabel: nonGenericClaudeCodeName(workerSession?.actor_label) ?? displayName,
    agentKey: workerSession?.agent_key ?? "claude-code",
    displayName,
    ownerLabel: workerSession?.owner_label ?? "Local desktop",
    ideLabel: workerSession?.ide_label ?? "Claude Code",
    model: session.model ?? null,
    effort: session.effort ?? null,
    reasoningSessionId: session.claude_session_id ?? null,
    activeWork: session.active_work
      ? {
        kind: session.active_work.kind,
        eventId: session.active_work.event_id ?? null,
        startedAt: session.active_work.started_at,
        summary: session.active_work.summary ?? null,
      }
      : null,
    pendingPermissionRequests: session.pending_permission_requests ?? [],
    startedAt: session.started_at,
    updatedAt: session.updated_at,
    lastError: session.last_error ?? null,
  };
}

function nonGenericCursorName(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || /^cursor(?:\s+\d+)?$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function workerHasExactCursorMarker(
  worker: StoredAgentSessionState,
  session: DesktopCursorLiveSessionState,
): boolean {
  const token = String(session.token ?? "").trim();
  if (!token) {
    return false;
  }
  const runtimeMarker = `cursor:${token}`;
  const instanceMarker = `desktop-cursor:${token}`;
  return String(worker.runtime ?? "").trim() === runtimeMarker ||
    String(worker.agent_instance_id ?? "").trim() === instanceMarker ||
    String(worker.tool_bridge_id ?? "").includes(runtimeMarker) ||
    String(worker.tool_bridge_id ?? "").includes(instanceMarker);
}

function workerCanRepresentCursorSession(
  worker: StoredAgentSessionState,
  session: DesktopCursorLiveSessionState,
): boolean {
  if (
    normalizeRoomId(worker.room_id) !== normalizeRoomId(session.room_id) ||
    worker.session_kind !== "worker" ||
    worker.ended_at ||
    !isCursorAgentSession(worker)
  ) {
    return false;
  }
  return worker.session_id === session.agent_session_id ||
    workerHasExactCursorMarker(worker, session) ||
    sameSessionText(worker.display_name, session.display_name) ||
    sameSessionText(worker.actor_label, session.display_name);
}

function publicDisplayNameForCursorSession(
  session: DesktopCursorLiveSessionState,
  workerSession: StoredAgentSessionState | null,
): string {
  return nonGenericCursorName(workerSession?.display_name) ||
    nonGenericCursorName(session.display_name) ||
    nonGenericCursorName(workerSession?.actor_label) ||
    suggestLetAgentsCodename(listCursorDisplayNamesForRoom(session.room_id), session.token || session.session_id);
}

export function toPublicCursorManagedAgentSession(
  session: DesktopCursorLiveSessionState,
): DesktopManagedAgentSession {
  const state = readAgentLocalState();
  const persistedWorker = session.agent_session_id
    ? state.agent_sessions?.[session.agent_session_id] ?? null
    : null;
  const persistedWorkerActive = Boolean(
    persistedWorker &&
    workerCanRepresentCursorSession(persistedWorker, session),
  );
  const activeWorkerSessionId = persistedWorkerActive ? session.agent_session_id ?? null : null;
  const workerSession = persistedWorkerActive ? persistedWorker : null;
  const displayName = publicDisplayNameForCursorSession(session, workerSession);
  const deliveryMode = session.delivery_mode || "desktop_events";
  const permissionProfile = managedAgentPermissionProfileForProvider("cursor", session.permission_profile_id);
  const cursorMcpPolicy = session.cursor_mcp_policy ?? "filter_letagents";
  return {
    id: session.session_id,
    providerId: "cursor",
    runtime: "cursor",
    roomIdentifier: session.room_identifier || session.room_id,
    roomDisplayName: session.room_display_name ?? null,
    repoRootPath: session.cwd,
    repoBranch: session.repo_branch ?? null,
    status: session.status,
    deliveryMode,
    permissionProfileId: permissionProfile.id,
    permissionProfile,
    cursorMcpPolicy,
    canStop: Boolean(activeWorkerSessionId) &&
      (
        session.status === "starting" ||
        session.status === "running" ||
        session.status === "unknown" ||
        (deliveryMode === "desktop_events" && session.status === "completed")
      ),
    agentSessionId: activeWorkerSessionId,
    actorLabel: nonGenericCursorName(workerSession?.actor_label) ?? displayName,
    agentKey: workerSession?.agent_key ?? "cursor",
    displayName,
    ownerLabel: workerSession?.owner_label ?? "Local desktop",
    ideLabel: workerSession?.ide_label ?? "Cursor",
    model: session.model ?? null,
    effort: session.effort ?? null,
    reasoningSessionId: session.cursor_session_id ?? null,
    activeWork: session.active_work
      ? {
        kind: session.active_work.kind,
        eventId: session.active_work.event_id ?? null,
        startedAt: session.active_work.started_at,
        summary: session.active_work.summary ?? null,
      }
      : null,
    pendingPermissionRequests: session.pending_permission_requests ?? [],
    startedAt: session.started_at,
    updatedAt: session.updated_at,
    lastError: session.last_error ?? null,
  };
}
