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

test("dependency advisory checks use the pinned supported audit client", () => {
  const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const releaseWorkflow = readFileSync(".github/workflows/desktop-release.yml", "utf8");

  assert.equal(
    (ciWorkflow.match(/npm install -g npm@11\.6\.2/g) ?? []).length,
    3,
    "each CI job that audits advisories must install the pinned npm client",
  );
  assert.equal(
    (releaseWorkflow.match(/npm install -g npm@11\.6\.2/g) ?? []).length,
    1,
    "the release build must install the pinned npm client",
  );

  const expectedCiAudits = [
    "node scripts/verify-dependency-advisories.mjs .",
    "node scripts/verify-dependency-advisories.mjs src/web",
    "node scripts/verify-dependency-advisories.mjs apps/desktop",
    "node scripts/verify-dependency-advisories.mjs .",
    "node scripts/verify-dependency-advisories.mjs .",
  ];
  const actualCiAudits = ciWorkflow.match(/node scripts\/verify-dependency-advisories\.mjs[^\n]*/g) ?? [];
  assert.deepEqual(actualCiAudits.map((command) => command.trim()), expectedCiAudits);
  assert.match(
    releaseWorkflow,
    /node scripts\/verify-dependency-advisories\.mjs \. apps\/desktop/,
  );

  for (const [path, workflow] of [
    [".github/workflows/ci.yml", ciWorkflow],
    [".github/workflows/desktop-release.yml", releaseWorkflow],
  ]) {
    assert.doesNotMatch(
      workflow,
      /npm audit --audit-level=low/,
      `${path} must not bypass the bounded audit runner`,
    );
  }
});
