import assert from "node:assert/strict";
import test from "node:test";

import { openManagedAgentWorktree } from "../src/domain/managed-agent-worktrees";

test("openManagedAgentWorktree reopens Add Agent after a successful worktree open", async () => {
  const reopenStates: boolean[] = [];
  const opened = await openManagedAgentWorktree({
    rootPath: "/repo-feature-worktree",
    openWorkspaceGitRoom: async (rootPath) => rootPath === "/repo-feature-worktree",
    setReopenAddAgent: (value) => {
      reopenStates.push(value);
    },
  });

  assert.equal(opened, true);
  assert.deepEqual(reopenStates, [false, true]);
});

test("openManagedAgentWorktree leaves Add Agent closed when worktree open fails", async () => {
  const reopenStates: boolean[] = [];
  const opened = await openManagedAgentWorktree({
    rootPath: "/repo-feature-worktree",
    openWorkspaceGitRoom: async () => false,
    setReopenAddAgent: (value) => {
      reopenStates.push(value);
    },
  });

  assert.equal(opened, false);
  assert.deepEqual(reopenStates, [false]);
});
