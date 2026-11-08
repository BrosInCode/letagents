import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopMessageReceipt } from "../../electron/ipc-types";
import {
  formatDuration, noWakeSentence, orderReceiptAgents, readersLabel, receiptRowDetail, receiptRowKind, summarizeReceipt,
} from "../src/domain/message-receipt-view";

type Agent = DesktopMessageReceipt["agents"][number];

function agent(overrides: Partial<Agent>): Agent {
  return {
    agentKey: "emmymay/desktop-codex-1", displayName: "LivelyDelta", provider: "Codex", ownerName: "EmmyMay", mine: true,
    state: "replied", activationReason: "explicit_mention", activationReasonLabel: "Mentioned directly",
    replyMessageId: "msg_8", askedAt: "2026-11-08T10:00:00.000Z", finishedAt: "2026-11-08T10:00:09.000Z",
    ...overrides,
  };
}

test("each receipt state has its own kind, so a row never relies on colour alone", () => {
  assert.equal(receiptRowKind("replied"), "replied");
  assert.equal(receiptRowKind("responding"), "working");
  assert.equal(receiptRowKind("retrying"), "working");
  assert.equal(receiptRowKind("queued"), "waiting");
  assert.equal(receiptRowKind("no_reply"), "no_reply");
  assert.equal(receiptRowKind("blocked"), "attention");
  assert.equal(receiptRowKind("unavailable"), "attention");
  assert.equal(receiptRowKind("cancelled"), "ended");
});

test("the title is the answer: one agent by name, several by count, nobody in words", () => {
  assert.deepEqual(summarizeReceipt({ agents: [agent({})], noWake: null }),
    { tone: "positive", replied: 1, total: 1, title: "LivelyDelta replied" });
  assert.equal(summarizeReceipt({ agents: [agent({ state: "responding" })], noWake: null }).title, "LivelyDelta is working");
  const many = summarizeReceipt({
    agents: [agent({}), agent({ agentKey: "a/b", displayName: "QuartzPeak", state: "responding" }), agent({ agentKey: "a/c", state: "no_reply" })],
    noWake: null,
  });
  assert.deepEqual(many, { tone: "active", replied: 1, total: 3, title: "1 of 3 replied" });
  const blocked = summarizeReceipt({ agents: [agent({}), agent({ agentKey: "a/b", state: "blocked" })], noWake: null });
  assert.equal(blocked.tone, "attention");
  assert.equal(blocked.title, "1 of 2 need attention");
  assert.deepEqual(summarizeReceipt({ agents: [], noWake: { reason: "unknown" } }),
    { tone: "nobody", replied: 0, total: 0, title: "Nobody was woken" });
});

test("the reason nobody was woken is one plain sentence for each stored reason", () => {
  assert.equal(noWakeSentence({ reason: "recent_agent_left", agentCount: 3, recentAgent: "Mossbank" }),
    "This message has no @mention. In a room with 3 agents, that wakes only the agent you last talked to, Mossbank, and Mossbank has left.");
  assert.match(noWakeSentence({ reason: "no_mention_large_room", agentCount: 4 }), /4 agents.*there is none yet/);
  assert.equal(noWakeSentence({ reason: "ambiguous_mention", handles: ["delta"] }),
    "@delta matches more than one agent, so it reached none of them.");
  assert.equal(noWakeSentence({ reason: "no_agents" }), "There is no agent in this room.");
  assert.equal(noWakeSentence({ reason: "thread_no_agents" }), "This thread reply has no @mention, and no agent is part of this thread yet.");
  assert.equal(noWakeSentence(null), "This message did not reach an agent.");
});

test("a row says whose agent it is only when it is not yours, why it woke, and how long it took", () => {
  const now = Date.parse("2026-11-08T10:01:04.000Z");
  assert.equal(receiptRowDetail(agent({}), "2026-11-08T10:00:00.000Z", now), "Mentioned directly · in 9s");
  assert.equal(receiptRowDetail(agent({ mine: false, ownerName: "Shannon", state: "responding", finishedAt: null, activationReasonLabel: "Asked with @everyone" }),
    "2026-11-08T10:00:00.000Z", now), "Shannon’s agent · Asked with @everyone · 1m 04s");
  assert.equal(receiptRowDetail(agent({ state: "no_reply" }), "2026-11-08T10:00:00.000Z", now), "Mentioned directly");
});

test("durations use whole units that keep their width", () => {
  assert.equal(formatDuration(9.4), "9s");
  assert.equal(formatDuration(64), "1m 04s");
  assert.equal(formatDuration(3720), "1h 02m");
  assert.equal(formatDuration(-3), "0s");
});

test("the readers line counts people against the room, and says everyone or nobody plainly", () => {
  const reader = (name: string) => ({ name, avatarUrl: null, readAt: "2026-11-08T10:00:00.000Z" });
  assert.equal(readersLabel({ readers: [], notRead: [{ name: "Tobi", avatarUrl: null }] }), "Nobody has read it yet");
  assert.equal(readersLabel({ readers: [reader("Shannon")], notRead: [{ name: "Tobi", avatarUrl: null }] }), "Read by Shannon");
  assert.equal(readersLabel({ readers: [reader("Shannon"), reader("Tobi")], notRead: [] }), "Read by everyone");
  assert.equal(readersLabel({ readers: [reader("Shannon"), reader("Tobi"), reader("Ada")], notRead: [{ name: "Kemi", avatarUrl: null }] }), "Read by 3 of 4");
  assert.equal(readersLabel({ readers: [reader("Shannon"), reader("Tobi")], notRead: null }), "Read by 2");
});

test("your own agents come first, then everyone's in the order they were asked", () => {
  const ordered = orderReceiptAgents([
    agent({ agentKey: "s/j", displayName: "Juniper", mine: false, askedAt: "2026-11-08T10:00:00.000Z" }),
    agent({ agentKey: "e/q", displayName: "QuartzPeak", askedAt: "2026-11-08T10:00:02.000Z" }),
    agent({ agentKey: "e/l", displayName: "LivelyDelta", askedAt: "2026-11-08T10:00:01.000Z" }),
  ]);
  assert.deepEqual(ordered.map((entry) => entry.displayName), ["LivelyDelta", "QuartzPeak", "Juniper"]);
});
