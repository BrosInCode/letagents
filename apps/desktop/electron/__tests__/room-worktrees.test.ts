import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureRepoWorktree } from "../main/rooms/worktrees.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function currentBranch(cwd: string): string {
  return execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim();
}

function initRepo(): { parent: string; repoRoot: string } {
  const parent = mkdtempSync(join(tmpdir(), "letagents-room-worktrees-"));
  const repoRoot = join(parent, "repo");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ["init", "-b", "main"]);
  writeFileSync(join(repoRoot, "tracked.txt"), "hello\n");
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "commit",
    "-m",
    "Initial commit",
  ]);
  return { parent, repoRoot };
}

test("ensureRepoWorktree creates a worktree and reports created ownership", async () => {
  const { parent, repoRoot } = initRepo();
  try {
    const first = await ensureRepoWorktree({ repoRoot, branch: "feature/room", baseBranch: "main" });
    assert.equal(first.created, true);
    assert.ok(existsSync(join(first.worktreePath, ".git")));
    assert.equal(currentBranch(first.worktreePath), "feature/room");

    // Reused checkouts are reported as not created.
    const second = await ensureRepoWorktree({ repoRoot, branch: "feature/room", baseBranch: "main" });
    assert.equal(second.created, false);
    assert.equal(second.worktreePath, first.worktreePath);

    const reusedMain = await ensureRepoWorktree({ repoRoot, branch: "main", baseBranch: "main" });
    assert.equal(reusedMain.created, false);
    assert.equal(realpathSync(reusedMain.worktreePath), realpathSync(repoRoot));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureRepoWorktree bases new branches on the remote default when no local branch exists", async () => {
  const parent = mkdtempSync(join(tmpdir(), "letagents-room-remote-base-"));
  try {
    // A "remote" whose only branch is main.
    const originRepo = join(parent, "origin-repo");
    mkdirSync(originRepo, { recursive: true });
    git(originRepo, ["init", "-b", "main"]);
    writeFileSync(join(originRepo, "tracked.txt"), "hello\n");
    git(originRepo, ["add", "-A"]);
    git(originRepo, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-m",
      "Initial commit",
    ]);

    // A clone left detached with NO local main — only origin/main remains.
    // With a stripped base name ("main"), `git worktree add -b feature/x main`
    // exits 0 but git's remote-branch DWIM silently creates the worktree on a
    // new local `main` instead of feature/x.
    const cloneRoot = join(parent, "clone");
    git(parent, ["clone", originRepo, cloneRoot]);
    git(cloneRoot, ["checkout", "--detach"]);
    git(cloneRoot, ["branch", "-D", "main"]);

    const result = await ensureRepoWorktree({ repoRoot: cloneRoot, branch: "feature/remote-base" });

    assert.equal(result.created, true);
    assert.equal(currentBranch(result.worktreePath), "feature/remote-base");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureRepoWorktree keeps colliding sanitized branch names apart", async () => {
  const { parent, repoRoot } = initRepo();
  try {
    // feature/foo and feature-foo both sanitize to "feature-foo".
    const slashed = await ensureRepoWorktree({ repoRoot, branch: "feature/foo", baseBranch: "main" });
    const dashed = await ensureRepoWorktree({ repoRoot, branch: "feature-foo", baseBranch: "main" });

    assert.notEqual(realpathSync(dashed.worktreePath), realpathSync(slashed.worktreePath));
    assert.equal(currentBranch(slashed.worktreePath), "feature/foo");
    assert.equal(currentBranch(dashed.worktreePath), "feature-foo");

    // Each branch keeps resolving to its own checkout on repeat calls.
    const slashedAgain = await ensureRepoWorktree({ repoRoot, branch: "feature/foo", baseBranch: "main" });
    assert.equal(slashedAgain.worktreePath, slashed.worktreePath);
    assert.equal(slashedAgain.created, false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
