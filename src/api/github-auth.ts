interface GitHubAccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

interface GitHubRepo {
  owner?: {
    login?: string;
  };
}

interface GitHubPermissionResponse {
  permission?: string;
}

export function getGitHubOAuthConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const baseUrl = process.env.LETAGENTS_BASE_URL || process.env.PUBLIC_API_URL || "http://localhost:3001";
  const scopes = process.env.GITHUB_OAUTH_SCOPES || "read:user";

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

export async function isGitHubRepoAdmin(input: {
  roomName: string;
  login: string;
  accessToken: string;
}): Promise<boolean> {
  const repo = parseGitHubRepoName(input.roomName);
  if (!repo) return false;

  const ownerResponse = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "letagents",
    },
  });

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
