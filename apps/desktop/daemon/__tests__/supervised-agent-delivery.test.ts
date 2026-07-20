import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";

test("worker-authenticated activation ingress deduplicates replay and publishes one bounded reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const polls: unknown[] = []; const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, {
      capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true, turnControl: "unsupported" }),
      spawn: async () => { throw new Error("not used"); }, attach: async () => null, attachAction: async () => ({ status: "missing" }), resume: async () => { throw new Error("not used"); }, poke: async () => {}, stop: async () => ({ endedAt: "", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
      runRoomTurn: async (_handle, request) => ({ turnId: `turn:${request.inboxItemId}`, outcome: "reply", text: "hello" }),
    }, {
      poll: async (input) => { polls.push(input); return { last_observed_message_id: "1", messages: [{ id: "1", activation: { for_current_agent: { reason: "server" } }, text: "hi" }, { id: "2", text: "ignored" }] }; },
      publish: async (input) => { published.push(input.clientMessageId); },
    }, 0);
    const agent = { agentId: "stone", roomId: "room", bearer: "memory-only", handle: { provider: "codex", workAttemptId: "attempt", providerContinuationId: "thread", pid: 1 } };
    await delivery.poll(agent); await new Promise((resolve) => setTimeout(resolve, 5));
    await delivery.poll(agent); await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(polls.length, 2);
    assert.equal((await store.receipts("stone")).length, 1);
    assert.deepEqual(published, ["supervised-room:stone:1:reply:v1"]);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a publish retry reuses the persisted terminal reply without rerunning the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-retry-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    let turns = 0; let publishes = 0;
    const delivery = new SupervisedAgentDelivery(store, {
      capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true, turnControl: "unsupported" }), spawn: async () => { throw new Error("not used"); }, attach: async () => null, attachAction: async () => ({ status: "missing" }), resume: async () => { throw new Error("not used"); }, poke: async () => {}, stop: async () => ({ endedAt: "", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
      runRoomTurn: async () => ({ turnId: `turn:${++turns}`, outcome: "reply", text: "durable" }),
    }, { poll: async () => ({ last_observed_message_id: "1", messages: [{ id: "1", activation: { for_current_agent: {} } }] }), publish: async () => { if (++publishes === 1) throw new Error("crash before ack"); } }, 0);
    const agent = { agentId: "stone", roomId: "room", bearer: "memory", handle: { provider: "codex", workAttemptId: "attempt", providerContinuationId: "thread", pid: 1 } };
    await delivery.poll(agent); await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(turns, 1); assert.equal(publishes, 2);
    assert.equal((await store.receipts("stone"))[0]?.state, "acknowledged");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
