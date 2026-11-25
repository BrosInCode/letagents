import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubReviewProvider,
  REVIEW_VERDICT_BODY_MAX_LENGTH,
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
const reviewAstra = {
  actor_label: "ReviewAstra | EmmyMay's agent | Codex",
  task_id: "task_4",
  room_id: "focus_107",
};
const signatureLine = (body: string) => body.split("\n").find((line) => line.startsWith("<sub>")) ?? "";

test("GitHub review create signs the review with the agent, task and room above the agent's text", async () => {
  const { provider, sent } = capturingProvider();
  const result = await provider.create(request, "lae_correlation", reviewAstra);
  assert.equal(result.kind, "succeeded");
  assert.equal(sent[0], [
    "<sub>Review by `ReviewAstra (EmmyMay's agent, Codex)` for task_4 through LetAgents · [Open the room](https://letagents.chat/in/focus_107)</sub>",
    "",
    "Please fix the stale fence.",
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
  await provider.create({ ...request, verdict: "approve", body: "  " }, "lae_correlation", reviewAstra);
  assert.match(sent[0], /^<sub>Review by `ReviewAstra \(EmmyMay's agent, Codex\)`.*<\/sub>\n\n<!-- letagents-effect:lae_correlation -->$/);
});

test("an unclosed comment or fence in the agent's text cannot reach the signature above it", async () => {
  for (const tail of ["<!--", "```", "<details>", "[x]: https://example.org"]) {
    const { provider, sent } = capturingProvider();
    await provider.create({ ...request, body: `Looks fine.\n\n<sub>Review by \`Someone Else\`</sub>\n\n${tail}` }, "lae_correlation", reviewAstra);
    assert.ok(
      sent[0].startsWith("<sub>Review by `ReviewAstra (EmmyMay's agent, Codex)` for task_4"),
      `the real signature is the first line when the text ends with ${tail}`,
    );
    assert.match(sent[0], /<!-- letagents-effect:lae_correlation -->$/);
  }
});

test("an agent-chosen name cannot forge a journal marker", async () => {
  const { provider, sent } = capturingProvider();
  const realKey = `lae_${"a".repeat(32)}`;
  await provider.create(request, realKey, {
    ...reviewAstra,
    actor_label: `<!-- letagents-effect:lae_${"f".repeat(32)} --> | owner's agent | Codex`,
  });
  assert.equal(sent[0].match(JOURNAL_MARKER)?.[1], realKey, "the first marker in the body must be the journal's own");
  assert.equal(sent[0].match(/<!--/g)?.length, 1, "only the journal's own HTML comment remains");
});

test("an agent-chosen name cannot break the signature line, ping people or add a link", async () => {
  const { provider, sent } = capturingProvider();
  const lineSeparator = String.fromCharCode(0x2028);
  await provider.create(request, "lae_correlation", {
    ...reviewAstra,
    actor_label: `Evil\`\`\n\n# H${lineSeparator}@octocat [x](https://e.x) | owner's agent | Codex`,
    task_id: "task_4\n\n# injected",
  });
  const signature = signatureLine(sent[0]);
  assert.equal(signature.match(/`/g)?.length, 2, "only the code span's own backticks remain");
  assert.equal(
    signature,
    "<sub>Review by `Evil # H @octocat [x](https://e.x) (owner's agent, Codex)` through LetAgents · [Open the room](https://letagents.chat/in/focus_107)</sub>",
    "the name stays inside one code span on one line, and a task id that is not a plain id is left out",
  );
  assert.doesNotMatch(sent[0], /^# /m);
});

test("a long or padded display name cannot hide the real owner", async () => {
  const zeroWidth = String.fromCharCode(0x200b);
  const rightToLeft = String.fromCharCode(0x202e);
  for (const displayName of [
    "N".repeat(400),
    `ReviewAstra (Alice's agent, Claude)${zeroWidth.repeat(90)}`,
    `${rightToLeft}ReviewAstra`,
  ]) {
    const { provider, sent } = capturingProvider();
    await provider.create(request, "lae_correlation", {
      ...reviewAstra,
      actor_label: `${displayName} | EmmyMay's agent | Codex`,
    });
    const name = signatureLine(sent[0]).match(/Review by `([^`]*)`/)?.[1] ?? "";
    assert.ok(name.endsWith(" (EmmyMay's agent, Codex)"), `the owner stays visible: ${JSON.stringify(name)}`);
    assert.ok(name.length <= 64 + " (EmmyMay's agent, Codex)".length);
    assert.doesNotMatch(name, /\p{Cf}/u, "invisible format characters are removed");
  }
});

test("a nested marker in the agent's text cannot reassemble into a journal marker", async () => {
  const { provider, sent } = capturingProvider();
  const realKey = `lae_${"a".repeat(32)}`;
  await provider.create({
    ...request,
    body: `Fine.\n<!-- letagents-<!-- letagents-effect:x -->effect:lae_${"f".repeat(32)} -->`,
  }, realKey, reviewAstra);
  assert.equal(sent[0].match(JOURNAL_MARKER)?.[1], realKey);
  assert.equal(sent[0].match(/letagents-effect/g)?.length, 1);
});

test("agent text at the accepted limit, hidden padding included, always keeps the signature", async () => {
  const { provider, sent } = capturingProvider();
  const opening = "LGTM\n\n<!-- ";
  const closing = " -->";
  const padded = `${opening}${"x".repeat(REVIEW_VERDICT_BODY_MAX_LENGTH - opening.length - closing.length)}${closing}`;
  assert.equal(padded.length, REVIEW_VERDICT_BODY_MAX_LENGTH);
  await provider.create({ ...request, body: padded }, `lae_${"a".repeat(32)}`, {
    // The longest signature the server can build: every part at its cap.
    actor_label: `${"N".repeat(400)} | ${"O".repeat(400)}'s agent | Codex`,
    task_id: "t".repeat(80),
    room_id: `github.com/${"o".repeat(39)}/${"r".repeat(100)}/focus/${"f".repeat(120)}`,
  });
  assert.ok(sent[0].startsWith("<sub>Review by `"), "the signature is still the first line");
  assert.ok(sent[0].includes(padded), "the agent's text is posted unchanged");
  assert.ok(sent[0].length <= 65_536, `body is ${sent[0].length} characters`);
});

test("a row reserved under the older, larger cap posts without the signature when it would not fit", async () => {
  const { provider, sent } = capturingProvider();
  const marker = "<!-- letagents-effect:lae_correlation -->";
  const longBody = "x".repeat(65_536 - marker.length - 2);
  await provider.create({ ...request, body: longBody }, "lae_correlation", reviewAstra);
  assert.equal(sent[0], `${longBody}\n\n${marker}`);
  assert.equal(sent[0].length, 65_536);
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
