import { defineLocalSupervisedToolHandlers } from "../../../shared/local-supervised-tools.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LOCAL_ROOM_API_ORIGIN } from "../../../shared/room-api-origin.mjs";
import { registerTools } from "../server/register-tools.js";
import { LETAGENTS_RUNTIME_READINESS_URI, letAgentsRuntimeContract, registerRuntimeReadinessResource } from "../server/runtime-contract.js";
import type { LetAgentsExecutionProfile } from "../server/runtime/execution-profile.js";

function discovered(profile: LetAgentsExecutionProfile, provider: string | null = null): Set<string> {
  const names = new Set<string>();
  const server = {
    tool(name: string) { names.add(name); return {}; },
  } as unknown as McpServer;
  registerTools(server, profile, provider);
  return names;
}

test("supervised room turns retain product tools but do not discover execution mechanics", () => {
  const names = discovered("supervised_room_turn", "cursor");
  for (const productTool of ["read_messages", "get_board", "claim_task", "publish_room_artifact", "send_message", "join_room"]) {
    assert.equal(names.has(productTool), true, `${productTool} remains available through daemon mediation`);
  }
  assert.equal(names.has("complete_room_turn"), true, "the exact-turn completion channel is supervised-only");
  for (const engineTool of [
    "wait_for_messages",
    "register_agent_session",
    "disconnect_agent_session",
    "start_local_codex_session",
    "status_local_codex_session",
    "stop_local_codex_session",
    "start_device_auth",
    "poll_device_auth",
    "clear_saved_auth",
    "get_onboarding_status",
    "resume_room_session",
  ]) {
    assert.equal(names.has(engineTool), false, `${engineTool} is supervisor-owned`);
  }
  assert.deepEqual(
    [...names].filter((name) => name.startsWith("rental_")),
    [],
    "rental authority is not part of an ordinary supervised room turn",
  );
  assert.equal(discovered("autonomous_mcp_worker").has("complete_room_turn"), false);
  for (const provider of ["codex", "claude-code", "open-model", null]) {
    assert.equal(discovered("supervised_room_turn", provider).has("complete_room_turn"), false,
      `${provider ?? "unknown"} supervised turns must not discover Cursor's completion contract`);
  }
});

test("the executable runtime contract is derived from the real Cursor registration path", () => {
  const contract = letAgentsRuntimeContract();
  assert.equal(contract.format, 1);
  assert.deepEqual(contract.profiles.cursor_supervised_room_turn.tools.filter((tool) => tool !== "complete_room_turn"), [...discovered("supervised_room_turn", "codex")].sort(), "the pinned runtime contract also describes Codex except for Cursor-only completion");
  assert.deepEqual(
    contract.profiles.cursor_supervised_room_turn.tools,
    [...discovered("supervised_room_turn", "cursor")].sort(),
  );
  assert.equal(contract.profiles.cursor_supervised_room_turn.tools.includes("complete_room_turn"), true);
});

test("runtime readiness exposes only the active profile's actual registered capabilities", async () => {
  for (const apiUrl of ["https://letagents.chat", LOCAL_ROOM_API_ORIGIN]) {
    for (const [profile, provider] of [
      ["supervised_room_turn", "codex"], ["supervised_room_turn", "cursor"],
      ["supervised_mcp_polling", "codex"], ["autonomous_mcp_worker", null],
    ] as const) {
      const server = new McpServer({ name: "readiness-test", version: "1" });
      const client = new Client({ name: "readiness-reader", version: "1" });
      registerTools(server, profile, provider, { apiUrl });
      registerRuntimeReadinessResource(server, profile, provider, apiUrl);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport); await client.connect(clientTransport);
        const { tools } = await client.listTools();
        const { contents } = await client.readResource({ uri: LETAGENTS_RUNTIME_READINESS_URI });
        assert.equal(contents.length, 1);
        assert.equal(contents[0].uri, LETAGENTS_RUNTIME_READINESS_URI);
        assert.equal(contents[0].mimeType, "application/json");
        assert.deepEqual(JSON.parse(String(contents[0].text)), {
          format: 1, profile, provider, tools: tools.map(tool => tool.name).sort(),
        }, "readiness contains no credentials, room content, or extra authority");
      } finally { await client.close(); await server.close(); }
    }
  }
});

test("autonomous MCP workers retain the established full tool registry", () => {
  const names = discovered("autonomous_mcp_worker");
  for (const tool of [
    "wait_for_messages",
    "register_agent_session",
    "start_device_auth",
    "send_message",
    "join_room",
    "rental_list_requests",
    "rental_accept",
    "rental_read_file",
    "rental_complete",
  ]) {
    assert.equal(names.has(tool), true);
  }
});

test('workspace capture tools are available to independent callers without duplicating supervised capture', () => {
  for (const profile of ['autonomous_mcp_worker', 'interactive_desktop', 'supervised_room_turn', 'supervised_mcp_polling'] as const) {
    for (const name of ['begin_workspace_capture', 'publish_workspace_capture']) {
      assert.equal(discovered(profile).has(name), profile === 'autonomous_mcp_worker' || profile === 'interactive_desktop');
    }
  }
});

test("interactive desktop sessions retain rental tools", () => {
  const names = discovered("interactive_desktop");
  assert.equal(names.has("rental_list_requests"), true);
  assert.equal(names.has("rental_read_file"), true);
});

test("custodial polling advertises the restricted real tool surface with delivery enabled", () => {
  const names = discovered("supervised_mcp_polling", "codex");
  assert.deepEqual([...names].sort(), [...discovered("supervised_room_turn", "codex")].filter(name => name !== "set_reply_thread").concat("wait_for_messages").sort());
  assert.deepEqual(letAgentsRuntimeContract().profiles.supervised_mcp_polling, {
    contract: "custodial_polling_v1", tools: [...names].sort(),
  });
});


test("local native discovery and runtime contract agree and expose an executable closeout path", async () => {
  for (const provider of ["cursor", "codex", "claude-code"]) {
    const server = new McpServer({ name: "local-tool-contract", version: "1" });
    const client = new Client({ name: "local-tool-reader", version: "1" });
    registerTools(server, "supervised_room_turn", provider, { apiUrl: LOCAL_ROOM_API_ORIGIN });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const contract = letAgentsRuntimeContract(LOCAL_ROOM_API_ORIGIN).profiles.cursor_supervised_room_turn.tools;
      assert.deepEqual(tools.map(tool => tool.name).sort(), contract.filter(name => provider === "cursor" || name !== "complete_room_turn"));
      for (const name of ["get_board", "read_messages", "claim_task", "complete_task", "update_task", "send_thread_message", "set_reply_thread", "publish_room_artifact"]) {
        assert.ok(tools.some(tool => tool.name === name), `${provider} keeps ${name}`);
      }
      for (const name of ["join_room", "join_project", "register_task_close_intent", "register_task_claim_intent", "get_board_settings", "get_room_memory", "submit_review_verdict"]) {
        assert.ok(!tools.some(tool => tool.name === name), `${provider} cannot discover unsupported ${name}`);
      }
      assert.match(tools.find(tool => tool.name === "update_task")!.description!, /merged work with status 'done'; no close intent or replacement work lease/);
      assert.equal(tools.find(tool => tool.name === "get_board")?.annotations?.readOnlyHint, true);
      assert.equal(tools.find(tool => tool.name === "update_task")?.annotations?.readOnlyHint, false);
    } finally { await client.close(); await server.close(); }
  }
  const hosted = letAgentsRuntimeContract("https://letagents.chat");
  assert.ok(hosted.profiles.cursor_supervised_room_turn.tools.includes("register_task_close_intent"));
  assert.ok(hosted.profiles.cursor_supervised_room_turn.tools.includes("join_room"));
  assert.deepEqual(hosted.profiles.cursor_supervised_room_turn.tools, [...discovered("supervised_room_turn", "cursor")].sort());
});


test("local executor construction refuses incomplete, extra or nonfunction handlers", () => {
  assert.throws(() => defineLocalSupervisedToolHandlers({}), /advertised tool contract/);
  const handlers = Object.fromEntries([
    "get_current_room", "read_messages", "send_message", "get_board", "add_task", "claim_task", "update_task",
    "change_task_lease", "claim_task_review", "get_room_artifacts", "publish_room_artifact", "get_message_thread",
  ].map(name => [name, async () => undefined]));
  assert.ok(Object.isFrozen(defineLocalSupervisedToolHandlers(handlers)));
  const { update_task: _update, ...incomplete } = handlers;
  assert.throws(() => defineLocalSupervisedToolHandlers(incomplete), /advertised tool contract/);
  assert.throws(() => defineLocalSupervisedToolHandlers({ ...handlers, unexpected: async () => undefined }), /advertised tool contract/);
  assert.throws(() => defineLocalSupervisedToolHandlers({ ...handlers, update_task: null! }), /advertised tool contract/);
});


test("thread routing is a strict bounded-only control, truthfully classified as a mutation", async () => {
  for (const profile of ["autonomous_mcp_worker", "interactive_desktop", "supervised_mcp_polling"] as const) {
    assert.equal(discovered(profile).has("set_reply_thread"), false, profile);
  }
  const server = new McpServer({ name: "thread-control", version: "1" });
  const client = new Client({ name: "thread-control-test", version: "1" });
  registerTools(server, "supervised_room_turn", "codex");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tool = (await client.listTools()).tools.find(tool => tool.name === "set_reply_thread")!;
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.deepEqual(tool.inputSchema.properties, {});
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const args of [{ room_id: "other" }, { thread_parent_id: "msg_2" }, { text: "send this" }]) {
      const result = await client.callTool({ name: "set_reply_thread", arguments: args });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /[Uu]nrecognized|[Uu]nexpected/);
    }
  } finally { await client.close(); await server.close(); }
});
