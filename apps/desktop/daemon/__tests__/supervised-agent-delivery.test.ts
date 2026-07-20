import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderActionPort } from "../provider-action-port.js";
import { SupervisorDaemon } from "../main.js";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";

const agent = {
  agentId: "stone", roomId: "room", apiUrl: "https://letagents.test", agentSessionId: "session-1", bearer: "memory", executionGenerationId: "generation-1",
  handle: { workAttemptId: "attempt", providerContinuationId: "thread", pid: 1, observedState: "working" as const },
};
const currentAuthority = async () => true;
const provider = (runRoomTurn: NonNullable<ProviderActionPort["runRoomTurn"]>) => ({
  capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true, turnControl: "unsupported" as const }),
  spawn: async () => { throw new Error("not used"); }, attach: async () => null, attachAction: async () => ({ state: "absent" as const }), resume: async () => { throw new Error("not used"); }, poke: async () => {}, stop: async () => ({ endedAt: "", exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: null }), onExit: async () => () => {}, runRoomTurn,
} satisfies ProviderActionPort);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
      poll: async (input) => { polls.push(input); return { last_observed_message_id: "1", messages: [{ id: "1", activation: { for_current_agent: { reason: "server" } }, text: "hi" }, { id: "2", text: "ignored" }] }; },
      publish: async (input) => { published.push(input.clientMessageId); },
    }, currentAuthority, 0);
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
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: `turn:${++turns}`, outcome: "reply", text: "durable" })), { poll: async () => ({ last_observed_message_id: "1", messages: [{ id: "1", activation: { for_current_agent: {} } }] }), publish: async () => { if (++publishes === 1) throw new Error("crash before ack"); } }, currentAuthority, 0);
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
      poll: ({ signal }) => new Promise((resolve) => { entered.resolve(); signal.addEventListener("abort", () => { aborted = true; resolve({ last_observed_message_id: "1", messages: [{ id: "1", activation: { for_current_agent: {} } }] }); }, { once: true }); }),
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);
    const poll = delivery.poll(agent); await entered.promise;
    await delivery.fenceAndDrain(); await poll;
    assert.equal(aborted, true);
    assert.equal((await store.receipts(agent.agentId)).length, 0, "a fenced poll cannot ingest after its await");
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
    assert.deepEqual(seen.at(-1), { agentId: "stone", roomId: "room", agentSessionId: "session-1", bearer: "memory", workAttemptId: "attempt", executionGenerationId: "generation-1" });
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
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
    await drain; await retry;
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "blocked");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery republishes a durable publishing outcome without rerunning its provider turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-republish-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite")); const item = await enqueue(store);
    await store.transition(item.inbox_item_id, "awaiting_result", { provider_turn_id: "turn", outcome: JSON.stringify({ kind: "reply", text: "durable" }) });
    await store.transition(item.inbox_item_id, "publishing");
    let turns = 0; const published: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { turns += 1; throw new Error("provider must not rerun"); }), { poll: async () => ({}), publish: async ({ clientMessageId }) => { published.push(clientMessageId); } }, currentAuthority);
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
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { turns += 1; throw new Error("provider must not rerun"); }), { poll: async () => ({}), publish: async ({ clientMessageId }) => { published.push(clientMessageId); } }, currentAuthority);
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
