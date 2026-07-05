import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopRoomInfo, RepoStatus } from "../../electron/ipc-types";
import {
  repoStateChangeLabel,
  repoStateShortHead,
  repoStateStripItems,
  shouldShowRepoStateForRoom,
} from "../src/domain/repo-state-strip";

test("repo state strip summarizes dirty and conflicted Git state", () => {
  const status = repoStatus({
    changes: {
      staged: 2,
      unstaged: 3,
      untracked: 1,
      conflicted: 1,
    },
    ahead: 2,
    behind: 1,
    upstream: "origin/feature/git-rooms",
  });

  assert.equal(repoStateChangeLabel(status), "2 staged · 3 modified · 1 untracked · 1 conflicted");
  assert.equal(repoStateShortHead(status), "1234567");
  assert.deepEqual(
    repoStateStripItems(status).map((item) => [item.key, item.value, item.tone]),
    [
      ["changes", "2 staged · 3 modified · 1 untracked · 1 conflicted", "danger"],
      ["sync", "2 ahead · 1 behind · origin/feature/git-rooms", "attention"],
      ["default", "main", "neutral"],
      ["head", "1234567", "neutral"],
    ],
  );
});

test("repo state strip only shows for Git Rooms backed by a Git repo", () => {
  assert.equal(shouldShowRepoStateForRoom(roomInfo({ gitRoom: null }), repoStatus(), true), false);
  assert.equal(shouldShowRepoStateForRoom(roomInfo(), repoStatus({ isGitRepo: false }), true), false);
  assert.equal(shouldShowRepoStateForRoom(roomInfo(), repoStatus(), false), false);
  assert.equal(shouldShowRepoStateForRoom(roomInfo(), repoStatus(), true), true);
});

function roomInfo(overrides: Partial<DesktopRoomInfo> = {}): DesktopRoomInfo {
  return {
    id: "room_1",
    identifier: "github.com/BrosInCode/letagents",
    displayName: "letagents",
    code: null,
    kind: "parent",
    parentRoomId: null,
    sourceTaskId: null,
    focusKey: null,
    focusStatus: null,
    focusGitHubEventRouting: null,
    focusSettings: null,
    focusArchivedAt: null,
    concludedAt: null,
    conclusionSummary: null,
    conclusionDetails: null,
    gitRoom: {
      provider: "git",
      host: "local",
      repository: {
        id: "local:test",
        fullName: "letagents",
        owner: "local",
        name: "letagents",
      },
      ref: {
        type: "branch",
        name: "feature/git-rooms",
        defaultBranch: "main",
        headSha: "1234567890abcdef",
        headRepository: null,
      },
      visibility: "local",
      accessMode: "local",
      source: "local_git",
      isDefault: false,
    },
    ...overrides,
  };
}

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
