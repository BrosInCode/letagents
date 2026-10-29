import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { removeDesktopSmokeUserData } from "../main/smoke.js";

test("smoke cleanup retries a held folder, then logs instead of throwing", () => {
  const calls: unknown[][] = [];
  const logged: string[] = [];
  removeDesktopSmokeUserData("C:\\smoke", ((...args: unknown[]) => {
    calls.push(args);
    throw Object.assign(new Error("EPERM, Permission denied"), { code: "EPERM" });
  }) as never, (message) => logged.push(message));
  assert.deepEqual(calls, [["C:\\smoke", { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }]]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /cleanup left C:\\smoke: EPERM/);
});

test("smoke cleanup removes the folder when nothing holds it", () => {
  const folder = mkdtempSync(join(tmpdir(), "letagents-smoke-cleanup-"));
  writeFileSync(join(folder, "state.json"), "{}");
  const logged: string[] = [];
  removeDesktopSmokeUserData(folder, undefined, (message) => logged.push(message));
  assert.deepEqual(logged, []);
  assert.throws(() => readFileSync(join(folder, "state.json")), /ENOENT/);
});

test("the smoke check follows the agents-off Add agent notice and never waits for the modal there", () => {
  const source = readFileSync(new URL("../main/window.ts", import.meta.url), "utf8");
  const branch = source.indexOf("if (!${JSON.stringify(agentsSupported)}) {");
  const modalWait = source.indexOf('await waitFor("add-agent modal"');
  assert.ok(branch > 0 && modalWait > branch, "the agents-off branch returns before the add-agent modal wait");
  const agentsOff = source.slice(branch, modalWait);
  assert.match(agentsOff, /desktop-add-agent-unavailable-modal/);
  assert.match(agentsOff, /supervised-agents-unavailable/);
  assert.match(agentsOff, /return agentsOff;/);
  assert.match(source, /const agentsSupported = supervisedAgentsSupported\(\);/);
});
