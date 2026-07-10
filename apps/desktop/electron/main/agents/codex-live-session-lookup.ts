import type {
  DesktopCodexLiveSessionState,
  SharedLetAgentsState,
  StoredAgentSessionState,
} from "./state.js";
import {
  isCodexAgentSession,
  normalizeRoomId,
} from "./state.js";

export interface BindCodexLiveSessionOptions {
  allowStaleSingleCandidate?: boolean;
}

const CODEX_WORKER_BINDING_GRACE_MS = 2 * 60_000;


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

export function workerCanBindToLiveSession(
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

export function codexWorkerSessionForLiveSession(
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

export function persistedWorkerSessionIsInvalid(
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

