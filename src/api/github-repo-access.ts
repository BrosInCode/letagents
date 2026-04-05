import { parseRepoRoomName } from "./repo-workflow.js";

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
  }) => Promise<boolean>;
}

const REPO_VISIBILITY_TTL_MS = 1000 * 60 * 60;
const REPO_ACCESS_TTL_MS = 1000 * 60 * 30;
const repoVisibilityCache = new Map<string, { visibility: GitHubRepoVisibility; expiresAt: number }>();
const repoAccessCache = new Map<string, { allowed: boolean; expiresAt: number }>();

function getCachedVisibility(roomName: string): GitHubRepoVisibility | null {
  const cached = repoVisibilityCache.get(roomName);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    repoVisibilityCache.delete(roomName);
    return null;
  }
  return cached.visibility;
}

function setCachedVisibility(roomName: string, visibility: GitHubRepoVisibility): void {
  repoVisibilityCache.set(roomName, {
    visibility,
    expiresAt: Date.now() + REPO_VISIBILITY_TTL_MS,
  });
}

function getCachedRepoAccess(roomName: string, login: string): boolean | null {
  const cacheKey = `${roomName.toLowerCase()}::${login.toLowerCase()}`;
  const cached = repoAccessCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    repoAccessCache.delete(cacheKey);
    return null;
  }
  return cached.allowed;
}

function setCachedRepoAccess(roomName: string, login: string, allowed: boolean): void {
  const cacheKey = `${roomName.toLowerCase()}::${login.toLowerCase()}`;
  repoAccessCache.set(cacheKey, {
    allowed,
    expiresAt: Date.now() + REPO_ACCESS_TTL_MS,
  });
}

export function clearGitHubRepoAccessCacheForLogin(login: string): void {
  const suffix = `::${login.toLowerCase()}`;
  for (const cacheKey of repoAccessCache.keys()) {
    if (cacheKey.endsWith(suffix)) {
      repoAccessCache.delete(cacheKey);
    }
  }
}

export function parseGitHubRepoName(roomName: string): { owner: string; repo: string } | null {
  const repoRef = parseRepoRoomName(roomName);
  if (!repoRef || repoRef.provider !== "github" || repoRef.namespace.includes("/")) {
    return null;
  }
  return { owner: repoRef.namespace, repo: repoRef.repo };
}

async function fetchGitHubRepo(roomName: string, accessToken?: string): Promise<Response> {
  const repo = parseGitHubRepoName(roomName);
  if (!repo) {
    throw new Error("Room is not a GitHub repo locator");
  }

  return fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      Accept: "application/vnd.github+json",
      "User-Agent": "letagents",
    },
  });
}

export async function getGitHubRepoVisibility(
  roomName: string,
  accessToken?: string
): Promise<GitHubRepoVisibility> {
  const cached = getCachedVisibility(roomName);
  if (cached) {
    return cached;
  }

  const unauthenticated = await fetchGitHubRepo(roomName);
  if (unauthenticated.ok) {
    const payload = (await unauthenticated.json()) as GitHubRepo;
    const visibility = payload.private ? "private" : "public";
    setCachedVisibility(roomName, visibility);
    return visibility;
  }

  if (unauthenticated.status === 404 && accessToken) {
    const authenticated = await fetchGitHubRepo(roomName, accessToken);
    if (authenticated.ok) {
      const payload = (await authenticated.json()) as GitHubRepo;
      const visibility = payload.private ? "private" : "public";
      setCachedVisibility(roomName, visibility);
      return visibility;
    }
  }

  setCachedVisibility(roomName, "unknown");
  return "unknown";
}

export async function isGitHubRepoCollaborator(input: {
  roomName: string;
  login: string;
  accessToken: string;
}): Promise<boolean> {
  const cached = getCachedRepoAccess(input.roomName, input.login);
  if (cached !== null) {
    return cached;
  }

  const repo = parseGitHubRepoName(input.roomName);
  if (!repo) return false;

  const ownerResponse = await fetchGitHubRepo(input.roomName, input.accessToken);
  if (!ownerResponse.ok) {
    setCachedRepoAccess(input.roomName, input.login, false);
    return false;
  }

  const repoPayload = (await ownerResponse.json()) as GitHubRepo;
  if (repoPayload.owner?.login?.toLowerCase() === input.login.toLowerCase()) {
    setCachedRepoAccess(input.roomName, input.login, true);
    return true;
  }

  const permissionResponse = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/collaborators/${encodeURIComponent(input.login)}/permission`,
    {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "letagents",
      },
    }
  );

  if (!permissionResponse.ok) {
    setCachedRepoAccess(input.roomName, input.login, false);
    return false;
  }

  const permissionPayload = (await permissionResponse.json()) as GitHubPermissionResponse;
  const allowed = Boolean(permissionPayload.permission);
  setCachedRepoAccess(input.roomName, input.login, allowed);
  return allowed;
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
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/collaborators/${encodeURIComponent(input.login)}/permission`,
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
  });

  return allowed ? { kind: "allow" } : { kind: "private_repo_no_access" };
}
