import assert from "node:assert/strict";
import test from "node:test";

import {
  createLinearKeyDetector,
  detectKeysInBranch,
  detectKeysInMessage,
  detectKeysInPullRequest,
  detectTicketKeys,
  linearTeamKeyOf,
  normalizeExternalRef,
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
