import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/desktop-release.yml",
];

function workflowRunScriptsFromText(workflow) {
  const lines = workflow.split("\n");
  const scripts = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) {
      continue;
    }

    const runIndent = match[1].length;
    const inlineCommand = match[2].trim();
    if (inlineCommand && !/^[>|]/.test(inlineCommand)) {
      scripts.push(inlineCommand);
      continue;
    }

    const blockCommands = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.match(/^\s*/)[0].length <= runIndent) {
        index -= 1;
        break;
      }
      const command = line.trim();
      if (command && !command.startsWith("#")) {
        blockCommands.push(command);
      }
    }
    scripts.push(blockCommands.join("\n"));
  }

  return scripts;
}

function workflowRunScripts(path) {
  return workflowRunScriptsFromText(readFileSync(path, "utf8"));
}

function containsDirectNpmAudit(script) {
  const withoutShellComments = script.replace(/\s+#.*$/gm, "");
  return /(?:^|(?:&&|\|\||[;|])\s*|\n\s*)npm\b[^\n;&|]*\s+audit(?:\s|$)/m.test(
    withoutShellComments,
  );
}

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

test("workflow policy inspects whole run scripts instead of matching comments", () => {
  const scripts = workflowRunScriptsFromText(`
steps:
  - run: echo audit-disabled # node scripts/verify-dependency-advisories.mjs .
  - run: |
      npm --prefix apps/desktop audit --audit-level='low'
  - run: |
      if false; then
        node scripts/verify-dependency-advisories.mjs .
      fi
  - run: npm --prefix apps/desktop audit
`);

  assert.deepEqual(scripts, [
    "echo audit-disabled # node scripts/verify-dependency-advisories.mjs .",
    "npm --prefix apps/desktop audit --audit-level='low'",
    "if false; then\nnode scripts/verify-dependency-advisories.mjs .\nfi",
    "npm --prefix apps/desktop audit",
  ]);
  assert.equal(
    scripts.filter((script) =>
      script.startsWith("node scripts/verify-dependency-advisories.mjs"),
    ).length,
    0,
  );
  assert.match(scripts[1].replace(/["']/g, ""), /--audit-level(?:=|\s+)low\b/);
  assert.deepEqual(scripts.filter(containsDirectNpmAudit), [scripts[1], scripts[3]]);
});

test("dependency advisory checks use the pinned supported audit client", () => {
  const ciScripts = workflowRunScripts(".github/workflows/ci.yml");
  const releaseScripts = workflowRunScripts(".github/workflows/desktop-release.yml");

  assert.equal(
    ciScripts.filter((script) => script === "npm install -g npm@11.6.2").length,
    1,
    "only the publishing job should globally replace npm",
  );
  assert.equal(
    ciScripts.filter(
      (script) =>
        script ===
        'npm install --global --ignore-scripts --prefix "${RUNNER_TEMP}/dependency-audit-npm" npm@11.6.2\necho "LETAGENTS_AUDIT_NPM_BIN=${RUNNER_TEMP}/dependency-audit-npm/bin/npm" >> "${GITHUB_ENV}"',
    ).length,
    2,
    "build and integration jobs must install isolated pinned audit clients",
  );
  assert.equal(
    releaseScripts.filter(
      (script) =>
        script ===
        'npm install --global --ignore-scripts --prefix "${RUNNER_TEMP}/dependency-audit-npm" npm@11.6.2\necho "LETAGENTS_AUDIT_NPM_BIN=${RUNNER_TEMP}/dependency-audit-npm/bin/npm" >> "${GITHUB_ENV}"',
    ).length,
    1,
    "the release build must install an isolated pinned audit client",
  );

  const expectedCiAudits = [
    "node scripts/verify-dependency-advisories.mjs .",
    "node scripts/verify-dependency-advisories.mjs src/web",
    "node scripts/verify-dependency-advisories.mjs apps/desktop",
    "node scripts/verify-dependency-advisories.mjs .",
    "node scripts/verify-dependency-advisories.mjs .",
  ];
  const actualCiAudits = ciScripts.filter((script) =>
    script.startsWith("node scripts/verify-dependency-advisories.mjs"),
  );
  assert.deepEqual(actualCiAudits, expectedCiAudits);
  assert.deepEqual(
    releaseScripts.filter((script) =>
      script.startsWith("node scripts/verify-dependency-advisories.mjs"),
    ),
    ["node scripts/verify-dependency-advisories.mjs . apps/desktop"],
  );

  assert.deepEqual(ciScripts.filter(containsDirectNpmAudit), [
    "npm audit signatures",
    "cd src/web && npm audit signatures",
    "npm audit signatures --prefix apps/desktop",
    "npm audit signatures",
    "npm audit signatures",
  ]);
  assert.deepEqual(releaseScripts.filter(containsDirectNpmAudit), [
    "npm audit signatures\nnpm audit signatures --prefix apps/desktop",
  ]);
});
