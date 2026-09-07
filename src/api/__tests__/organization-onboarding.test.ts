import assert from "node:assert/strict";
import test from "node:test";

import { GitHubOrganizationAccessError, listGitHubOrganizationMemberships } from "../github/organization-memberships.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerAccountOrganizationRoutes } = await import("../routes/account/organizations.js");

const membership = { github_org_id: "42", login: "acme", avatar_url: null, role: "owner" as const };
const organization = { github_org_id: "42", login: "acme", avatar_url: null, created_at: "now", updated_at: "now" };
const account = { account_id: "acct_1", provider: "github", provider_access_token: "test-token" };

function harness(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, (req: any, res: any) => Promise<void>>();
  const writes: any[] = [];
  const removals: string[] = [];
  registerAccountOrganizationRoutes({
    get: (path: string, handler: any) => handlers.set(`GET ${path}`, handler),
    post: (path: string, handler: any) => handlers.set(`POST ${path}`, handler),
  } as never, {
    listMemberships: async () => [membership],
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
      await handlers.get(path)!({ sessionAccount: account, params: { organizationId: "42" }, ...req }, res);
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
  assert.equal(calls[1], "https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=2");
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
  const h = harness({ listMemberships: async () => { throw new Error("must not call provider"); } });
  assert.equal((await h.request("GET /account/organizations", { sessionAccount: null })).statusCode, 401);
  assert.equal((await h.request("POST /organizations/:organizationId/setup", { authKind: "agent_session" })).statusCode, 403);
  assert.equal(h.writes.length, 0);
});

test("discovery distinguishes setup/joined companies and preserves an empty personal path", async () => {
  const h = harness({
    listMemberships: async () => [membership, { ...membership, github_org_id: "43", login: "other" }],
    getJoinedIds: async () => ["42", "99"],
  });
  assert.deepEqual((await h.request("GET /account/organizations")).body.organizations.map((org: any) => [org.github_org_id, org.setup, org.joined]), [["42", true, true], ["43", false, false]]);
  assert.deepEqual((await harness({ listMemberships: async () => [] }).request("GET /account/organizations")).body, { organizations: [] });
  assert.equal(h.writes.length, 0);
});

test("only verified owners can set up a company; request body roles are ignored", async () => {
  const h = harness({ listMemberships: async () => [{ ...membership, role: "member" }] });
  const denied = await h.request("POST /organizations/:organizationId/setup", { body: { role: "owner" } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error, "organization_owner_required");
  assert.equal(h.writes.length, 0);
  const owner = harness();
  assert.equal((await owner.request("POST /organizations/:organizationId/setup")).statusCode, 200);
  assert.deepEqual(owner.writes[0], { accountId: "acct_1", membership, create: true });
});

test("members join an existing company but cannot implicitly create one", async () => {
  const h = harness({ listMemberships: async () => [{ ...membership, role: "member" }] });
  assert.equal((await h.request("POST /organizations/:organizationId/join")).body.joined, true);
  assert.equal(h.writes[0].create, false);
  assert.equal(h.writes[0].membership.role, "member");
  const missing = await harness({ saveMembership: async () => null }).request("POST /organizations/:organizationId/join");
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.body.error, "organization_setup_required");
});

test("revoked membership removes a stored join and cannot create or rejoin the company", async () => {
  const h = harness({ listMemberships: async () => [] });
  assert.equal((await h.request("POST /organizations/:organizationId/join")).statusCode, 403);
  assert.deepEqual(h.removals, ["42"]);
  assert.equal(h.writes.length, 0);
});

test("provider outages preserve stored joins, block access, and distinguish expired credentials", async () => {
  for (const status of [401, 403, 429, 500]) {
    const h = harness({ listMemberships: async () => { throw new GitHubOrganizationAccessError(status); } });
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
