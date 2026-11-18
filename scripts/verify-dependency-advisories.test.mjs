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

async function createAuditFixture(mode, { lockfile = {}, report = null, lsOutput = "", lsExit = 0, lsHang = false, shrinkwrap = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "letagents-audit-test-"));
  const packageDirectory = path.join(directory, "package");
  const fakeNpmPath = path.join(directory, "fake-npm.mjs");
  const countPath = path.join(directory, "attempt-count.txt");
  await mkdir(packageDirectory);
  const reportPath = path.join(directory, "audit-report.json");
  await writeFile(path.join(packageDirectory, "package-lock.json"), `${JSON.stringify(lockfile)}\n`);
  if (report) await writeFile(reportPath, JSON.stringify(report));
  if (shrinkwrap) await writeFile(path.join(packageDirectory, "npm-shrinkwrap.json"), `${JSON.stringify(lockfile)}\n`);
  // npm ls prints absolute paths; "@DIR@" stands for the package directory.
  const lsText = lsOutput.replaceAll("@DIR@", packageDirectory);
  await writeFile(
    fakeNpmPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("11.6.2");
  process.exit(0);
}
if (args[0] === "ls") {
  if (JSON.stringify(args.slice(2)) !== JSON.stringify(["--omit=dev", "--package-lock-only", "--all", "--parseable"])) {
    console.error("unexpected ls arguments: " + JSON.stringify(args));
    process.exit(9);
  }
  if (${JSON.stringify(lsHang)}) {
    // Hangs, then answers "nothing in production" when stopped: the timeout alone must refuse it.
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else {
    if (${JSON.stringify(lsText)}) console.log(${JSON.stringify(lsText)});
    process.exit(${JSON.stringify(lsExit)});
  }
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
if (${JSON.stringify(mode)}.startsWith("report")) {
  console.log(readFileSync(${JSON.stringify(reportPath)}, "utf8"));
  if (${JSON.stringify(mode)} === "report-exit-7") process.exit(7);
  if (${JSON.stringify(mode)}.startsWith("report-hang")) {
    // Stopped by the timeout, it exits 0, or 1 like a normal advisory answer: the timeout alone must refuse it.
    process.on("SIGTERM", () => process.exit(${JSON.stringify(mode)} === "report-hang-1" ? 1 : 0));
    setInterval(() => {}, 1000);
  } else {
    process.exit(1);
  }
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
if (!${JSON.stringify(mode)}.startsWith("report")) console.log("found 0 vulnerabilities");
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
// The rule tests use their own copy, so they hold after the real entry is removed or ends.
const TEST_EXCEPTIONS = [{ advisory: PICOMATCH, packageName: "picomatch", endsOn: "2026-12-18" }];
const testEndsAt = Date.parse("2026-12-18T00:00:00Z");
const beforeEnd = new Date(testEndsAt - 60_000);
const evaluate = (report, lockfile, now = beforeEnd) => evaluateAdvisoryExceptions(report, lockfile, { now, exceptions: TEST_EXCEPTIONS });

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

test("the real list holds exactly the owner's exception: picomatch's GHSA-fc5q-39xc-vjpf until 2026-12-18", () => {
  assert.deepEqual(
    ADVISORY_EXCEPTIONS.map(({ advisory: id, packageName, endsOn }) => ({ id, packageName, endsOn })),
    [{ id: PICOMATCH, packageName: "picomatch", endsOn: "2026-12-18" }],
  );
  assert.ok(Object.isFrozen(ADVISORY_EXCEPTIONS) && ADVISORY_EXCEPTIONS.every(Object.isFrozen), "nothing can move the date at run time");
});

test("the exception lets the picomatch advisory pass only while every picomatch is dev, and says when it ends", () => {
  const decision = evaluate(picomatchReport(), devLockfile());
  assert.equal(decision.allowed, true, decision.blocking.join("\n"));
  assert.deepEqual(decision.blocking, []);
  assert.deepEqual(decision.used, [{ advisory: PICOMATCH, packageName: "picomatch", paths: ["node_modules/picomatch"] }]);
  assert.equal(decision.notes.length, 1);
  assert.match(decision.notes[0], /Allowing GHSA-fc5q-39xc-vjpf in picomatch \(dev only: node_modules\/picomatch\) until 2026-12-18 00:00 UTC\. This exception ends on that date/);
});

test("rule 1: only GHSA-fc5q-39xc-vjpf is excepted; any other advisory still fails, also next to it", () => {
  const other = evaluate(picomatchReport({ advisoryId: "GHSA-aaaa-bbbb-cccc" }), devLockfile());
  assert.equal(other.allowed, false);
  assert.match(other.blocking.join("\n"), /picomatch: GHSA-aaaa-bbbb-cccc has no exception\./);

  const alongside = picomatchReport({
    extra: { esbuild: { name: "esbuild", severity: "moderate", isDirect: false, via: [advisory("GHSA-67mh-4wv8-2f99", "esbuild", "<=0.24.2")], effects: [], range: "<=0.24.2", nodes: ["node_modules/esbuild"] } },
  });
  const decision = evaluate(alongside, devLockfile({ "node_modules/esbuild": { version: "0.24.0", dev: true } }));
  assert.equal(decision.allowed, false);
  assert.match(decision.blocking.join("\n"), /esbuild: GHSA-67mh-4wv8-2f99 has no exception\./);

  const noId = picomatchReport();
  noId.vulnerabilities.picomatch.via = [{ ...advisory(PICOMATCH, "picomatch"), url: "https://example.com/not-an-advisory" }];
  assert.equal(evaluate(noId, devLockfile()).allowed, false, "an advisory without a GHSA id fails");
  const unreadable = picomatchReport();
  unreadable.vulnerabilities.picomatch.via = [advisory(PICOMATCH, "picomatch"), null];
  assert.match(evaluate(unreadable, devLockfile()).blocking.join("\n"), /picomatch: the report gives an advisory it cannot read\./);
});

test("rule 2: the advisory is excepted only for picomatch, and only on picomatch's own entry", () => {
  const decision = evaluate(picomatchReport({ advisoryPackage: "micromatch" }), devLockfile());
  assert.equal(decision.allowed, false);
  assert.match(decision.blocking.join("\n"), /GHSA-fc5q-39xc-vjpf is excepted only for picomatch, not for micromatch\./);

  // The same advisory object, listed on vite's entry, with nodes the lockfile knows: still refused.
  const misplaced = picomatchReport();
  misplaced.vulnerabilities.vite.via = [...misplaced.vulnerabilities.vite.via, advisory(PICOMATCH, "picomatch")];
  misplaced.vulnerabilities.vite.nodes = ["node_modules/picomatch"];
  assert.match(evaluate(misplaced, devLockfile()).blocking.join("\n"), /GHSA-fc5q-39xc-vjpf is excepted only on picomatch's own entry, not on vite's\./);
  assert.equal(evaluate(misplaced, devLockfile()).allowed, false);
});

test("rule 3: a picomatch that is not dev (at any depth), or one the lockfile does not show, fails the audit", () => {
  const nested = devLockfile({ "node_modules/some-runtime-lib/node_modules/picomatch": { version: "4.0.7" } });
  const runtime = evaluate(picomatchReport(), nested);
  assert.equal(runtime.allowed, false);
  assert.match(runtime.blocking.join("\n"), /only while every picomatch in the lockfile is a dev dependency\. Not dev: node_modules\/some-runtime-lib\/node_modules\/picomatch\./);

  const devOptional = devLockfile({ "node_modules/picomatch": { version: "4.0.4", devOptional: true } });
  assert.equal(evaluate(picomatchReport(), devOptional).allowed, false, "devOptional can install in production");

  assert.equal(evaluate(picomatchReport(), { packages: {} }).allowed, false, "not in the lockfile");
  assert.equal(evaluate(picomatchReport({ nodes: [] }), { lockfileVersion: 1, dependencies: {} }).allowed, false, "no packages map and no reported nodes");
  assert.equal(
    evaluate(picomatchReport({ nodes: ["node_modules/other/node_modules/picomatch"] }), devLockfile()).allowed,
    false,
    "a reported copy the lockfile does not list",
  );
});

test("rule 4: the exception ends at 00:00 UTC on its end date, after the dev check, and says so", () => {
  assert.equal(evaluate(picomatchReport(), devLockfile(), new Date(testEndsAt - 1)).allowed, true);
  for (const now of [new Date(testEndsAt), new Date(testEndsAt + 30 * 24 * 3600 * 1000)]) {
    const decision = evaluate(picomatchReport(), devLockfile(), now);
    assert.equal(decision.allowed, false);
    assert.match(decision.blocking.join("\n"), /The exception for GHSA-fc5q-39xc-vjpf in picomatch ended on 2026-12-18\. Upgrade picomatch/);
  }
  // The dev check comes first, so after the end a non-dev copy is still named.
  const afterEnd = evaluate(picomatchReport(), devLockfile({ "node_modules/picomatch": { version: "4.0.4" } }), new Date(testEndsAt + 1));
  assert.match(afterEnd.blocking.join("\n"), /Not dev: node_modules\/picomatch\./);
  assert.doesNotMatch(afterEnd.blocking.join("\n"), /ended on/);
  const bad = evaluateAdvisoryExceptions(picomatchReport(), devLockfile(), { now: beforeEnd, exceptions: [{ ...TEST_EXCEPTIONS[0], endsOn: "not a date" }] });
  assert.equal(bad.allowed, false, "an unreadable end date fails closed");
});

test("a report the exception cannot trust fails closed", () => {
  assert.equal(evaluate(null, devLockfile()).allowed, false);
  assert.equal(evaluate({ metadata: { vulnerabilities: { total: 1 } } }, devLockfile()).allowed, false);
  const dangling = picomatchReport();
  dangling.vulnerabilities.vite.via = ["fdir", "picomatch", "rollup"];
  assert.match(evaluate(dangling, devLockfile()).blocking.join("\n"), /vite: it depends on rollup, which the report does not list\./);
  const empty = picomatchReport();
  empty.vulnerabilities.fdir.via = [];
  assert.equal(evaluate(empty, devLockfile()).allowed, false);
  const miscount = picomatchReport();
  miscount.metadata.vulnerabilities.total = 999;
  assert.match(evaluate(miscount, devLockfile()).blocking.join("\n"), /counts 999 vulnerabilities but lists 4/);
  const loop = picomatchReport();
  loop.vulnerabilities.vite.via = ["vite"];
  assert.match(evaluate(loop, devLockfile()).blocking.join("\n"), /vite: no advisory explains it/);
});

// The runner uses the real list and the real clock.
const realEndsAt = Date.parse(`${ADVISORY_EXCEPTIONS.find((exception) => exception.advisory === PICOMATCH)?.endsOn}T00:00:00Z`);
const realExceptionOpen = Number.isFinite(realEndsAt) && Date.now() < realEndsAt;
const realHasPicomatch = ADVISORY_EXCEPTIONS.some((exception) => exception.advisory === PICOMATCH);

test("the audit runner passes the excepted picomatch report and logs the end date, until that date", async () => {
  const fixture = await createAuditFixture("report", { lockfile: devLockfile(), report: picomatchReport() });
  const result = runFixture(fixture);
  if (realExceptionOpen) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Allowing GHSA-fc5q-39xc-vjpf in picomatch \(dev only: node_modules\/picomatch\) until 2026-12-18 00:00 UTC/);
  } else {
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /Allowing GHSA-fc5q-39xc-vjpf/);
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
  // With the real entry (before or after its end) the non-dev copy is named; without it, the advisory has no exception.
  assert.match(runtimeResult.stderr, realHasPicomatch ? /Not dev: node_modules\/picomatch\./ : /GHSA-fc5q-39xc-vjpf has no exception/);
  assert.match(runtimeResult.stderr, /found advisories without an exception/);

  const other = await createAuditFixture("report", { lockfile: devLockfile(), report: picomatchReport({ advisoryId: "GHSA-aaaa-bbbb-cccc" }) });
  const otherResult = runFixture(other);
  assert.equal(otherResult.status, 1);
  assert.match(otherResult.stderr, /GHSA-aaaa-bbbb-cccc has no exception/);
});

test("a stale or edited dev flag fails: npm itself must not install picomatch in production", { skip: !realExceptionOpen && "the real exception has ended" }, async () => {
  const stale = await createAuditFixture("report", {
    lockfile: devLockfile(),
    report: picomatchReport(),
    lsOutput: "@DIR@/node_modules/picomatch",
  });
  const staleResult = runFixture(stale);
  assert.equal(staleResult.status, 1);
  assert.match(staleResult.stderr, /GHSA-fc5q-39xc-vjpf is excepted only for dev copies, but npm installs picomatch in production: node_modules\/picomatch\./);
  assert.doesNotMatch(staleResult.stderr, /Allowing GHSA-fc5q-39xc-vjpf/);

  const unlisted = await createAuditFixture("report", { lockfile: devLockfile(), report: picomatchReport(), lsExit: 1 });
  const unlistedResult = runFixture(unlisted);
  assert.equal(unlistedResult.status, 1);
  assert.match(unlistedResult.stderr, /npm could not list where picomatch is installed in production/);

  const lsHang = await createAuditFixture("report", { lockfile: devLockfile(), report: picomatchReport(), lsHang: true });
  const lsHangResult = runFixture(lsHang, { timeoutMs: 1500 });
  assert.equal(lsHangResult.status, 1, "a timed-out npm ls fails closed even when it exits 0");
  assert.match(lsHangResult.stderr, /npm could not list where picomatch is installed in production/);

  // The root path alone (no node_modules) is not a production copy.
  const rootOnly = await createAuditFixture("report", { lockfile: devLockfile(), report: picomatchReport(), lsOutput: "@DIR@" });
  assert.equal(runFixture(rootOnly).status, 0);
});

test("only npm's normal advisory answer can meet the exception: other exits, timeouts and a shrinkwrap fail", async () => {
  const exit7 = await createAuditFixture("report-exit-7", { lockfile: devLockfile(), report: picomatchReport() });
  const exit7Result = runFixture(exit7);
  assert.equal(exit7Result.status, 1);
  assert.match(exit7Result.stderr, /exited with code 7/);

  for (const mode of ["report-hang", "report-hang-1"]) {
    const hang = await createAuditFixture(mode, { lockfile: devLockfile(), report: picomatchReport() });
    const hangResult = runFixture(hang, { timeoutMs: 1500 });
    assert.equal(hangResult.status, 1, mode);
    assert.match(hangResult.stderr, /timed out/);
    assert.doesNotMatch(hangResult.stderr, /Allowing GHSA-fc5q-39xc-vjpf/);
    assert.equal(await readFile(hang.countPath, "utf8"), "1", "a full report is read, not retried as a registry failure");
  }

  const shrinkwrap = await createAuditFixture("report", { lockfile: devLockfile(), report: picomatchReport(), shrinkwrap: true });
  const shrinkwrapResult = runFixture(shrinkwrap);
  assert.equal(shrinkwrapResult.status, 1);
  assert.match(shrinkwrapResult.stderr, /npm-shrinkwrap\.json is present/);
});
