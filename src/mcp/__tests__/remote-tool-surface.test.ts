import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../server/register-tools.js";
import {
  isRemoteExcludedTool,
  LETAGENTS_REMOTE_TOOL_SURFACE_ENV,
  REMOTE_EXCLUDED_TOOLS,
} from "../server/remote-tool-surface.js";
import { normalizeJoinSessionMode } from "../server/runtime/rooms.js";

function discovered(remote: boolean): Map<string, Record<string, unknown>> {
  const tools = new Map<string, Record<string, unknown>>();
  const server = {
    tool(name: string, ...registration: unknown[]) {
      tools.set(name, (registration.at(-2) ?? {}) as Record<string, unknown>);
      return {};
    },
  } as unknown as McpServer;
  registerTools(server, "autonomous_mcp_worker", null, { remote });
  return tools;
}

test("the remote surface is the stdio registry minus the documented local-machine tools", () => {
  const stdio = discovered(false);
  const remote = discovered(true);
  for (const name of Object.keys(REMOTE_EXCLUDED_TOOLS)) assert.equal(stdio.has(name), true, `${name} exists in stdio`);
  assert.deepEqual([...remote.keys()].sort(), [...stdio.keys()].filter((name) => !isRemoteExcludedTool(name)).sort());
  assert.equal([...remote.keys()].some((name) => name.startsWith("rental_")), false);
  for (const [name, schema] of remote) assert.equal(Object.hasOwn(schema, "cwd"), false, `${name} has no cwd input`);
  assert.equal(Object.hasOwn(stdio.get("register_agent_session")!, "cwd"), true, "stdio keeps cwd");
});

test("a remote connection cannot start a live local agent session", () => {
  const previous = process.env[LETAGENTS_REMOTE_TOOL_SURFACE_ENV];
  try {
    delete process.env[LETAGENTS_REMOTE_TOOL_SURFACE_ENV];
    assert.equal(normalizeJoinSessionMode("live"), "live");
    process.env[LETAGENTS_REMOTE_TOOL_SURFACE_ENV] = "1";
    assert.equal(normalizeJoinSessionMode("current"), "current");
    assert.throws(() => normalizeJoinSessionMode("LIVE"), /not available over the remote MCP endpoint/);
  } finally {
    if (previous === undefined) delete process.env[LETAGENTS_REMOTE_TOOL_SURFACE_ENV];
    else process.env[LETAGENTS_REMOTE_TOOL_SURFACE_ENV] = previous;
  }
});
