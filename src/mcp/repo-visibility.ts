// ---------------------------------------------------------------------------
// Task 6: Repo Visibility Auto-Detection
// ---------------------------------------------------------------------------
// Detects whether a git repository is public or private by making
// unauthenticated API calls to the provider (GitHub, GitLab, Bitbucket).
//
// Used in the MCP auto-join flow:
//   1. Detect git remote → normalize to canonical form
//   2. Check visibility → public = discoverable room, private = invite room
//   3. Auto-join or prompt for invite code
//
// Rate limits (unauthenticated):
//   - GitHub:    60 requests/hour
//   - GitLab:    10 requests/second
//   - Bitbucket: 60 requests/hour

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RepoProvider = "github" | "gitlab" | "bitbucket" | "unknown";

export type RepoVisibility = "public" | "private" | "unknown";

export interface VisibilityResult {
  /** Normalized canonical key (e.g. "github.com/owner/repo") */
  canonicalKey: string;
  /** Detected provider */
  provider: RepoProvider;
  /** Visibility: public, private, or unknown (if detection failed) */
  visibility: RepoVisibility;
  /** Suggested room type based on visibility */
  roomType: "discoverable" | "invite";
  /** Error message if detection failed */
  error?: string;
}

// ---------------------------------------------------------------------------
// Provider Detection
// ---------------------------------------------------------------------------

/**
 * Detect the git provider from a canonical key (host/owner/repo).
 */
export function detectProvider(canonicalKey: string): RepoProvider {
  const host = canonicalKey.split("/")[0]?.toLowerCase();

  if (!host) return "unknown";
  if (host === "github.com") return "github";
  if (host === "gitlab.com") return "gitlab";
  if (host === "bitbucket.org") return "bitbucket";

  return "unknown";
}

/**
 * Extract owner and repo from a canonical key.
 * canonical key format: host/owner/repo
 */
export function extractOwnerRepo(
  canonicalKey: string
): { owner: string; repo: string } | null {
  const parts = canonicalKey.split("/");
  // Need at least host/owner/repo
  if (parts.length < 3) return null;

  const owner = parts[1];
  const repo = parts.slice(2).join("/"); // handle nested paths (e.g. GitLab groups)

  if (!owner || !repo) return null;
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// Provider-Specific Visibility Checkers
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 10000; // 10s timeout for API calls

/**
 * Check GitHub repo visibility.
 * Uses GET /repos/{owner}/{repo} — 200 = public, 404 = private/nonexistent.
 */
async function checkGitHub(owner: string, repo: string): Promise<RepoVisibility> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "letagents-mcp/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );

    if (res.status === 200) return "public";
    if (res.status === 404) return "private"; // private or doesn't exist
    if (res.status === 403) return "unknown"; // rate limited

    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Check GitLab repo visibility.
 * Uses GET /api/v4/projects/{encoded-path} — returns visibility field.
 */
async function checkGitLab(owner: string, repo: string): Promise<RepoVisibility> {
  try {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const res = await fetch(
      `https://gitlab.com/api/v4/projects/${projectPath}`,
      {
        method: "GET",
        headers: {
          "User-Agent": "letagents-mcp/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );

    if (res.status === 404) return "private";
    if (!res.ok) return "unknown";

    const data = (await res.json()) as { visibility?: string };
    if (data.visibility === "public") return "public";
    if (data.visibility === "internal" || data.visibility === "private")
      return "private";

    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Check Bitbucket repo visibility.
 * Uses GET /2.0/repositories/{owner}/{repo} — returns is_private field.
 */
async function checkBitbucket(owner: string, repo: string): Promise<RepoVisibility> {
  try {
    const res = await fetch(
      `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        method: "GET",
        headers: {
          "User-Agent": "letagents-mcp/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );

    if (res.status === 404) return "private";
    if (!res.ok) return "unknown";

    const data = (await res.json()) as { is_private?: boolean };
    if (typeof data.is_private === "boolean") {
      return data.is_private ? "private" : "public";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Main Visibility Check
// ---------------------------------------------------------------------------

/**
 * Check the visibility of a repository given its canonical key.
 *
 * @param canonicalKey - Normalized git remote (e.g. "github.com/owner/repo")
 * @returns VisibilityResult with provider, visibility, and suggested room type
 */
export async function checkRepoVisibility(
  canonicalKey: string
): Promise<VisibilityResult> {
  const provider = detectProvider(canonicalKey);
  const ownerRepo = extractOwnerRepo(canonicalKey);

  // Unknown provider — default to invite room (safe fallback)
  if (provider === "unknown" || !ownerRepo) {
    return {
      canonicalKey,
      provider,
      visibility: "unknown",
      roomType: "invite",
      error: provider === "unknown"
        ? `Unknown git provider for host: ${canonicalKey.split("/")[0]}`
        : `Could not extract owner/repo from: ${canonicalKey}`,
    };
  }

  const { owner, repo } = ownerRepo;

  // Provider-specific visibility check
  let visibility: RepoVisibility;
  switch (provider) {
    case "github":
      visibility = await checkGitHub(owner, repo);
      break;
    case "gitlab":
      visibility = await checkGitLab(owner, repo);
      break;
    case "bitbucket":
      visibility = await checkBitbucket(owner, repo);
      break;
    default:
      visibility = "unknown";
  }

  // Determine room type from visibility
  const roomType = visibility === "public" ? "discoverable" : "invite";

  return {
    canonicalKey,
    provider,
    visibility,
    roomType,
    ...(visibility === "unknown" && {
      error: "Could not determine visibility — defaulting to invite room",
    }),
  };
}

// ---------------------------------------------------------------------------
// Full Auto-Detection Flow
// ---------------------------------------------------------------------------

/**
 * Complete auto-detection: read git remote → normalize → check visibility.
 * This is the main entry point for the MCP auto-join flow.
 *
 * @param cwd - Working directory to detect git remote from
 * @returns VisibilityResult or null if not in a git repo
 */
export async function autoDetectRepo(
  cwd?: string
): Promise<VisibilityResult | null> {
  // Import git-remote at call time to avoid circular deps
  const { getGitRemoteIdentity } = await import("./git-remote.js");

  const canonicalKey = getGitRemoteIdentity(cwd);
  if (!canonicalKey) return null;

  return checkRepoVisibility(canonicalKey);
}
