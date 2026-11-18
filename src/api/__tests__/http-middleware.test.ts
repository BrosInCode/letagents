import assert from "node:assert/strict";
import test from "node:test";

const { registerHttpMiddleware } = await import("../http/middleware.js");

function createDeps() {
  return {
    resolveRequestAuth: async () => ({
      account: null,
      authKind: null,
    }),
  };
}

test("registerHttpMiddleware preserves initial middleware order", () => {
  const calls: Array<{ method: "use" | "options"; path?: string }> = [];
  const app = {
    use() {
      calls.push({ method: "use" });
    },
    options(path: string) {
      calls.push({ method: "options", path });
    },
  };

  registerHttpMiddleware(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "use" },
    { method: "use" },
    { method: "use" },
    { method: "options", path: "{*path}" },
  ]);
});

test("registerHttpMiddleware allows PUT requests for CORS preflight", async () => {
  const handlers: Function[] = [];
  const headers = new Map<string, string>();
  const app = {
    use(handler: Function) {
      handlers.push(handler);
    },
    options() {},
  };
  const req = {
    headers: {
      origin: "https://letagents.chat",
    },
  };
  const res = {
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
  };

  registerHttpMiddleware(app as never, createDeps() as never);
  await handlers[1](req, res, () => undefined);
  handlers[2](req, res, () => undefined);

  assert.equal(headers.get("Access-Control-Allow-Origin"), "https://letagents.chat");
  assert.match(headers.get("Access-Control-Allow-Methods") ?? "", /\bPUT\b/);
});

test("rejected bearer credentials cannot fall through to anonymous room access", async () => {
  const handlers: Function[] = [];
  registerHttpMiddleware({ use: (handler: Function) => handlers.push(handler), options() {} } as never, createDeps() as never);
  for (const [authorization, method, path, rejected] of [
    [undefined, "PATCH", "/rooms/public/tasks/task_1", false],
    ["Bearer ", "PATCH", "/rooms/public/tasks/task_1", true],
    ["Bearer\t", "PATCH", "/rooms/public/tasks/task_1", true],
    ["Bearer invalid token", "PATCH", "/rooms/public/tasks/task_1", true],
    ["Bearer\tinvalid", "PATCH", "/rooms/public/tasks/task_1", true],
    ["Bearer revoked-worker", "PATCH", "/rooms/public/tasks/task_1", true],
    ["bearer invalid", "PATCH", "/rooms/public/tasks/task_1", true],
    ["Bearer expired-owner", "GET", "/auth/session", false],
    ["Bearer revoked-worker", "POST", "/auth/session", true],
  ] as const) {
    let continued = false;
    let status: number | null = null;
    const res = { status(code: number) { status = code; return this; }, json() {} };
    await handlers[1]({ method, path, headers: { authorization } }, res, () => { continued = true; });
    assert.equal(status, rejected ? 401 : null);
    assert.equal(continued, !rejected);
  }
});

test("a given agent waiting for the asker may stay connected and do nothing else", async () => {
  const run = async (auth: Record<string, unknown>, method: string, path: string, waiting = true) => {
    const handlers: Function[] = [];
    registerHttpMiddleware({ use: (handler: Function) => handlers.push(handler), options() {} } as never, {
      resolveRequestAuth: async () => auth, isGrantWaitingForAsker: async () => waiting,
    } as never);
    let continued = false; let body: any = null;
    const res = { status() { return this; }, json(value: unknown) { body = value; } };
    await handlers[1]({ method, path, headers: {} }, res, () => { continued = true; });
    return { continued, code: body?.code ?? null };
  };
  const worker = (waiting: boolean) => ({ account: null, authKind: "agent_session", agentSession: {
    agent_session_id: "s", capabilities: ["messages.read", "messages.write", "coordination.read", "coordination.self_write", "coordination.propose"], waiting_for_asker: waiting } });
  for (const [method, path] of [["POST", "/rooms/r/messages"], ["GET", "/rooms/r/messages"], ["POST", "/rooms/r/agent-ask-workspace/read"], ["POST", "/rooms/r/tasks"]]) {
    assert.deepEqual(await run(worker(true), method, path), { continued: false, code: "waiting_for_asker" }, `${method} ${path}`);
    assert.equal((await run(worker(false), method, path)).continued, true, `${method} ${path} once accepted`);
  }
  assert.equal((await run(worker(true), "POST", "/rooms/r/agent-sessions/s/desktop-heartbeat")).continued, true);

  process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "1";
  const grant = (scope: string) => ({ account: null, authKind: "supervisor_grant", supervisorGrant: { grant_id: "g", scope_key: scope } });
  assert.deepEqual(await run(grant("ask:ask_1"), "POST", "/supervisor-host-grants/g/worker-sessions/s/agent-work"), { continued: false, code: "waiting_for_asker" });
  assert.equal((await run(grant("ask:ask_1"), "POST", "/supervisor-host-grants/g/renew")).continued, true);
  assert.equal((await run(grant("ask:ask_1"), "POST", "/supervisor-host-grants/g/worker-sessions/s/agent-work", false)).continued, true);
  assert.equal((await run(grant("owner"), "POST", "/supervisor-host-grants/g/worker-sessions/s/agent-work")).continued, true, "other grants are never checked");
  delete process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED;
});

test("a page's large HTML body is read only after the caller is known", async () => {
  process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
  const [{ default: express }, { z }, { once }, http, core, router, route, rateLimit] = await Promise.all([
    import("express"), import("zod"), import("node:events"), import("node:http"),
    import("../../../shared/api/core.mjs"), import("../v1/router.js"), import("../v1/route.js"), import("../v1/rate-limit.js"),
  ]);
  const create = core.defineMethod({
    name: "pages.createExample", area: "pages", kind: "write", capability: "rooms.read", description: "Takes HTML.",
    path: "/rooms/:room/pages", input: z.object({ html: z.string() }), output: z.object({ length: z.number() }), rateClass: "write",
  });
  let handled = 0;
  const app = express();
  registerHttpMiddleware(app, {
    resolveRequestAuth: async (req: { headers: Record<string, unknown> }) => req.headers.authorization === "Bearer good"
      ? { account: { account_id: "acct_ada", login: "ada" }, authKind: "owner_token" }
      : { account: null, authKind: null },
  } as never);
  router.registerApiV1Routes(app, {
    routes: [route.defineRoute(create, (input) => { handled += 1; return { length: input.html.length }; })],
    identifyCaller: async (req) => req.sessionAccount ? { principal: { kind: "person", id: req.sessionAccount.account_id }, account: null } : null,
    resolveRoomAccess: async (caller, roomId) => ({ actor: { principal: caller.principal, roomId }, room: { id: roomId } as never, access: { kind: "membership", accessRoomId: roomId } }),
    checkCapability: async () => {},
    recordAction: async () => {},
    rateLimiter: rateLimit.createApiRateLimiter(),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as import("node:net").AddressInfo).port;
  const path = "/api/v1/rooms/r1/pages";
  try {
    // No credential, streamed with no length: the 401 arrives while most of
    // the 5 MB is still unsent, so the server never waited for (or parsed) it.
    const streamed = await new Promise<{ status: number; sent: number }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } });
      let sent = 0;
      req.on("response", (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, sent }); req.destroy(); });
      req.on("error", reject);
      req.write('{"html":"');
      const chunk = "x".repeat(64 * 1024);
      const pump = () => {
        if (sent >= 5 * 1024 * 1024 || req.destroyed) return;
        sent += chunk.length;
        req.write(chunk);
        setTimeout(pump, 20);
      };
      pump();
    });
    assert.equal(streamed.status, 401);
    assert.ok(streamed.sent < 5 * 1024 * 1024, `answered after ${streamed.sent} bytes`);

    // No credential and a declared length over 1 MB: refused from the header alone.
    const declared = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": String(5 * 1024 * 1024) } });
      req.on("response", (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, connection: res.headers.connection }); req.destroy(); });
      req.on("error", reject);
      req.write('{"html":"');
    });
    assert.deepEqual(declared, { status: 401, connection: "close" });
    assert.equal(handled, 0);

    // Signed in: a 3 MB body (a page's HTML, escaped) is read and handled.
    const html = '"'.repeat(1.5 * 1024 * 1024);
    const ok = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ html }),
    });
    assert.deepEqual({ status: ok.status, body: await ok.json() }, { status: 200, body: { length: html.length } });
    const tooBig = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ html: "x".repeat(6 * 1024 * 1024) }),
    });
    assert.equal((await tooBig.json()).code, "too_large");
    // Every other route keeps the 1 MB limit.
    const other = await fetch(`http://127.0.0.1:${port}/api/v1/rooms/r1/tasks`, {
      method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ html: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal((await other.json()).code, "too_large");
    assert.equal(handled, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
