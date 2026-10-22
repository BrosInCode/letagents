import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubKeyDetector,
  createLinearKeyDetector,
  detectKeysInBranch,
  detectKeysInMessage,
  detectKeysInPullRequest,
  detectTicketKeys,
  linearTeamKeyOf,
  normalizeExternalRef,
  parseExternalRef,
  parseGitHubIssueKey,
} from "../connectors/key-detectors.js";
import { validateTaskWorkflowArtifactsInput } from "../repo-workflow.js";

// The mention writer's module opens a pool lazily; these tests never query it.
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  getCachedRoomExternalRefScope,
  invalidateRoomExternalRefScope,
  peekRoomExternalRefScope,
  recordTaskMentionsForMessage,
} = await import("../db/task-external-refs.js");
const { repositoryOfPullRequestUrl } = await import("../connectors/key-task-resolution.js");

test("Jira keys are found in the usual branch forms", () => {
  assert.deepEqual(detectTicketKeys("jira", "feature/HT-12-x"), ["HT-12"]);
  assert.deepEqual(detectTicketKeys("jira", "HT-12"), ["HT-12"]);
  assert.deepEqual(detectTicketKeys("jira", "x-HT-12-y"), ["HT-12"]);
  assert.deepEqual(detectTicketKeys("jira", "HT-1234-proration"), ["HT-1234"]);
  assert.deepEqual(detectTicketKeys("jira", "fix HT2-7_and_more"), ["HT2-7"]);
});

test("lowercase keys, glued words and one-letter prefixes are not Jira keys", () => {
  assert.deepEqual(detectTicketKeys("jira", "feature/ht-12-x"), []);
  assert.deepEqual(detectTicketKeys("jira", "xHT-12"), []);
  assert.deepEqual(detectTicketKeys("jira", "HT-12b"), []);
  assert.deepEqual(detectTicketKeys("jira", "A-12"), []);
});

test("technical names shaped like keys are not tickets", () => {
  assert.deepEqual(detectTicketKeys("jira", "Save the file as UTF-8 and hash with SHA-256."), []);
  assert.deepEqual(detectTicketKeys("jira", "UTF-16, ISO-8859, AES-128, CVE-2024, RFC-9110, GPT-4"), []);
  assert.deepEqual(detectTicketKeys("jira", "UTF-8 output fixes HT-9"), ["HT-9"]);
});

test("a key named twice is returned once, in order of first appearance", () => {
  assert.deepEqual(detectTicketKeys("jira", "HT-2 then AB-1 then HT-2"), ["HT-2", "AB-1"]);
});

test("Linear matches only known team keys, and nothing without them", () => {
  assert.deepEqual(detectTicketKeys("linear", "ENG-12 and OPS-3"), []);
  assert.deepEqual(createLinearKeyDetector([])("ENG-12"), []);
  assert.deepEqual(detectTicketKeys("linear", "ENG-12 and OPS-3 and E-4", { linearTeamKeys: ["eng", "E"] }), ["ENG-12", "E-4"]);
});

test("pull request detection reads branch, title and body as refs", () => {
  assert.deepEqual(
    detectKeysInPullRequest({ headRef: "refs/heads/HT-1234-proration", title: "Proration (AB-5)", body: "Also UTF-8 and HT-77." })
      .map((match) => match.ref),
    ["jira:HT-1234", "jira:AB-5"],
  );
  assert.deepEqual(detectKeysInBranch("main"), []);
  assert.deepEqual(
    detectKeysInMessage("ENG-7 is blocked", { linearTeamKeys: ["ENG"] }).map((match) => match.ref),
    ["jira:ENG-7", "linear:ENG-7"],
  );
});

test("a PR body links only in closing-keyword form", () => {
  const refs = (body: string) => detectKeysInPullRequest({ body }).map((match) => match.ref);
  assert.deepEqual(refs("Follow-up to HT-5, see also AB-1."), []);
  assert.deepEqual(refs("Fixes HT-6\n- closes: AB-7.\n(Resolves CD-9)"), ["jira:HT-6", "jira:AB-7", "jira:CD-9"]);
  assert.deepEqual(refs("FIXES HT-6 and HT-7"), ["jira:HT-6"], "one key per line, right after the keyword");
  assert.deepEqual(refs("resolves ht-8"), [], "the key itself stays upper case");
  assert.deepEqual(detectKeysInPullRequest({ title: "follow-up to HT-5" }).map((match) => match.ref), ["jira:HT-5"],
    "the title counts in any form");
});

test("typed external refs are normalized or rejected", () => {
  assert.equal(normalizeExternalRef("HT-1234"), "jira:HT-1234");
  assert.equal(normalizeExternalRef(" Jira:ht-1234 "), "jira:HT-1234");
  assert.equal(normalizeExternalRef("linear:eng-12"), "linear:ENG-12");
  assert.equal(normalizeExternalRef("linear:E-1"), "linear:E-1");
  assert.equal(normalizeExternalRef("jira:E-1"), null);
  assert.equal(normalizeExternalRef("github:HT-1"), null);
  assert.equal(normalizeExternalRef("HT 1234"), null);
  assert.equal(normalizeExternalRef(""), null);
  assert.equal(linearTeamKeyOf("linear:ENG-12"), "ENG");
  assert.equal(linearTeamKeyOf("jira:HT-1"), null);
});

test("GitHub keys match only repositories the room's filter names", () => {
  const repos = ["BrosInCode/letagents"];
  assert.deepEqual(detectTicketKeys("github", "See #123 and brosincode/letagents#7.", { githubRepos: repos }),
    ["brosincode/letagents#123", "brosincode/letagents#7"]);
  assert.deepEqual(detectTicketKeys("github", "Fixes #123"), [], "no filter names a repository: nothing matches");
  assert.deepEqual(detectTicketKeys("github", "acme/api#5 and other/repo#9", { githubRepos: repos }), [],
    "a repository the filter does not name never matches, even written in full");
  assert.deepEqual(detectTicketKeys("github", "acme/api#5", { githubRepos: [...repos, "acme/api"] }), ["acme/api#5"]);
});

test("a bare #123 names the pull request's repository, or the only filtered one", () => {
  const two = ["brosincode/letagents", "acme/api"];
  assert.deepEqual(detectTicketKeys("github", "#12", { githubRepos: two }), [], "two repositories and no default: ambiguous");
  assert.deepEqual(detectTicketKeys("github", "#12", { githubRepos: two, githubDefaultRepo: "Acme/API" }), ["acme/api#12"]);
  assert.deepEqual(detectTicketKeys("github", "#12", { githubRepos: ["brosincode/letagents"], githubDefaultRepo: "acme/api" }),
    ["brosincode/letagents#12"], "a default outside the filter is ignored");
  assert.equal(repositoryOfPullRequestUrl("https://github.com/BrosInCode/letagents/pull/1729"), "brosincode/letagents");
  assert.equal(repositoryOfPullRequestUrl("https://example.com/x/y/pull/1"), null);
});

test("GitHub keys are not read inside words, paths, URLs or HTML entities", () => {
  const detect = createGitHubKeyDetector(["brosincode/letagents"]);
  assert.deepEqual(detect("abc#12 x/#12 &#123; https://github.com/brosincode/letagents#12 #0 #12a"), []);
  assert.deepEqual(detect("(#12) and \"#13\", #12 again"), ["brosincode/letagents#12", "brosincode/letagents#13"]);
  assert.deepEqual(createGitHubKeyDetector([])("#12"), []);
});

test("pull requests link GitHub issues by branch, title, or a closing keyword in the body", () => {
  const options = { githubRepos: ["brosincode/letagents"], githubDefaultRepo: "brosincode/letagents" };
  assert.deepEqual(detectKeysInPullRequest({ body: "Fixes #123\nCloses brosincode/letagents#124\nfollow-up to #125" }, options)
    .map((match) => match.ref), ["github:brosincode/letagents#123", "github:brosincode/letagents#124"]);
  assert.deepEqual(detectKeysInPullRequest({ title: "Connectors page (#41)", body: "Resolves HT-9" }, options).map((match) => match.ref),
    ["jira:HT-9", "github:brosincode/letagents#41"]);
  assert.deepEqual(detectKeysInMessage("Fixes #123", {}), [], "a room whose filter names no repository links nothing");
});

test("GitHub refs normalize to lower case and keep their form", () => {
  assert.equal(normalizeExternalRef("github:BrosInCode/LetAgents#12"), "github:brosincode/letagents#12");
  assert.equal(normalizeExternalRef(" github: acme/api.v2#3 "), "github:acme/api.v2#3");
  assert.equal(normalizeExternalRef("github:#12"), null);
  assert.equal(normalizeExternalRef("github:acme/api#0"), null);
  assert.equal(normalizeExternalRef("github:acme/api.git#3"), null);
  assert.equal(normalizeExternalRef("#12"), null, "a bare number has no repository and is not a Jira key");
  const long = `github:${"a".repeat(39)}/${"b".repeat(100)}#123456789`;
  assert.equal(normalizeExternalRef(long), long, "the longest GitHub ref fits");
  assert.deepEqual(parseExternalRef("github:acme/api#3"), { provider: "github", key: "acme/api#3", ref: "github:acme/api#3" });
  assert.deepEqual(parseGitHubIssueKey("Acme/Api#3"), { repo: "acme/api", number: 3 });
});

test("a room with no external refs runs no detector on messages", async () => {
  let detectorRuns = 0;
  let queries = 0;
  const executor = {
    select: () => { queries += 1; throw new Error("no card query expected"); },
    execute: () => { throw new Error("the scope probe is injected"); },
    insert: () => { throw new Error("no mention write expected"); },
  } as unknown as Parameters<typeof recordTaskMentionsForMessage>[0];
  const recorded = await recordTaskMentionsForMessage(executor, "room-without-refs", { number: 1, text: "HT-1234 is done" }, {
    getScope: async () => ({ hasExternalRefs: false, detectorOptions: {} }),
    detect: () => { detectorRuns += 1; return []; },
  });
  assert.equal(recorded, 0);
  assert.equal(detectorRuns, 0);
  assert.equal(queries, 0);
});

test("a client cannot mark an artifact as key-linked, but may echo one it read", () => {
  const [artifact] = validateTaskWorkflowArtifactsInput([
    { provider: "github", kind: "pull_request", url: "https://github.com/o/r/pull/1", linked_by: "ticket_key" },
  ])!;
  assert.equal("linked_by" in artifact!, false);
});

test("a scope read that races a ticket write is not cached", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const executor = {
    execute: async () => { await gate; return { rows: [] }; },
  } as unknown as Parameters<typeof getCachedRoomExternalRefScope>[1];
  const read = getCachedRoomExternalRefScope("race-room", executor);
  invalidateRoomExternalRefScope("race-room"); // a card got a key while the probe ran
  release();
  assert.equal((await read).hasExternalRefs, false);
  assert.equal(peekRoomExternalRefScope("race-room"), undefined, "the stale read is not cached");

  const fresh = await getCachedRoomExternalRefScope("race-room", { execute: async () => ({ rows: [] }) } as never);
  assert.equal(fresh.hasExternalRefs, false);
  assert.equal(peekRoomExternalRefScope("race-room")?.hasExternalRefs, false, "an undisturbed read is cached");
});
