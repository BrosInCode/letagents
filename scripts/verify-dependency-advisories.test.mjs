import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runnerPath = path.resolve("scripts/verify-dependency-advisories.mjs");

async function createAuditFixture(mode) {
  const directory = await mkdtemp(path.join(tmpdir(), "letagents-audit-test-"));
  const packageDirectory = path.join(directory, "package");
  const fakeNpmPath = path.join(directory, "fake-npm.mjs");
  const countPath = path.join(directory, "attempt-count.txt");
  await mkdir(packageDirectory);
  await writeFile(path.join(packageDirectory, "package-lock.json"), "{}\n");
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
if (
  (${JSON.stringify(mode)} === "transient" && count < 3) ||
  ${JSON.stringify(mode)} === "transient-always"
) {
  console.error("npm error 503 Service Unavailable - POST audit endpoint returned an error");
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
if (${JSON.stringify(mode)}.startsWith("http-")) {
  const status = ${JSON.stringify(mode)}.slice(5);
  console.error("npm error " + status + " permanent audit endpoint failure");
  process.exit(1);
}
console.log("found 0 vulnerabilities");
`,
  );
  await chmod(fakeNpmPath, 0o755);
  return { countPath, fakeNpmPath, packageDirectory };
}

function runFixture(fixture) {
  return spawnSync(process.execPath, [runnerPath, fixture.packageDirectory], {
    encoding: "utf8",
    env: {
      ...process.env,
      LETAGENTS_AUDIT_NPM_BIN: fixture.fakeNpmPath,
      LETAGENTS_AUDIT_RETRY_DELAY_MS: "1",
      LETAGENTS_AUDIT_TIMEOUT_MS: "5000",
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

for (const status of [400, 401, 403]) {
  test(`does not retry permanent HTTP ${status} failures`, async () => {
    const fixture = await createAuditFixture(`http-${status}`);
    const result = runFixture(fixture);

    assert.equal(result.status, 1);
    assert.equal(await readFile(fixture.countPath, "utf8"), "1");
    assert.doesNotMatch(result.stderr, /Temporary registry failure/);
  });
}
