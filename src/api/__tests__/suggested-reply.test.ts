import assert from "node:assert/strict";
import test from "node:test";

import {
  pickSuggestedReply,
  SuggestedReplyCache,
  suggestedReplyCandidates,
  type SuggestedReplyRow,
} from "../messages/suggested-reply.js";
import type { JevEndpoint } from "../messages/jev-conversation-routing.js";

const ME = "acct_me";
const SHANNON = "acct_shannon";
let next = 1;

function human(account: string, text: string, extra: Partial<SuggestedReplyRow> = {}): SuggestedReplyRow {
  return { number: next++, sender: account, text, source: "browser", publisher_agent_key: null, publisher_account_id: account,
    reply_to_number: null, suggested_reply: null, ...extra };
}

function agent(key: string, text: string, suggested: string | null, extra: Partial<SuggestedReplyRow> = {}): SuggestedReplyRow {
  return { number: next++, sender: key.toUpperCase(), text, source: "agent", publisher_agent_key: key, publisher_account_id: ME,
    reply_to_number: null, suggested_reply: suggested, ...extra };
}

const endpoint: JevEndpoint = { provider: "typesafe", apiKey: "test", baseUrl: "https://jev.test", model: "jev", timeoutMs: 1_000 };

test("an agent's suggestion after my last message is mine to see", () => {
  const rows = [human(ME, "Can you check CI?"), agent("codex", "CI is green. Merge it?", "Yes, merge it")];
  assert.deepEqual(suggestedReplyCandidates(rows, ME).map((candidate) => candidate.text), ["Yes, merge it"]);
});

test("once I speak, earlier suggestions are gone", () => {
  const rows = [human(ME, "Check CI"), agent("codex", "Green. Merge?", "Yes, merge it"), human(ME, "Merged, thanks")];
  assert.deepEqual(suggestedReplyCandidates(rows, ME), []);
});

test("my agent answering another person is not a suggestion for me", () => {
  const rows = [human(ME, "Morning"), human(SHANNON, "Which theme?"), agent("claude", "Option 2 or 3?", "Use option 2")];
  assert.deepEqual(suggestedReplyCandidates(rows, ME), []);
});

test("another person's agent never fills my composer, even when it answers me", () => {
  const mine = human(ME, "@Fern which build?");
  const rows = [mine, agent("fern", "Build 2 or 3?", "Build 3", { publisher_account_id: SHANNON, reply_to_number: mine.number })];
  assert.deepEqual(suggestedReplyCandidates(rows, ME), []);
  assert.deepEqual(suggestedReplyCandidates(rows, SHANNON), [], "nor Shannon's: it answers me");
});

test("a reply to my message counts even when someone else spoke after me", () => {
  const mine = human(ME, "Which build?");
  const rows = [mine, human(SHANNON, "lunch?"), agent("codex", "Build 2 or 3?", "Build 3", { reply_to_number: mine.number })];
  assert.equal(suggestedReplyCandidates(rows, ME)[0]?.text, "Build 3");
});

test("an agent's newest message decides: a later message without a suggestion clears its older one", () => {
  const rows = [human(ME, "Go"), agent("codex", "Merge?", "Yes"), agent("codex", "Done, merged it myself.", null)];
  assert.deepEqual(suggestedReplyCandidates(rows, ME), []);
});

test("with no person in the window, an agent's suggestion goes to its owner only", () => {
  // The first message to a new agent is private, so its answer opens the room.
  const rows = [agent("codex", "Mint or Coral?", "Let's go with Mint")];
  assert.equal(suggestedReplyCandidates(rows, ME)[0]?.text, "Let's go with Mint");
  assert.equal(suggestedReplyCandidates([agent("codex", "Hi", "Hello", { sender: "CanyonWest | QA Emmy's agent | Claude Code" })], ME)[0]?.from, "CanyonWest");
  assert.deepEqual(suggestedReplyCandidates(rows, SHANNON), []);
});

test("the cache key follows the candidates, so a deleted message changes it", async () => {
  const { suggestedReplyCandidatesKey } = await import("../messages/suggested-reply.js");
  const rows = [human(ME, "Status?"), agent("codex", "Merge?", "Yes"), agent("claude", "Theme?", "Option 2")];
  const both = suggestedReplyCandidatesKey(suggestedReplyCandidates(rows, ME));
  const oneDeleted = suggestedReplyCandidatesKey(suggestedReplyCandidates([rows[0]!, rows[2]!], ME));
  assert.notEqual(both, oneDeleted);
});

test("one candidate needs no Jev call", async () => {
  let calls = 0;
  const rows = [human(ME, "Check CI"), agent("codex", "Merge?", "Yes, merge it")];
  const pick = await pickSuggestedReply({ rows, viewerAccountId: ME, endpoint, evaluate: async () => { calls += 1; return { body: {}, latencyMs: 1 }; } });
  assert.equal(pick?.text, "Yes, merge it");
  assert.equal(pick?.message_id, `msg_${rows[1]!.number}`);
  assert.equal(calls, 0);
});

test("with several candidates Jev picks one, and a failed or odd answer falls back to the newest", async () => {
  const rows = [human(ME, "Status?"), agent("codex", "Merge #1921?", "Yes, merge it"), agent("claude", "Theme option 2 or 3?", "Use option 2")];
  let state: any = null;
  const pick = await pickSuggestedReply({ rows, viewerAccountId: ME, endpoint, evaluate: async (_config, request) => {
    state = request;
    return { body: { answers: { next_reply: { choice: "reply_1" } } }, latencyMs: 5 };
  } });
  assert.equal(pick?.text, "Yes, merge it");
  assert.deepEqual(Object.keys(state.questions.next_reply.criteria), ["reply_1", "reply_2"]);
  assert.equal(state.state.untrusted_recent_conversation[0].from, "the_viewer");

  const failed = await pickSuggestedReply({ rows, viewerAccountId: ME, endpoint, evaluate: async () => { throw new Error("HTTP 500"); } });
  assert.equal(failed?.text, "Use option 2");
  const odd = await pickSuggestedReply({ rows, viewerAccountId: ME, endpoint, evaluate: async () => ({ body: { answers: { next_reply: { choice: "reply_9" } } }, latencyMs: 1 }) });
  assert.equal(odd?.text, "Use option 2");
  const off = await pickSuggestedReply({ rows, viewerAccountId: ME, endpoint: null });
  assert.equal(off?.text, "Use option 2");
});

test("the cache shares one pick per key and forgets a failed one", async () => {
  const cache = new SuggestedReplyCache(2);
  let loads = 0;
  const load = async () => { loads += 1; return null; };
  await Promise.all([cache.get("a", load), cache.get("a", load)]);
  assert.equal(loads, 1);
  await assert.rejects(cache.get("b", async () => { throw new Error("db down"); }));
  await cache.get("b", load);
  assert.equal(loads, 2);
  await cache.get("c", load);
  await cache.get("a", load);
  assert.equal(loads, 4, "the oldest key was evicted at capacity 2, so it loads again");
});
