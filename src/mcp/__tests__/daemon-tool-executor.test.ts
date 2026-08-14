import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StoredAgentSessionState } from "../local-state.js";
import { executeDaemonTool, supervisedToolIsMutation } from "../server/daemon-tool-executor.js";

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
