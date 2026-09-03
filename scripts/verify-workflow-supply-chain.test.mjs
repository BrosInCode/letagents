import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/desktop-release.yml",
];

test("external GitHub Actions are pinned to immutable commits", () => {
  for (const path of workflowPaths) {
    const workflow = readFileSync(path, "utf8");
    const externalUses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/gm)]
      .map((match) => ({ reference: match[1], versionComment: match[2] ?? "" }))
      .filter(({ reference }) => !reference.startsWith("./"));

    assert.ok(externalUses.length > 0, `${path} should contain external actions`);
    for (const { reference, versionComment } of externalUses) {
      assert.match(reference, /@[0-9a-f]{40}$/, `${reference} must use a full commit SHA`);
      assert.match(versionComment, /^v\d/, `${reference} must retain its readable release version`);
    }
  }
});

test("the OIDC publishing job never bootstraps mutable npm latest", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.doesNotMatch(workflow, /npm(?:@|\s+).*latest/);
  assert.match(workflow, /npm install -g npm@11\.6\.2/);
});

test("dependency advisory checks use lockfiles instead of the retired quick-audit endpoint", () => {
  for (const path of workflowPaths) {
    const workflow = readFileSync(path, "utf8");
    const advisoryCommands = workflow.match(/npm audit --audit-level=low[^\n]*/g) ?? [];
    assert.ok(advisoryCommands.length > 0, `${path} should audit dependency advisories`);
    for (const command of advisoryCommands) {
      assert.match(command, /--package-lock-only\b/, `${path}: ${command.trim()} must audit its lockfile`);
    }
  }
});
