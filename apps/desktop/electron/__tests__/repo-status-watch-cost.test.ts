import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import "./isolated-home.js";
import { resetDesktopShellEnvironmentForTests, startDesktopShellEnvironmentHydration } from "../main/desktop-shell-environment.js";
import { refreshRepoStatus } from "../repo-status.js";
import {
  configureRepoStatusWatchForTest,
  ignoredDirectoryCandidatesForTest,
  refreshActiveRepoStatusForTest,
  runRepoStatusReconciliationTickForTest,
  startRepoStatusWatch,
  stopRepoStatusWatch,
  waitForActiveRepoStatusRefreshForTest,
} from "../main/repo-status-watch.js";

const visibleWindow = () => ({ isDestroyed: () => false, isVisible: () => true });

/** Wait for the refresh queue to drain, failing fast (not timing out) on a refresh loop. */
async function settled(withinMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      waitForActiveRepoStatusRefreshForTest(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new assert.AssertionError({
          message: `the watcher did not settle within ${withinMs} ms: refreshes keep triggering refreshes`,
        })), withinMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function countGitSpawns(directory: string): Promise<{ count: () => number; restore: () => void }> {
  const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(directory, "bin");
  const log = join(directory, "git-spawns.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  resetDesktopShellEnvironmentForTests();
  await startDesktopShellEnvironmentHydration({
    env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    runCommand: async () => `__LETAGENTS_PATH_START__\n${bin}\n__LETAGENTS_PATH_END__\n`,
  });
  return {
    count: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length,
    restore: resetDesktopShellEnvironmentForTests,
  };
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"], { cwd: root });
}

test("the reconciliation tick is one git status unless repository metadata changed", async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-watch-tick-"));
  const root = join(temporary, "repo");
  initRepo(root);
  const restore = configureRepoStatusWatchForTest({
    emitToMainWindow: () => undefined,
    getMainWindow: () => visibleWindow(),
  });
  const git = await countGitSpawns(temporary);
  try {
    await startRepoStatusWatch(root);
    await settled();

    let before = git.count();
    await refreshActiveRepoStatusForTest({ full: true });
    const fullSpawns = git.count() - before;
    t.diagnostic(`git spawns per old full tick: ${fullSpawns}`);

    before = git.count();
    assert.deepEqual(await runRepoStatusReconciliationTickForTest(), { status: true });
    const tickSpawns = git.count() - before;
    t.diagnostic(`git spawns per unchanged tick: ${tickSpawns}`);
    assert.equal(tickSpawns, 1, "an unchanged tick runs only git status");
    assert.ok(fullSpawns >= 10 * tickSpawns, `full (${fullSpawns}) is far more costly than a tick`);

    execFileSync("git", ["config", "core.someSetting", "1"], { cwd: root });
    assert.deepEqual(await runRepoStatusReconciliationTickForTest(), { full: true }, "a config change promotes to full");
    assert.deepEqual(await runRepoStatusReconciliationTickForTest(), { status: true });
    execFileSync("git", ["pack-refs", "--all"], { cwd: root });
    assert.deepEqual(await runRepoStatusReconciliationTickForTest(), { full: true }, "a packed-refs change promotes to full");
    execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/other"], { cwd: root });
    assert.deepEqual(await runRepoStatusReconciliationTickForTest(), { full: true }, "a HEAD change promotes to full");

    const kinds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      kinds.push((await runRepoStatusReconciliationTickForTest())?.full ? "full" : "status");
    }
    assert.deepEqual(kinds.filter((kind) => kind === "full").length, 1, "every tenth unchanged tick is still full");
    assert.equal(kinds.at(-1), "full");
  } finally {
    stopRepoStatusWatch();
    git.restore();
    restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("working-tree events inside ignored directories do not refresh status", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-watch-ignored-"));
  const root = join(temporary, "repo");
  initRepo(root);
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  let refreshes = 0;
  const asked: string[] = [];
  let resolveRefresh: (() => void) | null = null;
  const restore = configureRepoStatusWatchForTest({
    refreshRepoStatus: async (...args) => {
      refreshes += 1;
      resolveRefresh?.();
      return refreshRepoStatus(...args);
    },
    isIgnoredDirectory: async (rootPath, directory) => {
      asked.push(directory);
      try {
        execFileSync("git", ["check-ignore", "-q", "--", `${directory}/`], { cwd: rootPath });
        return true;
      } catch {
        return false;
      }
    },
    emitToMainWindow: () => undefined,
    getMainWindow: () => visibleWindow(),
  });
  try {
    await startRepoStatusWatch(root);
    await settled();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await settled();
    const baseline = refreshes;
    // Before this filter: each burst of writes below node_modules cost a git status.
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(root, "node_modules", "pkg", `file-${index}.js`), `${index}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await settled();
    assert.equal(refreshes, baseline, "ignored writes never refresh status");
    assert.equal(asked.filter((directory) => directory === "node_modules").length, 1, "one check per directory");

    const refreshed = new Promise<void>((resolve) => { resolveRefresh = resolve; });
    writeFileSync(join(root, "src", "index.ts"), "export {};\n");
    await Promise.race([
      refreshed,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("tracked change was not delivered")), 3_000)),
    ]);
    assert.ok(refreshes > baseline, "a change outside ignored directories still refreshes");
  } finally {
    stopRepoStatusWatch();
    restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("git reading its own index does not start the next refresh; a real index write does", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "letagents-watch-index-read-"));
  const root = join(temporary, "repo");
  initRepo(root);
  let refreshes = 0;
  let resolveRefresh: (() => void) | null = null;
  const restore = configureRepoStatusWatchForTest({
    refreshRepoStatus: async (...args) => {
      refreshes += 1;
      resolveRefresh?.();
      return refreshRepoStatus(...args);
    },
    emitToMainWindow: () => undefined,
    getMainWindow: () => visibleWindow(),
  });
  try {
    await startRepoStatusWatch(root);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const baseline = refreshes;
    // Before this check: each status read of .git/index raised a "change"
    // event on macOS, so an idle repository refreshed about 3 times a second.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.ok(refreshes - baseline <= 1, `an idle repository settles (${refreshes - baseline} refreshes in 2 s)`);

    const refreshed = new Promise<void>((resolve) => { resolveRefresh = resolve; });
    writeFileSync(join(root, "README.md"), "changed\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    await Promise.race([
      refreshed,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("index write was not delivered")), 3_000)),
    ]);
  } finally {
    stopRepoStatusWatch();
    restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("ignored-directory candidates cover top-level and common generated directories", () => {
  assert.deepEqual(ignoredDirectoryCandidatesForTest("README.md"), []);
  assert.deepEqual(ignoredDirectoryCandidatesForTest("dist/app.js"), ["dist"]);
  assert.deepEqual(
    ignoredDirectoryCandidatesForTest("packages/web/node_modules/x/index.js"),
    ["packages", "packages/web/node_modules"],
  );
  assert.equal(ignoredDirectoryCandidatesForTest("packages/web/.gitignore"), null, "a .gitignore change resets answers");
  assert.deepEqual(ignoredDirectoryCandidatesForTest(null), []);
});
