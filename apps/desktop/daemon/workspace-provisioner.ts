import { lstat, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { withWorkspaceFence } from "./workspace-fence.js";

/** Action commands return void; identity queries must return stdout. */
export type GitCommand = (args: string[]) => Promise<string | void>;

type RepositoryMarker = { version: 1; repo: string; remote_url: string };
export type WorkspaceMarker = {
  version: 1;
  repo: string;
  work_attempt_id: string;
  task_id: string;
  remote_url: string;
  resolved_revision: string;
  bare_path: string;
};

const REPOSITORY_MARKER = ".letagents-repository.json";
export const WORKSPACE_MARKER = ".letagents-work-attempt.json";

function safeSegment(value: string, label: string): string {
  if (value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Unsafe ${label}.`);
  return value;
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function normalizeRemote(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed;
}

export function assertCredentialFreeRemote(value: string): void {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Remote URL is malformed."); }
  if (parsed.username || parsed.password) throw new Error("Remote URLs with userinfo are forbidden in daemon state.");
}

function sameRecord(value: unknown, expected: Record<string, unknown>): boolean {
  return !!value && typeof value === "object" && Object.entries(expected).every(([key, entry]) => (value as Record<string, unknown>)[key] === entry);
}

/** Keeps supervisor work isolated from any user checkout and pins every worktree to an OID. */
export class WorkspaceProvisioner {
  constructor(readonly root: string, private readonly git: GitCommand) {}

  workspacePath(repo: string, workAttemptId: string): string {
    return this.insideRoot("worktrees", safeSegment(repo, "repository"), safeSegment(workAttemptId, "work attempt id"));
  }

  async provision(input: { repo: string; workAttemptId: string; taskId: string; remoteUrl: string; revision: string }): Promise<{ path: string; reused: boolean; identity: WorkspaceMarker }> {
    const repo = safeSegment(input.repo, "repository");
    const workAttemptId = safeSegment(input.workAttemptId, "work attempt id");
    if (!isUuid(workAttemptId)) throw new Error("Work attempt IDs must be supervisor-minted UUIDs.");
    if (!input.taskId.trim()) throw new Error("A task ID is required for a workspace attempt.");
    assertCredentialFreeRemote(input.remoteUrl);
    const remoteUrl = normalizeRemote(input.remoteUrl);
    if (!remoteUrl) throw new Error("A remote URL is required for a workspace attempt.");
    const bare = this.insideRoot("repos", `${repo}.git`);
    const workspace = this.workspacePath(repo, workAttemptId);
    const reposRoot = this.insideRoot("repos");
    const worktreesRoot = this.insideRoot("worktrees");
    const canonicalRoot = await this.canonicalRoot();
    await this.ensureDirectory(reposRoot, canonicalRoot);
    await this.ensureDirectory(worktreesRoot, canonicalRoot);
    const repoWorktrees = this.insideRoot("worktrees", repo);
    await this.ensureDirectory(repoWorktrees, await realpath(worktreesRoot));

    const repositoryMarker: RepositoryMarker = { version: 1, repo, remote_url: remoteUrl };
    await withWorkspaceFence(bare, async () => {
      if (await this.exists(bare)) {
        await this.ensureDirectory(bare, await realpath(reposRoot));
        const markerPath = join(bare, REPOSITORY_MARKER);
        if (await this.exists(markerPath)) await this.assertMarker(markerPath, repositoryMarker, "bare repository");
        else {
          // Recover the narrow clone-before-marker crash window only after
          // proving this is the expected bare repository and origin.
          await this.verifyBare(await realpath(bare), remoteUrl);
          await this.writeMarker(markerPath, repositoryMarker);
        }
      } else {
        await this.run(["clone", "--bare", input.remoteUrl, bare]);
        await this.ensureDirectory(bare, await realpath(reposRoot));
        await this.verifyBare(await realpath(bare), remoteUrl);
        await this.writeMarker(join(bare, REPOSITORY_MARKER), repositoryMarker);
      }
    });
    const canonicalBare = await realpath(bare);
    await this.verifyBare(canonicalBare, remoteUrl);

    return withWorkspaceFence(workspace, async () => {
      if (await this.exists(workspace)) {
        await this.ensureDirectory(workspace, await realpath(repoWorktrees));
        const markerPath = join(workspace, WORKSPACE_MARKER);
        if (await this.exists(markerPath)) {
          const identity = await this.readWorkspaceMarker(markerPath);
          if (identity.repo !== repo || identity.work_attempt_id !== workAttemptId || identity.task_id !== input.taskId
            || identity.remote_url !== remoteUrl || identity.bare_path !== canonicalBare) {
            throw new Error("Workspace identity does not match the requested repository and attempt.");
          }
          await this.verifyWorkspace(workspace, identity);
          return { path: workspace, reused: true, identity };
        }
        // A crash after worktree-add is recoverable: prove the exact expected
        // Git identity, then finish the final marker rather than orphaning it.
        const recovered = await this.resolveIdentity(repo, workAttemptId, input.taskId, remoteUrl, canonicalBare, input.revision);
        await this.verifyWorkspace(workspace, recovered);
        await this.writeMarker(markerPath, recovered);
        return { path: workspace, reused: true, identity: recovered };
      }

      const identity = await this.resolveIdentity(repo, workAttemptId, input.taskId, remoteUrl, canonicalBare, input.revision);
      await this.run(["--git-dir", canonicalBare, "worktree", "add", "--detach", workspace, identity.resolved_revision]);
      await this.ensureDirectory(workspace, await realpath(repoWorktrees));
      await this.verifyWorkspace(workspace, identity);
      // The provisioner writes the complete, final marker atomically before the store may persist an attempt.
      await this.writeMarker(join(workspace, WORKSPACE_MARKER), identity);
      return { path: workspace, reused: false, identity };
    });
  }

  private async resolveIdentity(repo: string, workAttemptId: string, taskId: string, remoteUrl: string, barePath: string, revision: string): Promise<WorkspaceMarker> {
    const resolvedRevision = await this.query(["--git-dir", barePath, "rev-parse", "--verify", `${revision}^{commit}`]);
    await this.query(["--git-dir", barePath, "cat-file", "-e", `${resolvedRevision}^{commit}`]);
    return { version: 1, repo, work_attempt_id: workAttemptId, task_id: taskId, remote_url: remoteUrl, resolved_revision: resolvedRevision, bare_path: barePath };
  }

  private async verifyBare(bare: string, remoteUrl: string): Promise<void> {
    if ((await this.query(["--git-dir", bare, "rev-parse", "--is-bare-repository"])) !== "true") throw new Error("Expected daemon repository is not bare.");
    if (normalizeRemote(await this.query(["--git-dir", bare, "remote", "get-url", "origin"])) !== remoteUrl) throw new Error("Bare repository remote identity does not match.");
  }

  private async verifyWorkspace(workspace: string, identity: WorkspaceMarker): Promise<void> {
    const common = await this.query(["-C", workspace, "rev-parse", "--git-common-dir"]);
    const commonPath = isAbsolute(common) ? common : resolve(workspace, common);
    if ((await realpath(commonPath)) !== identity.bare_path) throw new Error("Workspace Git common directory does not match its daemon bare repository.");
    if (normalizeRemote(await this.query(["-C", workspace, "remote", "get-url", "origin"])) !== identity.remote_url) throw new Error("Workspace remote identity does not match.");
    const head = await this.query(["-C", workspace, "rev-parse", "--verify", "HEAD^{commit}"]);
    if (head !== identity.resolved_revision) throw new Error("Workspace HEAD is not the provisioned commit.");
    await this.query(["-C", workspace, "cat-file", "-e", `${head}^{commit}`]);
  }

  private async run(args: string[]): Promise<void> { await this.git(args); }
  private async query(args: string[]): Promise<string> {
    const result = await this.git(args);
    if (typeof result !== "string" || !result.trim()) throw new Error(`Git identity query did not return stdout: ${args.join(" ")}`);
    return result.trim();
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

  private async readWorkspaceMarker(path: string): Promise<WorkspaceMarker> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe workspace identity marker.");
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Malformed workspace identity marker."); }
    const marker = parsed as Partial<WorkspaceMarker>;
    if (!marker || marker.version !== 1 || !safeSegment(String(marker.repo ?? ""), "repository")
      || !safeSegment(String(marker.work_attempt_id ?? ""), "work attempt id") || typeof marker.task_id !== "string" || !marker.task_id.trim()
      || typeof marker.remote_url !== "string" || !marker.remote_url.trim() || typeof marker.resolved_revision !== "string" || !/^[0-9a-f]{40,64}$/i.test(marker.resolved_revision)
      || typeof marker.bare_path !== "string" || !isAbsolute(marker.bare_path)) throw new Error("Malformed workspace identity marker.");
    assertCredentialFreeRemote(marker.remote_url);
    return { version: 1, repo: marker.repo!, work_attempt_id: marker.work_attempt_id!, task_id: marker.task_id, remote_url: normalizeRemote(marker.remote_url), resolved_revision: marker.resolved_revision, bare_path: resolve(marker.bare_path) };
  }

  private async writeMarker(path: string, value: RepositoryMarker | WorkspaceMarker): Promise<void> {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  }
}
