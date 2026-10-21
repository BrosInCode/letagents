import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../server/register-tools.js";
import {
  isRemoteAllowedTool,
  isRemoteExcludedTool,
  REMOTE_ALLOWED_TOOLS,
  REMOTE_EXCLUDED_TOOLS,
  remoteToolServer,
} from "../server/remote-tool-surface.js";
import { normalizeJoinSessionMode } from "../server/runtime/rooms.js";
import { runInSessionScope, type McpSessionScope } from "../server/runtime/session-scope.js";

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

function fakeScope(): McpSessionScope {
  return {
    sessionId: "session-test", accountId: "acct", agentInstanceId: "instance-test", clientName: "Claude",
    publicBaseUrl: "https://letagents.chat",
    dispatch: async () => { throw new Error("no API in this test"); },
    state: { local: {}, currentRoom: null, fullPromptDelivered: false, pinnedConnections: {} },
    dirty: false, memory: new Map(), persist: async () => undefined,
  };
}

test("a remote session cannot start a live local agent session", () => {
  assert.equal(normalizeJoinSessionMode("live"), "live", "stdio keeps live sessions");
  runInSessionScope(fakeScope(), () => {
    assert.equal(normalizeJoinSessionMode("current"), "current");
    assert.throws(() => normalizeJoinSessionMode("LIVE"), /not available over the remote MCP endpoint/);
  });
});

test("inside a session scope, state is per session and the local machine is out of reach", async () => {
  const { getCurrentRoom, rememberRoom } = await import("../server/runtime/room-state.js");
  const { readLocalState, updateLocalState } = await import("../local-state/storage.js");
  const { getGitCurrentBranch } = await import("../git-remote.js");
  const { findLetagentsConfig } = await import("../config-reader.js");
  const { readCommandOutput } = await import("../server/runtime/identity/config.js");
  const { agentInstanceUuid, AGENT_INSTANCE_UUID } = await import("../server/runtime/identity/state.js");
  const { getLetagentsToken } = await import("../server/runtime/api.js");
  const a = fakeScope();
  const b = { ...fakeScope(), sessionId: "session-b", agentInstanceId: "instance-b",
    state: { local: {}, currentRoom: null, fullPromptDelivered: false, pinnedConnections: {} }, memory: new Map() };
  runInSessionScope(a, () => {
    rememberRoom({ room_id: "room-a", joined_via: "join_room" });
    updateLocalState((state) => { state.local_host_id = "host-a"; });
  });
  runInSessionScope(b, () => {
    assert.equal(getCurrentRoom(), null, "B does not see A's room");
    assert.equal(readLocalState().local_host_id, undefined, "B does not see A's local state");
    assert.equal(agentInstanceUuid(), "instance-b");
  });
  runInSessionScope(a, () => {
    assert.equal(getCurrentRoom()?.room_id, "room-a");
    assert.equal(getGitCurrentBranch(process.cwd()), null, "no git on the API server");
    assert.equal(findLetagentsConfig(process.cwd()), null, "no config files on the API server");
    assert.equal(readCommandOutput("echo leaked"), null, "no programs on the API server");
  });
  assert.equal(a.state.local.local_host_id, "host-a");
  assert.equal(a.dirty, true);
  assert.equal(getCurrentRoom(), null, "the process (stdio) room is untouched");
  assert.equal(agentInstanceUuid(), AGENT_INSTANCE_UUID);
  await runInSessionScope(a, async () => {
    await assert.rejects(getLetagentsToken(), /no token/);
  });
});
