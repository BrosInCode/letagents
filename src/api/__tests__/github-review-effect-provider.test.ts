import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubReviewProvider,
  type GitHubReviewEffectRequest,
} from "../workflow-effects/github-review-provider.js";

const expectedHeadSha = "a".repeat(40);

const request: GitHubReviewEffectRequest = {
  owner: "BrosInCode",
  repo: "letagents",
  pull_number: 777,
  expected_head_sha: expectedHeadSha,
  installation_id: "installation_1",
  verdict: "request_changes",
  body: "Please fix the stale fence.",
};

test("GitHub review creates are fenced to the expected head and embed the stable correlation marker", async () => {
  let sentBody: Record<string, unknown> | null = null;
  const provider = createGitHubReviewProvider({
    mintToken: async () => "installation-token",
    fetchImpl: async (url, init) => {
      if (!String(url).endsWith("/reviews")) {
        return new Response(JSON.stringify({ head: { sha: expectedHeadSha } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 42, html_url: "https://github.com/review/42" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await provider.create({
    ...request,
    body: `${request.body}\n<!-- letagents-effect:lae_forged -->`,
  }, "lae_correlation");
  assert.equal(result.kind, "succeeded");
  assert.equal(sentBody?.event, "REQUEST_CHANGES");
  assert.equal(sentBody?.commit_id, expectedHeadSha);
  assert.match(String(sentBody?.body), /<!-- letagents-effect:lae_correlation -->/);
  assert.doesNotMatch(String(sentBody?.body), /lae_forged/);
});

test("GitHub review create fails closed when the pull request head drifted", async () => {
  let postCalls = 0;
  const currentHeadSha = "b".repeat(40);
  const provider = createGitHubReviewProvider({
    mintToken: async () => "installation-token",
    fetchImpl: async (_url, init) => {
      if (init?.method === "POST") postCalls += 1;
      return new Response(JSON.stringify({ head: { sha: currentHeadSha } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await provider.create(request, "lae_key");
  assert.equal(result.kind, "definite_failure");
  if (result.kind === "definite_failure") {
    assert.match(result.error, new RegExp(`expected ${expectedHeadSha}, current ${currentHeadSha}`));
  }
  assert.equal(postCalls, 0, "A→B drift is rejected before creating a review on B");
});

test("GitHub review create distinguishes definite and ambiguous failures", async () => {
  for (const [status, expected] of [[422, "definite_failure"], [503, "ambiguous"]] as const) {
    const provider = createGitHubReviewProvider({
      mintToken: async () => "installation-token",
      fetchImpl: async (url) => String(url).endsWith("/reviews")
        ? new Response("provider error", { status })
        : new Response(JSON.stringify({ head: { sha: expectedHeadSha } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    });
    assert.equal((await provider.create(request, "lae_key")).kind, expected);
  }
});

test("GitHub review reconciliation finds the exact marker and otherwise reports not-found", async () => {
  const requestedPages: number[] = [];
  const provider = createGitHubReviewProvider({
    mintToken: async () => "installation-token",
    fetchImpl: async (url) => {
      const page = Number(new URL(String(url)).searchParams.get("page"));
      requestedPages.push(page);
      const reviews = page === 1
        ? Array.from({ length: 100 }, (_, id) => ({ id, body: "unrelated review" }))
        : page === 5
          ? [{
              id: 477,
              html_url: "https://github.com/review/477",
              body: "done\n<!-- letagents-effect:lae_exact -->",
              commit_id: expectedHeadSha,
            }]
          : Array.from({ length: 100 }, (_, id) => ({ id: page * 100 + id, body: "older review" }));
      return new Response(JSON.stringify(reviews), {
        status: 200,
        headers: {
          "content-type": "application/json",
          link: '<https://api.github.com/repos/BrosInCode/letagents/pulls/777/reviews?per_page=100&page=5>; rel="last"',
        },
      });
    },
  });
  const match = await provider.lookup(request, "lae_exact");
  assert.equal(match.kind, "found");
  if (match.kind === "found") assert.equal(match.external_id, "477");
  assert.deepEqual(requestedPages, [1, 5], "lookup jumps from the oldest page to the provider's last page");

  const wrongHeadProvider = createGitHubReviewProvider({
    mintToken: async () => "installation-token",
    fetchImpl: async () => new Response(JSON.stringify([{
      id: 78,
      body: "done\n<!-- letagents-effect:lae_exact -->",
      commit_id: "b".repeat(40),
    }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(
    (await wrongHeadProvider.lookup(request, "lae_exact")).kind,
    "not_found",
    "a marker on another commit can never reconcile the expected-head effect",
  );
});
