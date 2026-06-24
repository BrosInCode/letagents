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
