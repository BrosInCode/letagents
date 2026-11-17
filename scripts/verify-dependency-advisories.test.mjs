import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  ADVISORY_EXCEPTIONS,
  evaluateAdvisoryExceptions,
} from "./dependency-advisory-exceptions.mjs";

const runnerPath = path.resolve("scripts/verify-dependency-advisories.mjs");

async function createAuditFixture(mode, { lockfile = {}, report = null } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "letagents-audit-test-"));
  const packageDirectory = path.join(directory, "package");
  const fakeNpmPath = path.join(directory, "fake-npm.mjs");
  const countPath = path.join(directory, "attempt-count.txt");
  await mkdir(packageDirectory);
  const reportPath = path.join(directory, "audit-report.json");
  await writeFile(path.join(packageDirectory, "package-lock.json"), `${JSON.stringify(lockfile)}\n`);
  if (report) await writeFile(reportPath, JSON.stringify(report));
  await writeFile(
    fakeNpmPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("11.6.2");
  process.exit(0);
}
if (JSON.stringify(args) !== JSON.stringify([
  "audit",
  "--audit-level=low",
  "--package-lock-only",
  "--json",
  "--fetch-retries=0",
  "--fetch-timeout=30000",
])) {
  console.error("unexpected arguments: " + JSON.stringify(args));
  process.exit(9);
}
let count = 0;
try { count = Number.parseInt(readFileSync(${JSON.stringify(countPath)}, "utf8"), 10) || 0; } catch {}
count += 1;
writeFileSync(${JSON.stringify(countPath)}, String(count));
const shouldEmitTransientFailure =
  (${JSON.stringify(mode)} === "transient" && count < 3) ||
  ${JSON.stringify(mode)} === "transient-always" ||
  (${JSON.stringify(mode)} === "request-timeout" && count < 3);
if (shouldEmitTransientFailure) {
  console.error(
    ${JSON.stringify(mode)} === "request-timeout"
      ? "npm warn audit 408 Request Timeout"
      : "npm error 503 Service Unavailable - POST audit endpoint returned an error",
  );
  process.exit(1);
}
if (["vulnerability", "vulnerability-with-transient-text"].includes(${JSON.stringify(mode)})) {
  console.log(JSON.stringify({ metadata: { vulnerabilities: { low: 1, total: 1 } } }));
  console.error("1 low severity vulnerability");
  if (${JSON.stringify(mode)} === "vulnerability-with-transient-text") {
    console.error("npm error 503 Service Unavailable");
  }
  process.exit(1);
}
if (${JSON.stringify(mode)} === "report") {
  console.log(readFileSync(${JSON.stringify(reportPath)}, "utf8"));
  process.exit(1);
}
if (${JSON.stringify(mode)}.startsWith("http-")) {
  const status = ${JSON.stringify(mode)}.slice(5);
  console.error("npm error " + status + " permanent audit endpoint failure");
  process.exit(1);
}
if (${JSON.stringify(mode)} === "timeout-success") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
console.log("found 0 vulnerabilities");
`,
  );
  await chmod(fakeNpmPath, 0o755);
  return { countPath, fakeNpmPath, packageDirectory };
}

function runFixture(fixture, { timeoutMs = 5000 } = {}) {
  return spawnSync(process.execPath, [runnerPath, fixture.packageDirectory], {
    encoding: "utf8",
    env: {
      ...process.env,
      LETAGENTS_AUDIT_NPM_BIN: fixture.fakeNpmPath,
      LETAGENTS_AUDIT_RETRY_DELAY_MS: "1",
      LETAGENTS_AUDIT_TIMEOUT_MS: String(timeoutMs),
    },
  });
}

test("retries bounded transient registry failures and then succeeds", async () => {
  const fixture = await createAuditFixture("transient");
  const result = runFixture(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(fixture.countPath, "utf8"), "3");
  assert.match(result.stderr, /Temporary registry failure/);
});

test("retries npm's 408 Request Timeout diagnostic", async () => {
  const fixture = await createAuditFixture("request-timeout");
  const result = runFixture(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(fixture.countPath, "utf8"), "3");
  assert.match(result.stderr, /408 Request Timeout/);
});

test("fails closed without retrying an advisory finding", async () => {
  const fixture = await createAuditFixture("vulnerability");
  const result = runFixture(fixture);

  assert.equal(result.status, 1);
  assert.equal(await readFile(fixture.countPath, "utf8"), "1");
  assert.match(result.stderr, /1 low severity vulnerability/);
  assert.doesNotMatch(result.stderr, /Temporary registry failure/);
});

test("does not retry a vulnerability report containing transient-looking text", async () => {
  const fixture = await createAuditFixture("vulnerability-with-transient-text");
  const result = runFixture(fixture);

  assert.equal(result.status, 1);
  assert.equal(await readFile(fixture.countPath, "utf8"), "1");
  assert.match(result.stderr, /503 Service Unavailable/);
  assert.doesNotMatch(result.stderr, /Temporary registry failure/);
});

test("fails closed after exhausting transient registry retries", async () => {
  const fixture = await createAuditFixture("transient-always");
  const result = runFixture(fixture);

  assert.equal(result.status, 1);
  assert.equal(await readFile(fixture.countPath, "utf8"), "3");
  assert.match(result.stderr, /Dependency advisory audit/);
});

test("does not accept a timed-out child that exits successfully on SIGTERM", async () => {
  const fixture = await createAuditFixture("timeout-success");
  const result = runFixture(fixture, { timeoutMs: 1500 });

  assert.equal(result.status, 1);
  assert.equal(await readFile(fixture.countPath, "utf8"), "3");
  assert.match(result.stderr, /timed out/);
});

for (const status of [400, 401, 403]) {
  test(`does not retry permanent HTTP ${status} failures`, async () => {
    const fixture = await createAuditFixture(`http-${status}`);
    const result = runFixture(fixture);

    assert.equal(result.status, 1);
    assert.equal(await readFile(fixture.countPath, "utf8"), "1");
    assert.doesNotMatch(result.stderr, /Temporary registry failure/);
  });
}

// ── The narrow, dated exception (dependency-advisory-exceptions.mjs) ──

const PICOMATCH = "GHSA-fc5q-39xc-vjpf";
const picomatchException = ADVISORY_EXCEPTIONS.find((exception) => exception.advisory === PICOMATCH);
const endsAt = Date.parse(`${picomatchException.endsOn}T00:00:00Z`);
const beforeEnd = new Date(endsAt - 60_000);

function advisory(id, name, range = "<=4.0.7") {
  return { source: 1247710, name, dependency: name, title: "ReDoS", url: `https://github.com/advisories/${id}`, severity: "high", range };
}

/** The report npm 11 gave for src/web on 2026-11-17: one advisory, three packages that reach it. */
function picomatchReport({ extra = {}, nodes = ["node_modules/picomatch"], advisoryId = PICOMATCH, advisoryPackage = "picomatch" } = {}) {
  const vulnerabilities = {
    fdir: { name: "fdir", severity: "high", isDirect: false, via: ["picomatch"], effects: ["vite"], range: ">=5.2.1", nodes: ["node_modules/fdir"] },
    picomatch: { name: "picomatch", severity: "high", isDirect: false, via: [advisory(advisoryId, advisoryPackage)], effects: ["fdir", "tinyglobby", "vite"], range: "*", nodes },
    tinyglobby: { name: "tinyglobby", severity: "high", isDirect: false, via: ["fdir", "picomatch"], effects: [], range: "*", nodes: ["node_modules/tinyglobby"] },
    vite: { name: "vite", severity: "high", isDirect: true, via: ["fdir", "picomatch", "tinyglobby"], effects: [], range: ">=6.3.0-beta.0", nodes: ["node_modules/vite"] },
    ...extra,
  };
  const total = Object.keys(vulnerabilities).length;
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: total, critical: 0, total } } };
}

function devLockfile(extraPackages = {}) {
  return {
    lockfileVersion: 3,
    packages: {
      "": { name: "web" },
      "node_modules/picomatch": { version: "4.0.4", dev: true },
      "node_modules/fdir": { version: "6.4.6", dev: true },
      "node_modules/vite": { version: "6.4.5", dev: true },
      ...extraPackages,
    },
  };
}

test("the exception lets the picomatch advisory pass only while every picomatch is dev, and says when it ends", () => {
  const decision = evaluateAdvisoryExceptions(picomatchReport(), devLockfile(), { now: beforeEnd });
  assert.equal(decision.allowed, true, decision.blocking.join("\n"));
  assert.deepEqual(decision.blocking, []);
  assert.equal(decision.notes.length, 1);
  assert.match(decision.notes[0], /Allowing GHSA-fc5q-39xc-vjpf in picomatch \(dev only: node_modules\/picomatch\) until 2026-12-18 00:00 UTC\. This exception ends on that date/);
});

test("rule 1: only GHSA-fc5q-39xc-vjpf is excepted; any other advisory still fails, also next to it", () => {
  const other = evaluateAdvisoryExceptions(picomatchReport({ advisoryId: "GHSA-aaaa-bbbb-cccc" }), devLockfile(), { now: beforeEnd });
  assert.equal(other.allowed, false);
  assert.match(other.blocking.join("\n"), /picomatch: GHSA-aaaa-bbbb-cccc has no exception\./);

  const alongside = picomatchReport({
    extra: { esbuild: { name: "esbuild", severity: "moderate", isDirect: false, via: [advisory("GHSA-67mh-4wv8-2f99", "esbuild", "<=0.24.2")], effects: [], range: "<=0.24.2", nodes: ["node_modules/esbuild"] } },
  });
  const decision = evaluateAdvisoryExceptions(alongside, devLockfile({ "node_modules/esbuild": { version: "0.24.0", dev: true } }), { now: beforeEnd });
  assert.equal(decision.allowed, false);
  assert.match(decision.blocking.join("\n"), /esbuild: GHSA-67mh-4wv8-2f99 has no exception\./);

  const noId = picomatchReport();
  noId.vulnerabilities.picomatch.via = [{ ...advisory(PICOMATCH, "picomatch"), url: "https://example.com/not-an-advisory" }];
  assert.equal(evaluateAdvisoryExceptions(noId, devLockfile(), { now: beforeEnd }).allowed, false, "an advisory without a GHSA id fails");
});

test("rule 2: the advisory is excepted only for picomatch", () => {
  const decision = evaluateAdvisoryExceptions(picomatchReport({ advisoryPackage: "micromatch" }), devLockfile(), { now: beforeEnd });
  assert.equal(decision.allowed, false);
  assert.match(decision.blocking.join("\n"), /GHSA-fc5q-39xc-vjpf is excepted only for picomatch, not for micromatch\./);
});

test("rule 3: a picomatch that is not dev (at any depth), or one the lockfile does not show, fails the audit", () => {
  const nested = devLockfile({ "node_modules/some-runtime-lib/node_modules/picomatch": { version: "4.0.7" } });
  const runtime = evaluateAdvisoryExceptions(picomatchReport(), nested, { now: beforeEnd });
  assert.equal(runtime.allowed, false);
  assert.match(runtime.blocking.join("\n"), /only while every picomatch in the lockfile is a dev dependency\. Not dev: node_modules\/some-runtime-lib\/node_modules\/picomatch\./);

  const devOptional = devLockfile({ "node_modules/picomatch": { version: "4.0.4", devOptional: true } });
  assert.equal(evaluateAdvisoryExceptions(picomatchReport(), devOptional, { now: beforeEnd }).allowed, false, "devOptional can install in production");

  assert.equal(evaluateAdvisoryExceptions(picomatchReport(), { packages: {} }, { now: beforeEnd }).allowed, false, "not in the lockfile");
  assert.equal(
    evaluateAdvisoryExceptions(picomatchReport({ nodes: ["node_modules/other/node_modules/picomatch"] }), devLockfile(), { now: beforeEnd }).allowed,
    false,
    "a reported copy the lockfile does not list",
  );
});

test("rule 4: the exception ends at 00:00 UTC on its end date, and the reason says so", () => {
  assert.equal(picomatchException.endsOn, "2026-12-18");
  assert.equal(evaluateAdvisoryExceptions(picomatchReport(), devLockfile(), { now: new Date(endsAt - 1) }).allowed, true);
  for (const now of [new Date(endsAt), new Date(endsAt + 30 * 24 * 3600 * 1000)]) {
    const decision = evaluateAdvisoryExceptions(picomatchReport(), devLockfile(), { now });
    assert.equal(decision.allowed, false);
    assert.match(decision.blocking.join("\n"), /The exception for GHSA-fc5q-39xc-vjpf in picomatch ended on 2026-12-18\. Upgrade picomatch/);
  }
});

test("a report the exception cannot read fails closed", () => {
  const now = beforeEnd;
  assert.equal(evaluateAdvisoryExceptions(null, devLockfile(), { now }).allowed, false);
  assert.equal(evaluateAdvisoryExceptions({ metadata: { vulnerabilities: { total: 1 } } }, devLockfile(), { now }).allowed, false);
  const dangling = picomatchReport();
  dangling.vulnerabilities.vite.via = ["fdir", "picomatch", "rollup"];
  assert.match(evaluateAdvisoryExceptions(dangling, devLockfile(), { now }).blocking.join("\n"), /vite: it depends on rollup, which the report does not list\./);
  const empty = picomatchReport();
  empty.vulnerabilities.fdir.via = [];
  assert.equal(evaluateAdvisoryExceptions(empty, devLockfile(), { now }).allowed, false);
});

test("the audit runner passes the excepted picomatch report and logs the end date, until that date", async () => {
  const fixture = await createAuditFixture("report", { lockfile: devLockfile(), report: picomatchReport() });
  const result = runFixture(fixture);
  if (Date.now() < endsAt) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Allowing GHSA-fc5q-39xc-vjpf in picomatch \(dev only: node_modules\/picomatch\) until 2026-12-18 00:00 UTC/);
  } else {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ended on 2026-12-18/);
  }
  assert.equal(await readFile(fixture.countPath, "utf8"), "1", "an advisory report is never retried");
});

test("the audit runner still fails the picomatch advisory on a non-dev path, and any other advisory", async () => {
  const runtime = await createAuditFixture("report", {
    lockfile: devLockfile({ "node_modules/picomatch": { version: "4.0.4" } }),
    report: picomatchReport(),
  });
  const runtimeResult = runFixture(runtime);
  assert.equal(runtimeResult.status, 1);
  assert.match(runtimeResult.stderr, /Not dev: node_modules\/picomatch\./);
  assert.match(runtimeResult.stderr, /found advisories without an exception/);

  const other = await createAuditFixture("report", { lockfile: devLockfile(), report: picomatchReport({ advisoryId: "GHSA-aaaa-bbbb-cccc" }) });
  const otherResult = runFixture(other);
  assert.equal(otherResult.status, 1);
  assert.match(otherResult.stderr, /GHSA-aaaa-bbbb-cccc has no exception/);
});
