import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../server/register-tools.js";
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

test("interactive desktop sessions retain rental tools", () => {
  const names = discovered("interactive_desktop");
  assert.equal(names.has("rental_list_requests"), true);
  assert.equal(names.has("rental_read_file"), true);
});
