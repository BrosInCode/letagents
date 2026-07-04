import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyManagedAgentBranchScopePreflight,
  branchScopedGitRoomName,
  gitRoomFromBranchRoomIdentifier,
} from "../main/agents/managed-agent-branch-scope.js";
import { runDesktopAgentProviderPreflight } from "../main/agents/providers.js";
import type {
  DesktopAgentProviderPreflight,
  DesktopGitRoomInfo,
  RepoStatus,
} from "../ipc-types.js";

function readyPreflight(): DesktopAgentProviderPreflight {
  return {
    providerId: "cursor",
    status: "ready",
    canStart: true,
    message: "Cursor is ready.",
    detail: null,
    nextAction: null,
    version: "cursor test",
    mcpStatus: "installed",
  };
}

function gitRoom(overrides: Partial<DesktopGitRoomInfo["ref"]> = {}): DesktopGitRoomInfo {
  return {
    provider: "git",
    host: "local",
    repository: {
      id: null,
      fullName: "FBRF",
      owner: "",
      name: "FBRF",
    },
    ref: {
      type: "branch",
      name: "feature/player-3d-presentation",
      defaultBranch: "main",
      baseRef: null,
      headRef: null,
      headRepository: null,
      ...overrides,
    },
    visibility: "local",
    accessMode: "local",
    isDefault: false,
    source: "local_git",
  };
}

function repoStatus(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    rootPath: "/tmp/repo",
    mainRootPath: "/tmp/repo",
    isGitRepo: true,
    gitHeadPath: "/tmp/repo/.git/HEAD",
    head: "abc123",
    branch: "feature/player-3d-presentation",
    detached: false,
    defaultBranch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    dirty: false,
    roomIdentifier: null,
    roomSource: "local_git",
    worktrees: [],
    ...overrides,
  };
}

test("branchScopedGitRoomName only scopes branch Git Rooms", () => {
  assert.equal(branchScopedGitRoomName(gitRoom()), "feature/player-3d-presentation");
  assert.equal(branchScopedGitRoomName(gitRoom({ type: "default_branch", name: "main" })), null);
  assert.equal(
    branchScopedGitRoomName(
      { ...gitRoom({ type: "branch", name: "main", defaultBranch: "main" }), isDefault: true },
    ),
    null,
  );
  assert.equal(
    branchScopedGitRoomName(
      gitRoom({ type: "branch", name: "main", defaultBranch: "main" }),
      repoStatus({ defaultBranch: "main" }),
    ),
    null,
  );
  assert.equal(branchScopedGitRoomName(gitRoom({ type: "branch", name: " " })), null);
  assert.equal(branchScopedGitRoomName(null), null);
});

test("gitRoomFromBranchRoomIdentifier decodes branch room ids", () => {
  const branch = "feature/player-3d-presentation";
  const encodedBranch = Buffer.from(branch, "utf8").toString("base64url");

  const local = gitRoomFromBranchRoomIdentifier(`git-room:local:1234567890abcdef:branch:${encodedBranch}`);
  assert.equal(local?.provider, "git");
  assert.equal(local?.host, "local");
  assert.equal(local?.ref.type, "branch");
  assert.equal(local?.ref.name, branch);

  const github = gitRoomFromBranchRoomIdentifier(`git-room:github.com:brosincode/letagents:branch:${encodedBranch}`);
  assert.equal(github?.provider, "github");
  assert.equal(github?.repository.fullName, "brosincode/letagents");
  assert.equal(github?.ref.name, branch);

  assert.equal(gitRoomFromBranchRoomIdentifier("git-room:local:1234567890abcdef:branch:not/canonical"), null);
  assert.equal(gitRoomFromBranchRoomIdentifier("github.com/brosincode/letagents"), null);
});

test("applyManagedAgentBranchScopePreflight allows a matching branch", () => {
  const result = applyManagedAgentBranchScopePreflight({
    providerName: "Cursor",
    preflight: readyPreflight(),
    gitRoom: gitRoom(),
    repoStatus: repoStatus(),
  });

  assert.equal(result.canStart, true);
  assert.equal(result.status, "ready");
});

test("applyManagedAgentBranchScopePreflight leaves default-branch rooms flexible", () => {
  const result = applyManagedAgentBranchScopePreflight({
    providerName: "Cursor",
    preflight: readyPreflight(),
    gitRoom: gitRoom({ type: "default_branch", name: "main" }),
    repoStatus: repoStatus({ branch: "feature/active-work" }),
  });

  assert.equal(result.canStart, true);
  assert.equal(result.status, "ready");

  const localDefaultBranch = applyManagedAgentBranchScopePreflight({
    providerName: "Cursor",
    preflight: readyPreflight(),
    gitRoom: gitRoom({ type: "branch", name: "main", defaultBranch: "main" }),
    repoStatus: repoStatus({ branch: "feature/active-work", defaultBranch: "main" }),
  });

  assert.equal(localDefaultBranch.canStart, true);
  assert.equal(localDefaultBranch.status, "ready");
});

test("applyManagedAgentBranchScopePreflight blocks mismatched and detached branch rooms", () => {
  const mismatched = applyManagedAgentBranchScopePreflight({
    providerName: "Cursor",
    preflight: readyPreflight(),
    gitRoom: gitRoom(),
    repoStatus: repoStatus({ branch: "main" }),
  });
  assert.equal(mismatched.canStart, false);
  assert.equal(mismatched.status, "branch_mismatch");
  assert.equal(mismatched.nextAction, "choose_worktree");
  assert.match(mismatched.detail ?? "", /selected project is on main/);

  const detached = applyManagedAgentBranchScopePreflight({
    providerName: "Cursor",
    preflight: readyPreflight(),
    gitRoom: gitRoom(),
    repoStatus: repoStatus({ branch: null, detached: true }),
  });
  assert.equal(detached.canStart, false);
  assert.equal(detached.status, "branch_mismatch");
  assert.match(detached.detail ?? "", /detached HEAD/);
});

test("provider preflight blocks branch-scoped rooms when the selected worktree is on another branch", async () => {
  const repo = mkdtempSync(join(tmpdir(), "letagents-branch-scope-"));
  const previousSmoke = process.env.LETAGENTS_DESKTOP_SMOKE_CHECK;
  process.env.LETAGENTS_DESKTOP_SMOKE_CHECK = "1";
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repo, stdio: "ignore" });
    const branchRoomIdentifier = `git-room:local:1234567890abcdef:branch:${
      Buffer.from("feature/player-3d-presentation", "utf8").toString("base64url")
    }`;
    const result = await runDesktopAgentProviderPreflight("cursor", {
      roomGitRoom: gitRoom(),
      repoRootPath: repo,
    });

    assert.equal(result.canStart, false);
    assert.equal(result.status, "branch_mismatch");
    assert.equal(result.nextAction, "choose_worktree");

    const resolvedFromIdentifier = await runDesktopAgentProviderPreflight("cursor", {
      roomIdentifier: branchRoomIdentifier,
      repoRootPath: repo,
    });
    assert.equal(resolvedFromIdentifier.canStart, false);
    assert.equal(resolvedFromIdentifier.status, "branch_mismatch");

    const staleRoomMetadata = await runDesktopAgentProviderPreflight("cursor", {
      roomIdentifier: branchRoomIdentifier,
      roomGitRoom: gitRoom({ type: "default_branch", name: "main" }),
      repoRootPath: repo,
    });
    assert.equal(staleRoomMetadata.canStart, false);
    assert.equal(staleRoomMetadata.status, "branch_mismatch");
  } finally {
    if (previousSmoke === undefined) {
      delete process.env.LETAGENTS_DESKTOP_SMOKE_CHECK;
    } else {
      process.env.LETAGENTS_DESKTOP_SMOKE_CHECK = previousSmoke;
    }
    rmSync(repo, { recursive: true, force: true });
  }
});
