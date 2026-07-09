import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Canonical, repo-agnostic worktree provisioning shared by the orchestrator.
//
// NOTE: The desktop app cannot import this module directly — `src/` and
// `apps/desktop/electron/` are compiled as separate packages with disjoint
// `rootDir`s, so a cross-package import breaks both builds. The electron main
// process therefore keeps a small behavioral mirror of this logic in
// `apps/desktop/electron/main/rooms/worktrees.ts`; keep the two in sync.

export interface EnsureWorktreeInput {
  /** Any checkout of the repository. Normalized to the main worktree root. */
  repoRoot: string;
  /** Branch the worktree should be checked out on. */
  branch: string;
  /**
   * Branch to create `branch` from when it does not yet exist. When omitted the
   * repository's default branch is detected (remote HEAD, then common names).
   */
  baseBranch?: string;
}

export interface EnsureWorktreeResult {
  /** Absolute path of the worktree checked out on the requested branch. */
  worktreePath: string;
  /**
   * True when this call ran `git worktree add`. False when an existing checkout
   * was reused — callers must not reclaim worktrees they did not create.
   */
  created: boolean;
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export function sanitizeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/**
 * Sibling directory used for a branch's worktree, named after the repository
 * (e.g. `<repoName>-<sanitized-branch>`) rather than a hardcoded prefix.
 */
export function worktreePathForBranch(repoRoot: string, branch: string): string {
  const normalizedRoot = path.resolve(repoRoot);
  const repoName = path.basename(normalizedRoot);
  return path.join(path.dirname(normalizedRoot), `${repoName}-${sanitizeBranchName(branch)}`);
}

async function getMainWorktreeRoot(repoRoot: string): Promise<string> {
  try {
    const { stdout, code } = await runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
    const commonDir = stdout.trim();
    if (code === 0 && commonDir) {
      const absoluteCommonDir = path.resolve(repoRoot, commonDir);
      if (path.basename(absoluteCommonDir) === ".git") {
        return path.dirname(absoluteCommonDir);
      }
    }
  } catch {
    // Fall back to the passed-in root.
  }
  return path.resolve(repoRoot);
}

interface WorktreeListEntry {
  worktreePath: string;
  branch: string | null;
}

async function listWorktrees(repoRoot: string): Promise<WorktreeListEntry[]> {
  const { stdout, code } = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (code !== 0) return [];
  const entries: WorktreeListEntry[] = [];
  let current: Partial<WorktreeListEntry> | null = null;
  const push = () => {
    if (current?.worktreePath) {
      entries.push({ worktreePath: current.worktreePath, branch: current.branch ?? null });
    }
    current = null;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      push();
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      push();
      current = { worktreePath: value };
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    }
  }
  push();
  return entries;
}

async function findWorktreeForBranch(repoRoot: string, branch: string): Promise<string | null> {
  const entries = await listWorktrees(repoRoot);
  return entries.find((entry) => entry.branch === branch)?.worktreePath ?? null;
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

/**
 * Ensure a worktree for `branch` exists and return its path plus ownership.
 *
 * - Prunes stale registrations first so a hand-deleted worktree folder does not
 *   make `git worktree add` fail.
 * - Reuses an existing checkout when the branch is already checked out elsewhere
 *   (a worktree already on the branch is the desired result). Reused checkouts
 *   are reported with `created: false` so callers never reclaim them.
 * - Never trusts the sanitized sibling path by name alone: if it is occupied by
 *   anything that is not a checkout of `branch`, a collision-resistant path is
 *   used instead.
 * - Creates the branch from `baseBranch` (or a detected default) when it is new.
 */
export async function ensureWorktree(input: EnsureWorktreeInput): Promise<EnsureWorktreeResult> {
  const { branch } = input;
  if (!branch.trim()) throw new Error("A branch name is required to provision a worktree.");

  const repoRoot = await getMainWorktreeRoot(input.repoRoot);

  // Heal stale registrations (folder removed by hand but still registered).
  await runGit(repoRoot, ["worktree", "prune"]);

  // A checkout already on the branch is exactly what we want.
  const alreadyCheckedOut = await findWorktreeForBranch(repoRoot, branch);
  if (alreadyCheckedOut) return { worktreePath: alreadyCheckedOut, created: false };

  let desiredPath = worktreePathForBranch(repoRoot, branch);
  if (fs.existsSync(desiredPath)) {
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
    if (!baseBranch) {
      throw new Error(`Cannot determine a base branch to create ${branch} from.`);
    }
    args = ["worktree", "add", desiredPath, "-b", branch, baseBranch];
  }

  const result = await runGit(repoRoot, args);
  if (result.code !== 0) {
    // `git worktree add` fails when the branch is already checked out elsewhere.
    // Return that checkout instead of surfacing an error.
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

export type RemoveWorktreeOutcome = "removed" | "dirty" | "missing";

/**
 * Remove a task's worktree once it is finished, but never discard uncommitted
 * work: if `git status --porcelain` reports changes the removal is skipped. The
 * branch ref (and its commits) survive worktree removal.
 */
export async function removeWorktreeIfClean(input: {
  repoRoot: string;
  worktreePath: string;
}): Promise<RemoveWorktreeOutcome> {
  const worktreePath = path.resolve(input.worktreePath);
  if (!fs.existsSync(worktreePath)) return "missing";

  const status = await runGit(worktreePath, ["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.trim()) {
    return "dirty";
  }

  const repoRoot = await getMainWorktreeRoot(input.repoRoot);
  const result = await runGit(repoRoot, ["worktree", "remove", worktreePath]);
  if (result.code !== 0) {
    throw new Error(
      `git worktree remove ${worktreePath} failed: ${result.stderr.trim() || `exited with code ${result.code}`}`,
    );
  }
  return "removed";
}
