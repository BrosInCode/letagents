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
    { method: "get", path: ["/inbox", "/messages", "/my-work", "/connectors"] },
    { method: "get", path: /^\/ask\/[A-Za-z0-9_-]{20,64}$/ },
    { method: "get", path: "/join/:organizationId" },
    { method: "get", path: "/app" },
  ]);
});


test("Inbox, My Work and Connectors direct navigation and sign-in return load the same SPA as Messages", async (t) => {
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
  assert.equal(await work.text(), await messages.clone().text());
  // A direct load of /inbox returned Express's "Cannot GET /inbox" before the
  // route was listed, although the in-app Inbox link routed there client-side.
  const inbox = await fetch(`${base}/inbox`);
  assert.equal(inbox.status, messages.status);
  assert.notEqual(inbox.status, 404);
  assert.equal(await inbox.text(), await messages.text());
});

test("every static page of the web router is served by the API on a direct load", async (t) => {
  // The web router and the server's page list are kept by hand. /inbox was
  // added to the router alone (#1838), so a reload of it returned 404. Read
  // the router source and load each static page through the real handlers.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../web/src/router.ts", import.meta.url), "utf8");
  // Commented-out routes are not pages. Pages with a `:param` are served by
  // their own server routes and are not covered here.
  const router = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const pages = [...router.matchAll(/\bpath:\s*(['"])(\/[^'"]*)\1/g)].map(match => match[2])
    .filter(page => !page.includes(":"));
  assert.ok(pages.includes("/") && pages.length >= 4, `router pages: ${pages.join(", ")}`);
  const { default: express } = await import("express");
  const app = express();
  app.use((_req, res, next) => {
    res.sendFile = ((_path: string) => res.status(200).send("Vue SPA")) as typeof res.sendFile;
    next();
  });
  registerWebRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const { port } = server.address() as { port: number };
  // Without a Vue build the handler answers 503 for every page, so compare
  // each page with the root rather than with a fixed status.
  const root = await fetch(`http://127.0.0.1:${port}/`);
  const expected = await root.text();
  for (const page of pages) {
    const response = await fetch(`http://127.0.0.1:${port}${page}`);
    assert.notEqual(response.status, 404, `${page} must serve the web app on a direct load`);
    assert.equal(response.status, root.status, page);
    assert.equal(await response.text(), expected, page);
  }
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
