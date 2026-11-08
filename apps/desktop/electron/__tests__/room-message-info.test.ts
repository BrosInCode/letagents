import assert from "node:assert/strict";
import test from "node:test";

import { mapDesktopMessageInfoPayload } from "../main/rooms/messages.js";

test("message info payload maps to the desktop projection", () => {
  const mapped = mapDesktopMessageInfoPayload({
    message: {
      id: "msg_41",
      sender: "EmmyMay",
      text_preview: "hello agents",
      timestamp: "2026-07-27T10:00:00.000Z",
      thread_root_id: "msg_41",
      reply_to_id: null,
    },
    seen_by_people: [
      { name: "Shannon", avatar_url: null, seen_at: "2026-07-27T10:01:00.000Z" },
      { name: "", seen_at: "2026-07-27T10:02:00.000Z" },
    ],
    agents_asked: [
      {
        receipt_id: "rcpt_1",
        agent_key: "owner/garden",
        actor_label: "GardenSignal | EmmyMay's agent | Supervisor Worker",
        activation_reason_label: "Asked with @everyone",
        receipt_state: "replied",
        observed: true,
        reply_message_id: "msg_42",
      },
      { receipt_id: "", agent_key: "owner/broken", receipt_state: "queued" },
    ],
    also_observed: [{ agent_key: "owner/quiet", display_name: "QuietAgent" }],
    summary_counts: { seen_count: 1, asked_count: 1, reply_count: 1, observed_count: 1 },
  });

  assert.ok(mapped);
  assert.equal(mapped.message.id, "msg_41");
  assert.equal(mapped.seenByPeople.length, 1, "nameless readers are dropped");
  assert.deepEqual(mapped.agentsAsked, [{
    receiptId: "rcpt_1",
    agentKey: "owner/garden",
    actorLabel: "GardenSignal | EmmyMay's agent | Supervisor Worker",
    activationReasonLabel: "Asked with @everyone",
    receiptState: "replied",
    observed: true,
    replyMessageId: "msg_42",
  }]);
  assert.deepEqual(mapped.alsoObserved, [{ agentKey: "owner/quiet", displayName: "QuietAgent" }]);
  assert.equal(mapped.summaryCounts.replyCount, 1);
});

test("message info without a valid message header maps to null", () => {
  assert.equal(mapDesktopMessageInfoPayload({}), null);
  assert.equal(mapDesktopMessageInfoPayload({ message: { id: "msg_1" } }), null);
});

test("absent optional sections default to empty and zero counts", () => {
  const mapped = mapDesktopMessageInfoPayload({
    message: { id: "msg_9", sender: "EmmyMay", timestamp: "2026-07-27T10:00:00.000Z" },
  });
  assert.ok(mapped);
  assert.deepEqual(mapped.seenByPeople, []);
  assert.deepEqual(mapped.agentsAsked, []);
  assert.deepEqual(mapped.alsoObserved, []);
  assert.deepEqual(mapped.summaryCounts, { seenCount: 0, askedCount: 0, replyCount: 0, observedCount: 0 });
  assert.equal(mapped.message.threadRootId, "msg_9", "a top-level message is its own thread root");
});

test("receipt payloads map to the sender's projection and drop malformed rows", async () => {
  const { mapDesktopMessageReceiptsPayload } = await import("../main/rooms/messages.js");
  const mapped = mapDesktopMessageReceiptsPayload({
    receipts: [
      {
        message_id: "msg_12", sent_at: "2026-11-08T10:00:00.000Z",
        agents: [
          { agent_key: "emmymay/desktop-codex-1", display_name: "LivelyDelta", provider: "Codex", owner_name: "EmmyMay", mine: true,
            state: "replied", activation_reason: "explicit_mention", activation_reason_label: "Mentioned directly",
            reply_message_id: "msg_13", asked_at: "2026-11-08T10:00:00.000Z", finished_at: "2026-11-08T10:00:09.000Z" },
          { agent_key: "", state: "queued", asked_at: "2026-11-08T10:00:00.000Z" },
        ],
        readers: [{ name: "Shannon", avatar_url: null, read_at: "2026-11-08T10:00:03.000Z" }, { name: "", read_at: "x" }],
        not_read: [{ name: "Tobi" }],
        no_wake: null,
      },
      { message_id: "msg_14", sent_at: "2026-11-08T10:01:00.000Z", agents: [], readers: [], not_read: null,
        no_wake: { reason: "recent_agent_left", agent_count: 3, recent_agent: "Mossbank" } },
      { sent_at: "2026-11-08T10:02:00.000Z" },
    ],
  });
  assert.equal(mapped.length, 2);
  assert.deepEqual(mapped[0]!.agents, [{
    agentKey: "emmymay/desktop-codex-1", displayName: "LivelyDelta", provider: "Codex", ownerName: "EmmyMay", mine: true,
    state: "replied", activationReason: "explicit_mention", activationReasonLabel: "Mentioned directly",
    replyMessageId: "msg_13", askedAt: "2026-11-08T10:00:00.000Z", finishedAt: "2026-11-08T10:00:09.000Z",
  }]);
  assert.deepEqual(mapped[0]!.readers, [{ name: "Shannon", avatarUrl: null, readAt: "2026-11-08T10:00:03.000Z" }]);
  assert.deepEqual(mapped[0]!.notRead, [{ name: "Tobi", avatarUrl: null }]);
  assert.equal(mapped[1]!.notRead, null);
  assert.deepEqual(mapped[1]!.noWake, { reason: "recent_agent_left", agentCount: 3, recentAgent: "Mossbank" });
});

test("an unknown or malformed no-wake reason still says nobody was woken", async () => {
  const { mapDesktopMessageNoWake } = await import("../main/rooms/messages.js");
  assert.equal(mapDesktopMessageNoWake(null), null);
  assert.deepEqual(mapDesktopMessageNoWake({ reason: "brand_new" }), { reason: "unknown" });
  assert.deepEqual(mapDesktopMessageNoWake({ reason: "recent_agent_left", agent_count: 3 }), { reason: "no_mention_large_room", agentCount: 3 });
  assert.deepEqual(mapDesktopMessageNoWake({ reason: "ambiguous_mention", handles: ["delta", 4, ""] }), { reason: "ambiguous_mention", handles: ["delta"] });
  assert.deepEqual(mapDesktopMessageNoWake({ reason: "no_mention_large_room", agent_count: -2 }), { reason: "no_mention_large_room", agentCount: 0 });
});
