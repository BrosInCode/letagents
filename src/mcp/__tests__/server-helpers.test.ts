import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { execSync } from "child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findExistingConfig, resolveGitRoot } from "../server/repo-context.js";

function makeTempGitRepo(): string {
  const dir = join(tmpdir(), `letagents-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync(
    "git -c user.name=LetAgents -c user.email=letagents@example.com commit --allow-empty -m init",
    { cwd: dir, stdio: "pipe" }
  );
  return dir;
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

describe("resolveGitRoot", () => {
  let repoDir = "";

  before(() => {
    repoDir = makeTempGitRepo();
  });

  after(() => cleanup(repoDir));

  it("returns the repo root when called from repo root", () => {
    assert.equal(resolveGitRoot(repoDir), realpathSync(repoDir));
  });

  it("returns the repo root when called from a subdirectory", () => {
    const subDir = join(repoDir, "src", "deep", "path");
    mkdirSync(subDir, { recursive: true });
    assert.equal(resolveGitRoot(subDir), realpathSync(repoDir));
  });

  it("returns null when not inside a git repo", () => {
    const nonRepoDir = join(tmpdir(), `no-git-${Date.now()}`);
    mkdirSync(nonRepoDir, { recursive: true });
    try {
      assert.equal(resolveGitRoot(nonRepoDir), null);
    } finally {
      cleanup(nonRepoDir);
    }
  });

  it("returns null for a non-existent directory", () => {
    assert.equal(resolveGitRoot(join(tmpdir(), "does-not-exist-12345")), null);
  });
});

describe("findExistingConfig", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = join(tmpdir(), `letagents-cfg-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => cleanup(tempDir));

  it("returns null when no .letagents.json exists anywhere", () => {
    const subDir = join(tempDir, "a", "b", "c");
    mkdirSync(subDir, { recursive: true });
    assert.equal(findExistingConfig(subDir), null);
  });

  it("finds config in the start directory", () => {
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "test" }));
    assert.equal(findExistingConfig(tempDir), tempDir);
  });

  it("finds config in a parent directory when called from subdirectory", () => {
    const subDir = join(tempDir, "nested", "path");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "test" }));
    assert.equal(findExistingConfig(subDir), tempDir);
  });

  it("returns the closest config when multiple exist in the tree", () => {
    const subDir = join(tempDir, "nested");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(tempDir, ".letagents.json"), JSON.stringify({ room: "root" }));
    writeFileSync(join(subDir, ".letagents.json"), JSON.stringify({ room: "nested" }));
    assert.equal(findExistingConfig(subDir), subDir);
  });
});
