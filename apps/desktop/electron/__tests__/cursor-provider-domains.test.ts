import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCursorPersonalIdentity as facadeAssertCursorPersonalIdentity,
  cursorCliEnv as facadeCursorCliEnv,
  CursorIdentityAuthRequiredError as FacadeCursorIdentityAuthRequiredError,
  CursorTeamManagedIdentityError as FacadeCursorTeamManagedIdentityError,
  defaultLaunchTurn as facadeDefaultLaunchTurn,
} from "../main/agents/cursor-provider-adapter.js";
import {
  assertCursorPersonalIdentity,
  CursorIdentityAuthRequiredError,
  CursorTeamManagedIdentityError,
} from "../main/agents/cursor-identity.js";
import {
  cursorCliEnv,
  defaultLaunchTurn,
} from "../main/agents/cursor-turn-launcher.js";

const adapterSource = read("../main/agents/cursor-provider-adapter.ts");
// The adapter state machine is split across these cursor/ modules.
const adapterModuleSources = [
  "dependencies", "lane-state", "launch-arguments", "provider-adapter", "room-turn", "stream-events",
  "supervised-turn-preparation", "turn-completion", "turn-control", "turn-launch", "turn-process",
  "turn-recovery", "workspace-generation",
].map((name) => read(`../main/agents/cursor/${name}.ts`));
const identitySource = read("../main/agents/cursor-identity.ts");
// The launcher composes its wrapper program from ordered cursor/ slices.
const launcherSource = [
  "turn-launcher", "turn-wrapper-setup", "turn-wrapper-mcp", "turn-wrapper-proxies", "turn-wrapper-start",
].map((name) => read(`../main/agents/cursor/${name}.ts`)).join("\n");
const sandboxSource = read("../main/agents/cursor-sandbox-policy.ts");

test("Cursor's public adapter facade preserves the extracted runtime identities", () => {
  assert.equal(facadeAssertCursorPersonalIdentity, assertCursorPersonalIdentity);
  assert.equal(FacadeCursorIdentityAuthRequiredError, CursorIdentityAuthRequiredError);
  assert.equal(FacadeCursorTeamManagedIdentityError, CursorTeamManagedIdentityError);
  assert.equal(facadeCursorCliEnv, cursorCliEnv);
  assert.equal(facadeDefaultLaunchTurn, defaultLaunchTurn);
});

test("Cursor native launch, identity, and sandbox authority remain bounded domains", () => {
  assert.ok(adapterSource.split("\n").length < 3_500);
  for (const source of [adapterSource, ...adapterModuleSources]) {
    assert.ok(source.split("\n").length < 900);
    assert.doesNotMatch(source, /const wrapperSource = String\.raw/);
    assert.doesNotMatch(source, /runCursorSandboxedInspection/);
    assert.doesNotMatch(source, /function validateCursorSandboxPaths/);
  }

  assert.match(launcherSource, /const wrapperSource = String\.raw/);
  assert.equal(matches(launcherSource, /spawn\(process\.execPath/g).length, 2);
  assert.match(identitySource, /runCursorSandboxedInspection/);
  assert.match(identitySource, /\/aiserver\.v1\.DashboardService\/GetMe/);
  assert.match(sandboxSource, /export function validateCursorSandboxPaths/);
  assert.match(sandboxSource, /export function cursorSandboxRuntimeReadSubpaths/);
});

test("extracted Cursor domains do not import the adapter state machine", () => {
  for (const source of [identitySource, launcherSource, sandboxSource]) {
    assert.doesNotMatch(source, /from "\.\.?\/cursor-provider-adapter\.js"/);
  }
  // The launcher now sits beside the adapter modules in cursor/.
  assert.doesNotMatch(launcherSource, /from "\.\/(provider-adapter|index)\.js"/);
});

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function matches(source: string, pattern: RegExp): RegExpMatchArray[] {
  return [...source.matchAll(pattern)];
}
