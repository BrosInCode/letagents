#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const EXPECTED_NPM_VERSION = "11.6.2";
const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

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
    "audit endpoint returned an error",
    "HTTP(?:\\s+error)?\\s+(?:408|429|500|502|503|504)\\b",
    "(?:408|429|500|502|503|504)\\s+(?:Bad Gateway|Gateway Timeout|Internal Server Error|Service Unavailable|Too Many Requests)",
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

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once("error", reject);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
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
        "--fetch-retries=0",
        "--fetch-timeout=30000",
      ],
      { cwd: targetDirectory, timeoutMs },
    );

    if (result.code === 0) {
      return;
    }

    const retryable = result.timedOut || transientFailurePattern.test(`${result.stdout}\n${result.stderr}`);
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
