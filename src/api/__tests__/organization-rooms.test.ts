import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubOrganizationSsoRequiredError,
  listAccessibleOrganizationRepositories,
  parseGitHubSsoAuthorizeUrl,
} from "../github/organization-repositories.js";
import { GitHubOrganizationScopeError } from "../github/organization-memberships.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerOrganizationRoomRoutes } = await import("../routes/account/organization-rooms.js");
const { registerLegacyProjectRoutes } = await import("../routes/legacy/projects.js");

const membership = { github_org_id: "42", login: "acme", avatar_url: null, role: "member" as const };
const organization = { github_org_id: "42", login: "acme", avatar_url: null, created_at: "now", updated_at: "now" };
const account = { account_id: "acct_1", provider: "github", provider_access_token: "user-token" };
const room = { github_repo_id: "100", room_id: "github.com/acme/app", display_name: "app", full_name: "acme/app" };
const accessible = { github_repo_id: "100", full_name: "acme/app", visibility: "private" as const };

function harness(overrides: Record<string, unknown> = {}) {
  let handler: (req: any, res: any) => Promise<void>;
  const calls = { candidates: 0, repositories: 0, removals: 0 };
  registerOrganizationRoomRoutes({ get: (_path: string, fn: typeof handler) => { handler = fn; } } as never, {
    readAccess: async () => ({ memberships: [membership], invitations: [], ssoRequiredOrgIds: [] }),
    getOrganizations: async () => [organization],
    getJoinedIds: async () => ["42"],
    saveMembership: async () => organization,
    removeMembership: async () => { calls.removals += 1; },
    getMemberRooms: async () => [],
    filterRoomAccess: async (_room: string, ids: string[]) => ({ recents: ids }),
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
      await handler!({ authKind: "session", sessionAccount: account, params: { organizationId: "42" }, ...req }, res);
      return res;
    },
  };
}

test("company discovery uses the employee credential and exposes only matching accessible connected repo rooms", async () => {
  const h = harness({ getConnectedRooms: async () => [room, { ...room, github_repo_id: "101", full_name: "acme/secret", display_name: "secret" }] });
  const res = await h.request();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rooms, [{ kind: "repo", ...room, organization_id: "42", visibility: "private" }]);
  assert.equal(h.calls.repositories, 1);
  assert.equal(JSON.stringify(res.body).includes("secret"), false);
});

test("a stored join is insufficient after GitHub membership is removed", async () => {
  const h = harness({ readAccess: async () => ({ memberships: [], invitations: [], ssoRequiredOrgIds: [] }) });
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
  assert.equal((await h.request({ sessionAccount: null, authKind: undefined })).statusCode, 401);
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

test("a public repo room needs a confirmed allow from the app's room access rule", async () => {
  const rooms = [
    room,
    { ...room, github_repo_id: "101", room_id: "github.com/acme/public-a", full_name: "acme/public-a", display_name: "public-a" },
    { ...room, github_repo_id: "102", room_id: "github.com/acme/public-b", full_name: "acme/public-b", display_name: "public-b" },
  ];
  const checked: string[] = [];
  const h = harness({
    getConnectedRooms: async () => rooms,
    listAccessibleRepositories: async () => [
      accessible,
      { github_repo_id: "101", full_name: "acme/public-a", visibility: "public" },
      { github_repo_id: "102", full_name: "acme/public-b", visibility: "public" },
    ],
    // 101 = no role (deny), 102 = transient error (retry: notify only, no recents)
    filterRoomAccess: async (roomId: string, ids: string[]) => {
      checked.push(roomId);
      assert.deepEqual(ids, ["acct_1"]);
      return { recents: roomId === "github.com/acme/app" ? ids : [] };
    },
  });
  const res = await h.request();
  assert.deepEqual(res.body.rooms.map((item: any) => item.room_id), ["github.com/acme/app"]);
  assert.deepEqual(checked.sort(), rooms.map((item) => item.room_id).sort());
});

test("room access checks run with a small concurrency limit", async () => {
  const rooms = Array.from({ length: 20 }, (_, i) => ({ ...room, github_repo_id: String(200 + i), room_id: `github.com/acme/r${i}`, full_name: `acme/r${i}`, display_name: `r${i}` }));
  let active = 0;
  let peak = 0;
  const h = harness({
    getConnectedRooms: async () => rooms,
    listAccessibleRepositories: async () => rooms.map((item) => ({ github_repo_id: item.github_repo_id, full_name: item.full_name, visibility: "public" })),
    filterRoomAccess: async (_room: string, ids: string[]) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { recents: ids };
    },
  });
  assert.equal((await h.request()).body.rooms.length, 20);
  assert.ok(peak > 1 && peak <= 6, `peak concurrency ${peak}`);
});

test("SSO-protected organizations answer with a validated authorize URL", async () => {
  const url = "https://github.com/orgs/acme/sso?authorization_request=abc";
  const res = await harness({ listAccessibleRepositories: async () => { throw new GitHubOrganizationSsoRequiredError(url); } }).request();
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "organization_sso_required", authorize_url: url });
  const noUrl = await harness({ listAccessibleRepositories: async () => { throw new GitHubOrganizationSsoRequiredError(null); } }).request();
  assert.deepEqual(noUrl.body, { error: "organization_sso_required" });
});

test("GitHub repo discovery turns a 403 SSO challenge into an SSO error and filters unsafe URLs", async () => {
  const sso = (header: string) => listAccessibleOrganizationRepositories({
    token: "t", organizationId: "42", login: "acme",
    fetchImpl: (async () => new Response(null, { status: 403, headers: { "x-github-sso": header } })) as typeof fetch,
  });
  await assert.rejects(sso("required; url=https://github.com/orgs/acme/sso?x=1"), (error: any) =>
    error instanceof GitHubOrganizationSsoRequiredError && error.authorizeUrl === "https://github.com/orgs/acme/sso?x=1");
  for (const bad of ["http://github.com/x", "https://evil.example/x", "https://github.com.evil.example/x", "https://user@github.com/x", "javascript:alert(1)", "https://github.com:8443/x", "not a url"]) {
    await assert.rejects(sso(`required; url=${bad}`), (error: any) => error instanceof GitHubOrganizationSsoRequiredError && error.authorizeUrl === null, bad);
  }
  assert.equal(parseGitHubSsoAuthorizeUrl("partial-results; organizations=1"), null);
  assert.equal(parseGitHubSsoAuthorizeUrl(null), null);
});

test("company rooms without a repo are listed with the final shape, even with no connected repos", async () => {
  const h = harness({
    getConnectedRooms: async () => [],
    getMemberRooms: async (organizationId: string, accountId: string) => {
      assert.deepEqual([organizationId, accountId], ["42", "acct_1"]);
      return [{ room_id: "abc-1234", display_name: "Planning" }];
    },
  });
  const res = await h.request();
  assert.deepEqual(res.body.rooms, [{
    kind: "room", room_id: "abc-1234", display_name: "Planning", full_name: null,
    github_repo_id: null, organization_id: "42", visibility: null,
  }]);
  assert.equal(h.calls.repositories, 0);
  const mixed = await harness({ getMemberRooms: async () => [{ room_id: "abc-1234", display_name: "Planning" }] }).request();
  assert.deepEqual(mixed.body.rooms.map((item: any) => item.kind), ["repo", "room"]);
});

test("scope errors from GitHub reach company routes as github_scope_required", async () => {
  const res = await harness({ readAccess: async () => { throw new GitHubOrganizationScopeError(); } }).request();
  assert.deepEqual([res.statusCode, res.body], [403, { error: "github_scope_required" }]);
});

function createRoomHarness(overrides: Record<string, unknown> = {}) {
  let handler: (req: any, res: any) => Promise<void>;
  const created: any[] = [];
  const creators: string[] = [];
  const unused = async () => { throw new Error("not invoked"); };
  registerLegacyProjectRoutes({
    get() {}, patch() {},
    post(path: string, fn: typeof handler) { if (path === "/projects") handler = fn; },
  } as never, {
    resolveRequestAuth: unused, resolveCanonicalRoomRequestId: unused, isRepoBackedRoomId: () => false,
    isRepoBackedProject: () => false, resolveRepoRoomAccessDecision: unused, resolveProjectRepoRoomAccessDecision: unused,
    replyRepoRoomAccessDecision: () => false, resolveProjectRole: unused, requireAdmin: unused,
    rememberHumanRoomParticipant: unused, rememberAccountRoom: async () => {},
    resolveRoomMembershipDecision: unused, replyRoomMembershipDecision: unused,
    companyRoomCreation: {
      readOrganizationAccess: async () => ({ memberships: [membership], invitations: [], ssoRequiredOrgIds: [] }),
      getJoinedOrganizationIds: async () => ["42"],
      createProject: async (options?: { organizationId?: string | null }) => {
        created.push(options ?? null);
        return { id: "room-1", code: "room-1", display_name: "Room One" };
      },
      recordRoomCreator: async (roomId: string) => { creators.push(roomId); },
      ...overrides,
    },
  } as never);
  return {
    created, creators,
    async post(req: Record<string, unknown> = {}) {
      const res = {
        statusCode: 200, body: undefined as any,
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
      };
      await handler!({
        authKind: "session", sessionAccount: account, method: "POST", headers: { origin: "https://app.test" },
        protocol: "https", get: () => "app.test", body: { organization_id: "42" }, ...req,
      }, res);
      return res;
    },
  };
}

test("POST /projects with organization_id stores the company on a new room", async () => {
  delete process.env.LETAGENTS_BASE_URL;
  delete process.env.PUBLIC_API_URL;
  const h = createRoomHarness();
  const res = await h.post();
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.organization_id, "42");
  assert.deepEqual(h.created, [{ organizationId: "42" }]);
  assert.deepEqual(h.creators, ["room-1"]);
  // Native bearer sessions need no Origin.
  assert.equal((await h.post({ headers: { authorization: "Bearer abc" } })).statusCode, 201);
});

test("POST /projects without organization_id is unchanged, even for owner tokens", async () => {
  const h = createRoomHarness({ readOrganizationAccess: async () => { throw new Error("must not call GitHub"); } });
  const res = await h.post({ authKind: "owner_token", body: undefined });
  assert.equal(res.statusCode, 201);
  assert.equal("organization_id" in res.body, false);
  assert.deepEqual(h.created, [null]);
});

test("POST /projects with organization_id enforces people-only, live membership, and a joined company", async () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, number, string]> = [
    ["owner token", { authKind: "owner_token" }, {}, 403, "human_app_session_required"],
    ["agent session", { authKind: "agent_session" }, {}, 403, "human_app_session_required"],
    ["cross-site", { headers: { origin: "https://evil.example" } }, {}, 403, "cross_site_write_refused"],
    ["login-only id", { body: { organization_id: "acme" } }, {}, 400, "invalid_organization_id"],
    ["zero id", { body: { organization_id: "0" } }, {}, 400, "invalid_organization_id"],
    ["left the org", {}, { readOrganizationAccess: async () => ({ memberships: [], invitations: [], ssoRequiredOrgIds: [] }) }, 403, "organization_membership_required"],
    ["pending invitation only", {}, { readOrganizationAccess: async () => ({ memberships: [], invitations: [{ github_org_id: "42", login: "acme", avatar_url: null }], ssoRequiredOrgIds: [] }) }, 403, "organization_membership_required"],
    ["not joined", {}, { getJoinedOrganizationIds: async () => [] }, 403, "organization_join_required"],
    ["missing scope", {}, { readOrganizationAccess: async () => { throw new GitHubOrganizationScopeError(); } }, 403, "github_scope_required"],
    ["GitHub down", {}, { readOrganizationAccess: async () => { throw new Error("down"); } }, 503, "organization_verification_unavailable"],
  ];
  for (const [name, req, overrides, status, code] of cases) {
    const h = createRoomHarness(overrides);
    const res = await h.post(req);
    assert.deepEqual([res.statusCode, res.body.error], [status, code], name);
    assert.deepEqual(h.created, [], name);
    assert.deepEqual(h.creators, [], name);
  }
});
