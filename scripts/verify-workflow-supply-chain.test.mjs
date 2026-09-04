import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/desktop-release.yml",
];

function readRunScript(lines, startIndex, runIndent, inlineValue) {
  const inlineScript = inlineValue.trim();
  if (inlineScript && !/^[>|]/.test(inlineScript)) {
    return { nextIndex: startIndex, script: inlineScript };
  }

  const blockCommands = [];
  let index = startIndex + 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.match(/^\s*/)[0].length <= runIndent) {
      break;
    }
    const command = line.trim();
    if (command && !command.startsWith("#")) {
      blockCommands.push(command);
    }
  }
  return { nextIndex: index - 1, script: blockCommands.join("\n") };
}

function workflowJobsFromText(workflow) {
  const lines = workflow.split("\n");
  const jobs = [];
  let insideJobs = false;
  let currentJob = null;
  let currentStep = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^jobs:\s*$/.test(line)) {
      insideJobs = true;
      continue;
    }
    if (!insideJobs) {
      continue;
    }

    const jobMatch = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/);
    if (jobMatch) {
      currentJob = {
        condition: null,
        continueOnError: null,
        name: jobMatch[1],
        steps: [],
      };
      jobs.push(currentJob);
      currentStep = null;
      continue;
    }
    if (!currentJob) {
      continue;
    }

    const jobCondition = line.match(/^ {4}if:\s*(.+)$/);
    if (jobCondition) {
      currentJob.condition = jobCondition[1].trim();
      continue;
    }
    const jobContinueOnError = line.match(/^ {4}continue-on-error:\s*(.+)$/);
    if (jobContinueOnError) {
      currentJob.continueOnError = jobContinueOnError[1].trim();
      continue;
    }

    const stepMatch = line.match(/^ {6}-\s+(name|run|uses):\s*(.*)$/);
    if (stepMatch) {
      currentStep = {
        condition: null,
        continueOnError: null,
        name: stepMatch[1] === "name" ? stepMatch[2].trim() : null,
        run: null,
      };
      currentJob.steps.push(currentStep);
      if (stepMatch[1] === "run") {
        const result = readRunScript(lines, index, 6, stepMatch[2]);
        currentStep.run = result.script;
        index = result.nextIndex;
      }
      continue;
    }
    if (!currentStep) {
      continue;
    }

    const stepName = line.match(/^ {8}name:\s*(.+)$/);
    if (stepName) {
      currentStep.name = stepName[1].trim();
      continue;
    }
    const stepCondition = line.match(/^ {8}if:\s*(.+)$/);
    if (stepCondition) {
      currentStep.condition = stepCondition[1].trim();
      continue;
    }
    const stepContinueOnError = line.match(/^ {8}continue-on-error:\s*(.+)$/);
    if (stepContinueOnError) {
      currentStep.continueOnError = stepContinueOnError[1].trim();
      continue;
    }
    const stepRun = line.match(/^ {8}run:\s*(.*)$/);
    if (stepRun) {
      const result = readRunScript(lines, index, 8, stepRun[1]);
      currentStep.run = result.script;
      index = result.nextIndex;
    }
  }

  return jobs;
}

function workflowJobs(path) {
  return workflowJobsFromText(readFileSync(path, "utf8"));
}

function workflowRunScripts(jobs) {
  return jobs.flatMap((job) => job.steps.map((step) => step.run).filter(Boolean));
}

function containsDirectNpmAudit(script) {
  const withoutShellComments = script.replace(/\s+#.*$/gm, "");
  return withoutShellComments
    .split(/&&|\|\||[;|\n]/)
    .some((segment) => {
      const tokens = segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
      const normalized = tokens.map((token) => token.replace(/^["']|["']$/g, ""));
      const npmIndex = normalized.indexOf("npm");
      return npmIndex >= 0 && normalized.slice(npmIndex + 1).includes("audit");
    });
}

function assertAuditStepsAreMandatory(jobs, workflowPath) {
  for (const job of jobs) {
    const auditSteps = job.steps.filter(
      (step) =>
        step.run &&
        (step.run.startsWith("node scripts/verify-dependency-advisories.mjs") ||
          containsDirectNpmAudit(step.run)),
    );
    if (auditSteps.length === 0) {
      continue;
    }

    const publishJob = job.name === "npm-publish";
    assert.equal(
      job.condition,
      publishJob ? "github.ref == 'refs/heads/staging'" : null,
      `${workflowPath}:${job.name} must not skip dependency gates`,
    );
    assert.ok(
      job.continueOnError === null || job.continueOnError === "false",
      `${workflowPath}:${job.name} must fail when a dependency gate fails`,
    );

    for (const step of auditSteps) {
      assert.equal(
        step.condition,
        publishJob ? "steps.version.outputs.publish == 'true'" : null,
        `${workflowPath}:${job.name}:${step.name ?? "unnamed"} must not skip its audit`,
      );
      assert.ok(
        step.continueOnError === null || step.continueOnError === "false",
        `${workflowPath}:${job.name}:${step.name ?? "unnamed"} must fail the job`,
      );
    }
  }
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
  const jobs = workflowJobsFromText(`
jobs:
  build:
    steps:
      - run: echo audit-disabled # node scripts/verify-dependency-advisories.mjs .
      - run: |
          npm --prefix apps/desktop audit --audit-level='low'
      - run: |
          if false; then
            node scripts/verify-dependency-advisories.mjs .
          fi
      - run: if true; then npm --prefix apps/desktop audit; fi
      - name: Disabled audit step
        if: false
        continue-on-error: true
        run: node scripts/verify-dependency-advisories.mjs .
`);
  const scripts = workflowRunScripts(jobs);

  assert.deepEqual(scripts, [
    "echo audit-disabled # node scripts/verify-dependency-advisories.mjs .",
    "npm --prefix apps/desktop audit --audit-level='low'",
    "if false; then\nnode scripts/verify-dependency-advisories.mjs .\nfi",
    "if true; then npm --prefix apps/desktop audit; fi",
    "node scripts/verify-dependency-advisories.mjs .",
  ]);
  assert.equal(scripts[2].startsWith("node scripts/verify-dependency-advisories.mjs"), false);
  assert.match(scripts[1].replace(/["']/g, ""), /--audit-level(?:=|\s+)low\b/);
  assert.deepEqual(scripts.filter(containsDirectNpmAudit), [scripts[1], scripts[3]]);
  assert.throws(() => assertAuditStepsAreMandatory(jobs, "fixture"), /must not skip/);
});

test("dependency advisory gates cannot be skipped or made non-blocking", () => {
  const mutations = [
    { job: "if: false", expected: /must not skip dependency gates/ },
    { job: "continue-on-error: true", expected: /must fail when a dependency gate fails/ },
    { step: "if: false", expected: /must not skip its audit/ },
    { step: "continue-on-error: true", expected: /must fail the job/ },
  ];

  for (const mutation of mutations) {
    const jobSetting = mutation.job ? `    ${mutation.job}\n` : "";
    const stepSetting = mutation.step ? `        ${mutation.step}\n` : "";
    const jobs = workflowJobsFromText(`
jobs:
  build:
${jobSetting}    steps:
      - name: Audit dependencies
${stepSetting}        run: node scripts/verify-dependency-advisories.mjs .
`);

    assert.throws(() => assertAuditStepsAreMandatory(jobs, "fixture"), mutation.expected);
  }
});

test("dependency advisory checks use the pinned supported audit client", () => {
  const ciJobs = workflowJobs(".github/workflows/ci.yml");
  const releaseJobs = workflowJobs(".github/workflows/desktop-release.yml");
  const ciScripts = workflowRunScripts(ciJobs);
  const releaseScripts = workflowRunScripts(releaseJobs);

  assertAuditStepsAreMandatory(ciJobs, ".github/workflows/ci.yml");
  assertAuditStepsAreMandatory(releaseJobs, ".github/workflows/desktop-release.yml");

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
