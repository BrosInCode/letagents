import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/desktop-release.yml",
];

function workflowRunCommandsFromText(workflow) {
  const lines = workflow.split("\n");
  const commands = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) {
      continue;
    }

    const runIndent = match[1].length;
    const inlineCommand = match[2].trim();
    if (inlineCommand && !/^[>|]/.test(inlineCommand)) {
      commands.push(inlineCommand);
      continue;
    }

    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.match(/^\s*/)[0].length <= runIndent) {
        index -= 1;
        break;
      }
      const command = line.trim();
      if (command && !command.startsWith("#")) {
        commands.push(command);
      }
    }
  }

  return commands;
}

function workflowRunCommands(path) {
  return workflowRunCommandsFromText(readFileSync(path, "utf8"));
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

test("workflow policy inspects commands instead of matching comments", () => {
  const commands = workflowRunCommandsFromText(`
steps:
  - run: echo audit-disabled # node scripts/verify-dependency-advisories.mjs .
  - run: |
      npm --prefix apps/desktop audit --audit-level=low
`);

  assert.deepEqual(commands, [
    "echo audit-disabled # node scripts/verify-dependency-advisories.mjs .",
    "npm --prefix apps/desktop audit --audit-level=low",
  ]);
  assert.equal(
    commands.filter((command) =>
      command.startsWith("node scripts/verify-dependency-advisories.mjs"),
    ).length,
    0,
  );
  assert.match(commands[1], /--audit-level(?:=|\s+)low\b/);
});

test("dependency advisory checks use the pinned supported audit client", () => {
  const ciCommands = workflowRunCommands(".github/workflows/ci.yml");
  const releaseCommands = workflowRunCommands(".github/workflows/desktop-release.yml");

  assert.equal(
    ciCommands.filter((command) => command === "npm install -g npm@11.6.2").length,
    1,
    "only the publishing job should globally replace npm",
  );
  assert.equal(
    ciCommands.filter(
      (command) =>
        command ===
        'npm install --global --ignore-scripts --prefix "${RUNNER_TEMP}/dependency-audit-npm" npm@11.6.2',
    ).length,
    2,
    "build and integration jobs must install isolated pinned audit clients",
  );
  assert.equal(
    releaseCommands.filter(
      (command) =>
        command ===
        'npm install --global --ignore-scripts --prefix "${RUNNER_TEMP}/dependency-audit-npm" npm@11.6.2',
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
  const actualCiAudits = ciCommands.filter((command) =>
    command.startsWith("node scripts/verify-dependency-advisories.mjs"),
  );
  assert.deepEqual(actualCiAudits, expectedCiAudits);
  assert.deepEqual(
    releaseCommands.filter((command) =>
      command.startsWith("node scripts/verify-dependency-advisories.mjs"),
    ),
    ["node scripts/verify-dependency-advisories.mjs . apps/desktop"],
  );

  for (const [path, commands] of [
    [".github/workflows/ci.yml", ciCommands],
    [".github/workflows/desktop-release.yml", releaseCommands],
  ]) {
    for (const command of commands) {
      assert.doesNotMatch(
        command,
        /--audit-level(?:=|\s+)low\b/,
        `${path} must not bypass the bounded audit runner: ${command}`,
      );
    }
  }
});
