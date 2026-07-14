import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type GitCommand = (args: string[]) => Promise<void>;

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Unsafe ${label}.`);
  return value;
}

/** Keeps supervisor work isolated from any user checkout. */
export class WorkspaceProvisioner {
  constructor(readonly root: string, private readonly git: GitCommand) {}

  workspacePath(repo: string, workAttemptId: string): string {
    return this.insideRoot("worktrees", safeSegment(repo, "repository"), safeSegment(workAttemptId, "work attempt id"));
  }

  async provision(input: { repo: string; workAttemptId: string; remoteUrl: string; revision: string }): Promise<{ path: string; reused: boolean }> {
    const bare = this.insideRoot("repos", `${safeSegment(input.repo, "repository")}.git`);
    const workspace = this.workspacePath(input.repo, input.workAttemptId);
    await mkdir(this.insideRoot("repos"), { recursive: true, mode: 0o700 });
    await mkdir(this.insideRoot("worktrees", safeSegment(input.repo, "repository")), { recursive: true, mode: 0o700 });
    try { await stat(workspace); return { path: workspace, reused: true }; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await stat(bare); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.git(["clone", "--bare", input.remoteUrl, bare]);
    }
    await this.git(["--git-dir", bare, "worktree", "add", "--detach", workspace, input.revision]);
    return { path: workspace, reused: false };
  }

  private insideRoot(...parts: string[]): string {
    const root = resolve(this.root);
    const candidate = resolve(root, ...parts);
    if (!isAbsolute(candidate) || (candidate !== root && relative(root, candidate).startsWith(".."))) throw new Error("Workspace must remain inside the daemon root.");
    return candidate;
  }
}
