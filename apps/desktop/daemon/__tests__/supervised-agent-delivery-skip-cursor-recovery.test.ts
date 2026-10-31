import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import {
  agent,
  currentAuthority,
  TEST_PROVIDER_TURN_AUTHORITY,
  provider,
  deferred,
  waitFor,
  waitForAsync,
  enqueue,
  ingest,
  writeAgentRuntime,
} from "./helpers/supervised-agent-delivery-fixture.js";

test("Skip moves past a finished turn that stays unreadable after Pause and Resume, without rerunning it", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-skip-started-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const runs: string[] = []; let recoveries = 0;
  const reread = deferred<void>(); let holdReread = false;
  const published: string[] = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    const id = String((request.sourceMessage as { id?: string }).id);
    runs.push(id);
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.(`turn-${id}`);
    return id === "1"
      ? { turnId: "turn-1", outcome: "unreadable", text: null, evidence: "none" }
      : { turnId: `turn-${id}`, outcome: "reply", text: "Second message answered.", evidence: "transcript" };
  }, async () => {
    recoveries += 1;
    if (holdReread) await reread.promise;
    return { turnId: "turn-1", outcome: "unreadable", text: null, evidence: "none" };
  }), {
    poll: async () => ({}),
    publish: async (input) => { published.push(input.text); return { messageId: `reply-${published.length}`, roomId: input.roomId }; },
  }, currentAuthority);
  try {
    await ingest(store, "1"); await ingest(store, "2");
    await delivery.pump(agent);
    assert.deepEqual((await store.receipts(agent.agentId)).map((item) => item.receipt_state), ["blocked", "queued_behind_blocked"]);

    // Pause and Resume start a new runtime generation for the same agent.
    const resumed = { ...agent, executionGenerationId: "generation-2", daemonGeneration: 2 };
    // While Retry is re-reading the turn, the message is not blocked and cannot be skipped.
    holdReread = true;
    await delivery.retry(resumed, "1");
    await waitFor(() => recoveries === 2);
    await assert.rejects(delivery.skipMessage(resumed, "1"), /no longer available/);
    reread.resolve();
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]!.state === "blocked");

    await delivery.skipMessage(resumed, "1");
    await waitForAsync(async () => (await store.receipts(agent.agentId))[1]?.state === "acknowledged");
    const [skipped] = await store.receipts(agent.agentId);
    assert.equal(skipped!.state, "cancelled_by_user");
    assert.equal(skipped!.timeline.at(-1)?.phase, "user_cancelled");
    assert.deepEqual(runs, ["1", "2"], "the finished turn is never rerun");
    assert.equal(recoveries, 3, "Skip itself never reads or runs the provider");
    assert.deepEqual(published, ["Second message answered."]);
    await assert.rejects(delivery.retry(resumed, "1"), /no longer available/);
  } finally {
    reread.resolve();
    await delivery.fenceAndDrain(); await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Skip refuses a started turn that may still run in the agent's conversation, and accepts it once that conversation is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-skip-running-"));
  const path = join(root, "daemon.sqlite");
  const store = new SupervisedAgentInboxStore(path);
  let runs = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    runs += 1;
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("turn-1");
    throw Object.assign(new Error("The provider turn's result could not be established."), { roomTurnRecoveryOutcome: "ambiguous" });
  }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
  try {
    await writeAgentRuntime(path, agent.providerContinuationId);
    await ingest(store);
    await delivery.pump(agent);
    assert.equal((await store.receipts(agent.agentId))[0]!.state, "blocked");
    await assert.rejects(delivery.skipMessage(agent, "1"), /may still be running/);
    // A fresh start records a new conversation for the agent.
    await writeAgentRuntime(path, "thread-2");
    await delivery.skipMessage({ ...agent, providerContinuationId: "thread-2", handle: { ...agent.handle, providerContinuationId: "thread-2" } }, "1");
    assert.equal((await store.receipts(agent.agentId))[0]!.state, "cancelled_by_user");
    assert.equal(runs, 1);
  } finally {
    await delivery.fenceAndDrain(); await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Skip refuses a row this process is still delivering, even if the row already reads as blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-skip-live-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let delivery!: SupervisedAgentDelivery;
  let refusal: unknown = null;
  delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("turn-1");
    // Another writer marked the row blocked while this delivery still owns it.
    await store.transition(request.inboxItemId, "blocked", { last_error: "blocked under a live delivery" });
    refusal = await delivery.skipMessage(agent, "1").then(() => null, (error: unknown) => error);
    return { turnId: "turn-1", outcome: "no_reply", text: null };
  }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
  try {
    await ingest(store);
    await delivery.pump(agent);
    assert.match(refusal instanceof Error ? refusal.message : String(refusal), /still being delivered/);
    assert.notEqual((await store.receipts(agent.agentId))[0]!.state, "cancelled_by_user");
  } finally {
    await delivery.fenceAndDrain(); await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const initialState of ["dispatching", "result_recovery"] as const) test(`exact result recovery from ${initialState} uses its own bounded backoff`, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-result-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-unreadable", TEST_PROVIDER_TURN_AUTHORITY);
    if (initialState === "result_recovery") {
      await store.transition(item.inbox_item_id, "awaiting_result", { provider_turn_id: "turn-unreadable" });
      await store.transition(item.inbox_item_id, "result_recovery", { outcome: JSON.stringify({ kind: "unreadable", text: null, evidence: "none" }) });
    }
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
    assert.equal(receipt.provider_turn_id, "turn-unreadable", "recovery never clears its native turn");
    assert.equal(receipt.attempt_count, 1, "recovery failures are not new model turns");
    assert.equal(receipt.timeline.filter((event) => event.phase === "retry_scheduled").length, 3);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unreadable completed turn is re-read, not rerun, and publishes the answer the re-read finds", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-transient-unreadable-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let runs = 0; let recoveries = 0;
  const published: string[] = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    runs += 1;
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("turn-1");
    return { turnId: "turn-1", outcome: "unreadable", text: null, evidence: "none" };
  }, async (_handle, request) => {
    recoveries += 1;
    assert.equal(request.providerTurnId, "turn-1");
    return { turnId: "turn-1", outcome: "reply", text: "Found on the re-read.", evidence: "transcript" };
  }), {
    poll: async () => ({}),
    publish: async (input) => { published.push(input.text); return { messageId: "reply-1", roomId: input.roomId }; },
  }, currentAuthority);
  try {
    await ingest(store);
    await delivery.pump(agent);
    const receipt = (await store.receipts(agent.agentId))[0]!;
    assert.equal(receipt.state, "acknowledged");
    assert.deepEqual(published, ["Found on the re-read."]);
    assert.equal(runs, 1); assert.equal(recoveries, 1);
    assert.equal(receipt.attempt_count, 1, "a re-read is not a new model turn");
    assert.ok(receipt.timeline.some((event) => event.phase === "result_unreadable"));
  } finally {
    await delivery.fenceAndDrain(); await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("each re-block of a still unreadable turn is recorded, including after Retry delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-reblock-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let runs = 0; let recoveries = 0;
  /** What each reading back was told: whether the daemon has the turn saved as completed with no readable answer. */
  const saidSavedAsUnreadable: Array<boolean | undefined> = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    runs += 1;
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("turn-1");
    return { turnId: "turn-1", outcome: "unreadable", text: null, evidence: "none" };
  }, async (_handle, request) => {
    recoveries += 1;
    saidSavedAsUnreadable.push(request.savedAsUnreadable);
    return { turnId: "turn-1", outcome: "unreadable", text: null, evidence: "none" };
  }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
  try {
    await ingest(store);
    await delivery.pump(agent);
    const blockedEvents = async () => (await store.receipts(agent.agentId))[0]!.timeline
      .filter((event) => event.phase === "blocked");
    assert.equal((await store.receipts(agent.agentId))[0]!.state, "blocked");
    assert.equal((await blockedEvents()).length, 1);

    await delivery.retry(agent, "1");
    await waitForAsync(async () => (await blockedEvents()).length === 2);
    const receipt = (await store.receipts(agent.agentId))[0]!;
    assert.equal(receipt.state, "blocked");
    assert.deepEqual(receipt.timeline.slice(-4).map((event) => event.phase),
      ["blocked", "queued", "result_unreadable", "blocked"]);
    assert.match(receipt.timeline.at(-1)!.detail ?? "", /No new model turn was started/);
    assert.equal(runs, 1, "Retry re-reads the completed turn and never reruns it");
    assert.equal(recoveries, 3);
    assert.deepEqual(saidSavedAsUnreadable, [true, undefined, true],
      "a second look at a turn saved as unreadable says so; the first look after Retry delivery is not one");
    assert.equal(receipt.attempt_count, 1);
    assert.equal(receipt.provider_turn_id, "turn-1");
  } finally {
    await delivery.fenceAndDrain(); await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh agent observes history at the tail, advances across silent messages, and dispatches only exact activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-bootstrap-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const dispatched: string[] = [];
    const cursors: Array<string | null> = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      await options?.beforeNativeDispatch?.();
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
    const detail = await store.detail(agent.agentId, agent.roomId, "101");
    assert.deepEqual(detail.prepared_context?.messages.map(message => message.id), ["100", "101"]);
    assert.equal(detail.prepared_context?.messages[0]?.text, "ordinary room context");
    assert.equal((await store.cursor(agent.agentId))?.last_observed_message_id, "101");
    assert.deepEqual((await store.receipts(agent.agentId)).map((item) => item.source_message_id), ["101"]);
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a sequenced turn sees a held correction as context without consuming its later activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-fresh-context-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const source = { id: "msg_183", text: "Original borrowing proposal", activation: { for_current_agent: {
    decision: "activate", reason: "broadcast", turn: { position: 2, count: 2, prior_speakers: [] } } } };
  const correction = { id: "msg_189", text: "Browse only. Do not collect contact details." };
  const fresh = [{ id: "msg_183", text: "Edited original question" }, correction];
  const dispatched: string[] = [];
  let released = false;
  let reads = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    dispatched.push(request.sourceMessage.id as string);
    if (request.sourceMessage.id === "msg_183") {
      assert.equal(request.sourceMessage.text, source.text, "the admitted source remains immutable");
      assert.deepEqual(request.observedContext, fresh, "fresh context retains the newer edit and correction");
      assert.equal((await store.cursor(agent.agentId))?.last_observed_message_id, "msg_183");
      assert.deepEqual((await store.receipts(agent.agentId)).map(row => row.source_message_id), ["msg_183"]);
    }
    return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
  }), {
    context: async () => { reads++; return fresh; },
    poll: async ({ afterMessageId }) => ({ messages: !afterMessageId ? [source]
      : released && afterMessageId === "msg_183" ? [{ ...correction, activation: source.activation }] : [] }),
    publish: async () => { throw new Error("no reply expected"); },
  }, currentAuthority, 0);
  try {
    await delivery.poll(agent);
    assert.deepEqual(dispatched, ["msg_183"]);
    assert.equal(reads, 1);
    assert.deepEqual((await store.detail(agent.agentId, agent.roomId, "msg_183")).prepared_context?.messages.map(row => row.id), ["msg_183", "msg_189"]);
    await delivery.poll(agent);
    assert.deepEqual(dispatched, ["msg_183"], "observation did not authorize another turn");
    released = true;
    await delivery.poll(agent);
    await delivery.poll(agent);
    assert.deepEqual(dispatched, ["msg_183", "msg_189"], "normal activation still runs exactly once");
    assert.equal(reads, 2);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("fresh context is not fetched again while recovering an existing native result", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-context-recovery-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let reads = 0;
  let runs = 0;
  let recoveries = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    runs++;
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("saved-turn");
    return { turnId: "saved-turn", outcome: "unreadable", text: null, evidence: "none" };
  }, async () => {
    recoveries++;
    return { turnId: "saved-turn", outcome: "no_reply", text: null, evidence: "transcript" };
  }), {
    context: async () => { reads++; assert.equal(reads, 1); return [{ id: "msg_189", text: "A correction" }]; },
    poll: async ({ afterMessageId }) => ({ messages: afterMessageId ? [] : [{ id: "msg_183", text: "Question",
      activation: { for_current_agent: { decision: "activate", reason: "broadcast",
        turn: { position: 1, count: 2, prior_speakers: [] } } } }] }),
    publish: async () => { throw new Error("no reply expected"); },
  }, currentAuthority, 0);
  try {
    await delivery.poll(agent);
    assert.equal(reads, 1);
    assert.equal(runs, 1);
    assert.equal(recoveries, 1);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["failure", "authority-lost", "stop", "unsupported", "independent"] as const) test(`fresh context: ${mode} before provider admission`, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-context-boundary-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let allowed = true;
  let runs = 0;
  let reads = 0;
  let yields = 0;
  let yieldObservation: unknown;
  const entered = deferred<void>();
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    runs++;
    assert.equal(request.observedContext?.[0]?.text, "Existing observation");
    return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
  }), {
    context: async ({ signal }) => {
      reads++;
      if (mode === "failure") throw new Error("Context temporarily unavailable");
      if (mode === "authority-lost") allowed = false;
      if (mode === "stop") {
        entered.resolve();
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return mode === "unsupported" ? null : [];
    },
    poll: async ({ afterMessageId }) => ({ messages: afterMessageId ? [] : [{ id: "msg_183", text: "Existing observation",
      activation: { for_current_agent: { decision: "activate", reason: "broadcast",
        ...(mode === "independent" ? {} : { turn: { position: 1, count: 2, prior_speakers: [] } }) } } }] }),
    publish: async () => { throw new Error("no reply expected"); },
    yieldReplyTurn: async input => {
      yields++;
      const row = await store.getBySourceMessage(agent.agentId, agent.roomId, input.sourceMessageId);
      yieldObservation = { state: row?.state, providerTurnId: row?.provider_turn_id,
        outcome: row?.outcome, bearer: input.bearer, source: input.sourceMessageId };
      throw new Error("yield upload unavailable");
    },
  }, async () => allowed, 60_000);
  try {
    const pending = delivery.poll(agent);
    if (mode === "stop") { await entered.promise; await delivery.fenceAndDrain(); }
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, mode === "independent" ? 0 : mode === "failure" ? 3 : 1, "uses the existing bounded pre-dispatch retry budget");
    assert.equal(runs, mode === "unsupported" || mode === "independent" ? 1 : 0);
    assert.equal(yields, mode === "failure" ? 1 : 0, "only exhausted unstarted work yields; transport failure is not a provider retry");
    if (mode === "failure") {
      assert.deepEqual(yieldObservation, { state: "blocked", providerTurnId: null,
        outcome: null, bearer: agent.bearer, source: "msg_183" });
      const row = (await store.receipts(agent.agentId))[0]!;
      assert.equal(row.provider_turn_id, null);
      assert.equal(row.attempt_count, 0, "a failed read did not spend a model attempt");
      assert.match(row.last_error ?? "", /Context temporarily unavailable/);
    }
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a blocked preparation yield stays tracked through Stop and preserves retryable work", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-yield-drain-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const reporting = deferred<void>(), aborted = deferred<void>(), cleanup = deferred<void>();
  let runs = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async () => {
    runs++; throw new Error("no model should start");
  }), {
    context: async () => { throw new Error("offline"); }, poll: async () => ({}), publish: async () => {},
    yieldReplyTurn: async ({ signal }) => {
      reporting.resolve();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
      await cleanup.promise;
    },
  }, currentAuthority, 0);
  try {
    await ingest(store, "msg_81", { turn: { position: 1, count: 2, prior_speakers: [] } });
    await delivery.pump(agent);
    await reporting.promise;
    let drained = false;
    const stopping = delivery.fenceAndDrain().then(() => { drained = true; });
    await aborted.promise;
    assert.equal(drained, false, "handoff waits for the tracked request cleanup");
    cleanup.resolve(); await stopping;
    const row = await store.getBySourceMessage(agent.agentId, agent.roomId, "msg_81");
    assert.equal(row?.state, "blocked");
    assert.equal(row.attempt_count, 0);
    assert.equal(runs, 0);
  } finally { cleanup.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
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

test("a server-hidden prompt advances the durable daemon cursor without entering FIFO", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-hidden-prompt-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    await store.bootstrapCursor({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: "20" });
    const after: Array<string | null> = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async () => {
      throw new Error("a hidden prompt must not create paid work");
    }), {
      poll: async ({ afterMessageId }) => {
        after.push(afterMessageId);
        return { messages: [], last_observed_message_id: "21" };
      },
      publish: async () => {},
    }, currentAuthority, 0);
    await delivery.poll(agent);
    assert.deepEqual(after, ["20"]);
    assert.equal((await store.cursor(agent.agentId))?.last_observed_message_id, "21");
    assert.deepEqual(await store.receipts(agent.agentId), []);
    await delivery.fenceAndDrain(); await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uncertain native dispatch without a durable turn id blocks instead of replaying, including after restart", async (t) => {
  for (const candidate of ["codex", "open-model"]) {
    for (const failure of ["lost acknowledgement", "failed checkpoint"]) {
      await t.test(`${candidate}: ${failure}`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "letagents-delivery-uncertain-dispatch-"));
        const databasePath = join(root, "daemon.sqlite");
        let store = new SupervisedAgentInboxStore(databasePath);
        const currentAgent = { ...agent, provider: candidate };
        let runs = 0;
        let recoveries = 0;
        const adapter = provider(async (_handle, _request, options) => {
          runs += 1;
          await options?.beforeNativeDispatch?.();
          // Both providers may admit native work before the daemon can save
          // its exact recovery key. Neither failure proves the prompt unsent.
          if (failure === "failed checkpoint") await options?.checkpointTurnStarted?.("native-turn");
          throw new Error("native dispatch acknowledgement was lost");
        }, async () => {
          recoveries += 1;
          throw new Error("no exact durable turn exists to recover");
        });
        const transport = { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } };
        let delivery = new SupervisedAgentDelivery(store, adapter, transport, currentAuthority, 0, async () => {});
        try {
          if (failure === "failed checkpoint") {
            t.mock.method(store, "checkpointTurnStarted", async () => { throw new Error("checkpoint write failed"); });
          }
          await delivery.pump(currentAgent);
          await ingest(store, "1");
          await ingest(store, "2");
          await delivery.pump(currentAgent);
          assert.equal(runs, 1, "an uncertain native send must not be automatically sent again");
          assert.equal(recoveries, 0);
          const receipts = await store.receipts(agent.agentId);
          assert.deepEqual(receipts.map((receipt) => receipt.receipt_state), ["blocked", "queued_behind_blocked"]);
          assert.equal(receipts[0]?.provider_turn_id, null);
          assert.match(receipts[0]?.last_error ?? "", /may have started/);

          await delivery.fenceAndDrain();
          await store.close();
          store = new SupervisedAgentInboxStore(databasePath);
          delivery = new SupervisedAgentDelivery(store, adapter, transport, currentAuthority, 0, async () => {});
          await delivery.pump({ ...currentAgent, daemonGeneration: 2 });
          assert.equal(runs, 1, "a replacement daemon preserves the ambiguity instead of replaying");
          assert.equal(recoveries, 0);
          assert.deepEqual((await store.receipts(agent.agentId)).map((receipt) => receipt.receipt_state), ["blocked", "queued_behind_blocked"]);
        } finally {
          await delivery.fenceAndDrain();
          await store.close();
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});

test("a generic failure after an exact turn checkpoint recovers that turn without resending", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-exact-recovery-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let runs = 0;
  const recovered: string[] = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    runs += 1;
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("native-turn");
    throw new Error("control connection interrupted after the exact turn was saved");
  }, async (_handle, request) => {
    recovered.push(request.providerTurnId);
    return { turnId: request.providerTurnId, outcome: "no_reply", text: null };
  }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority, 0, async () => {});
  try {
    await delivery.pump(agent);
    await ingest(store);
    await delivery.pump(agent);
    assert.equal(runs, 1);
    assert.deepEqual(recovered, ["native-turn"]);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
  } finally {
    await delivery.fenceAndDrain();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("publication exhausts only its own budget and explicit Retry reuses the saved reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-retry-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    let turns = 0; let publishes = 0; const clientIds: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: `turn:${++turns}`, outcome: "reply", text: "durable" })), {
      poll: async () => ({}), publish: async (input) => {
        clientIds.push(input.clientMessageId);
        if (++publishes <= 3) throw new Error("crash before ack");
        return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId };
      },
    }, currentAuthority, 0);
    await delivery.pump(agent); await ingest(store); await delivery.pump(agent);
    assert.equal(turns, 1); assert.equal(publishes, 3);
    const blocked = (await store.receipts("stone"))[0]!;
    assert.equal(blocked.state, "blocked");
    assert.equal(JSON.parse(blocked.outcome!).text, "durable");
    await delivery.retry(agent, "1");
    await waitForAsync(async () => (await store.receipts("stone"))[0]?.state === "acknowledged");
    assert.equal(turns, 1); assert.equal(publishes, 4, "manual Retry admits an attempt without erasing durable debt");
    assert.deepEqual(clientIds, Array(4).fill(blocked.reply_client_message_id));
    assert.equal((await store.receipts("stone"))[0]?.state, "acknowledged");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a normalized no-reply terminal survives partial provider-journal retirement in live delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-no-reply-retirement-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    let runs = 0;
    let recoveries = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(
      async (_handle, request, options) => {
        runs += 1;
        const terminal = {
          turnId: `cursor:${request.inboxItemId}`, outcome: "no_reply" as const, text: null,
        };
        await options?.checkpointTurnStarted?.(terminal.turnId);
        await store.checkpointNormalizedTerminal({
          inbox_item_id: request.inboxItemId,
          agent_id: agent.agentId,
          execution_generation_id: agent.executionGenerationId,
          provider_turn_id: terminal.turnId,
          outcome: "no_reply",
          text: null,
          evidence: "stream",
          terminal_evidence: terminal,
        });
        throw new Error("provider terminal journal was partially retired after normalized checkpoint");
      },
      async () => {
        recoveries += 1;
        throw new Error("normalized no-reply must bypass provider recovery");
      },
    ), {
      poll: async () => ({}),
      publish: async () => { throw new Error("no-reply delivery must not publish"); },
    }, currentAuthority, 0);
    await delivery.pump({ ...agent, provider: "cursor" });
    const settled = await store.get(item.inbox_item_id);
    assert.equal(settled?.state, "acknowledged_no_reply");
    assert.equal(runs, 1);
    assert.equal(recoveries, 0, "the durable normalized terminal outranks a partially deleted provider journal");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a normalized no-reply terminal survives partial provider-journal retirement during exact recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-no-reply-recovery-retirement-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "cursor:recover-no-reply", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(item.inbox_item_id, "awaiting_result");
    await store.transition(item.inbox_item_id, "result_recovery", {
      outcome: JSON.stringify({ kind: "unreadable", text: null, evidence: "none" }),
    });
    await store.recordRetryFailure(item.inbox_item_id, { domain: "result_recovery", error: "prior recovery failure one" });
    await store.recordRetryFailure(item.inbox_item_id, { domain: "result_recovery", error: "prior recovery failure two" });
    let recoveries = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(
      async () => { throw new Error("must not start a new turn"); },
      async (_handle, request, options) => {
        recoveries += 1;
        const terminal = {
          turnId: request.providerTurnId, outcome: "no_reply" as const, text: null,
        };
        assert.ok(options?.checkpointTerminalResult, "recovery exposes the same normalized-terminal checkpoint contract");
        await store.checkpointNormalizedTerminal({
          inbox_item_id: item.inbox_item_id,
          agent_id: agent.agentId,
          execution_generation_id: agent.executionGenerationId,
          provider_turn_id: terminal.turnId,
          outcome: "no_reply",
          text: null,
          evidence: "stream",
          terminal_evidence: terminal,
        });
        throw new Error("recovery terminal journal was partially retired after normalized checkpoint");
      },
    ), {
      poll: async () => ({}),
      publish: async () => { throw new Error("no-reply delivery must not publish"); },
    }, currentAuthority, 0);
    await delivery.pump({ ...agent, provider: "cursor" });
    assert.equal((await store.get(item.inbox_item_id))?.state, "acknowledged_no_reply");
    assert.equal(recoveries, 1, "the first exact recovery checkpoints once; its partial cleanup failure is not retried");
    assert.equal((await store.receipts(agent.agentId))[0]?.timeline.filter((event) => event.phase === "retry_scheduled").length, 2,
      "accepted no-reply does not spend the last recovery retry on provider-journal cleanup");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const cleanupFails of [false, true]) test(`a saved reply has its own publication budget after recovery (cleanup fails: ${cleanupFails})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-reply-recovery-retirement-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, `daemon-${cleanupFails}.sqlite`));
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "cursor:recover-reply", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(item.inbox_item_id, "awaiting_result");
    await store.transition(item.inbox_item_id, "result_recovery", {
      outcome: JSON.stringify({ kind: "unreadable", text: null, evidence: "none" }),
    });
    await store.recordRetryFailure(item.inbox_item_id, { domain: "result_recovery", error: "prior reply recovery failure one" });
    await store.recordRetryFailure(item.inbox_item_id, { domain: "result_recovery", error: "prior reply recovery failure two" });
    let recoveries = 0;
    const published: string[] = [];
    const clientIds: string[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(
      async () => { throw new Error("must not start a new turn"); },
      async (_handle, request) => {
        recoveries += 1;
        const terminal = { turnId: request.providerTurnId, outcome: "reply" as const, text: "Durable normalized reply." };
        await store.checkpointNormalizedTerminal({
          inbox_item_id: item.inbox_item_id,
          agent_id: agent.agentId,
          execution_generation_id: agent.executionGenerationId,
          provider_turn_id: terminal.turnId,
          outcome: "reply",
          text: terminal.text,
          evidence: "stream",
          terminal_evidence: terminal,
        });
        if (cleanupFails) throw new Error("reply recovery journal was partially retired after normalized checkpoint");
        return terminal;
      },
    ), {
      poll: async () => ({}),
      publish: async (input) => {
        published.push(input.text);
        clientIds.push(input.clientMessageId);
        if (published.length < 3) throw new Error("publication acknowledgement unavailable");
        return { messageId: "message:normalized-reply", roomId: input.roomId };
      },
    }, currentAuthority, 0);
    await delivery.pump({ ...agent, provider: "cursor" });
    assert.equal((await store.get(item.inbox_item_id))?.state, "acknowledged");
    assert.deepEqual(published, Array(3).fill("Durable normalized reply."));
    assert.deepEqual(clientIds, Array(3).fill(item.reply_client_message_id), "all publication retries keep the same idempotency key");
    assert.equal(recoveries, 1);
    assert.equal((await store.receipts(agent.agentId))[0]?.timeline.filter((event) => event.phase === "retry_scheduled").length, 4,
      "two prior recovery failures leave all three publication attempts; journal cleanup spends neither budget");
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
