import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { deriveCodexLiveSessionStatus, inspectLocalCodexSession } from "../codex-session.js";
import { saveCodexLiveSession, type CodexLiveSessionState } from "../local-state.js";

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
