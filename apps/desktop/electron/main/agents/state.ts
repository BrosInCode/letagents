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

const CODEX_WORKER_BINDING_GRACE_MS = 2 * 60_000;

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
  return dedupeDesktopManagedCodexLiveSessions(
    listStoredCodexLiveSessions(roomId).filter(isDesktopManagedCodexLiveSession),
  );
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

function normalizedSessionText(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function sameSessionText(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftKey = normalizedSessionText(left);
  const rightKey = normalizedSessionText(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function workerHasExactLiveSessionMarker(
  worker: StoredAgentSessionState,
  session: DesktopCodexLiveSessionState,
): boolean {
  const token = String(session.token ?? "").trim();
  if (!token) {
    return false;
  }
  const runtimeMarker = `codex:${token}`;
  const instanceMarker = `desktop-codex:${token}`;
  return String(worker.runtime ?? "").trim() === runtimeMarker ||
    String(worker.agent_instance_id ?? "").trim() === instanceMarker ||
    String(worker.tool_bridge_id ?? "").includes(runtimeMarker) ||
    String(worker.tool_bridge_id ?? "").includes(instanceMarker);
}

function workerLabelMatchesLiveSession(
  worker: StoredAgentSessionState,
  session: DesktopCodexLiveSessionState,
): boolean {
  const displayName = normalizedSessionText(session.display_name);
  if (!displayName) {
    return true;
  }
  return sameSessionText(worker.display_name, session.display_name) ||
    sameSessionText(worker.actor_label, session.display_name);
}

function workerStartedNearLiveSession(
  worker: StoredAgentSessionState,
  session: DesktopCodexLiveSessionState,
): boolean {
  const startedAt = sessionTimestamp(session.started_at);
  const createdAt = sessionTimestamp(worker.created_at);
  if (!startedAt || !createdAt) {
    return false;
  }
  return createdAt >= startedAt - 1_000 &&
    createdAt <= startedAt + CODEX_WORKER_BINDING_GRACE_MS;
}

function workerCanBindToLiveSession(
  worker: StoredAgentSessionState,
  session: DesktopCodexLiveSessionState,
): boolean {
  if (workerHasExactLiveSessionMarker(worker, session)) {
    return true;
  }
  return workerStartedNearLiveSession(worker, session) &&
    workerLabelMatchesLiveSession(worker, session);
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
    if (
      bound &&
      candidates.some((candidate) => candidate.session_id === bound.session_id) &&
      workerCanBindToLiveSession(bound, session)
    ) {
      return bound;
    }
  }

  const exactRuntimeMatches = candidates.filter((candidate) =>
    workerHasExactLiveSessionMarker(candidate, session)
  );
  if (exactRuntimeMatches.length === 1) {
    return exactRuntimeMatches[0] ?? null;
  }

  const plausibleStartupMatches = candidates.filter((candidate) =>
    workerStartedNearLiveSession(candidate, session) &&
    workerLabelMatchesLiveSession(candidate, session)
  );
  if (plausibleStartupMatches.length === 1) {
    return plausibleStartupMatches[0] ?? null;
  }

  const allowStaleSingleCandidate = options.allowStaleSingleCandidate === true;
  const staleLabelMatches = candidates.filter((candidate) =>
    workerLabelMatchesLiveSession(candidate, session)
  );
  return allowStaleSingleCandidate && plausibleStartupMatches.length === 0 && staleLabelMatches.length === 1
    ? staleLabelMatches[0] ?? null
    : null;
}

function persistedWorkerSessionIsInvalid(
  state: SharedLetAgentsState,
  session: DesktopCodexLiveSessionState,
): boolean {
  if (!session.agent_session_id) {
    return false;
  }
  const persisted = state.agent_sessions?.[session.agent_session_id];
  if (!persisted || persisted.ended_at) {
    return true;
  }
  if (
    persisted.session_kind !== "worker" ||
    !isCodexAgentSession(persisted) ||
    normalizeRoomId(persisted.room_id) !== normalizeRoomId(session.room_id)
  ) {
    return true;
  }
  return !workerCanBindToLiveSession(persisted, session);
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

export function bindCodexLiveSessionToWorker(
  session: DesktopCodexLiveSessionState,
  options: BindCodexLiveSessionOptions = {},
): DesktopCodexLiveSessionState {
  const state = readAgentLocalState();
  const workerSession = codexWorkerSessionForLiveSession(state, session, options);
  if (!workerSession) {
    if (persistedWorkerSessionIsInvalid(state, session)) {
      return updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        agent_session_id: null,
        updated_at: new Date().toISOString(),
      })) ?? {
        ...session,
        agent_session_id: null,
      };
    }
    return session;
  }
  if (workerSession.session_id === session.agent_session_id) {
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
  const persistedWorkerActive = Boolean(
    persistedWorker &&
    !persistedWorker.ended_at &&
    workerCanBindToLiveSession(persistedWorker, session),
  );
  const activeWorkerSessionId = workerSession?.session_id ?? (persistedWorkerActive ? session.agent_session_id ?? null : null);
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
    canStop: Boolean(activeWorkerSessionId) &&
      (
        session.status === "starting" ||
        session.status === "running" ||
        session.status === "unknown" ||
        (managedAgentDeliveryMode(session) === "desktop_events" && session.status === "completed")
      ),
    agentSessionId: activeWorkerSessionId,
    actorLabel: nonGenericCodexName(workerSession?.actor_label) ?? displayName,
    agentKey: workerSession?.agent_key ?? "codex",
    displayName,
    ownerLabel: workerSession?.owner_label ?? "Local desktop",
    ideLabel: workerSession?.ide_label ?? "Codex",
    reasoningSessionId: session.reasoning_session_id ?? null,
    activeWork: session.active_work
      ? {
        kind: session.active_work.kind,
        eventId: session.active_work.event_id ?? null,
        startedAt: session.active_work.started_at,
        summary: session.active_work.summary ?? null,
      }
      : null,
    startedAt: session.started_at,
    updatedAt: session.updated_at,
    lastError: session.last_error ?? null,
  };
}
