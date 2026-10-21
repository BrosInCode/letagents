import { createHash, randomBytes } from "node:crypto";

import type { TrackerProvider } from "../../../shared/ticket-connectors.mjs";
import { asRecord, asString, trackerRequest } from "./providers/http.js";
import { TrackerProviderError } from "./providers/types.js";

/**
 * OAuth apps for the trackers. Each provider's OAuth is offered only when both
 * its client id and secret are set; API tokens work without them.
 *
 *   LETAGENTS_JIRA_CLIENT_ID / LETAGENTS_JIRA_CLIENT_SECRET     Atlassian 3LO app
 *   LETAGENTS_LINEAR_CLIENT_ID / LETAGENTS_LINEAR_CLIENT_SECRET Linear OAuth app
 *
 * Callback URLs are `${LETAGENTS_BASE_URL}/account/connectors/oauth/<provider>/callback`.
 * OAuth is off unless LETAGENTS_BASE_URL (or PUBLIC_API_URL) is set to an
 * https URL; plain http is accepted only for an explicit localhost base.
 */
export interface TrackerOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface TrackerOAuthStartParams {
  state: string;
  /** PKCE S256 challenge (Linear). */
  codeChallenge?: string;
}

export interface TrackerOAuthTokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
}

const JIRA_SCOPES = "read:jira-work write:jira-work read:jira-user offline_access";
const LINEAR_SCOPES = "read,write";

export const ATLASSIAN_AUTH_HOST = "auth.atlassian.com";
export const LINEAR_AUTH_HOST = "linear.app";

/** The public base URL for callbacks, or null when none safe is configured. */
function baseUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.LETAGENTS_BASE_URL || env.PUBLIC_API_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function clientCredentials(provider: TrackerProvider, env: NodeJS.ProcessEnv) {
  const prefix = provider === "jira" ? "LETAGENTS_JIRA" : "LETAGENTS_LINEAR";
  const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** The provider's OAuth app, or null when it is not set up or no https base URL is configured. */
export function getTrackerOAuthConfig(
  provider: TrackerProvider,
  env: NodeJS.ProcessEnv = process.env,
): TrackerOAuthConfig | null {
  const client = clientCredentials(provider, env);
  const base = baseUrl(env);
  if (!client || !base) return null;
  return { ...client, callbackUrl: `${base}/account/connectors/oauth/${provider}/callback` };
}

/** OAuth app credentials are set, but the server has no https base URL for the callback. */
export function trackerOAuthMissingBaseUrl(provider: TrackerProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(clientCredentials(provider, env)) && !baseUrl(env);
}

export function buildTrackerAuthorizeUrl(provider: TrackerProvider, config: TrackerOAuthConfig, start: TrackerOAuthStartParams): string {
  const { state } = start;
  if (provider === "jira") {
    const params = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: config.clientId,
      scope: JIRA_SCOPES,
      redirect_uri: config.callbackUrl,
      state,
      response_type: "code",
      prompt: "consent",
    });
    return `https://${ATLASSIAN_AUTH_HOST}/authorize?${params.toString()}`;
  }
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    response_type: "code",
    scope: LINEAR_SCOPES,
    state,
    actor: "user",
    prompt: "consent",
  });
  if (start.codeChallenge) {
    params.set("code_challenge", start.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `https://${LINEAR_AUTH_HOST}/oauth/authorize?${params.toString()}`;
}

function tokensFrom(payload: unknown, now: Date): TrackerOAuthTokens {
  const record = asRecord(payload);
  const accessToken = asString(record.access_token);
  if (!accessToken) throw new TrackerProviderError("auth", "The tracker returned no access token.");
  const expiresIn = Number(record.expires_in);
  return {
    access_token: accessToken,
    refresh_token: asString(record.refresh_token),
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(now.getTime() + expiresIn * 1000).toISOString()
      : null,
  };
}

async function tokenRequest(
  provider: TrackerProvider,
  config: TrackerOAuthConfig,
  grant: Record<string, string>,
  fetchImpl: typeof fetch,
  now: Date,
): Promise<TrackerOAuthTokens> {
  const secrets = [config.clientSecret, grant.code, grant.refresh_token, grant.code_verifier];
  try {
    const response = provider === "jira"
      ? await trackerRequest(fetchImpl, {
          url: `https://${ATLASSIAN_AUTH_HOST}/oauth/token`,
          method: "POST",
          body: { ...grant, client_id: config.clientId, client_secret: config.clientSecret },
          secrets,
        })
      : await trackerRequest(fetchImpl, {
          url: "https://api.linear.app/oauth/token",
          method: "POST",
          form: { ...grant, client_id: config.clientId, client_secret: config.clientSecret },
          secrets,
        });
    return tokensFrom(response.json, now);
  } catch (error) {
    // A refused grant (400 invalid_grant) means the user must reconnect.
    if (error instanceof TrackerProviderError && error.status !== null && error.status >= 400 && error.status < 500) {
      throw new TrackerProviderError("auth", error.message, error.status);
    }
    throw error;
  }
}

export function exchangeTrackerCode(
  provider: TrackerProvider,
  config: TrackerOAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
  codeVerifier: string | null = null,
): Promise<TrackerOAuthTokens> {
  return tokenRequest(provider, config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.callbackUrl,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  }, fetchImpl, now);
}

/** PKCE (RFC 7636) S256 verifier and challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function refreshTrackerTokens(
  provider: TrackerProvider,
  config: TrackerOAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<TrackerOAuthTokens> {
  return tokenRequest(provider, config, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl, now);
}

/** The Jira sites a 3LO token can reach. */
export async function listAtlassianResources(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ id: string; url: string; name: string }>> {
  const response = await trackerRequest(fetchImpl, {
    url: "https://api.atlassian.com/oauth/token/accessible-resources",
    headers: { Authorization: `Bearer ${accessToken}` },
    secrets: [accessToken],
  });
  const list = Array.isArray(response.json) ? response.json : [];
  return list.flatMap((entry) => {
    const record = asRecord(entry);
    const id = asString(record.id);
    const url = asString(record.url);
    const scopes = Array.isArray(record.scopes) ? record.scopes.map(String) : [];
    if (!id || !url || !scopes.some((scope) => scope.includes("jira"))) return [];
    return [{ id, url, name: asString(record.name) ?? url }];
  });
}
