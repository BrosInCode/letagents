import assert from "node:assert/strict";
import test from "node:test";

import type { RepoStatus } from "../ipc-types.js";
import {
  configureRepoStatusWatchForTest,
  refreshActiveRepoStatusForTest,
  startRepoStatusWatch,
  stopRepoStatusWatch,
} from "../main/repo-status-watch.js";

test("repo status watch suppresses unchanged refresh emits", async () => {
  let nextStatus = repoStatus();
  const emitted: unknown[] = [];
  const restore = configureRepoStatusWatchForTest({
    buildRepoStatus: async () => nextStatus,
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
