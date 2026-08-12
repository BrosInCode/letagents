import assert from "node:assert/strict";
import test from "node:test";

import { isGitHubRepoCollaborator } from "../github/repo-access.js";

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

// Owner login matches the caller → allowed on the first (repo) call.
function allowFetch(login: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (String(url).includes("/collaborators/")) return new Response("no", { status: 403 });
    return jsonResponse({ owner: { login } });
  }) as typeof fetch;
}

// Owner differs and the permission check denies → not a collaborator.
function denyFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (String(url).includes("/collaborators/")) return new Response("forbidden", { status: 403 });
    return jsonResponse({ owner: { login: "someone-else" } });
  }) as typeof fetch;
}

test("bypassCache ignores a pre-cached allow when a fresh GitHub check denies", async () => {
  const roomName = "github.com/acme/bypass-regression";
  const login = "octocat";

  // 1. Populate the positive (30-min) access cache with an allow.
  assert.equal(
    await isGitHubRepoCollaborator({ roomName, login, accessToken: "t", fetchImpl: allowFetch(login) }),
    true,
  );

  // 2. Without bypass, a now-revoked collaborator is still allowed from cache.
  assert.equal(
    await isGitHubRepoCollaborator({ roomName, login, accessToken: "t", fetchImpl: denyFetch() }),
    true,
    "cached allow masks the live deny (expected 30-min window)",
  );

  // 3. With bypass, the live deny wins immediately — revocation-aware.
  assert.equal(
    await isGitHubRepoCollaborator({ roomName, login, accessToken: "t", fetchImpl: denyFetch(), bypassCache: true }),
    false,
    "bypassCache reflects live revocation, ignoring the cache",
  );
});
