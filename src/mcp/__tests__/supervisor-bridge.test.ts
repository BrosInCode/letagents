import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StoredAgentSessionState } from "../local-state.js";
import { toPublicAgentSession } from "../server/runtime/agent-sessions.js";
import {
  bindSupervisedWorkerSession,
  bindSupervisedWorkerSessionWithContext,
  checkpointSupervisedWorkerCursor,
} from "../server/runtime/supervisor-bridge.js";

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
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-absent-"));
  try {
    assert.equal(await bindSupervisedWorkerSession(session, {}, { cwd: root }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex supervisor context binds and checkpoints through an MCP process without supervisor env", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-context-"));
  const socketPath = join(root, "daemon.sock");
  const requests: any[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      const result = request.method === "daemon.negotiate" ? { protocol_version: 2 } : { accepted: true };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await writeSupervisorContext(root, "generation_first");
    const options = { cwd: root, trustedDaemonSocketPath: socketPath };
    assert.deepEqual(await bindSupervisedWorkerSessionWithContext(session, {}, options), {
      bound: true,
      supervisorContextCwd: await realpath(root),
    });
    assert.equal(await checkpointSupervisedWorkerCursor(session, "msg_2819", {}, options), true);
    assert.deepEqual(requests.filter((request) => request.method === "supervisor.bind_worker_session")[0]?.params, {
      entry_id: "manifest_exact",
      room_id: session.room_id,
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_first",
      agent_session_id: session.session_id,
      agent_session_token: session.session_token,
      api_url: "https://letagents.chat",
    });
    assert.deepEqual(requests.filter((request) => request.method === "supervisor.checkpoint_worker_cursor")[0]?.params, {
      entry_id: "manifest_exact",
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_first",
      agent_session_id: session.session_id,
      room_cursor: "msg_2819",
    });
    assert.doesNotMatch(JSON.stringify(await readContext(root)), /session-secret/, "stable context never persists worker authority");

    await writeSupervisorContext(root, "generation_resumed");
    assert.equal(await bindSupervisedWorkerSession(session, {}, options), true);
    const binds = requests.filter((request) => request.method === "supervisor.bind_worker_session");
    assert.equal(binds[1]?.params.execution_generation_id, "generation_resumed", "restart rewrites the exact live generation");

    await assert.rejects(
      () => bindSupervisedWorkerSession(session, { LETAGENTS_SUPERVISOR_ENTRY_ID: "partial" }, options),
      /environment is incomplete/,
      "partial ambient coordinates never fall through to the file",
    );
    await writeFile(join(root, ".letagents-supervisor-context.json"), "{");
    assert.equal(
      await bindSupervisedWorkerSession(session, supervisedEnv(socketPath), options),
      true,
      "complete ambient coordinates remain authoritative over file fallback",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("validated supervisor cwd survives MCP restart for bind and cursor checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-context-persisted-"));
  const unrelated = await mkdtemp(join(tmpdir(), "letagents-supervisor-context-process-cwd-"));
  const socketPath = join(root, "daemon.sock");
  const requests: any[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      const result = request.method === "daemon.negotiate"
        ? { protocol_version: 2 }
        : { accepted: true };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await writeSupervisorContext(root, "generation_exact");
    const persistedSession: StoredAgentSessionState = {
      ...session,
      supervisor_context_cwd: root,
    };

    const publicSession = toPublicAgentSession(persistedSession);
    assert.equal(publicSession?.supervisor_context_cwd, undefined);
    assert.doesNotMatch(JSON.stringify(publicSession), /session-secret|supervisor-context-persisted/,
      "neither worker authority nor the local supervisor route enters public projections");

    assert.equal(await bindSupervisedWorkerSession(persistedSession, {}, {
      trustedDaemonSocketPath: socketPath,
    }), true, "restart binds from the validated session route rather than process.cwd");
    assert.equal(await checkpointSupervisedWorkerCursor(persistedSession, "msg_restart", {}, {
      trustedDaemonSocketPath: socketPath,
    }), true, "later room polls checkpoint through the same durable route");

    const bind = requests.find((request) => request.method === "supervisor.bind_worker_session");
    const checkpoint = requests.find((request) => request.method === "supervisor.checkpoint_worker_cursor");
    assert.equal(bind?.params.agent_session_id, session.session_id);
    assert.equal(checkpoint?.params.agent_session_id, session.session_id);
    assert.doesNotMatch(JSON.stringify(checkpoint), /session-secret/, "cursor checkpoint never carries worker authority");

    assert.equal(await bindSupervisedWorkerSession({
      ...persistedSession,
      supervisor_context_cwd: unrelated,
    }, {}, { trustedDaemonSocketPath: socketPath }), false, "an unrelated persisted route cannot inherit the binding");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(unrelated, { recursive: true, force: true });
  }
});

test("Codex supervisor context fails closed for partial, cross-room, and unrelated worker contexts", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-context-invalid-"));
  const unrelated = await mkdtemp(join(tmpdir(), "letagents-supervisor-context-unrelated-"));
  try {
    await writeFile(join(root, ".letagents-supervisor-context.json"), JSON.stringify({ version: 1, provider: "codex", entry_id: "manifest_exact" }));
    await assert.rejects(() => bindSupervisedWorkerSession(session, {}, { cwd: root }), /is required/);

    await writeSupervisorContext(root, "generation_exact", "focus_other");
    await assert.rejects(() => bindSupervisedWorkerSession(session, {}, { cwd: root }), /does not match the worker room/);

    await writeSupervisorContext(root, "generation_exact");
    await assert.rejects(
      () => bindSupervisedWorkerSession({ ...session, runtime: "claude-code" }, {}, { cwd: root }),
      /cannot bind a non-Codex/,
    );
    await writeFile(join(root, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, work_attempt_id: "attempt_other" }));
    await assert.rejects(
      () => bindSupervisedWorkerSession(session, {}, { cwd: root }),
      /does not match the daemon-owned worktree/,
    );
    assert.equal(await bindSupervisedWorkerSession(session, {}, { cwd: unrelated }), false, "another MCP cwd cannot inherit the binding context");

    const contextPath = join(root, ".letagents-supervisor-context.json");
    await rm(contextPath);
    const symlinkTarget = join(root, "attacker-context.json");
    await writeFile(symlinkTarget, JSON.stringify({ version: 1, provider: "codex" }));
    await symlink(symlinkTarget, contextPath);
    await assert.rejects(() => bindSupervisedWorkerSession(session, {}, { cwd: root }), /small regular file/);
    await rm(contextPath);
    await writeFile(contextPath, "x".repeat(4 * 1024 + 1));
    await assert.rejects(() => bindSupervisedWorkerSession(session, {}, { cwd: root }), /small regular file/);
    await writeFile(contextPath, "{");
    await assert.rejects(() => bindSupervisedWorkerSession(session, {}, { cwd: root }), /not valid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(unrelated, { recursive: true, force: true });
  }
});

test("worktree context cannot redirect a freshly minted worker credential to an attacker socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-context-socket-"));
  const trustedSocketPath = join(root, "trusted.sock");
  const attackerSocketPath = join(root, "attacker.sock");
  const trustedRequests: any[] = [];
  const attackerRequests: any[] = [];
  const serverFor = (requests: any[]) => createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      const result = request.method === "daemon.negotiate" ? { protocol_version: 2 } : { bound: true };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  const trusted = serverFor(trustedRequests);
  const attacker = serverFor(attackerRequests);
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => { trusted.once("error", reject); trusted.listen(trustedSocketPath, resolve); }),
      new Promise<void>((resolve, reject) => { attacker.once("error", reject); attacker.listen(attackerSocketPath, resolve); }),
    ]);
    await writeSupervisorContext(root, "generation_exact", session.room_id, { socket_path: attackerSocketPath });
    assert.equal(await bindSupervisedWorkerSession(session, {}, {
      cwd: root,
      trustedDaemonSocketPath: trustedSocketPath,
    }), true);
    assert.equal(attackerRequests.length, 0, "repo-controlled socket_path receives no request or worker credential");
    assert.match(JSON.stringify(trustedRequests), /session-secret/);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => trusted.close(() => resolve())),
      new Promise<void>((resolve) => attacker.close(() => resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor bridge binds only the exact worker session credential over the daemon socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-bridge-"));
  const socketPath = join(root, "daemon.sock");
  const requests: any[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      const result = request.method === "daemon.negotiate" ? { protocol_version: 2 } : { bound: true };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
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
    assert.equal(requests.length, 2);
    assert.equal(requests[0].version, 1);
    assert.equal(requests[0].method, "daemon.negotiate");
    assert.equal(requests[1].version, 2);
    assert.equal(requests[1].method, "supervisor.bind_worker_session");
    assert.deepEqual(requests[1].params, {
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

test("supervisor bridge checkpoints the exact worker cursor without sending its session token", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-cursor-"));
  const socketPath = join(root, "daemon.sock");
  const requests: any[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      const result = request.method === "daemon.negotiate"
        ? { protocol_version: 2 }
        : { checkpointed: true };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    assert.equal(await checkpointSupervisedWorkerCursor(session, "msg_2819", supervisedEnv(socketPath)), true);
    assert.equal(requests[1].method, "supervisor.checkpoint_worker_cursor");
    assert.deepEqual(requests[1].params, {
      entry_id: "manifest_exact",
      work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact",
      agent_session_id: "agent_session_exact",
      room_cursor: "msg_2819",
    });
    assert.doesNotMatch(JSON.stringify(requests[1]), /session-secret/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor bridge fails closed when protocol negotiation is malformed or unsupported", async () => {
  for (const { protocolVersion, responseVersion } of [
    { protocolVersion: "2", responseVersion: 2 },
    { protocolVersion: 999, responseVersion: 2 },
    { protocolVersion: 2, responseVersion: 1 },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-bridge-invalid-"));
    const socketPath = join(root, "daemon.sock");
    let requestCount = 0;
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        requestCount += 1;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        socket.end(`${JSON.stringify({ version: responseVersion, id: request.id, ok: true, result: { protocol_version: protocolVersion } })}\n`);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
      await assert.rejects(() => bindSupervisedWorkerSession(session, supervisedEnv(socketPath)), /unsupported version|does not match/);
      assert.equal(requestCount, 1, "an invalid negotiation never reaches the binding mutation");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("supervisor bridge surfaces negotiation rejection without attempting a bind", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-bridge-reject-"));
  const socketPath = join(root, "daemon.sock");
  let requestCount = 0;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      requestCount += 1;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: false, error: "negotiation denied" })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await assert.rejects(() => bindSupervisedWorkerSession(session, supervisedEnv(socketPath)), /negotiation denied/);
    assert.equal(requestCount, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor bridge bounds an unresponsive negotiation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-bridge-timeout-"));
  const socketPath = join(root, "daemon.sock");
  const server = createServer((socket) => socket.resume());
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await assert.rejects(
      () => bindSupervisedWorkerSession(session, supervisedEnv(socketPath), { requestTimeoutMs: 25 }),
      /Timed out communicating/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function supervisedEnv(socketPath: string): NodeJS.ProcessEnv {
  return {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "manifest_exact",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: socketPath,
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "attempt_exact",
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation_exact",
    LETAGENTS_API_URL: "https://letagents.chat",
  };
}

async function writeSupervisorContext(
  root: string,
  executionGenerationId: string,
  roomId = session.room_id,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(join(root, ".letagents-work-attempt.json"), JSON.stringify({
    version: 1,
    work_attempt_id: "attempt_exact",
  }));
  await writeFile(join(root, ".letagents-supervisor-context.json"), JSON.stringify({
    version: 1,
    provider: "codex",
    entry_id: "manifest_exact",
    room_id: roomId,
    work_attempt_id: "attempt_exact",
    execution_generation_id: executionGenerationId,
    ...extra,
  }));
}

async function readContext(root: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, ".letagents-supervisor-context.json"), "utf8"));
}
