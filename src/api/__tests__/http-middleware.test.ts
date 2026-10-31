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
