import assert from "node:assert/strict";
import test from "node:test";

process.env.LETAGENTS_WEB_MODE = "legacy";
const { normalizeWebMode, registerWebRoutes } = await import("../web-routes.js");

test("normalizeWebMode accepts vue and defaults to legacy", (t) => {
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = originalWarn;
  });

  assert.equal(normalizeWebMode("vue"), "vue");
  assert.equal(normalizeWebMode(" VUE "), "vue");
  assert.equal(normalizeWebMode(undefined), "legacy");
  assert.equal(normalizeWebMode(""), "legacy");
  assert.equal(normalizeWebMode("legacy"), "legacy");
  assert.equal(normalizeWebMode("unknown"), "legacy");
});

test("registerWebRoutes preserves legacy route registration order", (t) => {
  const originalLog = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = originalLog;
  });

  const calls: Array<{ method: "get" | "use"; path: string }> = [];
  const app = {
    get(path: string) {
      calls.push({ method: "get", path });
    },
    use(pathOrMiddleware: string | unknown) {
      calls.push({
        method: "use",
        path: typeof pathOrMiddleware === "string" ? pathOrMiddleware : "<static>",
      });
    },
  };

  registerWebRoutes(app as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/" },
    { method: "get", path: "/docs" },
    { method: "get", path: "/app" },
    { method: "use", path: "<static>" },
  ]);
});
