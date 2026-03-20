// ---------------------------------------------------------------------------
// Repository Visibility Checker (GitHub, GitLab, Bitbucket)
// @module repo-visibility
// @author Kingdavid Ehindero <kdof64squares@gmail.com>
// ---------------------------------------------------------------------------
// Checks if a repository is public by making unauthenticated API requests
// to the appropriate hosting platform. Returns 'public', 'private', or 'unknown'.
//
// Supported platforms:
//   github.com    — GET api.github.com/repos/{owner}/{repo}
//   gitlab.com    — GET gitlab.com/api/v4/projects/{owner}%2F{repo}
//   bitbucket.org — GET api.bitbucket.org/2.0/repositories/{owner}/{repo}
//   others        — returns 'unknown' (safe fallback → join-code room)
//
// Used by the MCP server auto-join logic to determine room type:
//   public  → join repo room by name (open access)
//   private → create a join-code room (code-gated access)
//   unknown → fall back to join-code room (safe default)

export type RepoVisibility = "public" | "private" | "unknown";

export interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Parse a normalized remote identity (e.g. "github.com/owner/repo")
 * into { host, owner, repo } parts.
 * Returns null if the format is unexpected.
 */
export function parseRemoteIdentity(normalizedRemote: string): ParsedRemote | null {
  const match = normalizedRemote.match(/^([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { host: match[1], owner: match[2], repo: match[3] };
}

// ---------------------------------------------------------------------------
// Platform-specific checkers
// ---------------------------------------------------------------------------

async function checkGitHub(
  owner: string,
  repo: string,
  timeoutMs: number
): Promise<RepoVisibility> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "letagents-mcp/0.3.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.ok) return "public";
  if (res.status === 404) return "private";
  if (res.status === 403 || res.status === 429) {
    console.error(`[letagents] GitHub API rate-limited (${res.status})`);
    return "unknown";
  }
  return "unknown";
}

async function checkGitLab(
  owner: string,
  repo: string,
  timeoutMs: number
): Promise<RepoVisibility> {
  // GitLab encodes the full path (owner/repo) as a single parameter
  const encodedPath = encodeURIComponent(`${owner}/${repo}`);
  const url = `https://gitlab.com/api/v4/projects/${encodedPath}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "letagents-mcp/0.3.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.ok) {
    const data = await res.json() as { visibility?: string };
    if (data.visibility === "public") return "public";
    return "private"; // "internal" or "private"
  }
  if (res.status === 404) return "private";
  if (res.status === 429) {
    console.error("[letagents] GitLab API rate-limited (429)");
    return "unknown";
  }
  return "unknown";
}

async function checkBitbucket(
  owner: string,
  repo: string,
  timeoutMs: number
): Promise<RepoVisibility> {
  const url = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "letagents-mcp/0.3.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.ok) {
    const data = await res.json() as { is_private?: boolean };
    return data.is_private ? "private" : "public";
  }
  if (res.status === 404 || res.status === 403) return "private";
  if (res.status === 429) {
    console.error("[letagents] Bitbucket API rate-limited (429)");
    return "unknown";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Check repository visibility for GitHub, GitLab, or Bitbucket repos.
 * For unknown platforms or on errors, returns 'unknown' (safe fallback).
 *
 * NOTE: All platforms rate-limit unauthenticated requests. Cache the result
 * for the session duration to avoid hitting rate limits on restarts.
 */
export async function checkRepoVisibility(
  normalizedRemote: string,
  timeoutMs = 5000
): Promise<RepoVisibility> {
  const parsed = parseRemoteIdentity(normalizedRemote);
  if (!parsed) return "unknown";

  const { host, owner, repo } = parsed;

  try {
    if (host === "github.com") {
      return await checkGitHub(owner, repo, timeoutMs);
    }
    if (host === "gitlab.com") {
      return await checkGitLab(owner, repo, timeoutMs);
    }
    if (host === "bitbucket.org") {
      return await checkBitbucket(owner, repo, timeoutMs);
    }

    // Unknown platform (self-hosted, custom) — safe fallback
    console.error(
      `[letagents] Unknown git host '${host}' — cannot check visibility. Using join-code room.`
    );
    return "unknown";
  } catch (err) {
    console.error("[letagents] Repo visibility check failed:", err instanceof Error ? err.message : err);
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible exports for GitHub-specific usage
// ---------------------------------------------------------------------------

/** @deprecated Use checkRepoVisibility() — supports all platforms */
export const checkGitHubVisibility = (
  normalizedRemote: string,
  timeoutMs?: number
) => checkRepoVisibility(normalizedRemote, timeoutMs);

/** @deprecated Use parseRemoteIdentity() */
export const parseGitHubIdentity = (normalizedRemote: string) => {
  const parsed = parseRemoteIdentity(normalizedRemote);
  if (!parsed || parsed.host !== "github.com") return null;
  return { owner: parsed.owner, repo: parsed.repo };
};
