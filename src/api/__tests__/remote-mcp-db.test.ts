import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path, { join, resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Full API app on a scratch database; the remote MCP server runs in process.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
// API and MCP tools share this process, so one cap applies to both.
process.env.LETAGENTS_POLL_MAX_MS = "1500";
process.env.LETAGENTS_REMOTE_MCP_MAX_SESSIONS_PER_ACCOUNT = "3";

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the DB-backed remote MCP tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const remoteSessionsDb = testDatabaseUrl ? await import("../db/remote-mcp-sessions.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;
const surface = await import("../../mcp/server/remote-tool-surface.js");

let server: Server | null = null;
let baseUrl = "";
const TOKEN_A = "remote_mcp_owner_token_a";
const TOKEN_B = "remote_mcp_owner_token_b";

async function createOwner(suffix: string, token: string) {
  const account = await accountSessions!.upsertAccount({
    provider: "github", provider_user_id: `remote-mcp-${suffix}`, login: `remote-mcp-${suffix}`, display_name: `Remote ${suffix}`,
  });
  return ownerTokens!.createOwnerToken({ accountId: account.id, githubUserId: `remote-mcp-${suffix}`, token });
}

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    await createOwner("a", TOKEN_A);
    await createOwner("b", TOKEN_B);
    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.after(async () => {
    routesModule!.closeApiRouteEventBroker();
    server?.closeAllConnections();
    await new Promise<void>((done) => server ? server.close(() => done()) : done());
    await dbClient!.pool.end();
  });
}

function sessions() {
  return routesModule!.remoteMcpSessionsForTest()!;
}

async function connect(token = TOKEN_A): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "Claude", version: "1" });
  await client.connect(transport);
  return { client, transport };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")?.text ?? "";
  try {
    return { ...JSON.parse(text), isError: result.isError };
  } catch {
    return { raw: text, isError: result.isError };
  }
}

function rawPost(token: string, sessionId: string, body: unknown) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId, "Mcp-Protocol-Version": "2025-06-18",
      "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

async function stdioToolNames(): Promise<string[]> {
  const temp = mkdtempSync(join(tmpdir(), "letagents-remote-parity-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/mcp/server.ts")],
    cwd: temp,
    env: { PATH: process.env.PATH!, HOME: temp, LETAGENTS_API_URL: "http://127.0.0.1:9",
      LETAGENTS_STATE_PATH: join(temp, "state.json"), LETAGENTS_EXECUTION_PROFILE: "autonomous_mcp_worker" },
    stderr: "ignore",
  });
  const client = new Client({ name: "stdio-parity", version: "1" });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    rmSync(temp, { recursive: true, force: true });
  }
}

test("the real API refuses an unknown owner token without echoing it", { skip, timeout: 30_000 }, async () => {
  const response = await rawPost("not-a-real-owner-token", "x", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes("not-a-real-owner-token"), false);
});

test("HTTP exposes exactly the remote allow list; stdio has nothing unclassified", { skip, timeout: 60_000 }, async () => {
  const [stdioNames, remote] = await Promise.all([stdioToolNames(), connect()]);
  try {
    const { tools } = await remote.client.listTools();
    const httpNames = tools.map((tool) => tool.name).sort();
    assert.deepEqual(httpNames, [...surface.REMOTE_ALLOWED_TOOLS].sort());
    assert.deepEqual(stdioNames.filter((name) => !surface.isRemoteExcludedTool(name)), httpNames);
    for (const tool of tools) assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, "cwd"), false, tool.name);
    const flood = await remote.client.callTool({ name: "send_message",
      arguments: { text: "x", reply_to: Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => [`k${i}`, i])) } });
    assert.match(JSON.stringify(flood.content), /more than the maximum of 10000 elements/);
  } finally {
    await remote.client.close();
  }
});

test("join_room, register, send_message and read_messages round-trip in process", { skip, timeout: 60_000 }, async () => {
  const { client } = await connect();
  try {
    const joined = await call(client, "join_room", { name: "remote-mcp-round-trip" });
    assert.equal(joined.isError, undefined, JSON.stringify(joined));
    const roomId = String(joined.room_id);
    const worker = await call(client, "register_agent_session",
      { room_id: roomId, display_name: "Remote Claude", runtime: "claude-app" });
    assert.ok(worker.agent_session_id, JSON.stringify(worker));
    assert.equal(worker.agent_session.repo_branch, null, "no git ran on the API server");
    assert.equal(worker.agent_session.host_kind, "remote_mcp");
    const text = `hello from the in-process endpoint ${Date.now()}`;
    const sent = await call(client, "send_message", { room_id: roomId, agent_session_id: worker.agent_session_id, text });
    assert.equal(sent.isError, undefined, JSON.stringify(sent));
    const read = await call(client, "read_messages", { room_id: roomId });
    assert.equal(JSON.stringify(read).includes(text), true);
  } finally {
    await client.close();
  }
});

test("two sessions with different tokens cannot see each other's room state", { skip, timeout: 60_000 }, async () => {
  const a = await connect(TOKEN_A);
  const b = await connect(TOKEN_B);
  try {
    await call(a.client, "join_room", { name: "remote-mcp-isolation-a" });
    const roomA = await call(a.client, "get_current_room");
    assert.equal(roomA.room_id, "remote-mcp-isolation-a", JSON.stringify(roomA));
    const roomB = await call(b.client, "get_current_room");
    assert.notEqual(roomB.room_id, "remote-mcp-isolation-a", "B does not inherit A's room");
    const readB = await call(b.client, "read_messages");
    assert.equal(JSON.stringify(readB).includes("remote-mcp-isolation-a"), false, "B's default room is not A's");
    const crossed = await rawPost(TOKEN_B, a.transport.sessionId!, { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
    assert.equal(crossed.status, 404, "B's token cannot use A's session id");
  } finally {
    await Promise.all([a.client.close(), b.client.close()]);
  }
});

test("a session survives a restart by reloading its state from the table", { skip, timeout: 60_000 }, async () => {
  const { client, transport } = await connect();
  try {
    const joined = await call(client, "join_room", { name: "remote-mcp-reload" });
    const worker = await call(client, "register_agent_session",
      { room_id: joined.room_id, display_name: "Reloaded Claude", runtime: "claude-app" });
    const row = await remoteSessionsDb!.getRemoteMcpSession(transport.sessionId!);
    assert.equal(row?.room_id, "remote-mcp-reload");
    assert.equal(row?.worker_session_id, worker.agent_session_id);

    sessions().dropLoaded(); // what a restart, or another replica, starts from
    const room = await call(client, "get_current_room");
    assert.equal(room.room_id, "remote-mcp-reload", "the joined room came back from Postgres");
    const sent = await call(client, "send_message",
      { room_id: joined.room_id, agent_session_id: worker.agent_session_id, text: "still here after reload" });
    assert.equal(sent.isError, undefined, `the worker connection came back too: ${JSON.stringify(sent)}`);

    // A durable worker handle is held by the session, so it reloads as well.
    const handle = await call(client, "register_agent_session",
      { room_id: joined.room_id, display_name: "Handle Claude", registration_key: "remote-reload-key" });
    assert.ok(handle.worker_id, JSON.stringify(handle));
    sessions().dropLoaded();
    const viaHandle = await call(client, "send_message",
      { room_id: joined.room_id, worker_id: handle.worker_id, text: "handle survives reload" });
    assert.equal(viaHandle.isError, undefined, JSON.stringify(viaHandle));
  } finally {
    await client.close();
  }
});

test("wait_for_messages in process is capped by LETAGENTS_POLL_MAX_MS", { skip, timeout: 60_000 }, async () => {
  const { client } = await connect();
  try {
    await call(client, "join_room", { name: "remote-mcp-long-poll" });
    const started = Date.now();
    const waited = await client.callTool({ name: "wait_for_messages", arguments: { timeout: 60_000 } });
    const elapsed = Date.now() - started;
    assert.notEqual(waited.isError, true, JSON.stringify(waited.content));
    assert.ok(elapsed >= 1_000, `the call really long-polled (${elapsed} ms)`);
    assert.ok(elapsed < 15_000, `a 60 s request returned after ${elapsed} ms under a 1.5 s cap`);
  } finally {
    await client.close();
  }
});

test("DELETE removes the session, and the account cap replaces the oldest", { skip, timeout: 60_000 }, async () => {
  const first = await connect();
  const id = first.transport.sessionId!;
  await first.transport.terminateSession();
  assert.equal(await remoteSessionsDb!.getRemoteMcpSession(id), null);
  assert.equal((await rawPost(TOKEN_A, id, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 404);

  const opened = [];
  for (let i = 0; i < 4; i += 1) opened.push(await connect());
  const ids = opened.map((connection) => connection.transport.sessionId!);
  const remaining = await Promise.all(ids.map((sessionId) => remoteSessionsDb!.getRemoteMcpSession(sessionId)));
  assert.equal(remaining.filter(Boolean).length, 3, "the cap of 3 holds");
  assert.equal(remaining[0], null, "the least recently used session was replaced");
  for (const connection of opened) await connection.client.close().catch(() => undefined);
});

test("revoking the owner token refuses its requests and the sweep deletes its sessions", { skip, timeout: 60_000 }, async () => {
  const created = await createOwner("revoked", "remote_mcp_token_to_revoke");
  const { client, transport } = await connect("remote_mcp_token_to_revoke");
  await ownerTokens!.deleteOwnerTokenById(created.token_id);
  const refused = await rawPost("remote_mcp_token_to_revoke", transport.sessionId!, { jsonrpc: "2.0", id: 9, method: "tools/list" });
  assert.equal(refused.status, 401);
  await sessions().sweep();
  assert.equal(await remoteSessionsDb!.getRemoteMcpSession(transport.sessionId!), null);
  await client.close().catch(() => undefined);
});
