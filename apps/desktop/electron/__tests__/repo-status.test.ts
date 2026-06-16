import assert from "node:assert/strict";
import test from "node:test";

import { parseGitWorktreePorcelain } from "../repo-status.js";

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
