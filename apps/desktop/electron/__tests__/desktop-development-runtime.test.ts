import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface PackageManifest {
  scripts?: Record<string, string>;
}

function readManifest(url: URL): PackageManifest {
  return JSON.parse(readFileSync(url, "utf8")) as PackageManifest;
}

test("desktop development builds every runtime before starting its watchers and Electron", () => {
  const rootManifest = readManifest(new URL("../../../../package.json", import.meta.url));
  const desktopManifest = readManifest(new URL("../../package.json", import.meta.url));

  assert.equal(
    rootManifest.scripts?.["dev:desktop"],
    "npm ci --prefix apps/desktop && npm --prefix apps/desktop run dev",
  );
  assert.equal(
    desktopManifest.scripts?.dev,
    "npm run build:dev && concurrently -k \"npm:dev:renderer\" \"npm:watch:mcp\" \"npm:watch:electron\" \"npm:watch:daemon\" \"npm:serve:electron\"",
  );
  assert.equal(
    desktopManifest.scripts?.["build:dev"],
    "npm run build:mcp && npm run build:electron && npm run build:daemon",
  );
  assert.equal(desktopManifest.scripts?.["build:mcp"], "npm --prefix ../.. run build");
  assert.equal(
    desktopManifest.scripts?.["watch:mcp"],
    "tsc -p ../../tsconfig.json --watch --preserveWatchOutput",
  );
  assert.equal(
    desktopManifest.scripts?.["serve:electron"],
    "wait-on tcp:5174 ../../dist/mcp/server.js dist-electron/main.js dist-daemon/main.js && cross-env LETAGENTS_DESKTOP_DEV_SERVER_URL=http://127.0.0.1:5174 electron .",
  );
  assert.match(desktopManifest.scripts?.["test:electron"] ?? "", /--test-concurrency=1/);
});
