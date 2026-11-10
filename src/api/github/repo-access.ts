import { createHash } from "node:crypto";

import { parseRepoRoomName } from "../repo-workflow.js";
import { createBridgedEmitter } from "../server/bridged-emitter.js";
import { githubRequest } from "./app-client.js";

interface GitHubRepo {
  private?: boolean;
  owner?: {
    login?: string;
  };
  // The caller's own role, present when the request carries a user token.
  permissions?: Partial<Record<"admin" | "maintain" | "push" | "triage" | "pull", boolean>>;
}

interface GitHubPermissionResponse {
  permission?: string;
}

export type GitHubRepoVisibility = "public" | "private" | "unknown";
export type RepoRoomAccessDecision =
  | { kind: "allow" }
  | { kind: "auth_required" }
  | { kind: "private_repo_no_access" }
  // A public repository: everyone can read the code, but only people with a
  // GitHub role on it may open its room.
  | { kind: "repo_collaborator_required" }
  // GitHub gave no answer to the role check (outage, rate limit, expired
  // token) and no recent positive answer stands in. Not a refusal: retry.
  | { kind: "repo_access_unavailable" }
  // The room id has the `host/owner/repo` shape of a repo room, but no
  // visibility or collaborator check exists for its host. Nobody may enter.
  | { kind: "unsupported_repo_provider" };

interface RepoRoomAccessIdentity {
  provider?: string | null;
  provider_access_token?: string | null;
  login?: string | null;
}

interface RepoRoomAccessDecisionDeps {
  getVisibility: (
    roomName: string,
    accessToken?: string,
    options?: { bypassCache?: boolean },
  ) => Promise<GitHubRepoVisibility>;
  isCollaborator: (input: {
    roomName: string;
    login: string;
    accessToken: string;
    bypassCache?: boolean;
    throwOnIndeterminate?: boolean;
    prefetchedRepo?: GitHubRepo | null;
  }) => Promise<boolean>;
  isPublicRepoRoleHolder?: typeof isGitHubPublicRepoRoleHolder;
  /** The fresh signed-in repository read; defaults to the real one only with the real getVisibility. */
  loadFreshRepo?: (roomName: string, accessToken: string) => Promise<FreshRepoRead>;
  getLastKnownVisibility?: (roomName: string) => "public" | "private" | null;
}

// Repository visibility is shared state, independent of the account asking.
// Webhooks invalidate this cache eagerly; the short TTL is the safety net for
// missed/delayed webhook delivery (especially public -> private transitions).
const REPO_VISIBILITY_TTL_MS = 1000 * 60;
const REPO_VISIBILITY_UNKNOWN_TTL_MS = 1000 * 10;
// How long a definitive answer may stand in while GitHub gives none (rate
// limit, outage, timeout). Webhook invalidation discards it immediately.
const REPO_VISIBILITY_LAST_KNOWN_MAX_AGE_MS = 1000 * 60 * 60;
// Token-less lookups share GitHub's per-IP budget across every room. After
// GitHub says it is exhausted, wait for its reset instead of retrying.
const REPO_VISIBILITY_RATE_LIMIT_DEFAULT_BACKOFF_MS = 1000 * 60;
const REPO_VISIBILITY_RATE_LIMIT_MAX_BACKOFF_MS = 1000 * 60 * 60;
let anonymousVisibilityLookupsBlockedUntil = 0;
// How long a "yes" from GitHub (a role on the repository) is reused by
// ordinary HTTP reads. Live streams re-check every 60 s and webhooks clear it
// at once; this bounds how long a missed webhook can keep a removed person
// reading over plain HTTP. Five minutes costs at most 12 role checks per hour
// per person and repository (24 GitHub calls for a private repository, 12 for
// a public one), against GitHub's 5,000 calls per hour per token.
export const REPO_ACCESS_TTL_MS = 1000 * 60 * 5;
// A "no role" answer for a public repository is kept briefly, so a refused
// client that reconnects does not spend the person's GitHub rate limit.
const PUBLIC_REPO_NO_ROLE_TTL_MS = 1000 * 60;
// How long a "not admin" answer is reused for the credential that got it.
// Only "not admin" is kept: a "yes" makes the caller store a permanent admin
// row, so a stale "yes" would become a permanent grant. A stale "not admin"
// can only delay a promotion: by at most 5 minutes, or until a `member` or
// `membership` webhook (or a sign-in) clears it.
const REPO_NOT_ADMIN_TTL_MS = 1000 * 60 * 5;
const REPO_CACHE_MAX_ENTRIES = 5_000;
const repoVisibilityCache = new Map<string, { visibility: GitHubRepoVisibility; expiresAt: number }>();
const repoVisibilityLastKnown = new Map<string, { visibility: "public" | "private"; expiresAt: number }>();
const repoAccessCache = new Map<string, { allowed: boolean; expiresAt: number }>();
const publicRepoRoleCache = new Map<string, { allowed: boolean; expiresAt: number }>();
// The last "has a role" answer, kept so that a GitHub outage does not lock a
// collaborator out. Webhook invalidation (role removed) discards it at once.
const publicRepoRoleLastKnown = new Map<string, { expiresAt: number }>();
const publicRepoRoleInflight = new Map<string, Promise<boolean>>();
// Keyed `room::credential::login`, where the credential is a hash of the
// GitHub token: an answer is reused only by the token that got it.
const repoNotAdminCache = new Map<string, { expiresAt: number }>();
const repoAdminInflight = new Map<string, {
  roomKey: string;
  loginKey: string;
  promise: Promise<boolean>;
}>();
const repoVisibilityInflight = new Map<string, {
  roomKey: string;
  promise: Promise<GitHubRepoVisibility>;
}>();
// Keyed by room: the token-first lookup for a repository last seen private.
const knownPrivateVisibilityInflight = new Map<string, Promise<GitHubRepoVisibility | null>>();
const repoAccessInflight = new Map<string, {
  roomKey: string;
  loginKey: string;
  promise: Promise<boolean>;
}>();
const repoRoomCacheGeneration = new Map<string, object>();
const repoLoginCacheGeneration = new Map<string, object>();
// Per person and repository (`room::login`). A fresh "no" advances it, so an
// older check still in flight neither caches nor shares its "yes".
const repoPersonCacheGeneration = new Map<string, object>();
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

// The same emitter handles process-local invalidation immediately and relays
// the compact key to every API instance through the ordered PostgreSQL bridge.
export const githubRepoAccessInvalidationEvents = createBridgedEmitter("repo_access");

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

function setCachedVisibility(roomName: string, visibility: GitHubRepoVisibility, ttlMs?: number): void {
  pruneExpiringCache(repoVisibilityCache, REPO_CACHE_MAX_ENTRIES);
  repoVisibilityCache.set(normalizeCacheKey(roomName), {
    visibility,
    expiresAt: Date.now() + (
      ttlMs ?? (visibility === "unknown" ? REPO_VISIBILITY_UNKNOWN_TTL_MS : REPO_VISIBILITY_TTL_MS)
    ),
  });
}

function getLastKnownVisibility(roomName: string): "public" | "private" | null {
  const lastKnown = repoVisibilityLastKnown.get(normalizeCacheKey(roomName));
  return lastKnown && lastKnown.expiresAt > Date.now() ? lastKnown.visibility : null;
}

function setLastKnownVisibility(roomName: string, visibility: GitHubRepoVisibility): void {
  const roomKey = normalizeCacheKey(roomName);
  if (visibility === "unknown") {
    repoVisibilityLastKnown.delete(roomKey);
    return;
  }
  pruneExpiringCache(repoVisibilityLastKnown, REPO_CACHE_MAX_ENTRIES);
  repoVisibilityLastKnown.set(roomKey, {
    visibility,
    expiresAt: Date.now() + REPO_VISIBILITY_LAST_KNOWN_MAX_AGE_MS,
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

function canonicalRepoRoomKey(roomName: string): string | null {
  const repo = parseGitHubRepoName(roomName);
  return repo ? `github.com/${repo.owner}/${repo.repo}`.toLowerCase() : null;
}

/** A check that stays true only while no invalidation touched this room, login or person. */
function captureRepoPersonGenerations(roomKey: string, loginKey: string): () => boolean {
  const personKey = `${roomKey}::${loginKey}`;
  const roomGeneration = getCacheGeneration(repoRoomCacheGeneration, roomKey);
  const loginGeneration = getCacheGeneration(repoLoginCacheGeneration, loginKey);
  const personGeneration = getCacheGeneration(repoPersonCacheGeneration, personKey);
  return () => getCacheGeneration(repoRoomCacheGeneration, roomKey) === roomGeneration
    && getCacheGeneration(repoLoginCacheGeneration, loginKey) === loginGeneration
    && getCacheGeneration(repoPersonCacheGeneration, personKey) === personGeneration;
}

/** `room::credential::login`: the credential part is a hash, never the token itself. */
function repoAdminCredentialKey(roomKey: string, accessToken: string, loginKey: string): string {
  const credential = createHash("sha256").update(accessToken).digest("hex").slice(0, 32);
  return `${roomKey}::${credential}::${loginKey}`;
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

function forgetRoomAccess(roomKey: string): void {
  const prefix = `${roomKey}::`;
  rotateCacheGeneration(repoRoomCacheGeneration, roomKey);
  repoVisibilityCache.delete(roomKey);
  repoVisibilityLastKnown.delete(roomKey);
  for (const cache of [repoAccessCache, publicRepoRoleCache, publicRepoRoleLastKnown, repoNotAdminCache]) {
    for (const cacheKey of cache.keys()) {
      if (cacheKey.startsWith(prefix)) cache.delete(cacheKey);
    }
  }
  for (const [flightKey, flight] of repoVisibilityInflight) {
    if (flight.roomKey === roomKey) repoVisibilityInflight.delete(flightKey);
  }
  knownPrivateVisibilityInflight.delete(roomKey);
  for (const [flightKey, flight] of freshRepoInflight) {
    if (flight.roomKey === roomKey) freshRepoInflight.delete(flightKey);
  }
  for (const flightKey of publicRepoRoleInflight.keys()) {
    if (flightKey.includes(`::${roomKey}::`)) publicRepoRoleInflight.delete(flightKey);
  }
  for (const flights of [repoAccessInflight, repoAdminInflight]) {
    for (const [flightKey, flight] of flights) {
      if (flight.roomKey === roomKey) flights.delete(flightKey);
    }
  }
}

/**
 * A fresh "no" from GitHub for one person on one repository (an outage
 * throws instead): forget every remembered "yes" for them, and let no check
 * that started earlier cache or share its answer.
 */
function forgetPersonAccess(roomKey: string, loginKey: string): void {
  const cacheKey = `${roomKey}::${loginKey}`;
  rotateCacheGeneration(repoPersonCacheGeneration, cacheKey);
  for (const cache of [repoAccessCache, publicRepoRoleCache, publicRepoRoleLastKnown]) cache.delete(cacheKey);
  for (const adminKey of repoNotAdminCache.keys()) {
    if (adminKey.startsWith(`${roomKey}::`) && adminKey.endsWith(`::${loginKey}`)) repoNotAdminCache.delete(adminKey);
  }
  for (const flights of [repoAccessInflight, repoAdminInflight]) {
    for (const [flightKey, flight] of flights) {
      if (flight.roomKey === roomKey && flight.loginKey === loginKey) flights.delete(flightKey);
    }
  }
  for (const flightKey of publicRepoRoleInflight.keys()) {
    if (flightKey.endsWith(`::${cacheKey}`)) publicRepoRoleInflight.delete(flightKey);
  }
}

export function clearGitHubRepoAccessCacheForRoom(roomName: string): void {
  const roomKey = normalizeCacheKey(roomName);
  forgetRoomAccess(roomKey);
  githubRepoAccessInvalidationEvents.emit("invalidate", { roomName: roomKey });
}

function forgetLoginAccess(loginKey: string): void {
  const suffix = `::${loginKey}`;
  rotateCacheGeneration(repoLoginCacheGeneration, loginKey);
  for (const cache of [repoAccessCache, publicRepoRoleCache, publicRepoRoleLastKnown, repoNotAdminCache]) {
    for (const cacheKey of cache.keys()) {
      if (cacheKey.endsWith(suffix)) cache.delete(cacheKey);
    }
  }
  for (const flights of [repoAccessInflight, repoAdminInflight]) {
    for (const [flightKey, flight] of flights) {
      if (flight.loginKey === loginKey) flights.delete(flightKey);
    }
  }
  for (const flightKey of publicRepoRoleInflight.keys()) {
    if (flightKey.endsWith(`::${loginKey}`)) publicRepoRoleInflight.delete(flightKey);
  }
}

export function clearGitHubRepoAccessCacheForLogin(login: string): void {
  const loginKey = normalizeCacheKey(login);
  forgetLoginAccess(loginKey);
  githubRepoAccessInvalidationEvents.emit("invalidate", { login: loginKey });
}

// A webhook received by another API instance arrives here through the bridge
// (emitLocal, never re-published). Forget this instance's copy as well, or
// its cached and remembered visibility would outlive the change. Local
// invalidations also pass through here; forgetting twice is harmless.
githubRepoAccessInvalidationEvents.on("invalidate", (payload: unknown) => {
  const invalidation = payload && typeof payload === "object"
    ? payload as { roomName?: unknown; login?: unknown }
    : {};
  if (typeof invalidation.roomName === "string") forgetRoomAccess(normalizeCacheKey(invalidation.roomName));
  if (typeof invalidation.login === "string") forgetLoginAccess(normalizeCacheKey(invalidation.login));
});

export function resetGitHubRepoVisibilityBackoffForTests(): void {
  anonymousVisibilityLookupsBlockedUntil = 0;
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
  accessToken?: string,
  options: { bypassCache?: boolean } = {},
): Promise<GitHubRepoVisibility> {
  if (options.bypassCache) {
    if (accessToken) {
      return loadGitHubRepoVisibility(roomName, accessToken, "fresh-authenticated");
    }
    return loadGitHubRepoVisibility(roomName, undefined, "fresh-anonymous");
  }

  // A definitive visibility value is safe to share across every account. An
  // authenticated caller may bypass only a cached "unknown" to refine a
  // private repository after the anonymous GitHub endpoint returned 404.
  const cached = getCachedVisibility(roomName, true);
  if (cached && (cached !== "unknown" || !accessToken)) return cached;

  if (!cached) {
    // A repository last seen private answers a token-less lookup with 404, so
    // a caller with a token asks with it first. A 200 is the answer and an
    // outage keeps the remembered one, as below; any other answer leaves every
    // cache alone and the usual two-step lookup runs. A change to public shows
    // in this answer; a change to private (last seen public) still goes
    // through the token-less lookup.
    if (accessToken && getLastKnownVisibility(roomName) === "private") {
      const knownPrivate = await loadKnownPrivateRepoVisibility(roomName, accessToken);
      if (knownPrivate) return knownPrivate;
    }
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

/**
 * The token-first lookup: the visibility on a 200, the remembered visibility
 * in an outage, otherwise null and no cache change.
 */
async function loadKnownPrivateRepoVisibility(
  roomName: string,
  accessToken: string,
): Promise<GitHubRepoVisibility | null> {
  const roomKey = normalizeCacheKey(roomName);
  const existing = knownPrivateVisibilityInflight.get(roomKey);
  if (existing) return existing;

  const roomGeneration = getCacheGeneration(repoRoomCacheGeneration, roomKey);
  // GitHub is down or timed out: keep the remembered answer for the short
  // retry time, as the token-less lookup does in an outage, instead of
  // waiting on a second request to the same failing service.
  const outage = (): GitHubRepoVisibility | null => {
    const lastKnown = getLastKnownVisibility(roomName);
    if (!lastKnown || getCacheGeneration(repoRoomCacheGeneration, roomKey) !== roomGeneration) return null;
    setCachedVisibility(roomName, lastKnown, REPO_VISIBILITY_UNKNOWN_TTL_MS);
    return lastKnown;
  };
  let pending!: Promise<GitHubRepoVisibility | null>;
  pending = (async () => {
    let response: Response;
    try {
      response = await fetchGitHubRepo(roomName, accessToken);
    } catch {
      return outage();
    }
    if (response.status === 408 || response.status >= 500) return outage();
    if (response.status !== 200) return null;
    const payload = (await response.json()) as GitHubRepo;
    const visibility: GitHubRepoVisibility = payload.private ? "private" : "public";
    if (getCacheGeneration(repoRoomCacheGeneration, roomKey) === roomGeneration) {
      setCachedVisibility(roomName, visibility);
      setLastKnownVisibility(roomName, visibility);
    }
    return visibility;
  })().finally(() => {
    if (knownPrivateVisibilityInflight.get(roomKey) === pending) knownPrivateVisibilityInflight.delete(roomKey);
  });
  knownPrivateVisibilityInflight.set(roomKey, pending);
  return pending;
}

async function loadGitHubRepoVisibility(
  roomName: string,
  accessToken: string | undefined,
  mode: "anonymous" | "authenticated" | "fresh-anonymous" | "fresh-authenticated",
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
  const isCurrentGeneration = () => getCacheGeneration(repoRoomCacheGeneration, roomKey) === roomGeneration;
  const anonymous = !accessToken;
  // When GitHub gives no answer, keep the last definitive visibility instead
  // of treating a public room as private for anonymous readers. That includes
  // the fresh checks behind anonymous live streams; a signed-in fresh check
  // exists to see live access and never falls back.
  const lastKnownFallback = (): GitHubRepoVisibility | null => {
    if (mode === "fresh-authenticated") return null;
    const lastKnown = getLastKnownVisibility(roomName);
    // Retry GitHub no sooner than an unknown answer would be retried.
    if (lastKnown && isCurrentGeneration()) setCachedVisibility(roomName, lastKnown, REPO_VISIBILITY_UNKNOWN_TTL_MS);
    return lastKnown;
  };
  if (anonymous && Date.now() < anonymousVisibilityLookupsBlockedUntil) {
    return lastKnownFallback() ?? "unknown";
  }
  let pending!: Promise<GitHubRepoVisibility>;
  pending = (async () => {
    let response: Response;
    try {
      response = await fetchGitHubRepo(roomName, accessToken);
    } catch (error) {
      const lastKnown = lastKnownFallback();
      if (lastKnown) return lastKnown;
      throw error;
    }
    const outcome = await classifyVisibilityLookupResponse(response, Date.now(), anonymous);
    const unanswered = outcome.kind === "unanswered";
    if (unanswered) {
      if (anonymous && outcome.retryAt !== null) {
        anonymousVisibilityLookupsBlockedUntil = Math.max(anonymousVisibilityLookupsBlockedUntil, outcome.retryAt);
      }
      const lastKnown = lastKnownFallback();
      if (lastKnown) return lastKnown;
    }
    let visibility: GitHubRepoVisibility = "unknown";
    if (response.ok) {
      const payload = (await response.json()) as GitHubRepo;
      visibility = payload.private ? "private" : "public";
    }
    if (isCurrentGeneration()) {
      // A fresh check that got no answer must not replace what other readers see.
      if (!unanswered || !getLastKnownVisibility(roomName)) setCachedVisibility(roomName, visibility);
      // A definitive refusal (404, 401, a plain 403) also retires a remembered public answer.
      if (!unanswered) setLastKnownVisibility(roomName, visibility);
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

// Keyed `room::credential`: a fresh read shared only by the same token.
const freshRepoInflight = new Map<string, {
  roomKey: string;
  promise: Promise<FreshRepoRead>;
}>();

/** `repo`: GitHub's 200 body; null for a 404; undefined for any other answer. */
type FreshRepoRead = { visibility: GitHubRepoVisibility; repo: GitHubRepo | null | undefined };

/**
 * The fresh, signed-in visibility lookup, keeping GitHub's 200 body for the
 * role check that follows with the same token. Visibility caches change as in
 * the "fresh-authenticated" lookup: a fresh check never falls back to a
 * remembered answer, and one GitHub did not answer replaces nothing.
 */
async function loadFreshRepoForCredential(
  roomName: string,
  accessToken: string,
): Promise<FreshRepoRead> {
  const roomKey = normalizeCacheKey(roomName);
  const credential = createHash("sha256").update(accessToken).digest("hex").slice(0, 32);
  const flightKey = `${roomKey}::${credential}`;
  const existing = freshRepoInflight.get(flightKey);
  if (existing) return existing.promise;
  const roomGeneration = getCacheGeneration(repoRoomCacheGeneration, roomKey);
  let pending!: Promise<FreshRepoRead>;
  pending = (async () => {
    const response = await fetchGitHubRepo(roomName, accessToken);
    const outcome = await classifyVisibilityLookupResponse(response, Date.now(), false);
    const unanswered = outcome.kind === "unanswered";
    let visibility: GitHubRepoVisibility = "unknown";
    let repo: GitHubRepo | null | undefined = response.status === 404 ? null : undefined;
    if (response.ok) {
      repo = (await response.json()) as GitHubRepo;
      visibility = repo.private ? "private" : "public";
    }
    if (getCacheGeneration(repoRoomCacheGeneration, roomKey) === roomGeneration) {
      if (!unanswered || !getLastKnownVisibility(roomName)) setCachedVisibility(roomName, visibility);
      if (!unanswered) setLastKnownVisibility(roomName, visibility);
    }
    return { visibility, repo };
  })().finally(() => {
    if (freshRepoInflight.get(flightKey)?.promise === pending) freshRepoInflight.delete(flightKey);
  });
  freshRepoInflight.set(flightKey, { roomKey, promise: pending });
  return pending;
}

type VisibilityLookupOutcome =
  | { kind: "answered" }
  | { kind: "unanswered"; retryAt: number | null };

// Only throttling, timeouts and server errors mean GitHub gave no answer.
// Anything else, including a 403 refusal such as a blocked repository and a
// 401 to a token-less call, answers the question: the repository is not
// public. This is deliberately narrower than isIndeterminateGitHubAccessResponse.
// A 401 or a plain 403 to a signed-in token (dead token, SSO not authorized,
// suspended account) says something about that token, not the visibility.
async function classifyVisibilityLookupResponse(
  response: Response,
  now: number,
  anonymous: boolean,
): Promise<VisibilityLookupOutcome> {
  if (response.ok) return { kind: "answered" };
  if (response.status === 408 || response.status >= 500 || (response.status === 401 && !anonymous)) {
    return { kind: "unanswered", retryAt: null };
  }
  if (response.status !== 403 && response.status !== 429) return { kind: "answered" };
  const retryAfter = response.headers.get("retry-after");
  const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
  let retryAt: number | null = null;
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    retryAt = Number.isFinite(seconds) && seconds >= 0
      ? now + seconds * 1000
      : now + REPO_VISIBILITY_RATE_LIMIT_DEFAULT_BACKOFF_MS;
  } else if (exhausted) {
    const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
    retryAt = Number.isFinite(resetSeconds) && resetSeconds > 0
      ? resetSeconds * 1000
      : now + REPO_VISIBILITY_RATE_LIMIT_DEFAULT_BACKOFF_MS;
  } else if (response.status === 429
    || /secondary rate limit/i.test(await response.text().catch(() => ""))) {
    retryAt = now + REPO_VISIBILITY_RATE_LIMIT_DEFAULT_BACKOFF_MS;
  }
  if (retryAt === null) return anonymous ? { kind: "answered" } : { kind: "unanswered", retryAt: null };
  return {
    kind: "unanswered",
    retryAt: Math.min(
      Math.max(retryAt, now + REPO_VISIBILITY_UNKNOWN_TTL_MS),
      now + REPO_VISIBILITY_RATE_LIMIT_MAX_BACKOFF_MS,
    ),
  };
}

export async function isGitHubRepoCollaborator(input: {
  roomName: string;
  login: string;
  accessToken: string;
  // When true, skip the positive-access cache entirely (read AND write) so the
  // decision reflects live GitHub access — used for source-diff requests where a
  // revoked collaborator must lose access immediately, not up to 30 minutes later.
  bypassCache?: boolean;
  // Authority-revalidation callers must distinguish a definitive denial from
  // GitHub throttling/outage responses. Throwing preserves the current grant
  // for retry instead of destructively treating uncertainty as access loss.
  throwOnIndeterminate?: boolean;
  // Injectable for tests; production uses the global fetch (bounded by a deadline).
  fetchImpl?: typeof fetch;
  // The repository as GitHub just returned it (200) to this same token, or
  // null for a 404 to it, so a fresh check does not read it twice.
  prefetchedRepo?: GitHubRepo | null;
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
  // A caller that opted into the throw never shares a flight with one that
  // did not: the same GitHub answer means a throw for one and false for the other.
  const flightKey = `${input.throwOnIndeterminate ? "strict" : "lenient"}::${input.bypassCache ? "fresh" : "cached"}::${cacheKey}`;
  const existing = repoAccessInflight.get(flightKey);
  if (existing) return existing.promise;

  const roomGeneration = getCacheGeneration(repoRoomCacheGeneration, roomKey);
  const loginGeneration = getCacheGeneration(repoLoginCacheGeneration, loginKey);
  const personGeneration = getCacheGeneration(repoPersonCacheGeneration, cacheKey);
  const doFetch = input.fetchImpl ?? fetch;

  let pending!: Promise<boolean>;
  pending = (async () => {
    const repo = parseGitHubRepoName(input.roomName);
    if (!repo) return false;

    let repoPayload: GitHubRepo;
    if (input.prefetchedRepo === null) {
      // A 404: the token cannot see the repository. An answer, not an outage.
      return false;
    } else if (input.prefetchedRepo) {
      repoPayload = input.prefetchedRepo;
    } else {
      let ownerResponse: Response;
      try {
        ownerResponse = await fetchGitHubRepo(input.roomName, input.accessToken, doFetch);
      } catch {
        throw new GitHubAccessUnavailableError(null);
      }
      if (!ownerResponse.ok) {
        if (input.throwOnIndeterminate && isIndeterminateGitHubAccessResponse(ownerResponse)) {
          throw new Error(`GitHub repo access revalidation was indeterminate (${ownerResponse.status}).`);
        }
        if (await isGitHubOutageResponse(ownerResponse)) throw new GitHubAccessUnavailableError(ownerResponse.status);
        return false;
      }
      repoPayload = (await ownerResponse.json()) as GitHubRepo;
    }
    let allowed = repoPayload.owner?.login?.toLowerCase() === loginKey;
    if (!allowed) {
      let permissionResponse: Response;
      try {
        permissionResponse = await githubRequest({
        url: buildGitHubApiUrl(
          `/repos/${repo.owner}/${repo.repo}/collaborators/${encodeURIComponent(input.login)}/permission`
        ),
        token: input.accessToken,
        fetchImpl: doFetch,
        timeoutMs: GITHUB_ACCESS_FETCH_TIMEOUT_MS,
      });
      } catch {
        throw new GitHubAccessUnavailableError(null);
      }
      if (!permissionResponse.ok) {
        if (input.throwOnIndeterminate && isIndeterminateGitHubAccessResponse(permissionResponse)) {
          throw new Error(`GitHub collaborator revalidation was indeterminate (${permissionResponse.status}).`);
        }
        if (await isGitHubOutageResponse(permissionResponse)) throw new GitHubAccessUnavailableError(permissionResponse.status);
        return false;
      }
      const permissionPayload = (await permissionResponse.json()) as GitHubPermissionResponse;
      allowed = Boolean(permissionPayload.permission);
    }

    if (
      allowed
      && !input.bypassCache
      && getCacheGeneration(repoRoomCacheGeneration, roomKey) === roomGeneration
      && getCacheGeneration(repoLoginCacheGeneration, loginKey) === loginGeneration
      && getCacheGeneration(repoPersonCacheGeneration, cacheKey) === personGeneration
    ) {
      setCachedRepoAccess(input.roomName, input.login, true);
    }
    return allowed;
  })().then((allowed) => {
    if (!allowed && input.bypassCache) forgetPersonAccess(roomKey, loginKey);
    return allowed;
  }).finally(() => {
    if (repoAccessInflight.get(flightKey)?.promise === pending) {
      repoAccessInflight.delete(flightKey);
    }
  });
  repoAccessInflight.set(flightKey, { roomKey, loginKey, promise: pending });
  return pending;
}

/** GitHub gave no answer to a role check: an outage, a rate limit or an expired token. */
export class GitHubAccessUnavailableError extends Error {
  constructor(status: number | null) {
    super(`GitHub did not answer the repository role check${status ? ` (${status})` : ""}.`);
    this.name = "GitHubAccessUnavailableError";
  }
}

/**
 * Whether this login has a GitHub role on a public repository: it owns the
 * repository, or GitHub reports triage, write, maintain or admin for the
 * person's own token. On a public repository GitHub reports read access for
 * everyone, and its per-user permission endpoint refuses callers without push
 * access, so a read-only collaborator cannot be told apart from the public and
 * does not count.
 *
 * When GitHub gives no answer, a positive answer from the last hour stands
 * in; without one it throws GitHubAccessUnavailableError, never a "no".
 * Parallel checks for one person and repository share one request.
 */
export async function isGitHubPublicRepoRoleHolder(input: {
  roomName: string;
  login: string;
  accessToken: string;
  bypassCache?: boolean;
  throwOnIndeterminate?: boolean;
  fetchImpl?: typeof fetch;
  /** As for isGitHubRepoCollaborator: GitHub's 200 body (or null for a 404) to this same token. */
  prefetchedRepo?: GitHubRepo | null;
}): Promise<boolean> {
  const roomKey = normalizeCacheKey(input.roomName);
  const loginKey = normalizeCacheKey(input.login);
  const cacheKey = `${roomKey}::${loginKey}`;
  if (!input.bypassCache) {
    const cached = publicRepoRoleCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.allowed;
    if (cached) publicRepoRoleCache.delete(cacheKey);
  }
  if (!parseGitHubRepoName(input.roomName)) return false;

  const flightKey = `${input.throwOnIndeterminate ? "strict" : "lenient"}::${input.bypassCache ? "fresh" : "cached"}::${cacheKey}`;
  const existing = publicRepoRoleInflight.get(flightKey);
  if (existing) return existing;
  const pending = (async () => {
    const roomGeneration = getCacheGeneration(repoRoomCacheGeneration, roomKey);
    const loginGeneration = getCacheGeneration(repoLoginCacheGeneration, loginKey);
    const personGeneration = getCacheGeneration(repoPersonCacheGeneration, cacheKey);
    const unavailable = (status: number | null): boolean => {
      const lastKnown = publicRepoRoleLastKnown.get(cacheKey);
      if (lastKnown && lastKnown.expiresAt > Date.now()) return true;
      throw new GitHubAccessUnavailableError(status);
    };
    let payload: GitHubRepo;
    if (input.prefetchedRepo === null) {
      publicRepoRoleLastKnown.delete(cacheKey);
      return false;
    } else if (input.prefetchedRepo) {
      payload = input.prefetchedRepo;
    } else {
      let response: Response;
      try {
        response = await fetchGitHubRepo(input.roomName, input.accessToken, input.fetchImpl ?? fetch);
      } catch {
        return unavailable(null);
      }
      if (!response.ok) {
        // Authority revalidation keeps its grant on any unanswered check,
        // a dead owner token included.
        if (input.throwOnIndeterminate && isIndeterminateGitHubAccessResponse(response)) {
          throw new Error(`GitHub repo role check was indeterminate (${response.status}).`);
        }
        // A dead token (401) or one blocked by the organization (plain 403) is
        // GitHub's answer for this token: no role. Only an outage is a retry.
        if (await isGitHubOutageResponse(response)) return unavailable(response.status);
        publicRepoRoleLastKnown.delete(cacheKey);
        return false;
      }
      payload = (await response.json()) as GitHubRepo;
    }
    const permissions = payload.permissions ?? {};
    const allowed = payload.owner?.login?.toLowerCase() === loginKey
      || Boolean(permissions.triage || permissions.push || permissions.maintain || permissions.admin);
    const generationsHold = getCacheGeneration(repoRoomCacheGeneration, roomKey) === roomGeneration
      && getCacheGeneration(repoLoginCacheGeneration, loginKey) === loginGeneration
      && getCacheGeneration(repoPersonCacheGeneration, cacheKey) === personGeneration;
    if (allowed && generationsHold) {
      pruneExpiringCache(publicRepoRoleLastKnown, REPO_CACHE_MAX_ENTRIES);
      publicRepoRoleLastKnown.set(cacheKey, { expiresAt: Date.now() + REPO_VISIBILITY_LAST_KNOWN_MAX_AGE_MS });
    } else if (!allowed) {
      publicRepoRoleLastKnown.delete(cacheKey);
    }
    if (!input.bypassCache && generationsHold) {
      pruneExpiringCache(publicRepoRoleCache, REPO_CACHE_MAX_ENTRIES);
      publicRepoRoleCache.set(cacheKey, {
        allowed,
        expiresAt: Date.now() + (allowed ? REPO_ACCESS_TTL_MS : PUBLIC_REPO_NO_ROLE_TTL_MS),
      });
    }
    return allowed;
  })().then((allowed) => {
    if (!allowed && input.bypassCache) forgetPersonAccess(roomKey, loginKey);
    return allowed;
  }).finally(() => {
    if (publicRepoRoleInflight.get(flightKey) === pending) publicRepoRoleInflight.delete(flightKey);
  });
  publicRepoRoleInflight.set(flightKey, pending);
  return pending;
}

/**
 * An answer that says nothing about the person's access: a timeout, a rate
 * limit (429, or a 403 with rate-limit signs) or a server error. A 401 (dead
 * token) and a plain 403 (for example SSO not authorized) are answers about
 * the token and count as no access.
 */
async function isGitHubOutageResponse(response: Response): Promise<boolean> {
  if (response.status === 408 || response.status === 429 || response.status >= 500) return true;
  if (response.status !== 403) return false;
  if (response.headers.get("retry-after") !== null || response.headers.get("x-ratelimit-remaining") === "0") return true;
  return /rate limit|abuse/i.test(await response.clone().text().catch(() => ""));
}

function isIndeterminateGitHubAccessResponse(response: Response): boolean {
  return response.status === 401
    || response.status === 403
    || response.status === 408
    || response.status === 429
    || response.status >= 500;
}

/**
 * Whether this login can push to the repo (owner, or admin/maintain/write),
 * asked of GitHub now and never cached: it gates actions where the GitHub App
 * pushes for the caller.
 */
export async function isGitHubRepoWriter(input: {
  roomName: string;
  login: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const repo = parseGitHubRepoName(input.roomName);
  if (!repo || !input.accessToken) return false;
  const doFetch = input.fetchImpl ?? fetch;
  const ownerResponse = await fetchGitHubRepo(input.roomName, input.accessToken, doFetch);
  if (!ownerResponse.ok) return false;
  const repoPayload = (await ownerResponse.json()) as GitHubRepo;
  if (repoPayload.owner?.login?.toLowerCase() === input.login.toLowerCase()) return true;
  const permissionResponse = await githubRequest({
    url: buildGitHubApiUrl(`/repos/${repo.owner}/${repo.repo}/collaborators/${encodeURIComponent(input.login)}/permission`),
    token: input.accessToken,
    fetchImpl: doFetch,
    timeoutMs: GITHUB_ACCESS_FETCH_TIMEOUT_MS,
  });
  if (!permissionResponse.ok) return false;
  const payload = (await permissionResponse.json()) as GitHubPermissionResponse & { role_name?: string };
  return payload.permission === "admin" || payload.permission === "write"
    || payload.role_name === "maintain" || payload.role_name === "write" || payload.role_name === "admin";
}

/**
 * Whether this login owns the repository or has the "admin" collaborator
 * permission, asked of GitHub with this token.
 *
 * Only a definitive "not admin" (a 200 without "admin", or a 404) is kept, for
 * REPO_NOT_ADMIN_TTL_MS, and only for the same token: the cache and the
 * in-flight request are keyed by room, a hash of the token, and login. A "yes"
 * is never kept, because the caller turns it into a permanent admin row. A
 * 401, a plain 403 or an outage is "not admin" and is not kept. Webhook,
 * sign-in and fresh-"no" invalidation clear both maps.
 */
export async function isGitHubRepoAdmin(input: {
  roomName: string;
  login: string;
  accessToken: string;
}): Promise<boolean> {
  const repo = parseGitHubRepoName(input.roomName);
  const roomKey = canonicalRepoRoomKey(input.roomName);
  if (!repo || !roomKey) return false;
  const loginKey = normalizeCacheKey(input.login);
  // A call without a token asks GitHub every time, as before.
  const shared = Boolean(input.accessToken);
  const cacheKey = repoAdminCredentialKey(roomKey, input.accessToken, loginKey);

  if (shared) {
    const cached = repoNotAdminCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return false;
    if (cached) repoNotAdminCache.delete(cacheKey);
    const existing = repoAdminInflight.get(cacheKey);
    if (existing) return existing.promise;
  }

  const generationsHold = captureRepoPersonGenerations(roomKey, loginKey);
  const notAdmin = (response: Response): false => {
    const definitive = response.ok || response.status === 404;
    if (shared && definitive && generationsHold()) {
      pruneExpiringCache(repoNotAdminCache, REPO_CACHE_MAX_ENTRIES);
      repoNotAdminCache.set(cacheKey, { expiresAt: Date.now() + REPO_NOT_ADMIN_TTL_MS });
    }
    return false;
  };
  const lookup = async (): Promise<boolean> => {
    const ownerResponse = await fetchGitHubRepo(input.roomName, input.accessToken);
    if (!ownerResponse.ok) return notAdmin(ownerResponse);

    const repoPayload = (await ownerResponse.json()) as GitHubRepo;
    if (repoPayload.owner?.login?.toLowerCase() === loginKey) {
      return true;
    }

    const permissionResponse = await githubRequest({
      url: buildGitHubApiUrl(
        `/repos/${repo.owner}/${repo.repo}/collaborators/${encodeURIComponent(input.login)}/permission`
      ),
      token: input.accessToken,
      timeoutMs: GITHUB_ACCESS_FETCH_TIMEOUT_MS,
    });
    if (!permissionResponse.ok) return notAdmin(permissionResponse);

    const permissionPayload = (await permissionResponse.json()) as GitHubPermissionResponse;
    return permissionPayload.permission === "admin" ? true : notAdmin(permissionResponse);
  };
  if (!shared) return lookup();
  let pending!: Promise<boolean>;
  pending = lookup().finally(() => {
    if (repoAdminInflight.get(cacheKey)?.promise === pending) repoAdminInflight.delete(cacheKey);
  });
  repoAdminInflight.set(cacheKey, { roomKey, loginKey, promise: pending });
  return pending;
}

export async function resolveGitHubRepoRoomAccessDecision(input: {
  roomName: string;
  sessionAccount: RepoRoomAccessIdentity | null | undefined;
  freshCollaboratorCheck?: boolean;
  throwOnIndeterminate?: boolean;
}, deps: RepoRoomAccessDecisionDeps = {
  getVisibility: getGitHubRepoVisibility,
  isCollaborator: isGitHubRepoCollaborator,
}): Promise<RepoRoomAccessDecision> {
  const githubRepo = parseGitHubRepoName(input.roomName);
  if (!githubRepo) {
    // Fail closed. Only github.com repositories have a visibility and
    // collaborator check, so any other host must never be admitted.
    return { kind: "unsupported_repo_provider" };
  }

  // Key every lookup, and so every cache entry, on the canonical room name.
  // Webhook invalidation clears `github.com/owner/repo`; an alias spelling
  // (`ssh.github.com/owner/repo`) would otherwise keep a stale entry.
  const canonicalRoomName = `github.com/${githubRepo.owner}/${githubRepo.repo}`.toLowerCase();

  // Every repo room needs a sign-in: no GitHub lookup for a caller without one.
  if (!input.sessionAccount) {
    return { kind: "auth_required" };
  }

  const accessToken = input.sessionAccount.provider_access_token ?? undefined;
  // A fresh check with a token reads the repository once: its 200 body gives
  // the visibility, the owner and the token's own permissions, and the role
  // check below reuses it. Any other answer leaves the role check to ask
  // again, as before, so its outage and refusal handling is unchanged.
  let prefetchedRepo: GitHubRepo | null | undefined;
  let visibility: GitHubRepoVisibility;
  const loadFresh = deps.loadFreshRepo ?? (deps.getVisibility === getGitHubRepoVisibility ? loadFreshRepoForCredential : null);
  if (input.freshCollaboratorCheck && accessToken && loadFresh) {
    const fresh = await loadFresh(canonicalRoomName, accessToken);
    visibility = fresh.visibility;
    prefetchedRepo = fresh.repo;
  } else {
    visibility = await deps.getVisibility(canonicalRoomName, accessToken, {
      bypassCache: input.freshCollaboratorCheck,
    });
  }
  // GitHub gave no answer (a fresh check does not use the remembered one): a
  // repository known to be public in the last hour goes to its role check,
  // which retries during an outage instead of refusing like a private repo.
  if (visibility === "unknown" && (deps.getLastKnownVisibility ?? getLastKnownVisibility)(canonicalRoomName) === "public") {
    visibility = "public";
  }

  if (visibility === "public") {
    if (
      input.sessionAccount.provider !== "github" ||
      !input.sessionAccount.provider_access_token ||
      !input.sessionAccount.login
    ) {
      return { kind: "repo_collaborator_required" };
    }
    const isRoleHolder = deps.isPublicRepoRoleHolder ?? isGitHubPublicRepoRoleHolder;
    let allowed: boolean;
    try {
      allowed = await isRoleHolder({
        roomName: canonicalRoomName,
        login: input.sessionAccount.login,
        accessToken: input.sessionAccount.provider_access_token,
        bypassCache: input.freshCollaboratorCheck,
        throwOnIndeterminate: input.throwOnIndeterminate,
        ...(prefetchedRepo !== undefined ? { prefetchedRepo } : {}),
      });
    } catch (error) {
      // Authority revalidation keeps its grant on an outage, by the throw.
      if (input.throwOnIndeterminate || !(error instanceof GitHubAccessUnavailableError)) throw error;
      return { kind: "repo_access_unavailable" };
    }
    return allowed ? { kind: "allow" } : { kind: "repo_collaborator_required" };
  }

  if (
    input.sessionAccount.provider !== "github" ||
    !input.sessionAccount.provider_access_token ||
    !input.sessionAccount.login
  ) {
    return { kind: "private_repo_no_access" };
  }

  let allowed: boolean;
  try {
    allowed = await deps.isCollaborator({
      roomName: canonicalRoomName,
      login: input.sessionAccount.login,
      accessToken: input.sessionAccount.provider_access_token,
      bypassCache: input.freshCollaboratorCheck,
      throwOnIndeterminate: input.throwOnIndeterminate,
      ...(prefetchedRepo !== undefined ? { prefetchedRepo } : {}),
    });
  } catch (error) {
    // A GitHub outage is a retry, not "no access"; a dead or blocked token
    // came back as false above. Authority revalidation keeps its throw.
    if (input.throwOnIndeterminate || !(error instanceof GitHubAccessUnavailableError)) throw error;
    return { kind: "repo_access_unavailable" };
  }

  return allowed ? { kind: "allow" } : { kind: "private_repo_no_access" };
}
