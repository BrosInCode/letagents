import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { registerHttpMiddleware } from "../http/middleware.js";
import type { AuthenticatedRequest, ResolvedRequestAuth } from "../http/helpers.js";
import { registerRemoteMcpRoutes } from "../routes/mcp/remote.js";
import type { RemoteMcpSessions } from "../remote-mcp/sessions.js";
import { InProcessDispatcher } from "../remote-mcp/in-process-dispatch.js";
import { currentSessionScope, runInSessionScope, type McpSessionScope } from "../../mcp/server/runtime/session-scope.js";

// Route-level refusals with stub auth and no database: every refusal happens
// before any session is looked up, opened or served.
const ACCOUNTS: Record<string, ResolvedRequestAuth> = {
  "owner-a": { authKind: "owner_token", account: { account_id: "acct_a", login: "a" } as never },
  "app-session": { authKind: "session", account: { account_id: "acct_a", login: "a" } as never },
};

function untouchableSessions(): RemoteMcpSessions & { calls: string[] } {
  const calls: string[] = [];
  const fail = (name: string) => async () => {
    calls.push(name);
    throw new Error(`${name} must not be reached`);
  };
  return { calls, open: fail("open"), find: fail("find"), handle: fail("handle"), delete: fail("delete") } as never;
}

async function startApp(sessions: RemoteMcpSessions): Promise<{ server: Server; base: string; app: express.Express }> {
  const app = express();
  registerHttpMiddleware(app, {
    async resolveRequestAuth(req) {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
      return match ? ACCOUNTS[match[1]] ?? { account: null, authKind: null } : { account: null, authKind: null };
    },
  });
  registerRemoteMcpRoutes(app, { sessions });
  app.get("/whoami", (req: AuthenticatedRequest, res) => {
    res.json({ authKind: req.authKind ?? null, account: (req.sessionAccount as { account_id?: string } | null)?.account_id ?? null,
      ...(currentSessionScope() ? { scope: currentSessionScope()!.sessionId } : {}) });
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, app, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
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

test("the remote endpoint refuses bad requests before any session work", { timeout: 30_000 }, async () => {
  const sessions = untouchableSessions();
  const { server, base } = await startApp(sessions);
  const url = `${base}/mcp`;
  try {
    const badOrigin = await post(url, { Authorization: "Bearer owner-a", Origin: "https://evil.example" });
    assert.equal(badOrigin.status, 403, "a browser Origin outside the allow list is refused before auth");
    assert.equal((await post(url, { Origin: "https://letagents.chat" })).status, 401, "an allowed Origin still needs the bearer");

    const missing = await post(url, {});
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get("www-authenticate") ?? "", /^Bearer/);
    assert.equal((await post(url, { Authorization: "Bearer" })).status, 401, "malformed bearer");
    assert.equal((await post(url, { Cookie: "letagents_session=whatever" })).status, 401, "a cookie never opens the endpoint");

    const appSession = await post(url, { Authorization: "Bearer app-session" });
    const unknownBearer = await post(url, { Authorization: "Bearer not-a-token" });
    assert.deepEqual(
      { status: appSession.status, auth: appSession.headers.get("www-authenticate"), body: await appSession.json() },
      { status: unknownBearer.status, auth: unknownBearer.headers.get("www-authenticate"), body: await unknownBearer.json() },
      "a valid bearer of the wrong kind looks exactly like an invalid bearer");

    const notInitialize = await post(url, { Authorization: "Bearer owner-a" }, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(notInitialize.status, 400);
    const wrongAccept = await fetch(url, { method: "POST", body: JSON.stringify(initializeBody),
      headers: { Authorization: "Bearer owner-a", "Content-Type": "application/json", Accept: "application/json" } });
    assert.equal(wrongAccept.status, 406);
    const oversized = await post(url, { Authorization: "Bearer owner-a" },
      { ...initializeBody, params: { ...initializeBody.params, padding: "x".repeat(300 * 1024) } });
    assert.equal(oversized.status, 413, "bodies over the MCP cap never reach SDK validation");
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer owner-a" } })).status, 400);

    assert.deepEqual(sessions.calls, [], "no refused request reached the session store");
  } finally {
    server.close();
  }
});

test("only in-process connections carry a bound principal, and they cannot re-enter /mcp", { timeout: 30_000 }, async () => {
  const sessions = untouchableSessions();
  const { server, base, app } = await startApp(sessions);
  try {
    const outside = await fetch(`${base}/whoami`, { headers: { Authorization: "Bearer owner-a" } });
    assert.deepEqual(await outside.json(), { authKind: "owner_token", account: "acct_a" }, "normal requests use normal auth");
    const anonymous = await fetch(`${base}/whoami`);
    assert.deepEqual(await anonymous.json(), { authKind: null, account: null });

    const dispatch = new InProcessDispatcher(app).bind({
      account: { account_id: "acct_bound", login: "bound" } as never,
      remoteMcpSessionId: "session-x",
    });
    const scope = { sessionId: "scope-under-test", memory: new Map() } as unknown as McpSessionScope;
    const inside = await runInSessionScope(scope, () =>
      dispatch("/whoami", { headers: { Authorization: "Bearer owner-a", Cookie: "letagents_session=x" } }));
    assert.deepEqual(await inside.json(), { authKind: "owner_token", account: "acct_bound" },
      "the bound account wins, credentials passed in are dropped, and the route runs outside the session scope");
    const reenter = await dispatch("/mcp", { method: "POST", body: JSON.stringify(initializeBody),
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" } });
    assert.equal(reenter.status, 403);
    await assert.rejects(dispatch("http://evil.example/whoami", {}), /absolute paths/);
    assert.deepEqual(sessions.calls, []);
  } finally {
    server.close();
  }
});
