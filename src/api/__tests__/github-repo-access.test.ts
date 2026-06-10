import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
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
