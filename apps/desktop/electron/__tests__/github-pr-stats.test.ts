import assert from "node:assert/strict";
import { promisify } from "node:util";
import test from "node:test";

import "./isolated-home.js";

test("pull request stats reuse the gh token and one answer per pull request, then revalidate with the ETag", async (t) => {
  const tokenCalls: string[][] = [];
  let tokenFails = false;
  const execute = async (command: string, args: string[]) => {
    assert.equal(command, "gh");
    tokenCalls.push(args);
    if (tokenFails) throw new Error("not logged in");
    return { stdout: "gho_test_token\n", stderr: "" };
  };
  t.mock.module("node:child_process", { namedExports: { execFile: Object.assign(
    () => { throw new Error("Use the promisified command runner"); }, { [promisify.custom]: execute },
  ) } });
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  let nextStatus = 200;
  let additions = 5;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    requests.push({ url, headers: init.headers });
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (nextStatus === 304) return new Response(null, { status: 304 });
    if (nextStatus !== 200) return new Response("{}", { status: nextStatus });
    return new Response(JSON.stringify({
      number: 7, title: "Title", state: "open", html_url: "https://github.com/acme/widgets/pull/7",
      base: { ref: "staging" }, head: { ref: "feature" }, changed_files: 2, additions, deletions: 1,
    }), { status: 200, headers: { etag: `"etag-${additions}"` } });
  }) as typeof fetch;
  const now = Date.now();
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  try {
    const subject = await import(new URL("../main/github-pr-stats.js?cache-test", import.meta.url).href);
    const url = "https://github.com/acme/widgets/pull/7";
    // Before this cache: every call spawned `gh auth token` and sent one GET.
    const concurrent = await Promise.all([1, 2, 3].map(() => subject.getGitHubPullRequestStats(url)));
    assert.equal(concurrent[0].additions, 5);
    assert.deepEqual(concurrent[1], concurrent[0]);
    assert.equal(tokenCalls.length, 1, "concurrent calls share one gh spawn");
    assert.equal(requests.length, 1, "concurrent calls share one request");
    assert.equal(requests[0]!.headers.Authorization, "Bearer gho_test_token");
    concurrent[0].additions = 999;
    assert.equal((await subject.getGitHubPullRequestStats(url)).additions, 5, "callers get copies");
    assert.equal(requests.length, 1, "a fresh answer is reused");

    clock = now + 46_000;
    nextStatus = 304;
    assert.equal((await subject.getGitHubPullRequestStats(url)).additions, 5);
    assert.equal(requests.length, 2, "an expired answer is revalidated");
    assert.equal(requests[1]!.headers["If-None-Match"], '"etag-5"');
    assert.equal(tokenCalls.length, 1, "the token is reused for five minutes");

    clock = now + 92_000;
    nextStatus = 200;
    additions = 9;
    assert.equal((await subject.getGitHubPullRequestStats(url)).additions, 9, "a changed pull request replaces the answer");

    clock = now + 6 * 60_000;
    nextStatus = 401;
    assert.equal(await subject.getGitHubPullRequestStats(url), null);
    assert.equal(tokenCalls.length, 2, "an expired token is read again");
    nextStatus = 200;
    assert.equal((await subject.getGitHubPullRequestStats(url)).additions, 9);
    assert.equal(tokenCalls.length, 3, "a rejected token is forgotten at once");
    assert.equal(requests.at(-1)!.headers["If-None-Match"], undefined, "a failure drops the stale ETag");

    subject.clearGitHubPullRequestStatsCacheForTest();
    tokenFails = true;
    await subject.getGitHubPullRequestStats(url);
    subject.clearGitHubPullRequestStatsCacheForTest();
    await subject.getGitHubPullRequestStats(url);
    assert.equal(tokenCalls.length, 5, "a missing login is never cached");
    assert.equal(requests.at(-1)!.headers.Authorization, undefined);
  } finally {
    globalThis.fetch = priorFetch;
  }
});
