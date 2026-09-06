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
    ["Bearer ", "PATCH", "/rooms/public/tasks/task_1", false],
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
