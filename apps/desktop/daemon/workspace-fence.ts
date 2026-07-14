import { open, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export class WorkspaceFenceError extends Error {}

/**
 * A daemon-owned, exclusive fence adjacent to a worktree. Every provision,
 * recovery, and destructive operation must hold it for its whole critical
 * section so one attempt cannot be swapped into another's path mid-flight.
 */
export async function withWorkspaceFence<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
  const path = join(dirname(workspacePath), `.${basename(workspacePath)}.letagents-fence`);
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceFenceError(`Workspace is fenced by another daemon operation: ${workspacePath}`);
    throw error;
  }
  try { await handle.sync(); return await operation(); }
  finally {
    await handle.close();
    await rm(path, { force: true });
  }
}
