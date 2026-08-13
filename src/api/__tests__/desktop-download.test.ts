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
    "https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-arm64.dmg",
  );
  assert.equal(arm64.headers.get("cache-control"), "public, max-age=60, must-revalidate");

  const x64 = await fetch(`${baseUrl}/downloads/mac/x64`, { redirect: "manual" });
  assert.equal(x64.status, 302);
  assert.equal(
    x64.headers.get("location"),
    "https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-x64.dmg",
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

  const response = await fetch(`http://127.0.0.1:${address.port}/downloads/mac/v0.1.5/checksums`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  const body = await response.text();
  assert.match(body, /LetAgents for Mac beta v0\.1\.5/);
  assert.match(body, /LetAgents-0\.1\.5-darwin-arm64\.dmg/);
  assert.match(body, /LetAgents-0\.1\.5-darwin-x64\.dmg/);
  assert.match(body, /704355796cee5214a9cfbb79105a035e0e00dc3a3aa57be7d389b97cf35fc804/);
  assert.match(body, /1e4b0b8b2c42ad8eaaf652fc887ab089445c8dd83233d763a6acdaa6617c2471/);
});

test("previous immutable Mac beta checksum routes remain available", async (t) => {
  const app = express();
  registerDesktopDownloadRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  for (const version of ["0.1.4", "0.1.3", "0.1.2"]) {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/downloads/mac/v${version}/checksums`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /immutable/);
    const body = await response.text();
    assert.match(body, new RegExp(`LetAgents for Mac beta v${version.replaceAll(".", "\\.")}`));
    assert.match(body, new RegExp(`LetAgents-${version.replaceAll(".", "\\.")}-darwin-arm64\\.dmg`));
    assert.match(body, new RegExp(`LetAgents-${version.replaceAll(".", "\\.")}-darwin-x64\\.dmg`));
  }
});
