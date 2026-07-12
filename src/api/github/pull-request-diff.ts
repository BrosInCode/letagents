import { getGitHubAppConfig, type GitHubAppConfig } from "./config.js";
import { createGitHubAppJwt } from "./lease-enforcement.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_HEADERS = {
  "User-Agent": "letagents",
  "X-GitHub-Api-Version": "2022-11-28",
};
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_DIFF_BYTES = 5 * 1024 * 1024; // 5 MiB
// Exact base content types accepted for a PR diff (parameters like charset stripped).
const ALLOWED_DIFF_CONTENT_TYPES = new Set([
  "application/vnd.github.v3.diff",
  "application/vnd.github.diff",
  "text/plain",
  "text/x-diff",
]);

export type PullRequestDiffErrorCode =
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "too_large"
  | "timeout"
  | "moved"
  | "invalid_content"
  | "upstream";

export class PullRequestDiffError extends Error {
  constructor(
    public readonly code: PullRequestDiffErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PullRequestDiffError";
  }
}

function mapStatusToError(status: number, context: string): PullRequestDiffError {
  if (status === 404) return new PullRequestDiffError("not_found", `${context}: 404`);
  if (status === 403 || status === 401) return new PullRequestDiffError("forbidden", `${context}: ${status}`);
  if (status === 429) return new PullRequestDiffError("rate_limited", `${context}: 429`);
  return new PullRequestDiffError("upstream", `${context}: ${status}`);
}

async function githubFetch(
  fetchImpl: typeof fetch,
  url: string,
  accept: string,
  token: string,
  signal: AbortSignal,
  method: "GET" | "POST" = "GET",
): Promise<Response> {
  return fetchImpl(url, {
    method,
    headers: { ...GITHUB_HEADERS, Accept: accept, Authorization: `Bearer ${token}` },
    signal,
  });
}

// Read the body with a hard byte cap, aborting before buffering an oversized diff.
// The stream is bound to the operation's abort signal, so the overall deadline also
// bounds this read (a slow/stalled body triggers the outer timeout).
async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PullRequestDiffError("too_large", `diff exceeds ${maxBytes} bytes`);
  }
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new PullRequestDiffError("too_large", `diff exceeds ${maxBytes} bytes`);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PullRequestDiffError("too_large", `diff exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function mintInstallationToken(
  config: GitHubAppConfig,
  installationId: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  if (!config.appId || !config.privateKey) {
    throw new PullRequestDiffError("upstream", "GitHub App appId and privateKey are required");
  }
  const jwt = createGitHubAppJwt({ appId: config.appId, privateKey: config.privateKey });
  const response = await githubFetch(
    fetchImpl,
    `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    "application/vnd.github+json",
    jwt,
    signal,
    "POST",
  );
  if (!response.ok) throw mapStatusToError(response.status, "installation token");
  const json = (await response.json()) as { token?: unknown };
  const token = typeof json.token === "string" ? json.token : "";
  if (!token) throw new PullRequestDiffError("upstream", "installation token response missing token");
  return token;
}

async function fetchHeadSha(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  number: number,
  token: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await githubFetch(
    fetchImpl,
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
    "application/vnd.github+json",
    token,
    signal,
  );
  if (!response.ok) throw mapStatusToError(response.status, "pull request");
  const json = (await response.json()) as { head?: { sha?: unknown } };
  const sha = typeof json.head?.sha === "string" ? json.head.sha : "";
  if (!sha) throw new PullRequestDiffError("upstream", "pull request response missing head sha");
  return sha;
}

export interface PullRequestUnifiedDiff {
  diff: string;
  headSha: string;
}

// Fetch a PR's unified diff via the App installation token. Bounded by a single
// overall deadline covering token mint, JSON reads, AND the streamed diff body
// (the abort signal is held open through body consumption). Content type is
// checked against an exact allowlist, and the head SHA is read before and after
// the diff — a mismatch (mid-flight force-push) fails "moved" so a stale diff is
// never returned/cached. Authorization + room association are the caller's job.
export async function fetchPullRequestUnifiedDiff(input: {
  owner: string;
  repo: string;
  number: number;
  installationId: string;
  config?: GitHubAppConfig;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<PullRequestUnifiedDiff> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const config = input.config ?? (await getGitHubAppConfig());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = await mintInstallationToken(config, input.installationId, fetchImpl, controller.signal);
    const shaBefore = await fetchHeadSha(fetchImpl, input.owner, input.repo, input.number, token, controller.signal);

    const diffResponse = await githubFetch(
      fetchImpl,
      `${GITHUB_API}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.number}`,
      "application/vnd.github.v3.diff",
      token,
      controller.signal,
    );
    if (!diffResponse.ok) throw mapStatusToError(diffResponse.status, "pull request diff");
    const baseType = (diffResponse.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_DIFF_CONTENT_TYPES.has(baseType)) {
      throw new PullRequestDiffError("invalid_content", `unexpected content-type: ${baseType || "none"}`);
    }
    const diff = await readCappedText(diffResponse, maxBytes);

    // Re-check after the body read: reject if the PR moved mid-flight so we never
    // return/cache a diff under a head SHA it does not correspond to.
    const shaAfter = await fetchHeadSha(fetchImpl, input.owner, input.repo, input.number, token, controller.signal);
    if (shaBefore !== shaAfter) {
      throw new PullRequestDiffError("moved", "pull request head changed during fetch");
    }
    return { diff, headSha: shaAfter };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new PullRequestDiffError("timeout", "GitHub request timed out");
    }
    if (error instanceof PullRequestDiffError) throw error;
    throw new PullRequestDiffError("upstream", error instanceof Error ? error.message : "fetch failed");
  } finally {
    clearTimeout(timer);
  }
}
