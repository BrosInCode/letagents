import assert from "node:assert/strict";
import test from "node:test";

import type { RepoStatus } from "../ipc-types.js";
import {
  repoStatusChanged,
  repoStatusWatchFingerprint,
  shouldScheduleRepoStatusRefreshForWindow,
  shouldPauseRepoStatusRefreshForWindow,
} from "../main/repo-status-watch-state.js";

test("repoStatusChanged suppresses unchanged status emits", () => {
  const status = repoStatus();
  const fingerprint = repoStatusWatchFingerprint(status);

  assert.equal(repoStatusChanged(fingerprint, status), false);
  assert.equal(repoStatusChanged(fingerprint, repoStatus({ ahead: 1 })), true);
  assert.equal(repoStatusChanged(fingerprint, repoStatus({
    worktrees: [{
      path: "/repo-feature",
      branch: "feature/git-rooms",
      head: "fedcba9876543210",
      isCurrent: false,
      isMain: false,
    }],
  })), true);
});

test("shouldPauseRepoStatusRefreshForWindow pauses only visible hidden windows", () => {
  assert.equal(shouldPauseRepoStatusRefreshForWindow(null), false);
  assert.equal(shouldScheduleRepoStatusRefreshForWindow(null), true);
  assert.equal(shouldPauseRepoStatusRefreshForWindow({
    isDestroyed: () => true,
    isVisible: () => false,
  }), false);
  assert.equal(shouldScheduleRepoStatusRefreshForWindow({
    isDestroyed: () => true,
    isVisible: () => false,
  }), true);
  assert.equal(shouldPauseRepoStatusRefreshForWindow({
    isDestroyed: () => false,
    isVisible: () => true,
  }), false);
  assert.equal(shouldScheduleRepoStatusRefreshForWindow({
    isDestroyed: () => false,
    isVisible: () => true,
  }), true);
  assert.equal(shouldPauseRepoStatusRefreshForWindow({
    isDestroyed: () => false,
    isVisible: () => false,
  }), true);
  assert.equal(shouldScheduleRepoStatusRefreshForWindow({
    isDestroyed: () => false,
    isVisible: () => false,
  }), false);
});

function repoStatus(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    rootPath: "/repo",
    mainRootPath: "/repo",
    isGitRepo: true,
    gitHeadPath: "/repo/.git/HEAD",
    head: "1234567890abcdef",
    branch: "feature/git-rooms",
    detached: false,
    defaultBranch: "main",
    upstream: "origin/feature/git-rooms",
    ahead: 0,
    behind: 0,
    changes: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    },
    dirty: false,
    roomIdentifier: "git-room:local:test:branch:ZmVhdHVyZS9naXQtcm9vbXM",
    roomSource: "local_git",
    worktrees: [],
    ...overrides,
  };
}
