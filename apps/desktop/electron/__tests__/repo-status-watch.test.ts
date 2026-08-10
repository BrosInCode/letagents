import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RepoStatus } from "../ipc-types.js";
import {
  classifyRepoStatusWatchEventForTest,
  configureRepoStatusWatchForTest,
  refreshActiveRepoStatusForTest,
  startRepoStatusWatch,
  stopRepoStatusWatch,
  waitForActiveRepoStatusRefreshForTest,
} from "../main/repo-status-watch.js";

test("repo status watch suppresses unchanged refresh emits", async () => {
  let nextStatus = repoStatus();
  const emitted: unknown[] = [];
  const restore = configureRepoStatusWatchForTest({
    buildRepoStatus: async () => nextStatus,
    refreshRepoStatus: async () => nextStatus,
    emitToMainWindow: (_channel, payload) => {
      emitted.push(payload);
    },
    getMainWindow: () => visibleWindow(),
  });

  try {
    await startRepoStatusWatch("/repo");
    await refreshActiveRepoStatusForTest();
    assert.equal(emitted.length, 0);

    nextStatus = repoStatus({
      ahead: 1,
      changes: {
        staged: 1,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
      },
      dirty: true,
    });
    await refreshActiveRepoStatusForTest();
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], nextStatus);
  } finally {
    stopRepoStatusWatch();
    restore();
  }
});

test("repo status watch does not build refreshes while the window is hidden", async () => {
  let buildCalls = 0;
  const restore = configureRepoStatusWatchForTest({
    buildRepoStatus: async () => {
      buildCalls += 1;
      return repoStatus({ ahead: buildCalls });
    },
    refreshRepoStatus: async () => {
      buildCalls += 1;
      return repoStatus({ ahead: buildCalls });
    },
    emitToMainWindow: () => undefined,
    getMainWindow: () => hiddenWindow(),
  });

  try {
    await startRepoStatusWatch("/repo");
    assert.equal(buildCalls, 1);

    await refreshActiveRepoStatusForTest();
    assert.equal(buildCalls, 1);
  } finally {
    stopRepoStatusWatch();
    restore();
  }
});

test("repo status watch closes the initial snapshot/listener race authoritatively", async () => {
  const initial = repoStatus();
  const reconciled = repoStatus({
    ahead: 1,
    changes: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
    dirty: true,
  });
  const emitted: RepoStatus[] = [];
  const restore = configureRepoStatusWatchForTest({
    buildRepoStatus: async () => initial,
    refreshRepoStatus: async (_rootPath, previous, invalidation) => {
      assert.strictEqual(previous, initial);
      assert.deepEqual(invalidation, { full: true });
      return reconciled;
    },
    emitToMainWindow: (_channel, payload) => emitted.push(payload as RepoStatus),
    getMainWindow: () => visibleWindow(),
  });

  try {
    const status = await startRepoStatusWatch("/repo");
    assert.strictEqual(status, reconciled);
    assert.deepEqual(emitted, [reconciled]);
  } finally {
    stopRepoStatusWatch();
    restore();
  }
});

test("repo status watch aborts an obsolete initial build on stop", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const restore = configureRepoStatusWatchForTest({
    buildRepoStatus: async (_rootPath, options) => {
      markStarted();
      return new Promise<RepoStatus>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options?.signal?.reason), {
          once: true,
        });
      });
    },
    emitToMainWindow: () => undefined,
    getMainWindow: () => visibleWindow(),
  });

  try {
    const startup = startRepoStatusWatch("/repo");
    await started;
    stopRepoStatusWatch();
    let timeout: NodeJS.Timeout | null = null;
    try {
      await assert.rejects(
        Promise.race([
          startup,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("obsolete initial build was not aborted")),
              1_000,
            );
          }),
        ]),
        /abort/i,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    stopRepoStatusWatch();
    restore();
  }
});

test("repo status watch releases a stopped post-listener bootstrap refresh", async () => {
  const initial = repoStatus();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const restore = configureRepoStatusWatchForTest({
    buildRepoStatus: async () => initial,
    refreshRepoStatus: async (_rootPath, _previous, _invalidation, options) => {
      markStarted();
      return new Promise<RepoStatus>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options?.signal?.reason), {
          once: true,
        });
      });
    },
    emitToMainWindow: () => undefined,
    getMainWindow: () => visibleWindow(),
  });

  try {
    const startup = startRepoStatusWatch("/repo");
    await started;
    stopRepoStatusWatch();
    let timeout: NodeJS.Timeout | null = null;
    try {
      assert.strictEqual(await Promise.race([
        startup,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("stopped bootstrap refresh kept startup pending")),
            1_000,
          );
        }),
      ]), initial);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    stopRepoStatusWatch();
    restore();
  }
});

test("repo status watch startup does not wait for a continually busy refresh queue", async () => {
  let refreshCalls = 0;
  let releaseBootstrap!: () => void;
  let releaseTrailing!: () => void;
  let markBootstrapStarted!: () => void;
  const bootstrapStarted = new Promise<void>((resolve) => {
    markBootstrapStarted = resolve;
  });
  const bootstrapGate = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  const trailingGate = new Promise<void>((resolve) => {
    releaseTrailing = resolve;
  });
  const restore = configureRepoStatusWatchForTest({
    buildRepoStatus: async () => repoStatus(),
    refreshRepoStatus: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        markBootstrapStarted();
        await bootstrapGate;
      } else {
        await trailingGate;
      }
      return repoStatus({ ahead: refreshCalls });
    },
    emitToMainWindow: () => undefined,
    getMainWindow: () => visibleWindow(),
  });

  try {
    const startup = startRepoStatusWatch("/repo");
    await bootstrapStarted;
    const trailing = refreshActiveRepoStatusForTest({ refs: true });
    releaseBootstrap();

    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        startup,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("startup waited for the trailing refresh")),
            1_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    assert.equal(refreshCalls, 2, "the trailing refresh should remain active after startup resolves");

    releaseTrailing();
    await trailing;
  } finally {
    releaseBootstrap();
    releaseTrailing();
    stopRepoStatusWatch();
    restore();
  }
});

test("repo status watch permits one refresh with one coalesced trailing refresh", async () => {
  let bootstrapping = true;
  let refreshCalls = 0;
  let activeRefreshes = 0;
  let maxActiveRefreshes = 0;
  let releaseFirstRefresh!: () => void;
  let markFirstRefreshStarted!: () => void;
  const firstRefreshStarted = new Promise<void>((resolve) => {
    markFirstRefreshStarted = resolve;
  });
  const firstRefreshGate = new Promise<void>((resolve) => {
    releaseFirstRefresh = resolve;
  });
  const invalidations: unknown[] = [];
  const restore = configureRepoStatusWatchForTest({
    buildRepoStatus: async () => repoStatus(),
    refreshRepoStatus: async (_rootPath, _previous, invalidation) => {
      if (bootstrapping) return repoStatus();
      refreshCalls += 1;
      activeRefreshes += 1;
      maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
      invalidations.push(invalidation);
      if (refreshCalls === 1) {
        markFirstRefreshStarted();
        await firstRefreshGate;
      }
      activeRefreshes -= 1;
      return repoStatus({ ahead: refreshCalls });
    },
    emitToMainWindow: () => undefined,
    getMainWindow: () => visibleWindow(),
  });

  try {
    await startRepoStatusWatch("/repo");
    bootstrapping = false;
    const first = refreshActiveRepoStatusForTest({ status: true });
    await firstRefreshStarted;
    const second = refreshActiveRepoStatusForTest({ refs: true });
    const third = refreshActiveRepoStatusForTest({ worktrees: true });

    assert.equal(refreshCalls, 1, "new signals must not start overlapping Git scans");
    releaseFirstRefresh();
    await Promise.all([first, second, third]);

    assert.equal(refreshCalls, 2, "signals during a scan collapse into one trailing refresh");
    assert.equal(maxActiveRefreshes, 1);
    assert.deepEqual(invalidations, [
      { status: true, head: false, refs: false, worktrees: false, static: false },
      { status: false, head: false, refs: true, worktrees: true, static: false },
    ]);
  } finally {
    stopRepoStatusWatch();
    restore();
  }
});

test("repo status watch retains hidden invalidations and drains them on focus", async () => {
  let visible = false;
  const listeners = new Map<string, Set<() => void>>();
  const windowState = {
    isDestroyed: () => false,
    isVisible: () => visible,
    on: (event: "show" | "focus", listener: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    },
    off: (event: "show" | "focus", listener: () => void) => {
      listeners.get(event)?.delete(listener);
    },
  };
  const invalidations: unknown[] = [];
  const restore = configureRepoStatusWatchForTest({
    buildRepoStatus: async () => repoStatus(),
    refreshRepoStatus: async (_rootPath, _previous, invalidation) => {
      invalidations.push(invalidation);
      return repoStatus({ ahead: 1 });
    },
    emitToMainWindow: () => undefined,
    getMainWindow: () => windowState,
  });

  try {
    await startRepoStatusWatch("/repo");
    await refreshActiveRepoStatusForTest({ refs: true });
    assert.equal(invalidations.length, 0);

    visible = true;
    for (const listener of listeners.get("focus") ?? []) listener();
    await waitForActiveRepoStatusRefreshForTest();

    assert.deepEqual(invalidations, [
      { full: true },
    ]);
  } finally {
    stopRepoStatusWatch();
    restore();
  }

  assert.equal(listeners.get("show")?.size, 0);
  assert.equal(listeners.get("focus")?.size, 0);
});

test("repo status watch observes nested working-tree changes without a polling tick", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-repo-watch-event-"));
  let resolveDirty!: () => void;
  const dirty = new Promise<void>((resolve) => {
    resolveDirty = resolve;
  });
  const restore = configureRepoStatusWatchForTest({
    emitToMainWindow: (_channel, payload) => {
      if ((payload as RepoStatus).dirty) resolveDirty();
    },
    getMainWindow: () => visibleWindow(),
  });

  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, stdio: "ignore" });
    mkdirSync(join(tempDir, "src"));
    await startRepoStatusWatch(tempDir);
    writeFileSync(join(tempDir, "src", "new-file.ts"), "export {};\n");

    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        dirty,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("nested change was not delivered by the watcher")),
            3_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    stopRepoStatusWatch();
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("linked-worktree index writes stay on the cheap status-only path", async () => {
  const tempParent = mkdtempSync(join(tmpdir(), "letagents-linked-index-watch-"));
  const mainRoot = join(tempParent, "main");
  const linkedRoot = join(tempParent, "linked");
  mkdirSync(mainRoot);
  let collecting = false;
  let resolveRefresh!: () => void;
  const refreshed = new Promise<void>((resolve) => {
    resolveRefresh = resolve;
  });
  const invalidations: unknown[] = [];
  const restore = configureRepoStatusWatchForTest({
    refreshRepoStatus: async (_rootPath, previous, invalidation) => {
      if (collecting) {
        invalidations.push(invalidation);
        resolveRefresh();
      }
      return previous;
    },
    emitToMainWindow: () => undefined,
    getMainWindow: () => visibleWindow(),
  });

  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: mainRoot, stdio: "ignore" });
    writeFileSync(join(mainRoot, "tracked.txt"), "initial\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: mainRoot, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
      { cwd: mainRoot, stdio: "ignore" },
    );
    execFileSync("git", ["worktree", "add", "-b", "feature/linked", linkedRoot], {
      cwd: mainRoot,
      stdio: "ignore",
    });
    writeFileSync(join(linkedRoot, "tracked.txt"), "changed\n");
    await startRepoStatusWatch(linkedRoot);
    collecting = true;

    execFileSync("git", ["add", "tracked.txt"], { cwd: linkedRoot, stdio: "ignore" });
    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        refreshed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("linked index change was not delivered")),
            3_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    assert.deepEqual(invalidations, [
      { status: true, head: false, refs: false, worktrees: false, static: false },
    ]);
  } finally {
    stopRepoStatusWatch();
    restore();
    rmSync(tempParent, { recursive: true, force: true });
  }
});

test("repo status watch observes another linked worktree switching branches", async () => {
  const tempParent = mkdtempSync(join(tmpdir(), "letagents-linked-head-watch-"));
  const mainRoot = join(tempParent, "main");
  const linkedRoot = join(tempParent, "linked");
  let canonicalLinkedRoot = linkedRoot;
  mkdirSync(mainRoot);
  let resolveBranch!: () => void;
  const branchChanged = new Promise<void>((resolve) => {
    resolveBranch = resolve;
  });
  const restore = configureRepoStatusWatchForTest({
    emitToMainWindow: (_channel, payload) => {
      const linked = (payload as RepoStatus).worktrees.find(
        (worktree) => worktree.path === canonicalLinkedRoot,
      );
      if (linked?.branch === "feature/other") resolveBranch();
    },
    getMainWindow: () => visibleWindow(),
  });

  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: mainRoot, stdio: "ignore" });
    writeFileSync(join(mainRoot, "tracked.txt"), "initial\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: mainRoot, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
      { cwd: mainRoot, stdio: "ignore" },
    );
    execFileSync("git", ["branch", "feature/other"], { cwd: mainRoot, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "feature/linked", linkedRoot], {
      cwd: mainRoot,
      stdio: "ignore",
    });
    canonicalLinkedRoot = realpathSync(linkedRoot);
    await startRepoStatusWatch(mainRoot);

    execFileSync("git", ["checkout", "feature/other"], { cwd: linkedRoot, stdio: "ignore" });
    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        branchChanged,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("linked worktree HEAD change was not delivered")),
            3_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    stopRepoStatusWatch();
    restore();
    rmSync(tempParent, { recursive: true, force: true });
  }
});

test("repo status watch installs metadata watchers for a linked worktree added later", async () => {
  const tempParent = mkdtempSync(join(tmpdir(), "letagents-linked-add-watch-"));
  const mainRoot = join(tempParent, "main");
  const linkedRoot = join(tempParent, "linked");
  mkdirSync(mainRoot);
  let canonicalLinkedRoot = linkedRoot;
  let resolveAdded!: () => void;
  const added = new Promise<void>((resolve) => {
    resolveAdded = resolve;
  });
  const restore = configureRepoStatusWatchForTest({
    emitToMainWindow: (_channel, payload) => {
      if ((payload as RepoStatus).worktrees.some(
        (worktree) => worktree.path === canonicalLinkedRoot,
      )) resolveAdded();
    },
    getMainWindow: () => visibleWindow(),
  });

  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: mainRoot, stdio: "ignore" });
    writeFileSync(join(mainRoot, "tracked.txt"), "initial\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: mainRoot, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
      { cwd: mainRoot, stdio: "ignore" },
    );
    execFileSync("git", ["branch", "feature/existing"], { cwd: mainRoot, stdio: "ignore" });
    await startRepoStatusWatch(mainRoot);

    execFileSync("git", ["worktree", "add", linkedRoot, "feature/existing"], {
      cwd: mainRoot,
      stdio: "ignore",
    });
    canonicalLinkedRoot = realpathSync(linkedRoot);
    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        added,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("new linked worktree was not delivered")),
            3_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    stopRepoStatusWatch();
    restore();
    rmSync(tempParent, { recursive: true, force: true });
  }
});

test("repo status watch treats a linked-worktree .git pointer change as layout invalidation", () => {
  assert.deepEqual(
    classifyRepoStatusWatchEventForTest({ workingTree: true, filename: ".git" }),
    { full: true },
  );
  assert.equal(
    classifyRepoStatusWatchEventForTest({ workingTree: true, filename: ".git/index" }),
    null,
  );
});

function visibleWindow() {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
  };
}

function hiddenWindow() {
  return {
    isDestroyed: () => false,
    isVisible: () => false,
  };
}

function repoStatus(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    rootPath: "/repo",
    mainRootPath: "/repo",
    isGitRepo: false,
    gitHeadPath: null,
    head: null,
    branch: null,
    detached: false,
    defaultBranch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    },
    dirty: false,
    roomIdentifier: null,
    roomSource: "local_folder",
    worktrees: [],
    ...overrides,
  };
}
