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
const INSTALLATION_TOKEN_EXPIRY_SAFETY_MS = 5 * 60_000;
const INSTALLATION_TOKEN_CACHE_MAX_ENTRIES = 1_000;
const INSTALLATION_TOKEN_MINT_TIMEOUT_MS = 10_000;
const installationTokenCache = new Map<string, {
  installationId: string;
  token: string;
  reuseUntil: number;
}>();
const installationTokenInflight = new Map<string, {
  installationId: string;
  promise: Promise<string>;
}>();
const installationTokenGeneration = new Map<string, object>();
let installationTokenGlobalGeneration: object = {};
const fetchImplementationIds = new WeakMap<object, number>();
let nextFetchImplementationId = 1;

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
  /** Redirect policy; use manual when callers need GitHub's signed asset URL. */
  redirect?: RequestRedirect;
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
    redirect: input.redirect,
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
  now?: Date;
}): Promise<string> {
  const appId = input.config.appId;
  const privateKey = input.config.privateKey;
  if (!appId || !privateKey) {
    throw new Error("GitHub App appId and privateKey are required");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const cacheKey = installationTokenCacheKey(appId, privateKey, input.installationId, fetchImpl);
  const mintTimeoutMs = input.timeoutMs ?? INSTALLATION_TOKEN_MINT_TIMEOUT_MS;
  const flightKey = `${cacheKey}::${mintTimeoutMs}`;
  const nowMs = input.now?.getTime() ?? Date.now();
  const cached = installationTokenCache.get(cacheKey);
  if (cached && cached.reuseUntil > nowMs) return cached.token;
  if (cached) installationTokenCache.delete(cacheKey);

  // Calls carrying an operation-owned signal retain independent cancellation.
  // Other callers share the mint so webhook bursts do not POST duplicate tokens.
  if (!input.signal) {
    const existing = installationTokenInflight.get(flightKey);
    if (existing) return existing.promise;
  }

  const generation = getInstallationTokenGeneration(input.installationId);
  const globalGeneration = installationTokenGlobalGeneration;
  let pending!: Promise<string>;
  pending = (async () => {
    const jwt = createGitHubAppJwt({
      appId,
      privateKey,
      now: input.now,
    });
    const result = await githubRequestJson({
      url: `${GITHUB_API_BASE_URL}/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
      method: "POST",
      token: jwt,
      fetchImpl,
      signal: input.signal,
      timeoutMs: mintTimeoutMs,
    });
    const token =
      typeof result === "object" && result && "token" in result
        ? String((result as { token: unknown }).token)
        : "";
    if (!token) {
      throw new Error("GitHub installation token response did not include a token");
    }

    const expiresAt = typeof result === "object" && result && "expires_at" in result
      ? Date.parse(String((result as { expires_at: unknown }).expires_at))
      : Number.NaN;
    const reuseUntil = expiresAt - INSTALLATION_TOKEN_EXPIRY_SAFETY_MS;
    if (
      Number.isFinite(reuseUntil)
      && reuseUntil > nowMs
      && installationTokenGlobalGeneration === globalGeneration
      && getInstallationTokenGeneration(input.installationId) === generation
    ) {
      pruneInstallationTokenCache(nowMs);
      const current = installationTokenCache.get(cacheKey);
      if (!current || current.reuseUntil < reuseUntil) {
        installationTokenCache.set(cacheKey, {
          installationId: input.installationId,
          token,
          reuseUntil,
        });
      }
    }
    return token;
  })().finally(() => {
    if (installationTokenInflight.get(flightKey)?.promise === pending) {
      installationTokenInflight.delete(flightKey);
    }
  });

  if (!input.signal) {
    installationTokenInflight.set(flightKey, {
      installationId: input.installationId,
      promise: pending,
    });
  }
  return pending;
}

function pruneInstallationTokenCache(nowMs: number): void {
  for (const [cacheKey, cached] of installationTokenCache) {
    if (cached.reuseUntil <= nowMs) installationTokenCache.delete(cacheKey);
  }
  while (installationTokenCache.size >= INSTALLATION_TOKEN_CACHE_MAX_ENTRIES) {
    const oldestKey = installationTokenCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    installationTokenCache.delete(oldestKey);
  }
}

function getInstallationTokenGeneration(installationId: string): object {
  const existing = installationTokenGeneration.get(installationId);
  if (existing) return existing;
  pruneInstallationTokenGenerations();
  const generation = {};
  installationTokenGeneration.set(installationId, generation);
  return generation;
}

function rotateInstallationTokenGeneration(installationId: string): void {
  installationTokenGeneration.delete(installationId);
  pruneInstallationTokenGenerations();
  installationTokenGeneration.set(installationId, {});
}

function pruneInstallationTokenGenerations(): void {
  while (installationTokenGeneration.size >= INSTALLATION_TOKEN_CACHE_MAX_ENTRIES) {
    const oldestInstallationId = installationTokenGeneration.keys().next().value as string | undefined;
    if (!oldestInstallationId) break;
    installationTokenGeneration.delete(oldestInstallationId);
  }
}

export function clearGitHubInstallationTokenCache(installationId?: string): void {
  if (!installationId) {
    installationTokenGlobalGeneration = {};
    installationTokenCache.clear();
    installationTokenInflight.clear();
    installationTokenGeneration.clear();
    return;
  }
  rotateInstallationTokenGeneration(installationId);
  for (const [cacheKey, cached] of installationTokenCache) {
    if (cached.installationId === installationId) installationTokenCache.delete(cacheKey);
  }
  for (const [cacheKey, pending] of installationTokenInflight) {
    if (pending.installationId === installationId) installationTokenInflight.delete(cacheKey);
  }
}

function installationTokenCacheKey(
  appId: string,
  privateKey: string,
  installationId: string,
  fetchImpl: typeof fetch,
): string {
  let fetchId = fetchImplementationIds.get(fetchImpl);
  if (!fetchId) {
    fetchId = nextFetchImplementationId++;
    fetchImplementationIds.set(fetchImpl, fetchId);
  }
  const keyFingerprint = crypto
    .createHash("sha256")
    .update(privateKey)
    .digest("base64url")
    .slice(0, 16);
  return `${fetchId}::${appId}::${installationId}::${keyFingerprint}`;
}
