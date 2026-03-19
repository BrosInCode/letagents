// ---------------------------------------------------------------------------
// Task 3: Git Remote URL Normalization
// ---------------------------------------------------------------------------
// Normalizes SSH and HTTPS git remote URLs to a canonical form:
//   host/owner/repo
//
// Examples:
//   git@github.com:EmmyMay/letagents.git  → github.com/EmmyMay/letagents
//   https://github.com/EmmyMay/letagents.git → github.com/EmmyMay/letagents
//   https://github.com/EmmyMay/letagents → github.com/EmmyMay/letagents
//   ssh://git@gitlab.com/team/project.git → gitlab.com/team/project

import { execSync } from "child_process";

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

  return normalized;
}

/**
 * Get the normalized git remote URL for the current working directory.
 * Returns null if not in a git repo or no remote is configured.
 */
export function getGitRemoteIdentity(cwd?: string): string | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!remoteUrl) return null;
    return normalizeGitRemote(remoteUrl);
  } catch {
    // Not a git repo, no remote, or git not installed
    return null;
  }
}
