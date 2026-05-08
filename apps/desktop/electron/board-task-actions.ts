import { existsSync, readFileSync } from "node:fs";

import type {
  DesktopTaskReviewWorkerActionInput,
  DesktopTaskWorkerActionInput,
  WorkerSnapshot,
} from "./ipc-types.js";

export type StoredLocalAgentSession = {
  session_id?: string;
  session_token?: string;
  room_id?: string;
  session_kind?: "worker" | "controller" | string;
  runtime?: string;
  actor_label?: string;
  agent_key?: string;
  agent_instance_id?: string | null;
  display_name?: string;
  owner_label?: string;
  ide_label?: string;
  created_at?: string;
  updated_at?: string;
  last_seen_at?: string;
  ended_at?: string | null;
};

export type StoredLetAgentsLocalState = {
  agent_sessions?: Record<string, StoredLocalAgentSession>;
  current_agent_session_ids?: Record<string, string>;
};

export function normalizeRoomIdentifierKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function readLetAgentsLocalState(statePath: string): StoredLetAgentsLocalState {
  try {
    if (!existsSync(statePath)) return {};
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as StoredLetAgentsLocalState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function localWorkerState(session: StoredLocalAgentSession, now = Date.now()): WorkerSnapshot["state"] {
  if (session.ended_at) return "offline";
  const lastSeen = Date.parse(session.last_seen_at || session.updated_at || "");
  if (!Number.isFinite(lastSeen)) return "away";
  const ageMs = now - lastSeen;
  if (ageMs < 2 * 60 * 1000) return "connected";
  if (ageMs < 15 * 60 * 1000) return "away";
  return "offline";
}

export function localSessionTimestamp(session: StoredLocalAgentSession): number {
  const timestamp = Date.parse(session.updated_at || session.last_seen_at || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function getLocalWorkerSessions(
  state: StoredLetAgentsLocalState,
  roomIdentifier?: string | null,
  now = Date.now()
): StoredLocalAgentSession[] {
  const targetRoom = normalizeRoomIdentifierKey(roomIdentifier);
  return Object.values(state.agent_sessions || {})
    .filter((session) =>
      session.session_kind === "worker"
      && session.session_id
      && session.session_token
      && session.actor_label
      && session.agent_key
      && !session.ended_at
      && localWorkerState(session, now) !== "offline"
      && (!targetRoom || normalizeRoomIdentifierKey(session.room_id) === targetRoom)
    )
    .sort((left, right) => localSessionTimestamp(right) - localSessionTimestamp(left));
}

export function getCurrentLocalWorkerSession(
  state: StoredLetAgentsLocalState,
  roomIdentifier: string,
  now = Date.now()
): StoredLocalAgentSession | null {
  const targetRoom = normalizeRoomIdentifierKey(roomIdentifier);
  const currentSessionId = Object.entries(state.current_agent_session_ids || {})
    .find(([roomId]) => normalizeRoomIdentifierKey(roomId) === targetRoom)?.[1] ?? null;
  const current = currentSessionId ? state.agent_sessions?.[currentSessionId] ?? null : null;
  if (
    current?.session_kind === "worker"
    && current.session_id
    && current.session_token
    && current.actor_label
    && current.agent_key
    && !current.ended_at
    && localWorkerState(current, now) !== "offline"
    && normalizeRoomIdentifierKey(current.room_id) === targetRoom
  ) {
    return current;
  }
  return getLocalWorkerSessions(state, roomIdentifier, now)[0] || null;
}

export function buildWorkerActionPatch(
  taskId: string,
  session: StoredLocalAgentSession,
  input: DesktopTaskWorkerActionInput
): Record<string, unknown> {
  const base = {
    agent_session_id: session.session_id,
    agent_session_token: session.session_token,
  };
  switch (input.action) {
    case "claim":
      return {
        ...base,
        status: "assigned",
        assignee: session.actor_label,
        assignee_agent_key: session.agent_key,
      };
    case "start":
    case "resume":
      return { ...base, status: "in_progress" };
    case "block":
      return { ...base, status: "blocked" };
    case "submit_review":
      return { ...base, status: "in_review" };
    default:
      throw new Error(`Unsupported worker action for ${taskId}.`);
  }
}

export function buildReviewWorkerActionBody(
  session: StoredLocalAgentSession,
  input: DesktopTaskReviewWorkerActionInput
): Record<string, unknown> {
  return {
    action: input.action,
    lease_id: input.lease_id ?? null,
    reason: input.reason ?? null,
    agent_session_id: session.session_id,
    agent_session_token: session.session_token,
  };
}

export function buildWorkerSnapshots(
  state: StoredLetAgentsLocalState,
  now = Date.now()
): WorkerSnapshot[] {
  return Object.values(state.agent_sessions || {})
    .filter((session) => session.session_kind === "worker" && session.session_id)
    .sort((left, right) => localSessionTimestamp(right) - localSessionTimestamp(left))
    .map((session) => ({
      id: session.session_id || `${session.agent_key || "worker"}:${session.room_id || "room"}`,
      runtime: session.runtime || "worker",
      state: localWorkerState(session, now),
      roomId: session.room_id || null,
      actorLabel: session.actor_label || null,
      agentKey: session.agent_key || null,
      agentSessionId: session.session_id || null,
      detail: [
        session.actor_label || session.display_name || "Local worker",
        session.room_id ? `in ${session.room_id}` : null,
      ].filter(Boolean).join(" "),
    }));
}
