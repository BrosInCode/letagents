import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activeGitHubRoomIdentifier,
  buildLocalGitRoomIdentifier,
  buildLocalGitRoomInfo,
  buildRepoStatus,
  parseGitStatusPorcelainV2,
  parseGitWorktreePorcelain,
  resolveRoomIdentifierFromPath,
  resolveWorkspaceRoom,
} from "../repo-status.js";

test("parseGitWorktreePorcelain marks the first worktree as the main checkout", () => {
  const worktrees = parseGitWorktreePorcelain([
    "worktree /Users/emmy/Projects/letagents",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/staging",
    "",
    "worktree /Users/emmy/Projects/letagents-task-170",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/codex/desktop-codex-room-agents",
    "",
  ].join("\n"), "/Users/emmy/Projects/letagents-task-170");

  assert.equal(worktrees[0]?.path, "/Users/emmy/Projects/letagents");
  assert.equal(worktrees[0]?.isMain, true);
  assert.equal(worktrees[0]?.isCurrent, false);
  assert.equal(worktrees[1]?.path, "/Users/emmy/Projects/letagents-task-170");
  assert.equal(worktrees[1]?.isMain, false);
  assert.equal(worktrees[1]?.isCurrent, true);
});

test("activeGitHubRoomIdentifier routes non-default branches to GitHub branch rooms", () => {
  assert.equal(
    activeGitHubRoomIdentifier({
      repoRoom: "github.com/BrosInCode/letagents",
      currentBranch: "feature/git-rooms",
      defaultBranch: "main",
    }),
    "git-room:github.com:brosincode/letagents:branch:ZmVhdHVyZS9naXQtcm9vbXM",
  );

  assert.equal(
    activeGitHubRoomIdentifier({
      repoRoom: "github.com/BrosInCode/letagents",
      currentBranch: "main",
      defaultBranch: "main",
    }),
    "github.com/BrosInCode/letagents",
  );
});

test("parseGitStatusPorcelainV2 extracts branch sync and change counts", () => {
  const status = parseGitStatusPorcelainV2([
    "# branch.oid 1111111111111111111111111111111111111111",
    "# branch.head codex/git-room-status-watch",
    "# branch.upstream origin/codex/git-room-status-watch",
    "# branch.ab +2 -1",
    "1 M. N... 100644 100644 100644 a a tracked.ts",
    "1 .M N... 100644 100644 100644 a a edited.ts",
    "u UU N... 100644 100644 100644 100644 a a a conflict.ts",
    "? new.ts",
  ].join("\n"));

  assert.equal(status.head, "1111111111111111111111111111111111111111");
  assert.equal(status.branch, "codex/git-room-status-watch");
  assert.equal(status.detached, false);
  assert.equal(status.upstream, "origin/codex/git-room-status-watch");
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.deepEqual(status.changes, {
    staged: 1,
    unstaged: 1,
    untracked: 1,
    conflicted: 1,
  });
  assert.equal(status.dirty, true);
});

test("parseGitStatusPorcelainV2 treats detached HEAD as a non-branch state", () => {
  const status = parseGitStatusPorcelainV2([
    "# branch.oid 2222222222222222222222222222222222222222",
    "# branch.head (detached)",
  ].join("\n"));

  assert.equal(status.branch, null);
  assert.equal(status.detached, true);
  assert.equal(status.dirty, false);
});

test("local Git room ids are deterministic from repo root and active ref", () => {
  const branch = "feature/player-3d-presentation";
  const first = buildLocalGitRoomIdentifier("/Users/emmy/Projects/FBRF", branch);
  const second = buildLocalGitRoomIdentifier("/Users/emmy/Projects/FBRF", branch);

  assert.equal(first, second);
  assert.match(
    first,
    /^git-room:local:[a-f0-9]{16}:branch:ZmVhdHVyZS9wbGF5ZXItM2QtcHJlc2VudGF0aW9u$/,
  );
});

test("buildLocalGitRoomInfo emits local access and branch metadata", () => {
  const gitRoom = buildLocalGitRoomInfo({
    repoRoot: "/Users/emmy/Projects/FBRF",
    currentBranch: "feature/player-3d-presentation",
    defaultBranch: "main",
  });

  assert.equal(gitRoom.provider, "git");
  assert.equal(gitRoom.host, "local");
  assert.equal(gitRoom.repository.fullName, "FBRF");
  assert.equal(gitRoom.ref.type, "branch");
  assert.equal(gitRoom.ref.name, "feature/player-3d-presentation");
  assert.equal(gitRoom.visibility, "local");
  assert.equal(gitRoom.accessMode, "local");
  assert.equal(gitRoom.source, "local_git");
});

test("resolveRoomIdentifierFromPath opens no-remote repositories as local Git rooms", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-local-git-room-"));
  try {
    execFileSync("git", ["init", "-b", "feature/player-3d-presentation"], {
      cwd: tempDir,
      stdio: "ignore",
    });

    const resolved = await resolveRoomIdentifierFromPath(tempDir);

    assert.equal(resolved.repoRoot, realpathSync(tempDir));
    assert.equal(resolved.source, "local_git");
    assert.equal(resolved.warning, null);
    assert.match(resolved.roomIdentifier, /^git-room:local:[a-f0-9]{16}:branch:/);
    assert.equal(resolved.gitRoom?.accessMode, "local");
    assert.equal(resolved.gitRoom?.ref.name, "feature/player-3d-presentation");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveWorkspaceRoom resolves no-remote repositories for lazy auto-open", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-lazy-local-git-room-"));
  try {
    execFileSync("git", ["init", "-b", "feature/lazy-local-git"], {
      cwd: tempDir,
      stdio: "ignore",
    });

    const resolved = await resolveWorkspaceRoom(tempDir);

    assert.equal(resolved?.repoRoot, realpathSync(tempDir));
    assert.equal(resolved?.source, "local_git");
    assert.match(resolved?.roomIdentifier || "", /^git-room:local:[a-f0-9]{16}:branch:/);
    assert.equal(resolved?.gitRoom?.accessMode, "local");
    assert.equal(resolved?.gitRoom?.ref.name, "feature/lazy-local-git");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveWorkspaceRoom routes rebasing worktrees to the original branch room", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-rebase-local-git-room-"));
  try {
    execFileSync("git", ["init", "-b", "feature/rebase-room"], {
      cwd: tempDir,
      stdio: "ignore",
    });
    writeFileSync(join(tempDir, "tracked.txt"), "hello\n");
    execFileSync("git", ["add", "tracked.txt"], {
      cwd: tempDir,
      stdio: "ignore",
    });
    execFileSync("git", [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-m",
      "Initial commit",
    ], {
      cwd: tempDir,
      stdio: "ignore",
    });
    execFileSync("git", ["checkout", "--detach"], {
      cwd: tempDir,
      stdio: "ignore",
    });
    const rebaseDir = join(tempDir, ".git", "rebase-merge");
    mkdirSync(rebaseDir, { recursive: true });
    writeFileSync(join(rebaseDir, "head-name"), "refs/heads/feature/rebase-room\n");

    const [resolved, status] = await Promise.all([
      resolveWorkspaceRoom(tempDir),
      buildRepoStatus(tempDir),
    ]);

    assert.equal(status.detached, true);
    assert.equal(status.branch, null);
    assert.equal(resolved?.gitRoom?.ref.name, "feature/rebase-room");
    assert.match(resolved?.roomIdentifier || "", /branch:ZmVhdHVyZS9yZWJhc2Utcm9vbQ$/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildRepoStatus exposes local Git room routing for no-remote repositories", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "letagents-local-git-status-"));
  try {
    execFileSync("git", ["init", "-b", "feature/git-room-status"], {
      cwd: tempDir,
      stdio: "ignore",
    });
    writeFileSync(join(tempDir, "tracked.txt"), "hello\n");
    execFileSync("git", ["add", "tracked.txt"], {
      cwd: tempDir,
      stdio: "ignore",
    });

    const status = await buildRepoStatus(tempDir);

    assert.equal(status.rootPath, realpathSync(tempDir));
    assert.equal(status.isGitRepo, true);
    assert.equal(status.branch, "feature/git-room-status");
    assert.equal(status.roomSource, "local_git");
    assert.match(status.roomIdentifier || "", /^git-room:local:[a-f0-9]{16}:branch:/);
    assert.equal(status.changes?.staged, 1);
    assert.equal(status.dirty, true);
    assert.ok(status.gitHeadPath?.endsWith(".git/HEAD"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
