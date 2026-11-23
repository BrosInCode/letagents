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
  // The server has no caller files to attach; stdio reads them from the caller's workspace.
  for (const [name, schema] of remote) assert.equal(Object.hasOwn(schema, "attachments"), false, `${name} has no attachments input`);
  for (const name of ["send_message", "send_thread_message"]) assert.equal(Object.hasOwn(stdio.get(name)!, "attachments"), true, `stdio ${name} keeps attachments`);
  // Files given as content need no folder, so a remote bot can send them.
  for (const name of ["send_message", "send_thread_message"]) {
    assert.equal(Object.hasOwn(remote.get(name)!, "files"), true, `remote ${name} offers files`);
    assert.equal(Object.hasOwn(stdio.get(name)!, "files"), true, `stdio ${name} offers files`);
  }
  assert.ok(remote.has("read_attachment"), "remote bots read attachments");
});

test("publish_page: npm and desktop room agents publish from a file or an attachment; remote bots from an attachment", () => {
  const inputs = (profile: Parameters<typeof registerTools>[1], options: Parameters<typeof registerTools>[3]) => {
    let schema: Record<string, unknown> | undefined;
    const server = {
      tool(name: string, ...registration: unknown[]) {
        // The input shape is the object argument that names page_id; wrappers may add annotations.
        if (name === "publish_page") {
          schema = registration.find((part): part is Record<string, unknown> =>
            typeof part === "object" && part !== null && Object.hasOwn(part, "page_id"));
        }
        return {};
      },
    } as unknown as McpServer;
    registerTools(server, profile, null, options);
    // Only where the page may come from; the worker wrapper adds worker_id to some kinds.
    return Object.keys(schema ?? {}).filter((field) => field === "path" || field === "source").sort();
  };
  assert.deepEqual(inputs("autonomous_mcp_worker", {}), ["path", "source"]);
  assert.deepEqual(inputs("autonomous_mcp_worker", { remote: true }), ["source"]);
  // The agent's own MCP process and the daemon that runs its tool calls (and reads the file) register the same input.
  assert.deepEqual(inputs("supervised_room_turn", {}), ["path", "source"]);
  assert.deepEqual(inputs("supervised_room_turn", { executionOwner: "daemon" }), ["path", "source"]);
  assert.deepEqual(inputs("supervised_mcp_polling", {}), ["source"]);
});

test("the remote proxy strips cwd from registerTool and refuses shapes it does not know", () => {
  const calls: unknown[][] = [];
  const base = {
    tool(...args: unknown[]) { calls.push(["tool", ...args]); return {}; },
    registerTool(...args: unknown[]) { calls.push(["registerTool", ...args]); return {}; },
  } as unknown as McpServer;
  const remote = remoteToolServer(base);
  const callback = async () => ({ content: [] });
  remote.registerTool("send_message", { inputSchema: { cwd: {}, attachments: {}, text: {} } } as never, callback as never);
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

test("no session, local or remote, can start a live local agent session", () => {
  assert.throws(() => normalizeJoinSessionMode("live"), /removed in letagents 0\.12\.46/);
  runInSessionScope(fakeScope(), () => {
    assert.equal(normalizeJoinSessionMode("current"), "current");
    assert.throws(() => normalizeJoinSessionMode("LIVE"), /removed in letagents 0\.12\.46/);
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

test("a hosted runtime fails closed when a session scope is missing", async () => {
  const { markHostedMcpRuntime } = await import("../server/runtime/session-scope.js");
  const { getCurrentRoom } = await import("../server/runtime/room-state.js");
  const { readLocalState } = await import("../local-state/storage.js");
  const { getLetagentsToken } = await import("../server/runtime/api.js");
  const { getGitCurrentBranch } = await import("../git-remote.js");
  markHostedMcpRuntime(); // last test in this file: the flag is process-wide
  assert.throws(() => getCurrentRoom(), /without a remote MCP session scope/);
  assert.throws(() => readLocalState(), /without a remote MCP session scope/);
  assert.throws(() => getGitCurrentBranch(process.cwd()), /without a remote MCP session scope/);
  await assert.rejects(getLetagentsToken(), /without a remote MCP session scope/);
  runInSessionScope(fakeScope(), () => assert.equal(getCurrentRoom(), null, "inside a scope it works"));
});
