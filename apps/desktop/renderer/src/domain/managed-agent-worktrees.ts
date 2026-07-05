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
