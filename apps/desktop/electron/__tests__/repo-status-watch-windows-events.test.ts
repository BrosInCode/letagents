import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import "./isolated-home.js";
import type { RepoStatusInvalidation } from "../repo-status.js";
import {
  configureRepoStatusWatchForTest,
  startRepoStatusWatch,
  stopRepoStatusWatch,
  waitForActiveRepoStatusRefreshForTest,
} from "../main/repo-status-watch.js";

// The watcher sees file-system events through an injected `watch`, so each
// platform's event sequence can be replayed on any machine. Windows reports a
// "change" on a folder whenever a file inside it is written, even to a
// non-recursive watcher of the folder above; macOS and Linux do not.

type Listener = (eventType: string, filename: string | null) => void;

function fakeWatch() {
  const watchers: Array<{ path: string; listener: Listener }> = [];
  const watch = ((path: string, _options: unknown, listener: Listener) => {
    watchers.push({ path: resolve(path), listener });
    return Object.assign(new EventEmitter(), { close: () => undefined }) as unknown as FSWatcher;
  }) as unknown as typeof import("node:fs").watch;
  const emit = (path: string, eventType: string, filename: string): void => {
    const matching = watchers.filter((watcher) => watcher.path === resolve(path));
    assert.ok(matching.length > 0, `a watcher is open on ${path}`);
    for (const watcher of matching) watcher.listener(eventType, filename);
  };
  return { watch, emit };
}

const visibleWindow = () => ({ isDestroyed: () => false, isVisible: () => true });

async function settle(): Promise<void> {
  // Past the 250 ms debounce, then until the queued refresh has finished.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await waitForActiveRepoStatusRefreshForTest();
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "ignore" });
}

function linkedWorktree(): { temporary: string; worktrees: string; linkedRoot: string; metadata: string } {
  const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "letagents-watch-windows-linked-")));
  const mainRoot = join(temporary, "main");
  const linkedRoot = join(temporary, "linked");
  mkdirSync(mainRoot);
  git(mainRoot, "init", "-b", "main");
  writeFileSync(join(mainRoot, "tracked.txt"), "initial\n");
  git(mainRoot, "add", "tracked.txt");
  git(mainRoot, "commit", "-qm", "initial");
  git(mainRoot, "worktree", "add", "-b", "feature/linked", linkedRoot);
  const worktrees = join(mainRoot, ".git", "worktrees");
  return { temporary, worktrees, linkedRoot, metadata: join(worktrees, "linked") };
}

function recordInvalidations(platform: NodeJS.Platform, watch: typeof import("node:fs").watch) {
  const invalidations: RepoStatusInvalidation[] = [];
  const restore = configureRepoStatusWatchForTest({
    watch,
    platform,
    refreshRepoStatus: async (_rootPath, previous, invalidation) => {
      invalidations.push(invalidation);
      return previous;
    },
    emitToMainWindow: () => undefined,
    getMainWindow: () => visibleWindow(),
  });
  return { invalidations, restore };
}

const statusOnly = { status: true, head: false, refs: false, worktrees: false, static: false };
const worktreeList = { status: false, head: false, refs: true, worktrees: true, static: false };

test("a linked-worktree index write, with the folder change Windows adds, stays a status-only refresh", async () => {
  const { temporary, worktrees, linkedRoot, metadata } = linkedWorktree();
  const events = fakeWatch();
  const { invalidations, restore } = recordInvalidations("win32", events.watch);
  try {
    await startRepoStatusWatch(linkedRoot);
    await settle();
    invalidations.length = 0;

    writeFileSync(join(linkedRoot, "tracked.txt"), "changed\n");
    git(linkedRoot, "add", "tracked.txt");
    // The write, as the linked worktree's metadata folder reports it ...
    events.emit(metadata, "rename", "index.lock");
    events.emit(metadata, "rename", "index");
    // ... and the change Windows also reports to the `worktrees` watcher.
    events.emit(worktrees, "change", "linked");
    await settle();
    assert.deepEqual(invalidations, [statusOnly]);

    // Adding or removing a worktree folder still reaches that watcher.
    invalidations.length = 0;
    events.emit(worktrees, "rename", "another");
    await settle();
    assert.deepEqual(invalidations, [worktreeList]);
  } finally {
    stopRepoStatusWatch();
    restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});

for (const platform of ["darwin", "linux"] as const) {
  test(`on ${platform} every event on the worktrees watcher counts, as before`, async () => {
    const { temporary, worktrees, linkedRoot } = linkedWorktree();
    const events = fakeWatch();
    const { invalidations, restore } = recordInvalidations(platform, events.watch);
    try {
      await startRepoStatusWatch(linkedRoot);
      await settle();
      invalidations.length = 0;
      events.emit(worktrees, "change", "linked");
      await settle();
      assert.deepEqual(invalidations, [worktreeList]);
    } finally {
      stopRepoStatusWatch();
      restore();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test("writes below an ignored folder, with the folder changes Windows adds, refresh nothing", async () => {
  const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "letagents-watch-windows-ignored-")));
  const root = join(temporary, "repo");
  mkdirSync(root);
  git(root, "init", "-b", "main");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "README.md"), "hello\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, "src"));
  const events = fakeWatch();
  const { invalidations, restore } = recordInvalidations("win32", events.watch);
  try {
    await startRepoStatusWatch(root);
    await settle();
    invalidations.length = 0;

    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    events.emit(root, "rename", "node_modules\\pkg\\index.js");
    events.emit(root, "change", "node_modules\\pkg\\index.js");
    events.emit(root, "change", "node_modules\\pkg");
    events.emit(root, "change", "node_modules");
    await settle();
    assert.deepEqual(invalidations, [], "ignored writes and their folder changes never refresh status");

    // A write in a tracked folder still refreshes; its folder change adds nothing.
    writeFileSync(join(root, "src", "a.ts"), "export {};\n");
    events.emit(root, "rename", "src\\a.ts");
    events.emit(root, "change", "src");
    await settle();
    assert.deepEqual(invalidations, [{ ...statusOnly }]);

    // A folder that is added or removed still arrives as "rename" and refreshes.
    invalidations.length = 0;
    events.emit(root, "rename", "src");
    await settle();
    assert.deepEqual(invalidations, [{ ...statusOnly }]);
  } finally {
    stopRepoStatusWatch();
    restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("on macOS a top-level folder change on the working tree still refreshes, as before", async () => {
  const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "letagents-watch-darwin-folder-")));
  const root = join(temporary, "repo");
  mkdirSync(root);
  git(root, "init", "-b", "main");
  writeFileSync(join(root, "README.md"), "hello\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  mkdirSync(join(root, "src"));
  const events = fakeWatch();
  const { invalidations, restore } = recordInvalidations("darwin", events.watch);
  try {
    await startRepoStatusWatch(root);
    await settle();
    invalidations.length = 0;
    events.emit(root, "change", "src");
    await settle();
    assert.deepEqual(invalidations, [{ ...statusOnly }]);
  } finally {
    stopRepoStatusWatch();
    restore();
    rmSync(temporary, { recursive: true, force: true });
  }
});
