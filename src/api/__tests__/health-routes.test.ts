import assert from "node:assert/strict";
import test from "node:test";

const { registerHealthRoutes } = await import("../routes/health.js");

test("registerHealthRoutes preserves health route order", () => {
  const calls: Array<{ method: "get"; path: string }> = [];
  const app = {
    get(path: string) {
      calls.push({ method: "get", path });
    },
  };

  registerHealthRoutes(app as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/api/health" },
  ]);
});
