import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { ensureWorktree, removeWorktreeIfClean, worktreePathForBranch } from "../worktrees.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function currentBranch(cwd: string): string {
  return execFileSync("git", ["branch", "--show-current"], { cwd }).toString().trim();
}

function initRepo(): { parent: string; repoRoot: string } {
  const parent = mkdtempSync(join(tmpdir(), "letagents-ensure-worktree-"));
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

test("ensureWorktree creates a new branch worktree from the base branch", async () => {
  const { parent, repoRoot } = initRepo();
  try {
    const result = await ensureWorktree({
      repoRoot,
      branch: "feature/new",
      baseBranch: "main",
    });

    assert.equal(result.created, true);
    assert.equal(
      realpathSync(result.worktreePath),
      realpathSync(worktreePathForBranch(repoRoot, "feature/new")),
    );
    assert.ok(existsSync(join(result.worktreePath, ".git")));
    assert.equal(basename(result.worktreePath), `${basename(repoRoot)}-feature-new`);
    assert.equal(currentBranch(result.worktreePath), "feature/new");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureWorktree detects a base branch when none is provided", async () => {
  const { parent, repoRoot } = initRepo();
  try {
    const result = await ensureWorktree({ repoRoot, branch: "feature/auto-base" });
    assert.equal(result.created, true);
    assert.ok(existsSync(join(result.worktreePath, ".git")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureWorktree reuses an existing checkout and reports created=false", async () => {
  const { parent, repoRoot } = initRepo();
  try {
    // `main` is already checked out in the main worktree: reused, not owned.
    const reusedMain = await ensureWorktree({ repoRoot, branch: "main", baseBranch: "main" });
    assert.equal(realpathSync(reusedMain.worktreePath), realpathSync(repoRoot));
    assert.equal(reusedMain.created, false);

    // Provisioning the same feature branch twice: first call creates, second reuses.
    const first = await ensureWorktree({ repoRoot, branch: "feature/reuse", baseBranch: "main" });
    const second = await ensureWorktree({ repoRoot, branch: "feature/reuse", baseBranch: "main" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.worktreePath, first.worktreePath);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("colliding sanitized branch names do not resolve to each other's worktree", async () => {
  const { parent, repoRoot } = initRepo();
  try {
    // feature/foo and feature-foo both sanitize to "feature-foo".
    const slashed = await ensureWorktree({ repoRoot, branch: "feature/foo", baseBranch: "main" });
    const dashed = await ensureWorktree({ repoRoot, branch: "feature-foo", baseBranch: "main" });

    assert.equal(slashed.created, true);
    assert.equal(dashed.created, true);
    assert.notEqual(realpathSync(dashed.worktreePath), realpathSync(slashed.worktreePath));
    assert.equal(currentBranch(slashed.worktreePath), "feature/foo");
    assert.equal(currentBranch(dashed.worktreePath), "feature-foo");

    // Re-requesting each branch keeps resolving to its own checkout.
    const slashedAgain = await ensureWorktree({ repoRoot, branch: "feature/foo", baseBranch: "main" });
    const dashedAgain = await ensureWorktree({ repoRoot, branch: "feature-foo", baseBranch: "main" });
    assert.equal(slashedAgain.worktreePath, slashed.worktreePath);
    assert.equal(slashedAgain.created, false);
    assert.equal(dashedAgain.worktreePath, dashed.worktreePath);
    assert.equal(dashedAgain.created, false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureWorktree avoids an unrelated folder squatting on the sanitized path", async () => {
  const { parent, repoRoot } = initRepo();
  try {
    const plainPath = worktreePathForBranch(repoRoot, "feature/squat");
    mkdirSync(plainPath, { recursive: true });
    writeFileSync(join(plainPath, "unrelated.txt"), "not a worktree\n");

    const result = await ensureWorktree({ repoRoot, branch: "feature/squat", baseBranch: "main" });

    assert.equal(result.created, true);
    assert.notEqual(realpathSync(result.worktreePath), realpathSync(plainPath));
    assert.equal(currentBranch(result.worktreePath), "feature/squat");
    // The squatting folder is untouched.
    assert.ok(existsSync(join(plainPath, "unrelated.txt")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureWorktree bases new branches on the remote default when no local branch exists", async () => {
  const parent = mkdtempSync(join(tmpdir(), "letagents-remote-base-"));
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

    const result = await ensureWorktree({ repoRoot: cloneRoot, branch: "feature/remote-base" });

    assert.equal(result.created, true);
    assert.equal(currentBranch(result.worktreePath), "feature/remote-base");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureWorktree prunes a hand-deleted worktree registration before re-adding", async () => {
  const { parent, repoRoot } = initRepo();
  try {
    const result = await ensureWorktree({ repoRoot, branch: "feature/prune", baseBranch: "main" });
    // Simulate the folder being deleted by hand while it stays registered.
    rmSync(result.worktreePath, { recursive: true, force: true });
    // Without `git worktree prune` the branch would still count as checked out and
    // `git worktree add` would fail; ensureWorktree heals this.
    const healed = await ensureWorktree({ repoRoot, branch: "feature/prune", baseBranch: "main" });
    assert.equal(healed.created, true);
    assert.ok(existsSync(join(healed.worktreePath, ".git")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("removeWorktreeIfClean removes a clean worktree but keeps a dirty one", async () => {
  const { parent, repoRoot } = initRepo();
  try {
    const clean = await ensureWorktree({ repoRoot, branch: "feature/clean", baseBranch: "main" });
    assert.equal(await removeWorktreeIfClean({ repoRoot, worktreePath: clean.worktreePath }), "removed");
    assert.equal(existsSync(clean.worktreePath), false);

    const dirty = await ensureWorktree({ repoRoot, branch: "feature/dirty", baseBranch: "main" });
    writeFileSync(join(dirty.worktreePath, "scratch.txt"), "uncommitted\n");
    assert.equal(await removeWorktreeIfClean({ repoRoot, worktreePath: dirty.worktreePath }), "dirty");
    assert.ok(existsSync(join(dirty.worktreePath, ".git")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
