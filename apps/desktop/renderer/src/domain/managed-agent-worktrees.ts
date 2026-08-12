export async function openManagedAgentWorktree(input: {
  rootPath: string;
  openWorkspaceGitRoom: (rootPath: string) => Promise<boolean>;
  setReopenAddAgent: (value: boolean) => void;
}): Promise<boolean> {
  input.setReopenAddAgent(false);
  const opened = await input.openWorkspaceGitRoom(input.rootPath);
  if (opened) {
    input.setReopenAddAgent(true);
  }
  return opened;
}

/**
 * Create a worktree for the room's branch and hand it to the regular
 * choose-worktree flow. Returns an error message when creation fails (so the
 * caller can keep its UI open and offer a retry), or null on success.
 */
export async function createManagedAgentWorktree(input: {
  repoRoot: string;
  branch: string;
  createWorktree: (
    repoRoot: string,
    branch: string,
  ) => Promise<{ worktreePath: string | null; error: string | null }>;
  chooseWorktree: (rootPath: string) => void;
}): Promise<string | null> {
  let created: { worktreePath: string | null; error: string | null };
  try {
    created = await input.createWorktree(input.repoRoot, input.branch);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (created.error) {
    return created.error;
  }
  if (!created.worktreePath) {
    return `Could not create a worktree on ${input.branch}.`;
  }
  input.chooseWorktree(created.worktreePath);
  return null;
}
