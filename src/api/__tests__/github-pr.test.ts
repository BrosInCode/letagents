/**
 * Tests for GitHub App PR handoff.
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import type { RentalGitHubPrDeps } from "../rental/github-pr.js";

const { openRentalPatchPullRequest } = await import("../rental/github-pr.js");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("openRentalPatchPullRequest creates a patch commit branch before opening the PR", async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs1" })
    .toString();
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(url), body });

    if (String(url).endsWith("/app/installations/inst_1/access_tokens")) {
      return jsonResponse({ token: "install-token" });
    }
    if (String(url).endsWith("/git/ref/heads/staging")) {
      return jsonResponse({ object: { sha: "basecommit" } });
    }
    if (String(url).endsWith("/git/commits/basecommit")) {
      return jsonResponse({ sha: "basecommit", tree: { sha: "basetree" } });
    }
    if (String(url).endsWith("/git/trees")) {
      assert.deepEqual(body, {
        base_tree: "basetree",
        tree: [
          {
            path: "src/index.ts",
            mode: "100644",
            type: "blob",
            content: "patched\n",
          },
          {
            path: "src/remove.ts",
            mode: "100644",
            type: "blob",
            sha: null,
          },
        ],
      });
      return jsonResponse({ sha: "newtree" });
    }
    if (String(url).endsWith("/git/commits") && method === "POST") {
      assert.deepEqual(body, {
        message: "rental: apply patch",
        tree: "newtree",
        parents: ["basecommit"],
      });
      return jsonResponse({ sha: "newcommit" });
    }
    if (String(url).endsWith("/git/ref/heads/rental/rsess_1")) {
      return jsonResponse({ message: "Not Found" }, 404);
    }
    if (String(url).endsWith("/git/refs")) {
      assert.deepEqual(body, {
        ref: "refs/heads/rental/rsess_1",
        sha: "newcommit",
      });
      return jsonResponse({ ref: "refs/heads/rental/rsess_1", object: { sha: "newcommit" } });
    }
    if (String(url).endsWith("/pulls")) {
      assert.deepEqual(body, {
        title: "Rental patch",
        head: "rental/rsess_1",
        base: "staging",
        body: "approved",
        draft: false,
      });
      return jsonResponse({
        number: 42,
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        title: "Rental patch",
        head: { ref: "rental/rsess_1" },
        base: { ref: "staging" },
      });
    }

    return jsonResponse({ message: `Unexpected ${method} ${url}` }, 500);
  };

  const deps: RentalGitHubPrDeps = {
    getConfig: async () => ({
      appId: "123",
      appSlug: "letagents-test",
      clientId: "client-id",
      clientSecret: "client-secret",
      privateKey,
      webhookSecret: "secret",
      baseUrl: "https://letagents.chat",
      callbackUrl: "https://letagents.chat/auth/github/app/callback",
      setupUrl: "https://letagents.chat/auth/github/app/callback",
    }),
    getRepositoryByFullName: async () => ({
      github_repo_id: "repo_1",
      installation_id: "inst_1",
      owner_login: "BrosInCode",
      repo_name: "letagents",
      full_name: "BrosInCode/letagents",
      room_id: "focus_24",
      removed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    getInstallationById: async () => ({
      installation_id: "inst_1",
      target_type: "Organization",
      target_login: "BrosInCode",
      target_github_id: "1234",
      repository_selection: "selected",
      permissions_json: null,
      suspended_at: null,
      uninstalled_at: null,
      last_synced_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    fetchImpl,
  };

  const result = await openRentalPatchPullRequest({
    repoProvider: "github",
    repoOwner: "BrosInCode",
    repoName: "letagents",
    baseBranch: "staging",
    workBranch: "rental/rsess_1",
    patchFiles: [
      { path: "./src/index.ts", operation: "modify", content: "patched\n" },
      { path: "src/remove.ts", operation: "delete" },
    ],
    commitMessage: "rental: apply patch",
    title: "Rental patch",
    body: "approved",
  }, deps);

  assert.equal(result.number, 42);
  assert.equal(result.commitSha, "newcommit");
  assert.equal(calls.some((call) => call.url.endsWith("/git/refs")), true);
  assert.equal(calls.at(-1)?.url.endsWith("/pulls"), true);
});
