import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Full API app on a scratch database: LetAgents as the OAuth authorization
// server for its own remote MCP endpoint. No network beyond 127.0.0.1.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_POLL_MAX_MS = "1500";
process.env.GITHUB_CLIENT_ID = "mcp-oauth-test-github-client";
process.env.LETAGENTS_MCP_OAUTH_REGISTRATIONS_PER_IP_HOUR = "1000";

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the DB-backed MCP OAuth tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;

let server: Server | null = null;
let baseUrl = "";
const OWNER_TOKEN = "mcp_oauth_device_flow_owner_token";
const COOKIE_A = "letagents_session=mcp-oauth-cookie-a";
const COOKIE_B = "letagents_session=mcp-oauth-cookie-b";
const REDIRECT = "http://localhost:53682/callback";

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    for (const [suffix, cookie] of [["a", COOKIE_A], ["b", COOKIE_B]] as const) {
      const account = await accountSessions!.upsertAccount({
        provider: "github", provider_user_id: `mcp-oauth-${suffix}`, login: `mcp-oauth-${suffix}`, display_name: `OAuth ${suffix}`,
      });
      await accountSessions!.createSession(account.id, cookie.split("=")[1]!, expires, null);
      if (suffix === "a") {
        await ownerTokens!.createOwnerToken({ accountId: account.id, githubUserId: "mcp-oauth-a", token: OWNER_TOKEN });
      }
    }
    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The issuer and the /mcp resource are this test server.
    process.env.LETAGENTS_BASE_URL = baseUrl;
  });
  test.after(async () => {
    routesModule!.closeApiRouteEventBroker();
    server?.closeAllConnections();
    await new Promise<void>((done) => server ? server.close(() => done()) : done());
    await dbClient!.pool.end();
  });
}

// ------------------------------------------------------------------ helpers

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test MCP client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], application_type: "native", ...body }),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function authorizeUrl(params: Record<string, string | undefined>): string {
  const url = new URL(`${baseUrl}/oauth/authorize`);
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
  return url.toString();
}

/** The browser part: open the authorization URL signed in, and press a button on the consent page. */
async function consent(url: string, decision: "approve" | "deny" = "approve", cookie = COOKIE_A) {
  const page = await fetch(url, { headers: { cookie }, redirect: "manual" });
  assert.equal(page.status, 200, await page.clone().text());
  const html = await page.text();
  const token = /name="consent" value="([0-9a-f]{64})"/.exec(html)?.[1];
  assert.ok(token, "the consent page carries a consent token");
  const answer = await fetch(`${baseUrl}/oauth/authorize/decision`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams({ consent: token, decision }).toString(),
  });
  assert.equal(answer.status, 303);
  return { html, location: new URL(answer.headers.get("location")!) };
}

async function tokenRequest(params: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
}

/** Register, consent and exchange: a fresh grant's tokens. */
async function issueTokens() {
  const client = await register();
  const { verifier, challenge } = pkce();
  const { location } = await consent(authorizeUrl({
    response_type: "code", client_id: client.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: "S256", state: "s1", resource: `${baseUrl}/mcp`,
  }));
  const code = location.searchParams.get("code")!;
  const tokens = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT,
    code_verifier: verifier, client_id: client.body.client_id, resource: `${baseUrl}/mcp` });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  return { clientId: client.body.client_id as string, code, verifier, ...tokens.body } as {
    clientId: string; code: string; verifier: string; access_token: string; refresh_token: string;
  };
}

function initialize(token: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }),
  });
}

function toolsList(token: string, sessionId: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId, "Mcp-Protocol-Version": "2025-06-18",
      "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
}

class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | null = null;
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() {
    return { client_name: "SDK client", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" } as never;
  }
  state() { return "sdk-state"; }
  clientInformation() { return this.info; }
  saveClientInformation(info: OAuthClientInformationMixed) { this.info = info; }
  tokens() { return this.saved; }
  saveTokens(tokens: OAuthTokens) { this.saved = tokens; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { return this.verifier; }
}

// -------------------------------------------------------------------- tests

test("metadata documents validate with the MCP SDK and point at this server", { skip }, async () => {
  const prm = await discoverOAuthProtectedResourceMetadata(`${baseUrl}/mcp`);
  assert.equal(prm.resource, `${baseUrl}/mcp`);
  assert.deepEqual(prm.authorization_servers, [baseUrl]);
  assert.deepEqual(prm.scopes_supported, ["mcp"]);
  const root = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)).json();
  assert.deepEqual(root, prm, "the root document matches the path-inserted one");
  const as = await discoverAuthorizationServerMetadata(baseUrl);
  assert.ok(as);
  assert.equal(as.issuer, baseUrl);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.response_types_supported, ["code"]);
  assert.equal(as.registration_endpoint, `${baseUrl}/oauth/register`);
  assert.equal((as as Record<string, unknown>).authorization_response_iss_parameter_supported, true);
});

test("/mcp without a token answers 401 with the resource metadata challenge", { skip }, async () => {
  const response = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 401);
  const challenge = response.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  assert.ok(challenge.includes(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`), challenge);
  assert.ok(challenge.includes('scope="mcp"'), challenge);
});

test("an MCP SDK client signs in, calls tools, keeps its session across refresh, and loses it on revoke", { skip, timeout: 60_000 }, async () => {
  const provider = new MemoryProvider();
  assert.equal(await auth(provider, { serverUrl: `${baseUrl}/mcp` }), "REDIRECT");
  const authorization = provider.authorizationUrl!;
  assert.equal(authorization.searchParams.get("resource"), `${baseUrl}/mcp`);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");

  const { html, location } = await consent(authorization.toString());
  assert.ok(html.includes("SDK client") && html.includes("@mcp-oauth-a") && html.includes("localhost:53682"),
    "the consent page names the client, the account and the redirect host");
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("state"), "sdk-state");
  assert.equal(location.searchParams.get("iss"), baseUrl);
  assert.equal(await auth(provider, { serverUrl: `${baseUrl}/mcp`, authorizationCode: location.searchParams.get("code")! }), "AUTHORIZED");
  const first = provider.saved!;
  assert.match(first.access_token, /^lmcp_at\./);
  assert.equal(first.expires_in, 3600);

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: provider });
  const client = new Client({ name: "Claude", version: "1" });
  await client.connect(transport);
  try {
    const joined = await client.callTool({ name: "join_room", arguments: { name: "mcp-oauth-room" } });
    assert.equal(joined.isError, undefined, JSON.stringify(joined));
    const sessionId = transport.sessionId!;

    // Refresh rotates both tokens; the session belongs to the grant, so it continues.
    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: first.refresh_token!,
      client_id: (provider.info as { client_id: string }).client_id, resource: `${baseUrl}/mcp` });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.notEqual(refreshed.body.access_token, first.access_token);
    assert.notEqual(refreshed.body.refresh_token, first.refresh_token);
    assert.equal(refreshed.headers.get("cache-control"), "no-store");
    const sameSession = await toolsList(refreshed.body.access_token, sessionId);
    assert.equal(sameSession.status, 200, "the new access token reaches the same session");

    // Revocation (RFC 7009) ends the grant: its access tokens and sessions stop working.
    const revoke = await fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshed.body.refresh_token, client_id: (provider.info as { client_id: string }).client_id }).toString(),
    });
    assert.equal(revoke.status, 200);
    const after = await toolsList(refreshed.body.access_token, sessionId);
    assert.equal(after.status, 401);
    assert.match(after.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
    const sessions = await dbClient!.pool.query("SELECT 1 FROM remote_mcp_sessions WHERE session_id = $1", [sessionId]);
    assert.equal(sessions.rowCount, 0, "the grant's sessions are deleted at once");
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("a reused refresh token revokes the grant", { skip }, async () => {
  const issued = await issueTokens();
  const rotated = await tokenRequest({ grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: issued.clientId });
  assert.equal(rotated.status, 200);
  const replay = await tokenRequest({ grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: issued.clientId });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "invalid_grant");
  assert.equal((await initialize(rotated.body.access_token)).status, 401, "the thief's replay also ends the legitimate tokens");
  const next = await tokenRequest({ grant_type: "refresh_token", refresh_token: rotated.body.refresh_token, client_id: issued.clientId });
  assert.equal(next.body.error, "invalid_grant");
});

test("a reused authorization code is refused and revokes the tokens it issued", { skip }, async () => {
  const issued = await issueTokens();
  assert.equal((await initialize(issued.access_token)).status, 200);
  const again = await tokenRequest({ grant_type: "authorization_code", code: issued.code, redirect_uri: REDIRECT,
    code_verifier: issued.verifier, client_id: issued.clientId });
  assert.equal(again.status, 400);
  assert.equal(again.body.error, "invalid_grant");
  assert.equal((await initialize(issued.access_token)).status, 401);
});

test("the authorization endpoint never redirects to an unregistered URI and requires PKCE S256", { skip }, async () => {
  const client = await register();
  const { challenge } = pkce();
  const base = { response_type: "code", client_id: client.body.client_id, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz" };

  const wrongRedirect = await fetch(authorizeUrl({ ...base, redirect_uri: "https://evil.example/cb" }), { headers: { cookie: COOKIE_A }, redirect: "manual" });
  assert.equal(wrongRedirect.status, 400);
  assert.equal(wrongRedirect.headers.get("location"), null);
  const prefixRedirect = await fetch(authorizeUrl({ ...base, redirect_uri: `${REDIRECT}/../x` }), { headers: { cookie: COOKIE_A }, redirect: "manual" });
  assert.equal(prefixRedirect.status, 400, "exact match only");
  const unknownClient = await fetch(authorizeUrl({ ...base, client_id: "mcpclient_unknown" }), { redirect: "manual" });
  assert.equal(unknownClient.status, 400);
  assert.equal(unknownClient.headers.get("location"), null);

  for (const [params, error] of [
    [{ ...base, code_challenge: undefined }, "invalid_request"],
    [{ ...base, code_challenge_method: "plain" }, "invalid_request"],
    [{ ...base, code_challenge_method: undefined }, "invalid_request"],
    [{ ...base, response_type: "token" }, "unsupported_response_type"],
    [{ ...base, resource: "https://other.example/mcp" }, "invalid_target"],
    [{ ...base, resource: `${baseUrl}/mcp-other` }, "invalid_target"],
  ] as const) {
    const response = await fetch(authorizeUrl(params as Record<string, string | undefined>), { headers: { cookie: COOKIE_A }, redirect: "manual" });
    assert.equal(response.status, 303, JSON.stringify(params));
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.origin + location.pathname, REDIRECT);
    assert.equal(location.searchParams.get("error"), error);
    assert.equal(location.searchParams.get("state"), "xyz");
    assert.equal(location.searchParams.get("iss"), baseUrl);
  }
});

test("a signed-out person goes through GitHub sign-in and comes back to the consent page", { skip }, async () => {
  const client = await register();
  const url = authorizeUrl({ response_type: "code", client_id: client.body.client_id, redirect_uri: REDIRECT,
    code_challenge: pkce().challenge, code_challenge_method: "S256", state: "abc" });
  const response = await fetch(url, { redirect: "manual" });
  assert.equal(response.status, 302);
  const github = new URL(response.headers.get("location")!);
  assert.equal(github.origin, "https://github.com");
  const state = github.searchParams.get("state")!;
  const stored = await dbClient!.pool.query<{ redirect_to: string }>("SELECT redirect_to FROM auth_states WHERE state = $1", [state]);
  assert.equal(stored.rows[0]?.redirect_to, url.slice(baseUrl.length), "after sign-in the browser returns to the same request");
  // A signed-in person sees the consent page directly, with a deny path.
  const { location } = await consent(url, "deny");
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "abc");
});

test("the consent decision refuses cross-site posts, other accounts and replays", { skip }, async () => {
  const client = await register();
  const url = authorizeUrl({ response_type: "code", client_id: client.body.client_id, redirect_uri: REDIRECT,
    code_challenge: pkce().challenge, code_challenge_method: "S256" });
  const html = await (await fetch(url, { headers: { cookie: COOKIE_A } })).text();
  const token = /name="consent" value="([0-9a-f]{64})"/.exec(html)![1]!;
  const post = (headers: Record<string, string>) => fetch(`${baseUrl}/oauth/authorize/decision`, {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ consent: token, decision: "approve" }).toString(),
  });
  assert.equal((await post({ cookie: COOKIE_A, Origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ cookie: COOKIE_A, "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post({ Origin: baseUrl })).status, 400, "no session cookie");
  assert.equal((await post({ cookie: COOKIE_B, Origin: baseUrl })).status, 400, "another account cannot approve it");
  assert.equal((await post({ cookie: COOKIE_A, Origin: baseUrl })).status, 303);
  assert.equal((await post({ cookie: COOKIE_A, Origin: baseUrl })).status, 400, "a consent is decided once");
});

test("the token endpoint checks the verifier, redirect URI, resource and client", { skip }, async () => {
  const client = await register();
  const other = await register();
  const start = async () => {
    const { verifier, challenge } = pkce();
    const { location } = await consent(authorizeUrl({ response_type: "code", client_id: client.body.client_id,
      redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" }));
    return { verifier, code: location.searchParams.get("code")! };
  };
  const exchange = (code: string, extra: Record<string, string>) => tokenRequest({ grant_type: "authorization_code", code,
    redirect_uri: REDIRECT, client_id: client.body.client_id, ...extra });

  let flow = await start();
  assert.equal((await exchange(flow.code, { code_verifier: pkce().verifier })).body.error, "invalid_grant", "wrong verifier");
  assert.equal((await exchange(flow.code, { code_verifier: flow.verifier })).body.error, "invalid_grant", "a failed try spends the code");
  flow = await start();
  assert.equal((await exchange(flow.code, {})).body.error, "invalid_grant", "PKCE cannot be skipped");
  flow = await start();
  assert.equal((await exchange(flow.code, { code_verifier: flow.verifier, redirect_uri: "http://localhost:1/cb" })).body.error, "invalid_grant");
  flow = await start();
  assert.equal((await exchange(flow.code, { code_verifier: flow.verifier, client_id: other.body.client_id })).body.error, "invalid_grant");
  assert.equal((await exchange(flow.code, { code_verifier: flow.verifier, resource: "https://other.example/mcp" })).body.error, "invalid_target");
  assert.equal((await exchange(flow.code, { code_verifier: flow.verifier })).status, 200, "the code still works for its own client");
  assert.equal((await tokenRequest({ grant_type: "password", client_id: client.body.client_id })).body.error, "unsupported_grant_type");
  assert.equal((await tokenRequest({ grant_type: "authorization_code", code: "x", client_id: "mcpclient_nobody" })).status, 401);
});

test("access tokens expire, work only on /mcp, and the device-flow owner token still works", { skip }, async () => {
  const issued = await issueTokens();
  assert.equal((await initialize(OWNER_TOKEN)).status, 200, "owner token on /mcp");
  const rest = await fetch(`${baseUrl}/auth/session`, { headers: { Authorization: `Bearer ${issued.access_token}` } });
  assert.equal((await rest.json()).authenticated, false, "an MCP access token is not a REST credential");
  const rooms = await fetch(`${baseUrl}/account/rooms`, { headers: { Authorization: `Bearer ${issued.access_token}` } });
  assert.equal(rooms.status, 401);
  const tampered = issued.access_token.replace(/\.([0-9a-f]{64})\./, `.${"0".repeat(64)}.`);
  assert.equal((await initialize(tampered)).status, 401, "the grant secret is part of the token");
  assert.equal((await initialize(issued.access_token)).status, 200);
  await dbClient!.pool.query("UPDATE mcp_oauth_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'access'");
  const expired = await initialize(issued.access_token);
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

test("account settings list connected apps and disconnect them", { skip }, async () => {
  const issued = await issueTokens();
  const list = await fetch(`${baseUrl}/account/mcp-connections`, { headers: { cookie: COOKIE_A } });
  const { connections } = await list.json() as { connections: Array<{ id: string; client_name: string; redirect_hosts: string[] }> };
  const mine = connections.find((connection) => connection.client_name === "Test MCP client");
  assert.ok(mine);
  assert.deepEqual(mine.redirect_hosts, ["localhost:53682"]);
  assert.equal((await fetch(`${baseUrl}/account/mcp-connections`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } })).status, 401,
    "only a signed-in person (not an agent's owner token) manages connections");
  const otherAccount = await fetch(`${baseUrl}/account/mcp-connections/${mine.id}`, { method: "DELETE", headers: { cookie: COOKIE_B } });
  assert.equal(otherAccount.status, 404);
  const own = await fetch(`${baseUrl}/account/mcp-connections/${mine.id}`, { method: "DELETE", headers: { cookie: COOKIE_A } });
  assert.equal(own.status, 200);
  for (const connection of connections) {
    await fetch(`${baseUrl}/account/mcp-connections/${connection.id}`, { method: "DELETE", headers: { cookie: COOKIE_A } });
  }
  assert.equal((await initialize(issued.access_token)).status, 401);
  const refresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: issued.refresh_token, client_id: issued.clientId });
  assert.equal(refresh.body.error, "invalid_grant");
});

test("registration validates redirect URIs and authenticates confidential clients", { skip }, async () => {
  for (const uri of ["http://example.com/cb", "javascript:alert(1)", "https://example.com/cb#frag", "https://user:pw@example.com/cb", "custom://cb"]) {
    const result = await register({ redirect_uris: [uri] });
    assert.equal(result.status, 400, uri);
    assert.equal(result.body.error, "invalid_redirect_uri");
  }
  assert.equal((await register({ grant_types: ["client_credentials"] })).body.error, "invalid_client_metadata");
  assert.equal((await register({ token_endpoint_auth_method: "private_key_jwt" })).body.error, "invalid_client_metadata");

  const confidential = await register({ token_endpoint_auth_method: "client_secret_basic", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  assert.equal(confidential.status, 201);
  assert.match(confidential.body.client_secret, /^[0-9a-f]{64}$/);
  const { verifier, challenge } = pkce();
  const { location } = await consent(authorizeUrl({ response_type: "code", client_id: confidential.body.client_id,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256" }));
  const code = location.searchParams.get("code")!;
  const params = { grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier };
  const basic = (secret: string) => ({ Authorization: `Basic ${Buffer.from(`${confidential.body.client_id}:${secret}`).toString("base64")}` });
  const wrong = await tokenRequest(params, basic("0".repeat(64)));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, "invalid_client");
  const right = await tokenRequest(params, basic(confidential.body.client_secret));
  assert.equal(right.status, 200, JSON.stringify(right.body));
});

test("no stored column holds a raw code, token or secret", { skip }, async () => {
  const issued = await issueTokens();
  const dump = JSON.stringify((await dbClient!.pool.query(`
    SELECT (SELECT json_agg(t) FROM mcp_oauth_tokens t) AS tokens, (SELECT json_agg(g) FROM mcp_oauth_grants g) AS grants,
           (SELECT json_agg(a) FROM mcp_oauth_authorizations a) AS authorizations, (SELECT json_agg(c) FROM mcp_oauth_clients c) AS clients`)).rows);
  const grantSecret = issued.access_token.split(".")[1]!;
  for (const secret of [issued.access_token, issued.refresh_token, issued.code, grantSecret]) {
    assert.equal(dump.includes(secret), false);
  }
});
