import assert from "node:assert/strict";
import test from "node:test";

process.env.LETAGENTS_WEB_MODE = "vue";
const { normalizeWebMode, registerWebRoutes } = await import("../routes/web/index.js");

test("normalizeWebMode accepts vue and defaults to Vue", (t) => {
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = originalWarn;
  });

  assert.equal(normalizeWebMode("vue"), "vue");
  assert.equal(normalizeWebMode(" VUE "), "vue");
  assert.equal(normalizeWebMode(undefined), "vue");
  assert.equal(normalizeWebMode(""), "vue");
  assert.equal(normalizeWebMode("legacy"), "vue");
  assert.equal(normalizeWebMode("unknown"), "vue");
});

test("registerWebRoutes preserves route registration order", (t) => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => {
    console.log = originalLog;
    console.warn = originalWarn;
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
    { method: "use", path: "<static>" },
    { method: "get", path: "/" },
    { method: "get", path: "/docs" },
    { method: "get", path: "/app" },
  ]);
});
