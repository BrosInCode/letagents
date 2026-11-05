import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { WakeRule } from "../../../shared/wake-rules.mjs";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-register-wake-up-"));
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_API_URL = "http://127.0.0.1:39999";
process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
process.env.LETAGENTS_CHAT_STORAGE = "cloud";
process.env.LETAGENTS_TOKEN = "owner-token";
delete process.env.LETAGENTS_AGENT_SESSION_BEARER;

const originalFetch = globalThis.fetch;
const { registerAgentSessionTools } = await import("../server/tools/agent-sessions.js");
const { registerRoomInspectionTools } = await import("../server/tools/rooms/inspection-tools.js");
const { rememberRoom, toRoomState, shutdownRuntime } = await import("../server/runtime/room-state.js");

test.after(() => {
  globalThis.fetch = originalFetch;
  shutdownRuntime();
  rmSync(tempDir, { recursive: true, force: true });
});

type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function toolHandler(register: (server: McpServer) => void, name: string): Handler {
  let handler: Handler | null = null;
  register({ tool(toolName: string, _description: string, _schema: unknown, callback: unknown) {
    if (toolName === name) handler = callback as Handler;
  } } as unknown as McpServer);
  assert.ok(handler, `missing ${name} handler`);
  return handler;
}

async function answer(handler: Handler, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse((await handler(input)).content[0]!.text) as Record<string, unknown>;
}

const ROOM = "PTGA-21RN-W0QP";

function webhookRule(agentKey: string): WakeRule {
  return {
    id: "wake_1", room_id: ROOM, agent_key: agentKey, agent_name: "GrokBot", event: "room.message",
    arguments: { mentions_me: true }, repeat: true, expires_at: "2026-12-04T10:00:00.000Z", note: null,
    status: "active", created_at: "2026-11-04T10:00:00.000Z", updated_at: "2026-11-04T10:00:00.000Z",
    fire_count: 0, last_fired_at: null, wake_message_id: null, cancelled_by: null, ended_reason: null,
    delivery: { kind: "webhook", paused: false },
  };
}

/**
 * A server with one room: it mints agents and agent sessions, and lists the
 * room's wake rules, which the test sets. The session answer echoes what the
 * durable-handle registration needs confirmed (its token, its instance id).
 */
function fakeServer(options: { rules: WakeRule[] }) {
  const requests: string[] = [];
  let counter = 0;
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(String(url));
    const path = `${requestUrl.pathname}${requestUrl.search}`;
    requests.push(`${init?.method ?? "GET"} ${path}`);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/agents/me") return json({ account: { id: "acct", login: "ada" }, agents: [] });
    if (path === "/agents" && init?.method === "POST") {
      return json({ canonical_key: `ada/${String(body.name ?? "agent").toLowerCase()}`, name: body.name, display_name: body.display_name });
    }
    if (path === `/rooms/${ROOM}/agent-sessions` && init?.method === "POST") {
      counter += 1;
      const now = new Date().toISOString();
      return json({
        session_id: `agent_session_${counter}`,
        session_token: typeof body.connection_token === "string" ? body.connection_token : `token_${counter}`,
        room_id: ROOM, session_kind: "worker", runtime: "test",
        actor_label: `${String(body.display_name)} | ada | Cursor`,
        agent_key: body.actor_key, agent_instance_id: body.agent_instance_id,
        display_name: body.display_name, assigned_base_display_name: body.requested_base_display_name,
        owner_label: "ada", ide_label: "Cursor",
        created_at: now, updated_at: now, last_seen_at: now, ended_at: null,
      }, 201);
    }
    if (path.startsWith(`/rooms/${ROOM}/wake-rules`)) return json({ room_id: ROOM, active: options.rules, recent: [] });
    if (path.startsWith(`/rooms/${ROOM}/presence`)) return json({});
    return json({ error: `unexpected ${path}` }, 404);
  };
  return { requests, options };
}

test("register_agent_session answers wake_up: polling_only for a new worker, webhook once a rule reaches it", async () => {
  const server = fakeServer({ rules: [] });
  const register = toolHandler(registerAgentSessionTools, "register_agent_session");

  // A durable worker handle, as Grok Bot, ChatGPT and the Claude app register.
  const first = await answer(register, { room_id: ROOM, registration_key: "key-for-this-chat", display_name: "Grok Bot" });
  assert.equal(first.success, true);
  assert.ok(typeof first.worker_id === "string");
  const workerKey = (first.agent_session as { agent_key: string }).agent_key;
  assert.deepEqual(first.wake_up, {
    status: "polling_only",
    how: "Call wait_for_messages with after_message_id in a loop while your turn runs; LetAgents can also email "
      + "a wake-up: add_wake_rule with email {to}.",
  }, "the npm package names no client, so the generic text");
  assert.ok(server.requests.includes(`GET /rooms/${ROOM}/wake-rules?agent_key=${encodeURIComponent(workerKey)}`), server.requests.join("\n"));
  assert.match(String(first.instruction), /Keep worker_id for this chat/, "the fields that were there stay");

  // The same worker reconnects after a rule was added for it.
  server.options.rules = [webhookRule(workerKey)];
  const again = await answer(register, { room_id: ROOM, worker_id: first.worker_id });
  assert.equal(again.success, true);
  assert.equal((again.wake_up as { status: string }).status, "webhook");
  assert.match((again.wake_up as { how: string }).how, /^A webhook wake-up is set for you here/);

  // A legacy registration (no key, no worker_id) gets the same object.
  server.options.rules = [];
  const legacy = await answer(register, { room_id: ROOM, display_name: "Legacy Bot" });
  assert.equal(legacy.success, true);
  assert.equal((legacy.wake_up as { status: string }).status, "polling_only");
  assert.doesNotMatch(JSON.stringify(legacy), /"webhook"/, "the legacy agent has no rule of its own");
});

test("get_current_room re-checks the wake-up of the workers this chat holds", async () => {
  const server = fakeServer({ rules: [] });
  const register = toolHandler(registerAgentSessionTools, "register_agent_session");
  const current = toolHandler(registerRoomInspectionTools, "get_current_room");

  rememberRoom(toRoomState({ room_id: ROOM, code: ROOM, display_name: "Sky Owl", joined_via: "join_code" }));
  const registered = await answer(register, { room_id: ROOM, registration_key: "key-for-current-room", display_name: "Sky Bot" });
  const workerKey = (registered.agent_session as { agent_key: string }).agent_key;

  const before = await answer(current, {});
  assert.equal(before.connected, true);
  assert.equal((before.wake_up as { status: string }).status, "polling_only");
  assert.match((before.wake_up as { how: string }).how, /^Call wait_for_messages/);

  server.options.rules = [webhookRule(workerKey)];
  const after = await answer(current, {});
  assert.equal((after.wake_up as { status: string }).status, "webhook");

  // A failed read claims nothing.
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "down" }), { status: 500 });
  const down = await answer(current, {});
  assert.equal(down.connected, true);
  assert.equal("wake_up" in down, false);
});
