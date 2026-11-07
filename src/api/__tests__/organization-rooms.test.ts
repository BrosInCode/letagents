import assert from "node:assert/strict";
import test from "node:test";

import { listAccessibleOrganizationRepositories } from "../github/organization-repositories.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerOrganizationRoomRoutes } = await import("../routes/account/organization-rooms.js");

const membership = { github_org_id: "42", login: "acme", avatar_url: null, role: "member" as const };
const organization = { github_org_id: "42", login: "acme", avatar_url: null, created_at: "now", updated_at: "now" };
const account = { account_id: "acct_1", provider: "github", provider_access_token: "user-token" };
const room = { github_repo_id: "100", room_id: "github.com/acme/app", display_name: "app", full_name: "acme/app" };
const accessible = { github_repo_id: "100", full_name: "acme/app", visibility: "private" as const };

function harness(overrides: Record<string, unknown> = {}) {
  let handler: (req: any, res: any) => Promise<void>;
  const calls = { candidates: 0, repositories: 0, removals: 0 };
  registerOrganizationRoomRoutes({ get: (_path: string, fn: typeof handler) => { handler = fn; } } as never, {
    listMemberships: async () => [membership],
    getOrganizations: async () => [organization],
    getJoinedIds: async () => ["42"],
    saveMembership: async () => organization,
    removeMembership: async () => { calls.removals += 1; },
    getConnectedRooms: async () => { calls.candidates += 1; return [room]; },
    listAccessibleRepositories: async (input) => {
      calls.repositories += 1;
      assert.deepEqual(input, { token: "user-token", organizationId: "42", login: "acme" });
      return [accessible];
    },
    ...overrides,
  });
  return {
    calls,
    async request(req: Record<string, unknown> = {}) {
      const res = {
        statusCode: 200, body: undefined as any,
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
      };
      await handler!({ sessionAccount: account, params: { organizationId: "42" }, ...req }, res);
      return res;
    },
  };
}

test("company discovery uses the employee credential and exposes only matching accessible connected repo rooms", async () => {
  const h = harness({ getConnectedRooms: async () => [room, { ...room, github_repo_id: "101", full_name: "acme/secret", display_name: "secret" }] });
  const res = await h.request();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rooms, [{ ...room, organization_id: "42", visibility: "private" }]);
  assert.equal(h.calls.repositories, 1);
  assert.equal(JSON.stringify(res.body).includes("secret"), false);
});

test("a stored join is insufficient after GitHub membership is removed", async () => {
  const h = harness({ listMemberships: async () => [] });
  const res = await h.request();
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "organization_membership_required");
  assert.deepEqual(h.calls, { candidates: 0, repositories: 0, removals: 1 });
});

test("employee must join LetAgents before company discovery", async () => {
  const h = harness({ getJoinedIds: async () => [] });
  assert.equal((await h.request()).body.error, "organization_join_required");
  assert.equal(h.calls.candidates, 0);
});

test("anonymous and worker credentials cannot list company rooms", async () => {
  const h = harness();
  assert.equal((await h.request({ sessionAccount: null })).statusCode, 401);
  assert.equal((await h.request({ authKind: "agent_session" })).statusCode, 403);
  assert.equal(h.calls.candidates, 0);
});

test("company with no connected rooms returns empty without making a repo request", async () => {
  const h = harness({ getConnectedRooms: async () => [] });
  assert.deepEqual((await h.request()).body.rooms, []);
  assert.equal(h.calls.repositories, 0);
});

test("stale repo names and IDs do not expose transferred or replaced rooms", async () => {
  for (const repo of [{ ...accessible, full_name: "other/app" }, { ...accessible, github_repo_id: "999" }]) {
    assert.deepEqual((await harness({ listAccessibleRepositories: async () => [repo] }).request()).body.rooms, []);
  }
});

test("provider failures do not return candidate metadata or delete membership", async () => {
  const h = harness({ listAccessibleRepositories: async () => { throw new Error("provider unavailable"); } });
  const res = await h.request();
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "organization_rooms_verification_unavailable" });
  assert.equal(h.calls.removals, 0);
});

test("GitHub repo discovery verifies owner identity, private read permission, and all pages", async () => {
  let page = 0;
  const repo = { id: 100, owner: { id: 42 }, full_name: "acme/app", private: true, permissions: { pull: true } };
  const repos = await listAccessibleOrganizationRepositories({
    token: "user-token", organizationId: "42", login: "acme",
    fetchImpl: (async (url: any, init: any) => {
      page += 1;
      assert.equal(init.headers.Authorization, "Bearer user-token");
      assert.ok(String(url).startsWith("https://api.github.com/orgs/acme/repos?"));
      return page === 1 ? Response.json([
        repo,
        { ...repo, id: 101, permissions: { pull: false } },
        { ...repo, id: 102, permissions: undefined },
        { ...repo, id: 103, owner: { id: 99 } },
      ], { headers: { link: '<https://untrusted.example>; rel="next"' } })
        : Response.json([{ ...repo, id: 104, full_name: "acme/public", private: false, permissions: undefined }]);
    }) as typeof fetch,
  });
  assert.deepEqual(repos.map((repo) => [repo.github_repo_id, repo.visibility]), [["100", "private"], ["104", "public"]]);
  assert.equal(page, 2);
});

test("GitHub repo discovery rejects malformed or failed pages instead of returning a partial list", async () => {
  for (const response of [new Response(null, { status: 403 }), Response.json([null]), Response.json({})]) {
    await assert.rejects(listAccessibleOrganizationRepositories({
      token: "token", organizationId: "42", login: "acme", fetchImpl: (async () => response) as typeof fetch,
    }));
  }
});
