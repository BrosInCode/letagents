import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderActionFailure } from "../provider-action-port.js";
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
  installCursorCompletionProjectionFixture,
  enqueue,
  ingest,
} from "./helpers/supervised-agent-delivery-fixture.js";

test("pending new turns wait for managed runtime admission without claiming the FIFO head", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-runtime-admission-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let invocations = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async () => {
    invocations += 1;
    return { turnId: "unexpected", outcome: "no_reply", text: null };
  }), { poll: async () => ({}), publish: async () => {} }, currentAuthority,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, async () => false);
  try {
    await ingest(store);
    await delivery.pump(agent);
    assert.equal(invocations, 0);
    const head = await store.head(agent.agentId);
    assert.equal(head?.state, "pending");
    assert.equal(head?.attempt_count, 0);
    assert.equal(head?.provider_turn_id, null);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a delivery wake during admission survives the active pump and internal restarts retain its demand", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-admission-wake-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const entered = deferred<void>();
  const release = deferred<void>();
  const demands: object[] = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async () => {
    throw new Error("unadmitted delivery cannot reach the provider");
  }), { poll: async () => ({}), publish: async () => {} }, currentAuthority,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, async (_agent, demand) => {
    demands.push(demand);
    if (demands.length === 1) { entered.resolve(); await release.promise; }
    return false;
  });
  try {
    await ingest(store);
    const first = delivery.pump(agent);
    await entered.promise;
    assert.equal(delivery.wake(agent), true);
    release.resolve();
    await first;
    await waitFor(() => demands.length === 2);
    await delivery.drainAdmittedTurns([agent.agentId]);
    assert.notEqual(demands[0], demands[1], "the independent wake has its own captured demand");
    await delivery.pump(agent);
    assert.equal(demands[2], demands[1], "internal restart must not create recursive refresh demand");
    await delivery.poll(agent);
    assert.notEqual(demands[3], demands[2], "a completed independent poll can retry a deferred native boundary");
    assert.equal((await store.head(agent.agentId))!.state, "pending");
  } finally { release.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("missing Codex room tools retain the exact inbox item without spending a model attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-room-tools-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  try {
    await ingest(store);
    let ready = false;
    let invocations = 0;
    const published: string[] = [];
    const detail = "LetAgents room tools could not be verified. No model turn was started. Restart and resume, then retry the message.";
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      invocations += 1;
      if (!ready) throw Object.assign(new Error(detail), { providerFailureCode: "provider_room_tools_unavailable" });
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.("turn-tools-restored");
      return { turnId: "turn-tools-restored", outcome: "reply", text: "Board checked." };
    }), { poll: async () => ({}), publish: async input => {
      published.push(input.clientMessageId);
      return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId };
    } }, currentAuthority);
    await delivery.pump(agent);
    const blocked = (await store.receipts(agent.agentId))[0]!;
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.last_error, detail);
    assert.equal(blocked.attempt_count, 0);
    assert.equal(blocked.provider_turn_id, null);
    assert.equal(blocked.outcome, null);
    assert.equal(invocations, 1, "no automatic retry loop while tools are unavailable");
    assert.deepEqual(published, []);
    ready = true;
    await store.retryBlocked(blocked.inbox_item_id);
    await delivery.pump(agent);
    const finished = (await store.receipts(agent.agentId))[0]!;
    assert.equal(finished.inbox_item_id, blocked.inbox_item_id);
    assert.equal(finished.state, "acknowledged");
    assert.equal(finished.attempt_count, 1);
    assert.deepEqual(published, [blocked.reply_client_message_id]);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("room-tool failure after dispatch intent cannot claim that no model turn started", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-room-tools-late-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  try {
    await ingest(store);
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      throw Object.assign(new Error("late tool failure"), { providerFailureCode: "provider_room_tools_unavailable" });
    }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await delivery.pump(agent);
    const blocked = (await store.receipts(agent.agentId))[0]!;
    assert.equal(blocked.state, "blocked");
    assert.match(blocked.last_error!, /provider may have started this work/);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
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

test("Cursor Stop settles its reserved FIFO identity after provider cleanup removes the live map", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cursor-stop-reservation-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const recordCompletion = installCursorCompletionProjectionFixture(store);
    let handlePid = agent.handle!.pid;
    let handleContinuation = agent.handle!.providerContinuationId;
    let handleConnection = { kind: "cursor_cli" as const, pid: null as number | null, processIdentity: null as string | null };
    const cursorHandle = {
      ...agent.handle!,
      get pid() { return handlePid; },
      get providerContinuationId() { return handleContinuation; },
      get providerConnection() { return handleConnection; },
    };
    const cursorAgent = { ...agent, provider: "cursor", handle: cursorHandle, providerConnection: handleConnection };
    const turnEntered = deferred<void>();
    const providerInterrupted = deferred<void>();
    const providerCleanupDone = deferred<void>();
    const settlementCheckpointEntered = deferred<void>();
    const releaseSettlementCheckpoint = deferred<void>();
    const published: string[] = [];
    let calls = 0; let providerStateCheckpoints = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      calls += 1;
      const providerTurnId = `cursor:${request.inboxItemId}`;
      handleConnection = { kind: "cursor_cli", pid: 7777, processIdentity: `cursor-wrapper-birth:${calls}` };
      handlePid = handleConnection.pid;
      await options?.checkpointPreparedTurn?.({
        providerTurnId,
        providerContinuationId: handleContinuation!,
        providerConnection: handleConnection,
      });
      options?.markDurableTurnStarted?.();
      if (calls === 1) {
        turnEntered.resolve();
        await providerInterrupted.promise;
        handleConnection = { kind: "cursor_cli", pid: null, processIdentity: null };
        handlePid = null;
        await options?.checkpointProviderState?.({
          providerContinuationId: handleContinuation!,
          providerConnection: handleConnection,
        });
        providerCleanupDone.resolve();
        throw Object.assign(new Error("Cursor bounded turn was interrupted after wrapper cleanup."), {
          roomTurnRecoveryOutcome: "not_dispatched" as const,
        });
      }
      recordCompletion(providerTurnId, { outcome: "reply", text: "next FIFO reply" });
      handleConnection = { kind: "cursor_cli", pid: null, processIdentity: null };
      handlePid = null;
      await options?.checkpointProviderState?.({
        providerContinuationId: handleContinuation!,
        providerConnection: handleConnection,
      });
      const raw = { turnId: providerTurnId, outcome: "reply" as const, text: "ignored aggregate" };
      return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw;
    }), {
      poll: async () => ({ messages: [
        { id: "1", activation: { for_current_agent: { decision: "activate" } } },
        { id: "2", activation: { for_current_agent: { decision: "activate" } } },
      ] }),
      publish: async (input) => { published.push(input.clientMessageId); return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; },
    }, async (authority, scope) => authority.bearer === "memory"
      && (scope === "lane_lease"
        || (authority.providerContinuationId === authority.handle?.providerContinuationId
          && JSON.stringify(authority.providerConnection) === JSON.stringify(authority.handle?.providerConnection))),
    25, undefined, undefined, undefined, undefined, undefined, async ({ agent: checkpointedAgent, providerContinuationId, providerConnection }) => {
      providerStateCheckpoints += 1;
      if (providerStateCheckpoints === 2) {
        settlementCheckpointEntered.resolve();
        await releaseSettlementCheckpoint.promise;
      }
      handleContinuation = providerContinuationId;
      handlePid = providerConnection.pid;
      handleConnection = providerConnection as typeof handleConnection;
      checkpointedAgent.providerContinuationId = providerContinuationId;
      checkpointedAgent.providerConnection = providerConnection;
    }, async ({ agent: checkpointedAgent, inboxItemId, providerTurnId, providerContinuationId, providerConnection }) => {
      await store.checkpointTurnStarted(inboxItemId, providerTurnId, TEST_PROVIDER_TURN_AUTHORITY);
      handleContinuation = providerContinuationId;
      handlePid = providerConnection.pid;
      handleConnection = providerConnection as typeof handleConnection;
      checkpointedAgent.providerContinuationId = providerContinuationId;
      checkpointedAgent.providerConnection = providerConnection;
    });
    try {
      const pollPromise = delivery.poll(cursorAgent);
      await turnEntered.promise;
      assert.equal(cursorAgent.providerConnection.pid, 7777, "the production checkpoint mutates the delivery agent to the wrapper pid");
      const reservation = delivery.captureActiveDeliveryInterrupt({ ...cursorAgent, bearer: "" }, "stop-cursor-1");
      assert.ok(reservation, "mutable wrapper identity does not invalidate the immutable live delivery owner");
      assert.equal(reservation.agent, cursorAgent, "the reservation retains the real memory-only bearer and dynamic handle owner");
      const reservedInboxItemId = reservation.inboxItemId;

      // Cursor controlTurn waits for wrapper/reaper completion. Model that
      // completion winning before main can perform durable inbox settlement.
      providerInterrupted.resolve();
      await providerCleanupDone.promise;
      const settlementPromise = delivery.interruptActiveDelivery(
        reservation.agent,
        reservedInboxItemId,
        reservation,
      );
      await settlementCheckpointEntered.promise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(calls, 1, "the exact FIFO invocation stays reserved beyond its retry delay");
      assert.equal((await store.get(reservedInboxItemId))?.state, "dispatching", "Stop arbitration retains the exact provider turn instead of making it runnable");

      releaseSettlementCheckpoint.resolve();
      const settlement = await settlementPromise;
      assert.equal(settlement, "settled");
      assert.equal((await store.get(reservedInboxItemId))?.state, "cancelled_by_user");
      await pollPromise;
      await waitForAsync(async () => (await store.receipts(cursorAgent.agentId)).find((receipt) => receipt.source_message_id === "2")?.state === "acknowledged");
      assert.equal(calls, 2, "the cancelled turn is never rerun and the next FIFO item is woken exactly once");
      assert.equal(published.length, 1);
    } finally {
      providerInterrupted.resolve();
      releaseSettlementCheckpoint.resolve();
      await delivery.fenceAndDrain().catch(() => undefined);
    }
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a frozen pre-checkpoint Cursor Stop cannot roll the reserved invocation back to pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cursor-prepared-freeze-"));
  let delivery: SupervisedAgentDelivery | undefined;
  let store: SupervisedAgentInboxStore | undefined;
  const releaseProvider = deferred<void>();
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>();
    let calls = 0;
    const cursorConnection = { kind: "cursor_cli" as const, pid: null, processIdentity: null };
    const cursorAgent = {
      ...agent,
      provider: "cursor",
      providerConnection: cursorConnection,
      handle: { ...agent.handle!, pid: null, providerConnection: cursorConnection },
    };
    delivery = new SupervisedAgentDelivery(store, provider(async () => {
      calls += 1;
      entered.resolve();
      await releaseProvider.promise;
      throw Object.assign(new Error("Cursor preparation was interrupted before its turn checkpoint."), {
        roomTurnRecoveryOutcome: "not_dispatched" as const,
      });
    }), {
      poll: async () => ({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] }),
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority, 10);

    const poll = delivery.poll(cursorAgent);
    await entered.promise;
    const reservation = delivery.captureActiveDeliveryInterrupt(cursorAgent, "stop-precheckpoint");
    assert.ok(reservation);
    delivery.resolveActiveDeliveryInterrupt(reservation, "freeze");
    delivery.resolveActiveDeliveryInterrupt(reservation, "resume");
    delivery.finishActiveDeliveryInterrupt(reservation, "resume");
    releaseProvider.resolve();
    await poll;
    await new Promise((resolve) => setTimeout(resolve, 40));

    const frozen = await store.get(reservation.inboxItemId);
    assert.equal(frozen?.state, "dispatching", "final rollback respects the frozen Stop lease");
    assert.equal(frozen?.provider_turn_id, null, "no provider turn is invented before the atomic checkpoint");
    assert.equal(calls, 1, "the exact pre-checkpoint invocation is never redispatched");
    const internals = delivery as unknown as { interruptReservations: Map<string, unknown> };
    assert.equal(internals.interruptReservations.has(cursorAgent.agentId), false, "the resolved lease is cleaned after its invocation drains");
  } finally {
    releaseProvider.resolve();
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed Stop cancellation freezes the exact Cursor turn beyond its retry window", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cursor-cancel-freeze-"));
  let delivery: SupervisedAgentDelivery | undefined;
  let store: SupervisedAgentInboxStore | undefined;
  const releaseProvider = deferred<void>();
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>();
    const providerExited = deferred<void>();
    let calls = 0;
    const cursorConnection = { kind: "cursor_cli" as const, pid: null, processIdentity: null };
    const cursorAgent = {
      ...agent,
      provider: "cursor",
      providerConnection: cursorConnection,
      handle: { ...agent.handle!, pid: null, providerConnection: cursorConnection },
    };
    delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      calls += 1;
      await options?.checkpointPreparedTurn?.({
        providerTurnId: `cursor:${request.inboxItemId}`,
        providerContinuationId: cursorAgent.providerContinuationId!,
        providerConnection: { kind: "cursor_cli", pid: 9901, processIdentity: "cursor-stop-freeze-birth" },
      });
      options?.markDurableTurnStarted?.();
      entered.resolve();
      await releaseProvider.promise;
      providerExited.resolve();
      throw Object.assign(new Error("Cursor wrapper was stopped."), {
        roomTurnRecoveryOutcome: "not_dispatched" as const,
      });
    }), {
      poll: async () => ({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] }),
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority, 10, undefined, undefined, undefined, undefined, undefined, undefined, async ({ inboxItemId, providerTurnId }) => {
      await store!.checkpointTurnStarted(inboxItemId, providerTurnId, TEST_PROVIDER_TURN_AUTHORITY);
    });
    store.cancelInterruptedTurn = async () => { throw new Error("transient cancellation failure"); };

    const poll = delivery.poll(cursorAgent);
    await entered.promise;
    const reservation = delivery.captureActiveDeliveryInterrupt(cursorAgent, "stop-cancel-failure");
    assert.ok(reservation);
    releaseProvider.resolve();
    await providerExited.promise;
    await assert.rejects(
      delivery.interruptActiveDelivery(reservation.agent, reservation.inboxItemId, reservation),
      /transient cancellation failure/,
    );
    delivery.resolveActiveDeliveryInterrupt(reservation, "freeze");
    await poll;
    await new Promise((resolve) => setTimeout(resolve, 40));

    const frozen = await store.get(reservation.inboxItemId);
    assert.equal(frozen?.state, "dispatching");
    assert.equal(frozen?.provider_turn_id, `cursor:${reservation.inboxItemId}`);
    assert.equal(calls, 1, "uncertain cancellation cannot make the killed turn runnable again");
  } finally {
    releaseProvider.resolve();
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale Stop reservation cannot settle a successor invocation of the same FIFO row", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-stale-stop-token-"));
  let delivery: SupervisedAgentDelivery | undefined;
  let store: SupervisedAgentInboxStore | undefined;
  const releaseFirst = deferred<void>();
  const releaseSecond = deferred<void>();
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const recordCompletion = installCursorCompletionProjectionFixture(store);
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    let calls = 0;
    const cursorConnection = { kind: "cursor_cli" as const, pid: null, processIdentity: null };
    const cursorAgent = {
      ...agent,
      provider: "cursor",
      providerConnection: cursorConnection,
      handle: { ...agent.handle!, pid: null, providerConnection: cursorConnection },
    };
    delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      calls += 1;
      if (calls === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
        throw Object.assign(new Error("The first invocation was not applied."), {
          roomTurnRecoveryOutcome: "not_dispatched" as const,
        });
      }
      secondEntered.resolve();
      await releaseSecond.promise;
      const providerTurnId = `successor:${request.inboxItemId}`;
      recordCompletion(providerTurnId, { outcome: "no_reply" });
      const raw = { turnId: providerTurnId, outcome: "no_reply" as const, text: null };
      return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw;
    }), {
      poll: async () => ({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] }),
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority, 0);

    const poll = delivery.poll(cursorAgent);
    await firstEntered.promise;
    const firstReservation = delivery.captureActiveDeliveryInterrupt(cursorAgent, "stop-A");
    assert.ok(firstReservation);
    delivery.resolveActiveDeliveryInterrupt(firstReservation, "resume");
    releaseFirst.resolve();
    await secondEntered.promise;

    const secondReservation = delivery.captureActiveDeliveryInterrupt(cursorAgent, "stop-B");
    assert.ok(secondReservation, "the resolved A lease cannot leak into successor B");
    await assert.rejects(
      delivery.interruptActiveDelivery(firstReservation.agent, firstReservation.inboxItemId, firstReservation),
      /stale or belongs to a different turn/,
    );
    delivery.resolveActiveDeliveryInterrupt(secondReservation, "resume");
    releaseSecond.resolve();
    await poll;
    assert.equal(calls, 2);
    assert.equal((await store.get(firstReservation.inboxItemId))?.state, "acknowledged_no_reply");
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
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
  // exact turn is already checkpointed before stdin writes. Its catch can
  // commit `retryable` for exact recovery before the Stop's settlement lands. The Stop
  // must still settle that head cancelled_by_user (not map it to "published"),
  // and the stopped turn must NOT be re-dispatched.
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-retryable-race-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const published: string[] = [];
    let calls = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      calls += 1;
      await options?.checkpointTurnStarted?.(request.inboxItemId);
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
