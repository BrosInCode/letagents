// ---------------------------------------------------------------------------
// GitHub Repository Visibility Checker
// @module github-visibility
// @author Kingdavid Ehindero <kdof64squares@gmail.com>
// ---------------------------------------------------------------------------
// Checks if a GitHub repository is public by making an unauthenticated
// request to the GitHub API. Returns 'public', 'private', or 'unknown'
// (for non-GitHub repos or network errors).
//
// Used by the MCP server auto-join logic to determine room type:
//   public  → join repo room by name (open access)
//   private → create a join-code room (code-gated access)
//   unknown → fall back to join-code room (safe default)

const GITHUB_API_BASE = "https://api.github.com";

export type RepoVisibility = "public" | "private" | "unknown";

/**
 * Parse a normalized remote identity (e.g. "github.com/owner/repo")
 * into { owner, repo } parts. Returns null for non-GitHub remotes.
 */
export function parseGitHubIdentity(
  normalizedRemote: string
): { owner: string; repo: string } | null {
  // Must start with github.com/
  const match = normalizedRemote.match(/^github\.com\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Check if a GitHub repository is public using the unauthenticated API.
 *
 * Returns:
 *   'public'  — repo exists and is public
 *   'private' — repo exists but is private (returns 404 for unauthenticated)
 *   'unknown' — network error, rate-limited, or not a GitHub repo
 *
 * NOTE: GitHub rate-limits unauthenticated requests to 60/hour per IP.
 * Callers should cache the result for the session duration.
 */
export async function checkGitHubVisibility(
  normalizedRemote: string,
  timeoutMs = 5000
): Promise<RepoVisibility> {
  const parsed = parseGitHubIdentity(normalizedRemote);
  if (!parsed) {
    // Not a GitHub repo — cannot check visibility
    return "unknown";
  }

  const { owner, repo } = parsed;
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "letagents-mcp/0.3.0",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) {
      // 200 — repo is accessible unauthenticated → public
      return "public";
    }

    if (response.status === 404) {
      // 404 for unauthenticated → private repo (or doesn't exist)
      return "private";
    }

    if (response.status === 403 || response.status === 429) {
      // Rate limited — treat as unknown, fall back safely
      console.error(
        `[letagents] GitHub API rate-limited (${response.status}). Falling back to join-code room.`
      );
      return "unknown";
    }

    // Any other status — treat conservatively as unknown
    return "unknown";
  } catch (err) {
    // Network error, timeout, etc.
    console.error("[letagents] GitHub visibility check failed:", err instanceof Error ? err.message : err);
    return "unknown";
  }
}
