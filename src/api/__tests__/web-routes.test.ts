import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";

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
    { method: "get", path: "/join/:organizationId" },
    { method: "get", path: "/app" },
  ]);
});


test("direct company invitations serve the same application as the landing page", async () => {
  const app = express();
  registerWebRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    const landing = await fetch(origin);
    const invitation = await fetch(`${origin}/join/42`);
    // A missing local build returns the same explicit 503 as the landing page.
    // Production builds must serve HTML, never the default Express 404.
    assert.ok([200, 503].includes(invitation.status));
    assert.equal(invitation.status, landing.status);
    assert.equal(await invitation.text(), await landing.text());
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
