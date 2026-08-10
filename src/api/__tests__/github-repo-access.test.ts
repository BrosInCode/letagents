import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  clearGitHubRepoAccessCacheForLogin,
  clearGitHubRepoAccessCacheForRoom,
  getGitHubRepoVisibility,
  isGitHubRepoCollaborator,
  resolveGitHubRepoRoomAccessDecision,
} from "../github/repo-access.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("resolveGitHubRepoRoomAccessDecision allows anonymous access to public GitHub repo rooms", async () => {
  const decision = await resolveGitHubRepoRoomAccessDecision(
    {
      roomName: "github.com/brosincode/letagents",
      sessionAccount: null,
    },
    {
      getVisibility: async () => "public",
      isCollaborator: async () => false,
    }
  );

  assert.deepEqual(decision, { kind: "allow" });
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
  assert.equal(calls, 3, "fresh access performs anonymous discovery plus authenticated refinement");
});

test("a fresh room decision bypasses both visibility and collaborator caches", async () => {
  let visibilityBypassed = false;
  let collaboratorBypassed = false;
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
        return true;
      },
    },
  );

  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(visibilityBypassed, true);
  assert.equal(collaboratorBypassed, true);
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
