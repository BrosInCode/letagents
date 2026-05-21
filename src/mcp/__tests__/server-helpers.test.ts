/**
 * Tests for server helper functions:
 * - resolveGitRoot: resolves the root of a git repo from any subdirectory
 * - findExistingConfig: walks parent dirs to find .letagents.json
 *
 * These helpers underpin the corrected initialize_repo tool behavior.
 * @author Kingdavid Ehindero <kdof64squares@gmail.com>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join, resolve, dirname } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Re-implement helpers here (they are not exported from server.ts yet)
// We test the logic directly until we extract them to a shared module.
// ---------------------------------------------------------------------------

function resolveGitRoot(dir: string): string | null {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

function findExistingConfig(startDir: string): string | null {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, ".letagents.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers for tests
// ---------------------------------------------------------------------------

function makeTempGitRepo(): string {
  const dir = join(tmpdir(), `letagents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "pipe" });
  return dir;
}

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// resolveGitRoot tests
// ---------------------------------------------------------------------------

test("resolveGitRoot returns the repo root when called from repo root", () => {
  const repoDir = makeTempGitRepo();
  try {
    const result = resolveGitRoot(repoDir);
    assert.equal(result, realpathSync(resolve(repoDir)));
  } finally {
    cleanup(repoDir);
  }
});

test("resolveGitRoot returns the repo root when called from a subdirectory", () => {
  const repoDir = makeTempGitRepo();
  try {
    const subDir = join(repoDir, "src", "deep", "path");
    mkdirSync(subDir, { recursive: true });
    const result = resolveGitRoot(subDir);
    assert.equal(result, realpathSync(resolve(repoDir)));
  } finally {
    cleanup(repoDir);
  }
});

test("resolveGitRoot returns null when not inside a git repo", () => {
  const nonRepoDir = join(tmpdir(), `no-git-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(nonRepoDir, { recursive: true });
  try {
    const result = resolveGitRoot(nonRepoDir);
    assert.equal(result, null);
  } finally {
    cleanup(nonRepoDir);
  }
});

test("resolveGitRoot returns null for a non-existent directory", () => {
  const result = resolveGitRoot(join(tmpdir(), "does-not-exist-12345"));
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// findExistingConfig tests
// ---------------------------------------------------------------------------

test("findExistingConfig returns null when no .letagents.json exists anywhere", () => {
  const tempDir = join(tmpdir(), `letagents-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const subDir = join(tempDir, "a", "b", "c");
    mkdirSync(subDir, { recursive: true });
    assert.equal(findExistingConfig(subDir), null);
  } finally {
    cleanup(tempDir);
  }
});

test("findExistingConfig finds config in the start directory", () => {
  const tempDir = join(tmpdir(), `letagents-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "test" }));
    assert.equal(findExistingConfig(tempDir), tempDir);
  } finally {
    cleanup(tempDir);
  }
});

test("findExistingConfig finds config in a parent directory when called from subdirectory", () => {
  const tempDir = join(tmpdir(), `letagents-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const subDir = join(tempDir, "nested", "path");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "test" }));
    assert.equal(findExistingConfig(subDir), tempDir);
  } finally {
    cleanup(tempDir);
  }
});

test("findExistingConfig returns the closest config when multiple exist in the tree", () => {
  const tempDir = join(tmpdir(), `letagents-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    const subDir = join(tempDir, "nested");
    mkdirSync(subDir, { recursive: true });
    // Config at root and at nested level — should find nested first
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "root" }));
    writeFileSync(join(subDir, ".letagents.json"), JSON.stringify({ room: "nested" }));
    assert.equal(findExistingConfig(subDir), subDir);
  } finally {
    cleanup(tempDir);
  }
});
