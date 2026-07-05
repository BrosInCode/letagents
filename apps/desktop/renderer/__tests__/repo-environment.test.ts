import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopRoomInfo, RepoStatus } from "../../electron/ipc-types";
import {
  repoEnvironmentBranchDeltaForRoom,
  repoEnvironmentBranchDeltaLabel,
  repoEnvironmentCurrentBranchMatchesRoom,
  repoEnvironmentLinkedRoomLabel,
  repoEnvironmentChangeLabel,
  repoEnvironmentRoomRefLabel,
  shouldShowRepoEnvironmentForRoom,
} from "../src/domain/repo-environment";
import { repoWorkspaceSummary } from "../src/domain/repo-status";

test("repo environment summarizes dirty and conflicted Git state", () => {
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

  assert.equal(repoEnvironmentChangeLabel(status), "2 staged · 3 modified · 1 untracked · 1 conflicted");
});

test("repo environment summarizes non-conflicted changes as files changed", () => {
  const status = repoStatus({
    changes: {
      staged: 2,
      unstaged: 3,
      untracked: 2,
      conflicted: 0,
    },
  });

  assert.equal(repoEnvironmentChangeLabel(status), "7 files changed");
  assert.equal(repoWorkspaceSummary(status), "7 files changed · tracking origin/feature/git-rooms");
});

test("repo environment describes the linked Git room", () => {
  const room = roomInfo();

  assert.equal(repoEnvironmentRoomRefLabel(room), "feature/git-rooms");
  assert.equal(repoEnvironmentLinkedRoomLabel(room), "letagents · feature/git-rooms");
});

test("repo environment formats branch-wide code delta", () => {
  assert.equal(
    repoEnvironmentBranchDeltaLabel({
      branch: "feature/git-rooms",
      filesChanged: 7,
      additions: 19926,
      deletions: 779,
      baseBranch: "main",
    }),
    "+19,926 -779",
  );
  assert.equal(repoEnvironmentBranchDeltaLabel(null), null);
});

test("repo environment finds branch delta for the linked room", () => {
  const room = roomInfo();
  const status = repoStatus({
    branch: "main",
    branchDelta: {
      branch: "main",
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      baseBranch: "main",
    },
    branchDeltas: [
      {
        branch: "main",
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        baseBranch: "main",
      },
      {
        branch: "feature/git-rooms",
        filesChanged: 4,
        additions: 21,
        deletions: 3,
        baseBranch: "main",
      },
    ],
  });

  assert.deepEqual(repoEnvironmentBranchDeltaForRoom(room, status), {
    branch: "feature/git-rooms",
    filesChanged: 4,
    additions: 21,
    deletions: 3,
    baseBranch: "main",
  });

  assert.equal(repoEnvironmentBranchDeltaForRoom(room, status, false), null);
});

test("repo environment knows when the current branch is the room branch", () => {
  const room = roomInfo();

  assert.equal(repoEnvironmentCurrentBranchMatchesRoom(room, repoStatus()), true);
  assert.equal(repoEnvironmentCurrentBranchMatchesRoom(room, repoStatus(), false), false);
  assert.equal(repoEnvironmentCurrentBranchMatchesRoom(room, repoStatus({ branch: "main" })), false);
  assert.equal(repoEnvironmentCurrentBranchMatchesRoom(room, repoStatus({ detached: true })), false);
});

test("repo environment treats default-branch rooms as the default branch", () => {
  const room = roomInfo({
    gitRoom: {
      ...roomInfo().gitRoom!,
      ref: {
        ...roomInfo().gitRoom!.ref,
        type: "default_branch",
        name: null,
        defaultBranch: "main",
      },
      isDefault: true,
    },
  });

  assert.equal(repoEnvironmentRoomRefLabel(room), "main");
  assert.equal(repoEnvironmentCurrentBranchMatchesRoom(room, repoStatus({ branch: "main" })), true);
});

test("repo environment only shows for Git Rooms backed by a Git repo", () => {
  assert.equal(shouldShowRepoEnvironmentForRoom(roomInfo({ gitRoom: null }), repoStatus(), true), false);
  assert.equal(shouldShowRepoEnvironmentForRoom(roomInfo(), repoStatus({ isGitRepo: false }), true), false);
  assert.equal(shouldShowRepoEnvironmentForRoom(roomInfo(), repoStatus(), false), false);
  assert.equal(shouldShowRepoEnvironmentForRoom(roomInfo(), repoStatus(), true), true);
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
    branchDelta: null,
    branchDeltas: [],
    dirty: false,
    roomIdentifier: "git-room:local:test:branch:ZmVhdHVyZS9naXQtcm9vbXM",
    roomSource: "local_git",
    worktrees: [],
    ...overrides,
  };
}
