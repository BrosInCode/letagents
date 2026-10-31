/**
 * OAuth 2.1 for the remote MCP endpoint, per the MCP specification's
 * Authorization section (revision 2026-07-28). LetAgents is both the protected
 * resource (`/mcp`) and its authorization server. The issuer is the public base
 * URL that the remote MCP endpoint already uses.
 */
/** The remote MCP endpoint's path (REMOTE_MCP_PATH in routes/mcp/remote.ts). */
export const REMOTE_MCP_PATH = "/mcp";
export const MCP_OAUTH_SCOPE = "mcp";
/** Accepted in requests; refresh tokens are issued with or without it. */
export const MCP_OAUTH_OFFLINE_SCOPE = "offline_access";
export const MCP_OAUTH_ACCESS_TTL_MS = 60 * 60_000;
export const MCP_OAUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
export const MCP_OAUTH_CODE_TTL_MS = 5 * 60_000;
/** How long a consent page stays valid. */
export const MCP_OAUTH_CONSENT_TTL_MS = 10 * 60_000;
/** A registered client nobody approved within this time is deleted. */
export const MCP_OAUTH_UNUSED_CLIENT_TTL_MS = 24 * 60 * 60_000;

export const MCP_OAUTH_PATHS = {
  protectedResource: "/.well-known/oauth-protected-resource",
  authorizationServer: "/.well-known/oauth-authorization-server",
  authorize: "/oauth/authorize",
  decision: "/oauth/authorize/decision",
  token: "/oauth/token",
  register: "/oauth/register",
  revoke: "/oauth/revoke",
} as const;

export interface McpOAuthUrls {
  issuer: string;
  /** The canonical URI of the MCP server: the audience of every issued token. */
  resource: string;
  /** RFC 9728 path-inserted metadata URL for the resource. */
  resourceMetadata: string;
}

/** Same base as RemoteMcpSessions: LETAGENTS_BASE_URL, then PUBLIC_API_URL, then production. */
export function mcpOAuthUrls(env: NodeJS.ProcessEnv = process.env): McpOAuthUrls {
  const raw = (env.LETAGENTS_BASE_URL || env.PUBLIC_API_URL || "https://letagents.chat").trim();
  const url = new URL(raw);
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  const basePath = url.pathname.replace(/\/+$/, "");
  return {
    issuer: base,
    resource: `${base}${REMOTE_MCP_PATH}`,
    resourceMetadata: `${url.origin}${MCP_OAUTH_PATHS.protectedResource}${basePath}${REMOTE_MCP_PATH}`,
  };
}

/** The WWW-Authenticate value for a /mcp request without a usable token. */
export function mcpBearerChallenge(error?: "invalid_token"): string {
  const parts = [`resource_metadata="${mcpOAuthUrls().resourceMetadata}"`, `scope="${MCP_OAUTH_SCOPE}"`];
  if (error) parts.unshift(`error="${error}"`);
  return `Bearer ${parts.join(", ")}`;
}

/** True for the remote MCP endpoint's path, with or without a trailing slash. */
export function isRemoteMcpRequestPath(path: string | undefined): boolean {
  return path === REMOTE_MCP_PATH || path === `${REMOTE_MCP_PATH}/`;
}
