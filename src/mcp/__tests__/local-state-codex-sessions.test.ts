import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listStoredCodexLiveSessionsForRoom,
  saveCodexLiveSession,
  type CodexLiveSessionState,
} from "../local-state.js";

function makeSession(overrides: Partial<CodexLiveSessionState>): CodexLiveSessionState {
  return {
    session_id: overrides.session_id ?? randomUUID(),
    room_id: overrides.room_id ?? "room-1",
    room_identifier: overrides.room_identifier ?? "room-1",
    room_code: overrides.room_code ?? null,
    room_display_name: overrides.room_display_name ?? null,
    joined_via: overrides.joined_via ?? "join_room",
    cwd: overrides.cwd ?? "/tmp/repo",
    stop_phrase: overrides.stop_phrase ?? "/stop-codex-room",
    max_minutes: overrides.max_minutes ?? 0,
    deadline_utc: overrides.deadline_utc ?? null,
    token: overrides.token ?? "tok",
    thread_id: overrides.thread_id ?? "thread",
    turn_id: overrides.turn_id ?? "turn",
    server_url: overrides.server_url ?? "ws://127.0.0.1:8765",
    server_pid: overrides.server_pid ?? null,
    launched_server: overrides.launched_server ?? false,
    codex_bin: overrides.codex_bin ?? "codex",
    status: overrides.status ?? "running",
    last_error: overrides.last_error ?? null,
    started_at: overrides.started_at ?? "2026-04-10T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-10T00:00:00.000Z",
  };
}

test("listStoredCodexLiveSessionsForRoom preserves multiple sessions for one room", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-state-"));
  const statePath = join(tempDir, "mcp-state.json");
  process.env.LETAGENTS_STATE_PATH = statePath;

  try {
    saveCodexLiveSession(makeSession({
      session_id: "sess-1",
      room_id: "room-1",
      cwd: "/repo/a",
      updated_at: "2026-04-10T00:00:00.000Z",
    }));
    saveCodexLiveSession(makeSession({
      session_id: "sess-2",
      room_id: "room-1",
      cwd: "/repo/b",
      updated_at: "2026-04-10T01:00:00.000Z",
    }));
    saveCodexLiveSession(makeSession({
      session_id: "sess-3",
      room_id: "room-2",
      cwd: "/repo/c",
      updated_at: "2026-04-10T02:00:00.000Z",
    }));

    const sessions = listStoredCodexLiveSessionsForRoom("room-1");
    assert.deepEqual(sessions.map((session) => session.session_id), ["sess-2", "sess-1"]);
  } finally {
    delete process.env.LETAGENTS_STATE_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
