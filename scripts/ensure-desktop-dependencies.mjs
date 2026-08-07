#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK_WAIT_MS = 100;
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function digestFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function dependencyFingerprint(lockPath) {
  return [
    digestFile(lockPath),
    process.platform,
    process.arch,
    process.versions.modules ?? "unknown-node-abi",
  ].join(":");
}

function lockPathFor(desktopRoot, dependencyRoot, lockRoot) {
  let installTarget;
  try {
    installTarget = realpathSync(dependencyRoot);
  } catch {
    installTarget = join(realpathSync(desktopRoot), "node_modules");
  }
  const targetDigest = createHash("sha256").update(installTarget).digest("hex").slice(0, 24);
  return join(lockRoot, `letagents-desktop-dependencies-${targetDigest}.lock`);
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function acquireInstallLock(lockPath, timeoutMs = LOCK_TIMEOUT_MS, onContention) {
  const startedAt = Date.now();
  let reportedContention = false;
  while (true) {
    const token = randomUUID();
    let createdLock = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      createdLock = true;
      writeFileSync(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token })}\n`,
        { mode: 0o600 },
      );
      return () => {
        if (readLockOwner(lockPath)?.token === token) {
          rmSync(lockPath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (createdLock) {
        const owner = readLockOwner(lockPath);
        if (owner === undefined || owner.token === token) {
          rmSync(lockPath, { recursive: true, force: true });
        }
      }
      if (error?.code !== "EEXIST") throw error;
    }

    if (!reportedContention) {
      reportedContention = true;
      onContention?.();
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const owner = readLockOwner(lockPath);
      const ownerDescription = Number.isInteger(owner?.pid) ? ` held by PID ${owner.pid}` : "";
      throw new Error(
        `Timed out waiting for the Desktop dependency bootstrap lock${ownerDescription}: ${lockPath}. ` +
          "If no dependency install is still running, remove that exact lock directory and retry.",
      );
    }
    sleep(LOCK_WAIT_MS);
  }
}

function runNpm(npmCommand, npmCommandArgs, args, options) {
  const result = spawnSync(npmCommand, [...npmCommandArgs, ...args], options);
  if (result.error) throw result.error;
  return result;
}

function dependencyTreeIsValid({ repoRoot, desktopRoot, npmCommand, npmCommandArgs }) {
  const check = runNpm(
    npmCommand,
    npmCommandArgs,
    [
      "ls",
      "--prefix",
      desktopRoot,
      "--include=dev",
      "--include=optional",
      "--depth=0",
      "--silent",
    ],
    {
      cwd: repoRoot,
      stdio: "ignore",
    },
  );
  if (check.status !== 0) return false;

  const requiredBins = ["concurrently", "cross-env", "electron", "tsc", "vite", "vue-tsc", "wait-on"];
  const binRoot = join(desktopRoot, "node_modules", ".bin");
  if (!requiredBins.every((name) => existsSync(join(binRoot, name)) || existsSync(join(binRoot, `${name}.cmd`)))) {
    return false;
  }
  return existsSync(join(desktopRoot, "node_modules", "esbuild", "bin", "esbuild"));
}

export function ensureDesktopDependencies({
  repoRoot = defaultRepoRoot,
  desktopRoot = join(repoRoot, "apps", "desktop"),
  lockRoot = tmpdir(),
  npmCommand = process.platform === "win32" ? "npm.cmd" : "npm",
  npmCommandArgs = [],
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  onLockContention,
} = {}) {
  const desktopLockPath = join(desktopRoot, "package-lock.json");
  const dependencyRoot = join(desktopRoot, "node_modules");
  const installStampPath = join(dependencyRoot, ".letagents-package-lock.sha256");

  const installedTreeIsCurrent = () => {
    if (!existsSync(dependencyRoot) || !existsSync(installStampPath)) return false;
    if (readFileSync(installStampPath, "utf8").trim() !== dependencyFingerprint(desktopLockPath)) return false;
    return dependencyTreeIsValid({ repoRoot, desktopRoot, npmCommand, npmCommandArgs });
  };

  if (installedTreeIsCurrent()) {
    console.log("Desktop dependencies are current; keeping the existing node_modules tree.");
    return;
  }

  const lockPath = lockPathFor(desktopRoot, dependencyRoot, lockRoot);
  const releaseLock = acquireInstallLock(lockPath, lockTimeoutMs, onLockContention);
  try {
    // Another dev process may have completed the repair while this one waited.
    if (installedTreeIsCurrent()) {
      console.log("Desktop dependencies were updated by another process; keeping that tree.");
      return;
    }

    console.log("Desktop dependencies are missing or stale; updating them without deleting node_modules.");
    const beforeInstallDigest = digestFile(desktopLockPath);
    const install = runNpm(
      npmCommand,
      npmCommandArgs,
      [
        "install",
        "--prefix",
        desktopRoot,
        "--include=dev",
        "--include=optional",
        "--package-lock=true",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );
    if (install.status !== 0) {
      throw new Error(`Desktop dependency install failed with status ${install.status ?? "unknown"}.`);
    }
    if (digestFile(desktopLockPath) !== beforeInstallDigest) {
      throw new Error("Desktop dependency install changed apps/desktop/package-lock.json; refusing to stamp it as current.");
    }
    if (!dependencyTreeIsValid({ repoRoot, desktopRoot, npmCommand, npmCommandArgs })) {
      // npm install may consider the package graph current even when a prior
      // interrupted lifecycle script left esbuild's platform binary absent.
      const rebuild = runNpm(
        npmCommand,
        npmCommandArgs,
        ["rebuild", "--prefix", desktopRoot, "esbuild"],
        {
          cwd: repoRoot,
          stdio: "inherit",
        },
      );
      if (rebuild.status !== 0) {
        throw new Error(`Desktop esbuild repair failed with status ${rebuild.status ?? "unknown"}.`);
      }
    }
    if (!dependencyTreeIsValid({ repoRoot, desktopRoot, npmCommand, npmCommandArgs })) {
      throw new Error(
        "Desktop dependency install completed without the required development binaries or lifecycle artifacts. " +
          "If npm ignore-scripts is enabled, install these dependencies under your chosen policy before retrying.",
      );
    }

    const temporaryStampPath = `${installStampPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryStampPath, `${dependencyFingerprint(desktopLockPath)}\n`, { mode: 0o600 });
    renameSync(temporaryStampPath, installStampPath);
  } finally {
    releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    ensureDesktopDependencies();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = process.exitCode || 1;
  }
}
