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
const identitySource = read("../main/agents/cursor-identity.ts");
const launcherSource = read("../main/agents/cursor-turn-launcher.ts");
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
  assert.doesNotMatch(adapterSource, /const wrapperSource = String\.raw/);
  assert.doesNotMatch(adapterSource, /runCursorSandboxedInspection/);
  assert.doesNotMatch(adapterSource, /function validateCursorSandboxPaths/);

  assert.match(launcherSource, /const wrapperSource = String\.raw/);
  assert.equal(matches(launcherSource, /spawn\(process\.execPath/g).length, 2);
  assert.match(identitySource, /runCursorSandboxedInspection/);
  assert.match(identitySource, /\/aiserver\.v1\.DashboardService\/GetMe/);
  assert.match(sandboxSource, /export function validateCursorSandboxPaths/);
  assert.match(sandboxSource, /export function cursorSandboxRuntimeReadSubpaths/);
});

test("extracted Cursor domains do not import the adapter state machine", () => {
  for (const source of [identitySource, launcherSource, sandboxSource]) {
    assert.doesNotMatch(source, /from "\.\/cursor-provider-adapter\.js"/);
  }
});

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function matches(source: string, pattern: RegExp): RegExpMatchArray[] {
  return [...source.matchAll(pattern)];
}
