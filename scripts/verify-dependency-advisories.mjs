#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { bundledPackagePaths, evaluateAdvisoryExceptions } from "./dependency-advisory-exceptions.mjs";

const EXPECTED_NPM_VERSION = "11.6.2";
const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const FORCE_KILL_GRACE_MS = 5_000;

const transientFailurePattern = new RegExp(
  [
    "EAI_AGAIN",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ERR_SOCKET",
    "socket hang up",
    "network timeout",
    "fetch failed",
    "HTTP(?:\\s+error)?\\s+(?:408|429|500|502|503|504)\\b",
    "(?:408|429|500|502|503|504)\\s+(?:Bad Gateway|Gateway Timeout|Internal Server Error|Request Timeout|Service Unavailable|Too Many Requests)",
  ].join("|"),
  "i",
);

function positiveIntegerFromEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runCommand(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimeout;

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_GRACE_MS);
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function parseAuditJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function reportedVulnerabilityCount(auditJson) {
  const total = auditJson?.metadata?.vulnerabilities?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function transientDiagnosticText(result, auditJson) {
  const npmDiagnostics = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .filter((line) => /^\s*npm (?:error|warn)\b/i.test(line))
    .join("\n");
  const structuredError = auditJson?.error ? JSON.stringify(auditJson.error) : "";
  return `${npmDiagnostics}\n${structuredError}`;
}

async function requirePinnedNpm(npmCommand, timeoutMs) {
  const result = await runCommand(npmCommand, ["--version"], {
    cwd: process.cwd(),
    timeoutMs,
  });
  const version = result.stdout.trim();
  if (result.code !== 0 || version !== EXPECTED_NPM_VERSION) {
    throw new Error(
      `Dependency audits require npm ${EXPECTED_NPM_VERSION}; received ${version || "no version"}.`,
    );
  }
}

/**
 * Why the advisories in this report may not pass; empty when every one has an
 * exception that applies. Logs the exceptions it used and their end dates.
 */
async function exceptionBlocking(npmCommand, target, targetDirectory, auditJson, timeoutMs) {
  // npm audits a shrinkwrap file instead of the lockfile; the exception reads only the lockfile.
  if (await access(path.join(targetDirectory, "npm-shrinkwrap.json")).then(() => true, () => false)) {
    return ["npm-shrinkwrap.json is present, and the exceptions read only package-lock.json, so it fails closed."];
  }
  const lockfile = JSON.parse(await readFile(path.join(targetDirectory, "package-lock.json"), "utf8"));
  const decision = evaluateAdvisoryExceptions(auditJson, lockfile, { now: new Date() });
  if (!decision.allowed) return decision.blocking;

  // The lockfile's dev flags can be stale or edited: npm's own view must agree
  // that no copy is installed in production.
  const blocking = [];
  // npm sees a package that Vite bundles as dev, but its code ships.
  const bundled = bundledPackagePaths(lockfile);
  for (const { advisory, packageName, paths } of decision.used) {
    const bundledPaths = paths.filter((key) => bundled.has(key));
    if (bundledPaths.length > 0) {
      blocking.push(`${advisory} is excepted only for packages that are not shipped, but ${packageName} ships in a bundle: ${bundledPaths.join(", ")}.`);
      continue;
    }
    const listed = await runCommand(
      npmCommand,
      ["ls", packageName, "--omit=dev", "--package-lock-only", "--all", "--parseable"],
      { cwd: targetDirectory, timeoutMs },
    );
    if (listed.code !== 0 || listed.signal || listed.timedOut) {
      blocking.push(`${advisory}: npm could not list where ${packageName} is installed in production, so it fails closed.`);
      continue;
    }
    const production = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes("node_modules"));
    if (production.length > 0) {
      blocking.push(
        `${advisory} is excepted only for dev copies, but npm installs ${packageName} in production: ` +
          `${production.map((line) => path.relative(targetDirectory, line) || line).join(", ")}.`,
      );
    }
  }
  if (blocking.length === 0) {
    for (const note of decision.notes) console.warn(`${target}: ${note}`);
  }
  return blocking;
}

async function auditTarget(npmCommand, target, { timeoutMs, retryDelayMs }) {
  const targetDirectory = path.resolve(process.cwd(), target);
  await access(path.join(targetDirectory, "package-lock.json"));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`Auditing ${target} with npm ${EXPECTED_NPM_VERSION} (attempt ${attempt}/${MAX_ATTEMPTS})...`);
    const result = await runCommand(
      npmCommand,
      [
        "audit",
        "--audit-level=low",
        "--package-lock-only",
        "--json",
        "--fetch-retries=0",
        "--fetch-timeout=30000",
      ],
      { cwd: targetDirectory, timeoutMs },
    );

    if (result.code === 0 && !result.timedOut) {
      return;
    }

    const auditJson = parseAuditJson(result.stdout);
    const hasVulnerabilities = reportedVulnerabilityCount(auditJson) > 0;
    // npm audit exits with 1 when it finds advisories. Only that answer, in
    // full, may meet a narrow, dated exception (dependency-advisory-exceptions.mjs).
    if (hasVulnerabilities && !result.timedOut && result.code === 1 && !result.signal) {
      const blocking = await exceptionBlocking(npmCommand, target, targetDirectory, auditJson, timeoutMs);
      if (blocking.length === 0) return;
      for (const reason of blocking) console.error(`${target}: ${reason}`);
      throw new Error(`Dependency advisory audit for ${target} found advisories without an exception.`);
    }
    const retryable =
      !hasVulnerabilities &&
      (result.timedOut || transientFailurePattern.test(transientDiagnosticText(result, auditJson)));
    if (!retryable || attempt === MAX_ATTEMPTS) {
      const reason = result.timedOut
        ? `timed out after ${timeoutMs}ms`
        : `exited with code ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`;
      throw new Error(`Dependency advisory audit for ${target} ${reason}.`);
    }

    console.warn(`Temporary registry failure while auditing ${target}; retrying.`);
    await delay(retryDelayMs * attempt);
  }
}

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    throw new Error("Pass at least one package directory to audit.");
  }

  const npmCommand = process.env.LETAGENTS_AUDIT_NPM_BIN || "npm";
  const timeoutMs = positiveIntegerFromEnv("LETAGENTS_AUDIT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const retryDelayMs = positiveIntegerFromEnv(
    "LETAGENTS_AUDIT_RETRY_DELAY_MS",
    DEFAULT_RETRY_DELAY_MS,
  );

  await requirePinnedNpm(npmCommand, Math.min(timeoutMs, 15_000));
  for (const target of targets) {
    await auditTarget(npmCommand, target, { timeoutMs, retryDelayMs });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
