import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StoredAgentSessionState } from "../local-state.js";
import { bindSupervisedWorkerSession } from "../server/runtime/supervisor-bridge.js";

const session: StoredAgentSessionState = {
  session_id: "agent_session_exact",
  session_token: "session-secret",
  room_id: "github.com/BrosInCode/letagents/focus/focus-room-agents-rewrite-e3b79d7b",
  session_kind: "worker",
  runtime: "codex",
  actor_label: "Worker | Owner's agent | Agent",
  agent_key: "Owner/worker",
  display_name: "Worker",
  owner_label: "Owner",
  ide_label: "Agent",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  last_seen_at: "2026-01-01T00:00:00.000Z",
};

test("supervisor bridge is inert outside a daemon-supervised provider", async () => {
  assert.equal(await bindSupervisedWorkerSession(session, {}), false);
});

test("supervisor bridge binds only the exact worker session credential over the daemon socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-bridge-"));
  const socketPath = join(root, "daemon.sock");
  let request: any = null;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      socket.end(`${JSON.stringify({ version: 1, id: request.id, ok: true, result: { bound: true } })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    assert.equal(await bindSupervisedWorkerSession(session, {
      LETAGENTS_SUPERVISOR_ENTRY_ID: "manifest_exact",
      LETAGENTS_SUPERVISOR_DAEMON_SOCKET: socketPath,
      LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "attempt_exact",
      LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation_exact",
      LETAGENTS_API_URL: "https://letagents.chat",
    }), true);
    assert.equal(request.method, "supervisor.bind_worker_session");
    assert.deepEqual(request.params, {
      entry_id: "manifest_exact",
      room_id: session.room_id,
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      agent_session_id: session.session_id,
      agent_session_token: session.session_token,
      api_url: "https://letagents.chat",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
