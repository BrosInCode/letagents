import crypto from "crypto";

import type { GitHubAppConfig } from "./config.js";

// Shared GitHub App client: App JWT creation, installation-token minting, and the
// authenticated REST request helper with standard headers. Centralized so GitHub
// features (lease enforcement, repo access, PR diff proxy, …) don't each reimplement
// the token dance and header plumbing.

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_DEFAULT_HEADERS = {
  "User-Agent": "letagents",
  "X-GitHub-Api-Version": "2022-11-28",
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function base64UrlSignature(value: Buffer): string {
  return value.toString("base64url");
}

export function createGitHubAppJwt(input: {
  appId: string;
  privateKey: string;
  now?: Date;
}): string {
  const nowSeconds = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: input.appId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), input.privateKey);
  return `${signingInput}.${base64UrlSignature(signature)}`;
}

export interface GitHubRequestInput {
  url: string;
  method?: string;
  /** Bearer token (App JWT or installation token). Omit for unauthenticated calls. */
  token?: string;
  /** Accept header; defaults to the GitHub JSON media type. */
  accept?: string;
  body?: unknown;
  fetchImpl?: typeof fetch;
  /** Caller-supplied signal (e.g. an operation-wide deadline). Takes precedence. */
  signal?: AbortSignal;
  /** When no signal is given, bound the call with AbortSignal.timeout(timeoutMs). */
  timeoutMs?: number;
}

// Perform an authenticated GitHub REST request and return the raw Response so the
// caller decides how to consume it (json/text/stream).
export async function githubRequest(input: GitHubRequestInput): Promise<Response> {
  const headers: Record<string, string> = {
    ...GITHUB_DEFAULT_HEADERS,
    Accept: input.accept ?? "application/vnd.github+json",
  };
  if (input.token) headers.Authorization = `Bearer ${input.token}`;
  if (input.body !== undefined) headers["Content-Type"] = "application/json";
  const signal = input.signal ?? (input.timeoutMs !== undefined ? AbortSignal.timeout(input.timeoutMs) : undefined);
  return (input.fetchImpl ?? fetch)(input.url, {
    method: input.method ?? "GET",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    ...(signal ? { signal } : {}),
  });
}

// Authenticated request that throws on a non-2xx status and returns parsed JSON
// (or null for 204). For callers that just want the decoded body.
export async function githubRequestJson(input: GitHubRequestInput): Promise<unknown> {
  const response = await githubRequest(input);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${input.method ?? "GET"} ${input.url} failed: ${response.status} ${body}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

// Mint a short-lived installation access token from the App credentials.
export async function mintInstallationToken(input: {
  config: GitHubAppConfig;
  installationId: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  if (!input.config.appId || !input.config.privateKey) {
    throw new Error("GitHub App appId and privateKey are required");
  }
  const jwt = createGitHubAppJwt({ appId: input.config.appId, privateKey: input.config.privateKey });
  const result = await githubRequestJson({
    url: `${GITHUB_API_BASE_URL}/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
    method: "POST",
    token: jwt,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  const token =
    typeof result === "object" && result && "token" in result
      ? String((result as { token: unknown }).token)
      : "";
  if (!token) {
    throw new Error("GitHub installation token response did not include a token");
  }
  return token;
}
