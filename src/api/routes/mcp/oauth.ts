import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";

import { createAuthState, getSessionAccountByToken } from "../../db.js";
import {
  createMcpOAuthAuthorization,
  decideMcpOAuthAuthorization,
  exchangeMcpOAuthCode,
  getMcpOAuthClient,
  getMcpOAuthTokenGrant,
  insertMcpOAuthClient,
  listMcpOAuthGrantsForAccount,
  refreshMcpOAuthGrant,
  revokeMcpOAuthGrant,
  sweepMcpOAuthRows,
  type McpOAuthAuthMethod,
  type McpOAuthClient,
} from "../../db/mcp-oauth.js";
import { buildGitHubAuthorizeUrl } from "../../github/oauth.js";
import { parseCookies, sanitizeRedirectPath, type AuthenticatedRequest } from "../../http/helpers.js";
import {
  MCP_OAUTH_ACCESS_TTL_MS,
  MCP_OAUTH_CODE_TTL_MS,
  MCP_OAUTH_CONSENT_TTL_MS,
  MCP_OAUTH_OFFLINE_SCOPE,
  MCP_OAUTH_PATHS,
  MCP_OAUTH_REFRESH_TTL_MS,
  MCP_OAUTH_SCOPE,
  MCP_OAUTH_UNUSED_CLIENT_TTL_MS,
  REMOTE_MCP_PATH,
  mcpOAuthUrls,
  type McpOAuthUrls,
} from "../../mcp-oauth/config.js";
import {
  grantSecretOf,
  isValidCodeChallenge,
  mintToken,
  randomSecret,
  safeEqual,
  sha256Hex,
  verifyPkceS256,
} from "../../mcp-oauth/tokens.js";
import { buildInMemoryListingsRateLimiter, type ListingsRateLimiter } from "../rental/renter/rate-limiter.js";

/**
 * OAuth 2.1 authorization server for the remote MCP endpoint, following the
 * MCP specification's Authorization section (revision 2026-07-28):
 *
 * - Protected resource metadata (RFC 9728) for `/mcp`, path-inserted and at the root.
 * - Authorization server metadata (RFC 8414).
 * - Dynamic client registration (RFC 7591), rate limited; no management API.
 * - Authorization code grant with PKCE S256 required, exact redirect URI
 *   match, `iss` in every redirect (RFC 9207), and a consent page.
 * - Resource indicators (RFC 8707): every token's audience is the `/mcp` URI.
 * - Refresh tokens rotate on every use; a reused one revokes the grant.
 * - Token revocation (RFC 7009).
 *
 * Tokens issued here are accepted only by `/mcp` (see request/auth.ts).
 */

export interface McpOAuthRouteDeps {
  /** Per-IP budgets; true allows the request. */
  allowRegister?: (key: string) => boolean;
  allowToken?: (key: string) => boolean;
  allowAuthorize?: (key: string) => boolean;
}

const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2000;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_STATE_LENGTH = 2000;
const SWEEP_EVERY_MS = 10 * 60_000;

let lastSweepAt = 0;

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sweepSoon(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_EVERY_MS) return;
  lastSweepAt = now;
  void sweepMcpOAuthRows(new Date(now - MCP_OAUTH_UNUSED_CLIENT_TTL_MS).toISOString()).catch((error: unknown) => {
    console.warn("MCP OAuth sweep failed:", error instanceof Error ? error.name : "unknown error");
  });
}

function isProxyAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/, "");
  return ip === "::1" || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip);
}

/**
 * The rate-limit key. A client can send any X-Forwarded-For value, so only
 * the last entry counts (the address the reverse proxy itself appended), and
 * only when the connection comes from a local proxy.
 */
export function rateLimitKey(req: Pick<Request, "headers" | "socket">): string {
  const socketAddress = req.socket.remoteAddress ?? "unknown";
  const forwarded = req.headers["x-forwarded-for"]?.toString().split(",").map((part) => part.trim()).filter(Boolean);
  const address = isProxyAddress(socketAddress) && forwarded?.length ? forwarded[forwarded.length - 1]! : socketAddress;
  return address.slice(0, 200);
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function oauthError(res: Response, status: number, error: string, description: string, headers: Record<string, string> = {}): void {
  noStore(res);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.status(status).json({ error, error_description: description });
}

function stringParam(source: unknown, name: string): string | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------- metadata

export function protectedResourceMetadata(urls: McpOAuthUrls) {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    // The spec says not to list offline_access here.
    scopes_supported: [MCP_OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "LetAgents",
  };
}

export function authorizationServerMetadata(urls: McpOAuthUrls) {
  return {
    issuer: urls.issuer,
    authorization_endpoint: `${urls.issuer}${MCP_OAUTH_PATHS.authorize}`,
    token_endpoint: `${urls.issuer}${MCP_OAUTH_PATHS.token}`,
    registration_endpoint: `${urls.issuer}${MCP_OAUTH_PATHS.register}`,
    revocation_endpoint: `${urls.issuer}${MCP_OAUTH_PATHS.revoke}`,
    scopes_supported: [MCP_OAUTH_SCOPE, MCP_OAUTH_OFFLINE_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
    service_documentation: "https://github.com/BrosInCode/letagents/blob/staging/AGENTS.md",
  };
}

// ------------------------------------------------------------ validation

/** The spec allows only https redirect URIs, or http to localhost. */
export function isAllowedRedirectUri(value: string): boolean {
  if (value.length > MAX_REDIRECT_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.includes("#") || url.username || url.password) return false;
  if (url.protocol === "https:") return Boolean(url.hostname);
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** The canonical resource for a `resource` parameter, or null when it is not this server's /mcp. */
export function matchesMcpResource(value: string, urls: McpOAuthUrls): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.includes("#") || url.search || url.username || url.password) return false;
  const canonical = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return canonical === urls.resource;
}

function cleanClientName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // No control or bidirectional-override characters in a name shown on the consent page.
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, MAX_CLIENT_NAME_LENGTH) : null;
}

type RegistrationResult =
  | { ok: true; client: Omit<McpOAuthClient, "created_at" | "client_id" | "client_secret_hash"> }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

export function validateRegistration(body: unknown): RegistrationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_client_metadata", description: "The registration must be a JSON object." };
  }
  const input = body as Record<string, unknown>;
  const redirectUris = input.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS
    || !redirectUris.every((uri) => typeof uri === "string")) {
    return { ok: false, error: "invalid_redirect_uri", description: `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.` };
  }
  if (!redirectUris.every((uri) => isAllowedRedirectUri(uri as string))) {
    return { ok: false, error: "invalid_redirect_uri",
      description: "Each redirect URI must be https, or http on localhost, with no fragment or user info." };
  }
  const method = input.token_endpoint_auth_method ?? "client_secret_basic";
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
    return { ok: false, error: "invalid_client_metadata",
      description: "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic." };
  }
  const grantTypes = input.grant_types ?? ["authorization_code"];
  if (!Array.isArray(grantTypes) || !grantTypes.every((type) => type === "authorization_code" || type === "refresh_token")
    || !grantTypes.includes("authorization_code")) {
    return { ok: false, error: "invalid_client_metadata",
      description: "grant_types must include authorization_code and may include refresh_token only." };
  }
  const responseTypes = input.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== "code") {
    return { ok: false, error: "invalid_client_metadata", description: "response_types must be [\"code\"]." };
  }
  const applicationType = input.application_type ?? "web";
  if (applicationType !== "web" && applicationType !== "native") {
    return { ok: false, error: "invalid_client_metadata", description: "application_type must be web or native." };
  }
  return {
    ok: true,
    client: {
      client_name: cleanClientName(input.client_name),
      redirect_uris: [...new Set(redirectUris as string[])],
      token_endpoint_auth_method: method,
      application_type: applicationType,
    },
  };
}

/** A redirect URI on this server's own origin could leak a code through a LetAgents page. */
function sameOriginAsIssuer(uri: string, urls: McpOAuthUrls): boolean {
  try {
    return new URL(uri).origin === new URL(urls.issuer).origin;
  } catch {
    return true;
  }
}

/** Requested scopes reduced to what this server grants; unknown scopes are ignored (RFC 6749 section 3.3). */
function grantedScope(): string {
  return MCP_OAUTH_SCOPE;
}

// ----------------------------------------------------- client authentication

type ClientAuthResult =
  | { ok: true; client: McpOAuthClient }
  | { ok: false; status: number; error: string; description: string; basic: boolean };

function parseBasic(header: string | undefined): { id: string; secret: string } | null | "invalid" {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match) return header.toLowerCase().startsWith("basic") ? "invalid" : null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return "invalid";
  try {
    // RFC 6749 section 2.3.1: both parts are form-urlencoded.
    const decode = (part: string) => decodeURIComponent(part.replace(/\+/g, " "));
    return { id: decode(decoded.slice(0, colon)), secret: decode(decoded.slice(colon + 1)) };
  } catch {
    return "invalid";
  }
}

async function authenticateClient(req: Request): Promise<ClientAuthResult> {
  const basic = parseBasic(req.headers.authorization);
  const fail = (description: string): ClientAuthResult =>
    ({ ok: false, status: 401, error: "invalid_client", description, basic: basic !== null });
  if (basic === "invalid") return fail("The client credentials are malformed.");
  const bodyId = stringParam(req.body, "client_id");
  const bodySecret = stringParam(req.body, "client_secret");
  if (basic && bodySecret !== undefined) return fail("Use one client authentication method.");
  if (basic && bodyId !== undefined && bodyId !== basic.id) return fail("The client_id values differ.");
  const clientId = basic?.id ?? bodyId;
  if (!clientId || clientId.length > 200) {
    return { ok: false, status: 400, error: "invalid_request", description: "client_id is required.", basic: false };
  }
  const client = await getMcpOAuthClient(clientId);
  if (!client) return fail("Unknown client.");
  const presented = basic?.secret ?? bodySecret;
  if (client.token_endpoint_auth_method === "none") {
    if (presented !== undefined && presented !== "") return fail("This client has no secret.");
    return { ok: true, client };
  }
  const expectBasic = client.token_endpoint_auth_method === "client_secret_basic";
  if (presented === undefined || Boolean(basic) !== expectBasic) {
    return fail(`Authenticate with ${client.token_endpoint_auth_method}.`);
  }
  if (!client.client_secret_hash || !safeEqual(sha256Hex(presented), client.client_secret_hash)) {
    return fail("The client credentials are invalid.");
  }
  return { ok: true, client };
}

function replyClientAuthFailure(res: Response, failure: Extract<ClientAuthResult, { ok: false }>): void {
  oauthError(res, failure.status, failure.error, failure.description,
    failure.basic ? { "WWW-Authenticate": 'Basic realm="letagents"' } : {});
}

// --------------------------------------------------------------- HTML pages

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function sendPage(res: Response, status: number, title: string, body: string): void {
  noStore(res);
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#e7e5e4;--warn:#92400e;--accent:#1c1917;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--warn:#fbbf24;--accent:#f5f5f4;--accent-fg:#0c0a09}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:30rem;margin:3rem auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:1.25rem;margin:0 0 12px}p,li{color:var(--muted)}strong,code{color:var(--fg)}
code{word-break:break-all}.warn{color:var(--warn)}ul{padding-left:1.2rem}
.actions{display:flex;gap:12px;margin-top:20px}button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
</style></head><body><main><div class="card">${body}</div></main></body></html>`);
}

function errorPage(res: Response, status: number, message: string): void {
  sendPage(res, status, "Cannot connect", `<h1>This app cannot connect to LetAgents</h1><p>${escapeHtml(message)}</p>`);
}

function consentPage(res: Response, input: {
  client: McpOAuthClient;
  redirectUri: string;
  login: string;
  consentToken: string;
  formAction: string;
}): void {
  const redirect = new URL(input.redirectUri);
  const name = input.client.client_name ?? "An unnamed app";
  sendPage(res, 200, "Connect to LetAgents", `
<h1>Connect <code>${escapeHtml(redirect.host)}</code> to your LetAgents account?</h1>
<p>Signed in as <strong>@${escapeHtml(input.login)}</strong>.</p>
<p>The app calls itself <strong>&ldquo;${escapeHtml(name)}&rdquo;</strong>. LetAgents did not check this name;
any app can choose it. The address below is what identifies the app.</p>
<p>After you approve, LetAgents sends you back to <strong><code>${escapeHtml(redirect.host)}</code></strong>
(<code>${escapeHtml(input.redirectUri)}</code>).</p>
<p class="warn">Approve only if you started this connection from that app just now.</p>
<p>The app gets the same access as a LetAgents owner token, on the remote MCP endpoint only:</p>
<ul><li>Join your rooms, read and send messages, and act on tasks as you.</li>
<li>Access stays until you disconnect it in LetAgents settings, or after 30 days without use.</li></ul>
<form method="post" action="${escapeHtml(input.formAction)}">
<input type="hidden" name="consent" value="${escapeHtml(input.consentToken)}">
<div class="actions"><button class="primary" type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Cancel</button></div>
</form>`);
}

function redirectToClient(res: Response, redirectUri: string, params: Record<string, string | null | undefined>): void {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(name, value);
  }
  noStore(res);
  res.redirect(303, url.toString());
}

// -------------------------------------------------------------------- routes

export function registerMcpOAuthRoutes(app: Express, deps: McpOAuthRouteDeps = {}): void {
  const allowRegister: ListingsRateLimiter = deps.allowRegister ?? buildInMemoryListingsRateLimiter({
    capacity: positiveIntEnv("LETAGENTS_MCP_OAUTH_REGISTRATIONS_PER_IP_HOUR", 30), windowMs: 60 * 60_000 });
  const allowRegisterGlobal = buildInMemoryListingsRateLimiter({
    capacity: positiveIntEnv("LETAGENTS_MCP_OAUTH_REGISTRATIONS_PER_HOUR", 1000), windowMs: 60 * 60_000 });
  const allowToken: ListingsRateLimiter = deps.allowToken ?? buildInMemoryListingsRateLimiter({ capacity: 120, windowMs: 60_000 });
  const allowAuthorize: ListingsRateLimiter = deps.allowAuthorize ?? buildInMemoryListingsRateLimiter({ capacity: 60, windowMs: 60_000 });
  const form = express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 20 });

  const sendResourceMetadata = (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(protectedResourceMetadata(mcpOAuthUrls()));
  };
  // RFC 9728: path-inserted for /mcp first, then the root (the spec has clients try both).
  app.get(`${MCP_OAUTH_PATHS.protectedResource}${REMOTE_MCP_PATH}`, sendResourceMetadata);
  app.get(MCP_OAUTH_PATHS.protectedResource, sendResourceMetadata);
  app.get(MCP_OAUTH_PATHS.authorizationServer, (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(authorizationServerMetadata(mcpOAuthUrls()));
  });

  app.post(MCP_OAUTH_PATHS.register, async (req: Request, res: Response) => {
    sweepSoon();
    if (!allowRegister(rateLimitKey(req)) || !allowRegisterGlobal("all")) {
      oauthError(res, 429, "slow_down", "Too many client registrations. Try again later.");
      return;
    }
    const result = validateRegistration(req.body);
    if (!result.ok) {
      oauthError(res, 400, result.error, result.description);
      return;
    }
    const urls = mcpOAuthUrls();
    if (result.client.redirect_uris.some((uri) => sameOriginAsIssuer(uri, urls))) {
      oauthError(res, 400, "invalid_redirect_uri", "A redirect URI may not be on this server.");
      return;
    }
    const clientSecret = result.client.token_endpoint_auth_method === "none" ? null : randomSecret();
    const client = await insertMcpOAuthClient({
      client_id: `mcpclient_${randomUUID()}`,
      ...result.client,
      client_secret_hash: clientSecret ? sha256Hex(clientSecret) : null,
    });
    noStore(res);
    res.status(201).json({
      client_id: client.client_id,
      client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_name: client.client_name ?? undefined,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: client.application_type,
      scope: MCP_OAUTH_SCOPE,
    });
  });

  app.get(MCP_OAUTH_PATHS.authorize, async (req: Request, res: Response) => {
    if (!allowAuthorize(rateLimitKey(req))) {
      errorPage(res, 429, "Too many sign-in attempts. Wait a minute and try again.");
      return;
    }
    const urls = mcpOAuthUrls();
    const query = req.query as Record<string, unknown>;
    const clientId = stringParam(query, "client_id");
    const redirectUri = stringParam(query, "redirect_uri");
    // Until the client and redirect URI are known to match, nothing redirects (no open redirect).
    const client = clientId && clientId.length <= 200 ? await getMcpOAuthClient(clientId) : null;
    if (!client) {
      errorPage(res, 400, "The app is not registered with LetAgents. Remove the connector and add it again.");
      return;
    }
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      errorPage(res, 400, "The app asked to return to an address it did not register.");
      return;
    }
    if (sameOriginAsIssuer(redirectUri, urls)) {
      errorPage(res, 400, "The app asked to return to a LetAgents page.");
      return;
    }
    const state = stringParam(query, "state");
    // Anyone may register a client with any https redirect URI, so a request
    // error shows a page here instead of redirecting: an unapproved
    // authorization link must not work as an open redirect (RFC 9700 4.11.2).
    const fail = (error: string, description: string) => errorPage(res, 400, `${description} (${error})`);
    if (state !== undefined && state.length > MAX_STATE_LENGTH) {
      fail("invalid_request", "state is too long.");
      return;
    }
    if (stringParam(query, "response_type") !== "code") {
      fail("unsupported_response_type", "response_type must be code.");
      return;
    }
    const codeChallenge = stringParam(query, "code_challenge");
    if (!codeChallenge || stringParam(query, "code_challenge_method") !== "S256" || !isValidCodeChallenge(codeChallenge)) {
      fail("invalid_request", "PKCE with code_challenge_method S256 is required.");
      return;
    }
    const resource = stringParam(query, "resource");
    if (resource !== undefined && !matchesMcpResource(resource, urls)) {
      fail("invalid_target", `resource must be ${urls.resource}.`);
      return;
    }
    if (Array.isArray(query.resource) || Array.isArray(query.client_id) || Array.isArray(query.redirect_uri)
      || Array.isArray(query.state) || Array.isArray(query.code_challenge)) {
      fail("invalid_request", "Each parameter may appear once.");
      return;
    }

    // Only the browser cookie counts as signed in here, never a bearer.
    const sessionToken = parseCookies(req.headers.cookie).letagents_session;
    const account = sessionToken ? await getSessionAccountByToken(sessionToken) : null;
    if (!account) {
      try {
        const loginState = randomSecret();
        await createAuthState(loginState, sanitizeRedirectPath(req.originalUrl, MCP_OAUTH_PATHS.authorize));
        noStore(res);
        res.redirect(302, buildGitHubAuthorizeUrl(loginState));
      } catch (error) {
        console.warn("MCP OAuth sign-in unavailable:", error instanceof Error ? error.message : "unknown error");
        errorPage(res, 503, "GitHub sign-in is not available on this server.");
      }
      return;
    }

    const consentToken = randomSecret();
    await createMcpOAuthAuthorization({
      consentHash: sha256Hex(consentToken),
      accountId: account.account_id,
      clientId: client.client_id,
      redirectUri,
      codeChallenge,
      resource: urls.resource,
      scope: grantedScope(),
      state: state ?? null,
      expiresAt: new Date(Date.now() + MCP_OAUTH_CONSENT_TTL_MS).toISOString(),
    });
    consentPage(res, {
      client,
      redirectUri,
      login: account.login,
      consentToken,
      formAction: `${new URL(urls.issuer).pathname.replace(/\/+$/, "")}${MCP_OAUTH_PATHS.decision}`,
    });
  });

  app.post(MCP_OAUTH_PATHS.decision, form, async (req: Request, res: Response) => {
    const urls = mcpOAuthUrls();
    // CSRF: the consent token is secret and bound to the account, the session
    // cookie is SameSite=Lax, and a browser's Origin must be this server.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== new URL(urls.issuer).origin) {
      errorPage(res, 403, "This approval did not come from the LetAgents page.");
      return;
    }
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite !== undefined && fetchSite !== "same-origin") {
      errorPage(res, 403, "This approval did not come from the LetAgents page.");
      return;
    }
    const sessionToken = parseCookies(req.headers.cookie).letagents_session;
    const account = sessionToken ? await getSessionAccountByToken(sessionToken) : null;
    const consent = stringParam(req.body, "consent");
    const decision = stringParam(req.body, "decision");
    if (!account || !consent || (decision !== "approve" && decision !== "deny")) {
      errorPage(res, 400, "This approval is not valid. Start the connection again from your app.");
      return;
    }
    const code = decision === "approve" ? randomSecret() : null;
    const authorization = await decideMcpOAuthAuthorization({
      consentHash: sha256Hex(consent),
      accountId: account.account_id,
      codeHash: code ? sha256Hex(code) : null,
      codeExpiresAt: new Date(Date.now() + MCP_OAUTH_CODE_TTL_MS).toISOString(),
    });
    if (!authorization) {
      errorPage(res, 400, "This approval expired or was already used. Start the connection again from your app.");
      return;
    }
    if (!code) {
      redirectToClient(res, authorization.redirect_uri, {
        error: "access_denied", error_description: "The person declined the connection.",
        state: authorization.state, iss: urls.issuer,
      });
      return;
    }
    redirectToClient(res, authorization.redirect_uri, { code, state: authorization.state, iss: urls.issuer });
  });

  app.post(MCP_OAUTH_PATHS.token, form, async (req: Request, res: Response) => {
    sweepSoon();
    if (!allowToken(rateLimitKey(req))) {
      oauthError(res, 429, "slow_down", "Too many token requests. Slow down.");
      return;
    }
    const urls = mcpOAuthUrls();
    const auth = await authenticateClient(req);
    if (!auth.ok) {
      replyClientAuthFailure(res, auth);
      return;
    }
    const grantType = stringParam(req.body, "grant_type");
    const resource = stringParam(req.body, "resource");
    if (resource !== undefined && !matchesMcpResource(resource, urls)) {
      oauthError(res, 400, "invalid_target", `resource must be ${urls.resource}.`);
      return;
    }
    const now = Date.now();
    const accessExpiresAt = new Date(now + MCP_OAUTH_ACCESS_TTL_MS).toISOString();
    const refreshExpiresAt = new Date(now + MCP_OAUTH_REFRESH_TTL_MS).toISOString();

    if (grantType === "authorization_code") {
      const code = stringParam(req.body, "code");
      if (!code) {
        oauthError(res, 400, "invalid_request", "code is required.");
        return;
      }
      const redirectUri = stringParam(req.body, "redirect_uri");
      const verifier = stringParam(req.body, "code_verifier");
      const grantSecret = randomSecret();
      const accessToken = mintToken("access", grantSecret);
      const refreshToken = mintToken("refresh", grantSecret);
      const outcome = await exchangeMcpOAuthCode({
        codeHash: sha256Hex(code),
        clientId: auth.client.client_id,
        check(authorization) {
          if (!verifier || !verifyPkceS256(verifier, authorization.code_challenge)) return "The code_verifier does not match.";
          if (redirectUri !== authorization.redirect_uri) return "redirect_uri does not match the authorization request.";
          if (authorization.resource !== urls.resource) return "The code was issued for another resource.";
          return null;
        },
        grantSecretHash: sha256Hex(grantSecret),
        accessTokenHash: sha256Hex(accessToken),
        refreshTokenHash: sha256Hex(refreshToken),
        accessExpiresAt,
        refreshExpiresAt,
      });
      if (outcome.kind !== "issued") {
        oauthError(res, 400, "invalid_grant", outcome.reason);
        return;
      }
      noStore(res);
      res.json({ access_token: accessToken, token_type: "Bearer", expires_in: MCP_OAUTH_ACCESS_TTL_MS / 1000,
        refresh_token: refreshToken, scope: MCP_OAUTH_SCOPE });
      return;
    }

    if (grantType === "refresh_token") {
      const presented = stringParam(req.body, "refresh_token");
      const grantSecret = presented ? grantSecretOf("refresh", presented) : null;
      if (!presented || !grantSecret) {
        oauthError(res, 400, "invalid_grant", "The refresh token is invalid.");
        return;
      }
      const accessToken = mintToken("access", grantSecret);
      const refreshToken = mintToken("refresh", grantSecret);
      const outcome = await refreshMcpOAuthGrant({
        refreshTokenHash: sha256Hex(presented),
        grantSecretHash: sha256Hex(grantSecret),
        clientId: auth.client.client_id,
        check: (grant) => (grant.resource === urls.resource ? null : "The grant was issued for another resource."),
        accessTokenHash: sha256Hex(accessToken),
        newRefreshTokenHash: sha256Hex(refreshToken),
        accessExpiresAt,
        refreshExpiresAt,
      });
      if (outcome.kind !== "issued") {
        oauthError(res, 400, "invalid_grant", outcome.reason);
        return;
      }
      noStore(res);
      res.json({ access_token: accessToken, token_type: "Bearer", expires_in: MCP_OAUTH_ACCESS_TTL_MS / 1000,
        refresh_token: refreshToken, scope: outcome.scope });
      return;
    }

    oauthError(res, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
  });

  app.post(MCP_OAUTH_PATHS.revoke, form, async (req: Request, res: Response) => {
    if (!allowToken(rateLimitKey(req))) {
      oauthError(res, 429, "slow_down", "Too many requests. Slow down.");
      return;
    }
    const auth = await authenticateClient(req);
    if (!auth.ok) {
      replyClientAuthFailure(res, auth);
      return;
    }
    const token = stringParam(req.body, "token");
    if (!token) {
      oauthError(res, 400, "invalid_request", "token is required.");
      return;
    }
    // RFC 7009: unknown tokens and other clients' tokens get the same 200.
    // Revoking either token of a grant ends the whole grant.
    const grant = await getMcpOAuthTokenGrant(sha256Hex(token));
    if (grant && grant.client_id === auth.client.client_id) await revokeMcpOAuthGrant(grant.grant_id);
    noStore(res);
    res.status(200).json({});
  });

  // An unexpected failure (database, body parser) on the token endpoints
  // answers in OAuth JSON without details, not with Express's HTML page.
  app.use(["/oauth/token", "/oauth/revoke", "/oauth/register"],
    (error: unknown, _req: Request, res: Response, next: (error?: unknown) => void) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      const status = (error as { status?: unknown })?.status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        oauthError(res, 400, "invalid_request", "The request body could not be read.");
        return;
      }
      console.warn("MCP OAuth endpoint failed:", error instanceof Error ? error.name : "unknown error");
      oauthError(res, 500, "server_error", "The authorization server failed. Try again.");
    });

  // Account settings: list and disconnect apps. Browser or desktop session only.
  app.get("/account/mcp-connections", async (req: AuthenticatedRequest, res: Response) => {
    if (req.authKind !== "session" || !req.sessionAccount) {
      res.status(401).json({ error: "Sign in to LetAgents to see connected apps." });
      return;
    }
    const grants = await listMcpOAuthGrantsForAccount(req.sessionAccount.account_id);
    noStore(res);
    res.json({
      connections: grants.map((grant) => ({
        id: grant.grant_id,
        client_name: grant.client_name,
        redirect_hosts: [...new Set(grant.redirect_uris.map((uri) => new URL(uri).host))],
        scope: grant.scope,
        created_at: grant.created_at,
        last_used_at: grant.last_used_at,
        expires_at: grant.expires_at,
      })),
    });
  });

  app.delete("/account/mcp-connections/:grantId", async (req: AuthenticatedRequest, res: Response) => {
    if (req.authKind !== "session" || !req.sessionAccount) {
      res.status(401).json({ error: "Sign in to LetAgents to disconnect apps." });
      return;
    }
    const grantId = String(req.params.grantId);
    if (!/^mcpgrant_[0-9a-f-]{36}$/.test(grantId)) {
      res.status(404).json({ error: "Connected app not found." });
      return;
    }
    const revoked = await revokeMcpOAuthGrant(grantId, req.sessionAccount.account_id);
    if (!revoked) {
      res.status(404).json({ error: "Connected app not found." });
      return;
    }
    res.json({ revoked: true });
  });
}

export function resetMcpOAuthSweepForTests(): void {
  lastSweepAt = 0;
}
