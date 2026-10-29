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
    if (command) {
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

    const jobMatch = line.match(/^ {2}([a-zA-Z0-9_-]+)\s*:\s*$/);
    if (jobMatch) {
      currentJob = {
        condition: null,
        continueOnError: null,
        name: jobMatch[1],
        needs: [],
        steps: [],
      };
      jobs.push(currentJob);
      currentStep = null;
      continue;
    }
    if (!currentJob) {
      continue;
    }

    const jobCondition = line.match(/^ {4}if\s*:\s*(.+)$/);
    if (jobCondition) {
      currentJob.condition = jobCondition[1].trim();
      continue;
    }
    const jobNeeds = line.match(/^ {4}needs\s*:\s*(.+)$/);
    if (jobNeeds) {
      currentJob.needs = jobNeeds[1].replace(/^\[|\]$/g, "").split(",").map((need) => need.trim()).filter(Boolean);
      continue;
    }
    const jobContinueOnError = line.match(/^ {4}continue-on-error\s*:\s*(.+)$/);
    if (jobContinueOnError) {
      currentJob.continueOnError = jobContinueOnError[1].trim();
      continue;
    }

    const stepMatch = line.match(/^ {6}-\s+([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (stepMatch) {
      currentStep = {
        condition: null,
        continueOnError: null,
        name: null,
        run: null,
        shell: null,
      };
      currentJob.steps.push(currentStep);
      const [key, value] = stepMatch.slice(1);
      if (key === "name") {
        currentStep.name = value.trim();
      } else if (key === "if") {
        currentStep.condition = value.trim();
      } else if (key === "continue-on-error") {
        currentStep.continueOnError = value.trim();
      } else if (key === "run") {
        const result = readRunScript(lines, index, 6, value);
        currentStep.run = result.script;
        index = result.nextIndex;
      } else if (key === "shell") {
        currentStep.shell = value.trim();
      }
      continue;
    }
    if (!currentStep) {
      continue;
    }

    const stepName = line.match(/^ {8}name\s*:\s*(.+)$/);
    if (stepName) {
      currentStep.name = stepName[1].trim();
      continue;
    }
    const stepCondition = line.match(/^ {8}if\s*:\s*(.+)$/);
    if (stepCondition) {
      currentStep.condition = stepCondition[1].trim();
      continue;
    }
    const stepContinueOnError = line.match(/^ {8}continue-on-error\s*:\s*(.+)$/);
    if (stepContinueOnError) {
      currentStep.continueOnError = stepContinueOnError[1].trim();
      continue;
    }
    const stepShell = line.match(/^ {8}shell\s*:\s*(.+)$/);
    if (stepShell) {
      currentStep.shell = stepShell[1].trim();
      continue;
    }
    const stepRun = line.match(/^ {8}run\s*:\s*(.*)$/);
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

function containsDirectNpmSubcommand(script, subcommand) {
  const conservativeScript = script
    .replace(/\\\r?\n\s*/g, "")
    .replace(/["'\\]/g, "");
  return conservativeScript
    .split(/&&|\|\||[;|\n]/)
    .some((segment) => {
      const tokens = segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
      const normalized = tokens.map((token) => token.replace(/^["']|["']$/g, ""));
      const npmIndex = normalized.findIndex((token) => {
        const executable = token.replace(
          /^[^a-zA-Z0-9_./-]+|[^a-zA-Z0-9_./-]+$/g,
          "",
        );
        return executable.split("/").at(-1) === "npm";
      });
      return npmIndex >= 0 && normalized.slice(npmIndex + 1).includes(subcommand);
    });
}

function containsDirectNpmAudit(script) {
  return containsDirectNpmSubcommand(script, "audit");
}

function containsDirectNpmCi(script) {
  return containsDirectNpmSubcommand(script, "ci");
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
      workflowPath === ".github/workflows/ci.yml"
        ? publishJob ? "github.ref == 'refs/heads/staging' && inputs.purpose != 'room-ack-evaluation'"
          : job.name === "room-ack-evaluation"
            ? "github.event_name == 'workflow_dispatch' && inputs.purpose == 'room-ack-evaluation'"
            : "inputs.purpose != 'room-ack-evaluation'"
        : publishJob ? "github.ref == 'refs/heads/staging'" : null,
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
      assert.equal(
        step.shell,
        null,
        `${workflowPath}:${job.name}:${step.name ?? "unnamed"} must use the default shell`,
      );
    }
  }
}

function assertNoWorkflowRunDefaults(workflow, workflowPath) {
  assert.doesNotMatch(
    workflow,
    /^\s*defaults\s*:/m,
    `${workflowPath} must not override the shell inherited by dependency gates`,
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
      - run: echo "registry # diagnostic"; npm --prefix apps/desktop audit
      - run: |
          echo prefix\\
          #; npm audit --audit-level=low
      - run: echo prefix\\ #; npm audit --audit-level=low
      - run: npm a""udit --audit-level=low
      - run: |
          npm \\
            audit --audit-level=low
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
    'echo "registry # diagnostic"; npm --prefix apps/desktop audit',
    "echo prefix\\\n#; npm audit --audit-level=low",
    "echo prefix\\ #; npm audit --audit-level=low",
    'npm a""udit --audit-level=low',
    "npm \\\naudit --audit-level=low",
    "node scripts/verify-dependency-advisories.mjs .",
  ]);
  assert.equal(scripts[2].startsWith("node scripts/verify-dependency-advisories.mjs"), false);
  assert.match(scripts[1].replace(/["']/g, ""), /--audit-level(?:=|\s+)low\b/);
  assert.deepEqual(scripts.filter(containsDirectNpmAudit), [
    scripts[1],
    scripts[3],
    scripts[4],
    scripts[5],
    scripts[6],
    scripts[7],
    scripts[8],
  ]);
  assert.equal(containsDirectNpmCi("npm --prefix . ci --ignore-scripts --audit"), true);
  assert.equal(containsDirectNpmCi("/usr/local/bin/npm ci --no-audit"), true);
  assert.equal(containsDirectNpmCi("$(command -v npm) ci --no-audit"), true);
  assert.equal(containsDirectNpmCi("npm --prefix . install --ignore-scripts"), false);
  assert.throws(() => assertAuditStepsAreMandatory(jobs, "fixture"), /must not skip/);
});

test("dependency advisory gates cannot be skipped or made non-blocking", () => {
  const mutations = [
    { job: "if: false", expected: /must not skip dependency gates/ },
    { job: "if : false", expected: /must not skip dependency gates/ },
    { job: "continue-on-error: true", expected: /must fail when a dependency gate fails/ },
    { step: "if: false", expected: /must not skip its audit/ },
    { step: "if : false", expected: /must not skip its audit/ },
    { step: "continue-on-error: true", expected: /must fail the job/ },
    { step: "shell: true {0}", expected: /must use the default shell/ },
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

  const leadingCondition = workflowJobsFromText(`
jobs:
  build:
    steps:
      - run: echo before
      - if : false
        run: node scripts/verify-dependency-advisories.mjs .
`);
  assert.throws(
    () => assertAuditStepsAreMandatory(leadingCondition, "fixture"),
    /must not skip its audit/,
  );
});

test("dependency advisory checks use the pinned supported audit client", () => {
  const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const releaseWorkflow = readFileSync(".github/workflows/desktop-release.yml", "utf8");
  const ciJobs = workflowJobs(".github/workflows/ci.yml");
  const releaseJobs = workflowJobs(".github/workflows/desktop-release.yml");
  const ciScripts = workflowRunScripts(ciJobs);
  const releaseScripts = workflowRunScripts(releaseJobs);

  assertNoWorkflowRunDefaults(ciWorkflow, ".github/workflows/ci.yml");
  assertNoWorkflowRunDefaults(releaseWorkflow, ".github/workflows/desktop-release.yml");
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
    "only the dependency-audit and evaluator jobs may install isolated pinned audit clients",
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
    "node scripts/verify-dependency-advisories.mjs apps/desktop apps/desktop/electron/runtime/letagents",
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
    ["node scripts/verify-dependency-advisories.mjs . apps/desktop apps/desktop/electron/runtime/letagents"],
  );

  assert.deepEqual(ciScripts.filter(containsDirectNpmAudit), [
    "node scripts/retry-command.mjs npm audit signatures",
    "cd src/web && node ../../scripts/retry-command.mjs npm audit signatures",
    "node scripts/retry-command.mjs npm audit signatures --prefix apps/desktop",
    "node scripts/retry-command.mjs npm audit signatures",
    "node scripts/retry-command.mjs npm audit signatures --prefix apps/desktop",
    "node scripts/retry-command.mjs npm audit signatures",
    "node scripts/retry-command.mjs npm audit signatures --prefix apps/desktop",
    "node scripts/retry-command.mjs npm audit signatures",
    "node scripts/retry-command.mjs npm audit signatures",
  ]);
  assert.deepEqual(releaseScripts.filter(containsDirectNpmAudit), [
    "node scripts/retry-command.mjs npm audit signatures\nnode scripts/retry-command.mjs npm audit signatures --prefix apps/desktop",
    // build-windows: one tree per step, each right after its install.
    "node scripts/retry-command.mjs npm audit signatures",
    "node scripts/retry-command.mjs npm audit signatures --prefix apps/desktop",
  ]);

  assert.deepEqual(
    ciScripts.filter(containsDirectNpmCi),
    [
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit",
      "cd src/web && node ../../scripts/retry-command.mjs npm ci --ignore-scripts --no-audit",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit --prefix apps/desktop",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit",
      "cd src/web && node ../../scripts/retry-command.mjs npm ci --ignore-scripts --no-audit",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit --prefix apps/desktop",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit\nnode scripts/retry-command.mjs npm ci --ignore-scripts --no-audit --prefix apps/desktop",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit --prefix apps/desktop",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit --prefix apps/desktop",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit",
    ],
    "CI installs must disable npm's implicit unbounded audit",
  );
  assert.deepEqual(
    releaseScripts.filter(containsDirectNpmCi),
    [
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit\n" +
        "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit --prefix apps/desktop",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit",
      "node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit --prefix apps/desktop",
    ],
    "release installs must disable npm's implicit unbounded audit",
  );
});

test("the Windows release build verifies each tree it installs before anything runs it", () => {
  const jobs = workflowJobs(".github/workflows/desktop-release.yml");
  const windows = jobs.find((candidate) => candidate.name === "build-windows");
  assert.ok(windows, "desktop-release.yml must build Windows");
  // The macOS builds run the lockfile gates (cooldown, advisories) first.
  assert.deepEqual(windows.needs, ["build-macos"]);
  const steps = windows.steps;
  const lifecycle = steps.findIndex((step) => step.name === "Run verified dependency lifecycle scripts");
  assert.ok(lifecycle > 0, "build-windows must run lifecycle scripts only after verification");
  const checks = steps.filter((step) => containsDirectNpmAudit(step.run ?? ""));
  assert.equal(checks.length, 2);
  for (const step of checks) {
    const index = steps.indexOf(step);
    const suffix = step.run.endsWith(" --prefix apps/desktop") ? " --prefix apps/desktop" : "";
    assert.equal(step.run, `node scripts/retry-command.mjs npm audit signatures${suffix}`);
    assert.equal(steps[index - 1]?.run, `node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit${suffix}`, `${step.name} must verify the tree it just installed`);
    assert.ok(index < lifecycle, `${step.name} must run before lifecycle scripts`);
    // A pwsh step checks only its last command's exit code, so each check is
    // its own one-command step on the default shell.
    assert.equal(step.shell, null, `${step.name} must use the default shell`);
    assert.equal(step.condition, null, `${step.name} must not be skipped`);
    assert.equal(step.continueOnError, null, `${step.name} must fail the job`);
  }
  for (const step of steps) {
    const run = step.run ?? "";
    assert.doesNotMatch(run, /verify-dependency-advisories\.mjs|verify:dependency-age|dependency-audit-npm/, `${step.name} must not repeat the lockfile gates`);
    assert.ok(step.condition === null || /provenance/i.test(step.name ?? ""), `${step.name} must not be skipped`);
  }
});

test("the dependency gates run once, in dependency-audit, before every check job", () => {
  const jobs = workflowJobs(".github/workflows/ci.yml");
  const job = (name) => {
    const found = jobs.find((candidate) => candidate.name === name);
    assert.ok(found, `ci.yml must define the ${name} job`);
    return found;
  };
  const audit = job("dependency-audit");
  assert.deepEqual(audit.needs, [], "dependency-audit must start at once");
  assert.equal(audit.condition, "inputs.purpose != 'room-ack-evaluation'");
  assert.equal(audit.continueOnError, null);

  // Every gate runs here, unconditionally, and fails the job.
  const gates = [
    "npm run verify:dependency-age",
    "node scripts/retry-command.mjs npm audit signatures",
    "node scripts/verify-dependency-advisories.mjs .",
    "cd src/web && node ../../scripts/retry-command.mjs npm audit signatures",
    "node scripts/verify-dependency-advisories.mjs src/web",
    "node scripts/retry-command.mjs npm audit signatures --prefix apps/desktop",
    "node scripts/verify-dependency-advisories.mjs apps/desktop apps/desktop/electron/runtime/letagents",
  ];
  for (const gate of gates) {
    const steps = audit.steps.filter((step) => step.run === gate);
    assert.equal(steps.length, 1, `dependency-audit must run "${gate}" once`);
    assert.equal(steps[0].condition, null, `dependency-audit must not skip "${gate}"`);
    assert.equal(steps[0].continueOnError, null, `"${gate}" must fail dependency-audit`);
  }
  // It only checks: nothing it installed may run a lifecycle script.
  for (const command of audit.steps.flatMap((step) => (step.run ?? "").split("\n"))) {
    assert.doesNotMatch(command, /\bnpx\b|\bnpm\s+(?:rebuild|exec|x|run(?!\s+verify:dependency-age$)|run-script)\b/, command);
    if (/\bnpm\s+(?:install|i|add|ci)\b/.test(command)) {
      assert.match(command, /\s--ignore-scripts\b/, `dependency-audit must install without lifecycle scripts: ${command}`);
    }
  }

  // The check jobs install the same lockfiles and run their lifecycle
  // scripts, so each waits for the gates and none repeats them.
  const notGated = new Set(["dependency-audit", "build", "integration-tests", "npm-publish", "docker", "deploy", "room-ack-evaluation"]);
  const checkJobs = jobs.filter((candidate) => !notGated.has(candidate.name));
  assert.deepEqual(checkJobs.map((candidate) => candidate.name).sort(), ["build-checks", "desktop-tests", "desktop-tests-windows", "integration-db-tests", "mcp-tests-windows", "process-tree-windows"]);
  // Each Windows job's gate: the step after which its suites run.
  const windowsGates = {
    "mcp-tests-windows": { name: "Build the MCP server", id: "build" },
    "desktop-tests-windows": { name: "Run verified dependency lifecycle scripts", id: "setup" },
  };
  for (const checkJob of checkJobs) {
    assert.deepEqual(checkJob.needs, ["dependency-audit"], `${checkJob.name} must wait for dependency-audit`);
    for (const step of checkJob.steps) {
      const run = step.run ?? "";
      // The Windows job installs Windows-only optional packages that the ubuntu
      // signature check never sees, so it verifies each tree's signatures itself,
      // right after installing it and before anything runs it.
      const windowsGate = windowsGates[checkJob.name];
      if (windowsGate && containsDirectNpmAudit(run)) {
        const index = checkJob.steps.indexOf(step);
        const install = checkJob.steps[index - 1]?.run ?? "";
        const suffix = run.endsWith(" --prefix apps/desktop") ? " --prefix apps/desktop" : "";
        assert.equal(run, `node scripts/retry-command.mjs npm audit signatures${suffix}`, `${checkJob.name}:${step.name}`);
        assert.equal(install, `node scripts/retry-command.mjs npm ci --ignore-scripts --no-audit${suffix}`, `${checkJob.name}:${step.name} must verify the tree it just installed`);
        assert.equal(step.condition, null, `${checkJob.name}:${step.name} must not be skipped`);
        assert.equal(step.continueOnError, null, `${checkJob.name}:${step.name} must fail the job`);
        assert.equal(step.shell, null, `${checkJob.name}:${step.name} must use the default shell`);
        // Verification precedes execution: both checks sit before the build
        // gate, and every suite runs only when that gate succeeded, so a
        // failed or skipped check leaves nothing to run the unverified tree.
        const gate = checkJob.steps.findIndex((candidate) => candidate.name === windowsGate.name);
        assert.ok(gate > index, `${checkJob.name}:${step.name} must run before the gate "${windowsGate.name}"`);
        assert.ok(checkJob.steps.length > gate + 1, `${checkJob.name} must run its suites after the gate`);
        for (const later of checkJob.steps.slice(gate + 1)) {
          assert.equal(later.condition, `\${{ !cancelled() && steps.${windowsGate.id}.outcome == 'success' }}`, `${checkJob.name}:${later.name} must wait for the gate "${windowsGate.name}"`);
        }
        continue;
      }
      assert.ok(!containsDirectNpmAudit(run), `${checkJob.name}:${step.name} must not repeat npm audit`);
      assert.doesNotMatch(run, /verify-dependency-advisories\.mjs/, `${checkJob.name}:${step.name} must not repeat the advisory audit`);
      assert.doesNotMatch(run, /verify:dependency-age|verify-dependency-age\.mjs/, `${checkJob.name}:${step.name} must not repeat the cooldown`);
      assert.doesNotMatch(run, /dependency-audit-npm/, `${checkJob.name}:${step.name} must not install the audit client`);
    }
  }
  for (const gate of ["build", "integration-tests"]) {
    assert.ok(job(gate).needs.includes("dependency-audit"), `${gate} must wait for dependency-audit`);
  }
});

test("the retry wrapper only wraps the pinned npm ci installs and signature checks", () => {
  // scripts/retry-command.mjs runs any command, so a step could use it to hide
  // an install or audit the npm ci and npm audit checks above would not see.
  const wrapperLine = /^(?:cd src\/web && node \.\.\/\.\.\/|node )scripts\/retry-command\.mjs (?:npm ci --ignore-scripts --no-audit|npm audit signatures)(?: --prefix apps\/desktop)?$/;
  for (const path of workflowPaths) {
    const commands = workflowRunScripts(workflowJobs(path))
      .flatMap((script) => script.split("\n"))
      .filter((command) => command.includes("retry-command"));
    assert.ok(commands.length > 0, `${path} should install through the retry wrapper`);
    for (const command of commands) {
      assert.match(command, wrapperLine, `${path} uses the retry wrapper for something other than npm ci`);
    }
  }
});

test("the OpenCode runtime contract steps are exactly the reviewed ones", () => {
  const build = workflowJobs(".github/workflows/ci.yml").find((job) => job.name === "build-checks");
  assert.ok(build, "ci.yml must define the build-checks job");
  const step = (name) => {
    const found = build.steps.filter((candidate) => candidate.name === name);
    assert.equal(found.length, 1, `the build-checks job must define "${name}" once`);
    return found[0];
  };
  const detect = step("Detect OpenCode runtime contract changes");
  const install = step("Install the pinned OpenCode runtime");
  const verify = step("Verify the OpenCode runtime contract");

  // Whole scripts are compared, as for the audit client above: a second
  // install, a bypassed check or a replaced binary cannot hide beside the
  // reviewed lines.
  assert.equal(install.run, [
    "set -euo pipefail",
    `opencode_version=$(node -p "require('./apps/desktop/package.json').letagentsRuntime.openCodeVersion")`,
    'if ! [[ "${opencode_version}" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then',
    `echo "letagentsRuntime.openCodeVersion must be an exact version; received '\${opencode_version}'." >&2`,
    "exit 1",
    "fi",
    'npm install --global --ignore-scripts --no-audit --prefix "${RUNNER_TEMP}/opencode" "opencode-ai@${opencode_version}"',
    'opencode_binary="${RUNNER_TEMP}/opencode/lib/node_modules/opencode-ai/node_modules/opencode-linux-x64/bin/opencode"',
    'if ! [ -x "${opencode_binary}" ]; then',
    'echo "The OpenCode platform binary is missing or not executable at ${opencode_binary}." >&2',
    "exit 1",
    "fi",
    'echo "LETAGENTS_OPENCODE_BIN=${opencode_binary}" >> "${GITHUB_ENV}"',
  ].join("\n"));
  assert.equal(verify.run, "cd apps/desktop && node electron/scripts/opencode-runtime-contract-smoke.mjs");

  // The detection may only ever turn the smoke off after a successful
  // comparison found no matching file.
  const detection = detect.run.split("\n").filter((line) => !line.startsWith("#"));
  assert.deepEqual(
    detection.filter((line) => /\brun=/.test(line)),
    ["run=true", "run=false", 'echo "run=${run}" >> "${GITHUB_OUTPUT}"'],
  );
  assert.equal(detection.at(-1), 'echo "run=${run}" >> "${GITHUB_OUTPUT}"');
  assert.equal(detection[detection.indexOf("run=false") - 1], 'if [ "${matched}" -eq 1 ]; then');

  const condition = "steps.opencode_contract.outputs.run == 'true'";
  assert.equal(detect.condition, null, "the detection always runs");
  assert.equal(install.condition, condition);
  assert.equal(verify.condition, condition, "the smoke runs exactly when the runtime is installed");
  for (const candidate of [detect, install, verify]) {
    assert.equal(candidate.continueOnError, null, `"${candidate.name}" must fail the job when it fails`);
    assert.equal(candidate.shell, null, `"${candidate.name}" must use the default shell`);
  }
  assert.equal(build.condition, "inputs.purpose != 'room-ack-evaluation'");
  assert.equal(build.continueOnError, null);
});

function workflowJobText(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `ci.yml must define the ${name} job`);
  const next = workflow.slice(start + 1).search(/\n {2}\S/);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

test("the required checks wait for every check job and fail closed", () => {
  const jobs = workflowJobs(".github/workflows/ci.yml");
  const job = (name) => {
    const found = jobs.find((candidate) => candidate.name === name);
    assert.ok(found, `ci.yml must define the ${name} job`);
    return found;
  };
  const gates = ["build", "integration-tests"].map(job);

  // A skipped required check counts as passing, so each gate runs after any
  // outcome and passes only when every job it waits for succeeded.
  for (const gate of gates) {
    assert.equal(gate.condition, "${{ always() && inputs.purpose != 'room-ack-evaluation' }}", gate.name);
    assert.equal(gate.continueOnError, null, gate.name);
    assert.equal(gate.steps.length, 1, gate.name);
    assert.equal(
      gate.steps[0].run,
      'echo "${NEEDS}"\njq -e \'length > 0 and all(.[]; .result == "success")\' <<< "${NEEDS}" > /dev/null',
      gate.name,
    );
    assert.equal(gate.steps[0].condition, null, gate.name);
    assert.equal(gate.steps[0].shell, null, gate.name);
  }

  const notChecks = new Set(["build", "integration-tests", "npm-publish", "docker", "deploy", "room-ack-evaluation"]);
  assert.deepEqual(
    [...new Set(gates.flatMap((gate) => gate.needs))].sort(),
    jobs.map((candidate) => candidate.name).filter((name) => !notChecks.has(name)).sort(),
    "every check job must sit behind a required check",
  );
  for (const name of ["npm-publish", "docker"]) {
    assert.deepEqual(job(name).needs, ["build", "integration-tests"], `${name} must wait for both required checks`);
  }
  assert.deepEqual(job("deploy").needs, ["docker"], "deploy must wait for the images built after both checks");
});

test("every integration test step runs in exactly one existing group", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const groupList = workflowJobText(workflow, "integration-db-tests").match(/^ {8}group:\s*\[([^\]]*)\]\s*$/m);
  assert.ok(groupList, "integration-db-tests must list its groups");
  const groups = groupList[1].split(",").map((group) => group.trim());
  const integration = workflowJobs(".github/workflows/ci.yml").find((job) => job.name === "integration-db-tests");

  const used = new Set();
  for (const step of integration.steps) {
    const runsTests = /(?:^|\s)--test(?:\s|$)/.test(step.run ?? "");
    if (!runsTests) {
      assert.equal(step.condition, null, `setup step "${step.name}" must run in every group`);
      continue;
    }
    const group = step.condition?.match(/^matrix\.group == (\S+)$/)?.[1];
    assert.ok(groups.includes(group), `"${step.name}" must name one of the groups ${groups.join(", ")}`);
    used.add(group);
  }
  assert.deepEqual([...used].sort(), [...groups].sort(), "every group must run at least one test step");
});

test("desktop-tests and desktop-tests-windows run every desktop suite, with electron shards of one total", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const desktopScripts = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).scripts;
  const suiteScripts = [...desktopScripts.test.matchAll(/npm run (test:[\w:-]+)/g)].map((match) => match[1]);
  // A suite added to `npm test` in apps/desktop must also run in CI.
  assert.equal(desktopScripts.test, suiteScripts.map((name) => `npm run ${name}`).join(" && "));
  // The shards must choose from the same files `npm test` runs locally.
  const electronFiles = desktopScripts["test:electron"].match(/^npm run test:electron:files -- (\S+)$/)?.[1];
  assert.ok(electronFiles, "test:electron must pass one file pattern to test:electron:files");

  const shardTotals = [];
  for (const [jobName, otherSuites] of [["desktop-tests", ["daemon", "renderer"]], ["desktop-tests-windows", ["build", "daemon", "renderer"]]]) {
    const suites = [...workflowJobText(workflow, jobName).matchAll(/^ {10}- (.+)$/gm)].map((match) => match[1].trim());
    const shards = suites.flatMap((suite) => {
      const match = suite.match(/^electron (\d+)\/(\d+)$/);
      return match ? [{ index: Number(match[1]), total: Number(match[2]) }] : [];
    });
    assert.deepEqual(suites.filter((suite) => !suite.startsWith("electron ")).sort(), otherSuites, jobName);

    const desktopJob = workflowJobs(".github/workflows/ci.yml").find((job) => job.name === jobName);
    const testStep = desktopJob.steps.find((step) => step.name === "Test desktop (${{ matrix.suite }})");
    assert.ok(testStep, `${jobName} must define its test step`);
    for (const name of suiteScripts) {
      const command = name === "test:electron" ? "npm run test:electron:files -- " : `npm --prefix apps/desktop run ${name}`;
      assert.ok(testStep.run.includes(command), `${jobName} must run ${name}`);
    }
    assert.ok(
      testStep.run.includes(`node ../../scripts/select-test-shard.mjs --shard "\${shard}" --weights ../../scripts/electron-test-weights.json ${electronFiles} > `),
      `the ${jobName} electron shards must select from ${electronFiles}, as test:electron does`,
    );
    assert.ok(shards.length > 0, `${jobName} must run the electron suite`);
    assert.deepEqual(
      shards.map(({ index, total }) => `${index}/${total}`).sort(),
      Array.from({ length: shards[0].total }, (_, index) => `${index + 1}/${shards[0].total}`).sort(),
      jobName,
    );
    shardTotals.push(shards[0].total);
  }
  assert.equal(new Set(shardTotals).size, 1, "desktop-tests and desktop-tests-windows must split the electron suite the same way");

  // The Windows job also type checks and builds the desktop app.
  const windowsStep = workflowJobs(".github/workflows/ci.yml")
    .find((job) => job.name === "desktop-tests-windows").steps
    .find((step) => step.name === "Test desktop (${{ matrix.suite }})");
  for (const name of ["typecheck", "build"]) {
    assert.ok(windowsStep.run.includes(`npm --prefix apps/desktop run ${name} || status=1`), `desktop-tests-windows must run ${name}`);
  }
});
