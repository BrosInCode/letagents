import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { getMainWorktreeRoot, runGit } from "../git-exec.js";

// Behavioral mirror of `src/orchestrator/worktrees.ts`. The desktop app and the
// orchestrator are compiled as separate packages with disjoint `rootDir`s, so
// the canonical module cannot be imported here without breaking both builds.
// Keep the prune-before-add, reuse-existing-checkout, sibling-naming,
// collision-fallback and created-ownership behavior in sync with that module.

function sanitizeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function worktreePathForBranch(repoRoot: string, branch: string): string {
  const normalizedRoot = resolve(repoRoot);
  return join(dirname(normalizedRoot), `${basename(normalizedRoot)}-${sanitizeBranchName(branch)}`);
}

async function findWorktreeForBranch(repoRoot: string, branch: string): Promise<string | null> {
  const { stdout, code } = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (code !== 0) return null;
  let currentPath: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      currentPath = value;
    } else if (key === "branch") {
      if (value.replace(/^refs\/heads\//, "") === branch && currentPath) return currentPath;
    }
  }
  return null;
}

async function gitRefExists(repoRoot: string, ref: string): Promise<boolean> {
  const { code } = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
  return code === 0;
}

async function detectBaseBranch(repoRoot: string): Promise<string | null> {
  const remoteHead = await runGit(repoRoot, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  // Keep the full remote-tracking name (e.g. `origin/main`) rather than the
  // stripped local name. When no local `main` exists, passing a bare `main` to
  // `git worktree add -b <branch> main` triggers git's remote-branch DWIM: it
  // silently ignores `-b <branch>` and creates the worktree on a new local
  // `main` instead. The full remote ref resolves unambiguously.
  const remoteDefault = remoteHead.stdout.trim();
  if (remoteHead.code === 0 && remoteDefault) return remoteDefault;
  for (const candidate of ["main", "master", "trunk", "develop"]) {
    if (await gitRefExists(repoRoot, `refs/heads/${candidate}`)) return candidate;
  }
  return null;
}

/**
 * Short stable discriminator of the raw branch name, used when the sanitized
 * sibling path is already taken by something else. `sanitizeBranchName` is
 * lossy (`feature/foo` and `feature-foo` both map to `feature-foo`), so the
 * plain path alone cannot be trusted to belong to the requested branch.
 */
function branchPathDiscriminator(branch: string): string {
  return createHash("sha256").update(branch).digest("hex").slice(0, 8);
}

export interface EnsureRepoWorktreeResult {
  /** Absolute path of the worktree checked out on the requested branch. */
  worktreePath: string;
  /**
   * True when this call ran `git worktree add`. False when an existing checkout
   * was reused — callers must not reclaim worktrees they did not create.
   */
  created: boolean;
}

export async function ensureRepoWorktree(input: {
  repoRoot: string;
  branch: string;
  baseBranch?: string;
}): Promise<EnsureRepoWorktreeResult> {
  const branch = input.branch.trim();
  if (!branch) throw new Error("A branch name is required to provision a worktree.");

  const repoRoot = await getMainWorktreeRoot(input.repoRoot);

  await runGit(repoRoot, ["worktree", "prune"]);

  const alreadyCheckedOut = await findWorktreeForBranch(repoRoot, branch);
  if (alreadyCheckedOut) return { worktreePath: alreadyCheckedOut, created: false };

  let desiredPath = worktreePathForBranch(repoRoot, branch);
  if (existsSync(desiredPath)) {
    // Occupied by something that is not a checkout of `branch` (the registered
    // lookup above would have matched) — e.g. a worktree of a colliding branch
    // name or an unrelated folder. Fall back to a collision-resistant path.
    desiredPath = `${desiredPath}-${branchPathDiscriminator(branch)}`;
  }

  const branchExists = await gitRefExists(repoRoot, `refs/heads/${branch}`);
  let args: string[];
  if (branchExists) {
    args = ["worktree", "add", desiredPath, branch];
  } else {
    const baseBranch = input.baseBranch?.trim() || (await detectBaseBranch(repoRoot));
    if (!baseBranch) throw new Error(`Cannot determine a base branch to create ${branch} from.`);
    args = ["worktree", "add", desiredPath, "-b", branch, baseBranch];
  }

  const result = await runGit(repoRoot, args);
  if (result.code !== 0) {
    const reused = await findWorktreeForBranch(repoRoot, branch);
    if (reused) return { worktreePath: reused, created: false };
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || `exited with code ${result.code}`}`,
    );
  }
  // Verify the worktree really is on the requested branch. `git worktree add`
  // can exit 0 while checking out a different branch (remote-branch DWIM), so
  // never hand back an unverified path.
  const recordedPath = await findWorktreeForBranch(repoRoot, branch);
  if (!recordedPath) {
    throw new Error(
      `git ${args.join(" ")} succeeded but no worktree is checked out on ${branch}; refusing to use ${desiredPath}.`,
    );
  }
  return { worktreePath: recordedPath, created: true };
}
