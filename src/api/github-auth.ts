interface GitHubAccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

export interface GitHubDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

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

export function getGitHubOAuthConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const baseUrl = process.env.LETAGENTS_BASE_URL || process.env.PUBLIC_API_URL || "http://localhost:3001";
  const scopes = process.env.GITHUB_OAUTH_SCOPES || "read:user,repo";

  return {
    clientId,
    clientSecret,
    baseUrl,
    scopes,
    callbackUrl: `${baseUrl}/auth/github/callback`,
  };
}

export function buildGitHubAuthorizeUrl(state: string): string {
  const config = getGitHubOAuthConfig();
  if (!config.clientId) {
    throw new Error("GITHUB_CLIENT_ID is not configured");
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: config.scopes,
    state,
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeGitHubCodeForAccessToken(code: string): Promise<string> {
  const config = getGitHubOAuthConfig();

  if (!config.clientId || !config.clientSecret) {
    throw new Error("GitHub OAuth is not configured");
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed with status ${response.status}`);
  }

  const payload = (await response.json()) as GitHubAccessTokenResponse;
  if (!payload.access_token) {
    throw new Error(payload.error_description || payload.error || "GitHub token exchange failed");
  }

  return payload.access_token;
}

export async function requestGitHubDeviceCode(): Promise<GitHubDeviceCodeResponse> {
  const config = getGitHubOAuthConfig();
  if (!config.clientId) {
    throw new Error("GITHUB_CLIENT_ID is not configured");
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scopes,
  });

  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`GitHub device code request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as Partial<GitHubDeviceCodeResponse> & GitHubAccessTokenResponse;
  if (!payload.device_code || !payload.user_code || !payload.verification_uri || !payload.expires_in || !payload.interval) {
    throw new Error(payload.error_description || payload.error || "GitHub device code request failed");
  }

  return {
    device_code: payload.device_code,
    user_code: payload.user_code,
    verification_uri: payload.verification_uri,
    expires_in: payload.expires_in,
    interval: payload.interval,
  };
}

export async function exchangeGitHubDeviceCodeForAccessToken(input: {
  deviceCode: string;
}): Promise<
  | { status: "authorized"; accessToken: string; scope: string | undefined }
  | { status: "pending"; interval: number | undefined }
  | { status: "slow_down"; interval: number | undefined }
  | { status: "denied" }
  | { status: "expired" }
> {
  const config = getGitHubOAuthConfig();
  if (!config.clientId) {
    throw new Error("GITHUB_CLIENT_ID is not configured");
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    device_code: input.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`GitHub device token exchange failed with status ${response.status}`);
  }

  const payload = (await response.json()) as GitHubAccessTokenResponse;
  if (payload.access_token) {
    return {
      status: "authorized",
      accessToken: payload.access_token,
      scope: payload.scope,
    };
  }

  switch (payload.error) {
    case "authorization_pending":
      return { status: "pending", interval: payload.interval };
    case "slow_down":
      return { status: "slow_down", interval: payload.interval };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      throw new Error(payload.error_description || payload.error || "GitHub device token exchange failed");
  }
}

export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "letagents",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user fetch failed with status ${response.status}`);
  }

  const payload = (await response.json()) as GitHubUser;
  return payload;
}

export function parseGitHubRepoName(roomName: string): { owner: string; repo: string } | null {
  const match = /^github\.com\/([^/]+)\/([^/]+)$/.exec(roomName);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
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
