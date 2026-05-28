import type { CodexLiveSessionState } from "../local-state.js";
import type { NewCodexSessionStateInput } from "./types.js";

export function toSessionState(input: NewCodexSessionStateInput): CodexLiveSessionState {
  const now = new Date().toISOString();
  return {
    session_id: input.session_id,
    room_id: input.room_id,
    room_identifier: input.room_identifier,
    room_code: input.room_code ?? null,
    room_display_name: input.room_display_name ?? null,
    joined_via: input.joined_via,
    cwd: input.cwd,
    stop_phrase: input.stop_phrase,
    max_minutes: input.max_minutes,
    deadline_utc: input.deadline_utc,
    token: input.token,
    thread_id: input.thread_id,
    turn_id: input.turn_id,
    server_url: input.server_url,
    server_pid: input.server_pid,
    launched_server: input.launched_server,
    codex_bin: input.codex_bin,
    status: "running",
    last_error: null,
    started_at: now,
    updated_at: now,
  };
}

export function toPublicCodexLiveSession(
  session: CodexLiveSessionState
): Record<string, unknown> {
  return {
    session_id: session.session_id,
    room_id: session.room_id,
    room_code: session.room_code ?? null,
    room_display_name: session.room_display_name ?? null,
    joined_via: session.joined_via,
    cwd: session.cwd,
    stop_phrase: session.stop_phrase,
    max_minutes: session.max_minutes,
    deadline_utc: session.deadline_utc ?? null,
    thread_id: session.thread_id,
    turn_id: session.turn_id,
    server_url: session.server_url,
    server_pid: session.server_pid ?? null,
    launched_server: session.launched_server,
    agent_session_id: session.agent_session_id ?? null,
    status: session.status,
    last_error: session.last_error ?? null,
    started_at: session.started_at,
    updated_at: session.updated_at,
  };
}
