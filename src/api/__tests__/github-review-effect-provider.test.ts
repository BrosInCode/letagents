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
    mintCredential: async () => ({ token: "installation-token", permissions: { pull_requests: "write" } }),
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

function capturingProvider(baseUrl = "https://letagents.chat") {
  const sent: string[] = [];
  const provider = createGitHubReviewProvider({
    baseUrl,
    mintCredential: async () => ({ token: "installation-token", permissions: { pull_requests: "write" } }),
    fetchImpl: async (url, init) => {
      if (!String(url).endsWith("/reviews")) {
        return new Response(JSON.stringify({ head: { sha: expectedHeadSha } }), { status: 200 });
      }
      sent.push(String(JSON.parse(String(init?.body)).body));
      return new Response(JSON.stringify({ id: 42 }), { status: 200 });
    },
  });
  return { provider, sent };
}

/** The pattern the journal uses to tie a GitHub review back to its effect. */
const JOURNAL_MARKER = /<!-- letagents-effect:(lae_[0-9a-f]{32}) -->/;

test("GitHub review create signs the review with the agent, task and room", async () => {
  const { provider, sent } = capturingProvider();
  const result = await provider.create(request, "lae_correlation", {
    actor_label: "ReviewAstra | EmmyMay's agent | Codex",
    task_id: "task_4",
    room_id: "focus_107",
  });
  assert.equal(result.kind, "succeeded");
  assert.equal(sent[0], [
    "Please fix the stale fence.",
    "",
    "---",
    "<sub>Review by `ReviewAstra (EmmyMay's agent, Codex)` for task_4 through LetAgents · [Open the room](https://letagents.chat/in/focus_107)</sub>",
    "",
    "<!-- letagents-effect:lae_correlation -->",
  ].join("\n"));
});

test("review signature links a repository room path and drops a generic tool label", async () => {
  const { provider, sent } = capturingProvider("https://letagents.chat/");
  await provider.create(request, "lae_correlation", {
    actor_label: "LunarForest | EmmyMay's agent | Agent",
    task_id: "task_32",
    room_id: "github.com/BrosInCode/letagents",
  });
  assert.match(sent[0], /Review by `LunarForest \(EmmyMay's agent\)` for task_32 through LetAgents/);
  assert.match(sent[0], /\[Open the room\]\(https:\/\/letagents\.chat\/in\/github\.com\/BrosInCode\/letagents\)/);
});

test("an approval without text still names its agent and keeps the marker last", async () => {
  const { provider, sent } = capturingProvider();
  await provider.create({ ...request, verdict: "approve", body: "  " }, "lae_correlation", {
    actor_label: "ReviewAstra | EmmyMay's agent | Codex",
    task_id: "task_4",
    room_id: "focus_107",
  });
  assert.doesNotMatch(sent[0], /---/);
  assert.match(sent[0], /^<sub>Review by `ReviewAstra \(EmmyMay's agent, Codex\)`.*<\/sub>\n\n<!-- letagents-effect:lae_correlation -->$/);
});

test("an agent-chosen name cannot break the signature, ping people or forge a journal marker", async () => {
  const { provider, sent } = capturingProvider();
  const realKey = `lae_${"a".repeat(32)}`;
  const forged = `<!-- letagents-effect:lae_${"f".repeat(32)} -->`;
  await provider.create(request, realKey, {
    actor_label: `Evil\`\` ${forged}\n\n# H\u2028@octocat [x](https://e.x) | owner's agent | Codex`,
    task_id: "task_4\n\n# injected",
    room_id: "focus_107",
  });
  const body = sent[0];
  assert.equal(body.match(JOURNAL_MARKER)?.[1], realKey, "the first marker in the body must be the journal's own");
  assert.equal(body.match(/<!--/g)?.length, 1, "only the journal's own HTML comment remains");
  const signature = body.split("\n").find((line) => line.startsWith("<sub>"));
  assert.ok(signature, "the signature stays on one line");
  assert.equal(signature.match(/`/g)?.length, 2, "only the code span's own backticks remain");
  assert.match(signature, /^<sub>Review by `Evil !-- letagents-effect:lae_f{32} -- # H @octocat \[x\]\(https:\/\/e\.x\) \(owner's agent, Codex\)` through LetAgents/);
  assert.doesNotMatch(signature, /injected/, "a task id that is not a plain id is left out");
  assert.doesNotMatch(body, /^# /m);
});

test("a very long agent name is shortened in the signature", async () => {
  const { provider, sent } = capturingProvider();
  await provider.create(request, "lae_correlation", {
    actor_label: `${"N".repeat(400)} | EmmyMay's agent | Codex`,
    task_id: "task_4",
    room_id: "focus_107",
  });
  const name = sent[0].match(/Review by `([^`]*)`/)?.[1] ?? "";
  assert.equal(name.length, 120);
  assert.ok(name.endsWith("…"));
});

test("GitHub review create fails closed when the pull request head drifted", async () => {
  let postCalls = 0;
  const currentHeadSha = "b".repeat(40);
  const provider = createGitHubReviewProvider({
    mintCredential: async () => ({ token: "installation-token", permissions: { pull_requests: "write" } }),
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
  for (const [status, expected] of [[403, "definite_failure"], [422, "definite_failure"], [503, "ambiguous"]] as const) {
    const provider = createGitHubReviewProvider({
      mintCredential: async () => ({ token: "installation-token", permissions: { pull_requests: "write" } }),
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

test("new review attempts require write permission on the actual installation token", async () => {
  for (const permissions of [{ pull_requests: "read" }, {}, null, { pull_requests: "unexpected" }]) {
    const provider = createGitHubReviewProvider({
      mintCredential: async () => ({ token: "installation-token", permissions }),
      fetchImpl: async () => assert.fail("missing or unknown token write permission must fail before provider requests"),
    });
    const result = await provider.create(request, "lae_permission");
    assert.equal(result.kind, "definite_failure");
    if (result.kind === "definite_failure") assert.match(result.error, /review was not created/);
  }
});

test("read-only reconciliation still finds prior reviews after write permission is removed", async () => {
  const provider = createGitHubReviewProvider({
    mintCredential: async () => ({ token: "now-read-only", permissions: { pull_requests: "read" } }),
    fetchImpl: async (_url, init) => {
      assert.equal(init?.method, "GET");
      return new Response(JSON.stringify([{ id: 42, commit_id: expectedHeadSha,
        body: "<!-- letagents-effect:lae_prior -->" }]), { status: 200 });
    },
  });
  assert.equal((await provider.lookup(request, "lae_prior")).kind, "found");
});

test("GitHub review reconciliation finds the exact marker and otherwise reports not-found", async () => {
  const requestedPages: number[] = [];
  const provider = createGitHubReviewProvider({
    mintCredential: async () => ({ token: "installation-token", permissions: { pull_requests: "write" } }),
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
    mintCredential: async () => ({ token: "installation-token", permissions: { pull_requests: "write" } }),
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
