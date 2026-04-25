import assert from "node:assert/strict";
import test from "node:test";

import { deriveCodexLiveSessionStatus } from "../codex-session.js";
import type { CodexLiveSessionState } from "../local-state.js";

const baseSession: CodexLiveSessionState = {
  session_id: "session_1",
  room_id: "room_1",
  room_identifier: "room_1",
  joined_via: "join_room",
  cwd: "/tmp/letagents",
  stop_phrase: "/stop-codex-room",
  max_minutes: 0,
  deadline_utc: null,
  token: "LOCAL_CODEX_ROOM_test",
  thread_id: "thread_1",
  turn_id: "turn_1",
  server_url: "ws://127.0.0.1:8765",
  server_pid: null,
  launched_server: false,
  codex_bin: "codex",
  status: "running",
  last_error: null,
  started_at: "2026-04-25T00:00:00.000Z",
  updated_at: "2026-04-25T00:00:00.000Z",
};

test("deriveCodexLiveSessionStatus treats systemError as failed before completed turn state", () => {
  assert.equal(
    deriveCodexLiveSessionStatus(baseSession, true, "systemError", "completed"),
    "failed"
  );
});

test("deriveCodexLiveSessionStatus preserves normal completed turns", () => {
  assert.equal(
    deriveCodexLiveSessionStatus(baseSession, true, "active", "completed"),
    "completed"
  );
});
