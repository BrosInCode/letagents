import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubOrganizationAccessError,
  GitHubOrganizationScopeError,
  listGitHubOrganizationMemberships,
  readGitHubOrganizationAccess,
} from "../github/organization-memberships.js";
import { buildGitHubAuthorizeUrl } from "../github/oauth.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
delete process.env.LETAGENTS_BASE_URL;
delete process.env.PUBLIC_API_URL;
const { registerAccountOrganizationRoutes } = await import("../routes/account/organizations.js");
const { registerOrganizationConsentRoutes } = await import("../routes/auth/organization-consent.js");

const membership = { github_org_id: "42", login: "acme", avatar_url: null, role: "owner" as const };
const organization = { github_org_id: "42", login: "acme", avatar_url: null, created_at: "now", updated_at: "now" };
const account = { account_id: "acct_1", provider: "github", provider_access_token: "test-token" };
const access = (memberships: unknown[] = [membership], extra: Record<string, unknown> = {}) =>
  async () => ({ memberships, invitations: [], ssoRequiredOrgIds: [], ...extra });

function harness(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, (req: any, res: any) => Promise<void>>();
  const writes: any[] = [];
  const removals: string[] = [];
  registerAccountOrganizationRoutes({
    get: (path: string, handler: any) => handlers.set(`GET ${path}`, handler),
    post: (path: string, handler: any) => handlers.set(`POST ${path}`, handler),
  } as never, {
    readAccess: access(),
    getOrganizations: async () => [organization],
    getJoinedIds: async () => [],
    saveMembership: async (input) => { writes.push(input); return organization; },
    removeMembership: async (_account, id) => { removals.push(id); },
    ...overrides,
  });
  return {
    writes, removals,
    async request(path: string, req: Record<string, unknown> = {}) {
      const res = {
        statusCode: 200, body: undefined as any,
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
      };
      await handlers.get(path)!({ authKind: "session", method: path.split(" ")[0], protocol: "https", get: () => "app.test",
        headers: path.startsWith("POST") ? { origin: "https://app.test" } : {}, sessionAccount: account, params: { organizationId: "42" }, ...req }, res);
      return res;
    },
  };
}

test("GitHub discovery includes private memberships, maps owners, and follows trusted pages", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: any, init: any) => {
    calls.push(String(url));
    assert.equal(init.headers.Authorization, "Bearer test-token");
    assert.equal(init.redirect, "error");
    return calls.length === 1
      ? Response.json([
        { state: "active", role: "admin", organization: { id: 42, login: "acme" } },
        { state: "pending", role: "member", organization: { id: 43, login: "pending" } },
      ], { headers: { link: '<https://untrusted.example/steal>; rel="next"' } })
      : Response.json([{ state: "active", role: "member", organization: { id: 44, login: "other" } }]);
  };
  const memberships = await listGitHubOrganizationMemberships("test-token", fetchImpl as typeof fetch);
  assert.deepEqual(memberships.map((item) => [item.github_org_id, item.role]), [["42", "owner"], ["44", "member"]]);
  assert.equal(calls[1], "https://api.github.com/user/memberships/orgs?per_page=100&page=2");
});

test("failed or malformed GitHub responses never become empty membership lists", async () => {
  for (const response of [
    new Response(null, { status: 403 }),
    new Response(null, { status: 429 }),
    Response.json({ message: "unexpected" }),
    Response.json([null]),
    Response.json([{ state: "active", role: "admin", organization: { id: "42", login: "acme" } }]),
  ]) {
    await assert.rejects(listGitHubOrganizationMemberships("token", (async () => response) as typeof fetch), GitHubOrganizationAccessError);
  }
});

test("GitHub pagination cap fails closed instead of silently hiding remaining organizations", async () => {
  let calls = 0;
  await assert.rejects(listGitHubOrganizationMemberships("token", (async () => {
    calls += 1;
    return Response.json([], { headers: { link: '<https://api.github.com/next>; rel="next"' } });
  }) as typeof fetch), GitHubOrganizationAccessError);
  assert.equal(calls, 10);
});

test("organization routes require human GitHub authentication", async () => {
  const h = harness({ readAccess: async () => { throw new Error("must not call provider"); } });
  assert.equal((await h.request("GET /account/organizations", { sessionAccount: null, authKind: undefined })).statusCode, 401);
  assert.equal((await h.request("POST /organizations/:organizationId/setup", { authKind: "agent_session" })).statusCode, 403);
  assert.equal(h.writes.length, 0);
});

test("discovery distinguishes setup/joined companies and preserves an empty personal path", async () => {
  const h = harness({
    readAccess: access([membership, { ...membership, github_org_id: "43", login: "other" }]),
    getJoinedIds: async () => ["42", "99"],
  });
  assert.deepEqual((await h.request("GET /account/organizations")).body.organizations.map((org: any) => [org.github_org_id, org.setup, org.joined]), [["42", true, true], ["43", false, false]]);
  assert.deepEqual((await harness({ readAccess: access([]) }).request("GET /account/organizations")).body, { organizations: [], invitations: [], sso_required: [] });
  assert.equal(h.writes.length, 0);
});

test("only verified owners can set up a company; request body roles are ignored", async () => {
  const h = harness({ readAccess: access([{ ...membership, role: "member" }]) });
  const denied = await h.request("POST /organizations/:organizationId/setup", { body: { role: "owner" } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error, "organization_owner_required");
  assert.equal(h.writes.length, 0);
  const owner = harness();
  assert.equal((await owner.request("POST /organizations/:organizationId/setup")).statusCode, 200);
  assert.deepEqual(owner.writes[0], { accountId: "acct_1", membership, create: true });
});

test("members join an existing company but cannot implicitly create one", async () => {
  const h = harness({ readAccess: access([{ ...membership, role: "member" }]) });
  assert.equal((await h.request("POST /organizations/:organizationId/join")).body.joined, true);
  assert.equal(h.writes[0].create, false);
  assert.equal(h.writes[0].membership.role, "member");
  const missing = await harness({ saveMembership: async () => null }).request("POST /organizations/:organizationId/join");
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.body.error, "organization_setup_required");
});

test("revoked membership removes a stored join and cannot create or rejoin the company", async () => {
  const h = harness({ readAccess: access([]) });
  assert.equal((await h.request("POST /organizations/:organizationId/join")).statusCode, 403);
  assert.deepEqual(h.removals, ["42"]);
  assert.equal(h.writes.length, 0);
});

test("provider outages preserve stored joins, block access, and distinguish expired credentials", async () => {
  for (const status of [401, 403, 429, 500]) {
    const h = harness({ readAccess: async () => { throw new GitHubOrganizationAccessError(status); } });
    assert.equal((await h.request("POST /organizations/:organizationId/join")).statusCode, status === 401 ? 401 : 503);
    assert.deepEqual(h.removals, []);
    assert.deepEqual(h.writes, []);
  }
});

test("organization routes use immutable IDs rather than accepting a company name", async () => {
  const h = harness();
  assert.equal((await h.request("POST /organizations/:organizationId/setup", { params: { organizationId: "acme" } })).statusCode, 400);
  assert.deepEqual(h.writes, []);
});

test("company routes refuse owner tokens, remote MCP tokens, and agent sessions", async () => {
  const h = harness({ readAccess: async () => { throw new Error("must not call provider"); } });
  for (const authKind of ["agent_session", "owner_token", "mcp_token"]) {
    for (const route of ["GET /account/organizations", "POST /organizations/:organizationId/setup", "POST /organizations/:organizationId/join"]) {
      const res = await h.request(route, { authKind });
      assert.equal(res.statusCode, 403, `${authKind} ${route}`);
      assert.deepEqual(res.body, { error: "human_app_session_required" });
    }
  }
});

test("cross-site cookie writes to setup and join are refused", async () => {
  const h = harness();
  for (const action of ["setup", "join"]) {
    for (const headers of [{}, { origin: "https://evil.example" }]) {
      const res = await h.request(`POST /organizations/:organizationId/${action}`, { headers });
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.body, { error: "cross_site_write_refused" });
    }
  }
  assert.deepEqual(h.writes, []);
  // A native bearer session needs no Origin.
  const bearer = await h.request("POST /organizations/:organizationId/join", { headers: { authorization: "Bearer abc" } });
  assert.equal(bearer.statusCode, 200);
});

const orgPage = (state: string, role: string, id: number, login: string) => ({ state, role, organization: { id, login, avatar_url: `https://a/${id}` } });

test("one GitHub read returns memberships, invitations, and SSO-hidden organizations without a state filter", async () => {
  const urls: string[] = [];
  const fetchImpl = async (url: any) => {
    urls.push(String(url));
    return Response.json([orgPage("active", "admin", 42, "acme"), orgPage("pending", "member", 43, "invited")], {
      headers: { "x-oauth-scopes": "read:user, repo, read:org", "x-github-sso": "partial-results; organizations=42,77,abc,0,-5,88x,99" },
    });
  };
  const result = await readGitHubOrganizationAccess("token", fetchImpl as typeof fetch);
  assert.deepEqual(urls, ["https://api.github.com/user/memberships/orgs?per_page=100&page=1"]);
  assert.deepEqual(result.memberships.map((m) => m.github_org_id), ["42"]);
  assert.deepEqual(result.invitations, [{ github_org_id: "43", login: "invited", avatar_url: "https://a/43" }]);
  assert.deepEqual(result.ssoRequiredOrgIds, ["77", "99"]);
  assert.deepEqual((await listGitHubOrganizationMemberships("token", fetchImpl as typeof fetch)).map((m) => m.login), ["acme"]);
});

test("SSO ids and invitations are collected across pages and only partial-results is honored", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return call === 1
      ? Response.json([orgPage("active", "member", 1, "a")], { headers: { link: '<https://api.github.com/x>; rel="next"', "x-github-sso": "partial-results; organizations=5" } })
      : Response.json([orgPage("pending", "member", 2, "b")], { headers: { "x-github-sso": "required; url=https://github.com/orgs/x/sso?organizations=9" } });
  };
  const result = await readGitHubOrganizationAccess("token", fetchImpl as typeof fetch);
  assert.deepEqual(result.ssoRequiredOrgIds, ["5"]);
  assert.deepEqual(result.invitations.map((i) => i.github_org_id), ["2"]);
});

test("a token without an organization-read scope is reported; a missing scope header is not judged", async () => {
  const withScopes = (scopes: string | null) => (async () =>
    Response.json([], { headers: scopes === null ? {} : { "x-oauth-scopes": scopes } })) as typeof fetch;
  await assert.rejects(readGitHubOrganizationAccess("t", withScopes("read:user, repo")), GitHubOrganizationScopeError);
  await assert.rejects(readGitHubOrganizationAccess("t", withScopes("")), GitHubOrganizationScopeError);
  for (const ok of ["read:org", "repo, write:org", "admin:org"]) {
    assert.deepEqual((await readGitHubOrganizationAccess("t", withScopes(ok))).memberships, []);
  }
  assert.deepEqual((await readGitHubOrganizationAccess("t", withScopes(null))).memberships, []);
  const h = harness({ readAccess: async () => { throw new GitHubOrganizationScopeError(); } });
  const res = await h.request("GET /account/organizations");
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "github_scope_required" });
});

test("discovery returns invitations and SSO-required organizations with known logins", async () => {
  const h = harness({
    readAccess: access([membership], {
      invitations: [{ github_org_id: "43", login: "invited", avatar_url: null }],
      ssoRequiredOrgIds: ["77", "88"],
    }),
    getOrganizations: async (ids: string[]) => ids.includes("77") ? [organization, { ...organization, github_org_id: "77", login: "hidden-co" }] : [organization],
  });
  const body = (await h.request("GET /account/organizations")).body;
  assert.deepEqual(body.invitations, [{ github_org_id: "43", login: "invited", avatar_url: null }]);
  assert.deepEqual(body.sso_required, [{ github_org_id: "77", login: "hidden-co" }, { github_org_id: "88", login: null }]);
  assert.equal(body.organizations.length, 1);
});

test("authorize URL can add read:org once and pre-select a GitHub login", () => {
  process.env.GITHUB_CLIENT_ID = "cid";
  process.env.GITHUB_OAUTH_SCOPES = "read:user,repo";
  try {
    const url = new URL(buildGitHubAuthorizeUrl("st", { extraScopes: ["read:org", "repo"], login: "octo" }));
    assert.equal(url.searchParams.get("scope"), "read:user,repo,read:org");
    assert.equal(url.searchParams.get("login"), "octo");
    assert.equal(new URL(buildGitHubAuthorizeUrl("st")).searchParams.get("scope"), "read:user,repo");
    assert.equal(new URL(buildGitHubAuthorizeUrl("st")).searchParams.has("login"), false);
  } finally {
    delete process.env.GITHUB_OAUTH_SCOPES;
  }
});

function consentHarness() {
  const handlers = new Map<string, any>();
  const states: Array<[string, string]> = [];
  registerOrganizationConsentRoutes({ get: (path: string, handler: any) => handlers.set(path, handler) } as never, {
    createAuthState: (async (state: string, redirect: string) => { states.push([state, redirect]); }) as never,
    buildGitHubAuthorizeUrl: ((state: string, options: any) => `https://github.com/login/oauth/authorize?state=${state}&extra=${options.extraScopes}&login=${options.login ?? ""}`) as never,
  });
  const call = async (path: string, req: Record<string, unknown>) => {
    const res: any = {
      statusCode: 200, headers: {}, body: undefined,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
      send(body: unknown) { this.body = body; return this; },
      set(h: any) { Object.assign(this.headers, h); return this; },
      type() { return this; },
      redirect(url: string) { this.location = url; return this; },
    };
    await handlers.get(path)({ headers: {}, query: {}, ...req }, res);
    return res;
  };
  return { states, call };
}

test("consent route redirects browsers to GitHub with read:org and validates the login hint", async () => {
  const h = consentHarness();
  const ok = await h.call("/auth/github/organizations", { query: { login: "octo-cat" } });
  assert.match(ok.location, /^https:\/\/github\.com\/login\/oauth\/authorize\?state=[a-f0-9]{48}&extra=read:org&login=octo-cat$/);
  assert.equal(h.states[0][1], "/auth/github/organizations/done");
  assert.equal((await h.call("/auth/github/organizations", {})).statusCode, 200);
  for (const login of ["-bad", "a".repeat(40), "a b", "x&scope=admin", ["a", "b"]]) {
    assert.equal((await h.call("/auth/github/organizations", { query: { login } })).statusCode, 400);
  }
  assert.equal(h.states.length, 2);
  const agent = await h.call("/auth/github/organizations", { headers: { authorization: "Bearer x" } });
  assert.equal(agent.statusCode, 403);
  assert.equal(h.states.length, 2);
});

test("consent done page tells the person to return to LetAgents", async () => {
  const res = await consentHarness().call("/auth/github/organizations/done", {});
  assert.match(res.body, /<h1>GitHub access updated<\/h1>/);
  assert.match(res.body, /Return to LetAgents\. You can close this tab\./);
});
