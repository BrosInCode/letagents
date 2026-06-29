import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

import {
  deriveCodexLiveSessionStatus,
  inspectLocalCodexSession,
  isCodexAgentSessionMarker,
  summarizeCodexReasoningNotificationForTest,
  summarizeCodexRuntimeNotificationForTest,
  summarizeCodexRuntimeSnapshotForTest,
  toPublicCodexLiveSession,
} from "../codex-session.js";
import { canReuseCodexLiveSessionForStart } from "../codex-session/session-start.js";
import { buildStartPrompt } from "../codex-session/start-prompt.js";
import { saveCodexLiveSession, type CodexLiveSessionState } from "../local-state.js";

const baseSession: CodexLiveSessionState = {
  session_id: "session_1",
  room_id: "room_1",
  room_identifier: "room_1",
  joined_via: "join_room",
  cwd: "/tmp/letagents",
  repo_branch: "codex/git-rooms",
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

test("isCodexAgentSessionMarker identifies Codex sessions by runtime and bridge markers", () => {
  assert.equal(isCodexAgentSessionMarker({ runtime: "codex" }), true);
  assert.equal(isCodexAgentSessionMarker({ ide_label: "Codex" }), true);
  assert.equal(isCodexAgentSessionMarker({ liveness_capability: "codex_app_server_runtime_stream" }), true);
  assert.equal(isCodexAgentSessionMarker({ tool_bridge_id: "host_1:codex:agent_1" }), true);
  assert.equal(isCodexAgentSessionMarker({ runtime: "antigravity", ide_label: "Agent" }), false);
});

test("toPublicCodexLiveSession exposes startup repo branch", () => {
  const publicSession = toPublicCodexLiveSession(baseSession);

  assert.equal(publicSession.repo_branch, "codex/git-rooms");
});

test("buildStartPrompt includes active git branch when available", () => {
  const prompt = buildStartPrompt({
    room_identifier: "github-refroom_github.com_owner_repo_branch_codex-git-rooms",
    joined_via: "join_room",
    cwd: "/tmp/letagents",
    repo_branch: "codex/git-rooms",
    stop_phrase: "/stop-codex-room",
    token: "LOCAL_CODEX_ROOM_test",
    deadline_utc: null,
    max_minutes: 0,
  });

  assert.match(prompt, /Primary working directory: \/tmp\/letagents/);
  assert.match(prompt, /Active git branch at startup: codex\/git-rooms/);
});

test("canReuseCodexLiveSessionForStart requires the same startup branch", () => {
  assert.equal(
    canReuseCodexLiveSessionForStart({
      session: baseSession,
      roomId: "room_1",
      cwd: "/tmp/letagents",
      repoBranch: "codex/git-rooms",
    }),
    true
  );

  assert.equal(
    canReuseCodexLiveSessionForStart({
      session: baseSession,
      roomId: "room_1",
      cwd: "/tmp/letagents",
      repoBranch: "codex/other-work",
    }),
    false
  );

  assert.equal(
    canReuseCodexLiveSessionForStart({
      session: { ...baseSession, repo_branch: null },
      roomId: "room_1",
      cwd: "/tmp/letagents",
      repoBranch: "codex/git-rooms",
    }),
    false
  );

  assert.equal(
    canReuseCodexLiveSessionForStart({
      session: { ...baseSession, repo_branch: null },
      roomId: "room_1",
      cwd: "/tmp/letagents",
      repoBranch: null,
    }),
    true
  );
});

test("summarizeCodexRuntimeNotificationForTest maps runtime notifications to visible reasoning", () => {
  const summary = summarizeCodexRuntimeNotificationForTest({
    method: "turn/started",
    params: { item: { type: "tool_call", name: "shell" } },
  });

  assert.equal(summary.status, "working");
  assert.match(summary.summary, /Codex turn started/);
  assert.match(summary.checking, /codex_app_server: turn\/started/);
});

test("summarizeCodexRuntimeSnapshotForTest maps app-server snapshots to visible reasoning", () => {
  const summary = summarizeCodexRuntimeSnapshotForTest({
    threadStatus: "active",
    turnStatus: "inProgress",
    recentItems: [
      { type: "userMessage", text: "Review PR #350." },
      { type: "agentMessage", phase: "commentary", text: "I am checking the desktop reasoning UI." },
    ],
  });

  assert.ok(summary);
  assert.equal(summary.status, "working");
  assert.equal(summary.summary, "I am checking the desktop reasoning UI.");
  assert.match(summary.checking, /Latest Codex worker message/);
});

test("summarizeCodexReasoningNotificationForTest accumulates readable reasoning summary deltas", () => {
  const params = { threadId: "thread_reasoning", turnId: "turn_reasoning", itemId: "item_reasoning" };
  assert.deepEqual(
    summarizeCodexReasoningNotificationForTest({
      method: "item/reasoning/summaryPartAdded",
      params: { ...params, summaryIndex: 0 },
    })?.summary,
    "Codex started a new reasoning summary section."
  );

  const first = summarizeCodexReasoningNotificationForTest({
    method: "item/reasoning/summaryTextDelta",
    params: { ...params, summaryIndex: 0, delta: "Reading the " },
  });
  const second = summarizeCodexReasoningNotificationForTest({
    method: "item/reasoning/summaryTextDelta",
    params: { ...params, summaryIndex: 0, delta: "desktop UI." },
  });

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.status, "working");
  assert.equal(second.summary, "Reading the desktop UI.");
  assert.match(second.checking, /readable reasoning summary/);
});

test("summarizeCodexReasoningNotificationForTest hides raw reasoning text deltas", () => {
  const summary = summarizeCodexReasoningNotificationForTest({
    method: "item/reasoning/textDelta",
    params: {
      threadId: "thread_raw_reasoning",
      turnId: "turn_raw_reasoning",
      itemId: "item_raw_reasoning",
      contentIndex: 0,
      delta: "raw private reasoning",
    },
  });

  assert.ok(summary);
  assert.equal(summary.summary, "Codex raw reasoning text is streaming.");
  assert.doesNotMatch(summary.checking, /raw private reasoning/);
});

test("inspectLocalCodexSession marks ready servers with failed websocket handshakes unknown", async () => {
  const previousStatePath = process.env.LETAGENTS_STATE_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-codex-session-"));
  process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");

  const server = createServer((request, response) => {
    response.statusCode = request.url === "/readyz" ? 200 : 404;
    response.end();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    saveCodexLiveSession({
      ...baseSession,
      session_id: "connect_failure_session",
      server_url: `ws://127.0.0.1:${address.port}`,
      launched_server: true,
      status: "running",
    });

    const inspected = await inspectLocalCodexSession("connect_failure_session");
    assert.ok(inspected);
    assert.equal(inspected.server_reachable, true);
    assert.equal(inspected.session.status, "unknown");
    assert.match(inspected.session.last_error ?? "", /WebSocket|fetch failed|closed/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousStatePath === undefined) {
      delete process.env.LETAGENTS_STATE_PATH;
    } else {
      process.env.LETAGENTS_STATE_PATH = previousStatePath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});
