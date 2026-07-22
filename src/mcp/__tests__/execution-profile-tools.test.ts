import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../server/register-tools.js";

function discovered(profile: "supervised_room_turn" | "autonomous_mcp_worker"): Set<string> {
  const names = new Set<string>();
  const server = {
    tool(name: string) { names.add(name); return {}; },
  } as unknown as McpServer;
  registerTools(server, profile);
  return names;
}

test("supervised room turns retain product tools but do not discover execution mechanics", () => {
  const names = discovered("supervised_room_turn");
  for (const productTool of ["read_messages", "get_board", "claim_task", "publish_room_artifact", "send_message", "join_room"]) {
    assert.equal(names.has(productTool), true, `${productTool} remains available through daemon mediation`);
  }
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
});

test("autonomous MCP workers retain the established full tool registry", () => {
  const names = discovered("autonomous_mcp_worker");
  for (const tool of ["wait_for_messages", "register_agent_session", "start_device_auth", "send_message", "join_room"]) {
    assert.equal(names.has(tool), true);
  }
});
