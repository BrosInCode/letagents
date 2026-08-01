import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import test from "node:test";

import { ProviderActionFailure, type ProviderActionPort } from "../provider-action-port.js";
import { SupervisorDaemon } from "../main.js";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { DAEMON_PROTOCOL_VERSION } from "../types.js";

const agent = {
  agentId: "stone", roomId: "room", provider: "codex", deliveryMode: "daemon_inbox" as const, apiUrl: "https://letagents.test", agentSessionId: "session-1", bearer: "memory", executionGenerationId: "generation-1", daemonGeneration: 1,
  handle: { workAttemptId: "attempt", providerContinuationId: "thread", pid: 1, observedState: "working" as const },
  workAttemptId: "attempt", providerContinuationId: "thread", pid: 1,
};
const currentAuthority = async () => true;
const provider = (
  runRoomTurn: NonNullable<ProviderActionPort["runRoomTurn"]>,
  recoverRoomTurn?: NonNullable<ProviderActionPort["recoverRoomTurn"]>,
  repairContinuation?: NonNullable<ProviderActionPort["repairContinuation"]>,
) => ({
  capabilities: async () => ({
    resume: true, midTurnInjection: false, transcriptAccess: true,
    permissionPromptBridging: false, survivesRestart: true,
    turnControl: "unsupported" as const,
    continuationRepair: repairContinuation ? "same_process" as const : "unsupported" as const,
  }),
  spawn: async () => { throw new Error("not used"); }, attach: async () => null, attachAction: async () => ({ state: "absent" as const }), resume: async () => { throw new Error("not used"); }, poke: async () => {}, stop: async () => ({ endedAt: "", exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: null }), onExit: async () => () => {}, runRoomTurn, recoverRoomTurn,
  repairContinuation,
} satisfies ProviderActionPort);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("daemon delivery refuses mcp_polling ingress for every provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  let polls = 0;
  const delivery = new SupervisedAgentDelivery(
    store,
    provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })),
    {
      poll: async () => { polls += 1; return {}; },
      publish: async () => {},
    },
    currentAuthority,
  );
  try {
    for (const candidate of ["codex", "claude-code", "cursor"]) {
      await delivery.poll({ ...agent, provider: candidate, deliveryMode: "mcp_polling" });
    }
    assert.equal(polls, 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon delivery treats an absent mode as historical mcp_polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  let polls = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
    poll: async () => { polls += 1; return {}; }, publish: async () => {},
  }, currentAuthority);
  try {
    const { deliveryMode: _deliveryMode, ...historicalAgent } = agent;
    await delivery.poll(historicalAgent);
    assert.equal(polls, 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon delivery admits a non-Codex provider that owns daemon_inbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-provider-neutral-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  let polls = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
    poll: async () => { polls += 1; return {}; }, publish: async () => {},
  }, currentAuthority);
  try {
    await delivery.poll({ ...agent, provider: "claude-code", deliveryMode: "daemon_inbox" });
    assert.equal(polls, 1);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ingress keeps observing and queues routed work without a provider handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-ingress-only-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  let turns = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async () => { turns += 1; return { turnId: "never", outcome: "no_reply", text: null }; }), {
    poll: async () => ({ messages: [{ id: "1", text: "hello", activation: { for_current_agent: { decision: "activate" } } }] }),
    publish: async () => {},
  }, currentAuthority);
  try {
    await store.bootstrapCursor({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: null });
    await delivery.poll({ ...agent, handle: null, pid: null });
    assert.equal(turns, 0);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "pending");
    assert.equal((await store.ingressHealth(agent.agentId))?.state, "observing");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for delivery progress.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForAsync(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous delivery progress.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function daemonRequest(socketPath: string, method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)) as { ok: boolean; result?: unknown; error?: string });
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: `delivery-${Date.now()}`, method, params })}\n`));
  });
}

async function enqueue(store: SupervisedAgentInboxStore, id = "1") {
  await ingest(store, id);
  return (await store.claimHead(agent.agentId))!;
}

async function ingest(store: SupervisedAgentInboxStore, id = "1") {
  await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: id, messages: [{ source_message_id: id, source_message: { id }, activation: {} }] });
}

test("worker-authenticated activation ingress deduplicates replay and publishes one bounded reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const polls: unknown[] = []; const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => ({ turnId: `turn:${request.inboxItemId}`, outcome: "reply", text: "hello" })), {
      poll: async (input) => { polls.push(input); return { messages: [{ id: "1", activation: { for_current_agent: { decision: "activate", reason: "server" } }, text: "hi" }, { id: "2", text: "ignored" }] }; },
      publish: async (input) => { published.push(input.clientMessageId); return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; },
    }, currentAuthority, 0);
    await delivery.poll(agent); await new Promise((resolve) => setTimeout(resolve, 5));
    await delivery.poll(agent); await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(polls.length, 2);
    assert.equal((await store.receipts("stone")).length, 1);
    assert.deepEqual(published, ["supervised-room:stone:room:1:reply:v1"]);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a publish response without a nonempty matching canonical room identity never checkpoints publication", async () => {
  for (const response of [
    { messageId: "", roomId: agent.roomId },
    { messageId: "msg_wrong_room", roomId: "other_room" },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "letagents-delivery-bad-publication-"));
    try {
      const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
      await ingest(store);
      const delivery = new SupervisedAgentDelivery(
        store,
        provider(async () => ({ turnId: "turn_bad_publication", outcome: "reply", text: "reply" })),
        { poll: async () => ({}), publish: async () => response },
        currentAuthority,
        0,
      );
      await delivery.pump(agent);
      const detail = await store.detail(agent.agentId, agent.roomId, "1");
      assert.equal(detail.publication, null);
      assert.equal(detail.receipt?.state, "blocked");
      assert.match(detail.receipt?.last_error ?? "", /canonical message id.*matching room/);
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("each new bounded turn resolves the latest durable charter without restarting the provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-charter-refresh-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let charter = "first durable charter";
  const seen: Array<string | undefined> = [];
  const delivery = new SupervisedAgentDelivery(
    store,
    provider(async (_handle, request) => {
      seen.push(request.charter);
      return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
    }),
    { poll: async () => ({}), publish: async () => { throw new Error("no-reply turn must not publish"); } },
    currentAuthority,
    0,
    undefined,
    undefined,
    undefined,
    async () => ({ charter }),
  );
  try {
    await ingest(store, "1");
    await delivery.pump(agent);
    charter = "second durable charter";
    await ingest(store, "2");
    await delivery.pump(agent);
    assert.deepEqual(seen, ["first durable charter", "second durable charter"]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("result recovery uses bounded backoff and blocks instead of hot-looping forever", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-result-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-unreadable");
    await store.transition(item.inbox_item_id, "awaiting_result", { provider_turn_id: "turn-unreadable" });
    await store.transition(item.inbox_item_id, "result_recovery", { outcome: JSON.stringify({ kind: "unreadable", text: null, evidence: "none" }) });
    let recoveries = 0;
    const delays: number[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(
      async () => { throw new Error("must not start a new turn"); },
      async () => { recoveries += 1; throw new Error("control socket unavailable"); },
    ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority, 25, async (ms) => { delays.push(ms); });
    await delivery.pump(agent);
    const receipt = (await store.receipts(agent.agentId))[0]!;
    assert.equal(recoveries, 3);
    assert.deepEqual(delays, [25, 50]);
    assert.equal(receipt.state, "blocked");
    assert.equal(receipt.timeline.filter((event) => event.phase === "retry_scheduled").length, 3);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a fresh agent observes history at the tail, advances across silent messages, and dispatches only exact activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-bootstrap-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const dispatched: string[] = [];
    const cursors: Array<string | null> = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => {
      dispatched.push(request.sourceMessage.id as string);
      return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
    }), {
      // msg_99 is an old @everyone activation. It predates this agent and
      // must establish the boundary rather than become its first work item.
      latest: async () => ({ messages: [{ id: "99", activation: { for_current_agent: { decision: "activate" } } }] }),
      poll: async ({ afterMessageId }) => {
        cursors.push(afterMessageId);
        if (afterMessageId === "99") return {
          messages: [
            { id: "100", text: "ordinary room context", activation: { for_current_agent: { decision: "unaddressed" } } },
            { id: "101", text: "@StoneRidge investigate", activation: { for_current_agent: { decision: "activate", reason: "mention" } } },
          ],
          has_more: false,
        };
        return { messages: [] };
      },
      publish: async () => { throw new Error("no-reply delivery must not publish"); },
    }, currentAuthority, 0);
    await delivery.poll(agent);
    assert.deepEqual(cursors, ["99"]);
    assert.deepEqual(dispatched, ["101"]);
    assert.equal((await store.cursor(agent.agentId))?.last_observed_message_id, "101");
    assert.deepEqual((await store.receipts(agent.agentId)).map((item) => item.source_message_id), ["101"]);
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production delivery never establishes a first cursor lazily after activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-admission-cursor-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    let tailReads = 0;
    let polls = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      admissionOwnsInitialCursor: true,
      latest: async () => { tailReads += 1; return { messages: [{ id: "historical" }] }; },
      poll: async () => { polls += 1; return { messages: [] }; },
      publish: async () => {},
    }, currentAuthority, 0);
    await assert.rejects(delivery.poll(agent), /admission cursor/i);
    assert.equal(tailReads, 0, "a running provider cannot move its own first-tail boundary");
    assert.equal(polls, 0);
    assert.equal(await store.cursor(agent.agentId), null);
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bootstrap is one-time and a successor resumes its persisted cursor instead of skipping handoff messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-bootstrap-handoff-"));
  try {
    const path = join(root, "daemon.sqlite");
    const first = new SupervisedAgentInboxStore(path);
    await first.bootstrapCursor({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: "41" });
    await first.close();
    const reopened = new SupervisedAgentInboxStore(path);
    let tailReads = 0;
    const delivery = new SupervisedAgentDelivery(reopened, provider(async (_handle, request) => ({ turnId: request.inboxItemId, outcome: "no_reply", text: null })), {
      latest: async () => { tailReads += 1; return { messages: [{ id: "999" }] }; },
      poll: async ({ afterMessageId }) => {
        assert.equal(afterMessageId, "41");
        return { messages: [{ id: "42", activation: { for_current_agent: { decision: "activate", reason: "everyone" } } }] };
      },
      publish: async () => { throw new Error("no-reply delivery must not publish"); },
    }, currentAuthority, 0);
    await delivery.poll({ ...agent, daemonGeneration: 2, bearer: "replacement" });
    assert.equal(tailReads, 0);
    assert.equal((await reopened.cursor(agent.agentId))?.last_observed_message_id, "42");
    assert.deepEqual((await reopened.receipts(agent.agentId)).map((item) => item.source_message_id), ["42"]);
    await delivery.fenceAndDrain();
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a retiring generation commits its observed bootstrap tail before a successor can poll", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-bootstrap-fence-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    let authority = true;
    const first = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      latest: async () => { authority = false; return { messages: [{ id: "50" }] }; },
      poll: async () => { throw new Error("retired generation must not poll"); },
      publish: async () => {},
    }, async () => authority, 0);
    await first.poll(agent);
    assert.equal((await store.cursor(agent.agentId))?.last_observed_message_id, "50");
    const after: Array<string | null> = [];
    const successor = new SupervisedAgentDelivery(store, provider(async (_handle, request) => ({ turnId: request.inboxItemId, outcome: "no_reply", text: null })), {
      latest: async () => ({ messages: [{ id: "999" }] }),
      poll: async ({ afterMessageId }) => {
        after.push(afterMessageId);
        return { messages: [{ id: "51", activation: { for_current_agent: { decision: "activate" } } }] };
      },
      publish: async () => {},
    }, currentAuthority, 0);
    await successor.poll({ ...agent, daemonGeneration: 2, bearer: "successor" });
    assert.deepEqual(after, ["50"], "the successor inherits the predecessor boundary rather than re-tailing at 999");
    await first.fenceAndDrain(); await successor.fenceAndDrain(); await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("silent messages advance the cursor but never enter FIFO, and paginated poll pages drain once", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-silent-pages-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    await store.bootstrapCursor({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: "10" });
    const after: Array<string | null> = [];
    const turns: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => {
      turns.push((request.sourceMessage as { id: string }).id);
      return { turnId: request.inboxItemId, outcome: "no_reply", text: null };
    }), {
      poll: async ({ afterMessageId }) => {
        after.push(afterMessageId);
        if (afterMessageId === "10") return { has_more: true, messages: [
          { id: "11", activation: { for_current_agent: { decision: "silent" } } },
          { id: "12", activation: { for_current_agent: { decision: "activate", reason: "mention" } } },
        ] };
        if (afterMessageId === "12") return { has_more: false, messages: [
          { id: "13", activation: { for_current_agent: { decision: "unaddressed" } } },
          { id: "14", activation: { for_current_agent: { decision: "activate", reason: "everyone" } } },
        ] };
        return { messages: [] };
      },
      publish: async () => {},
    }, currentAuthority, 0);
    await delivery.poll(agent);
    await delivery.poll(agent);
    assert.deepEqual(after, ["10", "12"]);
    assert.equal((await store.cursor(agent.agentId))?.last_observed_message_id, "14");
    assert.deepEqual((await store.receipts(agent.agentId)).map((item) => item.source_message_id), ["12", "14"]);
    assert.deepEqual(turns, ["12", "14"]);
    await delivery.fenceAndDrain(); await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a publish retry reuses the persisted terminal reply without rerunning the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-retry-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    let turns = 0; let publishes = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: `turn:${++turns}`, outcome: "reply", text: "durable" })), { poll: async () => ({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] }), publish: async (input) => { if (++publishes === 1) throw new Error("crash before ack"); return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; } }, currentAuthority, 0);
    await delivery.poll(agent); await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(turns, 1); assert.equal(publishes, 2);
    assert.equal((await store.receipts("stone"))[0]?.state, "acknowledged");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
    assert.equal(blockedTurns, 3, "the blocked agent exhausts only its own bounded retry budget");
    assert.equal(healthyTurns, 2, "each @everyone activation independently reaches the healthy Codex worker");
  } finally {
    firstBlockedTurn.resolve({ turnId: "cleanup", outcome: "no_reply", text: null });
    await delivery.fenceAndDrain().catch(() => undefined);
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
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

test("the supervised runtime backs off after a poll error and resumes intake", async () => {
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
    await waitFor(() => !internals.loops.has(agent.agentId));
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

test("rebind waits for an old provider turn, recovers its interrupted FIFO head, then processes it and the next item", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-rebind-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); const release = deferred<{ turnId: string; outcome: "reply"; text: string }>();
    let turns = 0; let published = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => {
      turns += 1;
      if (turns === 1) { entered.resolve(); return release.promise; }
      return { turnId: `turn:${turns}`, outcome: "no_reply", text: null };
    }), {
      poll: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true })),
      publish: async (input) => { published += 1; return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; },
    }, currentAuthority);
    await delivery.pump(agent);
    await ingest(store, "1"); await ingest(store, "2");
    const oldPump = delivery.pump(agent); await entered.promise;
    const successor = {
      ...agent,
      bearer: "rotated-memory-only-token",
      executionGenerationId: "generation-2",
      handle: { ...agent.handle, pid: 2 },
    };
    let refreshed = false;
    const refresh = delivery.refresh(successor).then(() => { refreshed = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(refreshed, false, "successor must not overlap the old non-abortable provider turn");
    release.resolve({ turnId: "turn:1", outcome: "reply", text: "late" });
    await refresh; await oldPump;
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "blocked");
    assert.equal(published, 0, "the stale provider reply is never published");
    await delivery.retry(successor, "1");
    await waitForAsync(async () => (await store.receipts(agent.agentId)).every((item) => item.state === "acknowledged_no_reply"));
    assert.equal(turns, 3, "the explicit recovery processes the blocked head before the next FIFO item");
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh fences a poll paused in ingest and lets the successor recover before its first hanging poll", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-ingest-rebind-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const ingestEntered = deferred<void>(); const releaseIngest = deferred<void>(); const successorPoll = deferred<void>();
    const ingest = store.ingestPoll.bind(store);
    (store as unknown as { ingestPoll(input: Parameters<typeof store.ingestPoll>[0]): ReturnType<typeof store.ingestPoll> }).ingestPoll = async (input) => {
      ingestEntered.resolve(); await releaseIngest.promise; return ingest(input);
    };
    let polls = 0; let turns = 0; const turnHandles: unknown[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (handle) => {
      turns += 1;
      turnHandles.push(handle);
      return { turnId: `turn:${turns}`, outcome: "no_reply", text: null };
    }), {
      poll: ({ signal }) => {
        polls += 1;
        if (polls === 1) return Promise.resolve({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] });
        successorPoll.resolve();
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true }));
      },
      publish: async () => { throw new Error("no-reply must not publish"); },
    }, currentAuthority);
    await delivery.start(agent); await ingestEntered.promise;
    const successor = { ...agent, executionGenerationId: "generation-2", handle: { ...agent.handle, pid: 2 } };
    let refreshed = false;
    const refresh = delivery.refresh(successor).then(() => { refreshed = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(refreshed, false, "refresh waits for the old poll's ingest commit");
    releaseIngest.resolve();
    await refresh; await successorPoll.promise;
    assert.equal(turns, 1, "the stopped poll cannot launch a stale delivery pump after ingest");
    assert.equal(turnHandles[0], successor.handle, "only the successor context may run the recovered delivery turn");
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply", "successor recovery and delivery happen before its hanging poll");
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent refreshes install only the newest epoch and its handle drains recovered FIFO work", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-refresh-epoch-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const ingestEntered = deferred<void>(); const releaseIngest = deferred<void>(); const currentPoll = deferred<void>();
    const ingest = store.ingestPoll.bind(store);
    (store as unknown as { ingestPoll(input: Parameters<typeof store.ingestPoll>[0]): ReturnType<typeof store.ingestPoll> }).ingestPoll = async (input) => {
      ingestEntered.resolve(); await releaseIngest.promise; return ingest(input);
    };
    let polls = 0; const turnHandles: unknown[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (handle) => {
      turnHandles.push(handle);
      return { turnId: `turn:${turnHandles.length}`, outcome: "no_reply", text: null };
    }), {
      poll: ({ signal }) => {
        polls += 1;
        if (polls === 1) return Promise.resolve({ last_observed_message_id: "2", messages: [
          { id: "1", activation: { for_current_agent: { decision: "activate" } } },
          { id: "2", activation: { for_current_agent: { decision: "activate" } } },
        ] });
        currentPoll.resolve();
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true }));
      },
      publish: async () => { throw new Error("no-reply must not publish"); },
    }, currentAuthority);
    await delivery.start(agent); await ingestEntered.promise;
    const stale = { ...agent, executionGenerationId: "generation-stale", handle: { ...agent.handle, pid: 2 } };
    const current = { ...agent, executionGenerationId: "generation-current", handle: { ...agent.handle, pid: 3 } };
    const staleRefresh = delivery.refresh(stale);
    const currentRefresh = delivery.refresh(current);
    releaseIngest.resolve();
    await Promise.all([staleRefresh, currentRefresh]); await currentPoll.promise;
    assert.deepEqual(turnHandles, [current.handle, current.handle], "the stale refresh cannot own either recovered FIFO turn");
    const internals = delivery as unknown as { loops: Map<string, Promise<void>>; loopEpochs: Map<string, number> };
    assert.equal(internals.loops.has(agent.agentId), true, "the current successor remains in its long poll");
    assert.equal(internals.loopEpochs.get(agent.agentId), 2, "the live loop belongs to the latest refresh epoch");
    assert.equal((await store.receipts(agent.agentId)).every((item) => item.state === "acknowledged_no_reply"), true);
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an external stop invalidates a refresh reservation still waiting on drain", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-stop-epoch-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const ingestEntered = deferred<void>(); const releaseIngest = deferred<void>();
    const ingest = store.ingestPoll.bind(store);
    (store as unknown as { ingestPoll(input: Parameters<typeof store.ingestPoll>[0]): ReturnType<typeof store.ingestPoll> }).ingestPoll = async (input) => {
      ingestEntered.resolve(); await releaseIngest.promise; return ingest(input);
    };
    let polls = 0; let turns = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => {
      turns += 1;
      return { turnId: "unexpected", outcome: "no_reply", text: null };
    }), {
      poll: async () => { polls += 1; return { messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] }; },
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);
    await delivery.start(agent); await ingestEntered.promise;
    const refresh = delivery.refresh({ ...agent, executionGenerationId: "generation-successor", handle: { ...agent.handle, pid: 2 } });
    const stop = delivery.stop(agent.agentId);
    releaseIngest.resolve();
    await Promise.all([refresh, stop]);
    const internals = delivery as unknown as { loops: Map<string, Promise<void>> };
    assert.equal(polls, 1);
    assert.equal(turns, 0);
    assert.equal(internals.loops.has(agent.agentId), false);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a credential-only rebind clears recovery ownership for the successor context", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-credential-rebind-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    let normalizations = 0;
    const normalize = store.normalizeStartupRecovery.bind(store);
    (store as unknown as { normalizeStartupRecovery(agentId: string): Promise<void> }).normalizeStartupRecovery = async (agentId) => {
      normalizations += 1;
      await normalize(agentId);
    };
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      poll: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true })),
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);
    await delivery.pump(agent);
    await delivery.refresh({ ...agent, bearer: "new-memory-only-token" });
    await waitFor(() => normalizations === 2);
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery publishes durable work before a hanging first poll settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-startup-pump-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite")); const item = await enqueue(store);
    await store.transition(item.inbox_item_id, "awaiting_result", { provider_turn_id: "turn", outcome: JSON.stringify({ kind: "reply", text: "durable" }) });
    await store.transition(item.inbox_item_id, "publishing");
    const pollEntered = deferred<void>(); let published = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("provider must not rerun"); }), {
      poll: ({ signal }) => new Promise((resolve) => {
        pollEntered.resolve(); signal.addEventListener("abort", () => resolve({}), { once: true });
      }),
      publish: async (input) => { published += 1; return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; },
    }, currentAuthority);
    void delivery.start(agent);
    await waitFor(() => published === 1);
    await pollEntered.promise;
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SupervisorDaemon stop fences and drains its production-owned delivery before releasing stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervisor-delivery-drain-"));
  let daemon: SupervisorDaemon | null = null;
  try {
    const entered = deferred<void>(); const release = deferred<{ messages: Array<Record<string, unknown>> }>(); let aborted = false;
    daemon = new SupervisorDaemon({
      lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "manifest.sqlite"), auditPath: join(root, "audit.log"),
      attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
    }, "darwin", provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), false, 60_000, undefined, {}, {
      poll: ({ signal }) => new Promise((resolve) => {
        entered.resolve(); signal.addEventListener("abort", () => { aborted = true; }, { once: true }); release.promise.then(resolve);
      }),
      publish: async () => { throw new Error("must not publish"); },
    });
    const internals = daemon as unknown as {
      putManifestEntry(entry: Record<string, unknown>): Promise<void>;
      startSupervisedDelivery(entryId: string): Promise<void>;
      liveHandles: Map<string, typeof agent.handle>;
      workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
    };
    await daemon.start();
    await internals.putManifestEntry({
      id: "stone", room_id: "room", display_name: "Stone", provider: "codex", model: null, charter: "supervised test", desired_state: "running", observed_state: "working", condition: "none", permission_profile_id: null,
      delivery_mode: "daemon_inbox",
      created_by: "test", created_at: new Date().toISOString(), work_attempt_id: "attempt",
      provider_ref: { work_attempt_id: "attempt", provider_continuation_id: "thread", provider_connection: null, execution_generation_id: "generation-1" },
    });
    internals.liveHandles.set("stone", agent.handle);
    await internals.workerBindings.bind({ entry_id: "stone", room_id: "room", work_attempt_id: "attempt", execution_generation_id: "generation-1", agent_session_id: "session-1", agent_session_token: "memory", api_url: "https://letagents.test" });
    void internals.startSupervisedDelivery("stone"); await entered.promise;
    let stopped = false; const stopping = daemon.stop().then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(aborted, true, "stop fences the live delivery before closing worker storage");
    assert.equal(stopped, false, "stop waits for the in-flight poll to settle");
    release.resolve({ messages: [] });
    await stopping;
    daemon = null;
  } finally {
    await daemon?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SupervisorDaemon stop detaches an unresolved provider turn without retaining the daemon", async () => {
  // Keep the Unix-socket path below macOS's short sockaddr_un limit.
  const root = await mkdtemp(join(tmpdir(), "la-sud-"));
  let daemon: SupervisorDaemon | null = null;
  const late = deferred<{ turnId: string; outcome: "reply"; text: string }>();
  try {
    const entered = deferred<void>(); let published = 0; let providerStops = 0;
    const port = provider(async (_handle, _request, options) => {
      await options?.markDispatched?.(); entered.resolve(); return late.promise;
    });
    (port as unknown as { stop: ProviderActionPort["stop"] }).stop = async () => {
      providerStops += 1;
      return { endedAt: "", exitCode: null, signal: null, terminalCause: "stopped", providerContinuationId: null };
    };
    const paths = {
      lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "manifest.sqlite"), auditPath: join(root, "audit.log"),
      attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
    };
    daemon = new SupervisorDaemon(paths, "darwin", port, false, 60_000, undefined, {}, {
      poll: async () => ({}), publish: async () => { published += 1; },
    });
    const internals = daemon as unknown as {
      putManifestEntry(entry: Record<string, unknown>): Promise<void>;
      liveHandles: Map<string, typeof agent.handle>;
      workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
      supervisedInbox: SupervisedAgentInboxStore;
      supervisedDelivery: SupervisedAgentDelivery;
    };
    await daemon.start();
    await internals.putManifestEntry({
      id: agent.agentId, room_id: agent.roomId, display_name: "Stone", provider: agent.provider, model: null, charter: "test", desired_state: "running", observed_state: "working", condition: "none", permission_profile_id: null,
      delivery_mode: "daemon_inbox",
      created_by: "test", created_at: new Date().toISOString(), work_attempt_id: agent.handle.workAttemptId,
      provider_ref: { work_attempt_id: agent.handle.workAttemptId, provider_continuation_id: agent.handle.providerContinuationId, provider_connection: null, execution_generation_id: agent.executionGenerationId },
    });
    internals.liveHandles.set(agent.agentId, agent.handle);
    await internals.workerBindings.bind({ entry_id: agent.agentId, room_id: agent.roomId, work_attempt_id: agent.handle.workAttemptId, execution_generation_id: agent.executionGenerationId, agent_session_id: agent.agentSessionId, agent_session_token: agent.bearer, api_url: agent.apiUrl });
    await internals.supervisedDelivery.pump(agent); await ingest(internals.supervisedInbox);
    void internals.supervisedDelivery.pump(agent); await entered.promise;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        daemon.stop(),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("daemon stop did not retire the provider await within one second")), 1_000); }),
      ]);
      daemon = null;
    } finally { if (timeout) clearTimeout(timeout); }
    assert.equal(providerStops, 0);
    late.resolve({ turnId: "late", outcome: "reply", text: "must not publish" });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(published, 0, "late provider output is fenced after daemon return");
  } finally {
    late.resolve({ turnId: "cleanup", outcome: "reply", text: "cleanup" });
    await daemon?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff during a provider turn drains it and prevents post-turn publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-turn-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); const release = deferred<{ turnId: string; outcome: "reply"; text: string }>(); let published = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { entered.resolve(); return release.promise; }), { poll: async () => ({}), publish: async () => { published += 1; } }, currentAuthority);
    await delivery.pump(agent); await ingest(store);
    const pump = delivery.pump(agent); await entered.promise;
    const drain = delivery.fenceAndDrain(); release.resolve({ turnId: "turn", outcome: "reply", text: "late" });
    await drain; await pump;
    assert.equal(published, 0);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("handoff retires an unresolved provider turn without stopping it, and late settlement cannot commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-unresolved-turn-"));
  let store: SupervisedAgentInboxStore | null = null;
  let delivery: SupervisedAgentDelivery | null = null;
  let late: ReturnType<typeof deferred<{ turnId: string; outcome: "reply"; text: string }>> | null = null;
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); late = deferred<{ turnId: string; outcome: "reply"; text: string }>();
    let providerStops = 0; let published = 0;
    const port = provider(async (_handle, _request, options) => {
      await options?.markDispatched?.(); entered.resolve(); return late!.promise;
    });
    (port as unknown as { stop: ProviderActionPort["stop"] }).stop = async () => {
      providerStops += 1;
      return { endedAt: "", exitCode: null, signal: null, terminalCause: "stopped", providerContinuationId: null };
    };
    delivery = new SupervisedAgentDelivery(store, port, {
      poll: async () => ({}), publish: async () => { published += 1; },
    }, currentAuthority);
    await delivery.pump(agent); await ingest(store);
    const pump = delivery.pump(agent); await entered.promise;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        delivery.fenceAndDrain(),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("handoff did not retire the provider await within one second")), 1_000); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
    assert.equal(providerStops, 0, "retirement never stops or interrupts the provider process");
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching", "the in-flight result remains durably ambiguous");
    late.resolve({ turnId: "late", outcome: "reply", text: "must not publish" });
    await pump;
    await Promise.resolve();
    assert.equal(published, 0, "a late provider resolution cannot publish after authority retirement");
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching", "a late result cannot checkpoint or acknowledge");
    await store.close(); store = null;
    let resumedTurns = 0;
    const reopened = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const successor = new SupervisedAgentDelivery(reopened, provider(async () => {
      resumedTurns += 1;
      throw new Error("an ambiguous dispatch must not rerun automatically");
    }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await successor.pump(agent);
    assert.equal(resumedTurns, 0);
    assert.equal((await reopened.receipts(agent.agentId))[0]?.state, "blocked", "the successor normalizes the detached dispatch as recoverable blocked work");
    await successor.fenceAndDrain();
    await reopened.close();
  } finally {
    late?.resolve({ turnId: "cleanup", outcome: "reply", text: "cleanup" });
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a late provider rejection after handoff is observed and cannot commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-late-rejection-"));
  let store: SupervisedAgentInboxStore | null = null;
  let delivery: SupervisedAgentDelivery | null = null;
  let late: ReturnType<typeof deferred<{ turnId: string; outcome: "reply"; text: string }>> | null = null;
  const unhandled: unknown[] = [];
  const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", observeUnhandled);
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); late = deferred<{ turnId: string; outcome: "reply"; text: string }>();
    let published = 0;
    delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.markDispatched?.(); entered.resolve(); return late!.promise;
    }), {
      poll: async () => ({}), publish: async () => { published += 1; },
    }, currentAuthority);
    await delivery.pump(agent); await ingest(store);
    const pump = delivery.pump(agent); await entered.promise;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        delivery.fenceAndDrain(),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("handoff did not retire the provider await within one second")), 1_000); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
    late.reject(new Error("late provider failure"));
    await pump;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "the detached provider rejection is already observed");
    assert.equal(published, 0, "a late rejection cannot publish");
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching", "a late rejection cannot mutate the ambiguous receipt");
  } finally {
    // Resolve if an assertion failed before the provider attached its observer.
    late?.resolve({ turnId: "cleanup", outcome: "reply", text: "cleanup" });
    process.off("unhandledRejection", observeUnhandled);
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff during publication aborts and drains the publication without acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-publish-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); const release = deferred<void>(); let aborted = false;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "turn", outcome: "reply", text: "answer" })), {
      poll: async () => ({}),
      publish: ({ signal }) => new Promise<void>((resolve) => { entered.resolve(); signal.addEventListener("abort", () => { aborted = true; }, { once: true }); release.promise.then(resolve); }),
    }, currentAuthority);
    await delivery.pump(agent); await ingest(store);
    const pump = delivery.pump(agent); await entered.promise;
    const drain = delivery.fenceAndDrain(); release.resolve();
    await drain; await pump;
    assert.equal(aborted, true);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "publishing");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a stale generation after a provider await cannot publish or acknowledge", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-stale-generation-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); const release = deferred<{ turnId: string; outcome: "reply"; text: string }>(); let current = true; let published = 0; const seen: unknown[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { entered.resolve(); return release.promise; }), { poll: async () => ({}), publish: async () => { published += 1; } }, async (authority) => { seen.push(authority); return current; }, 50, async () => {});
    await delivery.pump(agent); await ingest(store);
    const pump = delivery.pump(agent); await entered.promise; current = false; release.resolve({ turnId: "turn", outcome: "reply", text: "late" }); await pump;
    assert.equal(published, 0);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching");
    assert.deepEqual(seen.at(-1), {
      agentId: "stone", roomId: "room", provider: "codex", apiUrl: "https://letagents.test", agentSessionId: "session-1", bearer: "memory",
      workAttemptId: "attempt", executionGenerationId: "generation-1", daemonGeneration: 1,
      providerContinuationId: "thread", pid: 1, handle: agent.handle,
    });
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a desired stop, API-origin rotation, or handle replacement after a provider await cannot publish", async () => {
  for (const stale of ["desired-stop", "api-origin", "handle-replacement"] as const) {
    const root = await mkdtemp(join(tmpdir(), `letagents-delivery-${stale}-`));
    try {
      const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
      const entered = deferred<void>(); const release = deferred<{ turnId: string; outcome: "reply"; text: string }>();
      let desiredRunning = true; let currentApiUrl = agent.apiUrl; let currentHandle = agent.handle; let published = 0;
      const delivery = new SupervisedAgentDelivery(store, provider(async () => { entered.resolve(); return release.promise; }), {
        poll: async () => ({}), publish: async () => { published += 1; },
      }, async (authority) => desiredRunning && authority.apiUrl === currentApiUrl && authority.handle === currentHandle);
      await delivery.pump(agent); await ingest(store);
      const pump = delivery.pump(agent); await entered.promise;
      if (stale === "desired-stop") desiredRunning = false;
      if (stale === "api-origin") currentApiUrl = "https://rotated-origin.test";
      if (stale === "handle-replacement") currentHandle = { ...agent.handle, pid: 2 };
      release.resolve({ turnId: "turn", outcome: "reply", text: "late" }); await pump;
      assert.equal(published, 0, stale);
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching", stale);
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("handoff tracks a retry paused after its receipt read and leaves the blocked head unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-retry-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite")); const item = await enqueue(store);
    await store.transition(item.inbox_item_id, "blocked", { last_error: "manual retry" });
    const entered = deferred<void>(); const release = deferred<void>(); const receipts = store.receipts.bind(store);
    (store as unknown as { receipts(agentId: string): ReturnType<typeof store.receipts> }).receipts = async (agentId) => { entered.resolve(); await release.promise; return receipts(agentId); };
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("must not run"); }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    const retry = delivery.retry(agent, "1"); await entered.promise;
    const drain = delivery.fenceAndDrain(); release.resolve();
    await drain; await assert.rejects(retry, (error: unknown) => error instanceof Error);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "blocked");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retry acknowledges durable scheduling without waiting for a long provider turn, and duplicate retry is fenced", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-retry-ack-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.transition(item.inbox_item_id, "blocked", { last_error: "manual retry" });
    const entered = deferred<void>(); const release = deferred<{ turnId: string; outcome: "no_reply"; text: null }>();
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.markDispatched?.();
      entered.resolve();
      return release.promise;
    }), { poll: async () => ({}), publish: async () => { throw new Error("no-reply must not publish"); } }, currentAuthority);
    const started = delivery.retry(agent, "1");
    await started;
    await entered.promise;
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching", "the request returned after durable scheduling, while provider work remains live");
    await assert.rejects(() => delivery.retry(agent, "1"), /blocked room delivery is no longer available/i);
    release.resolve({ turnId: "turn", outcome: "no_reply", text: null });
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged_no_reply");
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daemon socket retry accepts only the exact blocked binding and leaves other rows isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-retry-socket-"));
  let daemon: SupervisorDaemon | null = null;
  let release: ReturnType<typeof deferred<{ turnId: string; outcome: "no_reply"; text: null }>> | null = null;
  try {
    const entered = deferred<void>(); release = deferred<{ turnId: string; outcome: "no_reply"; text: null }>();
    const paths = {
      lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "daemon.sqlite"), auditPath: join(root, "audit.log"),
      attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempts"), workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
    };
    daemon = new SupervisorDaemon(paths, "darwin", provider(async (_handle, _request, options) => {
      await options?.markDispatched?.(); entered.resolve(); return release!.promise;
    }), false, 60_000, undefined, {}, {
      poll: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true })),
      publish: async () => { throw new Error("no-reply must not publish"); },
    });
    const internals = daemon as unknown as {
      liveHandles: Map<string, typeof agent.handle>;
      supervisedInbox: SupervisedAgentInboxStore;
      workerBindings: { bind(input: Record<string, string>): Promise<unknown>; unbind(entryId: string): Promise<void> };
    };
    await daemon.start();
    const identities = {
      stone: { attempt: "00000000-0000-4000-8000-000000000001", execution: "00000000-0000-4000-8000-000000000011", session: "00000000-0000-4000-8000-000000000021" },
      other: { attempt: "00000000-0000-4000-8000-000000000002", execution: "00000000-0000-4000-8000-000000000012", session: "00000000-0000-4000-8000-000000000022" },
    } as const;
    for (const id of ["stone", "other"] as const) {
      const identity = identities[id];
      const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        id, room_id: id === "stone" ? "room" : "other-room", display_name: id, provider: "codex", model: null, charter: "test",
        desired_state: "running", observed_state: "working", condition: "none", permission_profile_id: null, delivery_mode: "daemon_inbox", created_by: "test", created_at: new Date().toISOString(), work_attempt_id: identity.attempt,
        provider_ref: { work_attempt_id: identity.attempt, provider_continuation_id: `${id}-thread`, provider_connection: null, execution_generation_id: identity.execution },
      } });
      assert.equal(put.ok, true, put.error);
      internals.liveHandles.set(id, { workAttemptId: identity.attempt, providerContinuationId: `${id}-thread`, pid: id === "stone" ? 1 : 2, observedState: "working" });
      await internals.workerBindings.bind({
        entry_id: id, room_id: id === "stone" ? "room" : "other-room", work_attempt_id: identity.attempt, execution_generation_id: identity.execution,
        agent_session_id: identity.session, agent_session_token: `${id}-token`, api_url: "https://letagents.test",
      });
      await internals.supervisedInbox.ingestPoll({ agent_id: id, room_id: id === "stone" ? "room" : "other-room", last_observed_message_id: "1", messages: [{ source_message_id: "msg_1", source_message: { id: "msg_1" }, activation: {} }] });
      const item = await internals.supervisedInbox.claimHead(id);
      await internals.supervisedInbox.transition(item!.inbox_item_id, "blocked", { last_error: "manual retry" });
    }
    await internals.supervisedInbox.ingestPoll({ agent_id: "other", room_id: "other-room", last_observed_message_id: "2", messages: [{ source_message_id: "msg_2", source_message: { id: "msg_2" }, activation: {} }] });
    const generation = (await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number };
    const exact = { entry_id: "stone", room_id: "room", source_message_id: "msg_1", work_attempt_id: identities.stone.attempt, execution_generation_id: identities.stone.execution, agent_session_id: identities.stone.session, daemon_generation: generation.generation };
    for (const [field, value] of Object.entries({ room_id: "wrong-room", work_attempt_id: "old-attempt", execution_generation_id: "old-generation", agent_session_id: "old-session", daemon_generation: generation.generation + 1 })) {
      const response = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", { ...exact, [field]: value });
      assert.equal(response.ok, false, `stale ${field} must reject`);
    }
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", { ...exact, source_message_id: "unknown" })).ok, false, "an unknown source row rejects");
    internals.liveHandles.delete("stone");
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", exact)).ok, false, "a missing live handle rejects");
    internals.liveHandles.set("stone", { workAttemptId: identities.stone.attempt, providerContinuationId: "stone-thread", pid: 1, observedState: "working" });
    const accepted = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", exact);
    assert.equal(accepted.ok, true, accepted.error);
    await entered.promise;
    const activeReceipt = (await internals.supervisedInbox.receipts("stone"))[0]!;
    const activeProjection = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{
      id: string;
      room_agent_state?: { turn: { state: string; inbox_item_id: string | null; source_message_id: string | null } } | null;
    }>;
    const activeTurn = activeProjection.find((entry) => entry.id === "stone")?.room_agent_state?.turn;
    assert.equal(activeTurn?.state, "responding", "only the live markDispatched edge projects an active responding turn");
    assert.equal(activeTurn?.inbox_item_id, activeReceipt.inbox_item_id);
    assert.equal(activeTurn?.source_message_id, "msg_1");
    const duplicate = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", exact);
    assert.equal(duplicate.ok, false, "a dispatching row is not retryable again");
    const listed = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{ id: string; delivery_receipts?: Array<{ state: string; source_message_id: string }> }>;
    assert.equal(listed.find((entry) => entry.id === "stone")?.delivery_receipts?.[0]?.state, "dispatching");
    const otherReceipts = listed.find((entry) => entry.id === "other")?.delivery_receipts ?? [];
    assert.equal(otherReceipts[0]?.state, "blocked", "retry targets only the selected agent row");
    assert.equal(otherReceipts[1]?.state, "queued_behind_blocked");
    assert.equal((otherReceipts[1] as { blocked_by_message_id?: string }).blocked_by_message_id, "msg_1", "projection exposes the public source ID, not a private inbox ID");
    release.resolve({ turnId: "turn", outcome: "no_reply", text: null });
    await waitForAsync(async () => (await internals.supervisedInbox.receipts("stone"))[0]?.state === "acknowledged_no_reply");
    const completed = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{ id: string; delivery_receipts?: Array<{ state: string; timeline?: Array<{ phase: string }> }> }>;
    assert.equal(completed.find((entry) => entry.id === "stone")?.delivery_receipts?.[0]?.state, "acknowledged_no_reply");
    assert.equal(completed.find((entry) => entry.id === "stone")?.delivery_receipts?.[0]?.timeline?.at(-1)?.phase, "no_reply");
    const final = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", exact);
    assert.equal(final.ok, false, "final rows cannot be retried");
    await internals.workerBindings.unbind("other");
    const missingCredential = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", { ...exact, entry_id: "other", room_id: "other-room", work_attempt_id: identities.other.attempt, execution_generation_id: identities.other.execution, agent_session_id: identities.other.session });
    assert.equal(missingCredential.ok, false, "missing binding/credential rejects");
    const waitingCredentials = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{
      id: string; room_agent_state?: { inbox: { state: string } } | null;
    }>;
    assert.equal(waitingCredentials.find((entry) => entry.id === "other")?.room_agent_state?.inbox.state, "waiting_for_desktop_credentials");
    await internals.workerBindings.bind({ entry_id: "other", room_id: "other-room", work_attempt_id: identities.other.attempt, execution_generation_id: identities.other.execution, agent_session_id: identities.other.session, agent_session_token: "other-token", api_url: "https://letagents.test" });
    const otherHead = (await internals.supervisedInbox.receipts("other"))[0]!;
    await internals.supervisedInbox.retryBlocked(otherHead.inbox_item_id);
    await internals.supervisedInbox.claimHead("other");
    await internals.supervisedInbox.transition(otherHead.inbox_item_id, "awaiting_result", { provider_turn_id: "other-turn" });
    await internals.supervisedInbox.transition(otherHead.inbox_item_id, "publishing", { outcome: JSON.stringify({ kind: "reply", text: "durable" }) });
    const publishingProjection = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{ id: string; delivery_receipts?: Array<{ state: string }> }>;
    assert.equal(publishingProjection.find((entry) => entry.id === "other")?.delivery_receipts?.[0]?.state, "publishing");
    await internals.supervisedInbox.transition(otherHead.inbox_item_id, "retryable", { last_error: "publish transport failed" });
    const retryableProjection = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{ id: string; delivery_receipts?: Array<{ state: string }> }>;
    assert.equal(retryableProjection.find((entry) => entry.id === "other")?.delivery_receipts?.[0]?.state, "retryable");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "other", desired_state: "stopped" });
    const stopped = await daemonRequest(paths.socketPath, "supervisor.retry_room_delivery", { ...exact, entry_id: "other", room_id: "other-room", work_attempt_id: identities.other.attempt, execution_generation_id: identities.other.execution, agent_session_id: identities.other.session });
    assert.equal(stopped.ok, false, "desired non-running rejects before retry");
    await daemon.stop(); daemon = null;
  } finally {
    release?.resolve({ turnId: "cleanup", outcome: "no_reply", text: null });
    await daemon?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon socket restores and skips only exact pre-turn authority without replacing the provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-restore-socket-"));
  let daemon: SupervisorDaemon | null = null;
  try {
    const paths = {
      lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"),
      manifestPath: join(root, "daemon.sqlite"), auditPath: join(root, "audit.log"),
      attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempts"),
      workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
    };
    const identity = {
      attempt: "00000000-0000-4000-8000-000000000031",
      execution: "00000000-0000-4000-8000-000000000032",
      session: "00000000-0000-4000-8000-000000000033",
    };
    const connection = {
      kind: "codex_app_server" as const,
      url: "http://127.0.0.1:43131",
      pid: 43131,
      processIdentity: "pid:43131:birth:durable",
    };
    const liveHandle = {
      workAttemptId: identity.attempt,
      providerContinuationId: "thread-missing",
      pid: connection.pid,
      providerConnection: connection,
      observedState: "idle" as const,
    };
    let repairs = 0;
    let turns = 0;
    const durableCheckpoints: string[] = [];
    daemon = new SupervisorDaemon(
      paths,
      "darwin",
      provider(
        async (handle, _request, options) => {
          turns += 1;
          assert.equal(handle, liveHandle, "repair promotes the same live provider handle");
          assert.equal(handle.pid, connection.pid);
          assert.equal(handle.providerConnection?.processIdentity, connection.processIdentity);
          await options?.checkpointTurnStarted?.("turn-after-repair");
          return { turnId: "turn-after-repair", outcome: "no_reply", text: null };
        },
        undefined,
        async (handle, request, options) => {
          repairs += 1;
          assert.equal(handle, liveHandle);
          assert.equal(request.expectedProviderContinuationId, "thread-missing");
          assert.equal(request.workAttemptId, identity.attempt);
          await options.checkpointReplacement("thread-replacement");
          liveHandle.providerContinuationId = "thread-replacement";
          return {
            handle: liveHandle,
            outcome: "replaced",
            previousProviderContinuationId: "thread-missing",
            replacementProviderContinuationId: "thread-replacement",
          };
        },
      ),
      false,
      60_000,
      undefined,
      {},
      {
        poll: ({ signal }) => new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({}), { once: true });
        }),
        publish: async () => { throw new Error("no-reply turn must not publish"); },
      },
    );
    const internals = daemon as unknown as {
      liveHandles: Map<string, typeof liveHandle>;
      supervisedInbox: SupervisedAgentInboxStore;
      workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
      durability: {
        getAttempt(id: string): Promise<{ work_attempt_id: string; checkpoints: Array<{ provider_continuation_id: string | null }> }>;
        checkpoint(id: string, input: { provider_continuation_id: string | null }): Promise<void>;
      };
    };
    await daemon.start();
    internals.durability.getAttempt = async (id) => {
      assert.equal(id, identity.attempt);
      return {
        work_attempt_id: id,
        checkpoints: durableCheckpoints.map((provider_continuation_id) => ({ provider_continuation_id })),
      };
    };
    internals.durability.checkpoint = async (id, checkpoint) => {
      assert.equal(id, identity.attempt);
      assert.ok(checkpoint.provider_continuation_id);
      durableCheckpoints.push(checkpoint.provider_continuation_id);
    };
    const put = await daemonRequest(paths.socketPath, "manifest.put", {
      entry: {
        id: "stone", room_id: "room", display_name: "Stone", provider: "codex",
        model: "gpt-5.6-sol", charter: "test", desired_state: "running",
        observed_state: "idle", condition: "none", permission_profile_id: null,
        delivery_mode: "daemon_inbox", created_by: "test", created_at: new Date().toISOString(),
        workspace_path: root, work_attempt_id: identity.attempt,
        provider_ref: {
          work_attempt_id: identity.attempt,
          provider_continuation_id: "thread-missing",
          provider_connection: connection,
          execution_generation_id: identity.execution,
        },
      },
    });
    assert.equal(put.ok, true, put.error);
    internals.liveHandles.set("stone", liveHandle);
    await internals.workerBindings.bind({
      entry_id: "stone", room_id: "room", work_attempt_id: identity.attempt,
      execution_generation_id: identity.execution, agent_session_id: identity.session,
      agent_session_token: "stone-token", api_url: "https://letagents.test",
    });
    await internals.supervisedInbox.ingestPoll({
      agent_id: "stone", room_id: "room", last_observed_message_id: "msg_1",
      messages: [{ source_message_id: "msg_1", source_message: { id: "msg_1" }, activation: {} }],
    });
    const blocked = await internals.supervisedInbox.claimHead("stone");
    await internals.supervisedInbox.transition(blocked!.inbox_item_id, "blocked", {
      failure_code: "provider_continuation_missing",
      last_error: "thread not found: 00000000-0000-4000-8000-000000000099",
    });
    const generation = (await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number };
    const exact = {
      entry_id: "stone", room_id: "room", source_message_id: "msg_1",
      work_attempt_id: identity.attempt, execution_generation_id: identity.execution,
      agent_session_id: identity.session, daemon_generation: generation.generation,
    };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.restore_agent_conversation", {
      ...exact,
      daemon_generation: generation.generation + 1,
    })).ok, false, "stale daemon generations fail before any repair side effect");

    const originalProcessIdentity = liveHandle.providerConnection.processIdentity;
    liveHandle.providerConnection = { ...connection, processIdentity: "pid:43131:birth:reused" };
    assert.equal(
      (await daemonRequest(paths.socketPath, "supervisor.restore_agent_conversation", exact)).ok,
      false,
      "changed process identity fails closed",
    );
    liveHandle.providerConnection = { ...connection, processIdentity: originalProcessIdentity };

    const concurrent = await Promise.all([
      daemonRequest(paths.socketPath, "supervisor.restore_agent_conversation", exact),
      daemonRequest(paths.socketPath, "supervisor.restore_agent_conversation", exact),
    ]);
    assert.equal(concurrent.filter((response) => response.ok).length, 1, "only one concurrent restore owns the blocked head");
    await waitForAsync(async () =>
      (await internals.supervisedInbox.receipts("stone"))[0]?.state === "acknowledged_no_reply",
    );
    const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{
      id: string;
      work_attempt_id?: string;
      provider_ref?: {
        provider_continuation_id: string;
        execution_generation_id: string;
        provider_connection: { pid: number | null; processIdentity?: string | null };
      };
    }>;
    const restored = manifest.find((entry) => entry.id === "stone")!;
    assert.equal(restored.work_attempt_id, identity.attempt);
    assert.equal(restored.provider_ref?.execution_generation_id, identity.execution);
    assert.equal(restored.provider_ref?.provider_continuation_id, "thread-replacement");
    assert.equal(restored.provider_ref?.provider_connection.pid, connection.pid);
    assert.equal(restored.provider_ref?.provider_connection.processIdentity, connection.processIdentity);
    assert.deepEqual(durableCheckpoints, ["thread-replacement"]);
    assert.equal(repairs, 1);
    assert.equal(turns, 1);

    await internals.supervisedInbox.ingestPoll({
      agent_id: "stone", room_id: "room", last_observed_message_id: "msg_2",
      messages: [{ source_message_id: "msg_2", source_message: { id: "msg_2" }, activation: {} }],
    });
    const skippable = await internals.supervisedInbox.claimHead("stone");
    await internals.supervisedInbox.transition(skippable!.inbox_item_id, "blocked", { last_error: "safe pre-turn block" });
    const skipExact = { ...exact, source_message_id: "msg_2" };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.skip_room_delivery", skipExact)).ok, true);
    assert.equal((await internals.supervisedInbox.get(skippable!.inbox_item_id))?.state, "cancelled_by_user");

    await internals.supervisedInbox.ingestPoll({
      agent_id: "stone", room_id: "room", last_observed_message_id: "msg_3",
      messages: [{ source_message_id: "msg_3", source_message: { id: "msg_3" }, activation: {} }],
    });
    const ambiguous = await internals.supervisedInbox.claimHead("stone");
    await internals.supervisedInbox.checkpointTurnStarted(ambiguous!.inbox_item_id, "turn-ambiguous");
    await internals.supervisedInbox.transition(ambiguous!.inbox_item_id, "blocked", { last_error: "ambiguous native result" });
    assert.equal(
      (await daemonRequest(paths.socketPath, "supervisor.skip_room_delivery", {
        ...exact,
        source_message_id: "msg_3",
      })).ok,
      false,
      "skip is unavailable after an exact provider turn starts",
    );

    await daemon.stop();
    daemon = null;
  } finally {
    await daemon?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovery republishes a durable publishing outcome without rerunning its provider turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-republish-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite")); const item = await enqueue(store);
    await store.transition(item.inbox_item_id, "awaiting_result", { provider_turn_id: "turn", outcome: JSON.stringify({ kind: "reply", text: "durable" }) });
    await store.transition(item.inbox_item_id, "publishing");
    let turns = 0; const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { turns += 1; throw new Error("provider must not rerun"); }), { poll: async () => ({}), publish: async ({ clientMessageId, roomId }) => { published.push(clientMessageId); return { messageId: `msg:${clientMessageId}`, roomId }; } }, currentAuthority);
    await delivery.pump(agent);
    assert.equal(turns, 0); assert.deepEqual(published, [item.reply_client_message_id]);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery treats a dispatching durable terminal outcome as republish-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-dispatch-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite")); const item = await enqueue(store);
    await store.checkpointTerminalOutcome(item.inbox_item_id, JSON.stringify({ kind: "reply", text: "durable" }));
    let turns = 0; const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { turns += 1; throw new Error("provider must not rerun"); }), { poll: async () => ({}), publish: async ({ clientMessageId, roomId }) => { published.push(clientMessageId); return { messageId: `msg:${clientMessageId}`, roomId }; } }, currentAuthority);
    await delivery.pump(agent);
    assert.equal(turns, 0); assert.deepEqual(published, [item.reply_client_message_id]);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery blocks ambiguous awaiting and retryable work instead of acknowledging it", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-ambiguous-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const first = await enqueue(store, "1"); await store.transition(first.inbox_item_id, "awaiting_result", { provider_turn_id: "turn" });
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("must not run"); }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await delivery.pump(agent);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "blocked");
    await store.close();

    const retryStore = new SupervisedAgentInboxStore(join(root, "retry.sqlite")); const retry = await enqueue(retryStore, "1");
    await retryStore.transition(retry.inbox_item_id, "awaiting_result", { provider_turn_id: "turn" }); await retryStore.transition(retry.inbox_item_id, "retryable", { last_error: "lost response" });
    const retryDelivery = new SupervisedAgentDelivery(retryStore, provider(async () => { throw new Error("must not run"); }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await retryDelivery.pump(agent);
    assert.equal((await retryStore.receipts(agent.agentId))[0]?.state, "blocked");
    await retryStore.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery reattaches only a persisted exact provider turn and blocks ambiguity without rerunning", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-exact-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-exact");
    let recoveries = 0; let newTurns = 0; const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(
      async () => { newTurns += 1; throw new Error("must not rerun"); },
      async (_handle, request) => { recoveries += 1; assert.equal(request.providerTurnId, "turn-exact"); return { turnId: "turn-exact", outcome: "reply", text: "recovered" }; },
    ), { poll: async () => ({}), publish: async (input) => { published.push(input.text); return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; } }, currentAuthority, 0);
    await delivery.pump(agent);
    assert.equal(recoveries, 1); assert.equal(newTurns, 0); assert.deepEqual(published, ["recovered"]);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
    await store.close();

    const ambiguousStore = new SupervisedAgentInboxStore(join(root, "ambiguous.sqlite"));
    const ambiguous = await enqueue(ambiguousStore);
    await ambiguousStore.checkpointTurnStarted(ambiguous.inbox_item_id, "turn-ambiguous");
    const ambiguousDelivery = new SupervisedAgentDelivery(ambiguousStore, provider(
      async () => { throw new Error("must not rerun"); },
      async () => { throw Object.assign(new Error("exact turn missing"), { roomTurnRecoveryOutcome: "ambiguous" as const }); },
    ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority, 0);
    await ambiguousDelivery.pump(agent);
    assert.equal((await ambiguousStore.receipts(agent.agentId))[0]?.state, "blocked");
    await ambiguousStore.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a terminal provider rejection blocks once without result recovery or model rerun", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-terminal-provider-failure-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    await ingest(store);
    let turns = 0;
    const delivery = new SupervisedAgentDelivery(
      store,
      provider(async (_handle, _request, options) => {
        turns += 1;
        await options?.beforeNativeDispatch?.();
        await options?.checkpointTurnStarted?.("turn-provider-rejected");
        throw Object.assign(
          new Error("Open Model request was rejected because the provider account has insufficient credit."),
          { roomTurnRecoveryOutcome: "terminal_failure" as const },
        );
      }),
      {
        poll: async () => ({}),
        publish: async () => { throw new Error("must not publish"); },
      },
      currentAuthority,
      0,
    );

    await delivery.pump(agent);

    const receipt = (await store.receipts(agent.agentId))[0];
    assert.equal(turns, 1);
    assert.equal(receipt?.state, "blocked");
    assert.match(receipt?.last_error ?? "", /insufficient credit/);
    assert.equal(
      receipt?.timeline.some((event) => event.phase === "retry_scheduled"),
      false,
    );
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a typed pre-turn missing conversation restores the same inbox item before one real turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-continuation-restore-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    await ingest(store);
    let providerInvocations = 0;
    let restorations = 0;
    const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(
      store,
      provider(async (_handle, request, options) => {
        providerInvocations += 1;
        if (providerInvocations === 1) {
          throw new ProviderActionFailure(
            "The saved provider conversation is unavailable.",
            "provider_continuation_missing",
            "thread",
          );
        }
        await options?.checkpointTurnStarted?.("turn-restored");
        return { turnId: "turn-restored", outcome: "reply", text: "restored reply" };
      }),
      {
        poll: async () => ({}),
        publish: async (input) => {
          published.push(input.clientMessageId);
          return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId };
        },
      },
      currentAuthority,
      0,
      async () => {},
      undefined,
      undefined,
      undefined,
      async ({ item }) => {
        restorations += 1;
        assert.equal(item.state, "blocked");
        assert.equal(item.failure_code, "provider_continuation_missing");
        assert.equal(item.attempt_count, 0);
        assert.equal(item.provider_turn_id, null);
        await store.retryBlocked(item.inbox_item_id);
        return "restored";
      },
    );

    await delivery.pump(agent);

    const receipt = (await store.receipts(agent.agentId))[0]!;
    assert.equal(restorations, 1);
    assert.equal(providerInvocations, 2, "the first invocation failed before native turn/start; only the successor started work");
    assert.equal(receipt.attempt_count, 1, "attempt_count advances only for the one acknowledged provider turn");
    assert.equal(receipt.state, "acknowledged");
    assert.deepEqual(published, [receipt.reply_client_message_id]);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing-conversation evidence after a turn starts never invokes automatic restoration", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-continuation-ambiguous-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    await ingest(store);
    let runInvocations = 0;
    let restorations = 0;
    const delivery = new SupervisedAgentDelivery(
      store,
      provider(async (_handle, _request, options) => {
        runInvocations += 1;
        await options?.checkpointTurnStarted?.("turn-ambiguous");
        throw new ProviderActionFailure(
          "The saved provider conversation became unavailable after turn/start.",
          "provider_continuation_missing",
          "thread",
        );
      }),
      { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } },
      currentAuthority,
      0,
      async () => {},
      undefined,
      undefined,
      undefined,
      async () => { restorations += 1; return "restored"; },
    );

    await delivery.pump(agent);

    const receipt = (await store.receipts(agent.agentId))[0]!;
    assert.equal(runInvocations, 1, "a persisted exact turn is never replaced by another model turn");
    assert.equal(restorations, 0);
    assert.equal(receipt.state, "blocked");
    assert.equal(receipt.provider_turn_id, "turn-ambiguous");
    assert.equal(receipt.attempt_count, 1);
    assert.equal(receipt.failure_code, null);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manual conversation restoration reports failure instead of falsely acknowledging the control", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-continuation-manual-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.transition(item.inbox_item_id, "blocked", {
      failure_code: "provider_continuation_missing",
      last_error: "thread not found: thread",
    });
    const delivery = new SupervisedAgentDelivery(
      store,
      provider(async () => { throw new Error("must not run"); }),
      { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } },
      currentAuthority,
      0,
      async () => {},
      undefined,
      undefined,
      undefined,
      async () => "failed",
    );

    await assert.rejects(
      delivery.restoreConversation(agent, item.source_message_id),
      /Couldn't restore this agent's provider conversation/,
    );
    assert.equal((await store.get(item.inbox_item_id))?.state, "blocked");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manual rematerialization wakes the repaired pending head without waiting for another poll", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-continuation-manual-restored-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.transition(item.inbox_item_id, "blocked", {
      failure_code: "provider_continuation_missing",
      last_error: "thread not found: 00000000-0000-0000-0000-000000000001",
    });
    let providerTurns = 0;
    let polls = 0;
    const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(
      store,
      provider(async (_handle, request, options) => {
        providerTurns += 1;
        await options?.checkpointTurnStarted?.("turn-after-rematerialization");
        return { turnId: "turn-after-rematerialization", outcome: "reply", text: "restored reply" };
      }),
      {
        poll: async () => { polls += 1; return {}; },
        publish: async (input) => {
          published.push(input.clientMessageId);
          return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId };
        },
      },
      currentAuthority,
      0,
      async () => {},
      undefined,
      undefined,
      undefined,
      async ({ item: blocked }) => {
        await store.retryBlocked(blocked.inbox_item_id);
        return "restored";
      },
    );

    await delivery.restoreConversation(agent, item.source_message_id);
    await waitForAsync(async () => (await store.get(item.inbox_item_id))?.state === "acknowledged");

    assert.equal(providerTurns, 1, "the rematerialized conversation resumes its blocked message immediately");
    assert.equal(polls, 0, "delivery does not rely on unrelated ingress to wake the pending head");
    assert.deepEqual(published, [item.reply_client_message_id]);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Stop settles the in-flight turn cancelled_by_user, suppresses its publish, and unblocks the FIFO", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-interrupt-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const turnEntered = deferred<void>();
    const turnRelease = deferred<void>();
    const published: string[] = [];
    let calls = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => {
      calls += 1;
      if (calls === 1) {
        // The first (soon-to-be-stopped) turn parks mid-flight so the Stop
        // lands while it is still dispatching, before any result is published.
        turnEntered.resolve();
        await turnRelease.promise;
        return { turnId: request.inboxItemId, outcome: "reply", text: "abandoned partial" };
      }
      return { turnId: request.inboxItemId, outcome: "reply", text: "second reply" };
    }), {
      poll: async () => ({ messages: [
        { id: "1", activation: { for_current_agent: { decision: "activate" } } },
        { id: "2", activation: { for_current_agent: { decision: "activate" } } },
      ] }),
      publish: async (input) => { published.push(input.clientMessageId); return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; },
    }, currentAuthority, 0);
    try {
      const pollPromise = delivery.poll(agent);
      await turnEntered.promise;
      assert.equal(delivery.activeTurn(agent)?.sourceMessageId, "1", "the first message is the in-flight turn");

      const settled = await delivery.interruptActiveDelivery(agent);
      assert.equal(settled, "settled", "an in-flight pre-publish turn is settled by the interrupt");
      const afterInterrupt = await store.receipts(agent.agentId);
      assert.equal(afterInterrupt.find((receipt) => receipt.source_message_id === "1")?.state, "cancelled_by_user");

      // Release the abandoned turn and let the FIFO advance to the next item.
      turnRelease.resolve();
      await pollPromise;

      const receipts = await store.receipts(agent.agentId);
      assert.equal(receipts.find((receipt) => receipt.source_message_id === "1")?.state, "cancelled_by_user", "the stopped turn stays cancelled");
      assert.equal(receipts.find((receipt) => receipt.source_message_id === "2")?.state, "acknowledged", "the queue is not wedged: the next item delivers");
      assert.equal(published.length, 1, "exactly one reply was published — never the stopped turn's");
      assert.equal(calls, 2, "the stopped turn was not rerun; only the next item ran a fresh turn");
    } finally { await delivery.fenceAndDrain().catch(() => undefined); }
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Stop that races a committed publication loses: the reply stands and the turn is not settled", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-interrupt-publish-race-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const publishEntered = deferred<void>();
    const publishRelease = deferred<void>();
    const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => ({ turnId: request.inboxItemId, outcome: "reply", text: "final reply" })), {
      poll: async () => ({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] }),
      publish: async (input) => { publishEntered.resolve(); await publishRelease.promise; published.push(input.clientMessageId); return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; },
    }, currentAuthority, 0);
    try {
      const pollPromise = delivery.poll(agent);
      await publishEntered.promise; // the turn has already committed to publishing

      const settled = await delivery.interruptActiveDelivery(agent);
      assert.equal(settled, "published", "once publishing has committed, the interrupt loses the race");
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "publishing", "the committed publication is left authoritative");

      publishRelease.resolve();
      await pollPromise;
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged", "the publication completes to acknowledged");
      assert.equal(published.length, 1, "the reply is published exactly once");
    } finally { await delivery.fenceAndDrain().catch(() => undefined); }
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("interruptActiveDelivery reports no_active_turn when no daemon turn is running", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-no-active-turn-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      poll: async () => ({}), publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority, 0);
    try {
      // No turn has ever run for this agent, so there is nothing to interrupt.
      // This is the mcp_polling / idle case: the caller must NOT downgrade the
      // provider's own native interrupt on the strength of a daemon settlement.
      assert.equal(await delivery.interruptActiveDelivery(agent), "no_active_turn");
    } finally { await delivery.fenceAndDrain().catch(() => undefined); }
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed durable cancellation neither aborts the turn nor strands the FIFO", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cancel-failure-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    // A transient cancellation failure must propagate WITHOUT aborting the turn,
    // so the in-flight deliver() stays the sole consumer able to settle it.
    const realCancel = store.cancelInterruptedTurn.bind(store);
    let failCancel = true;
    store.cancelInterruptedTurn = async (inboxItemId: string, detail?: string) => {
      if (failCancel) throw new Error("transient sqlite failure");
      return realCancel(inboxItemId, detail);
    };
    const turnEntered = deferred<void>();
    const turnRelease = deferred<void>();
    const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => {
      turnEntered.resolve();
      await turnRelease.promise;
      return { turnId: request.inboxItemId, outcome: "reply", text: "completed after the failed stop" };
    }), {
      poll: async () => ({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] }),
      publish: async (input) => { published.push(input.clientMessageId); return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; },
    }, currentAuthority, 0);
    try {
      const pollPromise = delivery.poll(agent);
      await turnEntered.promise;
      // The durable cancellation fails; the interrupt must reject and must not abort.
      await assert.rejects(delivery.interruptActiveDelivery(agent), /transient sqlite failure/);
      assert.ok(delivery.activeTurn(agent), "the in-flight turn is still the live consumer after a failed cancellation");
      // The turn finishes and publishes normally: the head reaches a terminal
      // state instead of being stranded with no consumer.
      failCancel = false;
      turnRelease.resolve();
      await pollPromise;
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged", "the head settles rather than stalling the FIFO");
      assert.equal(published.length, 1);
    } finally { await delivery.fenceAndDrain().catch(() => undefined); }
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Stop that loses to an interrupt-rejection retryable still settles — it is not reported published and the turn does not rerun", async () => {
  // claude-code's native interrupt REJECTS the in-flight turn, so deliver()'s
  // catch can commit `retryable` before the Stop's settlement lands. The Stop
  // must still settle that head cancelled_by_user (not map it to "published"),
  // and the stopped turn must NOT be re-dispatched.
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-retryable-race-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const published: string[] = [];
    let calls = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => {
      calls += 1;
      if (calls === 1) throw new Error(`Claude bounded room turn ${request.inboxItemId} failed: Claude command ended interrupted.`);
      return { turnId: request.inboxItemId, outcome: "reply", text: "rerun reply after the Stop" };
    }), {
      poll: async () => ({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] }),
      publish: async (input) => { published.push(input.clientMessageId); return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; },
    }, currentAuthority, 200 /* catch sleeps here between retryable and pending */);
    try {
      const pollPromise = delivery.poll(agent);
      await waitForAsync(async () => (await store.receipts(agent.agentId)).find((receipt) => receipt.source_message_id === "1")?.state === "retryable");
      const settlement = await delivery.interruptActiveDelivery(agent);
      assert.equal(settlement, "settled", "a retryable (pre-publish) head is settled by the Stop, not called published");
      assert.equal((await store.receipts(agent.agentId)).find((receipt) => receipt.source_message_id === "1")?.state, "cancelled_by_user");
      await pollPromise;
      assert.equal(calls, 1, "the natively-interrupted turn is NOT rerun after the Stop");
      assert.equal(published.length, 0, "and nothing is published for the stopped turn");
    } finally { await delivery.fenceAndDrain().catch(() => undefined); }
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
