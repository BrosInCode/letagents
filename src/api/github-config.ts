import { db } from "./db/client.js";
import { system_github_app } from "./db/schema.js";

const DEFAULT_BASE_URL = "http://localhost:3001";

export interface GitHubOAuthConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  baseUrl: string;
  scopes: string;
  callbackUrl: string;
}

export interface GitHubAppConfig {
  appId: string | undefined;
  appSlug: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  privateKey: string | undefined;
  webhookSecret: string | undefined;
  baseUrl: string;
  callbackUrl: string;
  setupUrl: string;
}

function resolveBaseUrl(): string {
  return process.env.LETAGENTS_BASE_URL || process.env.PUBLIC_API_URL || DEFAULT_BASE_URL;
}

function normalizePrivateKey(privateKey: string | undefined): string | undefined {
  const trimmed = privateKey?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\\n/g, "\n");
}

export function getGitHubOAuthConfig(): GitHubOAuthConfig {
  const baseUrl = resolveBaseUrl();
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const scopes = process.env.GITHUB_OAUTH_SCOPES || "read:user,repo";

  return {
    clientId,
    clientSecret,
    baseUrl,
    scopes,
    callbackUrl: `${baseUrl}/auth/github/callback`,
  };
}

export async function getGitHubAppConfig(): Promise<GitHubAppConfig> {
  const baseUrl = resolveBaseUrl();
  const setupUrl = `${baseUrl}/auth/github/app/callback`;

  try {
    const dbConfigList = await db.select().from(system_github_app).limit(1);
    if (dbConfigList.length > 0) {
      const dbConfig = dbConfigList[0];
      return {
        appId: dbConfig.app_id,
        appSlug: dbConfig.app_slug,
        clientId: dbConfig.client_id,
        clientSecret: dbConfig.client_secret,
        privateKey: normalizePrivateKey(dbConfig.private_key),
        webhookSecret: dbConfig.webhook_secret,
        baseUrl,
        callbackUrl: setupUrl,
        setupUrl,
      };
    }
  } catch (error) {
    console.error("Failed to load GitHub App config from DB, falling back to env", error);
  }

  return {
    appId: process.env.GITHUB_APP_ID,
    appSlug: process.env.GITHUB_APP_SLUG,
    clientId: process.env.GITHUB_APP_CLIENT_ID,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    privateKey: normalizePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    baseUrl,
    callbackUrl: setupUrl,
    setupUrl,
  };
}

export async function hasGitHubAppConfig(): Promise<boolean> {
  const config = await getGitHubAppConfig();
  return Boolean(
    config.appId &&
      config.clientId &&
      config.clientSecret &&
      config.privateKey &&
      config.webhookSecret
  );
}
