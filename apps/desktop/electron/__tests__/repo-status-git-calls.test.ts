import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./isolated-home.js";
import { observeGitSpawns, type ObservedGitSpawn } from "./harness.js";
import { startDesktopShellEnvironmentHydration } from "../main/desktop-shell-environment.js";
import {
  buildRepoStatus,
  clearBranchDeltaCacheForTest,
  parseGitShortStat,
  refreshRepoStatus,
} from "../repo-status.js";
import {
  configureRepoStatusWatchForTest,
  startRepoStatusWatch,
  stopRepoStatusWatch,
  waitForActiveRepoStatusRefreshForTest,
} from "../main/repo-status-watch.js";

// The isolated HOME hides the user's shell profile; keep the PATH this test
// process already has so the app finds the same Git as the fixtures.
await startDesktopShellEnvironmentHydration({
  runCommand: async () => `__LETAGENTS_PATH_START__\n${process.env.PATH ?? ""}\n__LETAGENTS_PATH_END__\n`,
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function commitFile(cwd: string, file: string, lines: number): void {
  writeFileSync(join(cwd, file), "line\n".repeat(lines));
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", `edit ${file}`);
}

/** A repository with an origin remote and `count` agent worktrees, each one commit ahead. */
function repoWithWorktrees(count: number): { temporary: string; root: string; worktrees: string[] } {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-git-calls-"));
  const root = join(temporary, "repo");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", "git@github.com:acme/widgets.git");
  commitFile(root, "README.md", 1);
  const worktrees: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const worktree = join(temporary, `agent-${index}`);
    git(root, "worktree", "add", "-q", "-b", `agent/${index}`, worktree);
    commitFile(worktree, `work-${index}.txt`, index + 1);
    worktrees.push(worktree);
  }
  return { temporary, root, worktrees };
}

type Recorder = {
  spawns: string[][];
  diffs: () => number;
  maxConcurrentDiffs: () => number;
  restore: () => void;
};

function recordGit(onSpawn?: (spawn: ObservedGitSpawn) => void): Recorder {
  const spawns: string[][] = [];
  let running = 0;
  let maxRunning = 0;
  const restore = observeGitSpawns((spawn) => {
    spawns.push(spawn.args);
    if (spawn.args.includes("--shortstat")) {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      spawn.child.once("exit", () => { running -= 1; });
    }
    onSpawn?.(spawn);
  });
  return {
    spawns,
    diffs: () => spawns.filter((args) => args.includes("--shortstat")).length,
    maxConcurrentDiffs: () => maxRunning,
    restore,
  };
}

/** What `git diff --shortstat --merge-base main <branch>` says, by branch name. */
function expectedDeltas(root: string, branches: string[]) {
  return branches.map((branch) => branch === "main"
    ? { branch, filesChanged: 0, additions: 0, deletions: 0, baseBranch: "main" }
    : parseGitShortStat(git(root, "diff", "--shortstat", "--merge-base", "main", branch, "--"), "main", branch));
}

test("a second build with unchanged refs runs no shortstat, and the result is unchanged", async () => {
  clearBranchDeltaCacheForTest();
  const { temporary, root } = repoWithWorktrees(6);
  const calls = recordGit();
  try {
    const first = await buildRepoStatus(root);
    assert.equal(calls.diffs(), 6, "the first build measures every worktree branch");
    assert.deepEqual(
      first.branchDeltas,
      expectedDeltas(root, ["main", ...Array.from({ length: 6 }, (_, index) => `agent/${index}`)]),
    );

    const second = await buildRepoStatus(root);
    assert.equal(calls.diffs(), 6, "unchanged refs cost zero shortstats");
    assert.deepEqual(second, first);
  } finally {
    calls.restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("moving one worktree branch measures only that branch, in a build and in a ref refresh", async () => {
  clearBranchDeltaCacheForTest();
  const { temporary, root, worktrees } = repoWithWorktrees(6);
  const calls = recordGit();
  try {
    const initial = await buildRepoStatus(root);

    commitFile(worktrees[2]!, "more.txt", 7);
    let before = calls.diffs();
    const rebuilt = await buildRepoStatus(root);
    assert.equal(calls.diffs() - before, 1, "one moved branch costs one shortstat");
    assert.deepEqual(rebuilt.branchDeltas?.find((delta) => delta.branch === "agent/2"), expectedDeltas(root, ["agent/2"])[0]);

    commitFile(worktrees[4]!, "more.txt", 3);
    before = calls.diffs();
    const refreshed = await refreshRepoStatus(root, initial, { refs: true });
    assert.equal(calls.diffs() - before, 1, "a ref change in one worktree costs one shortstat");

    clearBranchDeltaCacheForTest();
    assert.deepEqual(refreshed, await buildRepoStatus(root), "cached deltas equal freshly measured ones");
  } finally {
    calls.restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("moving the default branch measures every branch again", async () => {
  clearBranchDeltaCacheForTest();
  const { temporary, root } = repoWithWorktrees(5);
  const calls = recordGit();
  try {
    await buildRepoStatus(root);
    commitFile(root, "README.md", 4);
    const before = calls.diffs();
    const status = await buildRepoStatus(root);
    assert.equal(calls.diffs() - before, 5);
    assert.deepEqual(
      status.branchDeltas,
      expectedDeltas(root, ["main", ...Array.from({ length: 5 }, (_, index) => `agent/${index}`)]),
    );
  } finally {
    calls.restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("one build or refresh starts each Git command once", async () => {
  clearBranchDeltaCacheForTest();
  const { temporary, root } = repoWithWorktrees(3);
  const calls = recordGit();
  const repeated = () => {
    const seen = new Set<string>();
    return calls.spawns.map((args) => args.join(" ")).filter((command) => {
      if (seen.has(command)) return true;
      seen.add(command);
      return false;
    });
  };
  try {
    const status = await buildRepoStatus(root);
    assert.deepEqual(repeated(), [], "build");

    calls.spawns.length = 0;
    await buildRepoStatus(root, { includeBranchDeltas: false });
    assert.deepEqual(repeated(), [], "build without branch deltas");
    assert.equal(calls.diffs(), 0);

    calls.spawns.length = 0;
    // Origin HEAD appears: refs changed and room routing is read again.
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await refreshRepoStatus(root, status, { refs: true, static: true });
    assert.deepEqual(repeated(), [], "refresh");
  } finally {
    calls.restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("shortstats run a few at a time and stop when the build is aborted", async () => {
  clearBranchDeltaCacheForTest();
  const { temporary, root } = repoWithWorktrees(12);
  const calls = recordGit();
  try {
    await buildRepoStatus(root);
    assert.equal(calls.diffs(), 12);
    assert.ok(calls.maxConcurrentDiffs() > 1, `shortstats overlap (max ${calls.maxConcurrentDiffs()})`);
    assert.ok(calls.maxConcurrentDiffs() <= 4, `at most 4 shortstats at once (max ${calls.maxConcurrentDiffs()})`);
  } finally {
    calls.restore();
  }

  clearBranchDeltaCacheForTest();
  const controller = new AbortController();
  const aborting = recordGit(({ args }) => {
    if (args.includes("--shortstat")) controller.abort();
  });
  try {
    await assert.rejects(buildRepoStatus(root, { signal: controller.signal }), { name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(aborting.diffs() <= 4, `no shortstat starts after the abort (${aborting.diffs()} started)`);
  } finally {
    aborting.restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("opening a repository watch asks for its metadata paths in one Git run", async () => {
  clearBranchDeltaCacheForTest();
  const { temporary, root } = repoWithWorktrees(2);
  const restoreWatch = configureRepoStatusWatchForTest({
    emitToMainWindow: () => undefined,
    getMainWindow: () => ({ isDestroyed: () => false, isVisible: () => true }),
  });
  const calls = recordGit();
  try {
    const status = await startRepoStatusWatch(root);
    await waitForActiveRepoStatusRefreshForTest();
    const metadataReads = calls.spawns.filter((args) => (
      args[0] === "rev-parse" && !args.join(" ").startsWith("rev-parse --git-path HEAD ") && args[1] !== "--show-toplevel"
    ));
    // One read when the watch opens and one after the full rebuild behind it.
    assert.equal(metadataReads.length, 2, metadataReads.map((args) => args.join(" ")).join("\n"));
    assert.equal(status.branchDeltas?.length, 3);
  } finally {
    stopRepoStatusWatch();
    calls.restore();
    restoreWatch();
    rmSync(temporary, { recursive: true, force: true });
  }
});

/** What Git itself says now for `branch` against main, run in `root`. */
function gitDelta(root: string, branch: string) {
  return parseGitShortStat(git(root, "diff", "--shortstat", "--merge-base", "main", branch, "--"), "main", branch);
}

test("a changed diff configuration is measured again, also by a full refresh", async () => {
  clearBranchDeltaCacheForTest();
  const { temporary, root, worktrees } = repoWithWorktrees(1);
  try {
    git(worktrees[0]!, "mv", "README.md", "README-renamed.md");
    git(worktrees[0]!, "commit", "-qm", "rename");
    git(root, "config", "diff.renames", "true");
    const first = await buildRepoStatus(root);
    const before = first.branchDeltas?.find((delta) => delta.branch === "agent/0");
    assert.deepEqual(before, gitDelta(root, "agent/0"));

    git(root, "config", "diff.renames", "false");
    const expected = gitDelta(root, "agent/0");
    assert.notDeepEqual(expected, before, "the fixture must make diff.renames matter");
    const refreshed = await refreshRepoStatus(root, first, { full: true });
    assert.deepEqual(refreshed.branchDeltas?.find((delta) => delta.branch === "agent/0"), expected);
    const rebuilt = await buildRepoStatus(root);
    assert.deepEqual(rebuilt.branchDeltas?.find((delta) => delta.branch === "agent/0"), expected);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a changed info/attributes file is measured again", async () => {
  clearBranchDeltaCacheForTest();
  const { temporary, root } = repoWithWorktrees(2);
  try {
    const first = await buildRepoStatus(root);
    assert.deepEqual(first.branchDeltas?.find((delta) => delta.branch === "agent/1"), gitDelta(root, "agent/1"));

    writeFileSync(join(root, ".git", "info", "attributes"), "*.txt binary\n");
    const expected = gitDelta(root, "agent/1");
    assert.equal(expected.additions, 0, "the fixture must make the attribute matter");
    const rebuilt = await buildRepoStatus(root);
    assert.deepEqual(rebuilt.branchDeltas?.find((delta) => delta.branch === "agent/1"), expected);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("checking out a branch whose .gitattributes changes a diff is measured again", async () => {
  clearBranchDeltaCacheForTest();
  const { temporary, root } = repoWithWorktrees(1);
  try {
    git(root, "switch", "-qc", "attributes");
    writeFileSync(join(root, ".gitattributes"), "work-0.txt -diff\n");
    git(root, "add", ".gitattributes");
    git(root, "commit", "-qm", "attributes");
    git(root, "switch", "-q", "main");
    const first = await buildRepoStatus(root);
    assert.deepEqual(first.branchDeltas?.find((delta) => delta.branch === "agent/0"), gitDelta(root, "agent/0"));

    // Neither compared tip moves; the clean checkout brings the attribute file.
    git(root, "switch", "-q", "attributes");
    const expected = gitDelta(root, "agent/0");
    assert.equal(expected.additions, 0, "the fixture must make the attribute matter");
    const headRefresh = await refreshRepoStatus(root, first, { head: true });
    assert.deepEqual(headRefresh.branchDeltas?.find((delta) => delta.branch === "agent/0"), expected);
    const fullRefresh = await refreshRepoStatus(root, first, { full: true });
    assert.deepEqual(fullRefresh.branchDeltas?.find((delta) => delta.branch === "agent/0"), expected);
    const rebuilt = await buildRepoStatus(root);
    assert.deepEqual(rebuilt.branchDeltas?.find((delta) => delta.branch === "agent/0"), expected);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("an unrelated configuration change measures once, then the cache holds again", async () => {
  clearBranchDeltaCacheForTest();
  const { temporary, root } = repoWithWorktrees(4);
  const calls = recordGit();
  try {
    const first = await buildRepoStatus(root);
    assert.equal(calls.diffs(), 4);
    git(root, "config", "letagents.unrelated", "1");
    let before = calls.diffs();
    assert.deepEqual(await buildRepoStatus(root), first);
    assert.equal(calls.diffs() - before, 4, "a configuration change measures every branch once");
    before = calls.diffs();
    assert.deepEqual(await buildRepoStatus(root), first);
    assert.equal(calls.diffs() - before, 0, "then unchanged builds measure nothing");
  } finally {
    calls.restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});
