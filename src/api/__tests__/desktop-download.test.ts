import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import express from "express";

import {
  createCachedDesktopRedirectResolver,
  registerDesktopDownloadRoutes,
} from "../releases/desktop-download.js";

test("Mac beta redirect cache expires on its bounded TTL", async () => {
  let now = 1_000;
  let calls = 0;
  const resolve = createCachedDesktopRedirectResolver(
    async () => `https://objects.example/asset-${++calls}.dmg`,
    45_000,
    () => now,
  );

  assert.equal(await resolve("arm64"), "https://objects.example/asset-1.dmg");
  now += 44_999;
  assert.equal(await resolve("arm64"), "https://objects.example/asset-1.dmg");
  now += 1;
  assert.equal(await resolve("arm64"), "https://objects.example/asset-2.dmg");
  assert.equal(calls, 2);
});

test("Mac beta routes redirect only supported architectures", async (t) => {
  const app = express();
  let redirectCalls = 0;
  registerDesktopDownloadRoutes(app, {
    resolveRedirect: async (architecture) => {
      redirectCalls += 1;
      return `https://objects.example/${architecture}.dmg?signature=short-lived`;
    },
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const arm64 = await fetch(`${baseUrl}/downloads/mac/arm64`, { redirect: "manual" });
  assert.equal(arm64.status, 302);
  assert.equal(arm64.headers.get("location"), "https://objects.example/arm64.dmg?signature=short-lived");
  assert.equal(arm64.headers.get("cache-control"), "private, max-age=30");

  const cachedArm64 = await fetch(`${baseUrl}/downloads/mac/arm64`, { redirect: "manual" });
  assert.equal(cachedArm64.status, 302);
  assert.equal(redirectCalls, 1, "repeated downloads reuse the bounded server-side redirect cache");

  const x64 = await fetch(`${baseUrl}/downloads/mac/x64`, { redirect: "manual" });
  assert.equal(x64.status, 302);
  assert.equal(x64.headers.get("location"), "https://objects.example/x64.dmg?signature=short-lived");
  assert.equal(redirectCalls, 2, "architectures keep independent cache entries");

  const unsupported = await fetch(`${baseUrl}/downloads/mac/universal`, { redirect: "manual" });
  assert.equal(unsupported.status, 404);
});

test("concurrent Mac beta downloads coalesce one GitHub asset lookup", async (t) => {
  const app = express();
  let redirectCalls = 0;
  registerDesktopDownloadRoutes(app, {
    resolveRedirect: async () => {
      redirectCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "https://objects.example/arm64.dmg?signature=coalesced";
    },
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/downloads/mac/arm64`;

  const responses = await Promise.all([
    fetch(url, { redirect: "manual" }),
    fetch(url, { redirect: "manual" }),
    fetch(url, { redirect: "manual" }),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [302, 302, 302]);
  assert.equal(redirectCalls, 1);
});

test("Mac beta checksum route is public and names both signed DMGs", async (t) => {
  const app = express();
  registerDesktopDownloadRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/downloads/mac/v0.1.2/checksums`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  const body = await response.text();
  assert.match(body, /LetAgents for Mac beta v0\.1\.2/);
  assert.match(body, /LetAgents-0\.1\.2-darwin-arm64\.dmg/);
  assert.match(body, /LetAgents-0\.1\.2-darwin-x64\.dmg/);
  assert.match(body, /e5355deced8383bc7d024ec60b109a38dde69dfeb6b6339352e1f5bc5c53bd43/);
  assert.match(body, /67d2896b806695dae8c0224b3bc2780aee6902e897569c983ecc1bdb0330b6b0/);
});
