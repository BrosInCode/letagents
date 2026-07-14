import { lstat, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export type GitCommand = (args: string[]) => Promise<void>;

type RepositoryMarker = { version: 1; repo: string; remote_url: string };
type WorkspaceMarker = { version: 1; repo: string; work_attempt_id: string; task_id: string | null; remote_url: string; revision: string };

const REPOSITORY_MARKER = ".letagents-repository.json";
const WORKSPACE_MARKER = ".letagents-work-attempt.json";

function safeSegment(value: string, label: string): string {
  if (value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Unsafe ${label}.`);
  return value;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sameRecord(value: unknown, expected: Record<string, unknown>): boolean {
  return !!value && typeof value === "object" && Object.entries(expected).every(([key, entry]) => (value as Record<string, unknown>)[key] === entry);
}

/** Keeps supervisor work isolated from any user checkout. */
export class WorkspaceProvisioner {
  constructor(readonly root: string, private readonly git: GitCommand) {}

  workspacePath(repo: string, workAttemptId: string): string {
    return this.insideRoot("worktrees", safeSegment(repo, "repository"), safeSegment(workAttemptId, "work attempt id"));
  }

  async provision(input: { repo: string; workAttemptId: string; taskId?: string; remoteUrl: string; revision: string }): Promise<{ path: string; reused: boolean }> {
    const repo = safeSegment(input.repo, "repository");
    const workAttemptId = safeSegment(input.workAttemptId, "work attempt id");
    const bare = this.insideRoot("repos", `${repo}.git`);
    const workspace = this.workspacePath(repo, workAttemptId);
    const reposRoot = this.insideRoot("repos");
    const worktreesRoot = this.insideRoot("worktrees");
    await this.ensureDirectory(reposRoot, await this.canonicalRoot());
    await this.ensureDirectory(worktreesRoot, await this.canonicalRoot());
    const repoWorktrees = this.insideRoot("worktrees", repo);
    await this.ensureDirectory(repoWorktrees, await this.canonicalRoot());

    const workspaceMarker: WorkspaceMarker = { version: 1, repo, work_attempt_id: workAttemptId, task_id: input.taskId ?? null, remote_url: input.remoteUrl, revision: input.revision };
    if (await this.exists(workspace)) {
      await this.ensureDirectory(workspace, await realpath(repoWorktrees));
      await this.assertMarker(join(workspace, WORKSPACE_MARKER), workspaceMarker, "workspace");
      return { path: workspace, reused: true };
    }

    const repositoryMarker: RepositoryMarker = { version: 1, repo, remote_url: input.remoteUrl };
    if (await this.exists(bare)) {
      await this.ensureDirectory(bare, await realpath(reposRoot));
      await this.assertMarker(join(bare, REPOSITORY_MARKER), repositoryMarker, "bare repository");
    } else {
      await this.git(["clone", "--bare", input.remoteUrl, bare]);
      await this.ensureDirectory(bare, await realpath(reposRoot));
      await this.writeMarker(join(bare, REPOSITORY_MARKER), repositoryMarker);
    }

    await this.git(["--git-dir", bare, "worktree", "add", "--detach", workspace, input.revision]);
    await this.ensureDirectory(workspace, await realpath(repoWorktrees));
    await this.writeMarker(join(workspace, WORKSPACE_MARKER), workspaceMarker);
    return { path: workspace, reused: false };
  }

  private insideRoot(...parts: string[]): string {
    const root = resolve(this.root);
    const candidate = resolve(root, ...parts);
    if (!isAbsolute(candidate) || !inside(root, candidate)) throw new Error("Workspace must remain inside the daemon root.");
    return candidate;
  }

  private async canonicalRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Daemon root must be a non-symlink directory.");
    return realpath(this.root);
  }

  private async ensureDirectory(path: string, root: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const rooted = resolve(this.root);
    const candidate = resolve(path);
    if (!inside(rooted, candidate)) throw new Error("Daemon path escaped its canonical root.");
    let cursor = rooted;
    for (const part of relative(rooted, candidate).split("/").filter(Boolean)) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Daemon paths may not traverse symlinks.");
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Daemon paths must be non-symlink directories.");
    if (!inside(await realpath(root), await realpath(path))) throw new Error("Daemon path escaped its canonical root.");
  }

  private async exists(path: string): Promise<boolean> {
    try { await stat(path); return true; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  private async assertMarker(path: string, expected: Record<string, unknown>, label: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe ${label} identity marker.`);
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error(`Malformed ${label} identity marker.`); }
    if (!sameRecord(parsed, expected)) throw new Error(`${label} identity does not match the requested repository, revision, and attempt.`);
  }

  private async writeMarker(path: string, value: RepositoryMarker | WorkspaceMarker): Promise<void> {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  }
}
