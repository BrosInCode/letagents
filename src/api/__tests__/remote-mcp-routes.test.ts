import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { registerHttpMiddleware } from "../http/middleware.js";
import type { ResolvedRequestAuth } from "../http/helpers.js";
import { registerRemoteMcpRoutes } from "../routes/mcp/remote.js";
import { RemoteMcpSessionManager } from "../remote-mcp/sessions.js";
import { isRemoteExcludedTool, REMOTE_ALLOWED_TOOLS, REMOTE_EXCLUDED_TOOLS } from "../../mcp/server/remote-tool-surface.js";

// Route-level behaviour with stub auth: real MCP child processes, no database.
const ACCOUNTS: Record<string, ResolvedRequestAuth> = {
  "owner-a": { authKind: "owner_token", account: { account_id: "acct_a", login: "a" } as never },
  "owner-a2": { authKind: "owner_token", account: { account_id: "acct_a", login: "a" } as never },
  "owner-b": { authKind: "owner_token", account: { account_id: "acct_b", login: "b" } as never },
  "app-session": { authKind: "session", account: { account_id: "acct_a", login: "a" } as never },
};

async function startApp(sessions: RemoteMcpSessionManager): Promise<{ server: Server; url: string }> {
  const app = express();
  registerHttpMiddleware(app, {
    async resolveRequestAuth(req) {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
      return match ? ACCOUNTS[match[1]] ?? { account: null, authKind: null } : { account: null, authKind: null };
    },
  });
  registerRemoteMcpRoutes(app, { sessions });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` };
}

async function connect(url: string, token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "remote-mcp-test", version: "1" });
  await client.connect(transport);
  return { client, transport };
}

const initializeBody = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};

function post(url: string, headers: Record<string, string>, body: unknown = initializeBody): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
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

test("the remote endpoint refuses requests without an owner bearer before starting anything", { timeout: 30_000 }, async () => {
  const sessions = new RemoteMcpSessionManager();
  const { server, url } = await startApp(sessions);
  try {
    const badOrigin = await post(url, { Authorization: "Bearer owner-a", Origin: "https://evil.example" });
    assert.equal(badOrigin.status, 403, "a browser Origin outside the allow list is refused before auth");
    const goodOrigin = await post(url, { Origin: "https://letagents.chat" });
    assert.equal(goodOrigin.status, 401, "an allowed Origin still needs the bearer");
    const missing = await post(url, {});
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get("www-authenticate") ?? "", /^Bearer/);
    assert.equal((await post(url, { Authorization: "Bearer not-a-token" })).status, 401, "unknown bearer");
    assert.equal((await post(url, { Authorization: "Bearer" })).status, 401, "malformed bearer");
    const appSession = await post(url, { Authorization: "Bearer app-session" });
    assert.equal(appSession.status, 401, "app sessions are not owner tokens");
    assert.match((await appSession.json()).error.message, /bearer credential is invalid or expired/,
      "a valid bearer of the wrong kind gets the middleware's message");
    const cookieOnly = await post(url, { Cookie: "letagents_session=whatever" });
    assert.equal(cookieOnly.status, 401, "a browser cookie never opens the MCP endpoint");
    const notInitialize = await post(url, { Authorization: "Bearer owner-a" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(notInitialize.status, 400, "no child starts for a request that is not initialize");
    const oversized = await post(url, { Authorization: "Bearer owner-a" },
      { ...initializeBody, params: { ...initializeBody.params, padding: "x".repeat(300 * 1024) } });
    assert.equal(oversized.status, 413, "bodies over the MCP cap never reach SDK validation");
    const wrongAccept = await fetch(url, { method: "POST", body: JSON.stringify(initializeBody),
      headers: { Authorization: "Bearer owner-a", "Content-Type": "application/json", Accept: "application/json" } });
    assert.equal(wrongAccept.status, 406, "a request the transport would refuse never starts a child");
    const getWithoutSession = await fetch(url, { headers: { Authorization: "Bearer owner-a" } });
    assert.equal(getWithoutSession.status, 400);
    assert.equal(sessions.size, 0, "no session was created by a rejected request");
  } finally {
    await sessions.closeAll();
    server.close();
  }
});

test("HTTP exposes exactly the remote allow list, and stdio has nothing unclassified", { timeout: 60_000 }, async () => {
  const sessions = new RemoteMcpSessionManager();
  const { server, url } = await startApp(sessions);
  try {
    const [stdioNames, remote] = await Promise.all([stdioToolNames(), connect(url, "owner-a")]);
    const { tools } = await remote.client.listTools();
    const httpNames = tools.map((tool) => tool.name).sort();
    for (const name of Object.keys(REMOTE_EXCLUDED_TOOLS)) {
      assert.equal(stdioNames.includes(name), true, `${name} is a real stdio tool, so its exclusion is meaningful`);
    }
    assert.deepEqual(httpNames, [...REMOTE_ALLOWED_TOOLS].sort(), "HTTP exposes exactly the allow list");
    assert.deepEqual(stdioNames.filter((name) => !isRemoteExcludedTool(name)), httpNames,
      "every stdio tool is either exposed remotely or excluded with a reason");
    for (const tool of tools) {
      assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, "cwd"), false, `${tool.name} takes no local path remotely`);
    }
    const flood = await remote.client.callTool({ name: "send_message",
      arguments: { text: "x", reply_to: Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => [`k${i}`, i])) } });
    assert.equal(flood.isError, true);
    assert.match(JSON.stringify(flood.content), /more than the maximum of 10000 elements/,
      "the SDK's element limit refuses the call before tool validation");
    await remote.client.close();
  } finally {
    await sessions.closeAll();
    server.close();
  }
});

test("a session answers only to the token that opened it, and DELETE removes it", { timeout: 60_000 }, async () => {
  const sessions = new RemoteMcpSessionManager();
  const { server, url } = await startApp(sessions);
  try {
    const { client, transport } = await connect(url, "owner-a");
    const sessionId = transport.sessionId!;
    assert.ok(sessionId);
    assert.equal(sessions.size, 1);
    const listBody = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId,
      "Mcp-Protocol-Version": "2025-06-18" });
    assert.equal((await post(url, headers("owner-b"), listBody)).status, 404, "another account cannot use the session");
    assert.equal((await post(url, headers("owner-a2"), listBody)).status, 404,
      "another token of the same account cannot use the session");
    assert.equal((await post(url, headers("owner-a"), { ...listBody, id: 3 })).status, 200);

    const dirs = [...(sessions as unknown as { sessions: Map<string, { dir: string }> }).sessions.values()].map((s) => s.dir);
    await transport.terminateSession();
    await client.close();
    for (let i = 0; i < 100 && (sessions.size || dirs.some((dir) => existsSync(dir))); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(sessions.size, 0, "DELETE closes the session");
    assert.equal(dirs.every((dir) => !existsSync(dir)), true, "the per-session folder is removed");
    assert.equal((await post(url, headers("owner-a"), listBody)).status, 404, "a closed session id is gone");
  } finally {
    await sessions.closeAll();
    server.close();
  }
});

test("idle sessions are swept, and an account at its cap replaces its least recently used idle session", { timeout: 60_000 }, async () => {
  let now = 1_000_000;
  const sessions = new RemoteMcpSessionManager({
    now: () => now,
    limits: { maxSessionsPerAccount: 1, maxSessions: 2, idleTimeoutMs: 60_000, maxLifetimeMs: 3_600_000 },
  });
  const { server, url } = await startApp(sessions);
  try {
    const first = await connect(url, "owner-a");
    const second = await connect(url, "owner-a");
    assert.notEqual(first.transport.sessionId, second.transport.sessionId);
    assert.equal(sessions.size, 1, "the per-account cap closed the older idle session");
    const third = await connect(url, "owner-b");
    assert.equal(sessions.size, 2);
    const overflow = await post(url, { Authorization: "Bearer owner-c-unknown" });
    assert.equal(overflow.status, 401);

    now += 61_000;
    sessions.sweep();
    for (let i = 0; i < 50 && sessions.size; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(sessions.size, 0, "idle sessions are closed by the sweep");
    for (const connection of [first, second, third]) await connection.client.close().catch(() => undefined);
  } finally {
    await sessions.closeAll();
    server.close();
  }
});

test("the global cap refuses new sessions with 503", { timeout: 60_000 }, async () => {
  const sessions = new RemoteMcpSessionManager({ limits: { maxSessions: 1 } });
  const { server, url } = await startApp(sessions);
  try {
    const first = await connect(url, "owner-a");
    const refused = await post(url, { Authorization: "Bearer owner-b" });
    assert.equal(refused.status, 503);
    assert.equal(sessions.size, 1);
    assert.deepEqual({ inUse: sessions.stats().inUse, refused: sessions.stats().refusedGlobalCap }, { inUse: 1, refused: 1 });
    await first.client.close();
  } finally {
    await sessions.closeAll();
    server.close();
  }
});

test("concurrent initializes from one account respect the account cap", { timeout: 60_000 }, async () => {
  const sessions = new RemoteMcpSessionManager({ limits: { maxSessionsPerAccount: 2, maxSessions: 10 } });
  const { server, url } = await startApp(sessions);
  try {
    const responses = await Promise.all(Array.from({ length: 6 }, () => post(url, { Authorization: "Bearer owner-a" })));
    const statuses = responses.map((response) => response.status).sort();
    for (const response of responses) await response.body?.cancel();
    assert.equal(statuses.filter((status) => status === 200).length, 2, `two creates proceed: ${statuses}`);
    assert.equal(statuses.filter((status) => status === 429).length, 4, `the rest are refused: ${statuses}`);
    assert.ok(sessions.size <= 2);
    assert.equal(sessions.stats().refusedAccountCap, 4);
  } finally {
    await sessions.closeAll();
    server.close();
  }
});

test("the sweep closes sessions whose owner token was revoked", { timeout: 60_000 }, async () => {
  const revoked = new Set<string>();
  const sessions = new RemoteMcpSessionManager({
    isTokenValid: async (hashHex) => !revoked.has(hashHex),
  });
  const { server, url } = await startApp(sessions);
  try {
    const a = await connect(url, "owner-a");
    const b = await connect(url, "owner-b");
    assert.equal(sessions.size, 2);
    revoked.add(createHash("sha256").update("owner-a").digest("hex"));
    sessions.sweep();
    for (let i = 0; i < 100 && sessions.size !== 1; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(sessions.size, 1, "only the revoked token's session closed");
    await Promise.all([a.client.close().catch(() => undefined), b.client.close()]);
  } finally {
    await sessions.closeAll();
    server.close();
  }
});

test("global pressure closes another account's session only after it has idled a while", { timeout: 60_000 }, async () => {
  let now = 5_000_000;
  const sessions = new RemoteMcpSessionManager({ now: () => now, limits: { maxSessions: 1, maxSessionsPerAccount: 4 } });
  const { server, url } = await startApp(sessions);
  try {
    const a = await connect(url, "owner-a");
    const early = await post(url, { Authorization: "Bearer owner-b" });
    assert.equal(early.status, 503, "a session that was just used is not taken from its owner");
    now += 3 * 60_000;
    const b = await connect(url, "owner-b");
    for (let i = 0; i < 100 && sessions.size !== 1; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(sessions.size, 1, "the long-idle session made room");
    await Promise.all([a.client.close().catch(() => undefined), b.client.close()]);
  } finally {
    await sessions.closeAll();
    server.close();
  }
});
