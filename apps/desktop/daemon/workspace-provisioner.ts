import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { withWorkspaceFence } from "./workspace-fence.js";

/** Action commands return void; identity queries must return stdout. */
export type GitCommand = (args: string[]) => Promise<string | void>;

const execFileAsync = promisify(execFile);

/**
 * Run every daemon-owned Git command from an explicit stable directory. A
 * long-lived supervisor may outlive the checkout/worktree that launched it;
 * inheriting that deleted cwd makes even `git --git-dir ...` fail before Git
 * can inspect the daemon-owned repository.
 */
export function createGitCommand(stableCwd: string): GitCommand {
  const cwd = resolve(stableCwd);
  return async (args) => {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  };
}

/**
 * A supervised launch names a source repository (the selected local project
 * folder) that LetAgents copies into a private per-agent worktree. When that
 * folder is not a usable git repository — the home directory, a plain folder,
 * or one with no commits yet — we must fail
 * with an actionable message instead of leaking a raw `git` error.
 */
export class UnusableSourceRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableSourceRepositoryError";
  }
}

/** Temporary transport failures use the scheduler's bounded startup recovery. */
export class RepositoryNetworkError extends Error {
  readonly transientProviderStart = true;

  constructor(cause: unknown) {
    super("LetAgents could not reach the Git remote to prepare this workspace. Check your network or VPN connection, then recover the agent if automatic retries do not succeed.", { cause });
    this.name = "RepositoryNetworkError";
  }
}

/**
 * Validate the source repository and return the identity the provisioner needs
 * (`origin` remote URL or canonical local Git root, plus HEAD commit).
 * Throws {@link UnusableSourceRepositoryError}
 * — never a raw git failure — when the path cannot back a private project area.
 */
export async function resolveSourceRepositoryIdentity(
  sourcePath: string,
  gitCommand: GitCommand,
): Promise<{ remoteUrl: string; revision: string }> {
  let insideWorkTree = "";
  try {
    insideWorkTree = String(
      (await gitCommand(["-C", sourcePath, "rev-parse", "--is-inside-work-tree"])) ?? "",
    ).trim();
  } catch {
    // A missing directory or non-repo makes `git` exit non-zero; treat both as
    // "not a usable repo" and report the path rather than the git stderr.
    insideWorkTree = "";
  }
  if (insideWorkTree !== "true") {
    throw new UnusableSourceRepositoryError(
      `The selected project folder is not a git repository: ${sourcePath}. Choose a folder that contains a git repository (with a .git directory) for this agent — a plain folder or your home directory can't be used.`,
    );
  }

  let remoteUrl = "";
  try {
    remoteUrl = String(
      (await gitCommand(["-C", sourcePath, "remote", "get-url", "origin"])) ?? "",
    ).trim();
  } catch {
    remoteUrl = "";
  }
  if (!remoteUrl) {
    try {
      // A configured but unreadable origin must not silently change identity.
      const remotes = String((await gitCommand(["-C", sourcePath, "remote"])) ?? "").trim().split(/\s+/);
      if (remotes.includes("origin")) throw new Error("Configured origin is unavailable.");
      const topLevel = String((await gitCommand(["-C", sourcePath, "rev-parse", "--show-toplevel"])) ?? "").trim();
      if (!isAbsolute(topLevel)) throw new Error("Local Git root is unavailable.");
      remoteUrl = await realpath(topLevel);
    } catch {
      throw new UnusableSourceRepositoryError(
        `LetAgents could not identify the git repository at ${sourcePath}. Check that the project folder and its Git configuration are accessible.`,
      );
    }
  }

  let revision = "";
  try {
    revision = String(
      (await gitCommand(["-C", sourcePath, "rev-parse", "--verify", "HEAD^{commit}"])) ?? "",
    ).trim();
  } catch {
    revision = "";
  }
  if (!revision) {
    throw new UnusableSourceRepositoryError(
      `The git repository at ${sourcePath} has no commits yet. Make an initial commit before starting an agent there.`,
    );
  }

  return { remoteUrl, revision };
}

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
/** The daemon's own files in a workspace stay out of an agent's `git status`, `git add` and `git clean`. */
export const WORKSPACE_MARKER_EXCLUDE = [`/${WORKSPACE_MARKER}`, `/${WORKSPACE_MARKER}.*.tmp`] as const;
/** The fetch refspec a normal clone records; `clone --bare` records none. */
const ORIGIN_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
const ORIGIN_FETCH_REFSPEC_VALUE = "^\\+?refs/heads/\\*:refs/remotes/origin/\\*$";
const ORIGIN_FETCH_REFSPEC_PATTERN = new RegExp(ORIGIN_FETCH_REFSPEC_VALUE);

function safeSegment(value: string, label: string): string {
  if (value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Unsafe ${label}.`);
  return value;
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** A repository that is reached over the network, not a path or a file: URL on this machine. */
export function isNetworkRemote(value: string): boolean {
  const trimmed = value.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme != null) return scheme !== "file";
  // Git's scp-like syntax (git@host:owner/repo) is a network identity too.
  return /^(?:[^/@:\s]+@)?[^/:\s]+:.+$/.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed);
}

export function normalizeRemote(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  // Everything that is not a network identity is a filesystem path, where
  // `repo.git` and `repo` may be two different repositories and must never
  // share daemon storage.
  return isNetworkRemote(trimmed) && trimmed.endsWith(".git")
    ? trimmed.slice(0, -4)
    : trimmed;
}

/** A readable, collision-safe daemon storage key derived from full remote identity. */
export function repositoryStorageKey(remoteUrl: string): string {
  assertCredentialFreeRemote(remoteUrl);
  const normalized = normalizeRemote(remoteUrl);
  if (!normalized) throw new Error("A remote URL is required for repository storage.");
  const tail = normalized.split(/[/:]/).filter(Boolean).at(-1) || "repository";
  const label = tail.replace(/[^A-Za-z0-9._-]/g, "-") || "repository";
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return safeSegment(`${label}-${digest}`, "repository storage key");
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

  async provision(input: { repo: string; workAttemptId: string; taskId: string; remoteUrl: string; revision: string; sourceRepoPath?: string }): Promise<{ path: string; reused: boolean; identity: WorkspaceMarker }> {
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
      let cloned = false;
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
        // Local transport must copy objects, including any borrowed through
        // alternates, instead of hardlinking or inheriting source authority.
        await this.runRemote(["clone", "--bare", ...(isAbsolute(remoteUrl) ? ["--no-local"] : []), input.remoteUrl, bare]);
        await this.ensureDirectory(bare, await realpath(reposRoot));
        await this.verifyBare(await realpath(bare), remoteUrl);
        await this.writeMarker(join(bare, REPOSITORY_MARKER), repositoryMarker);
        cloned = true;
      }
      const fencedBare = await realpath(bare);
      await this.verifyBare(fencedBare, remoteUrl);
      // Also repairs repositories cloned before this existed.
      await this.prepareForAgents(bare, fencedBare, cloned);
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
        await this.ensureRevisionAvailable(canonicalBare, remoteUrl, input.revision);
        // A crash after worktree-add is recoverable: prove the exact expected
        // Git identity, then finish the final marker rather than orphaning it.
        const recovered = await this.resolveIdentity(repo, workAttemptId, input.taskId, remoteUrl, canonicalBare, input.revision, input.sourceRepoPath);
        try {
          await this.verifyWorkspace(workspace, recovered);
          await this.writeMarker(markerPath, recovered);
          return { path: workspace, reused: true, identity: recovered };
        } catch {
          // It is daemon-owned (exact layout + held fence) but cannot prove it
          // is this attempt. Keep it for inspection and make the retry usable.
          await this.quarantineWorkspace(workspace, canonicalBare);
        }
      }

      await this.ensureRevisionAvailable(canonicalBare, remoteUrl, input.revision);
      const identity = await this.resolveIdentity(repo, workAttemptId, input.taskId, remoteUrl, canonicalBare, input.revision, input.sourceRepoPath);
      await this.run(["--git-dir", canonicalBare, "worktree", "add", "--detach", workspace, identity.resolved_revision]);
      await this.ensureDirectory(workspace, await realpath(repoWorktrees));
      await this.verifyWorkspace(workspace, identity);
      // The provisioner writes the complete, final marker atomically before the store may persist an attempt.
      await this.writeMarker(join(workspace, WORKSPACE_MARKER), identity);
      return { path: workspace, reused: false, identity };
    });
  }

  private async resolveIdentity(repo: string, workAttemptId: string, taskId: string, remoteUrl: string, barePath: string, revision: string, sourceRepoPath?: string): Promise<WorkspaceMarker> {
    let resolvedRevision: string;
    try {
      resolvedRevision = await this.query(["--git-dir", barePath, "rev-parse", "--verify", `${revision}^{commit}`]);
    } catch (remoteResolutionError) {
      if (!sourceRepoPath?.trim()) throw remoteResolutionError;
      resolvedRevision = await this.importSourceRevision({
        barePath,
        remoteUrl,
        revision,
        sourceRepoPath,
        workAttemptId,
      });
    }
    await this.run(["--git-dir", barePath, "cat-file", "-e", `${resolvedRevision}^{commit}`]);
    return { version: 1, repo, work_attempt_id: workAttemptId, task_id: taskId, remote_url: remoteUrl, resolved_revision: resolvedRevision, bare_path: barePath };
  }

  /**
   * A feature branch can legitimately contain commits that have not been
   * pushed yet. The daemon still needs an isolated detached worktree, so copy
   * only the already-resolved commit object from the verified local checkout
   * into a daemon-private ref. Never substitute origin's branch tip.
   */
  private async importSourceRevision(input: {
    barePath: string;
    remoteUrl: string;
    revision: string;
    sourceRepoPath: string;
    workAttemptId: string;
  }): Promise<string> {
    const source = await realpath(resolve(input.sourceRepoPath));
    const sourceRemote = normalizeRemote((await resolveSourceRepositoryIdentity(source, this.git)).remoteUrl);
    if (sourceRemote !== input.remoteUrl) throw new Error("Local source repository remote identity does not match the daemon repository.");
    const sourceRevision = await this.query(["-C", source, "rev-parse", "--verify", `${input.revision}^{commit}`]);
    const targetRef = `refs/letagents/sources/${safeSegment(input.workAttemptId, "work attempt id")}`;
    await withWorkspaceFence(input.barePath, async () => {
      await this.verifyBare(input.barePath, input.remoteUrl);
      await this.run([
        "--git-dir", input.barePath,
        "fetch", "--no-tags", "--no-write-fetch-head", source,
        `+${sourceRevision}:${targetRef}`,
      ]);
    });
    const imported = await this.query(["--git-dir", input.barePath, "rev-parse", "--verify", `${targetRef}^{commit}`]);
    if (imported !== sourceRevision) throw new Error("Daemon repository did not import the exact local source revision.");
    return imported;
  }

  private async quarantineWorkspace(workspace: string, bare: string): Promise<void> {
    await rename(workspace, `${workspace}.quarantine.${randomUUID()}`);
    // `worktree add` records its path in the bare repository. Renaming an
    // unprovable partial preserves it for inspection but does not clear that
    // exact registration, so remove only the old daemon-owned path before the
    // retry. Broad `worktree prune` could erase another recoverable attempt.
    await this.run(["--git-dir", bare, "worktree", "remove", "--force", workspace]);
  }

  private async verifyBare(bare: string, remoteUrl: string): Promise<void> {
    if ((await this.query(["--git-dir", bare, "rev-parse", "--is-bare-repository"])) !== "true") throw new Error("Expected daemon repository is not bare.");
    if (normalizeRemote(await this.query(["--git-dir", bare, "remote", "get-url", "origin"])) !== remoteUrl) throw new Error("Bare repository remote identity does not match.");
  }

  /**
   * Agents' worktrees share the bare repository's config and `info/exclude`.
   * Give them what a normal clone has: one standard `origin` fetch refspec
   * (replacing a duplicate an agent added), `origin/<branch>` refs and
   * `origin/HEAD`, so they can branch from and rebase onto the remote's
   * branches. Keep the daemon's marker file out of their commits. This runs
   * under the repository's exclusive fence on every launch, so it never
   * touches the network, and none of it may fail a launch except refusing to
   * write through a symlink.
   */
  private async prepareForAgents(bare: string, canonicalBare: string, cloned: boolean): Promise<void> {
    await this.bestEffort("origin fetch refspec", async () => {
      let refspecs: string[];
      try {
        refspecs = String(await this.git(["--git-dir", canonicalBare, "config", "--get-all", "remote.origin.fetch"]) ?? "").split("\n").filter(Boolean);
      } catch (error) {
        // `config --get-all` exits 1 when the key is unset.
        if ((error as { code?: unknown }).code !== 1) throw error;
        refspecs = [];
      }
      const standard = refspecs.filter((value) => ORIGIN_FETCH_REFSPEC_PATTERN.test(value));
      if (standard.length !== 1 || standard[0] !== ORIGIN_FETCH_REFSPEC) {
        await this.run(["--git-dir", canonicalBare, "config", "--replace-all", "remote.origin.fetch", ORIGIN_FETCH_REFSPEC, ORIGIN_FETCH_REFSPEC_VALUE]);
      }
    });
    await this.bestEffort("origin refs", () => this.ensureOriginRefs(canonicalBare, cloned));
    await this.bestEffort("origin/HEAD", () => this.ensureOriginHead(canonicalBare));
    await this.ensureMarkerExcluded(bare);
  }

  /**
   * Copies branches the repository already has; the agent's own
   * `git fetch origin` brings them up to date. Straight after `clone --bare`
   * its branches are exactly the remote's. Later they also hold agents' own
   * branches, so only the daemon's refreshed copy of the remote's branches
   * is used, when there is one.
   */
  private async ensureOriginRefs(bare: string, cloned: boolean): Promise<void> {
    if (String(await this.git(["--git-dir", bare, "for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes/origin/"]) ?? "").trim()) return;
    const source = cloned ? "refs/heads" : "refs/letagents/remotes/origin";
    // A fetch from the repository's own path copies refs locally, in one
    // command. Atomic, so a crash cannot leave a partial set the guard above
    // would then never complete.
    await this.run(["--git-dir", bare, "fetch", "--quiet", "--atomic", "--no-tags", "--no-write-fetch-head", bare, `+${source}/*:refs/remotes/origin/*`]);
  }

  /**
   * Points origin/HEAD at the bare repository's HEAD, which `clone --bare`
   * copies from the remote's default branch. Nothing moves it afterwards:
   * the daemon doesn't, and an agent's fetch only creates a missing
   * origin/HEAD under Git's default `followRemoteHEAD=create`. It goes stale
   * if the remote renames its default branch, unless that setting is
   * `always`.
   */
  private async ensureOriginHead(bare: string): Promise<void> {
    const succeeds = (args: string[]) => this.run(["--git-dir", bare, ...args]).then(() => true, () => false);
    if (await succeeds(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])) return;
    const head = String(await this.git(["--git-dir", bare, "symbolic-ref", "--quiet", "HEAD"]).catch(() => "") ?? "").trim();
    if (!head.startsWith("refs/heads/")) return;
    const tracking = `refs/remotes/origin/${head.slice("refs/heads/".length)}`;
    // Skipped until the default branch has a tracking ref.
    if (await succeeds(["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`])) {
      await this.run(["--git-dir", bare, "symbolic-ref", "refs/remotes/origin/HEAD", tracking]);
    }
  }

  private async ensureMarkerExcluded(bare: string): Promise<void> {
    const info = join(bare, "info");
    const path = join(info, "exclude");
    for (const candidate of [info, path]) {
      if ((await lstat(candidate).catch(() => null))?.isSymbolicLink()) throw new Error("Daemon paths may not traverse symlinks.");
    }
    await this.bestEffort("marker exclude", async () => {
      await mkdir(info, { recursive: true, mode: 0o700 });
      const existing = await readFile(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      const lines = new Set(existing.split(/\r?\n/));
      const missing = WORKSPACE_MARKER_EXCLUDE.filter((line) => !lines.has(line));
      if (missing.length === 0) return;
      const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(`${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, "utf8"); } finally { await handle.close(); }
    });
  }

  /** Setup that helps agents but is not workspace identity never fails a launch. */
  private async bestEffort(step: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      console.warn(`[workspace_agent_setup] ${step} skipped:`, error instanceof Error ? error.message : String(error));
    }
  }

  private async refreshBare(bare: string): Promise<void> {
    // Refresh every advertised branch and tag into daemon-private namespaces
    // so a long-lived repository can resolve branch-reachable and tag-only
    // source commits created after its initial clone. The static
    // refspec and verified origin prevent callers from selecting another
    // remote or writing arbitrary refs; detached worktrees remain OID-pinned.
    // Git also updates, but does not prune, agents' `origin/*` refs through
    // the configured refspec; their own `git fetch --prune` does.
    await this.runRemote([
      "--git-dir", bare,
      "fetch", "--prune", "--no-tags", "origin",
      "+refs/heads/*:refs/letagents/remotes/origin/*",
      "+refs/tags/*:refs/letagents/tags/*",
    ]);
  }

  private async ensureRevisionAvailable(bare: string, remoteUrl: string, revision: string): Promise<void> {
    // Only immutable, complete object IDs may bypass a remote refresh. A
    // symbolic revision must never silently fall back to a stale cached ref.
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)) {
      try {
        await this.run(["--git-dir", bare, "cat-file", "-e", `${revision}^{commit}`]);
        return;
      } catch { /* Missing object: refresh before resolving/importing it. */ }
    }
    await withWorkspaceFence(bare, async () => {
      await this.verifyBare(bare, remoteUrl);
      await this.refreshBare(bare);
    });
  }

  private async runRemote(args: string[]): Promise<void> {
    try {
      await this.run(args);
    } catch (error) {
      // Inspect transport diagnostics, not Git's generic access-rights hint:
      // permission, identity, and missing-repository failures are not transient.
      const detail = error instanceof Error
        ? String((error as Error & { stderr?: string }).stderr ?? error.message)
        : "";
      if (/connection timed out|operation timed out|connection reset by peer|could not resolve (?:host|hostname)|failed to connect to|network is unreachable|no route to host/i.test(detail)) {
        throw new RepositoryNetworkError(error);
      }
      throw error;
    }
  }

  private async verifyWorkspace(workspace: string, identity: WorkspaceMarker): Promise<void> {
    const common = await this.query(["-C", workspace, "rev-parse", "--git-common-dir"]);
    const commonPath = isAbsolute(common) ? common : resolve(workspace, common);
    if ((await realpath(commonPath)) !== identity.bare_path) throw new Error("Workspace Git common directory does not match its daemon bare repository.");
    if (normalizeRemote(await this.query(["-C", workspace, "remote", "get-url", "origin"])) !== identity.remote_url) throw new Error("Workspace remote identity does not match.");
    const head = await this.query(["-C", workspace, "rev-parse", "--verify", "HEAD^{commit}"]);
    if (head !== identity.resolved_revision) throw new Error("Workspace HEAD is not the provisioned commit.");
    await this.run(["-C", workspace, "cat-file", "-e", `${head}^{commit}`]);
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
