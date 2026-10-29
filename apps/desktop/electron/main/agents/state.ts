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
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { getLetAgentsLocalStatePath } from "../paths.js";
import { ownerPrivatePlatform, protectOwnerPrivateSync, writePrivateFileAtomicallySync } from "../../../../../shared/owner-private-fs.mjs";

const STATE_LOCK_WAIT_MS = 25;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STATE_LOCK_STALE_MS = 10_000;
const STATE_LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export type DesktopCodexJoinedVia = "join_code" | "join_room";

/**
 * The desktop's share of `~/.letagents` local state. Room worker sessions and
 * the host identity live here; the daemon owns every agent runtime.
 */
export interface SharedLetAgentsState {
  agent_identity?: StoredAgentIdentityState;
  agent_identities?: Record<string, StoredAgentIdentityState>;
  local_host_id?: string;
  agent_sessions?: Record<string, StoredAgentSessionState>;
  current_agent_session_ids?: Record<string, string>;
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

/**
 * The state file is shared with the `letagents` MCP package, so every key the
 * desktop does not own is kept as it is. The Claude and Cursor live-session
 * caches belonged only to the retired Electron engine and are dropped on
 * load, so the next write cannot revive them. The Codex live-session keys
 * also served the package's `start_local_codex_session` tools, which letagents
 * 0.12.46 removed; an older package version may still use them, so only the
 * entries the retired engine owned (marked `desktop_managed` or carrying a
 * `delivery_mode`) are dropped.
 */
function parseLocalState(raw: string): SharedLetAgentsState {
  const parsed = JSON.parse(raw) as SharedLetAgentsState & SharedCodexLiveSessionKeys & {
    current_claude_code_live_session_ids?: unknown;
    claude_code_live_sessions?: unknown;
    current_cursor_live_session_ids?: unknown;
    cursor_live_sessions?: unknown;
  };
  if (!parsed || typeof parsed !== "object") return {};
  const {
    current_claude_code_live_session_ids: _legacyCurrentClaudeSessionIds,
    claude_code_live_sessions: _legacyClaudeSessions,
    current_cursor_live_session_ids: _legacyCurrentCursorSessionIds,
    cursor_live_sessions: _legacyCursorSessions,
    ...current
  } = parsed;
  dropDesktopManagedCodexSessions(current);
  return current;
}

/** The Codex live-session keys the `letagents` MCP package owns in the same file. */
interface SharedCodexLiveSessionKeys {
  current_codex_live_session_ids?: Record<string, string>;
  codex_live_sessions?: Record<string, { desktop_managed?: unknown; delivery_mode?: unknown } | null>;
}

function dropDesktopManagedCodexSessions(state: SharedCodexLiveSessionKeys): void {
  const sessions = state.codex_live_sessions;
  if (!sessions || typeof sessions !== "object") return;
  const removed = new Set<string>();
  for (const [sessionId, session] of Object.entries(sessions)) {
    const desktopOwned = session && typeof session === "object"
      && (session.desktop_managed === true || typeof session.delivery_mode === "string");
    if (desktopOwned) {
      delete sessions[sessionId];
      removed.add(sessionId);
    }
  }
  if (Object.keys(sessions).length === 0) delete state.codex_live_sessions;
  const currentIds = state.current_codex_live_session_ids;
  if (!currentIds || typeof currentIds !== "object") return;
  for (const [roomId, sessionId] of Object.entries(currentIds)) {
    if (removed.has(sessionId)) delete currentIds[roomId];
  }
  if (Object.keys(currentIds).length === 0) delete state.current_codex_live_session_ids;
}

function readLocalStateFromPath(statePath: string): SharedLetAgentsState {
  if (!existsSync(statePath)) return {};
  try {
    return parseLocalState(readFileSync(statePath, "utf-8"));
  } catch {
    return {};
  }
}

export function readAgentLocalStateSnapshot(): {
  state: SharedLetAgentsState;
  complete: boolean;
} {
  const statePath = getLetAgentsLocalStatePath();
  if (!existsSync(statePath)) {
    return { state: {}, complete: true };
  }

  try {
    return { state: parseLocalState(readFileSync(statePath, "utf-8")), complete: true };
  } catch {
    return { state: {}, complete: false };
  }
}

export function readAgentLocalState(): SharedLetAgentsState {
  return readAgentLocalStateSnapshot().state;
}

function writeLocalStateUnlocked(statePath: string, state: SharedLetAgentsState): void {
  // Windows has no mode bits: the shared writer makes the file private before
  // any token is written in it, and before it is published.
  if (ownerPrivatePlatform() === "win32") {
    writePrivateFileAtomicallySync(statePath, `${JSON.stringify(state, null, 2)}\n`, { syncDirectory: false });
    return;
  }
  const tempPath = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let tempFd: number | null = null;
  try {
    tempFd = openSync(tempPath, "w", 0o600);
    writeFileSync(tempFd, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    closeSync(tempFd);
    tempFd = null;
    renameSync(tempPath, statePath);
    protectOwnerPrivateSync(statePath, "file");
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

/**
 * The host id is made once and never changes, but the grant coordinator, the
 * rental handlers and local supervision asked for it on many calls, and each
 * call read and parsed the whole shared state file.
 * Rule: remember the id for the state path it came from. Trust it for
 * `HOST_ID_RECHECK_MS` (30 s) and only while the state file still exists. After
 * that, or if the path changes or the file is gone, read the file again.
 * Bound: one entry.
 */
const HOST_ID_RECHECK_MS = 30_000;
let cachedHostId: { path: string; hostId: string; verifiedAt: number } | null = null;

export function clearDesktopHostIdCacheForTest(): void {
  cachedHostId = null;
}

export function getOrCreateDesktopHostId(): string {
  const statePath = getLetAgentsLocalStatePath();
  const cached = cachedHostId;
  if (cached && cached.path === statePath && Date.now() - cached.verifiedAt < HOST_ID_RECHECK_MS
    && existsSync(statePath)) {
    return cached.hostId;
  }
  const hostId = resolveDesktopHostId();
  cachedHostId = { path: statePath, hostId, verifiedAt: Date.now() };
  return hostId;
}

function resolveDesktopHostId(): string {
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
