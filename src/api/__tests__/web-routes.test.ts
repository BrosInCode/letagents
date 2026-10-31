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
    { method: "get", path: ["/messages", "/my-work", "/connectors"] },
    { method: "get", path: /^\/ask\/[A-Za-z0-9_-]{20,64}$/ },
    { method: "get", path: "/app" },
  ]);
});


test("My Work and Connectors direct navigation and sign-in return load the same SPA as Messages", async (t) => {
  const { default: express } = await import("express");
  const app = express();
  // Exercise the real route handlers without depending on a concurrent Vite build
  // or Express dotfile restrictions on hidden worktree paths.
  app.use((_req, res, next) => {
    res.sendFile = ((_path: string) => res.status(200).send("Vue SPA")) as typeof res.sendFile;
    next();
  });
  registerWebRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const messages = await fetch(`${base}/messages`);
  const connectors = await fetch(`${base}/connectors`);
  assert.equal(connectors.status, messages.status);
  assert.notEqual(connectors.status, 404);
  assert.equal(await connectors.text(), await messages.clone().text());
  const work = await fetch(`${base}/my-work`);
  assert.equal(work.status, messages.status);
  assert.notEqual(work.status, 404);
  assert.equal(await work.text(), await messages.text());
});
