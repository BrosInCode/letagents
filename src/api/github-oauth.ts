import { getGitHubOAuthConfig } from "./github-config.js";

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
  if (
    !payload.device_code ||
    !payload.user_code ||
    !payload.verification_uri ||
    !payload.expires_in ||
    !payload.interval
  ) {
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

  return (await response.json()) as GitHubUser;
}
