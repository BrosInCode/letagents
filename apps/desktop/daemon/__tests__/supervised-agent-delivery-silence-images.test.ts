import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { type ProviderActionPort } from "../provider-action-port.js";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { RoomAttachmentDownloadError, RoomTurnAttachmentStager, STAGED_FOLDER_MAX_AGE_MS } from "../room-turn-attachments.js";
import {
  agent,
  currentAuthority,
  TEST_PROVIDER_TURN_AUTHORITY,
  provider,
  deferred,
  waitForAsync,
  enqueue,
  ingest,
  recordThreadIntent,
  STAGED_PNG,
  imageMessage,
  pngAttachment,
  withAttachmentStager,
} from "./helpers/supervised-agent-delivery-fixture.js";

test("silence yields at its first durable checkpoint before the adapter returns", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-silent-checkpoint-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const checkpointed = deferred<void>(), adapterDone = deferred<void>();
  let yields = 0, captures = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.(); await options?.checkpointTurnStarted?.(request.inboxItemId);
    const result = { turnId: request.inboxItemId, outcome: "no_reply" as const, text: null };
    await options?.checkpointTerminalResult?.(result);
    await options?.checkpointTerminalResult?.(result);
    checkpointed.resolve(); await adapterDone.promise;
    return result;
  }), { poll: async () => ({}), publish: async () => {}, yieldReplyTurn: async () => { yields++; } }, currentAuthority,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  async () => { captures++; });
  try {
    await ingest(store, "msg_81", { turn: { position: 1, count: 2, prior_speakers: [] } });
    const pumping = delivery.pump(agent);
    await checkpointed.promise;
    await waitForAsync(async () => yields === 1, 1_000);
    assert.equal(captures, 0, "the slot does not wait for the duplicate outer authority/checkpoint path");
    assert.notEqual((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
    adapterDone.resolve(); await pumping;
    assert.equal(yields, 1); assert.equal(captures, 1);
  } finally { adapterDone.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a busy older native turn yields only the new human speaking position", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-busy-human-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const nativeStarted = deferred<void>(), nativeDone = deferred<void>();
  const captureStarted = deferred<void>(), captureDone = deferred<void>();
  const yielded: string[] = [], nativeSources: string[] = [];
  const message = { id: "msg_82", source: "browser", agent_identity: null, text: "Change of plan",
    activation: { for_current_agent: { decision: "activate", reason: "broadcast", turn: { position: 1, count: 2, prior_speakers: [] } } } };
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    nativeSources.push(String(request.sourceMessage.id));
    await options?.beforeNativeDispatch?.(); await options?.checkpointTurnStarted?.(request.inboxItemId);
    if (request.sourceMessage.id === "msg_81") { nativeStarted.resolve(); await nativeDone.promise; }
    return { turnId: request.inboxItemId, outcome: "no_reply", text: null };
  }), { poll: async () => ({ messages: [message] }), publish: async () => {},
    yieldReplyTurn: async input => { yielded.push(input.sourceMessageId); } }, currentAuthority,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  async (_agent, source) => { if (source === "msg_81") { captureStarted.resolve(); await captureDone.promise; } });
  try {
    await ingest(store, "msg_81");
    const pumping = delivery.pump(agent); await nativeStarted.promise;
    const intake = delivery as unknown as { pollOnce(worker: typeof agent): Promise<void> };
    await intake.pollOnce(agent);
    await waitForAsync(async () => yielded.includes("msg_82"), 1_000);
    await intake.pollOnce(agent);
    assert.deepEqual(yielded, ["msg_82"], "replaying the poll cannot repeat the optional hint");
    const next = await store.getBySourceMessage(agent.agentId, agent.roomId, "msg_82");
    assert.equal(next?.state, "pending"); assert.equal(next?.provider_turn_id, null); assert.equal(next?.outcome, null);
    assert.deepEqual(nativeSources, ["msg_81"]);
    nativeDone.resolve(); await captureStarted.promise;
    assert.deepEqual(nativeSources, ["msg_81"], "the new native turn still waits for local capture");
    captureDone.resolve(); await pumping;
    assert.deepEqual(nativeSources, ["msg_81", "msg_82"]);
    assert.ok((await store.receipts(agent.agentId)).every(row => row.state === "acknowledged_no_reply"));
  } finally { nativeDone.resolve(); captureDone.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["agent-source", "spoofed-human", "unordered", "single-recipient", "control-history", "old-completed",
  "stop-before-http", "authority-lost", "handle-replaced", "http-failure", "stop-during-http", "handoff-during-http"] as const) {
  test(`busy human scheduling yield preserves both inbox items: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "letagents-busy-human-fence-"));
    const path = join(root, "state.sqlite"), store = new SupervisedAgentInboxStore(path);
    const started = deferred<void>(), nativeDone = deferred<void>();
    const capturing = deferred<void>(), captureDone = deferred<void>();
    const checking = deferred<void>(), checkDone = deferred<void>();
    const reporting = deferred<void>(), aborted = deferred<void>(), cleanup = deferred<void>();
    let allowed = true, yields = 0, polls = 0, calls = 0, publications = 0, historyAdded = false;
    const current = { ...agent, handle: { ...agent.handle } };
    const waitAtBinding = ["old-completed", "stop-before-http", "authority-lost", "handle-replaced"].includes(mode);
    const originalBinding = store.providerTurnBinding.bind(store);
    store.providerTurnBinding = async id => {
      const binding = await originalBinding(id);
      if (polls && waitAtBinding) { checking.resolve(); await checkDone.promise; }
      return binding;
    };
    const untouched = store.untouchedPending.bind(store);
    store.untouchedPending = async id => {
      if (mode === "control-history" && !historyAdded) {
        historyAdded = true;
        const db = new DatabaseSync(path);
        try { db.prepare(`INSERT INTO supervised_agent_inbox_events
          (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
          SELECT ?,COALESCE(MAX(event_sequence),0)+1,'retry:test','queued',?,NULL FROM supervised_agent_inbox_events WHERE inbox_item_id=?`)
          .run(id, new Date().toISOString(), id); } finally { db.close(); }
      }
      return untouched(id);
    };
    const activation = { decision: "activate", reason: "broadcast",
      ...(mode === "unordered" ? {} : { turn: { position: 1, count: mode === "single-recipient" ? 1 : 2, prior_speakers: [] } }) };
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      calls++;
      await options?.beforeNativeDispatch?.(); await options?.checkpointTurnStarted?.(request.inboxItemId);
      if (request.sourceMessage.id === "msg_81") { started.resolve(); await nativeDone.promise; }
      return { turnId: request.inboxItemId, outcome: mode === "old-completed" ? "no_reply" : "reply",
        text: mode === "old-completed" ? null : `my contribution to ${request.sourceMessage.id}` };
    }), {
      poll: async () => { polls++; return { messages: [{ id: "msg_82", text: "New human direction",
        source: mode === "agent-source" ? "agent" : "browser",
        agent_identity: mode === "spoofed-human" ? { agent_key: "other-agent" } : null,
        activation: { for_current_agent: activation } }] }; },
      publish: async input => { publications++; return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; },
      yieldReplyTurn: async ({ sourceMessageId, signal }) => {
        assert.equal(sourceMessageId, "msg_82"); yields++; reporting.resolve();
        if (mode === "http-failure") throw new Error("optional scheduling hint failed");
        if (mode === "stop-during-http" || mode === "handoff-during-http") {
          await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
          await cleanup.promise;
        }
      },
    }, async () => allowed, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async (_agent, source) => { if (source === "msg_81") { capturing.resolve(); await captureDone.promise; } });
    let draining: Promise<void> | undefined;
    try {
      await ingest(store, "msg_81");
      const pumping = delivery.pump(current); await started.promise;
      const intake = delivery as unknown as { pollOnce(agent: typeof current): Promise<void>; auxiliaryControllers: Map<string, Set<AbortController>> };
      await intake.pollOnce(current);
      if (waitAtBinding) {
        await checking.promise;
        if (mode === "old-completed") { nativeDone.resolve(); await capturing.promise; }
        if (mode === "stop-before-http") assert.equal(await delivery.interruptActiveDelivery(current), "settled");
        if (mode === "authority-lost") allowed = false;
        if (mode === "handle-replaced") current.handle = { ...current.handle };
        checkDone.resolve();
      }
      if (mode.endsWith("during-http")) {
        await reporting.promise;
        if (mode === "stop-during-http") assert.equal(await delivery.interruptActiveDelivery(current), "settled");
        let drained = false; draining = delivery.fenceAndDrain().then(() => { drained = true; });
        await aborted.promise; await new Promise(resolve => setImmediate(resolve));
        assert.equal(drained, false, "handoff joins the cancelled HTTP request's cleanup");
        cleanup.resolve(); nativeDone.resolve(); captureDone.resolve();
        await pumping; await draining;
      } else {
        await waitForAsync(async () => !intake.auxiliaryControllers.get(current.agentId)?.size);
        assert.equal(yields, mode === "http-failure" ? 1 : 0);
        if (mode === "http-failure") {
          nativeDone.resolve(); await capturing.promise;
          assert.equal((await store.getBySourceMessage(current.agentId, current.roomId, "msg_82"))?.state, "pending");
          assert.equal(calls, 1); captureDone.resolve(); await pumping;
          assert.equal(calls, 2); assert.equal(publications, 2, "a failed hint does not suppress either agent contribution");
        } else {
          draining = delivery.fenceAndDrain(); nativeDone.resolve(); captureDone.resolve(); await pumping; await draining;
        }
      }
      if (mode.startsWith("stop-")) assert.equal((await store.getBySourceMessage(current.agentId, current.roomId, "msg_81"))?.state, "cancelled_by_user");
    } finally {
      checkDone.resolve(); nativeDone.resolve(); captureDone.resolve(); cleanup.resolve();
      await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true });
    }
  });
}

test("durable silence yields the remote speaking slot while capture still owns local settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-silent-slot-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const capturing = deferred<void>(), captureDone = deferred<void>();
  let turns = 0, yields = 0, reports = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    turns++;
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.(request.inboxItemId);
    const result = { turnId: request.inboxItemId, outcome: "no_reply" as const, text: null,
      publicationContract: "legacy_cursor_aggregate_v0" as const };
    await options?.checkpointTerminalResult?.(result);
    await options?.checkpointTerminalResult?.(result);
    return result;
  }), {
    poll: async () => ({}), publish: async () => { throw new Error("no reply"); },
    yieldReplyTurn: async () => { yields++; },
    reportNoReply: async () => { reports++; },
  }, currentAuthority, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  async (_agent, source) => { if (source === "msg_81") { capturing.resolve(); await captureDone.promise; } });
  try {
    await ingest(store, "msg_81", { turn: { position: 1, count: 2, prior_speakers: [] } });
    await ingest(store, "msg_82");
    const pumping = delivery.pump(agent);
    await capturing.promise;
    await waitForAsync(async () => yields === 1, 1_000);
    const [head, next] = await store.receipts(agent.agentId);
    assert.equal(JSON.parse(head!.outcome!).kind, "no_reply");
    assert.notEqual(head!.state, "acknowledged_no_reply", "yield is scheduling progress, not a receipt ACK");
    assert.equal(next!.state, "pending");
    assert.equal(turns, 1, "the same agent cannot start its next native turn during capture");
    assert.equal(reports, 0, "no_reply receipt still waits for capture and Stop arbitration");
    captureDone.resolve(); await pumping;
    await waitForAsync(async () => reports === 2);
    assert.equal(yields, 1, "duplicate native checkpoints and an unsequenced successor cannot duplicate the hint");
    assert.equal(turns, 2);
    assert.ok((await store.receipts(agent.agentId)).every(row => row.state === "acknowledged_no_reply"));
  } finally { captureDone.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["stop-before-dispatch", "replacement-before-dispatch", "handle-replaced", "connection-mutated",
  "foreign-origin", "foreign-continuation", "foreign-turn", "http-failure", "stop-during-http", "handoff-during-http",
  "reply", "unreadable", "failed", "unsequenced", "local", "synthetic"] as const) {
  test(`silent scheduling yield preserves settlement and authority: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "letagents-silent-yield-fence-"));
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    const capturing = deferred<void>(), captureDone = deferred<void>();
    const checking = deferred<void>(), checkDone = deferred<void>();
    const reporting = deferred<void>(), aborted = deferred<void>(), httpCleanup = deferred<void>();
    const liveAgent = { ...agent, handle: { ...agent.handle, providerConnection: { ...agent.handle.providerConnection } },
      providerConnection: { ...agent.providerConnection }, apiUrl: mode === "local" ? "letagents-local://rooms" : agent.apiUrl };
    let terminalCommitted = false, ownsLane = true, yields = 0, nativeCalls = 0;
    const checkpoint = store.checkpointNormalizedTerminal.bind(store);
    store.checkpointNormalizedTerminal = async input => { const saved = await checkpoint(input); terminalCommitted = true; return saved; };
    const binding = store.providerTurnBinding.bind(store);
    store.providerTurnBinding = async id => {
      const saved = await binding(id);
      if (!terminalCommitted) return saved;
      checking.resolve();
      if (["stop-before-dispatch", "replacement-before-dispatch", "handle-replaced", "connection-mutated", "foreign-origin", "foreign-continuation", "foreign-turn"].includes(mode)) await capturing.promise;
      if (mode === "stop-before-dispatch" || mode === "replacement-before-dispatch") await checkDone.promise;
      if (mode === "handle-replaced") liveAgent.handle = { ...liveAgent.handle };
      if (mode === "connection-mutated") liveAgent.handle.providerConnection.processIdentity = "replacement-process";
      if (saved && mode === "foreign-origin") return { ...saved, origin_execution_generation_id: "old-generation" };
      if (saved && mode === "foreign-continuation") return { ...saved, provider_continuation_id: "other-thread" };
      if (saved && mode === "foreign-turn") return { ...saved, provider_turn_id: "other-turn" };
      return saved;
    };
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      nativeCalls++;
      await options?.beforeNativeDispatch?.(); await options?.checkpointTurnStarted?.(request.inboxItemId);
      const outcome = mode === "reply" || mode === "unreadable" || mode === "failed" ? mode : "no_reply";
      return { turnId: request.inboxItemId, providerContinuationId: "thread", outcome, text: outcome === "reply" ? "my answer" : null,
        evidence: "stream", publicationContract: "legacy_cursor_aggregate_v0", ...(outcome === "failed" ? { error: "provider failure" } : {}) };
    }), {
      poll: async () => ({}), publish: async input => ({ messageId: "msg_99", roomId: input.roomId }),
      yieldReplyTurn: async ({ signal }) => {
        yields++; reporting.resolve();
        if (mode === "http-failure") throw new Error("optional yield unavailable");
        if (mode === "stop-during-http" || mode === "handoff-during-http") {
          await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
          await httpCleanup.promise;
        }
      },
    }, async () => ownsLane, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { capturing.resolve(); await captureDone.promise; });
    let draining: Promise<void> | undefined;
    try {
      const activation = mode === "unsequenced" ? {} : { turn: { position: 1, count: 2, prior_speakers: [] } };
      if (mode === "synthetic") await store.enqueueInitialMessage({ agent_id: liveAgent.agentId, room_id: liveAgent.roomId,
        source_message_id: "initial:1", source_message: { id: "initial:1", text: "start" }, activation });
      else await ingest(store, "msg_81", activation);
      const pumping = delivery.pump(liveAgent);
      await capturing.promise;
      if (mode === "stop-before-dispatch" || mode === "replacement-before-dispatch") {
        await checking.promise;
        if (mode === "stop-before-dispatch") assert.equal(await delivery.interruptActiveDelivery(liveAgent), "settled");
        else ownsLane = false;
        checkDone.resolve();
      }
      if (mode === "http-failure" || mode === "stop-during-http" || mode === "handoff-during-http") await reporting.promise;
      if (mode === "stop-during-http" || mode === "handoff-during-http") {
        if (mode === "stop-during-http") assert.equal(await delivery.interruptActiveDelivery(liveAgent), "settled");
        let drained = false;
        draining = delivery.fenceAndDrain().then(() => { drained = true; });
        await aborted.promise;
        captureDone.resolve(); await pumping;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(drained, false, "retirement joins the aborted optional request's cleanup");
        httpCleanup.resolve(); await draining;
      } else {
        if (["handle-replaced", "connection-mutated", "foreign-origin", "foreign-continuation", "foreign-turn"].includes(mode)) {
          await checking.promise;
        }
        // Registration precedes capture. Observe its tracked completion before
        // asserting negatives; fencing early could otherwise hide a late hint.
        const tracked = delivery as unknown as { auxiliaryControllers: Map<string, Set<AbortController>> };
        await waitForAsync(async () => !tracked.auxiliaryControllers.get(agent.agentId)?.size);
        assert.equal(yields, mode === "http-failure" ? 1 : 0);
        // Prevent unreadable recovery and invalidated proof fixtures from retrying native work.
        if (!["http-failure", "reply", "unsequenced", "local", "synthetic"].includes(mode)) {
          draining = delivery.fenceAndDrain();
        }
        captureDone.resolve(); await pumping; await draining;
      }
      assert.equal(nativeCalls, 1, "optional scheduling transport cannot rerun a completed native turn");
      if (mode === "http-failure") assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
      if (mode.startsWith("stop-")) assert.equal((await store.receipts(agent.agentId))[0]?.state, "cancelled_by_user");
    } finally {
      checkDone.resolve(); captureDone.resolve(); httpCleanup.resolve();
      await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true });
    }
  });
}

test("settled no-reply hints do not wait for report upload or retry a provider after transport failure", async () => {
  for (const candidate of ["codex", "claude-code"]) {
    const root = await mkdtemp(join(tmpdir(), "letagents-no-reply-hint-"));
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    const capturing = deferred<void>(), captureDone = deferred<void>();
    const reporting = deferred<void>(), reportDone = deferred<void>();
    let turns = 0, reports = 0, settled = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.(request.inboxItemId);
      turns++;
      return { turnId: request.inboxItemId, outcome: "no_reply", text: null, publicationContract: "legacy_cursor_aggregate_v0" };
    }), {
      poll: async () => ({}), publish: async () => { throw new Error("no reply"); },
      reportNoReply: async input => {
        reports++;
        assert.equal((await store.getBySourceMessage(agent.agentId, agent.roomId, input.sourceMessageId))?.state, "acknowledged_no_reply");
        assert.equal(input.bearer, agent.bearer);
        assert.equal(input.apiUrl, agent.apiUrl);
        assert.equal(input.roomId, agent.roomId);
        reporting.resolve();
        await reportDone.promise;
      },
    }, currentAuthority, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { capturing.resolve(); await captureDone.promise; }, undefined, undefined, () => { settled++; });
    try {
      await ingest(store, "msg_81");
      const pumping = delivery.pump({ ...agent, provider: candidate });
      await capturing.promise;
      assert.equal(reports, 0, "native checkpoint alone cannot bypass capture/Stop arbitration");
      captureDone.resolve();
      await reporting.promise;
      await pumping;
      assert.equal(settled, 1, "normal work publication is still notified without awaiting receipt transport");
      reportDone.reject(new Error("receipt upload unavailable"));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(turns, 1);
      assert.equal(reports, 1);
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
    } finally {
      captureDone.resolve(); reportDone.resolve();
      await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true });
    }
  }
});

test("settled no-reply requests remain cancellable and joined after their pump finishes", async () => {
  for (const action of ["stop", "fence"]) {
    const root = await mkdtemp(join(tmpdir(), "letagents-no-reply-drain-"));
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    const reporting = deferred<void>(), aborted = deferred<void>(), cleanup = deferred<void>();
    let requestSignal: AbortSignal | undefined;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      await options?.beforeNativeDispatch?.(); await options?.checkpointTurnStarted?.(request.inboxItemId);
      return { turnId: request.inboxItemId, outcome: "no_reply", text: null, publicationContract: "legacy_cursor_aggregate_v0" };
    }), { poll: async () => ({}), publish: async () => {}, reportNoReply: async input => {
      requestSignal = input.signal;
      input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      reporting.resolve();
      await aborted.promise;
      await cleanup.promise;
    } }, currentAuthority);
    try {
      await ingest(store, "msg_84");
      await delivery.pump(agent);
      await reporting.promise;
      assert.equal(requestSignal?.aborted, false);
      let drained = false;
      const draining = (action === "stop" ? delivery.stop(agent.agentId) : delivery.fenceAndDrain()).then(() => { drained = true; });
      await aborted.promise;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(requestSignal?.aborted, true);
      assert.equal(drained, false, "drain must join request cleanup after abort");
      cleanup.resolve(); await draining;
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
    } finally { aborted.resolve(); cleanup.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("no-reply hint is suppressed when Stop or authority replacement wins during capture", async () => {
  for (const action of ["stop", "replace"]) {
    const root = await mkdtemp(join(tmpdir(), "letagents-no-reply-stop-"));
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    const capturing = deferred<void>(), captureDone = deferred<void>();
    let current = true, reports = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      await options?.beforeNativeDispatch?.(); await options?.checkpointTurnStarted?.(request.inboxItemId);
      return { turnId: request.inboxItemId, outcome: "no_reply", text: null, publicationContract: "legacy_cursor_aggregate_v0" };
    }), { poll: async () => ({}), publish: async () => {}, reportNoReply: async () => { reports++; } }, async () => current,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { capturing.resolve(); await captureDone.promise; });
    try {
      await ingest(store, "msg_82");
      const pumping = delivery.pump(agent);
      await capturing.promise;
      if (action === "stop") assert.equal(await delivery.interruptActiveDelivery(agent), "settled");
      else current = false;
      captureDone.resolve(); await pumping;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reports, 0);
      if (action === "stop") assert.equal((await store.receipts(agent.agentId))[0]?.state, "cancelled_by_user");
    } finally { captureDone.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("no-reply hints skip synthetic messages and local-room transport", async () => {
  for (const variant of ["synthetic", "local"]) {
    const root = await mkdtemp(join(tmpdir(), "letagents-no-reply-skip-"));
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    let reports = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      await options?.beforeNativeDispatch?.(); await options?.checkpointTurnStarted?.(request.inboxItemId);
      return { turnId: request.inboxItemId, outcome: "no_reply", text: null, publicationContract: "legacy_cursor_aggregate_v0" };
    }), { poll: async () => ({}), publish: async () => {}, reportNoReply: async () => { reports++; } }, currentAuthority);
    try {
      if (variant === "synthetic") await store.enqueueInitialMessage({ agent_id: agent.agentId, room_id: agent.roomId,
        source_message_id: "initial:1", source_message: { id: "initial:1", text: "start" }, activation: {} });
      else await ingest(store, "msg_83");
      await delivery.pump({ ...agent, apiUrl: variant === "local" ? "letagents-local://rooms" : agent.apiUrl });
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
      assert.equal(reports, 0);
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('every provider waits for the workspace snapshot before advancing to its next turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'letagents-workspace-boundary-'));
  try {
    for (const candidate of ['codex', 'claude-code', 'cursor', 'open-model']) {
      const store = new SupervisedAgentInboxStore(join(root, `${candidate}.sqlite`));
      const entered = deferred<void>(), release = deferred<void>();
      const events: string[] = [];
      const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
        await options?.beforeNativeDispatch?.();
        events.push(`turn:${request.sourceMessage.id}`);
        await options?.checkpointTurnStarted?.(request.inboxItemId);
        return { turnId: request.inboxItemId, outcome: 'no_reply', text: null, publicationContract: 'legacy_cursor_aggregate_v0' };
      }), { poll: async () => ({}), publish: async () => { throw new Error('no reply'); } }, currentAuthority,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      async (_agent, source) => {
        events.push(`snapshot:${source}`);
        if (source === '1') { entered.resolve(); await release.promise; }
        // Optional review failure must not retry the agent's completed work.
        if (source === '2') throw new Error('snapshot unavailable');
      }, async (_agent, source) => { events.push(`baseline:${source}`); return 'a'.repeat(40); },
      async (_agent, source) => { events.push(`release:${source}`); });
      try {
        const currentAgent = { ...agent, provider: candidate };
        await delivery.pump(currentAgent);
        await ingest(store, '1'); await ingest(store, '2');
        const pumping = delivery.pump(currentAgent);
        await entered.promise;
        assert.deepEqual(events, ['baseline:1', 'turn:1', 'snapshot:1']);
        release.resolve(); await pumping;
        assert.deepEqual(events, ['baseline:1', 'turn:1', 'snapshot:1', 'release:1', 'baseline:2', 'turn:2', 'snapshot:2', 'release:2']);
        assert.deepEqual((await store.receipts(agent.agentId)).map(row => row.state), ['acknowledged_no_reply', 'acknowledged_no_reply']);
      } finally { release.resolve(); await delivery.fenceAndDrain(); await store.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


for (const variant of ['success', 'capture_failure', 'http_failure', 'stop', 'authority_loss', 'handoff'] as const) {
  test(`reply publication overlaps capture but joins its boundary on ${variant}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'letagents-capture-publication-'));
    const store = new SupervisedAgentInboxStore(join(root, 'state.sqlite'));
    const captureStarted = deferred<void>(), captureRelease = deferred<void>();
    const publishStarted = deferred<void>(), publishRelease = deferred<void>();
    const events: string[] = [];
    let ownsLane = true, nativeCalls = 0, publications = 0, finished = false;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
      await options?.beforeNativeDispatch?.();
      nativeCalls++;
      await options?.checkpointTurnStarted?.(request.inboxItemId);
      return { turnId: request.inboxItemId, outcome: 'reply', text: `answer ${request.sourceMessage.id}`,
        publicationContract: 'legacy_cursor_aggregate_v0' };
    }), {
      poll: async () => ({}),
      publish: async input => {
        publications++;
        events.push(`publish:${publications}`);
        if (publications === 1) {
          publishStarted.resolve();
          await publishRelease.promise;
          if (variant === 'http_failure') throw new Error('temporary publication failure');
        }
        return { messageId: `published-${input.clientMessageId}`, roomId: agent.roomId };
      },
    }, async () => ownsLane, 0,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async (_agent, source) => {
      events.push(`capture:${source}`);
      if (source === '1') {
        captureStarted.resolve(); await captureRelease.promise;
        if (variant === 'capture_failure') throw new Error('optional capture unavailable');
      }
    }, undefined, async (_agent, source) => { events.push(`release:${source}`); });
    let draining: Promise<void> | undefined;
    try {
      await delivery.pump(agent);
      await ingest(store, '1'); await ingest(store, '2');
      const pumping = delivery.pump(agent).finally(() => { finished = true; });
      await captureStarted.promise;
      await publishStarted.promise;
      assert.equal(nativeCalls, 1, 'posting does not start a successor native turn');
      assert.equal((await store.receipts(agent.agentId))[0]?.state, 'publishing');
      if (variant === 'stop') {
        assert.equal(await delivery.interruptActiveDelivery(agent), 'published', 'Stop honestly loses after publishing owns the result');
      }
      if (variant === 'authority_loss') ownsLane = false;
      if (variant === 'handoff') draining = delivery.fenceAndDrain();
      publishRelease.resolve();
      // Let HTTP resolve/reject while capture remains deliberately held.
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(finished, false, 'delivery still owns capture');
      assert.equal(publications, 1, 'HTTP failure cannot retry before capture joins');
      assert.equal(nativeCalls, 1);
      assert.ok(!events.includes('release:1'), 'capture refs remain retained');
      assert.notEqual((await store.receipts(agent.agentId))[0]?.state, 'acknowledged');
      captureRelease.resolve();
      await pumping; await draining;
      assert.ok(events.indexOf('release:1') > events.indexOf('publish:1'));
      const receipts = await store.receipts(agent.agentId);
      if (variant === 'authority_loss' || variant === 'handoff') {
        assert.equal(nativeCalls, 1);
        assert.notEqual(receipts[0]?.state, 'acknowledged', 'lost authority cannot ACK the posted result');
        const recoveryCalls: string[] = [], recoveryCaptures: string[] = [], recoveryIds: string[] = [];
        const restored = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
          recoveryCalls.push(String(request.sourceMessage.id));
          await options?.beforeNativeDispatch?.(); await options?.checkpointTurnStarted?.(request.inboxItemId);
          return { turnId: request.inboxItemId, outcome: 'reply', text: 'second answer' };
        }), { poll: async () => ({}), publish: async input => {
          recoveryIds.push(input.clientMessageId);
          return { messageId: `published-${input.clientMessageId}`, roomId: agent.roomId };
        } }, currentAuthority, 0,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        async (_agent, source) => { recoveryCaptures.push(source); });
        try {
          await restored.pump(agent);
          assert.deepEqual(recoveryCalls, ['2'], 'recover the saved first answer without rerunning its model');
          assert.deepEqual(recoveryCaptures, ['2'], 'never reconstruct the old filesystem snapshot');
          assert.equal(recoveryIds[0], receipts[0]!.reply_client_message_id, 'retry the exact published message identity');
          assert.deepEqual((await store.receipts(agent.agentId)).map(row => row.state), ['acknowledged', 'acknowledged']);
        } finally { await restored.fenceAndDrain(); }
      } else {
        assert.equal(nativeCalls, 2, 'publication retry never repeats the first native turn');
        assert.deepEqual(receipts.map(row => row.state), ['acknowledged', 'acknowledged']);
        assert.equal(publications, variant === 'http_failure' ? 3 : 2);
      }
    } finally {
      captureRelease.resolve(); publishRelease.resolve();
      await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true });
    }
  });
}

test("recorded reply-thread intent cannot publish a stopped, failed, silent or authority-lost turn", async () => {
  for (const outcome of ["stop", "failed", "no_reply", "authority_lost"] as const) {
    const root = await mkdtemp(join(tmpdir(), "letagents-thread-no-publish-"));
    const path = join(root, "state.sqlite");
    const store = new SupervisedAgentInboxStore(path);
    const recorded = deferred<void>(); const release = deferred<void>();
    let ownsLane = true; let publications = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.checkpointTurnStarted?.("native-turn");
      await recordThreadIntent(path, store, "native-turn");
      recorded.resolve(); await release.promise;
      if (outcome === "authority_lost") ownsLane = false;
      return { turnId: "native-turn", outcome: outcome === "failed" ? "failed" : outcome === "no_reply" ? "no_reply" : "reply",
        text: outcome === "failed" || outcome === "no_reply" ? null : "must not be sent" };
    }), { poll: async () => ({}), publish: async () => { publications++; } }, async () => ownsLane, 0);
    try {
      await ingest(store, "msg_72");
      const pumping = delivery.pump(agent);
      await recorded.promise;
      if (outcome === "stop") assert.equal(await delivery.interruptActiveDelivery(agent), "settled");
      release.resolve(); await pumping;
      assert.equal(publications, 0, outcome);
      if (outcome === "stop") assert.equal((await store.receipts(agent.agentId))[0]?.state, "cancelled_by_user");
    } finally { release.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

for (const change of ["authority", "handoff", "epoch"] as const) {
  test(`managed admission cannot dispatch after ${change} changes during its await`, async () => {
    const root = await mkdtemp(join(tmpdir(), "letagents-admission-fence-"));
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); const gate = deferred<boolean>();
    let current = true; let calls = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => {
      calls += 1; return { turnId: "unexpected", outcome: "no_reply", text: null };
    }), { poll: async () => ({}), publish: async () => {} }, async () => current,
    0, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { entered.resolve(); return gate.promise; });
    try {
      await ingest(store);
      const pending = delivery.pump(agent);
      await entered.promise;
      if (change === "authority") current = false;
      if (change === "handoff") delivery.fence();
      if (change === "epoch") delivery.pauseIngress(agent.agentId);
      gate.resolve(true);
      await pending;
      assert.equal(calls, 0);
      assert.equal((await store.head(agent.agentId))!.state, "pending");
    } finally { gate.resolve(false); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const kind of ["exact-turn", "publication", "ambiguous"] as const) {
  test(`managed admission leaves ${kind} recovery on its existing path`, async () => {
    const root = await mkdtemp(join(tmpdir(), "letagents-admission-recovery-"));
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    let gates = 0; let newTurns = 0; let recovered = 0; let published = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => {
      newTurns += 1; throw new Error("must not replay");
    }, async (_handle, request) => {
      recovered += 1; assert.equal(request.providerTurnId, "saved-turn");
      return { turnId: "saved-turn", outcome: "reply", text: "saved reply" };
    }), { poll: async () => ({}), publish: async input => {
      published += 1; return { messageId: "saved-publication", roomId: input.roomId };
    } }, currentAuthority, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { gates += 1; return false; });
    try {
      const item = await enqueue(store);
      if (kind !== "ambiguous") await store.checkpointTurnStarted(item.inbox_item_id, "saved-turn", TEST_PROVIDER_TURN_AUTHORITY);
      if (kind === "publication") {
        await store.transition(item.inbox_item_id, "awaiting_result", { outcome: JSON.stringify({ kind: "reply", text: "saved reply" }) });
        await store.transition(item.inbox_item_id, "publishing");
      }
      await delivery.pump(agent);
      assert.equal(gates, 0);
      assert.equal(newTurns, 0);
      assert.equal(recovered, kind === "exact-turn" ? 1 : 0);
      assert.equal(published, kind === "ambiguous" ? 0 : 1);
      const receipt = (await store.receipts(agent.agentId))[0]!;
      assert.equal(receipt.state, kind === "ambiguous" ? "blocked" : "acknowledged");
      if (kind === "ambiguous") {
        assert.equal(receipt.attempt_count, 0);
        assert.equal(receipt.provider_turn_id, null);
        assert.match(receipt.last_error!, /without authoritative terminal/);
      }
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const race of ["retry", "arrival", "successor"] as const) {
  test(`managed admission rechecks ${race} that changes the inspected FIFO head`, async () => {
    const root = await mkdtemp(join(tmpdir(), "letagents-admission-claim-race-"));
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    let calls = 0; let gates = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => {
      calls += 1; throw new Error("uninspected pending work must not run");
    }), { poll: async () => ({}), publish: async () => {} }, currentAuthority,
    0, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { gates += 1; return false; });
    try {
      if (race !== "arrival") {
        const item = await enqueue(store);
        if (race === "retry") await store.transition(item.inbox_item_id, "blocked");
        else {
          await store.checkpointTurnStarted(item.inbox_item_id, "saved-turn", TEST_PROVIDER_TURN_AUTHORITY);
          await store.transition(item.inbox_item_id, "awaiting_result", { outcome: JSON.stringify({ kind: "reply", text: "saved" }) });
          await store.normalizeStartupRecovery(agent.agentId);
          await ingest(store, "2");
        }
      }
      const head = store.head.bind(store);
      let raced = false;
      store.head = async id => {
        const inspected = await head(id);
        if (!raced) {
          raced = true;
          if (race === "arrival") await ingest(store);
          else if (race === "retry") await store.retryBlocked(inspected!.inbox_item_id);
          else {
            await store.transition(inspected!.inbox_item_id, "dispatching");
            await store.transition(inspected!.inbox_item_id, "awaiting_result");
            await store.transition(inspected!.inbox_item_id, "publishing");
            await store.transition(inspected!.inbox_item_id, "acknowledged");
          }
        }
        return inspected;
      };
      await delivery.pump(agent);
      assert.equal(calls, 0);
      assert.equal(gates, 1, "the changed pending head must pass admission");
      assert.equal((await head(agent.agentId))!.state, "pending");
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("the activating message's images reach that turn only, and a staged file stays until the turn ends", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-turn-images-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const stagedRoot = join(root, "room-turn-attachments");
  const downloads: Array<{ messageId: string; attachmentId: string; bearer: string }> = [];
  const seen: Array<{ status: string; path?: string; existed: boolean }> = [];
  const finishTurn = deferred<void>();
  const turnRunning = deferred<void>();
  const port = { ...provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    for (const file of request.attachments ?? []) {
      seen.push({ status: file.status, path: file.image?.path,
        existed: Boolean(file.image?.path && await readFile(file.image.path).then(() => true, () => false)) });
    }
    turnRunning.resolve();
    await finishTurn.promise;
    return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
  }), roomTurnImageDelivery: async () => "file" as const } satisfies ProviderActionPort;
  const delivery = withAttachmentStager(store, port, {
    poll: async ({ afterMessageId }) => ({ messages: afterMessageId ? [] : [imageMessage("msg_5", [pngAttachment("att_1"),
      { id: "att_2", filename: "log.txt", content_type: "text/plain", byte_size: 4 }])] }),
    downloadAttachment: async (input) => { downloads.push({ messageId: input.messageId, attachmentId: input.attachmentId, bearer: input.bearer }); return STAGED_PNG; },
    publish: async () => { throw new Error("no reply expected"); },
  }, new RoomTurnAttachmentStager(stagedRoot));
  try {
    const polled = delivery.poll(agent);
    await turnRunning.promise;
    assert.deepEqual(seen.map(file => [file.status, file.existed]), [["image", true], ["not_image", false]]);
    assert.deepEqual(downloads, [{ messageId: "msg_5", attachmentId: "att_1", bearer: "memory" }], "only the image is downloaded, with the worker bearer");
    finishTurn.resolve();
    await polled;
    for (let attempt = 0; attempt < 50 && (await readdir(stagedRoot)).length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(await readdir(stagedRoot), [], "the staged file is removed once the turn has ended");
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
    const detail = await store.detail(agent.agentId, agent.roomId, "msg_5");
    assert.ok(!JSON.stringify(detail.prepared_context).includes(stagedRoot), "no staged path is saved with the turn");
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a refused attachment download leaves the room accepted and the turn runs with a note", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-turn-images-refused-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const statuses: string[][] = [];
  const port = { ...provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    statuses.push((request.attachments ?? []).map(file => file.status));
    return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
  }), roomTurnImageDelivery: async () => "memory" as const } satisfies ProviderActionPort;
  const delivery = withAttachmentStager(store, port, {
    poll: async ({ afterMessageId }) => ({ messages: afterMessageId ? [] : [imageMessage("msg_5", [pngAttachment("att_1")])] }),
    // What an older server that does not grant workers the route answers.
    downloadAttachment: async () => { throw new RoomAttachmentDownloadError("unavailable"); },
    publish: async () => { throw new Error("no reply expected"); },
  }, new RoomTurnAttachmentStager(join(root, "room-turn-attachments")));
  try {
    await delivery.poll(agent);
    assert.deepEqual(statuses, [["unavailable"]]);
    assert.equal(delivery.roomRefusesAccess(agent.agentId), false);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("an agent whose provider takes no images downloads nothing and is told so", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-turn-images-unsupported-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const statuses: string[][] = [];
  let downloads = 0;
  const delivery = withAttachmentStager(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    statuses.push((request.attachments ?? []).map(file => file.status));
    return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
  }), {
    poll: async ({ afterMessageId }) => ({ messages: afterMessageId ? [] : [imageMessage("msg_5", [pngAttachment("att_1")]), imageMessage("msg_6", [])] }),
    downloadAttachment: async () => { downloads++; return STAGED_PNG; },
    publish: async () => { throw new Error("no reply expected"); },
  }, new RoomTurnAttachmentStager(join(root, "room-turn-attachments")));
  try {
    await delivery.poll(agent);
    await delivery.poll(agent);
    assert.deepEqual(statuses, [["provider_unsupported"], []]);
    assert.equal(downloads, 0);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("recovering a saved turn never downloads its images again", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-turn-images-recovery-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let downloads = 0;
  const recoveryRequests: unknown[] = [];
  const port = { ...provider(async (_handle, request, options) => {
    assert.equal(request.attachments?.[0]?.status, "image");
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("saved-turn");
    return { turnId: "saved-turn", outcome: "unreadable", text: null, evidence: "none" };
  }, async (_handle, request) => {
    recoveryRequests.push(request);
    return { turnId: "saved-turn", outcome: "no_reply", text: null, evidence: "transcript" };
  }), roomTurnImageDelivery: async () => "memory" as const } satisfies ProviderActionPort;
  const delivery = withAttachmentStager(store, port, {
    poll: async ({ afterMessageId }) => ({ messages: afterMessageId ? [] : [imageMessage("msg_5", [pngAttachment("att_1")])] }),
    downloadAttachment: async () => { downloads++; return STAGED_PNG; },
    publish: async () => { throw new Error("no reply expected"); },
  }, new RoomTurnAttachmentStager(join(root, "room-turn-attachments")));
  try {
    await delivery.poll(agent);
    assert.equal(downloads, 1, "only the first dispatch downloads");
    assert.equal(recoveryRequests.length, 1);
    assert.equal((recoveryRequests[0] as Record<string, unknown>).attachments, undefined);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a turn whose observation ends early keeps its staged file for the native turn until the sweep", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-turn-images-detached-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const stagedRoot = join(root, "room-turn-attachments");
  let now = Date.now();
  const stager = new RoomTurnAttachmentStager(stagedRoot, () => now);
  let stagedPath: string | undefined;
  const port = { ...provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("native-turn");
    stagedPath = request.attachments?.[0]?.image?.path;
    // What Codex does when its observation detaches: the native turn goes on.
    throw new Error("Codex room-turn observation detached.");
  }, async () => ({ turnId: "native-turn", outcome: "no_reply", text: null, evidence: "transcript" })),
  roomTurnImageDelivery: async () => "file" as const } satisfies ProviderActionPort;
  const delivery = withAttachmentStager(store, port, {
    poll: async ({ afterMessageId }) => ({ messages: afterMessageId ? [] : [imageMessage("msg_5", [pngAttachment("att_1")])] }),
    downloadAttachment: async () => STAGED_PNG,
    publish: async () => { throw new Error("no reply expected"); },
  }, stager);
  try {
    await delivery.poll(agent);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(stagedPath, "the provider was given a staged file");
    assert.deepEqual(await readFile(stagedPath!), Buffer.from(STAGED_PNG), "the file outlives the detached observation");
    now += STAGED_FOLDER_MAX_AGE_MS + 60_000;
    await stager.sweep();
    assert.deepEqual(await readdir(stagedRoot), [], "the age sweep removes it once no turn can still read it");
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("an agent's first turn on a continuation carries the room history summary, later turns do not", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-history-summary-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const summary = { lines: [{ node: "3:0", first_message_id: "msg_1", last_message_id: "msg_8", last_at: "2026-10-19T09:00:00.000Z",
    text: "Emmy and Ada chose Postgres.", pending: false }], covered_through_message_id: "msg_8" };
  const activation = { for_current_agent: { decision: "activate", reason: "broadcast" } };
  const seen: Array<{ source: string; summary: unknown }> = [];
  let reads = 0;
  let failNext = false;
  let next = 10;
  const http = {
    historySummary: async () => {
      reads++;
      if (failNext) { failNext = false; throw new Error("offline"); }
      return summary;
    },
    poll: async ({ afterMessageId }: { afterMessageId: string | null }) => {
      const after = afterMessageId ? Number(afterMessageId.slice(4)) : 9;
      return { messages: after < next ? [{ id: `msg_${after + 1}`, text: `Question ${after + 1}`, activation }] : [] };
    },
    publish: async () => { throw new Error("no reply expected"); },
  };
  const run = provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    seen.push({ source: request.sourceMessage.id as string, summary: request.historySummary });
    return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
  });
  let delivery = new SupervisedAgentDelivery(store, run, http, currentAuthority, 0);
  try {
    await delivery.poll(agent);
    next = 11;
    await delivery.poll(agent);
    assert.deepEqual(seen, [{ source: "msg_10", summary }, { source: "msg_11", summary: undefined }]);
    assert.equal(reads, 1, "the continuation holds the summary after its first turn");
    // A restarted daemon does not know what the continuation holds: it gives it again.
    await delivery.fenceAndDrain();
    delivery = new SupervisedAgentDelivery(store, run, http, currentAuthority, 0);
    failNext = true;
    next = 12;
    await delivery.poll(agent);
    next = 13;
    await delivery.poll(agent);
    assert.deepEqual(seen.slice(2), [{ source: "msg_12", summary: undefined }, { source: "msg_13", summary }],
      "a failed read gives the turn none and is asked again on the next turn");
    assert.equal(reads, 3);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("the history summary counts as given under every id its continuation had during the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-history-summary-given-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  const summary = { lines: [{ node: "0:0", first_message_id: "msg_1", last_message_id: "msg_1", last_at: "2026-10-19T09:00:00.000Z",
    text: "Emmy: hello", pending: false }], covered_through_message_id: "msg_1" };
  const activation = { for_current_agent: { decision: "activate", reason: "broadcast" } };
  const seen: Array<{ source: string; summary: unknown }> = [];
  let next = 10;
  // A copy whose continuation id changes during a turn, as a Cursor pending id becomes the real one.
  const moving = structuredClone(agent);
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    seen.push({ source: request.sourceMessage.id as string, summary: request.historySummary });
    if (request.historySummary) { moving.handle.providerContinuationId = "thread-real"; moving.providerContinuationId = "thread-real"; }
    return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
  }), {
    historySummary: async () => summary,
    poll: async ({ afterMessageId }: { afterMessageId: string | null }) => {
      const after = afterMessageId ? Number(afterMessageId.slice(4)) : 9;
      return { messages: after < next ? [{ id: `msg_${after + 1}`, text: `Question ${after + 1}`, activation }] : [] };
    },
    publish: async () => { throw new Error("no reply expected"); },
  }, currentAuthority, 0);
  try {
    await delivery.poll(moving);
    // The id changed during the answered first turn: the next turn, under the new id, does not repeat it.
    next = 11;
    await delivery.poll(moving);
    assert.deepEqual(seen.map((turn) => [turn.source, Boolean(turn.summary)]), [["msg_10", true], ["msg_11", false]]);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});
