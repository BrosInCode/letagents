import { parseRepoRoomName } from "../repo-workflow.js";
import { githubRequest } from "./app-client.js";

interface GitHubRepo {
  private?: boolean;
  owner?: {
    login?: string;
  };
}

interface GitHubPermissionResponse {
  permission?: string;
}

export type GitHubRepoVisibility = "public" | "private" | "unknown";
export type RepoRoomAccessDecision =
  | { kind: "allow" }
  | { kind: "auth_required" }
  | { kind: "private_repo_no_access" };

interface RepoRoomAccessIdentity {
  provider?: string | null;
  provider_access_token?: string | null;
  login?: string | null;
}

interface RepoRoomAccessDecisionDeps {
  getVisibility: (roomName: string, accessToken?: string) => Promise<GitHubRepoVisibility>;
  isCollaborator: (input: {
    roomName: string;
    login: string;
    accessToken: string;
    bypassCache?: boolean;
  }) => Promise<boolean>;
}

// Repository visibility is shared state, independent of the account asking.
// Webhooks invalidate this cache eagerly; the short TTL is the safety net for
// missed/delayed webhook delivery (especially public -> private transitions).
const REPO_VISIBILITY_TTL_MS = 1000 * 60;
const REPO_VISIBILITY_UNKNOWN_TTL_MS = 1000 * 10;
const REPO_ACCESS_TTL_MS = 1000 * 60 * 30;
const REPO_CACHE_MAX_ENTRIES = 5_000;
const repoVisibilityCache = new Map<string, { visibility: GitHubRepoVisibility; expiresAt: number }>();
const repoAccessCache = new Map<string, { allowed: boolean; expiresAt: number }>();
const repoVisibilityInflight = new Map<string, {
  roomKey: string;
  promise: Promise<GitHubRepoVisibility>;
}>();
const repoAccessInflight = new Map<string, {
  roomKey: string;
  loginKey: string;
  promise: Promise<boolean>;
}>();
const repoRoomCacheGeneration = new Map<string, object>();
const repoLoginCacheGeneration = new Map<string, object>();
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

function normalizeCacheKey(value: string): string {
  return value.trim().toLowerCase();
}

function getCachedVisibility(roomName: string, includeUnknown: boolean): GitHubRepoVisibility | null {
  const roomKey = normalizeCacheKey(roomName);
  const cached = repoVisibilityCache.get(roomKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    repoVisibilityCache.delete(roomKey);
    return null;
  }
  if (!includeUnknown && cached.visibility === "unknown") return null;
  return cached.visibility;
}

function setCachedVisibility(roomName: string, visibility: GitHubRepoVisibility): void {
  pruneExpiringCache(repoVisibilityCache, REPO_CACHE_MAX_ENTRIES);
  repoVisibilityCache.set(normalizeCacheKey(roomName), {
    visibility,
    expiresAt: Date.now() + (
      visibility === "unknown" ? REPO_VISIBILITY_UNKNOWN_TTL_MS : REPO_VISIBILITY_TTL_MS
    ),
  });
}

function getCachedRepoAccess(roomName: string, login: string): boolean | null {
  const cacheKey = `${normalizeCacheKey(roomName)}::${normalizeCacheKey(login)}`;
  const cached = repoAccessCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    repoAccessCache.delete(cacheKey);
    return null;
  }
  return cached.allowed;
}

function setCachedRepoAccess(roomName: string, login: string, allowed: boolean): void {
  if (!allowed) return;
  pruneExpiringCache(repoAccessCache, REPO_CACHE_MAX_ENTRIES);
  const cacheKey = `${normalizeCacheKey(roomName)}::${normalizeCacheKey(login)}`;
  repoAccessCache.set(cacheKey, {
    allowed,
    expiresAt: Date.now() + REPO_ACCESS_TTL_MS,
  });
}

function pruneExpiringCache<T extends { expiresAt: number }>(
  cache: Map<string, T>,
  maxEntries: number,
): void {
  // Deliberately simple at this scale: scan the bounded map for expiry and
  // evict the oldest insertion (FIFO), not the least-recently-read entry. If
  // these caches approach the 5,000-entry cap routinely, replace this with an
  // indexed expiry/LRU structure rather than increasing the per-write scan.
  const now = Date.now();
  for (const [cacheKey, cached] of cache) {
    if (cached.expiresAt <= now) cache.delete(cacheKey);
  }
  while (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function getCacheGeneration(cache: Map<string, object>, cacheKey: string): object {
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  pruneKeyCache(cache, REPO_CACHE_MAX_ENTRIES);
  const generation = {};
  cache.set(cacheKey, generation);
  return generation;
}

function rotateCacheGeneration(cache: Map<string, object>, cacheKey: string): void {
  cache.delete(cacheKey);
  pruneKeyCache(cache, REPO_CACHE_MAX_ENTRIES);
  cache.set(cacheKey, {});
}

function pruneKeyCache(cache: Map<string, object>, maxEntries: number): void {
  while (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

export function clearGitHubRepoAccessCacheForRoom(roomName: string): void {
  const roomKey = normalizeCacheKey(roomName);
  const prefix = `${roomKey}::`;
  rotateCacheGeneration(repoRoomCacheGeneration, roomKey);
  repoVisibilityCache.delete(roomKey);
  for (const cacheKey of repoAccessCache.keys()) {
    if (cacheKey.startsWith(prefix)) {
      repoAccessCache.delete(cacheKey);
    }
  }
  for (const [flightKey, flight] of repoVisibilityInflight) {
    if (flight.roomKey === roomKey) repoVisibilityInflight.delete(flightKey);
  }
  for (const [flightKey, flight] of repoAccessInflight) {
    if (flight.roomKey === roomKey) repoAccessInflight.delete(flightKey);
  }
}

export function clearGitHubRepoAccessCacheForLogin(login: string): void {
  const loginKey = normalizeCacheKey(login);
  const suffix = `::${loginKey}`;
  rotateCacheGeneration(repoLoginCacheGeneration, loginKey);
  for (const cacheKey of repoAccessCache.keys()) {
    if (cacheKey.endsWith(suffix)) {
      repoAccessCache.delete(cacheKey);
    }
  }
  for (const [flightKey, flight] of repoAccessInflight) {
    if (flight.loginKey === loginKey) repoAccessInflight.delete(flightKey);
  }
}

export function parseGitHubRepoName(roomName: string): { owner: string; repo: string } | null {
  const repoRef = parseRepoRoomName(roomName);
  if (!repoRef || repoRef.provider !== "github" || repoRef.namespace.includes("/")) {
    return null;
  }
  return { owner: repoRef.namespace, repo: repoRef.repo };
}

function getGitHubApiBaseUrl(): string {
  return (process.env.GITHUB_API_BASE_URL || DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, "");
}

function buildGitHubApiUrl(pathname: string): string {
  return new URL(pathname.replace(/^\/+/, ""), `${getGitHubApiBaseUrl()}/`).toString();
}

const GITHUB_ACCESS_FETCH_TIMEOUT_MS = 10_000;

async function fetchGitHubRepo(
  roomName: string,
  accessToken?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const repo = parseGitHubRepoName(roomName);
  if (!repo) {
    throw new Error("Room is not a GitHub repo locator");
  }

  return githubRequest({
    url: buildGitHubApiUrl(`/repos/${repo.owner}/${repo.repo}`),
    token: accessToken,
    fetchImpl,
    timeoutMs: GITHUB_ACCESS_FETCH_TIMEOUT_MS,
  });
}

export async function getGitHubRepoVisibility(
  roomName: string,
  accessToken?: string
): Promise<GitHubRepoVisibility> {
  // A definitive visibility value is safe to share across every account. An
  // authenticated caller may bypass only a cached "unknown" to refine a
  // private repository after the anonymous GitHub endpoint returned 404.
  const cached = getCachedVisibility(roomName, true);
  if (cached && (cached !== "unknown" || !accessToken)) return cached;

  if (!cached) {
    const unauthenticatedVisibility = await loadGitHubRepoVisibility(roomName, undefined, "anonymous");
    if (unauthenticatedVisibility !== "unknown") return unauthenticatedVisibility;
  }

  if (accessToken) {
    const refined = getCachedVisibility(roomName, false);
    if (refined) return refined;
    return loadGitHubRepoVisibility(roomName, accessToken, "authenticated");
  }

  return "unknown";
}

async function loadGitHubRepoVisibility(
  roomName: string,
  accessToken: string | undefined,
  mode: "anonymous" | "authenticated",
): Promise<GitHubRepoVisibility> {
  const roomKey = normalizeCacheKey(roomName);
  // The authenticated flight is intentionally room-scoped because visibility
  // is shared metadata, not account authorization. If the first token cannot
  // see a private repository, another account joining that flight may receive
  // `unknown` for this call; its per-login permission check remains separate,
  // and the next authenticated lookup can refine `unknown` immediately.
  const flightKey = `${mode}::${roomKey}`;
  const existing = repoVisibilityInflight.get(flightKey);
  if (existing) return existing.promise;

  const roomGeneration = getCacheGeneration(repoRoomCacheGeneration, roomKey);
  let pending!: Promise<GitHubRepoVisibility>;
  pending = (async () => {
    const response = await fetchGitHubRepo(roomName, accessToken);
    let visibility: GitHubRepoVisibility = "unknown";
    if (response.ok) {
      const payload = (await response.json()) as GitHubRepo;
      visibility = payload.private ? "private" : "public";
    }
    if (getCacheGeneration(repoRoomCacheGeneration, roomKey) === roomGeneration) {
      setCachedVisibility(roomName, visibility);
    }
    return visibility;
  })().finally(() => {
    if (repoVisibilityInflight.get(flightKey)?.promise === pending) {
      repoVisibilityInflight.delete(flightKey);
    }
  });
  repoVisibilityInflight.set(flightKey, { roomKey, promise: pending });
  return pending;
}

export async function isGitHubRepoCollaborator(input: {
  roomName: string;
  login: string;
  accessToken: string;
  // When true, skip the positive-access cache entirely (read AND write) so the
  // decision reflects live GitHub access — used for source-diff requests where a
  // revoked collaborator must lose access immediately, not up to 30 minutes later.
  bypassCache?: boolean;
  // Injectable for tests; production uses the global fetch (bounded by a deadline).
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const roomKey = normalizeCacheKey(input.roomName);
  const loginKey = normalizeCacheKey(input.login);
  if (!input.bypassCache) {
    const cached = getCachedRepoAccess(input.roomName, input.login);
    if (cached !== null) {
      return cached;
    }
  }
  const cacheKey = `${roomKey}::${loginKey}`;
  const flightKey = `${input.bypassCache ? "fresh" : "cached"}::${cacheKey}`;
  const existing = repoAccessInflight.get(flightKey);
  if (existing) return existing.promise;

  const roomGeneration = getCacheGeneration(repoRoomCacheGeneration, roomKey);
  const loginGeneration = getCacheGeneration(repoLoginCacheGeneration, loginKey);
  const doFetch = input.fetchImpl ?? fetch;

  let pending!: Promise<boolean>;
  pending = (async () => {
    const repo = parseGitHubRepoName(input.roomName);
    if (!repo) return false;

    const ownerResponse = await fetchGitHubRepo(input.roomName, input.accessToken, doFetch);
    if (!ownerResponse.ok) return false;

    const repoPayload = (await ownerResponse.json()) as GitHubRepo;
    let allowed = repoPayload.owner?.login?.toLowerCase() === loginKey;
    if (!allowed) {
      const permissionResponse = await githubRequest({
        url: buildGitHubApiUrl(
          `/repos/${repo.owner}/${repo.repo}/collaborators/${encodeURIComponent(input.login)}/permission`
        ),
        token: input.accessToken,
        fetchImpl: doFetch,
        timeoutMs: GITHUB_ACCESS_FETCH_TIMEOUT_MS,
      });
      if (!permissionResponse.ok) return false;
      const permissionPayload = (await permissionResponse.json()) as GitHubPermissionResponse;
      allowed = Boolean(permissionPayload.permission);
    }

    if (
      allowed
      && !input.bypassCache
      && getCacheGeneration(repoRoomCacheGeneration, roomKey) === roomGeneration
      && getCacheGeneration(repoLoginCacheGeneration, loginKey) === loginGeneration
    ) {
      setCachedRepoAccess(input.roomName, input.login, true);
    }
    return allowed;
  })().finally(() => {
    if (repoAccessInflight.get(flightKey)?.promise === pending) {
      repoAccessInflight.delete(flightKey);
    }
  });
  repoAccessInflight.set(flightKey, { roomKey, loginKey, promise: pending });
  return pending;
}

export async function isGitHubRepoAdmin(input: {
  roomName: string;
  login: string;
  accessToken: string;
}): Promise<boolean> {
  const repo = parseGitHubRepoName(input.roomName);
  if (!repo) return false;

  const ownerResponse = await fetchGitHubRepo(input.roomName, input.accessToken);

  if (!ownerResponse.ok) {
    return false;
  }

  const repoPayload = (await ownerResponse.json()) as GitHubRepo;
  if (repoPayload.owner?.login?.toLowerCase() === input.login.toLowerCase()) {
    return true;
  }

  const permissionResponse = await fetch(
    buildGitHubApiUrl(
      `/repos/${repo.owner}/${repo.repo}/collaborators/${encodeURIComponent(input.login)}/permission`
    ),
    {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "letagents",
      },
    }
  );

  if (!permissionResponse.ok) {
    return false;
  }

  const permissionPayload = (await permissionResponse.json()) as GitHubPermissionResponse;
  return permissionPayload.permission === "admin";
}

export async function resolveGitHubRepoRoomAccessDecision(input: {
  roomName: string;
  sessionAccount: RepoRoomAccessIdentity | null | undefined;
  freshCollaboratorCheck?: boolean;
}, deps: RepoRoomAccessDecisionDeps = {
  getVisibility: getGitHubRepoVisibility,
  isCollaborator: isGitHubRepoCollaborator,
}): Promise<RepoRoomAccessDecision> {
  const githubRepo = parseGitHubRepoName(input.roomName);
  if (!githubRepo) {
    return { kind: "allow" };
  }

  const accessToken = input.sessionAccount?.provider_access_token ?? undefined;
  const visibility = await deps.getVisibility(input.roomName, accessToken);
  if (visibility === "public") {
    return { kind: "allow" };
  }

  if (!input.sessionAccount) {
    return { kind: "auth_required" };
  }

  if (
    input.sessionAccount.provider !== "github" ||
    !input.sessionAccount.provider_access_token ||
    !input.sessionAccount.login
  ) {
    return { kind: "private_repo_no_access" };
  }

  const allowed = await deps.isCollaborator({
    roomName: input.roomName,
    login: input.sessionAccount.login,
    accessToken: input.sessionAccount.provider_access_token,
    bypassCache: input.freshCollaboratorCheck,
  });

  return allowed ? { kind: "allow" } : { kind: "private_repo_no_access" };
}
