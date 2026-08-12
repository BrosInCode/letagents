import assert from "node:assert/strict";
import test from "node:test";

import {
  retireLegacyCodexBackedOpenModelSessions,
} from "../main/agents/legacy-open-model-retirement.js";
import type {
  DesktopCodexLiveSessionState,
  StoredAgentSessionState,
} from "../main/agents/state.js";

function legacySession(
  sessionId: string,
  workerSessionId: string,
  serverPid: number,
): DesktopCodexLiveSessionState {
  return {
    session_id: sessionId,
    room_id: "focus_37",
    room_identifier: "focus_37",
    display_name: "Legacy Open Model",
    cwd: "/tmp/preserved-worktree",
    stop_phrase: "stop",
    max_minutes: 60,
    provider_id: "open-model",
    joined_via: "join_room",
    thread_id: `thread-${sessionId}`,
    turn_id: `turn-${sessionId}`,
    server_url: "http://127.0.0.1:45000",
    server_pid: serverPid,
    launched_server: true,
    codex_bin: "/usr/local/bin/codex",
    token: "retired-token",
    agent_session_id: workerSessionId,
    status: "running",
    started_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-28T00:00:00.000Z",
  };
}

function workerSession(sessionId: string): StoredAgentSessionState {
  return {
    session_id: sessionId,
    session_token: `token-${sessionId}`,
    room_id: "focus_37",
    session_kind: "worker",
    display_name: "Legacy Open Model",
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-28T00:00:00.000Z",
  };
}

test("legacy Codex-backed Open Model cleanup fences workers before removing local rows", async () => {
  const sessions = [
    legacySession("legacy-1", "worker-1", 7001),
    legacySession("legacy-2", "worker-2", 7002),
  ];
  const workers = new Map([
    ["worker-1", workerSession("worker-1")],
    ["worker-2", workerSession("worker-2")],
  ]);
  const calls: string[] = [];
  const remaining = new Set(sessions.map((session) => session.session_id));
  const reports: unknown[] = [];

  const result = await retireLegacyCodexBackedOpenModelSessions({
    listSessions: () => sessions,
    getWorkerSession: (id) => workers.get(id) ?? null,
    disconnectWorker: async (session) => {
      calls.push(`disconnect:${session?.session_id ?? "none"}`);
    },
    removeSession: (id) => {
      calls.push(`remove:${id}`);
      const session = sessions.find((candidate) => candidate.session_id === id) ?? null;
      if (session) remaining.delete(id);
      return session;
    },
    reportRetirement: (retirement) => {
      reports.push(retirement);
    },
  });

  assert.deepEqual(calls, [
    "disconnect:worker-1",
    "remove:legacy-1",
    "disconnect:worker-2",
    "remove:legacy-2",
  ]);
  assert.deepEqual(result, {
    retiredSessionIds: ["legacy-1", "legacy-2"],
    disconnectedWorkerSessionIds: ["worker-1", "worker-2"],
    unverifiableProcessIds: [7001, 7002],
  });
  assert.deepEqual(reports, [result]);
  assert.equal(remaining.size, 0);
});
