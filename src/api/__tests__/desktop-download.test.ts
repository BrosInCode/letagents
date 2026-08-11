import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import express from "express";

import { registerDesktopDownloadRoutes } from "../releases/desktop-download.js";

test("Mac beta routes redirect supported architectures directly to public R2 assets", async (t) => {
  const app = express();
  registerDesktopDownloadRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const arm64 = await fetch(`${baseUrl}/downloads/mac/arm64`, { redirect: "manual" });
  assert.equal(arm64.status, 302);
  assert.equal(
    arm64.headers.get("location"),
    "https://downloads.letagents.chat/desktop/v0.1.3/LetAgents-0.1.3-darwin-arm64.dmg",
  );
  assert.equal(arm64.headers.get("cache-control"), "public, max-age=60, must-revalidate");

  const x64 = await fetch(`${baseUrl}/downloads/mac/x64`, { redirect: "manual" });
  assert.equal(x64.status, 302);
  assert.equal(
    x64.headers.get("location"),
    "https://downloads.letagents.chat/desktop/v0.1.3/LetAgents-0.1.3-darwin-x64.dmg",
  );

  const unsupported = await fetch(`${baseUrl}/downloads/mac/universal`, { redirect: "manual" });
  assert.equal(unsupported.status, 404);
});

test("Mac beta checksum route is public and names both signed DMGs", async (t) => {
  const app = express();
  registerDesktopDownloadRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/downloads/mac/v0.1.3/checksums`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  const body = await response.text();
  assert.match(body, /LetAgents for Mac beta v0\.1\.3/);
  assert.match(body, /LetAgents-0\.1\.3-darwin-arm64\.dmg/);
  assert.match(body, /LetAgents-0\.1\.3-darwin-x64\.dmg/);
  assert.match(body, /6010454bc7375a38571d707f90c077207a7d2b49b01a1db1655b03f4def9b502/);
  assert.match(body, /b7574e17ef87aebf418926478de10d9937fd1a96ca0c7a53b826a109302c5560/);
});

test("previous immutable Mac beta checksum routes remain available", async (t) => {
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
