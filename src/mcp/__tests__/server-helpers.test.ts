/**
 * Tests for server helper functions:
 * - resolveGitRoot: resolves the root of a git repo from any subdirectory
 * - findExistingConfig: walks parent dirs to find .letagents.json
 *
 * These helpers underpin the corrected initialize_repo tool behavior.
 * @author Kingdavid Ehindero <kdof64squares@gmail.com>
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
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
  const { dirname } = require("path");
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
  const dir = join(tmpdir(), `letagents-test-${Date.now()}`);
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

describe("resolveGitRoot", () => {
  let repoDir: string;

  beforeAll(() => { repoDir = makeTempGitRepo(); });
  afterAll(() => cleanup(repoDir));

  it("returns the repo root when called from repo root", () => {
    const result = resolveGitRoot(repoDir);
    expect(result).toBe(resolve(repoDir));
  });

  it("returns the repo root when called from a subdirectory", () => {
    const subDir = join(repoDir, "src", "deep", "path");
    mkdirSync(subDir, { recursive: true });
    const result = resolveGitRoot(subDir);
    expect(result).toBe(resolve(repoDir));
  });

  it("returns null when not inside a git repo", () => {
    const nonRepoDir = join(tmpdir(), `no-git-${Date.now()}`);
    mkdirSync(nonRepoDir, { recursive: true });
    const result = resolveGitRoot(nonRepoDir);
    cleanup(nonRepoDir);
    expect(result).toBeNull();
  });

  it("returns null for a non-existent directory", () => {
    const result = resolveGitRoot(join(tmpdir(), "does-not-exist-12345"));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findExistingConfig tests
// ---------------------------------------------------------------------------

describe("findExistingConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `letagents-cfg-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => cleanup(tempDir));

  it("returns null when no .letagents.json exists anywhere", () => {
    const subDir = join(tempDir, "a", "b", "c");
    mkdirSync(subDir, { recursive: true });
    expect(findExistingConfig(subDir)).toBeNull();
  });

  it("finds config in the start directory", () => {
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "test" }));
    expect(findExistingConfig(tempDir)).toBe(tempDir);
  });

  it("finds config in a parent directory when called from subdirectory", () => {
    const subDir = join(tempDir, "nested", "path");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "test" }));
    expect(findExistingConfig(subDir)).toBe(tempDir);
  });

  it("returns the closest config when multiple exist in the tree", () => {
    const subDir = join(tempDir, "nested");
    mkdirSync(subDir, { recursive: true });
    // Config at root and at nested level — should find nested first
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "root" }));
    writeFileSync(join(subDir, ".letagents.json"), JSON.stringify({ room: "nested" }));
    expect(findExistingConfig(subDir)).toBe(subDir);
  });
});
