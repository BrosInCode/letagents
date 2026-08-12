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

export async function getGitHubPullRequestStats(
  rawUrl: string,
): Promise<DesktopGitHubPullRequestStats | null> {
  const parsed = parseGitHubPullRequestUrl(rawUrl);
  if (!parsed) return null;
  const token = await readGitHubCliToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "LetAgents-Desktop",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`,
    { headers },
  );
  if (!response.ok) return null;

  const payload = await response.json() as GitHubPullRequestApiResponse;
  return {
    url: payload.html_url || rawUrl,
    number: typeof payload.number === "number" ? payload.number : parsed.number,
    title: payload.title || null,
    state: normalizePullRequestState(payload),
    baseRefName: payload.base?.ref || null,
    headRefName: payload.head?.ref || null,
    changedFiles: safeNumber(payload.changed_files),
    additions: safeNumber(payload.additions),
    deletions: safeNumber(payload.deletions),
  };
}

async function readGitHubCliToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 3000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
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
