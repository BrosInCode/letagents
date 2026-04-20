import assert from "node:assert/strict";
import test from "node:test";

const { registerHttpMiddleware } = await import("../http-middleware.js");

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
