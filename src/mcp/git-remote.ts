// ---------------------------------------------------------------------------
// Git Remote URL Normalization
// @module git-remote
// @author Kingdavid Ehindero <kdof64squares@gmail.com>
// ---------------------------------------------------------------------------
// Normalizes SSH and HTTPS git remote URLs to a canonical form:
//   host/owner/repo
//
// Examples:
//   git@github.com:BrosInCode/letagents.git  → github.com/brosincode/letagents
//   https://github.com/BrosInCode/letagents.git → github.com/brosincode/letagents
//   https://github.com/BrosInCode/letagents → github.com/brosincode/letagents
//   ssh://git@gitlab.com/team/project.git → gitlab.com/team/project

import { execFileSync } from "child_process";

export type GitRefRoomType = "branch" | "tag";

export interface GitRoomContext {
  repoRoom: string | null;
  currentBranch: string | null;
  defaultBranch: string | null;
  activeRefRoomLocator: string | null;
  activeRoomLocator: string | null;
  activeRoomKind: "repo" | "branch" | null;
}

/**
 * Normalize a git remote URL to `host/owner/repo` format.
 * Strips protocol (SSH/HTTPS), user prefix, and `.git` suffix.
 */
export function normalizeGitRemote(url: string): string {
  let normalized = url.trim();

  // Handle SSH format: git@host:owner/repo.git
  const sshMatch = normalized.match(/^[\w-]+@([^:]+):(.+)$/);
  if (sshMatch) {
    normalized = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    // Handle HTTPS/SSH protocol format: https://host/owner/repo.git
    // or ssh://git@host/owner/repo.git
    try {
      const parsed = new URL(normalized);
      const host = parsed.hostname;
      const path = parsed.pathname.replace(/^\//, "");
      normalized = `${host}/${path}`;
    } catch {
      // Not a valid URL — return as-is after stripping .git
    }
  }

  // Strip trailing .git suffix
  normalized = normalized.replace(/\.git$/, "");

  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, "");

  const parts = normalized.split("/");
  const host = parts[0]?.toLowerCase();
  if (host) {
    parts[0] = host;
    normalized = host === "github.com" ? parts.join("/").toLowerCase() : parts.join("/");
  }

  return normalized;
}

function execGit(args: string[], cwd?: string): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return output || null;
  } catch {
    return null;
  }
}

function encodeRefForRoomId(refName: string): string {
  return Buffer.from(refName, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function githubRepositoryFullNameFromRoom(repoRoom: string): string | null {
  const parts = repoRoom.trim().replace(/\/+$/, "").split("/");
  const host = parts[0]?.toLowerCase();
  const owner = parts[1];
  const repo = parts[2];

  if (host !== "github.com" || !owner || !repo || parts.length !== 3) {
    return null;
  }

  return `${owner}/${repo}`;
}

function isLikelyDefaultBranchName(branchName: string | null): boolean {
  return branchName === "main" || branchName === "master" || branchName === "trunk";
}

export function buildGitRefRoomLocator(input: {
  repoRoom: string;
  refType: GitRefRoomType;
  refName: string;
}): string | null {
  const repositoryFullName = githubRepositoryFullNameFromRoom(input.repoRoom);
  const refName = input.refName.trim();
  if (!repositoryFullName || !refName) {
    return null;
  }

  return `github.com/${repositoryFullName.toLowerCase()}/focus/git:${input.refType}:${encodeRefForRoomId(refName)}`;
}

export function getGitCurrentBranch(cwd?: string): string | null {
  return execGit(["branch", "--show-current"], cwd);
}

export function getGitDefaultBranch(cwd?: string): string | null {
  const originHead = execGit(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    cwd
  );
  if (!originHead) return null;

  return originHead.replace(/^origin\//, "") || null;
}

export function buildActiveGitRoomContext(input: {
  repoRoom: string | null;
  currentBranch?: string | null;
  defaultBranch?: string | null;
}): GitRoomContext {
  const currentBranch = input.currentBranch?.trim() || null;
  const defaultBranch = input.defaultBranch?.trim() || null;
  const shouldUseBranchRoom = Boolean(
    input.repoRoom
    && currentBranch
    && (
      defaultBranch
        ? currentBranch !== defaultBranch
        : !isLikelyDefaultBranchName(currentBranch)
    )
  );
  const activeRefRoomLocator =
    input.repoRoom && currentBranch && shouldUseBranchRoom
      ? buildGitRefRoomLocator({
          repoRoom: input.repoRoom,
          refType: "branch",
          refName: currentBranch,
        })
      : null;

  return {
    repoRoom: input.repoRoom,
    currentBranch,
    defaultBranch,
    activeRefRoomLocator,
    activeRoomLocator: activeRefRoomLocator ?? input.repoRoom,
    activeRoomKind: activeRefRoomLocator ? "branch" : input.repoRoom ? "repo" : null,
  };
}

export function getGitRoomContext(cwd?: string): GitRoomContext {
  const repoRoom = getGitRemoteIdentity(cwd);
  return buildActiveGitRoomContext({
    repoRoom,
    currentBranch: getGitCurrentBranch(cwd),
    defaultBranch: getGitDefaultBranch(cwd),
  });
}

/**
 * Get the normalized git remote URL for the current working directory.
 * Returns null if not in a git repo or no remote is configured.
 */
export function getGitRemoteIdentity(cwd?: string): string | null {
  const remoteUrl = execGit(["remote", "get-url", "origin"], cwd);
  return remoteUrl ? normalizeGitRemote(remoteUrl) : null;
}
