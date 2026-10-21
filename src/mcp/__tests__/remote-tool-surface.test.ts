import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../server/register-tools.js";
import {
  isRemoteAllowedTool,
  isRemoteExcludedTool,
  LETAGENTS_REMOTE_TOOL_SURFACE_ENV,
  REMOTE_ALLOWED_TOOLS,
  REMOTE_EXCLUDED_TOOLS,
  remoteToolServer,
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

test("the remote surface is exactly the allow list, and every stdio tool is classified", () => {
  const stdio = discovered(false);
  const remote = discovered(true);
  assert.deepEqual([...remote.keys()].sort(), [...REMOTE_ALLOWED_TOOLS].sort(),
    "add a new remote tool to REMOTE_ALLOWED_TOOLS on purpose, never by accident");
  const unclassified = [...stdio.keys()].filter((name) => !isRemoteAllowedTool(name) && !isRemoteExcludedTool(name));
  assert.deepEqual(unclassified, [], "classify every registry tool as remote-allowed or remote-excluded");
  for (const name of REMOTE_ALLOWED_TOOLS) {
    assert.equal(stdio.has(name), true, `${name} exists in stdio`);
    assert.equal(isRemoteExcludedTool(name), false, `${name} is not both allowed and excluded`);
  }
  for (const name of Object.keys(REMOTE_EXCLUDED_TOOLS)) assert.equal(stdio.has(name), true, `${name} exists in stdio`);
  for (const [name, schema] of remote) assert.equal(Object.hasOwn(schema, "cwd"), false, `${name} has no cwd input`);
  assert.equal(Object.hasOwn(stdio.get("register_agent_session")!, "cwd"), true, "stdio keeps cwd");
});

test("the remote proxy strips cwd from registerTool and refuses shapes it does not know", () => {
  const calls: unknown[][] = [];
  const base = {
    tool(...args: unknown[]) { calls.push(["tool", ...args]); return {}; },
    registerTool(...args: unknown[]) { calls.push(["registerTool", ...args]); return {}; },
  } as unknown as McpServer;
  const remote = remoteToolServer(base);
  const callback = async () => ({ content: [] });
  remote.registerTool("send_message", { inputSchema: { cwd: {}, text: {} } } as never, callback as never);
  assert.deepEqual(Object.keys((calls[0]![2] as { inputSchema: object }).inputSchema), ["text"]);
  remote.registerTool("begin_workspace_capture", { inputSchema: { cwd: {} } } as never, callback as never);
  remote.tool("check_repo", "local", { cwd: {} } as never, callback as never);
  assert.equal(calls.length, 1, "tools outside the allow list never register");
  assert.throws(() => (remote.tool as (...args: unknown[]) => unknown)("send_message", "d", "extra", {}, callback),
    /unrecognised registration shape/);
  assert.throws(() => (remote.tool as (...args: unknown[]) => unknown)("send_message", "d", {}),
    /no callback/);
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
