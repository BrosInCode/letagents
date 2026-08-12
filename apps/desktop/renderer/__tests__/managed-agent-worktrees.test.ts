import assert from "node:assert/strict";
import test from "node:test";

import {
  createManagedAgentWorktree,
  openManagedAgentWorktree,
} from "../src/domain/managed-agent-worktrees";

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

test("createManagedAgentWorktree hands the created worktree to the choose flow", async () => {
  const chosen: string[] = [];
  let createArgs: { repoRoot: string; branch: string } | null = null;
  const errorMessage = await createManagedAgentWorktree({
    repoRoot: "/repo",
    branch: "feature/x",
    createWorktree: async (repoRoot, branch) => {
      createArgs = { repoRoot, branch };
      return { worktreePath: "/repo-feature-x", error: null };
    },
    chooseWorktree: (rootPath) => {
      chosen.push(rootPath);
    },
  });

  assert.equal(errorMessage, null);
  assert.deepEqual(createArgs, { repoRoot: "/repo", branch: "feature/x" });
  assert.deepEqual(chosen, ["/repo-feature-x"]);
});

test("createManagedAgentWorktree surfaces the creation error and does not choose", async () => {
  const chosen: string[] = [];
  const errorMessage = await createManagedAgentWorktree({
    repoRoot: "/repo",
    branch: "feature/x",
    createWorktree: async () => ({ worktreePath: null, error: "boom" }),
    chooseWorktree: (rootPath) => {
      chosen.push(rootPath);
    },
  });

  assert.equal(errorMessage, "boom");
  assert.deepEqual(chosen, []);
});

test("createManagedAgentWorktree reports missing paths and thrown errors", async () => {
  const missingPath = await createManagedAgentWorktree({
    repoRoot: "/repo",
    branch: "feature/x",
    createWorktree: async () => ({ worktreePath: null, error: null }),
    chooseWorktree: () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(missingPath, "Could not create a worktree on feature/x.");

  const thrown = await createManagedAgentWorktree({
    repoRoot: "/repo",
    branch: "feature/x",
    createWorktree: async () => {
      throw new Error("ipc unavailable");
    },
    chooseWorktree: () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(thrown, "ipc unavailable");
});
