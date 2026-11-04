import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  clearGitHubRepoAccessCacheForLogin,
  clearGitHubRepoAccessCacheForRoom,
  getGitHubRepoVisibility,
  githubRepoAccessInvalidationEvents,
  GitHubAccessUnavailableError,
  isGitHubPublicRepoRoleHolder,
  isGitHubRepoCollaborator,
  isGitHubRepoWriter,
  resetGitHubRepoVisibilityBackoffForTests,
  resolveGitHubRepoRoomAccessDecision,
} from "../github/repo-access.js";
import { setBridgedEventPublisher } from "../server/bridged-emitter.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetGitHubRepoVisibilityBackoffForTests();
});

test("a public GitHub repo room needs a sign-in and a GitHub role on the repository", async () => {
  const account = { provider: "github", provider_access_token: "secret-token", login: "EmmyMay" };
  const roleChecks: string[] = [];
  const decide = (sessionAccount: typeof account | null, hasRole: boolean) => resolveGitHubRepoRoomAccessDecision(
    { roomName: "github.com/BrosInCode/letagents", sessionAccount },
    {
      getVisibility: async () => "public",
      isCollaborator: async () => { throw new Error("the private-repo check must not decide a public repo"); },
      isPublicRepoRoleHolder: async (input) => { roleChecks.push(`${input.roomName}:${input.login}`); return hasRole; },
    },
  );

  assert.deepEqual(await decide(null, true), { kind: "auth_required" });
  assert.deepEqual(roleChecks, [], "no GitHub lookup for a caller with no sign-in");
  assert.deepEqual(await decide(account, false), { kind: "repo_collaborator_required" });
  assert.deepEqual(await decide(account, true), { kind: "allow" });
  assert.deepEqual(roleChecks, ["github.com/brosincode/letagents:EmmyMay", "github.com/brosincode/letagents:EmmyMay"]);
  assert.deepEqual(
    await decide({ ...account, provider_access_token: "" }, true),
    { kind: "repo_collaborator_required" },
    "without a GitHub token the role cannot be checked",
  );
});

test("a GitHub role on a public repository means owner, triage or more, never read alone", async () => {
  const room = `github.com/acme/public-${Date.now()}`;
  const permissionsByLogin: Record<string, Record<string, boolean>> = {
    reader: { pull: true },
    triager: { pull: true, triage: true },
    writer: { pull: true, triage: true, push: true },
  };
  let calls = 0;
  let status = 200;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (status !== 200) return jsonResponse(status, { message: "unavailable" });
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    return jsonResponse(200, { private: false, owner: { login: "acme" }, permissions: permissionsByLogin[token] ?? { pull: true } });
  }) as typeof fetch;
  const check = (login: string, options: { bypassCache?: boolean; throwOnIndeterminate?: boolean } = {}) =>
    isGitHubPublicRepoRoleHolder({ roomName: room, login, accessToken: login, ...options });

  assert.equal(await check("acme"), true, "the owner");
  assert.equal(await check("triager"), true);
  assert.equal(await check("writer"), true);
  assert.equal(await check("reader"), false, "read access is what everyone has on a public repository");
  const afterFirstLookups = calls;
  assert.equal(await check("reader"), false);
  assert.equal(calls, afterFirstLookups, "a no-role answer is kept briefly");
  await withClockOffset(61_000, async () => {
    assert.equal(await check("reader"), false);
  });
  assert.equal(calls, afterFirstLookups + 1, "and asked again after a minute");
  assert.equal(await check("triager", { bypassCache: true }), true);
  assert.equal(calls, afterFirstLookups + 2, "a fresh check always asks GitHub");

  status = 503;
  await assert.rejects(check("outage-person"), { name: "GitHubAccessUnavailableError" },
    "no answer from GitHub is never a no");
  assert.equal(await check("triager", { bypassCache: true }), true,
    "during an outage, a positive answer from the last hour stands in");
  status = 200;
  permissionsByLogin["outage-person"] = { pull: true, triage: true };
  assert.equal(await check("outage-person"), true, "an outage answer is not kept");
});

test("parallel role checks for one person and repository share one GitHub request", async () => {
  const room = `github.com/acme/parallel-${Date.now()}`;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse(200, { private: false, owner: { login: "acme" }, permissions: { pull: true } });
  }) as typeof fetch;
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    isGitHubPublicRepoRoleHolder({ roomName: room, login: "someone", accessToken: "token" })));
  assert.deepEqual(results, Array(8).fill(false));
  assert.equal(calls, 1);
});

test("an unanswered role check is a retry, not a refusal, and a sign-in-less caller costs no lookup", async () => {
  const account = { provider: "github", provider_access_token: "secret-token", login: "EmmyMay" };
  let visibilityLookups = 0;
  const deps = {
    getVisibility: async () => { visibilityLookups += 1; return "public" as const; },
    isCollaborator: async () => false,
    isPublicRepoRoleHolder: async () => { throw new GitHubAccessUnavailableError(503); },
  };
  assert.deepEqual(
    await resolveGitHubRepoRoomAccessDecision({ roomName: "github.com/acme/app", sessionAccount: null }, deps),
    { kind: "auth_required" },
  );
  assert.equal(visibilityLookups, 0, "no GitHub lookup for a caller with no sign-in");
  assert.deepEqual(
    await resolveGitHubRepoRoomAccessDecision({ roomName: "github.com/acme/app", sessionAccount: account }, deps),
    { kind: "repo_access_unavailable" },
  );
  await assert.rejects(
    resolveGitHubRepoRoomAccessDecision({ roomName: "github.com/acme/app", sessionAccount: account, throwOnIndeterminate: true }, deps),
    { name: "GitHubAccessUnavailableError" },
    "authority revalidation keeps its grant on an outage",
  );
});

test("resolveGitHubRepoRoomAccessDecision still requires auth for private GitHub repo rooms", async () => {
  const decision = await resolveGitHubRepoRoomAccessDecision(
    {
      roomName: "github.com/brosincode/secret-repo",
      sessionAccount: null,
    },
    {
      getVisibility: async () => "private",
      isCollaborator: async () => false,
    }
  );

  assert.deepEqual(decision, { kind: "auth_required" });
});

test("resolveGitHubRepoRoomAccessDecision allows authenticated collaborators into private repos", async () => {
  const decision = await resolveGitHubRepoRoomAccessDecision(
    {
      roomName: "github.com/brosincode/secret-repo",
      sessionAccount: {
        provider: "github",
        provider_access_token: "secret-token",
        login: "EmmyMay",
      },
    },
    {
      getVisibility: async () => "private",
      isCollaborator: async () => true,
    }
  );

  assert.deepEqual(decision, { kind: "allow" });
});

test("resolveGitHubRepoRoomAccessDecision rejects authenticated non-collaborators on private repos", async () => {
  const decision = await resolveGitHubRepoRoomAccessDecision(
    {
      roomName: "github.com/brosincode/secret-repo",
      sessionAccount: {
        provider: "github",
        provider_access_token: "secret-token",
        login: "outsider",
      },
    },
    {
      getVisibility: async () => "private",
      isCollaborator: async () => false,
    }
  );

  assert.deepEqual(decision, { kind: "private_repo_no_access" });
});

test("resolveGitHubRepoRoomAccessDecision keys every dependency lookup on the canonical room name", async () => {
  // Webhook invalidation clears `github.com/owner/repo`, so a lookup (and its
  // cache entry) under an alias spelling would stay stale after a member leaves.
  for (const roomName of [
    "github.com/brosincode/secret-repo",
    "GitHub.com/BrosInCode/Secret-Repo",
    "www.github.com/brosincode/secret-repo",
    "ssh.github.com/BrosInCode/Secret-Repo",
    "ssh.github.com:443/brosincode/secret-repo",
    "ssh://git@ssh.github.com:443/BrosInCode/Secret-Repo.git",
  ]) {
    const visibilityNames: string[] = [];
    const collaboratorNames: string[] = [];
    const decision = await resolveGitHubRepoRoomAccessDecision(
      {
        roomName,
        sessionAccount: {
          provider: "github",
          provider_access_token: "secret-token",
          login: "EmmyMay",
        },
        freshCollaboratorCheck: true,
      },
      {
        getVisibility: async (name) => {
          visibilityNames.push(name);
          return "private";
        },
        isCollaborator: async (input) => {
          collaboratorNames.push(input.roomName);
          return true;
        },
      }
    );

    assert.deepEqual(decision, { kind: "allow" }, roomName);
    assert.deepEqual(visibilityNames, ["github.com/brosincode/secret-repo"], roomName);
    assert.deepEqual(collaboratorNames, ["github.com/brosincode/secret-repo"], roomName);
  }
});

test("a webhook invalidation of the canonical room clears the entry an alias-form decision created", async () => {
  let memberRemoved = false;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (/\/collaborators\/[^/]+\/permission$/.test(String(url))) {
      return memberRemoved
        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
        : new Response(JSON.stringify({ permission: "write" }), { status: 200 });
    }
    return new Response(JSON.stringify({ private: true, owner: { login: "BrosInCode" } }), { status: 200 });
  }) as typeof fetch;

  const account = { provider: "github", provider_access_token: "secret-token", login: "alias-member" };
  const aliasRoom = "ssh.github.com/brosincode/alias-invalidation-repo";
  const canonicalRoom = "github.com/brosincode/alias-invalidation-repo";

  assert.deepEqual(
    await resolveGitHubRepoRoomAccessDecision({ roomName: aliasRoom, sessionAccount: account }),
    { kind: "allow" }
  );

  // The member is removed and the webhook clears the CANONICAL room.
  memberRemoved = true;
  clearGitHubRepoAccessCacheForRoom(canonicalRoom);

  assert.deepEqual(
    await resolveGitHubRepoRoomAccessDecision({ roomName: aliasRoom, sessionAccount: account }),
    { kind: "private_repo_no_access" }
  );
});

// The real github.com room and the hosts that must land in it give one decision.
const GITHUB_ROOM_SPELLINGS = [
  "github.com/brosincode/secret-repo",
  "www.github.com/brosincode/secret-repo",
  "ssh.github.com/brosincode/secret-repo",
  "ssh.github.com:443/brosincode/secret-repo",
];

for (const roomName of GITHUB_ROOM_SPELLINGS) {
  test(`resolveGitHubRepoRoomAccessDecision treats ${roomName} as the real GitHub repo room`, async () => {
    const collaborator = {
      provider: "github",
      provider_access_token: "secret-token",
      login: "EmmyMay",
    };
    const decide = (
      visibility: "public" | "private",
      sessionAccount: typeof collaborator | null,
      isCollaborator: boolean
    ) =>
      resolveGitHubRepoRoomAccessDecision(
        { roomName, sessionAccount },
        {
          getVisibility: async () => visibility,
          isCollaborator: async () => isCollaborator,
          isPublicRepoRoleHolder: async (input) => {
            assert.equal(input.roomName, "github.com/brosincode/secret-repo");
            return isCollaborator;
          },
        }
      );

    assert.deepEqual(await decide("public", null, false), { kind: "auth_required" });
    assert.deepEqual(await decide("public", collaborator, true), { kind: "allow" });
    assert.deepEqual(await decide("public", collaborator, false), { kind: "repo_collaborator_required" });
    assert.deepEqual(await decide("private", null, false), { kind: "auth_required" });
    assert.deepEqual(await decide("private", collaborator, true), { kind: "allow" });
    assert.deepEqual(await decide("private", collaborator, false), { kind: "private_repo_no_access" });
  });
}

for (const roomName of [
  "gitlab.com/team/project",
  "gitlab.com/group/sub/project",
  "bitbucket.org/team/project",
  "local/Users/someone",
  "github.com.evil.example/owner/repo",
  "ssh.github.com.evil.example/owner/repo",
  "github-work/acme/app",
  "team/design/ideas",
]) {
  test(`resolveGitHubRepoRoomAccessDecision denies the non-GitHub repo room ${roomName} for everyone`, async () => {
    const deps = {
      getVisibility: async () => {
        throw new Error("visibility must not be looked up for a non-GitHub host");
      },
      isCollaborator: async () => {
        throw new Error("collaborator check must not run for a non-GitHub host");
      },
    };

    assert.deepEqual(
      await resolveGitHubRepoRoomAccessDecision({ roomName, sessionAccount: null }, deps),
      { kind: "unsupported_repo_provider" }
    );
    assert.deepEqual(
      await resolveGitHubRepoRoomAccessDecision(
        {
          roomName,
          sessionAccount: {
            provider: "github",
            provider_access_token: "secret-token",
            login: "EmmyMay",
          },
        },
        deps
      ),
      { kind: "unsupported_repo_provider" }
    );
  });
}

test("repository visibility is shared and single-flighted across authenticated callers", async () => {
  const roomName = `github.com/brosincode/public-cache-${Date.now()}`;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ private: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const visibility = await Promise.all([
    getGitHubRepoVisibility(roomName),
    getGitHubRepoVisibility(roomName, "token-a"),
    getGitHubRepoVisibility(roomName.toUpperCase(), "token-b"),
  ]);
  assert.deepEqual(visibility, ["public", "public", "public"]);
  assert.equal(calls, 1);

  assert.equal(await getGitHubRepoVisibility(roomName, "token-c"), "public");
  assert.equal(calls, 1, "authenticated callers reuse repository-wide visibility");
});

test("an authenticated private-repo lookup refines unknown once and shares the result", async () => {
  const roomName = `github.com/brosincode/private-cache-${Date.now()}`;
  const authorizationHeaders: Array<string | null> = [];
  globalThis.fetch = (async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    authorizationHeaders.push(authorization);
    if (!authorization) {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ private: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName, "token-a"), "private");
  assert.equal(await getGitHubRepoVisibility(roomName, "token-b"), "private");
  assert.equal(await getGitHubRepoVisibility(roomName), "private");
  assert.deepEqual(authorizationHeaders, [null, "Bearer token-a"]);
});

test("room invalidation refreshes shared visibility after a repository webhook", async () => {
  const roomName = `github.com/brosincode/visibility-change-${Date.now()}`;
  let isPrivate = false;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const authorization = new Headers(init?.headers).get("authorization");
    if (isPrivate && !authorization) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ private: isPrivate }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  isPrivate = true;
  clearGitHubRepoAccessCacheForRoom(roomName);
  assert.equal(await getGitHubRepoVisibility(roomName, "token"), "private");
  assert.equal(calls, 3, "post-webhook lookup performs anonymous discovery plus private refinement");
});

test("a fresh visibility check bypasses a cached public result", async () => {
  const roomName = `github.com/brosincode/fresh-visibility-${Date.now()}`;
  let isPrivate = false;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const authorization = new Headers(init?.headers).get("authorization");
    if (isPrivate && !authorization) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ private: isPrivate }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  isPrivate = true;
  assert.equal(
    await getGitHubRepoVisibility(roomName, "token", { bypassCache: true }),
    "private",
  );
  assert.equal(calls, 2, "fresh access uses the owner token directly and skips the anonymous quota");
});

test("a fresh room decision bypasses both visibility and collaborator caches", async () => {
  let visibilityBypassed = false;
  let collaboratorBypassed = false;
  let indeterminateThrows = false;
  const decision = await resolveGitHubRepoRoomAccessDecision(
    {
      roomName: "github.com/brosincode/secret-repo",
      sessionAccount: {
        provider: "github",
        provider_access_token: "secret-token",
        login: "EmmyMay",
      },
      freshCollaboratorCheck: true,
    },
    {
      getVisibility: async (_roomName, _accessToken, options) => {
        visibilityBypassed = options?.bypassCache === true;
        return "private";
      },
      isCollaborator: async (input) => {
        collaboratorBypassed = input.bypassCache === true;
        indeterminateThrows = input.throwOnIndeterminate === true;
        return true;
      },
    },
  );

  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(visibilityBypassed, true);
  assert.equal(collaboratorBypassed, true);
  assert.equal(indeterminateThrows, false, "fresh cache bypass does not change existing caller error contracts");
});

test("authority callers explicitly opt into indeterminate provider errors", async () => {
  let indeterminateThrows = false;
  const decision = await resolveGitHubRepoRoomAccessDecision({
    roomName: "github.com/brosincode/secret-repo",
    sessionAccount: {
      provider: "github",
      provider_access_token: "secret-token",
      login: "EmmyMay",
    },
    freshCollaboratorCheck: true,
    throwOnIndeterminate: true,
  }, {
    getVisibility: async () => "private",
    isCollaborator: async (input) => {
      indeterminateThrows = input.throwOnIndeterminate === true;
      return true;
    },
  });
  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(indeterminateThrows, true);
});

test("fresh collaborator revalidation throws on GitHub outages instead of denying access", async () => {
  const fetchImpl = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  await assert.rejects(
    isGitHubRepoCollaborator({
      roomName: `github.com/brosincode/indeterminate-${Date.now()}`,
      login: "EmmyMay",
      accessToken: "token",
      bypassCache: true,
      throwOnIndeterminate: true,
      fetchImpl,
    }),
    /indeterminate \(503\)/,
  );
});

test("fresh collaborator revalidation treats dead credentials and secondary throttling as indeterminate", async () => {
  for (const response of [
    new Response("bad credentials", { status: 401 }),
    new Response("slow down", { status: 403, headers: { "retry-after": "60", "x-ratelimit-remaining": "4999" } }),
  ]) {
    await assert.rejects(
      isGitHubRepoCollaborator({
        roomName: `github.com/brosincode/provider-uncertain-${response.status}-${Date.now()}`,
        login: "EmmyMay",
        accessToken: "token",
        bypassCache: true,
        throwOnIndeterminate: true,
        fetchImpl: (async () => response.clone()) as typeof fetch,
      }),
      new RegExp(`indeterminate \\(${response.status}\\)`),
    );
  }
});

test("concurrent collaborator checks are single-flighted per repository and login", async () => {
  const roomName = `github.com/brosincode/permission-flight-${Date.now()}`;
  let repoCalls = 0;
  let permissionCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/collaborators/")) {
      permissionCalls += 1;
      return new Response(JSON.stringify({ permission: "read" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    repoCalls += 1;
    return new Response(JSON.stringify({ private: true, owner: { login: "BrosInCode" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const checks = await Promise.all(Array.from({ length: 12 }, () => isGitHubRepoCollaborator({
    roomName,
    login: "octocat",
    accessToken: "token",
    fetchImpl,
  })));
  assert.ok(checks.every(Boolean));
  assert.equal(repoCalls, 1);
  assert.equal(permissionCalls, 1);

  assert.equal(await isGitHubRepoCollaborator({
    roomName,
    login: "octocat",
    accessToken: "another-token",
    fetchImpl,
  }), true);
  assert.equal(repoCalls, 1);
  assert.equal(permissionCalls, 1);
});

test("login invalidation prevents an older in-flight allow from repopulating access cache", async () => {
  const roomName = `github.com/brosincode/permission-invalidation-${Date.now()}`;
  let releaseOwner!: () => void;
  const ownerGate = new Promise<void>((resolve) => { releaseOwner = resolve; });
  const allowFetch = (async () => {
    await ownerGate;
    return new Response(JSON.stringify({ owner: { login: "octocat" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const staleAllow = isGitHubRepoCollaborator({
    roomName,
    login: "octocat",
    accessToken: "token",
    fetchImpl: allowFetch,
  });
  clearGitHubRepoAccessCacheForLogin("octocat");
  releaseOwner();
  assert.equal(await staleAllow, true);

  let liveCalls = 0;
  const denyFetch = (async () => {
    liveCalls += 1;
    return new Response("forbidden", { status: 403 });
  }) as typeof fetch;
  assert.equal(await isGitHubRepoCollaborator({
    roomName,
    login: "octocat",
    accessToken: "token",
    fetchImpl: denyFetch,
  }), false);
  assert.equal(liveCalls, 1, "the invalidated in-flight allow was not cached");
});

test("isGitHubRepoCollaborator does not cache negative collaborator checks", async () => {
  const calls: string[] = [];
  let permissionCallCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    if (url.includes("/collaborators/outsider/permission")) {
      permissionCallCount += 1;
      if (permissionCallCount === 1) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ permission: "read" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        private: true,
        owner: { login: "BrosInCode" },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const roomName = `github.com/brosincode/no-negative-cache-${Date.now()}`;
  const first = await isGitHubRepoCollaborator({
    roomName,
    login: "outsider",
    accessToken: "token",
  });
  const second = await isGitHubRepoCollaborator({
    roomName,
    login: "outsider",
    accessToken: "token",
  });

  assert.equal(first, false);
  assert.equal(second, true);
  assert.equal(permissionCallCount, 2);
  assert.equal(
    calls.filter((url) => url.includes("/collaborators/outsider/permission")).length,
    2,
  );
});

// Anonymous reads of a public room returned 401 about once in 50 requests:
// a rate-limited or failed visibility refresh became "unknown", which reads
// as private. A remembered definitive answer now stands in until GitHub answers.
async function withClockOffset<T>(offsetMs: number, run: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("a remembered public visibility stands while GitHub cannot answer a refresh", async () => {
  const roomName = `github.com/brosincode/public-flap-${Date.now()}`;
  const replies: Array<() => Response> = [
    () => jsonResponse(200, { private: false }),
    () => jsonResponse(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }),
    () => jsonResponse(503, { message: "unavailable" }),
    () => { throw new TypeError("fetch failed"); },
  ];
  let calls = 0;
  globalThis.fetch = (async () => {
    const reply = replies[Math.min(calls, replies.length - 1)]!;
    calls += 1;
    return reply();
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  for (const [index, offsetMs] of [61_000, 122_000, 183_000].entries()) {
    await withClockOffset(offsetMs, async () => {
      assert.equal(await getGitHubRepoVisibility(roomName), "public", `refresh ${index + 1} keeps the known answer`);
    });
  }
  assert.equal(calls, 4, "each refresh still asks GitHub once");

  await withClockOffset(2 * 60 * 60 * 1000, async () => {
    await assert.rejects(getGitHubRepoVisibility(roomName), /fetch failed/, "a long outage no longer vouches for the room");
  });
});

test("a definitive not-found answer retires a remembered public visibility", async () => {
  const roomName = `github.com/brosincode/went-private-${Date.now()}`;
  const replies = [
    () => jsonResponse(200, { private: false }),
    () => jsonResponse(404, { message: "Not Found" }),
    () => jsonResponse(429, { message: "slow down" }),
  ];
  let calls = 0;
  globalThis.fetch = (async () => replies[Math.min(calls++, replies.length - 1)]!()) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  await withClockOffset(61_000, async () => {
    assert.equal(await getGitHubRepoVisibility(roomName), "unknown");
  });
  await withClockOffset(122_000, async () => {
    assert.equal(await getGitHubRepoVisibility(roomName), "unknown");
    assert.deepEqual(
      await resolveGitHubRepoRoomAccessDecision({ roomName, sessionAccount: null }),
      { kind: "auth_required" },
    );
  });
});

test("fresh visibility checks see GitHub's answer and do not unsettle other readers", async () => {
  const roomName = `github.com/brosincode/fresh-flap-${Date.now()}`;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(200, { private: false })
      : jsonResponse(503, { message: "unavailable" });
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  assert.equal(await getGitHubRepoVisibility(roomName, "token", { bypassCache: true }), "unknown");
  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  assert.equal(calls, 2, "anonymous readers keep the cached answer");
});

test("repository webhook invalidation discards the remembered visibility", async () => {
  const roomName = `github.com/brosincode/invalidated-${Date.now()}`;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(200, { private: false })
      : jsonResponse(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  clearGitHubRepoAccessCacheForRoom(roomName);
  assert.equal(await getGitHubRepoVisibility(roomName), "unknown");
});

test("401 and a plain 403 to a token-less lookup are answers: the room is not public", async () => {
  const roomName = `github.com/brosincode/refused-${Date.now()}`;
  const replies = [
    () => jsonResponse(200, { private: false }),
    () => jsonResponse(401, { message: "Requires authentication" }),
    () => jsonResponse(200, { private: false }),
    () => jsonResponse(403, { message: "Repository access blocked" }),
    () => jsonResponse(200, { private: false }),
  ];
  let calls = 0;
  globalThis.fetch = (async () => replies[Math.min(calls++, replies.length - 1)]!()) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  for (const [index, offsetMs] of [61_000, 183_000].entries()) {
    await withClockOffset(offsetMs, async () => {
      assert.notEqual(await getGitHubRepoVisibility(roomName), "public", `refusal ${index + 1} is not kept public`);
      assert.deepEqual(
        await resolveGitHubRepoRoomAccessDecision({ roomName, sessionAccount: null }),
        { kind: "auth_required" },
      );
    });
    await withClockOffset(offsetMs + 61_000, async () => {
      assert.equal(await getGitHubRepoVisibility(roomName), "public", "a refusal does not pause other lookups");
    });
  }
  assert.equal(calls, 5);
});

test("a secondary rate limit without headers keeps the remembered public answer", async () => {
  const roomName = `github.com/brosincode/secondary-${Date.now()}`;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(200, { private: false })
      : jsonResponse(403, { message: "You have exceeded a secondary rate limit. Please wait a few minutes." });
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  await withClockOffset(61_000, async () => {
    assert.equal(await getGitHubRepoVisibility(roomName), "public");
  });
});

test("an anonymous live-stream recheck of a public room is refused before any GitHub lookup", async () => {
  const roomName = `github.com/brosincode/live-anonymous-${Date.now()}`;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (calls === 1) return jsonResponse(200, { private: false });
    if (new Headers(init?.headers).get("authorization")) return jsonResponse(503, { message: "unavailable" });
    return jsonResponse(429, { message: "slow down" }, { "retry-after": "120" });
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  assert.equal(await getGitHubRepoVisibility(roomName, undefined, { bypassCache: true }), "public");
  assert.deepEqual(
    await resolveGitHubRepoRoomAccessDecision({ roomName, sessionAccount: null, freshCollaboratorCheck: true }),
    { kind: "auth_required" },
  );
  assert.equal(calls, 2, "no GitHub lookup is spent on a caller with no sign-in");
  assert.equal(
    await getGitHubRepoVisibility(roomName, "token", { bypassCache: true }),
    "unknown",
    "a signed-in fresh check still sees GitHub's live answer",
  );
});

test("a rate limit pauses token-less lookups for every room until GitHub's reset", async () => {
  const stamp = Date.now();
  const known = `github.com/brosincode/known-${stamp}`;
  const limited = `github.com/brosincode/limited-${stamp}`;
  const unseen = `github.com/brosincode/unseen-${stamp}`;
  const requests: Array<{ url: string; authorized: boolean }> = [];
  let rateLimited = false;
  globalThis.fetch = (async (input, init) => {
    const authorized = Boolean(new Headers(init?.headers).get("authorization"));
    requests.push({ url: String(input), authorized });
    if (rateLimited && !authorized) {
      return jsonResponse(403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.ceil((stamp + 120_000) / 1000)),
      });
    }
    return jsonResponse(200, { private: false });
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(known), "public");
  rateLimited = true;
  assert.equal(await getGitHubRepoVisibility(limited), "unknown");
  assert.equal(requests.length, 2);

  await withClockOffset(61_000, async () => {
    assert.equal(await getGitHubRepoVisibility(known), "public", "a remembered answer is served without asking");
    assert.equal(await getGitHubRepoVisibility(unseen), "unknown");
    assert.equal(requests.length, 2, "no token-less request is made before the reset");
    assert.equal(await getGitHubRepoVisibility(unseen, "token"), "public", "a signed-in token has its own budget");
    assert.equal(requests.length, 3);
    assert.equal(requests[2]!.authorized, true);
  });

  rateLimited = false;
  await withClockOffset(125_000, async () => {
    assert.equal(await getGitHubRepoVisibility(limited), "public", "lookups resume after the reset");
  });
});

test("an invalidation relayed from another API instance clears this instance's visibility", async () => {
  const roomName = `github.com/brosincode/relayed-${Date.now()}`;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(200, { private: false })
      : jsonResponse(503, { message: "unavailable" });
  }) as typeof fetch;
  assert.equal(await getGitHubRepoVisibility(roomName), "public");

  const published: unknown[] = [];
  setBridgedEventPublisher((lane, event, data) => published.push({ lane, event, data }));
  try {
    githubRepoAccessInvalidationEvents.emitLocal("invalidate", { roomName: roomName.toUpperCase() });
  } finally {
    setBridgedEventPublisher(null);
  }
  assert.deepEqual(published, [], "a relayed invalidation is not published again");
  assert.equal(await getGitHubRepoVisibility(roomName), "unknown", "neither the cache nor the remembered answer survives");
  assert.equal(calls, 2);
});

test("a dead signed-in token says nothing about visibility and cannot unsettle a public room", async () => {
  const roomName = `github.com/brosincode/dead-token-${Date.now()}`;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (calls === 1) return jsonResponse(200, { private: false });
    if (new Headers(init?.headers).get("authorization")) return jsonResponse(401, { message: "Bad credentials" });
    return jsonResponse(429, { message: "slow down" });
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  assert.equal(await getGitHubRepoVisibility(roomName, "revoked-token", { bypassCache: true }), "unknown");
  assert.equal(await getGitHubRepoVisibility(roomName), "public", "other readers keep the cached answer");
  await withClockOffset(61_000, async () => {
    assert.equal(await getGitHubRepoVisibility(roomName), "public", "the remembered answer was not retired");
  });
});

test("a signed-in token refused by GitHub cannot retire a remembered public answer", async () => {
  const roomName = `github.com/brosincode/sso-token-${Date.now()}`;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (calls === 1) return jsonResponse(200, { private: false });
    if (new Headers(init?.headers).get("authorization")) {
      return jsonResponse(403, { message: "Resource protected by organization SAML enforcement." });
    }
    return jsonResponse(429, { message: "slow down" });
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  assert.equal(await getGitHubRepoVisibility(roomName, "sso-token", { bypassCache: true }), "unknown");
  await withClockOffset(61_000, async () => {
    assert.equal(await getGitHubRepoVisibility(roomName), "public", "anonymous readers keep the remembered answer");
  });
});

test("a signed-in not-found answer still retires a remembered public answer", async () => {
  const roomName = `github.com/brosincode/signed-in-404-${Date.now()}`;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (calls === 1) return jsonResponse(200, { private: false });
    if (new Headers(init?.headers).get("authorization")) return jsonResponse(404, { message: "Not Found" });
    return jsonResponse(429, { message: "slow down" });
  }) as typeof fetch;

  assert.equal(await getGitHubRepoVisibility(roomName), "public");
  assert.equal(await getGitHubRepoVisibility(roomName, "token", { bypassCache: true }), "unknown");
  await withClockOffset(61_000, async () => {
    assert.equal(await getGitHubRepoVisibility(roomName), "unknown");
  });
});

test("isGitHubRepoWriter passes owners and writers, and refuses readers and failures", async () => {
  const fetchFor = (permission: { permission?: string; role_name?: string } | null, owner = "acme") => (async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith("/permission")) return permission ? new Response(JSON.stringify(permission), { status: 200 }) : new Response("", { status: 404 });
    return new Response(JSON.stringify({ owner: { login: owner }, private: true }), { status: 200 });
  }) as typeof fetch;
  const check = (login: string, fetchImpl: typeof fetch) => isGitHubRepoWriter({ roomName: "github.com/acme/app", login, accessToken: "t", fetchImpl });
  assert.equal(await check("acme", fetchFor(null)), true);
  assert.equal(await check("sam", fetchFor({ permission: "write" })), true);
  assert.equal(await check("sam", fetchFor({ permission: "read", role_name: "maintain" })), true);
  assert.equal(await check("sam", fetchFor({ permission: "read", role_name: "triage" })), false);
  assert.equal(await check("sam", fetchFor(null)), false);
  assert.equal(await isGitHubRepoWriter({ roomName: "github.com/acme/app", login: "sam", accessToken: "", fetchImpl: fetchFor({ permission: "write" }) }), false);
});

test("a fresh check during a GitHub outage keeps a known collaborator in and asks a stranger to retry", async () => {
  const room = `github.com/acme/outage-${Date.now()}`;
  let outage = false;
  globalThis.fetch = (async (_input, init) => {
    if (outage) return jsonResponse(503, { message: "unavailable" });
    const token = new Headers(init?.headers).get("authorization");
    const triage = token === "Bearer collab-token";
    return jsonResponse(200, { private: false, owner: { login: "acme" }, permissions: { pull: true, triage } });
  }) as typeof fetch;
  const collaborator = { provider: "github", provider_access_token: "collab-token", login: "collab" };
  const stranger = { provider: "github", provider_access_token: "stranger-token", login: "stranger" };

  assert.deepEqual(await resolveGitHubRepoRoomAccessDecision({ roomName: room, sessionAccount: collaborator }), { kind: "allow" });
  outage = true;
  assert.deepEqual(
    await resolveGitHubRepoRoomAccessDecision({ roomName: room, sessionAccount: collaborator, freshCollaboratorCheck: true }),
    { kind: "allow" },
    "the repository was public and the person had a role an hour ago: the stream stays open",
  );
  assert.deepEqual(
    await resolveGitHubRepoRoomAccessDecision({ roomName: room, sessionAccount: stranger, freshCollaboratorCheck: true }),
    { kind: "repo_access_unavailable" },
    "an unanswered check is a retry, not 'private repo, no access'",
  );
});
