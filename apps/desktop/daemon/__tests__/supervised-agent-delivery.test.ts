import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderActionPort } from "../provider-action-port.js";
import { SupervisorDaemon } from "../main.js";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";

const agent = {
  agentId: "stone", roomId: "room", provider: "codex", apiUrl: "https://letagents.test", agentSessionId: "session-1", bearer: "memory", executionGenerationId: "generation-1", daemonGeneration: 1,
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

test("the supervised runtime continuously polls and delivers a later activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-loop-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const secondPoll = deferred<void>(); let polls = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => ({ turnId: request.inboxItemId, outcome: "no_reply", text: null })), {
      poll: ({ signal }) => {
        polls += 1;
        if (polls === 1) return Promise.resolve({ last_observed_message_id: "1", messages: [{ id: "1", activation: { for_current_agent: {} } }] });
        if (polls === 2) {
          secondPoll.resolve();
          return Promise.resolve({ last_observed_message_id: "2", messages: [{ id: "2", activation: { for_current_agent: {} } }] });
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
        if (polls === 2) return Promise.resolve({ last_observed_message_id: "1", messages: [{ id: "1", activation: { for_current_agent: {} } }] });
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
    const controller = internals.loopControllers.get(agent.agentId)!;
    await waitFor(() => !internals.loops.has(agent.agentId));
    assert.equal(polls, 15);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fence aborts a pending error backoff and releases its listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-backoff-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      poll: async () => { throw new Error("outage"); },
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);
    const internals = delivery as unknown as { loopControllers: Map<string, AbortController> };
    void delivery.start(agent);
    const controller = internals.loopControllers.get(agent.agentId)!;
    await waitFor(() => getEventListeners(controller.signal, "abort").length === 1);
    const started = Date.now();
    await delivery.fenceAndDrain();
    assert.ok(Date.now() - started < 100, "fence should not wait for the 250ms backoff timer");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
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
      publish: async () => { published += 1; },
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
      publish: async () => { published += 1; },
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
