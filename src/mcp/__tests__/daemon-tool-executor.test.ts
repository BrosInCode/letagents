import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StoredAgentSessionState } from "../local-state.js";
import { executeDaemonTool, supervisedToolIsMutation } from "../server/daemon-tool-executor.js";

import { resolveWorkerToolIdentity } from "../server/runtime/agent-sessions.js";
import { runWithDaemonToolExecutionContext } from "../server/runtime/daemon-tool-context.js";

function session(roomId: string, suffix: string): StoredAgentSessionState {
  const now = "2026-08-14T00:00:00.000Z";
  return {
    session_id: `session_${suffix}`,
    session_token: "",
    room_id: roomId,
    session_kind: "worker",
    runtime: "cursor",
    actor_label: `agent-${suffix}`,
    agent_key: `agent-${suffix}`,
    agent_instance_id: `instance-${suffix}`,
    display_name: `Agent ${suffix}`,
    owner_label: "Owner",
    ide_label: "Cursor",
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    ended_at: null,
  };
}

test("hosted daemon registry remains hosted under a local ambient API route", async () => {
  const priorApi = process.env.LETAGENTS_API_URL;
  process.env.LETAGENTS_API_URL = "letagents-local://rooms";
  try {
    // An incomplete input must reach the hosted tool's schema validation,
    // proving the local ambient environment did not hide or poison its registry.
    await assert.rejects(executeDaemonTool({ provider: "open-model", toolName: "register_task_close_intent",
      input: {}, requestId: "hosted_contract", roomId: "focus_42", apiUrl: "https://letagents.example",
      bearer: "worker", cwd: process.cwd(), agentSession: { ...session("focus_42", "hosted_contract"), runtime: "open-model" },
    }), { name: "ZodError" });
  } finally {
    if (priorApi === undefined) delete process.env.LETAGENTS_API_URL;
    else process.env.LETAGENTS_API_URL = priorApi;
  }
});

test("daemon executor binds exact supervised room authority without crossing the bridge", async () => {
  const output = await executeDaemonTool({
    provider: "cursor",
    toolName: "get_current_room",
    input: {},
    requestId: "effect_1",
    roomId: "focus_42",
    apiUrl: "https://letagents.example",
    bearer: "secret-worker-bearer",
    cwd: process.cwd(),
    agentSession: session("focus_42", "one"),
  });
  const payload = JSON.parse(String(output.liveResult.content[0]?.type === "text"
    ? output.liveResult.content[0].text
    : "{}")) as Record<string, unknown>;
  assert.equal(payload.connected, true);
  assert.equal(payload.room_id, "focus_42");
  assert.equal(payload.room_binding, "daemon_supervised");
  assert.deepEqual(output.durableResult, output.liveResult);
});

test("Codex daemon identity uses the current worker session and rejects stale explicit IDs", async () => {
  const current = { ...session("focus_42", "1205"), session_id: "agent_session_1205", runtime: "codex" };
  await runWithDaemonToolExecutionContext({
    roomId: current.room_id, apiUrl: "https://letagents.example", bearer: "worker-only",
    cwd: process.cwd(), agentSession: current,
  }, async () => {
    for (const agentSessionId of [undefined, "worker_bearer", current.session_id]) {
      const resolved = await resolveWorkerToolIdentity({ roomId: current.room_id, agentSessionId });
      assert.equal(resolved.agentSession, current, "the daemon supplies current identity without a local session cache");
    }
    await assert.rejects(() => resolveWorkerToolIdentity({ roomId: current.room_id, agentSessionId: "agent_session_1200" }), /1205, not agent_session_1200/);
    await assert.rejects(() => resolveWorkerToolIdentity({ roomId: "focus_other", agentSessionId: current.session_id }), /registered for focus_42/);
  });
});

test("concurrent daemon executions keep room and session authority isolated", async () => {
  const execute = (roomId: string, suffix: string) => executeDaemonTool({
    provider: "cursor",
    toolName: "get_current_room",
    input: {},
    requestId: `effect_${suffix}`,
    roomId,
    apiUrl: `https://${suffix}.example`,
    bearer: `bearer-${suffix}`,
    cwd: process.cwd(),
    agentSession: session(roomId, suffix),
  });
  const outputs = await Promise.all([execute("focus_1", "one"), execute("focus_2", "two")]);
  const payloads = outputs.map(({ liveResult }) => JSON.parse(
    liveResult.content[0]?.type === "text" ? liveResult.content[0].text : "{}",
  ));
  assert.deepEqual(payloads.map((payload) => payload.room_id), ["focus_1", "focus_2"]);
  assert.deepEqual(payloads.map((payload) => payload.agent_identity?.actor_label), ["agent-one", "agent-two"]);
});

test("daemon runtime owns the canonical read-versus-mutation classification", () => {
  assert.equal(supervisedToolIsMutation("get_board"), false);
  assert.equal(supervisedToolIsMutation("read_messages"), false);
  assert.equal(supervisedToolIsMutation("send_message"), true);
  assert.equal(supervisedToolIsMutation("complete_room_turn"), true);
});

test("daemon executor rejects tools outside the provider's supervised surface", async () => {
  await assert.rejects(() => executeDaemonTool({
    provider: "cursor",
    toolName: "rental_provision",
    input: {},
    requestId: "effect_forbidden",
    roomId: "focus_1",
    apiUrl: "https://letagents.example",
    bearer: "bearer",
    cwd: process.cwd(),
    agentSession: session("focus_1", "one"),
  }), /Unsupported supervised tool/);
});

test("daemon executor rejects cross-room sessions and unsafe API origins", async () => {
  const base = {
    provider: "cursor",
    toolName: "get_current_room",
    input: {},
    requestId: "effect_invalid",
    roomId: "focus_1",
    bearer: "bearer",
    cwd: process.cwd(),
    agentSession: session("focus_2", "two"),
  };
  await assert.rejects(() => executeDaemonTool({
    ...base, apiUrl: "https://letagents.example",
  }), /session does not match/i);
  await assert.rejects(() => executeDaemonTool({
    ...base, agentSession: session("focus_1", "one"), apiUrl: "http://attacker.example",
  }), /HTTPS or an exact HTTP loopback/i);
  await assert.rejects(() => executeDaemonTool({
    ...base,
    agentSession: { ...session("focus_1", "one"), runtime: "codex" },
    apiUrl: "https://letagents.example",
  }), /session does not match/i);
});

test("daemon executor preserves MCP schema validation at the local control boundary", async () => {
  await assert.rejects(() => executeDaemonTool({
    provider: "cursor",
    toolName: "complete_room_turn",
    input: { outcome: "invented" },
    requestId: "effect_bad_schema",
    roomId: "focus_1",
    apiUrl: "https://letagents.example",
    bearer: "bearer",
    cwd: process.cwd(),
    agentSession: session("focus_1", "one"),
  }), /Invalid option|invalid/i);
});

test("workspace-local tools cannot redirect daemon execution outside the authorized project", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-daemon-tool-scope-"));
  const authorized = join(root, "authorized");
  const outside = join(root, "outside");
  const outsideLink = join(authorized, "outside-link");
  await mkdir(authorized);
  await mkdir(outside);
  await symlink(outside, outsideLink);
  try {
    for (const requestedCwd of [outside, join(authorized, "..", "outside"), outsideLink]) {
      const output = await executeDaemonTool({
        provider: "cursor",
        toolName: "check_repo",
        input: { cwd: requestedCwd },
        requestId: `effect_scope_${requestedCwd}`,
        roomId: "focus_1",
        apiUrl: "https://letagents.example",
        bearer: "bearer",
        cwd: authorized,
        agentSession: session("focus_1", "one"),
      });
      const payload = JSON.parse(output.liveResult.content[0]?.type === "text"
        ? output.liveResult.content[0].text
        : "{}") as Record<string, unknown>;
      assert.equal(payload.cwd, authorized);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task mutations remain successful when the following presence update fails", async (t) => {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ method: init.method!, path, body: JSON.parse(String(init.body)) });
    if (path.endsWith("/presence")) throw new TypeError("fetch failed");
    assert.match(path, /\/tasks(?:\/task_1)?$/);
    return Response.json({ id: "task_1", room_id: "focus_test", status: "assigned" });
  });
  t.mock.method(console, "error", () => {});
  for (const [toolName, input] of [
    ["add_task", { title: "Due dates", client_task_id: "due-dates", source_message_id: "msg_121" }],
    ["claim_task", { task_id: "task_1" }],
    ["update_task", { task_id: "task_1", status: "in_progress" }],
    ["complete_task", { task_id: "task_1" }],
  ] as const) {
    const output = await executeDaemonTool({
      provider: "cursor", toolName, input, requestId: `effect_${toolName}`,
      roomId: "focus_test", apiUrl: "https://letagents.example", bearer: "test-worker-bearer",
      cwd: process.cwd(), agentSession: session("focus_test", "test"),
    });
    const payload = JSON.parse(output.liveResult.content[0]?.type === "text" ? output.liveResult.content[0].text : "{}");
    assert.equal(payload.success, true, JSON.stringify(payload));
    assert.equal(payload.task.id, "task_1");
  }
  assert.equal(requests.length, 8);
  assert.equal(requests[0].body.client_task_id, "due-dates");
  assert.equal(requests[0].body.source_message_id, "msg_121");
});

test("send_message and send_thread_message derive deterministic bounded-effect client_message_id from durable effectId and tag pre-dispatch rejections", async (t) => {
  const sentBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/presence")) {
      return Response.json({ ok: true });
    }
    if ((init.method ?? "GET") === "GET" && parsed.pathname.includes("/messages/")) {
      return Response.json({ id: "msg_10", thread_root_id: "msg_10" });
    }
    if (init.method === "POST" && parsed.pathname.endsWith("/messages")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sentBodies.push({ path: parsed.pathname, body });
      return Response.json({ id: `msg_${sentBodies.length + 100}`, text: body.text, client_message_id: body.client_message_id });
    }
    return Response.json({ error: "unexpected route" }, { status: 404 });
  });

  await executeDaemonTool({
    provider: "cursor",
    toolName: "send_message",
    input: { text: "Cloud top-level reply", reply_to: "msg_10" },
    requestId: "transient-mcp-req-1",
    effectId: "durable-effect-uuid-1",
    roomId: "focus_test",
    apiUrl: "https://letagents.example",
    bearer: "test-worker-bearer",
    cwd: process.cwd(),
    agentSession: session("focus_test", "send"),
  });

  await executeDaemonTool({
    provider: "cursor",
    toolName: "send_thread_message",
    input: { text: "Cloud thread reply", thread_parent_id: "msg_10" },
    requestId: "transient-mcp-req-2",
    effectId: "durable-effect-uuid-2",
    roomId: "focus_test",
    apiUrl: "https://letagents.example",
    bearer: "test-worker-bearer",
    cwd: process.cwd(),
    agentSession: session("focus_test", "send"),
  });

  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[0]!.body.client_message_id, "bounded-effect:durable-effect-uuid-1");
  assert.equal(sentBodies[1]!.body.client_message_id, "bounded-effect:durable-effect-uuid-2");
  for (const sent of sentBodies) {
    const id = String(sent.body.client_message_id);
    assert.equal(id.startsWith("internal:"), false);
    assert.equal(id.startsWith("desktop-send:"), false);
  }

  // Pre-dispatch mismatch is tagged beforeExternalDispatch: true so mutations fail cleanly instead of going uncertain.
  await assert.rejects(
    () => executeDaemonTool({
      provider: "cursor",
      toolName: "send_message",
      input: { text: "bad", reply_to: "msg_1", thread_parent_id: "msg_2" },
      requestId: "transient-mcp-req-3",
      effectId: "durable-effect-uuid-3",
      roomId: "focus_test",
      apiUrl: "https://letagents.example",
      bearer: "test-worker-bearer",
      cwd: process.cwd(),
      agentSession: session("focus_test", "send"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /reply_to and thread_parent_id must match/);
      assert.equal((error as { beforeExternalDispatch?: unknown }).beforeExternalDispatch, true);
      return true;
    },
  );

  // Input Zod schema validation failure is tagged beforeExternalDispatch: true.
  await assert.rejects(
    () => executeDaemonTool({
      provider: "cursor",
      toolName: "send_message",
      input: { text: 12345 },
      requestId: "transient-mcp-req-4",
      effectId: "durable-effect-uuid-4",
      roomId: "focus_test",
      apiUrl: "https://letagents.example",
      bearer: "test-worker-bearer",
      cwd: process.cwd(),
      agentSession: session("focus_test", "send"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ZodError");
      assert.equal((error as { beforeExternalDispatch?: unknown }).beforeExternalDispatch, true);
      return true;
    },
  );
});

test("send_message preserves committed message receipt across post-commit presence 403, tags primary 4xx rejections, and forwards AbortSignal", async (t) => {
  let observedSignal: AbortSignal | null | undefined;
  let mode: "presence_403" | "send_403" = "presence_403";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const parsed = new URL(url);
    if (init.method === "POST" && parsed.pathname.endsWith("/messages")) {
      observedSignal = init.signal;
      if (mode === "send_403") {
        return Response.json({ error: "forbidden by room policy" }, { status: 403 });
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ id: "msg_committed_200", text: body.text, client_message_id: body.client_message_id });
    }
    if (parsed.pathname.endsWith("/presence")) {
      return Response.json({ error: "presence forbidden" }, { status: 403 });
    }
    return Response.json({ error: "unexpected route" }, { status: 404 });
  });

  // 1. POST /messages -> 200, then POST /presence -> 403 must still return the committed message.
  const controller = new AbortController();
  const committed = await executeDaemonTool({
    provider: "cursor",
    toolName: "send_message",
    input: { text: "Committed before presence 403" },
    requestId: "req-presence-403",
    effectId: "effect-presence-403",
    signal: controller.signal,
    roomId: "focus_test",
    apiUrl: "https://letagents.example",
    bearer: "test-worker-bearer",
    cwd: process.cwd(),
    agentSession: session("focus_test", "send"),
  });
  assert.ok(observedSignal, "daemon shutdown AbortSignal is forwarded to fetch");
  const committedText = committed.liveResult.content[0]?.type === "text" ? committed.liveResult.content[0].text : "";
  assert.match(committedText, /msg_committed_200/);

  // 2. Primary POST /messages -> 403 tags mutationRejectedBeforeCommit: true.
  mode = "send_403";
  await assert.rejects(
    () => executeDaemonTool({
      provider: "cursor",
      toolName: "send_message",
      input: { text: "Rejected directly by POST /messages" },
      requestId: "req-send-403",
      effectId: "effect-send-403",
      roomId: "focus_test",
      apiUrl: "https://letagents.example",
      bearer: "test-worker-bearer",
      cwd: process.cwd(),
      agentSession: session("focus_test", "send"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: unknown }).status, 403);
      assert.equal((error as { mutationRejectedBeforeCommit?: unknown }).mutationRejectedBeforeCommit, true);
      return true;
    },
  );

  // 3. Pre-aborted signal fails before dispatch with beforeExternalDispatch: true.
  controller.abort();
  await assert.rejects(
    () => executeDaemonTool({
      provider: "cursor",
      toolName: "send_message",
      input: { text: "Never sent after abort" },
      requestId: "req-pre-aborted",
      effectId: "effect-pre-aborted",
      signal: controller.signal,
      roomId: "focus_test",
      apiUrl: "https://letagents.example",
      bearer: "test-worker-bearer",
      cwd: process.cwd(),
      agentSession: session("focus_test", "send"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { beforeExternalDispatch?: unknown }).beforeExternalDispatch, true);
      return true;
    },
  );
});
