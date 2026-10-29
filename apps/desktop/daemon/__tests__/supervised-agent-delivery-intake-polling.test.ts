import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { supervisedAgentsOnly } from "../../electron/__tests__/platform.js";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import {
  agent,
  currentAuthority,
  provider,
  deferred,
  waitFor,
  waitForAsync,
  ingest,
} from "./helpers/supervised-agent-delivery-fixture.js";

test("handoff fences an in-flight ingress poll and drains it before returning", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-poll-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); let aborted = false;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      poll: ({ signal }) => new Promise((resolve) => { entered.resolve(); signal.addEventListener("abort", () => { aborted = true; resolve({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] }); }, { once: true }); }),
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);
    const poll = delivery.poll(agent); await entered.promise;
    await delivery.fenceAndDrain(); await poll;
    assert.equal(aborted, true);
    assert.equal((await store.receipts(agent.agentId)).length, 0, "a fenced poll cannot ingest after its await");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("messages arriving during handoff replay from the durable cursor exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-handoff-replay-"));
  let firstStore: SupervisedAgentInboxStore | null = null;
  let successorStore: SupervisedAgentInboxStore | null = null;
  let firstDelivery: SupervisedAgentDelivery | null = null;
  let successorDelivery: SupervisedAgentDelivery | null = null;
  try {
    const databasePath = join(root, "daemon.sqlite");
    firstStore = new SupervisedAgentInboxStore(databasePath);
    const handoffPollEntered = deferred<void>();
    let oldPolls = 0;
    firstDelivery = new SupervisedAgentDelivery(firstStore, provider(async (_handle, request) => ({
      turnId: `old:${request.inboxItemId}`, outcome: "no_reply", text: null,
    })), {
      poll: ({ afterMessageId, signal }) => {
        oldPolls += 1;
        if (oldPolls === 1) {
          assert.equal(afterMessageId, null);
          return Promise.resolve({
            last_observed_message_id: "1",
            messages: [{ id: "1", text: "before handoff", activation: { for_current_agent: { decision: "activate" } } }],
          });
        }
        assert.equal(afterMessageId, "1");
        handoffPollEntered.resolve();
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({
          last_observed_message_id: "3",
          messages: [
            { id: "2", text: "during handoff", activation: { for_current_agent: { decision: "activate" } } },
            { id: "3", text: "also during handoff", activation: { for_current_agent: { decision: "activate" } } },
          ],
        }), { once: true }));
      },
      publish: async () => { throw new Error("no-reply delivery must not publish"); },
    }, currentAuthority, 0);

    await firstDelivery.poll(agent);
    const retiringPoll = firstDelivery.poll(agent);
    await handoffPollEntered.promise;
    await firstDelivery.fenceAndDrain();
    await retiringPoll;
    assert.equal((await firstStore.cursor(agent.agentId))?.last_observed_message_id, "1");
    assert.deepEqual((await firstStore.receipts(agent.agentId)).map((receipt) => receipt.source_message_id), ["1"]);
    await firstStore.close();
    firstStore = null;

    successorStore = new SupervisedAgentInboxStore(databasePath);
    const replayedAfter: Array<string | null> = [];
    let successorTurns = 0;
    successorDelivery = new SupervisedAgentDelivery(successorStore, provider(async (_handle, request) => {
      successorTurns += 1;
      return { turnId: `successor:${request.inboxItemId}`, outcome: "no_reply", text: null };
    }), {
      poll: async ({ afterMessageId }) => {
        replayedAfter.push(afterMessageId);
        return {
          last_observed_message_id: "3",
          messages: [
            { id: "2", text: "during handoff", activation: { for_current_agent: { decision: "activate" } } },
            { id: "3", text: "also during handoff", activation: { for_current_agent: { decision: "activate" } } },
          ],
        };
      },
      publish: async () => { throw new Error("no-reply delivery must not publish"); },
    }, currentAuthority, 0);
    const successorAgent = { ...agent, bearer: "successor-memory-token", daemonGeneration: 2 };
    await successorDelivery.poll(successorAgent);
    await successorDelivery.poll(successorAgent);
    const receipts = await successorStore.receipts(agent.agentId);
    assert.deepEqual(replayedAfter, ["1", "3"], "the successor resumes at the predecessor cursor, then advances monotonically");
    assert.deepEqual(receipts.map((receipt) => receipt.source_message_id), ["1", "2", "3"]);
    assert.equal(receipts.every((receipt) => receipt.state === "acknowledged_no_reply"), true);
    assert.equal(successorTurns, 2, "server replay is deduplicated before provider delivery");
  } finally {
    await successorDelivery?.fenceAndDrain().catch(() => undefined);
    await firstDelivery?.fenceAndDrain().catch(() => undefined);
    await successorStore?.close().catch(() => undefined);
    await firstStore?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("@everyone delivery is per-agent and one blocked FIFO cannot stall another Codex worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-everyone-isolation-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const firstBlockedTurn = deferred<{ turnId: string; outcome: "no_reply"; text: null }>();
  const blockedTurnEntered = deferred<void>();
  const agents = {
    blocked: {
      ...agent, agentId: "blocked", agentSessionId: "session-blocked", bearer: "token-blocked",
      handle: { ...agent.handle, workAttemptId: "attempt-blocked", providerContinuationId: "thread-blocked", pid: 11 },
      executionGenerationId: "generation-blocked",
    },
    healthy: {
      ...agent, agentId: "healthy", agentSessionId: "session-healthy", bearer: "token-healthy",
      handle: { ...agent.handle, workAttemptId: "attempt-healthy", providerContinuationId: "thread-healthy", pid: 22 },
      executionGenerationId: "generation-healthy",
    },
  };
  const pollCounts = new Map<string, number>();
  let blockedTurns = 0;
  let healthyTurns = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async (handle, request) => {
    if (handle === agents.blocked.handle) {
      blockedTurns += 1;
      if (blockedTurns === 1) {
        blockedTurnEntered.resolve();
        return firstBlockedTurn.promise;
      }
      throw new Error(`blocked agent failure ${request.inboxItemId}`);
    }
    healthyTurns += 1;
    return { turnId: `healthy:${request.inboxItemId}`, outcome: "no_reply", text: null };
  }), {
    poll: async ({ bearer, afterMessageId }) => {
      const count = (pollCounts.get(bearer) ?? 0) + 1;
      pollCounts.set(bearer, count);
      assert.equal(afterMessageId, count === 1 ? null : "1");
      return {
        last_observed_message_id: String(count),
        messages: [{
          id: String(count), text: `@everyone broadcast ${count}`,
          activation: { for_current_agent: { decision: "activate", reason: "everyone" } },
        }],
      };
    },
    publish: async () => { throw new Error("no-reply delivery must not publish"); },
  }, currentAuthority, 0, async () => {});
  try {
    const blockedFirst = delivery.poll(agents.blocked);
    await blockedTurnEntered.promise;
    await delivery.poll(agents.healthy);
    assert.equal((await store.receipts(agents.healthy.agentId))[0]?.state, "acknowledged_no_reply",
      "the healthy worker completes while the other provider turn is still blocked");
    firstBlockedTurn.reject(new Error("blocked worker failed"));
    await blockedFirst;
    assert.equal((await store.receipts(agents.blocked.agentId))[0]?.state, "blocked");

    await Promise.all([delivery.poll(agents.blocked), delivery.poll(agents.healthy)]);
    const blockedReceipts = await store.receipts(agents.blocked.agentId);
    const healthyReceipts = await store.receipts(agents.healthy.agentId);
    assert.deepEqual(blockedReceipts.map((receipt) => receipt.receipt_state), ["blocked", "queued_behind_blocked"]);
    assert.deepEqual(healthyReceipts.map((receipt) => receipt.state), ["acknowledged_no_reply", "acknowledged_no_reply"]);
    assert.equal(blockedTurns, 1, "the uncertain native send blocks only its own FIFO without replay");
    assert.equal(healthyTurns, 2, "each @everyone activation independently reaches the healthy Codex worker");
  } finally {
    firstBlockedTurn.resolve({ turnId: "cleanup", outcome: "no_reply", text: null });
    await delivery.fenceAndDrain().catch(() => undefined);
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("room intake continues through a held provider turn while FIFO execution stays serial", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-independent-intake-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const firstTurn = deferred<void>(); const release = deferred<void>();
  let polls = 0; let concurrent = 0; let peak = 0;
  const turns: string[] = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => {
    concurrent += 1; peak = Math.max(peak, concurrent); turns.push((request.sourceMessage as { id: string }).id);
    if (turns.length === 1) { firstTurn.resolve(); await release.promise; }
    concurrent -= 1;
    return { turnId: request.inboxItemId, outcome: "no_reply", text: null };
  }), {
    poll: async ({ signal }) => {
      polls += 1;
      if (polls <= 3) {
        if (polls > 1) await firstTurn.promise;
        return { messages: [{ id: String(polls), activation: { for_current_agent: { decision: "activate" } } }] };
      }
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({}), { once: true }));
    },
    publish: async () => { throw new Error("no-reply must not publish"); },
  }, currentAuthority, 0);
  try {
    await delivery.start(agent); await firstTurn.promise;
    await waitForAsync(async () => (await store.cursor(agent.agentId))?.last_observed_message_id === "3");
    assert.equal((await store.receipts(agent.agentId)).length, 3, "later messages are durable before the held turn ends");
    assert.deepEqual(turns, ["1"]);
    assert.equal(peak, 1);
    const internal = delivery as unknown as { pumpWakeups: Map<string, unknown> };
    assert.equal(internal.pumpWakeups.size, 1, "repeated intake coalesces one settlement wake");
    release.resolve();
    await waitForAsync(async () => (await store.receipts(agent.agentId)).every(item => item.state === "acknowledged_no_reply"));
    assert.deepEqual(turns, ["1", "2", "3"]);
    assert.equal(peak, 1);
  } finally { release.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("while a turn runs, a person's message overtakes queued work and a notice turn carries the notices behind it", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-priority-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const firstTurn = deferred<void>(); const release = deferred<void>();
  const turns: Array<{ id: string; earlier: string[] }> = [];
  const activate = { for_current_agent: { decision: "activate", reason: "explicit_mention", addressed: true } };
  const notice = (id: string) => ({ id, sender: "letagents", source: "system", agent_identity: null, text: `Board intent bi_${id} was approved.`, activation: activate });
  const peer = (id: string) => ({ id, sender: "Peer", source: "agent", agent_identity: { agent_key: "dana/peer" }, text: `peer ${id}`, activation: activate });
  const pages = [[peer("1")], [notice("2"), peer("3"), notice("4"), { id: "5", sender: "Dana", source: "browser", agent_identity: null, text: "stop and look at this", activation: activate }]];
  let polls = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => {
    const earlier = (request.activation as { queued_notices?: { notices: Array<{ id: string }> } }).queued_notices;
    turns.push({ id: (request.sourceMessage as { id: string }).id, earlier: earlier?.notices.map((entry) => entry.id) ?? [] });
    if (turns.length === 1) { firstTurn.resolve(); await release.promise; }
    return { turnId: request.inboxItemId, outcome: "no_reply", text: null };
  }), {
    poll: async ({ signal }) => {
      const page = pages[polls++];
      if (page) {
        if (polls > 1) await firstTurn.promise;
        return { messages: page };
      }
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({}), { once: true }));
    },
    publish: async () => { throw new Error("no-reply must not publish"); },
  }, currentAuthority, 0);
  try {
    await delivery.start(agent); await firstTurn.promise;
    await waitForAsync(async () => (await store.cursor(agent.agentId))?.last_observed_message_id === "5");
    release.resolve();
    await waitForAsync(async () => (await store.receipts(agent.agentId)).every(item => item.state === "acknowledged_no_reply"));
    assert.deepEqual(turns, [
      { id: "1", earlier: [] },
      { id: "5", earlier: [] },
      { id: "2", earlier: ["4"] },
      { id: "3", earlier: [] },
    ]);
    const carried = (await store.getBySourceMessage(agent.agentId, agent.roomId, "4"))!;
    assert.equal(carried.provider_turn_id, null, "the later notice never ran its own provider turn");
    assert.equal(carried.last_error, "Delivered in the turn for 2 together with other queued notices, so this notice had no separate turn.");
  } finally { release.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a notice turn that fails after it starts leaves its listed notices queued, so the lease holder's work continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-notice-batch-failure-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const runs: Array<{ id: string; listed: string[] }> = [];
  let completed = false;
  const task = { id: "task_1", title: "Finish the existing change", leaseId: "lease-1", epoch: 0 };
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    const listed = (request.activation as { queued_notices?: { notices: Array<{ id: string }> } }).queued_notices?.notices.map((entry) => entry.id) ?? [];
    runs.push({ id: String((request.sourceMessage as { id?: string }).id), listed });
    await options?.beforeNativeDispatch?.();
    const turnId = `turn-${runs.length}`;
    await options?.checkpointTurnStarted?.(turnId);
    if (runs.length === 1) {
      return { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", error: "HTTP 503 Service Unavailable" };
    }
    completed = true;
    return { turnId, outcome: "no_reply", text: null };
  }), {
    poll: async () => ({}),
    ownedTasks: async () => completed ? [] : [task],
    publish: async () => ({ roomId: agent.roomId, messageId: "msg_9" }),
  }, currentAuthority, 0, async () => {});
  try {
    const notice = (id: string) => ({ source_message_id: id, activation: { decision: "activate", reason: "explicit_mention", addressed: true },
      source_message: { id, sender: "letagents", source: "system", agent_identity: null, text: `Board intent bi_${id} was approved. Continue the approved action.` } });
    await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: "2", messages: [notice("1"), notice("2")] });
    await delivery.pump(agent);
    assert.deepEqual(runs, [{ id: "1", listed: ["2"] }, { id: "2", listed: [] }], "the failed turn's listed notice gets its own turn");
    assert.equal(completed, true);
    assert.deepEqual((await store.receipts(agent.agentId)).map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply"]);
  } finally {
    await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true });
  }
});

for (const intakeState of ["observing", "backoff"] as const) {
  test(`delivery recovery preserves ${intakeState} health while room polling hangs`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "letagents-delivery-independent-recovery-"));
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    await ingest(store, "1");
    const normalize = store.normalizeStartupRecovery.bind(store);
    const hangingPoll = deferred<void>();
    const expectedHealth = { room_id: agent.roomId, state: intakeState,
      detail: intakeState === "backoff" ? "temporary poll failure" : null,
      execution_generation_id: agent.executionGenerationId };
    let normalizations = 0; let turns = 0; let polls = 0;
    store.normalizeStartupRecovery = async (...args) => {
      await hangingPoll.promise;
      assert.deepEqual(await store.ingressHealth(agent.agentId), expectedHealth);
      if (++normalizations <= 2) throw new Error("temporary store failure password=synthetic-secret");
      return normalize(...args);
    };
    const warnings: string[] = [];
    t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
    const delays: number[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => {
      turns += 1; return { turnId: request.inboxItemId, outcome: "no_reply", text: null };
    }), {
      poll: async ({ signal }) => {
        if (++polls === 1) {
          if (intakeState === "backoff") throw new Error("temporary poll failure");
          return {};
        }
        hangingPoll.resolve();
        return new Promise(resolve => signal.addEventListener("abort", () => resolve({}), { once: true }));
      },
      publish: async () => { throw new Error("no-reply must not publish"); },
    }, currentAuthority, 0, undefined, async delay => { delays.push(delay); });
    try {
      await delivery.start(agent);
      await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged_no_reply");
      assert.equal(normalizations, 3); assert.equal(turns, 1);
      assert.deepEqual(delays.slice(-2), [250, 500]);
      assert.deepEqual(await store.ingressHealth(agent.agentId), expectedHealth,
        "delivery recovery must not change the independent observation state");
      assert.deepEqual(warnings, ["Room delivery recovery for stone: temporary store failure password=[REDACTED]"],
        "one redacted diagnostic covers the recovery episode");
    } finally { hangingPoll.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("an intake commit racing an empty pump still wakes delivery without another message", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-empty-wake-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const emptyClaim = deferred<void>(); const release = deferred<void>();
  const claim = store.claimHead.bind(store); let claims = 0; let polls = 0; let turns = 0;
  store.claimHead = async (...args) => {
    const result = await claim(...args);
    if (++claims === 1) { assert.equal(result, null); emptyClaim.resolve(); await release.promise; }
    return result;
  };
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => {
    turns += 1; return { turnId: request.inboxItemId, outcome: "no_reply", text: null };
  }), {
    poll: async ({ signal }) => {
      if (++polls === 1) {
        await emptyClaim.promise;
        return { messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] };
      }
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({}), { once: true }));
    }, publish: async () => { throw new Error("no-reply must not publish"); },
  }, currentAuthority, 0);
  try {
    await delivery.start(agent);
    await waitForAsync(async () => (await store.cursor(agent.agentId))?.last_observed_message_id === "1");
    release.resolve();
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged_no_reply");
    assert.equal(turns, 1);
  } finally { release.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("handoff aborts delivery recovery backoff and cannot create a successor pump", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-recovery-drain-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let normalizations = 0; let aborted = false;
  const waiting = deferred<void>();
  store.normalizeStartupRecovery = async () => { normalizations += 1; throw new Error("store offline"); };
  const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("no native turn expected"); }), {
    poll: ({ signal }) => new Promise(resolve => signal.addEventListener("abort", () => resolve({}), { once: true })),
    publish: async () => { throw new Error("must not publish"); },
  }, currentAuthority, 0, undefined, (_delay, signal) => new Promise(resolve => {
    waiting.resolve(); signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
  }));
  try {
    await delivery.start(agent); await waiting.promise;
    await delivery.fenceAndDrain();
    assert.equal(aborted, true); assert.equal(normalizations, 1);
    assert.equal(delivery.wake(agent), false);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("the supervised runtime continuously polls and delivers a later activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-loop-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const secondPoll = deferred<void>(); let polls = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => ({ turnId: request.inboxItemId, outcome: "no_reply", text: null })), {
      poll: ({ signal }) => {
        polls += 1;
        if (polls === 1) return Promise.resolve({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] });
        if (polls === 2) {
          secondPoll.resolve();
          return Promise.resolve({ messages: [{ id: "2", activation: { for_current_agent: { decision: "activate" } } }] });
        }
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true }));
      },
      publish: async () => { throw new Error("no-reply must not publish"); },
    }, currentAuthority, 0);
    void delivery.start(agent); await secondPoll.promise;
    await waitFor(() => polls >= 3);
    await delivery.fenceAndDrain();
    assert.equal(polls >= 2, true);
    assert.equal((await store.receipts(agent.agentId)).length, 2);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the supervised runtime backs off after a poll error and resumes intake", { skip: supervisedAgentsOnly }, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-loop-retry-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    let polls = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => ({ turnId: request.inboxItemId, outcome: "no_reply", text: null })), {
      poll: ({ signal }) => {
        polls += 1;
        if (polls === 1) return Promise.reject(new Error("temporary poll failure"));
        if (polls === 2) return Promise.resolve({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] });
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true }));
      },
      publish: async () => { throw new Error("no-reply must not publish"); },
    }, currentAuthority, 0);
    void delivery.start(agent);
    await waitFor(() => polls >= 3);
    assert.deepEqual(await store.ingressHealth(agent.agentId), {
      room_id: agent.roomId,
      state: "observing",
      detail: null,
      execution_generation_id: agent.executionGenerationId,
    }, "the successful recovery poll clears backoff before the received turn is exposed");
    await delivery.fenceAndDrain();
    assert.equal((await store.receipts(agent.agentId)).length, 1);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("poll-error backoff grows, caps, and resets after a healthy poll", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-backoff-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const delays: number[] = []; let polls = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      poll: ({ signal }) => {
        polls += 1;
        if (polls <= 8 || polls === 10) return Promise.reject(new Error("outage"));
        if (polls === 9) return Promise.resolve({});
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true }));
      },
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority, 50, undefined, async (delayMs) => { delays.push(delayMs); });
    void delivery.start(agent);
    await waitFor(() => polls >= 11);
    await delivery.fenceAndDrain();
    assert.deepEqual(delays, [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 25, 250]);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("successful polling cycles release backoff listeners instead of accumulating them", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-poll-listeners-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    let polls = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      poll: async () => { polls += 1; return {}; },
      publish: async () => { throw new Error("must not publish"); },
    }, async () => polls < 15);
    const internals = delivery as unknown as { loopControllers: Map<string, AbortController>; loops: Map<string, Promise<void>> };
    void delivery.start(agent);
    await waitFor(() => internals.loops.has(agent.agentId));
    const controller = internals.loopControllers.get(agent.agentId)!;
    await waitFor(() => !internals.loops.has(agent.agentId), 5_000);
    assert.equal(polls, 15);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fence aborts a pending error backoff and releases its listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-backoff-drain-"));
  let store: SupervisedAgentInboxStore | null = null;
  let delivery: SupervisedAgentDelivery | null = null;
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      poll: async () => { throw new Error("outage"); },
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);
    const internals = delivery as unknown as { loopControllers: Map<string, AbortController> };
    void delivery.start(agent);
    await waitFor(() => internals.loopControllers.has(agent.agentId));
    const controller = internals.loopControllers.get(agent.agentId)!;
    await waitFor(() => getEventListeners(controller.signal, "abort").length === 1);
    const started = Date.now();
    await delivery.fenceAndDrain();
    assert.ok(Date.now() - started < 100, "fence should not wait for the 250ms backoff timer");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    // This test intentionally starts an endless outage loop. Keep its cleanup
    // independent of assertion success so a test failure cannot retain Node's
    // worker process through its timer and SQLite handle.
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
