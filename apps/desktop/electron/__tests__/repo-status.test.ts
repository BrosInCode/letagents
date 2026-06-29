import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activeGitHubRoomIdentifier,
  buildLocalGitRoomIdentifier,
  buildLocalGitRoomInfo,
  parseGitWorktreePorcelain,
  resolveRoomIdentifierFromPath,
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
