import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DesktopGitHubPullRequestStats } from "../ipc-types.js";

const execFileAsync = promisify(execFile);

type GitHubPullRequestApiResponse = {
  number?: number;
  title?: string | null;
  state?: string | null;
  draft?: boolean | null;
  merged?: boolean | null;
  base?: { ref?: string | null } | null;
  head?: { ref?: string | null } | null;
  changed_files?: number | null;
  additions?: number | null;
  deletions?: number | null;
  html_url?: string | null;
};

type FetchedStats = {
  stats: DesktopGitHubPullRequestStats | null;
  etag: string | null;
};

type StatsEntry = {
  /** Fresh until this time; an expired entry is still kept for its ETag. */
  expiresAt: number;
  etag: string | null;
  stats: DesktopGitHubPullRequestStats;
};

const TOKEN_TTL_MS = 5 * 60_000;
const STATS_TTL_MS = 45_000;
const STATS_CACHE_LIMIT = 200;

let cachedToken: { value: string; expiresAt: number } | null = null;
let tokenInFlight: Promise<string | null> | null = null;
const statsCache = new Map<string, StatsEntry>();
const statsInFlight = new Map<string, Promise<DesktopGitHubPullRequestStats | null>>();

/** Test-only: forget the cached token and every cached pull request. */
export function clearGitHubPullRequestStatsCacheForTest(): void {
  cachedToken = null;
  tokenInFlight = null;
  statsCache.clear();
  statsInFlight.clear();
}

/**
 * Pull request cards ask for the same stats on every render. One successful
 * answer per pull request is reused for 45 seconds, concurrent callers share
 * one request, and an expired answer is revalidated with its ETag (GitHub does
 * not count a 304 against the rate limit). Failures are never cached.
 */
export async function getGitHubPullRequestStats(
  rawUrl: string,
): Promise<DesktopGitHubPullRequestStats | null> {
  const parsed = parseGitHubPullRequestUrl(rawUrl);
  if (!parsed) return null;
  const key = `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}#${parsed.number}`;
  const cached = statsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.stats };
  let inFlight = statsInFlight.get(key);
  if (!inFlight) {
    inFlight = fetchPullRequestStats(rawUrl, parsed, cached ?? null).then((result) => {
      if (result.stats) {
        statsCache.delete(key);
        statsCache.set(key, {
          expiresAt: Date.now() + STATS_TTL_MS,
          etag: result.etag,
          stats: result.stats,
        });
        pruneStatsCache();
      } else {
        statsCache.delete(key);
      }
      return result.stats;
    }).finally(() => {
      statsInFlight.delete(key);
    });
    statsInFlight.set(key, inFlight);
  }
  const stats = await inFlight;
  return stats ? { ...stats } : null;
}

async function fetchPullRequestStats(
  rawUrl: string,
  parsed: { owner: string; repo: string; number: number },
  previous: StatsEntry | null,
): Promise<FetchedStats> {
  const token = await readGitHubCliToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "LetAgents-Desktop",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (previous?.etag) headers["If-None-Match"] = previous.etag;

  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`,
    { headers },
  );
  if (response.status === 304 && previous) {
    return { stats: previous.stats, etag: previous.etag };
  }
  // A rejected token may have been revoked or rotated: ask gh again next time.
  if (response.status === 401) cachedToken = null;
  if (!response.ok) return { stats: null, etag: null };

  const payload = await response.json() as GitHubPullRequestApiResponse;
  return {
    etag: response.headers.get("etag"),
    stats: {
      url: payload.html_url || rawUrl,
      number: typeof payload.number === "number" ? payload.number : parsed.number,
      title: payload.title || null,
      state: normalizePullRequestState(payload),
      baseRefName: payload.base?.ref || null,
      headRefName: payload.head?.ref || null,
      changedFiles: safeNumber(payload.changed_files),
      additions: safeNumber(payload.additions),
      deletions: safeNumber(payload.deletions),
    },
  };
}

function pruneStatsCache(): void {
  // Map order is insertion order and hits re-insert, so the oldest go first.
  for (const key of statsCache.keys()) {
    if (statsCache.size <= STATS_CACHE_LIMIT) break;
    statsCache.delete(key);
  }
}

async function readGitHubCliToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  if (!tokenInFlight) {
    tokenInFlight = (async () => {
      try {
        const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 3000 });
        const value = stdout.trim() || null;
        // Only a real token is remembered; a missing login is asked again next time.
        cachedToken = value ? { value, expiresAt: Date.now() + TOKEN_TTL_MS } : null;
        return value;
      } catch {
        return null;
      } finally {
        tokenInFlight = null;
      }
    })();
  }
  return tokenInFlight;
}

function parseGitHubPullRequestUrl(rawUrl: string): { owner: string; repo: string; number: number } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  const [owner, repo, segment, numberText] = url.pathname.split("/").filter(Boolean);
  const number = Number(numberText);
  if (!owner || !repo || segment !== "pull" || !Number.isInteger(number) || number <= 0) return null;
  return { owner, repo, number };
}

function normalizePullRequestState(payload: GitHubPullRequestApiResponse): DesktopGitHubPullRequestStats["state"] {
  if (payload.merged) return "merged";
  if (payload.draft) return "draft";
  const state = payload.state?.toLowerCase();
  return state === "open" || state === "closed" ? state : "unknown";
}

function safeNumber(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}
