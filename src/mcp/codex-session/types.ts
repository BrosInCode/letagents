import type { CodexLiveSessionState } from "../local-state.js";
import type { JoinedVia } from "../room-id.js";

export interface LocalCodexSessionStatus {
  session: CodexLiveSessionState;
  server_reachable: boolean;
  thread_status: unknown;
  turn_status: unknown;
  recent_items: Array<Record<string, unknown>>;
}

export interface StartLocalCodexSessionInput {
  room_id: string;
  room_identifier: string;
  room_code?: string | null;
  room_display_name?: string | null;
  joined_via: JoinedVia;
  cwd?: string;
  stop_phrase?: string;
  max_minutes?: number;
  server_url?: string;
  codex_bin?: string;
}

export interface StartLocalCodexSessionResult {
  session: CodexLiveSessionState;
  reused: boolean;
}

export interface StopLocalCodexSessionOptions {
  session_id?: string | null;
  room_id?: string | null;
  shutdown_server?: boolean;
}

export interface NewCodexSessionStateInput {
  session_id: string;
  room_id: string;
  room_identifier: string;
  room_code?: string | null;
  room_display_name?: string | null;
  joined_via: JoinedVia;
  cwd: string;
  repo_branch?: string | null;
  stop_phrase: string;
  max_minutes: number;
  deadline_utc: string | null;
  token: string;
  thread_id: string;
  turn_id: string;
  server_url: string;
  server_pid: number | null;
  launched_server: boolean;
  codex_bin: string;
}
