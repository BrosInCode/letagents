import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StoredAgentSessionState } from "../local-state.js";
import { toPublicAgentSession } from "../server/runtime/agent-sessions.js";
import {
  runWithSupervisedRoomAuthority,
} from "../server/runtime/supervised-room-authority.js";
import {
  borrowSupervisedWorkerCredential,
  borrowCurrentSupervisedWorkerCredential,
  bindSupervisedWorkerSession,
  bindSupervisedWorkerSessionWithContext,
  checkpointSupervisedWorkerCursor,
  completeCurrentSupervisedEffect,
  isRetryableSupervisorBridgeError,
  prepareCurrentSupervisedEffect,
  resolveCurrentSupervisedWorkerSession,
  scheduleSupervisedWorkerCursorCheckpoint,
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

test("Open Model supervised coordinates resolve without a Codex context file", async () => {
  await runWithSupervisedRoomAuthority("room_open_model", async () => {
    const resolved = await resolveCurrentSupervisedWorkerSession(undefined, {
      LETAGENTS_SUPERVISOR_PROVIDER: "open-model",
      LETAGENTS_SUPERVISOR_ENTRY_ID: "open_model_exact",
      LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/letagents-open-model.sock",
      LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "attempt_open_model",
      LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation_open_model",
      LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "session_open_model",
      LETAGENTS_SUPERVISOR_ROOM_ID: "room_open_model",
      LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: "Local Qwen",
    });

    assert.equal(resolved.runtime, "open-model");
    assert.equal(resolved.ide_label, "Open Model");
    assert.equal(resolved.session_id, "session_open_model");
    assert.equal(resolved.room_id, "room_open_model");
    assert.equal(resolved.display_name, "Local Qwen");
  });
});

test("Cursor credential borrowing carries the exact rotating provider-turn capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-cursor-turn-"));
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
        ? { protocol_version: 2, generation: 17, pid: 123, started_at: "2026-08-02T00:00:00.000Z" }
        : { status: "available", credential: "turn-bounded-bearer" };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const result = await borrowSupervisedWorkerCredential({ ...session, runtime: "cursor" }, {
      LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
      LETAGENTS_SUPERVISOR_ENTRY_ID: "cursor_exact",
      LETAGENTS_SUPERVISOR_DAEMON_SOCKET: socketPath,
      LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "attempt_cursor",
      LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation_cursor",
      LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "cursor:unpredictable-turn-1",
    });
    assert.deepEqual(result, { state: "available", credential: "turn-bounded-bearer" });
    const borrow = requests.find((request) => request.method === "supervisor.borrow_worker_credential");
    assert.equal(borrow.params.provider_turn_id, "cursor:unpredictable-turn-1");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded effect completion survives a real handoff socket unlink and delayed successor listen", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-effect-handoff-"));
  const socketPath = join(root, "daemon.sock");
  const requests: any[] = [];
  let firstClosed = false;
  let successorListening = false;
  let successorTimer: NodeJS.Timeout | null = null;
  const successor = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      if (request.method === "daemon.negotiate") {
        socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result: {
          protocol_version: 2, generation: 21, pid: 4343, started_at: "2026-08-05T16:00:01.000Z",
        } })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result: { completed: true } })}\n`);
    });
  });
  const first = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      if (request.method === "daemon.negotiate") {
        socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result: {
          protocol_version: 2, generation: 20, pid: 4242, started_at: "2026-08-05T16:00:00.000Z",
        } })}\n`);
        return;
      }
      socket.destroy();
      first.close(() => {
        firstClosed = true;
        // Longer than the first three backoffs: completion must observe the
        // actual ENOENT unlink window more than once before generation 21 is
        // available, rather than succeeding against the same listener.
        successorTimer = setTimeout(() => {
          successor.listen(socketPath, () => { successorListening = true; });
        }, 220);
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { first.once("error", reject); first.listen(socketPath, resolve); });
    const startedAt = Date.now();
    await writeSupervisorContext(root, "generation_exact");
    await completeCurrentSupervisedEffect({ effectId: "effect-exact", result: { sent: true } }, {
      LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    }, { cwd: root, trustedDaemonSocketPath: socketPath, requestTimeoutMs: 1_000 });
    const completions = requests.filter((request) => request.method === "supervisor.complete_bounded_effect");
    assert.equal(completions.length, 2);
    assert.deepEqual(completions.map((request) => request.params.daemon_generation), [20, 21]);
    assert.ok(Date.now() - startedAt >= 200, "completion waited through multiple missing-socket retries");
    assert.ok(completions.every((request) => request.params.effect_id === "effect-exact"));
    assert.ok(completions.every((request) => !Object.hasOwn(request.params, "provider_turn_id")),
      "non-Cursor completion remains provider-neutral across handoff");
  } finally {
    if (successorTimer) clearTimeout(successorTimer);
    if (!firstClosed) await new Promise<void>((resolve) => first.close(() => resolve()));
    if (successorListening) await new Promise<void>((resolve) => successor.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded effect preparation preserves a daemon-owned uncertain mutation outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-effect-uncertain-"));
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
        ? { protocol_version: 2, generation: 22, pid: 4343, started_at: "2026-08-05T16:00:01.000Z" }
        : { state: "uncertain", room_id: "room_exact", effect_id: "effect_uncertain", error: "The mutation may already have completed." };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const prepared = await prepareCurrentSupervisedEffect({
      toolName: "send_message", input: { text: "once" }, mcpRequestId: "request_uncertain", mutation: true,
    }, {
      LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
      LETAGENTS_SUPERVISOR_ENTRY_ID: "manifest_exact",
      LETAGENTS_SUPERVISOR_DAEMON_SOCKET: socketPath,
      LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "attempt_exact",
      LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation_exact",
    });
    assert.deepEqual(prepared, {
      state: "uncertain", roomId: "room_exact", effectId: "effect_uncertain", error: "The mutation may already have completed.",
    });
    assert.equal(requests.filter((request) => request.method === "supervisor.prepare_bounded_effect").length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded effect preparation fails closed without valid daemon room authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-effect-room-authority-"));
  const socketPath = join(root, "daemon.sock");
  const roomAuthorities: unknown[] = [undefined, "   ", "room\u0000escape"];
  let preparationIndex = 0;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      const result = request.method === "daemon.negotiate"
        ? { protocol_version: 2, generation: 23, pid: 4343, started_at: "2026-08-05T16:00:01.000Z" }
        : {
            state: "prepared",
            effect_id: `effect_invalid_room_${preparationIndex}`,
            action: "execute",
            room_id: roomAuthorities[preparationIndex++],
          };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    for (let index = 0; index < roomAuthorities.length; index += 1) {
      await assert.rejects(() => prepareCurrentSupervisedEffect({
        toolName: "read_messages",
        input: {},
        mcpRequestId: `request_invalid_room_${index}`,
        mutation: false,
      }, {
        ...supervisedEnv(socketPath),
        LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
      }), /did not return valid exact room authority/i);
    }
    assert.equal(preparationIndex, roomAuthorities.length);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded effect preparation fails closed on unknown daemon states and actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-effect-protocol-drift-"));
  const socketPath = join(root, "daemon.sock");
  const responses = [
    { state: "future_state", room_id: "room_exact", effect_id: "effect_future", action: "execute" },
    { state: "prepared", room_id: "room_exact", effect_id: "effect_future", action: "future_action" },
  ];
  let preparationIndex = 0;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      const result = request.method === "daemon.negotiate"
        ? { protocol_version: 2, generation: 24, pid: 4343, started_at: "2026-08-05T16:00:01.000Z" }
        : responses[preparationIndex++];
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await assert.rejects(() => prepareCurrentSupervisedEffect({
      toolName: "read_messages", input: {}, mcpRequestId: "request_future_state", mutation: false,
    }, { ...supervisedEnv(socketPath), LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn" }), /unsupported state/i);
    await assert.rejects(() => prepareCurrentSupervisedEffect({
      toolName: "read_messages", input: {}, mcpRequestId: "request_future_action", mutation: false,
    }, { ...supervisedEnv(socketPath), LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn" }), /unsupported action/i);
    assert.equal(preparationIndex, responses.length);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded effect completion does not retry an authoritative non-handoff rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-effect-reject-"));
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
      const response = request.method === "daemon.negotiate"
        ? { version: 2, id: request.id, ok: true, result: {
          protocol_version: 2, generation: 30, pid: 4242, started_at: "2026-08-05T16:00:00.000Z",
        } }
        : { version: 2, id: request.id, ok: false, error: "Effect lost exact provider-turn authority." };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await writeSupervisorContext(root, "generation_exact");
    await assert.rejects(() => completeCurrentSupervisedEffect({ effectId: "effect-rejected" }, {
      LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    }, { cwd: root, trustedDaemonSocketPath: socketPath }), /lost exact provider-turn authority/i);
    assert.equal(requests.filter((request) => request.method === "daemon.negotiate").length, 1);
    assert.equal(requests.filter((request) => request.method === "supervisor.complete_bounded_effect").length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded effect completion surfaces an authoritative successor failure after transient handoff retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-effect-double-failure-"));
  const socketPath = join(root, "daemon.sock");
  const requests: any[] = [];
  let completionAttempts = 0;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      if (request.method === "daemon.negotiate") {
        socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result: {
          protocol_version: 2, generation: 40 + completionAttempts, pid: 4242, started_at: "2026-08-05T16:00:00.000Z",
        } })}\n`);
        return;
      }
      completionAttempts += 1;
      const error = completionAttempts === 1
        ? "Stale daemon generation after handoff."
        : "Successor rejected exact completion.";
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: false, error })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await writeSupervisorContext(root, "generation_exact");
    await assert.rejects(() => completeCurrentSupervisedEffect({ effectId: "effect-double-failure" }, {
      LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    }, { cwd: root, trustedDaemonSocketPath: socketPath }), /successor rejected exact completion/i);
    assert.equal(requests.filter((request) => request.method === "daemon.negotiate").length, 2);
    assert.equal(requests.filter((request) => request.method === "supervisor.complete_bounded_effect").length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("credential borrowing requires the negotiated daemon generation and defers without desktop delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-credential-"));
  const socketPath = join(root, "daemon.sock");
  const requests: any[] = [];
  let result: Record<string, unknown> = { status: "deferred" };
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      const payload = request.method === "daemon.negotiate"
        ? { protocol_version: 2, generation: 9, pid: 123, started_at: "2026-07-20T00:00:00.000Z" }
        : result;
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result: payload })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const options = { cwd: root, trustedDaemonSocketPath: socketPath };
    await writeSupervisorContext(root, "generation_exact");
    assert.deepEqual(await borrowSupervisedWorkerCredential(session, {}, options), {
      state: "deferred", code: "SUPERVISED_CREDENTIAL_UNAVAILABLE",
    });
    result = { status: "available", credential: "worker-bearer-only" };
    assert.deepEqual(await borrowSupervisedWorkerCredential(session, {}, options), {
      state: "available", credential: "worker-bearer-only",
    });
    assert.deepEqual(requests.filter((request) => request.method === "supervisor.borrow_worker_credential")[1]?.params, {
      entry_id: "manifest_exact", room_id: session.room_id, work_attempt_id: "attempt_exact",
      execution_generation_id: "generation_exact", agent_session_id: session.session_id, daemon_generation: 9,
      api_url: "https://letagents.chat",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded MCP identity and credential borrowing follow a daemon room move instead of stale launch context", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-current-credential-"));
  const socketPath = join(root, "daemon.sock");
  const requests: any[] = [];
  let borrowCount = 0;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      const result = request.method === "daemon.negotiate"
        ? { protocol_version: 2, generation: 11, pid: 123, started_at: "2026-07-21T00:00:00.000Z" }
        : { status: "available", credential: `rotated-in-daemon-memory-${++borrowCount}` };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await writeSupervisorContext(root, "generation_exact", session.room_id, {
      agent_session_id: session.session_id,
      agent_display_name: "Exact worker",
    });
    const env = {
      LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
      LETAGENTS_API_URL: "https://letagents.chat",
    };
    const destinationRoom = "focus/destination-room";
    await runWithSupervisedRoomAuthority(destinationRoom, async () => {
      const movedIdentity = await resolveCurrentSupervisedWorkerSession(destinationRoom, env, {
        cwd: root,
        trustedDaemonSocketPath: socketPath,
      });
      assert.equal(movedIdentity.room_id, destinationRoom, "the fresh daemon effect supersedes the source room in the context file");
      assert.deepEqual(await borrowCurrentSupervisedWorkerCredential(env, { cwd: root, trustedDaemonSocketPath: socketPath }), {
        state: "available", credential: "rotated-in-daemon-memory-1",
      });
      assert.deepEqual(await borrowCurrentSupervisedWorkerCredential(env, { cwd: root, trustedDaemonSocketPath: socketPath }), {
        state: "available", credential: "rotated-in-daemon-memory-2",
      });
      assert.deepEqual(requests[1]?.params, {
        entry_id: "manifest_exact", room_id: destinationRoom, work_attempt_id: "attempt_exact",
        execution_generation_id: "generation_exact", agent_session_id: session.session_id, daemon_generation: 11,
        api_url: "https://letagents.chat",
      });
      assert.equal(requests.filter((request) => request.method === "supervisor.borrow_worker_credential").length, 2);
      assert.doesNotMatch(JSON.stringify(await readContext(root)), /rotated-in-daemon-memory|session-secret/);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded MCP borrowing rejects absent identity before contacting the daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-current-missing-"));
  const socketPath = join(root, "missing.sock");
  try {
    await writeSupervisorContext(root, "generation_exact");
    assert.deepEqual(await borrowCurrentSupervisedWorkerCredential({
      LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
      LETAGENTS_API_URL: "https://letagents.chat",
    }, { cwd: root, trustedDaemonSocketPath: socketPath }), {
      state: "stale", code: "SUPERVISED_CREDENTIAL_STALE",
    });
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

    await assert.rejects(() => bindSupervisedWorkerSession({
      ...persistedSession,
      supervisor_context_cwd: unrelated,
    }, {}, { trustedDaemonSocketPath: socketPath }), /persisted supervised worker context is missing/,
    "a missing persisted supervised route fails closed instead of becoming unsupervised");
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

test("supervisor bridge binds once per exact daemon generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-bridge-cache-"));
  const socketPath = join(root, "daemon.sock");
  const requests: any[] = [];
  let daemonGeneration = 41;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      const result = request.method === "daemon.negotiate"
        ? { protocol_version: 2, generation: daemonGeneration, pid: 123, started_at: `generation-${daemonGeneration}` }
        : { bound: true };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const env = supervisedEnv(socketPath);
    assert.equal(await bindSupervisedWorkerSession(session, env), true);
    assert.equal(await bindSupervisedWorkerSession(session, env), true);
    assert.equal(requests.filter((request) => request.method === "supervisor.bind_worker_session").length, 1,
      "heartbeat waits negotiate health but do not repeat an unchanged bind");

    daemonGeneration += 1;
    assert.equal(await bindSupervisedWorkerSession(session, env), true);
    assert.equal(requests.filter((request) => request.method === "supervisor.bind_worker_session").length, 2,
      "a replacement daemon receives a fresh exact bind");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("confirmed waits bound a wedged exact-binding verification to 250ms or less", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-fast-wait-"));
  const socketPath = join(root, "daemon.sock");
  let wedgeNegotiation = false;
  const requests: any[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      if (wedgeNegotiation && (request.method === "daemon.negotiate" || request.method === "supervisor.verify_worker_session")) return;
      const result = request.method === "daemon.negotiate"
        ? { protocol_version: 2, generation: 1, pid: 123, started_at: "2026-01-01T00:00:00.000Z" }
        : { bound: true };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const env = supervisedEnv(socketPath);
    assert.equal(await bindSupervisedWorkerSession(session, env, { requestTimeoutMs: 25 }), true);
    wedgeNegotiation = true;
    const startedAt = Date.now();
    await assert.rejects(() => bindSupervisedWorkerSession(session, env, {
      requestTimeoutMs: 25,
      allowConfirmedFastPath: true,
    }), /Timed out communicating/);
    assert.ok(Date.now() - startedAt < 100, "a wedged local verification cannot consume the room long-poll budget");

    await assert.rejects(() => bindSupervisedWorkerSession(session, {
      ...env,
      LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation_successor",
    }, { requestTimeoutMs: 25, allowConfirmedFastPath: true }), /Timed out communicating/,
    "a successor generation still fails closed until its exact binding is proven");
  } finally {
    wedgeNegotiation = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("binding cache includes protected room and credential identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-protected-cache-"));
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
        ? { protocol_version: 2, generation: 1, pid: 123, started_at: "2026-01-01T00:00:00.000Z" }
        : { bound: true };
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const env = supervisedEnv(socketPath);
    assert.equal(await bindSupervisedWorkerSession(session, env), true);
    assert.equal(await bindSupervisedWorkerSession({ ...session, session_token: "replacement-secret" }, env, {
      allowConfirmedFastPath: true,
    }), true);
    assert.equal(requests.filter((request) => request.method === "supervisor.bind_worker_session").length, 2,
      "a changed protected credential cannot inherit the prior confirmation");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("a daemon without a stable identity is rebound instead of cached across replacements", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-no-identity-"));
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
    const env = supervisedEnv(socketPath);
    assert.equal(await bindSupervisedWorkerSession(session, env), true);
    assert.equal(await bindSupervisedWorkerSession(session, env, { allowConfirmedFastPath: true }), true);
    assert.equal(requests.filter((request) => request.method === "supervisor.bind_worker_session").length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor transport timeouts are retryable bookkeeping failures", () => {
  assert.equal(isRetryableSupervisorBridgeError(new Error("Timed out communicating with the supervisor daemon.")), true);
  assert.equal(isRetryableSupervisorBridgeError(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" })), true);
  assert.equal(isRetryableSupervisorBridgeError(Object.assign(new Error("connect ENOENT daemon.sock"), { code: "ENOENT" })), true,
    "the unlink-to-successor-listen handoff window is retryable");
  assert.equal(isRetryableSupervisorBridgeError(new Error("Exact authority rejected this socket request.")), false,
    "authoritative rejections do not become retryable merely by mentioning a socket");
  assert.equal(isRetryableSupervisorBridgeError(new Error("Worker session room does not match the supervised manifest entry.")), false);
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

test("scheduled cursor checkpoints retry transient failures and keep the newest acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-cursor-retry-"));
  const socketPath = join(root, "daemon.sock");
  const checkpoints: string[] = [];
  let failedOnce = false;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      if (request.method === "daemon.negotiate") {
        socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result: { protocol_version: 2 } })}\n`);
        return;
      }
      checkpoints.push(request.params.room_cursor);
      if (!failedOnce) {
        failedOnce = true;
        socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: false, error: "connection reset" })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ version: 2, id: request.id, ok: true, result: { checkpointed: true } })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const scheduledSession = { ...session, session_id: "agent_session_scheduled_retry" };
    const env = supervisedEnv(socketPath);
    scheduleSupervisedWorkerCursorCheckpoint(scheduledSession, "msg_12", env, { requestTimeoutMs: 50 });
    scheduleSupervisedWorkerCursorCheckpoint(scheduledSession, "msg_10", env, { requestTimeoutMs: 50 });
    await eventually(() => checkpoints.length >= 2, 1_500);
    assert.deepEqual(checkpoints, ["msg_12", "msg_12"], "an older concurrent acknowledgement cannot replace the retry");
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

async function eventually(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for supervisor bridge test condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
