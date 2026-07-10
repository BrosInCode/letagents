import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type {
  DesktopGitRoomInfo,
  DesktopGitRoomRefType,
  RepoBranchDelta,
  DesktopRepoRoomSelection,
  RepoChangeSummary,
  RepoStatus,
  RepoWorktreeEntry,
} from "./ipc-types.js";
import { runGitStdout } from "./main/git-exec.js";

async function runGit(workspaceRoot: string, args: string[]): Promise<string> {
  return runGitStdout(workspaceRoot, args);
}

async function runGitInPath(cwd: string, args: string[]): Promise<string> {
  return runGitStdout(cwd, args);
}

async function getRepoRoot(workspaceRoot: string): Promise<string | null> {
  try {
    const stdout = await runGitInPath(workspaceRoot, ["rev-parse", "--show-toplevel"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getGitHeadPath(workspaceRoot: string): Promise<string | null> {
  try {
    const stdout = await runGit(workspaceRoot, ["rev-parse", "--git-path", "HEAD"]);
    const headPath = stdout.trim();
    if (!headPath) return null;
    return resolve(workspaceRoot, headPath);
  } catch {
    return null;
  }
}

async function getCurrentBranch(workspaceRoot: string): Promise<string | null> {
  try {
    const stdout = await runGit(workspaceRoot, ["branch", "--show-current"]);
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

async function getRebaseHeadBranch(workspaceRoot: string): Promise<string | null> {
  for (const relativePath of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
    try {
      const stdout = await runGit(workspaceRoot, ["rev-parse", "--git-path", relativePath]);
      const rebaseHeadPath = resolve(workspaceRoot, stdout.trim());
      if (!existsSync(rebaseHeadPath)) continue;
      const branch = readFileSync(rebaseHeadPath, "utf8")
        .trim()
        .replace(/^refs\/heads\//, "");
      if (branch) return branch;
    } catch {
      // Try the next rebase state path.
    }
  }
  return null;
}

async function getRoutingBranch(workspaceRoot: string): Promise<string | null> {
  return (await getCurrentBranch(workspaceRoot)) || await getRebaseHeadBranch(workspaceRoot);
}

async function getLocalBranches(workspaceRoot: string): Promise<string[]> {
  try {
    const stdout = await runGit(workspaceRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    return stdout.split(/\r?\n/)
      .map((branch) => branch.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function fallbackDefaultBranch(localBranches: string[]): string | null {
  for (const candidate of ["main", "master", "trunk", "develop"]) {
    if (localBranches.includes(candidate)) return candidate;
  }
  return null;
}

async function getRemoteDefaultBranch(workspaceRoot: string): Promise<string | null> {
  try {
    const stdout = await runGit(workspaceRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    return stdout.trim().replace(/^origin\//, "") || null;
  } catch {
    return null;
  }
}

async function getDefaultBranch(
  workspaceRoot: string,
  localBranches: string[] = [],
): Promise<string | null> {
  return await getRemoteDefaultBranch(workspaceRoot) || fallbackDefaultBranch(localBranches);
}

export function parseGitWorktreePorcelain(stdout: string, workspaceRoot: string): RepoWorktreeEntry[] {
  const lines = stdout.split(/\r?\n/);
  const entries: RepoWorktreeEntry[] = [];
  let current: Partial<RepoWorktreeEntry> | null = null;

  const pushCurrent = () => {
    if (current?.path && current.head) {
      entries.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head,
        isCurrent: current.path === workspaceRoot,
        isMain: entries.length === 0,
      });
    }
    current = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      pushCurrent();
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      pushCurrent();
      current = { path: value };
    } else if (current && key === "HEAD") {
      current.head = value;
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    }
  }

  pushCurrent();

  return entries;
}

async function getWorktrees(workspaceRoot: string): Promise<RepoWorktreeEntry[]> {
  try {
    const stdout = await runGit(workspaceRoot, ["worktree", "list", "--porcelain"]);
    return parseGitWorktreePorcelain(stdout, workspaceRoot);
  } catch {
    return [];
  }
}

/**
 * Resolve the stable repository root shared by every worktree of a repo.
 *
 * `git rev-parse --show-toplevel` returns the *current* worktree's root, so a
 * linked worktree (`git worktree add`) reports a different path than the main
 * checkout. Keying a local room off that path would split one repository into N
 * rooms. `--git-common-dir` points every worktree at the same `.git` directory,
 * whose parent is the main worktree root; we fall back to the worktree list's
 * main entry, then to the passed-in root for bare/unusual layouts.
 */
async function getMainWorktreeRoot(worktreeRoot: string): Promise<string> {
  try {
    const stdout = await runGitInPath(worktreeRoot, ["rev-parse", "--git-common-dir"]);
    const commonDir = stdout.trim();
    if (commonDir) {
      const absoluteCommonDir = resolve(worktreeRoot, commonDir);
      if (basename(absoluteCommonDir) === ".git") {
        return dirname(absoluteCommonDir);
      }
    }
  } catch {
    // Fall back to the worktree list below.
  }
  try {
    const stdout = await runGitInPath(worktreeRoot, ["worktree", "list", "--porcelain"]);
    const main = parseGitWorktreePorcelain(stdout, worktreeRoot).find((entry) => entry.isMain);
    if (main?.path) return resolve(main.path);
  } catch {
    // Fall back to the worktree root.
  }
  return resolve(worktreeRoot);
}

export type ParsedGitStatus = {
  head: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: RepoChangeSummary;
  dirty: boolean;
};

function emptyChangeSummary(): RepoChangeSummary {
  return {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  };
}

export function parseGitShortStat(
  stdout: string,
  baseBranch: string | null,
  branch: string | null = null,
): RepoBranchDelta {
  const text = stdout.trim();
  const filesMatch = /(\d+)\s+files?\s+changed/.exec(text);
  const insertionsMatch = /(\d+)\s+insertions?\(\+\)/.exec(text);
  const deletionsMatch = /(\d+)\s+deletions?\(-\)/.exec(text);
  return {
    branch,
    filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    additions: insertionsMatch ? Number(insertionsMatch[1]) : 0,
    deletions: deletionsMatch ? Number(deletionsMatch[1]) : 0,
    baseBranch,
  };
}

async function getBranchDelta(
  workspaceRoot: string,
  branch: string | null,
  defaultBranch: string | null,
): Promise<RepoBranchDelta | null> {
  if (!branch || !defaultBranch) return null;
  if (branch === defaultBranch) {
    return { branch, filesChanged: 0, additions: 0, deletions: 0, baseBranch: defaultBranch };
  }
  try {
    const stdout = await runGit(workspaceRoot, [
      "--no-optional-locks",
      "diff",
      "--shortstat",
      "--merge-base",
      defaultBranch,
      branch,
      "--",
    ]);
    return parseGitShortStat(stdout, defaultBranch, branch);
  } catch {
    return null;
  }
}

async function getKnownBranchDeltas(
  workspaceRoot: string,
  branches: Array<string | null | undefined>,
  defaultBranch: string | null,
): Promise<RepoBranchDelta[]> {
  const uniqueBranches = [...new Set(branches.map((branch) => branch?.trim()).filter(Boolean) as string[])];
  const deltas: Array<RepoBranchDelta | null> = [];
  for (const branch of uniqueBranches) {
    deltas.push(await getBranchDelta(workspaceRoot, branch, defaultBranch));
  }
  return deltas.filter((delta): delta is RepoBranchDelta => Boolean(delta));
}

export function parseGitStatusPorcelainV2(stdout: string): ParsedGitStatus {
  const changes = emptyChangeSummary();
  let head: string | null = null;
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      head = oid && oid !== "(initial)" ? oid : null;
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const name = line.slice("# branch.head ".length).trim();
      detached = name === "(detached)";
      branch = detached ? null : name || null;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /^\# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) {
        ahead = Number(match[1] || 0);
        behind = Number(match[2] || 0);
      }
      continue;
    }
    if (line.startsWith("? ")) {
      changes.untracked += 1;
      continue;
    }
    if (line.startsWith("u ")) {
      changes.conflicted += 1;
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const stagedState = line[2];
      const unstagedState = line[3];
      if (stagedState && stagedState !== ".") changes.staged += 1;
      if (unstagedState && unstagedState !== ".") changes.unstaged += 1;
    }
  }

  return {
    head,
    branch,
    detached,
    upstream,
    ahead,
    behind,
    changes,
    dirty: changes.staged > 0
      || changes.unstaged > 0
      || changes.untracked > 0
      || changes.conflicted > 0,
  };
}

async function getStatusPorcelain(workspaceRoot: string): Promise<ParsedGitStatus> {
  try {
    const stdout = await runGit(workspaceRoot, [
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
    ]);
    return parseGitStatusPorcelainV2(stdout);
  } catch {
    return {
      head: null,
      branch: await getCurrentBranch(workspaceRoot),
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: emptyChangeSummary(),
      dirty: false,
    };
  }
}

export async function buildRepoStatus(workspaceRoot: string): Promise<RepoStatus> {
  const repoRoot = await getRepoRoot(workspaceRoot);
  if (!repoRoot) {
    return {
      rootPath: workspaceRoot,
      mainRootPath: workspaceRoot,
      isGitRepo: false,
      gitHeadPath: null,
      head: null,
      branch: null,
      detached: false,
      defaultBranch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: emptyChangeSummary(),
      branchDelta: null,
      branchDeltas: [],
      dirty: false,
      roomIdentifier: null,
      roomSource: "local_folder",
      worktrees: [],
    };
  }

  const [worktrees, gitStatus, localBranches, headPath, resolvedRoom] = await Promise.all([
    getWorktrees(repoRoot),
    getStatusPorcelain(repoRoot),
    getLocalBranches(repoRoot),
    getGitHeadPath(repoRoot),
    resolveRoomIdentifierFromPath(repoRoot),
  ]);
  const defaultBranch = await getDefaultBranch(repoRoot, localBranches);

  const branchDeltas = await getKnownBranchDeltas(
    repoRoot,
    [defaultBranch, gitStatus.branch, ...worktrees.map((worktree) => worktree.branch)],
    defaultBranch,
  );
  const branchDelta = branchDeltas.find((delta) => delta.branch === gitStatus.branch) ?? null;

  return {
    rootPath: repoRoot,
    mainRootPath: worktrees.find((worktree) => worktree.isMain)?.path ?? repoRoot,
    isGitRepo: true,
    gitHeadPath: headPath,
    head: gitStatus.head,
    branch: gitStatus.branch,
    detached: gitStatus.detached,
    defaultBranch,
    upstream: gitStatus.upstream,
    ahead: gitStatus.ahead,
    behind: gitStatus.behind,
    changes: gitStatus.changes,
    branchDelta,
    branchDeltas,
    dirty: gitStatus.dirty,
    roomIdentifier: resolvedRoom.roomIdentifier,
    roomSource: resolvedRoom.source,
    worktrees,
  };
}
/**
 * Normalize the casing of a `host/owner/repo` room identifier derived from a git
 * remote. Hostnames are always case-insensitive, so they are safe to lowercase.
 * GitHub owner/repo names are also case-insensitive, so we lowercase the path for
 * github.com to keep two differently-cased clones in the same repo-level room
 * (branch rooms are already lowercased downstream). Other hosts may be
 * case-sensitive, so their path casing is preserved.
 */
function normalizeDerivedRoomIdentifierCasing(identifier: string): string {
  const trimmed = identifier.trim().replace(/\/+$/, "");
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex < 0) return trimmed.toLowerCase();
  const host = trimmed.slice(0, slashIndex).toLowerCase();
  const rest = trimmed.slice(slashIndex + 1);
  return host === "github.com" ? `${host}/${rest.toLowerCase()}` : `${host}/${rest}`;
}

export function normalizeGitRemoteToRoomIdentifier(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;

  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  if (sshMatch) {
    return normalizeDerivedRoomIdentifierCasing(
      `${sshMatch[1]}/${sshMatch[2]}`.replace(/\.git$/, ""),
    );
  }

  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    return normalizeDerivedRoomIdentifierCasing(
      `${url.hostname}${url.pathname}`.replace(/\.git$/, "").replace(/\/+$/, ""),
    );
  } catch {
    return null;
  }
}

export function readConfiguredRoomIdentifier(workspaceRoot: string): string | null {
  return readConfiguredRoomIdentifierAt(workspaceRoot);
}

function readConfiguredRoomIdentifierAt(repoRoot: string): string | null {
  try {
    const configPath = join(repoRoot, ".letagents.json");
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { room?: string };
    return parsed.room?.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveRoomIdentifier(workspaceRoot: string): Promise<string | null> {
  return (await resolveWorkspaceRoom(workspaceRoot))?.roomIdentifier || null;
}

export async function resolveWorkspaceRoom(workspaceRoot: string): Promise<{
  repoRoot: string;
  roomIdentifier: string;
  source: DesktopRepoRoomSelection["source"];
  gitRoom: DesktopGitRoomInfo | null;
} | null> {
  const resolved = await resolveRoomIdentifierFromPath(workspaceRoot);
  if (!resolved.repoRoot || resolved.source === "local_folder") return null;
  return {
    repoRoot: resolved.repoRoot,
    roomIdentifier: resolved.roomIdentifier,
    source: resolved.source,
    gitRoom: resolved.gitRoom,
  };
}

function slugifyLocalProjectName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "project";
}

function createLocalRoomIdentifier(projectPath: string): string {
  const normalizedPath = resolve(projectPath);
  const folderName = slugifyLocalProjectName(basename(normalizedPath));
  const pathHash = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 10);
  return `local-${folderName}-${pathHash}`;
}

function encodeRefForRoomId(refName: string): string {
  return Buffer.from(refName, "utf8").toString("base64url");
}

function repoRootKey(repoRoot: string): string {
  return createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 16);
}

function githubRepositoryFullNameFromRoom(repoRoom: string | null | undefined): string | null {
  const parts = repoRoom?.trim().replace(/\/+$/, "").split("/") || [];
  const [host, owner, repo] = parts;
  if (host?.toLowerCase() !== "github.com" || !owner || !repo || parts.length !== 3) {
    return null;
  }
  return `${owner}/${repo}`;
}

function isLikelyDefaultBranchName(branchName: string | null): boolean {
  return branchName === "main" || branchName === "master" || branchName === "trunk";
}

function shouldUseBranchRoom(input: {
  currentBranch: string | null;
  defaultBranch: string | null;
}): boolean {
  const currentBranch = input.currentBranch?.trim() || null;
  const defaultBranch = input.defaultBranch?.trim() || null;
  return Boolean(
    currentBranch && (
      defaultBranch
        ? currentBranch !== defaultBranch
        : !isLikelyDefaultBranchName(currentBranch)
    ),
  );
}

export function buildGitHubBranchRoomIdentifier(
  repoRoom: string | null,
  branchName: string | null,
): string | null {
  const repositoryFullName = githubRepositoryFullNameFromRoom(repoRoom);
  const refName = branchName?.trim();
  if (!repositoryFullName || !refName) return null;
  return `git-room:github.com:${repositoryFullName.toLowerCase()}:branch:${encodeRefForRoomId(refName)}`;
}

export function activeGitHubRoomIdentifier(input: {
  repoRoom: string | null;
  currentBranch: string | null;
  defaultBranch: string | null;
}): string | null {
  if (!input.repoRoom) return null;
  return shouldUseBranchRoom(input)
    ? buildGitHubBranchRoomIdentifier(input.repoRoom, input.currentBranch)
    : input.repoRoom;
}

export function buildLocalGitRoomIdentifier(
  repoRoot: string,
  activeRef: string | null,
): string {
  const refName = activeRef?.trim();
  const suffix = refName
    ? `branch:${encodeRefForRoomId(refName)}`
    : "repo";
  return `git-room:local:${repoRootKey(repoRoot)}:${suffix}`;
}

export function buildLocalGitRoomInfo(input: {
  repoRoot: string;
  currentBranch: string | null;
  defaultBranch: string | null;
}): DesktopGitRoomInfo {
  const repoName = basename(resolve(input.repoRoot)) || "Repository";
  const branchName = input.currentBranch?.trim() || null;
  const defaultBranch = input.defaultBranch?.trim() || null;
  const refType: DesktopGitRoomRefType = branchName ? "branch" : "default_branch";
  return {
    provider: "git",
    host: "local",
    repository: {
      id: `local:${repoRootKey(input.repoRoot)}`,
      fullName: repoName,
      owner: "local",
      name: repoName,
    },
    ref: {
      type: refType,
      name: branchName,
      defaultBranch,
      baseRef: defaultBranch,
      headRef: branchName,
      headRepository: null,
    },
    visibility: "local",
    accessMode: "local",
    isDefault: Boolean(
      branchName && (
        defaultBranch
          ? branchName === defaultBranch
          : isLikelyDefaultBranchName(branchName)
      ),
    ),
    source: "local_git",
  };
}

export async function resolveRoomIdentifierFromPath(folderPath: string): Promise<{
  repoRoot: string | null;
  roomIdentifier: string;
  source: DesktopRepoRoomSelection["source"];
  gitRoom: DesktopGitRoomInfo | null;
  warning: string | null;
}> {
  let repoRoot: string | null = null;
  try {
    const stdout = await runGitInPath(folderPath, ["rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim() || null;
  } catch {
    return {
      repoRoot: null,
      roomIdentifier: createLocalRoomIdentifier(folderPath),
      source: "local_folder",
      gitRoom: null,
      warning: "This folder is not a Git repository. LetAgents opened a plain local folder room.",
    };
  }

  if (!repoRoot) {
    return {
      repoRoot: null,
      roomIdentifier: createLocalRoomIdentifier(folderPath),
      source: "local_folder",
      gitRoom: null,
      warning: "This folder is not a Git repository. LetAgents opened a plain local folder room.",
    };
  }

  const [currentBranch, localBranches, routingDefaultBranch] = await Promise.all([
    getRoutingBranch(repoRoot),
    getLocalBranches(repoRoot),
    getRemoteDefaultBranch(repoRoot),
  ]);
  const defaultBranch = await getDefaultBranch(repoRoot, localBranches);

  const configured = readConfiguredRoomIdentifierAt(repoRoot);
  if (configured) {
    return {
      repoRoot,
      roomIdentifier: activeGitHubRoomIdentifier({
        repoRoom: configured,
        currentBranch,
        defaultBranch: routingDefaultBranch,
      }) || configured,
      source: "configured",
      gitRoom: null,
      warning: null,
    };
  }

  try {
    const stdout = await runGitInPath(repoRoot, ["remote", "get-url", "origin"]);
    const repoRoom = normalizeGitRemoteToRoomIdentifier(stdout);
    if (repoRoom) {
      return {
        repoRoot,
        roomIdentifier: activeGitHubRoomIdentifier({
          repoRoom,
          currentBranch,
          defaultBranch: routingDefaultBranch,
        }) || repoRoom,
        source: "git_remote",
        gitRoom: null,
        warning: null,
      };
    }
  } catch {
    // Fall through to the local Git room below.
  }

  // Local-only repos are keyed by a hash of the repository root. Normalize to the
  // main worktree root so a linked worktree resolves to the same room as the main
  // checkout. The returned `repoRoot` stays the actually-opened worktree root.
  const identityRoot = await getMainWorktreeRoot(repoRoot);
  return {
    repoRoot,
    roomIdentifier: buildLocalGitRoomIdentifier(identityRoot, currentBranch),
    source: "local_git",
    gitRoom: buildLocalGitRoomInfo({ repoRoot: identityRoot, currentBranch, defaultBranch }),
    warning: null,
  };
}
