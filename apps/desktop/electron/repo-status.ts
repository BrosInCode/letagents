import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  DesktopGitRoomInfo,
  DesktopGitRoomRefType,
  DesktopRepoRoomSelection,
  RepoStatus,
  RepoWorktreeEntry,
} from "./ipc-types.js";

const execFileAsync = promisify(execFile);

async function runGit(workspaceRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: workspaceRoot });
  return stdout;
}

async function runGitInPath(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
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

async function getDefaultBranch(workspaceRoot: string): Promise<string | null> {
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

export async function buildRepoStatus(workspaceRoot: string): Promise<RepoStatus> {
  const worktrees = await getWorktrees(workspaceRoot);
  return {
    rootPath: workspaceRoot,
    mainRootPath: worktrees.find((worktree) => worktree.isMain)?.path ?? workspaceRoot,
    branch: await getCurrentBranch(workspaceRoot),
    worktrees,
  };
}
export function normalizeGitRemoteToRoomIdentifier(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;

  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`.replace(/\.git$/, "");
  }

  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    return `${url.hostname}${url.pathname}`.replace(/\.git$/, "").replace(/\/+$/, "");
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
  const configured = readConfiguredRoomIdentifier(workspaceRoot);
  const currentBranch = await getCurrentBranch(workspaceRoot);
  const defaultBranch = await getDefaultBranch(workspaceRoot);
  if (configured) {
    return activeGitHubRoomIdentifier({
      repoRoom: configured,
      currentBranch,
      defaultBranch,
    }) || configured;
  }

  try {
    const stdout = await runGit(workspaceRoot, ["remote", "get-url", "origin"]);
    const repoRoom = normalizeGitRemoteToRoomIdentifier(stdout);
    return activeGitHubRoomIdentifier({
      repoRoom,
      currentBranch,
      defaultBranch,
    }) || repoRoom;
  } catch {
    return null;
  }
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

  const [currentBranch, defaultBranch] = await Promise.all([
    getCurrentBranch(repoRoot),
    getDefaultBranch(repoRoot),
  ]);

  const configured = readConfiguredRoomIdentifierAt(repoRoot);
  if (configured) {
    return {
      repoRoot,
      roomIdentifier: activeGitHubRoomIdentifier({
        repoRoom: configured,
        currentBranch,
        defaultBranch,
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
          defaultBranch,
        }) || repoRoom,
        source: "git_remote",
        gitRoom: null,
        warning: null,
      };
    }
  } catch {
    // Fall through to the local Git room below.
  }

  return {
    repoRoot,
    roomIdentifier: buildLocalGitRoomIdentifier(repoRoot, currentBranch),
    source: "local_git",
    gitRoom: buildLocalGitRoomInfo({ repoRoot, currentBranch, defaultBranch }),
    warning: null,
  };
}
