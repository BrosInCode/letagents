import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { desktopPlatformCapabilities } from "../main/platform-capabilities.js";

// Supervised agents on Windows reach the daemon from MCP workers that run
// the bundled npm runtime (electron/runtime/letagents), not this checkout's
// shared/ modules. letagents 0.12.48 and older open the daemon pipe with
// libuv's connect, which lets whatever serves the pipe impersonate the
// worker. Windows agents may be switched on only once the pinned runtime is a
// release whose client opens the pipe through letagents-daemon-pipe.node.
const LAST_MCP_WITHOUT_PIPE_ADDON_CLIENT = [0, 12, 48];

function version(text: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  assert.ok(match, `the bundled MCP runtime pins an exact version, not '${text}'`);
  return match.slice(1).map(Number);
}

function newer(left: number[], right: number[]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}

test("Windows agents stay off until the bundled MCP runtime opens the daemon pipe through the sealed addon", () => {
  const runtime = JSON.parse(readFileSync(new URL("../runtime/letagents/package.json", import.meta.url), "utf8")) as { dependencies: { letagents: string } };
  const pinned = version(runtime.dependencies.letagents);
  if (!desktopPlatformCapabilities({ platform: "win32", env: {} }).supervisedAgentsSupported) return;
  assert.ok(newer(pinned, LAST_MCP_WITHOUT_PIPE_ADDON_CLIENT),
    `letagents ${pinned.join(".")} opens the daemon pipe with libuv; pin a release with the daemon pipe addon client first`);
});
