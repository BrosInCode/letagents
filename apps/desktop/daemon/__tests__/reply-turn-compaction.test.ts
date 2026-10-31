import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderActionPort, ProviderActionStreamEvent } from "../provider-action-port.js";
import { ReplyTurnCompactionObserver, type ReplyTurnCompactionProof } from "../reply-turn-compaction.js";
import { SupervisedAgentDelivery, type SupervisedIngressAgent } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";

const scope = { workAttemptId: "attempt", providerContinuationId: "thread" };
function frame(method = "item/started", change: Partial<ProviderActionStreamEvent> = {}): ProviderActionStreamEvent {
  return { ...scope, observedAt: new Date().toISOString(), sequence: 1, provider: "codex", kind: "provider_event",
    method, payload: { threadId: "thread", turnId: "turn", item: { id: "compact", type: "contextCompaction" } },
    payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null, ...change };
}

test("compaction before the start response waits for the exact admitted turn, then yields only once", () => {
  const proofs: ReplyTurnCompactionProof[] = [];
  const observer = new ReplyTurnCompactionObserver(scope, proof => proofs.push(proof));
  observer.observe(frame());
  assert.equal(proofs.length, 0, "native output alone cannot authorize a yield");
  observer.admit("turn");
  observer.observe(frame());
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]!.isCompacting(), true);
  observer.observe(frame("item/completed"));
  assert.equal(proofs[0]!.isCompacting(), false, "completion cancels a pending authority check");
});

test("foreign, incomplete, projected and display-only frames cannot yield a reply position", () => {
  let yields = 0;
  const observer = new ReplyTurnCompactionObserver(scope, () => yields++);
  observer.admit("turn");
  for (const change of [
    { provider: "claude-code" }, { workAttemptId: "other" }, { providerContinuationId: "other" },
    { payloadTruncated: true }, { payloadRedacted: true }, { lifecycleProjectionOnly: true as const },
    { method: "item/agentMessage/delta", summary: "Compacting context" },
    { payload: { threadId: "other", turnId: "turn", item: { id: "compact", type: "contextCompaction" } } },
    { payload: { threadId: "thread", turnId: "other", item: { id: "compact", type: "contextCompaction" } } },
    { payload: { threadId: "thread", turnId: "turn", turn: { id: "other" }, item: { id: "compact", type: "contextCompaction" } } },
    { payload: { threadId: "thread", turnId: "turn", item: { type: "contextCompaction" } } },
    { payload: { threadId: "thread", turnId: "turn", item: { id: "tool", type: "mcpToolCall" } } },
  ]) observer.observe(frame("item/started", change));
  assert.equal(yields, 0);
});

for (const ending of ["item/completed", "turn/completed", "turn/interrupted", "retired"]) {
  test(`${ending} before admission cannot turn a buffered compaction into a late yield`, () => {
    let yields = 0;
    const observer = new ReplyTurnCompactionObserver(scope, () => yields++);
    observer.observe(frame());
    if (ending === "retired") observer.close();
    else observer.observe(frame(ending));
    observer.admit("turn");
    assert.equal(yields, 0);
  });
}

for (const flag of ["payloadTruncated", "payloadRedacted"] as const) {
  test(`${flag} native terminal before admission revokes buffered compaction without lifecycle authority`, () => {
    let yields = 0;
    const observer = new ReplyTurnCompactionObserver(scope, () => yields++);
    observer.observe(frame());
    observer.observe(frame("turn/completed", { [flag]: true, payload: {} }));
    observer.admit("turn");
    observer.observe(frame());
    assert.equal(yields, 0);
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const mode of ["during-turn", "during-turn-reply", "reporting-failure", "before-checkpoint", "already-completed",
  "completion-during-authority", "terminal-during-authority", "truncated-terminal-during-authority", "redacted-terminal-during-authority",
  "authority-lost", "replaced-handle", "mutated-process-birth",
  "handoff-during-http", "user-stop-during-http", "registration-failure", "independent"]) {
  test(`real inbox compaction yield: ${mode} preserves work, native settlement and delivery authority`, async () => {
    const root = await mkdtemp(join(tmpdir(), "letagents-compaction-yield-"));
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    const connection = { kind: "codex_app_server" as const, url: "ws://127.0.0.1:1", pid: 1, processIdentity: "test-birth" };
    const agent: SupervisedIngressAgent = { agentId: "agent", roomId: "room", provider: "codex", deliveryMode: "daemon_inbox",
      apiUrl: "https://letagents.test", agentSessionId: "session", bearer: "test-memory", executionGenerationId: "generation",
      daemonGeneration: 1, ...scope, providerConnection: { ...connection },
      handle: { ...scope, pid: 1, providerConnection: { ...connection }, observedState: "working" } };
    let allowed = true, runs = 0, yields = 0, noReplies = 0, publications = 0, subscriptions = 0, disposals = 0;
    const silentYieldKinds: unknown[] = [];
    let checkingCompaction = false;
    let listener: ((event: ProviderActionStreamEvent) => void) | null = null;
    const reported = deferred();
    const aborted = deferred(), cleanup = deferred(), nativeFinish = deferred();
    const nextSettled = deferred();
    const hintRead = deferred(), authorityObserved = deferred();
    const originalGet = store.get.bind(store);
    store.get = async id => {
      const row = await originalGet(id);
      if (checkingCompaction) hintRead.resolve();
      return row;
    };
    const stoppedDuringHttp = mode === "handoff-during-http" || mode === "user-stop-during-http";
    const shouldYield = ["during-turn", "during-turn-reply", "reporting-failure", "before-checkpoint"].includes(mode) || stoppedDuringHttp;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false,
        survivesRestart: true, turnControl: "unsupported", continuationRepair: "unsupported" }),
      spawn: async () => { throw new Error("unused"); }, resume: async () => { throw new Error("unused"); },
      attach: async () => null, attachAction: async () => ({ state: "absent" }), poke: async () => {},
      stop: async () => ({ endedAt: "", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread" }),
      onExit: async () => () => {},
      onStream: async (_handle, receive) => {
        subscriptions++;
        if (mode === "registration-failure") throw new Error("optional stream unavailable");
        listener = receive;
        return () => { disposals++; listener = null; };
      },
      runRoomTurn: async (_handle, _request, options) => {
        runs++;
        await options?.beforeNativeDispatch?.();
        if (runs > 1) {
          await options?.checkpointTurnStarted?.("turn-2");
          return { turnId: "turn-2", outcome: "no_reply", text: null };
        }
        if (mode === "before-checkpoint" || mode === "already-completed") listener?.(frame());
        if (mode === "already-completed") listener?.(frame("turn/completed"));
        await options?.checkpointTurnStarted?.("turn");
        if (mode === "authority-lost") allowed = false;
        if (mode === "replaced-handle") agent.handle = { ...agent.handle!, providerConnection: { ...connection, processIdentity: "replacement" } };
        if (mode === "mutated-process-birth") agent.handle!.providerConnection!.processIdentity = "replacement";
        checkingCompaction = true;
        if (!["before-checkpoint", "already-completed"].includes(mode)) listener?.(frame());
        if (shouldYield) await reported.promise;
        else if (["authority-lost", "replaced-handle", "mutated-process-birth"].includes(mode)) {
          await hintRead.promise;
          await new Promise(resolve => setImmediate(resolve)); // Drain the guard after its actual row read.
        } else if (mode.endsWith("during-authority")) await authorityObserved.promise;
        if (stoppedDuringHttp) await nativeFinish.promise;
        if (mode === "during-turn-reply") return { turnId: "turn", outcome: "reply", text: "My own contribution, after compaction." };
        return { turnId: "turn", outcome: "no_reply", text: null };
      },
    };
    const delivery = new SupervisedAgentDelivery(store, port, {
      poll: async () => ({}), publish: async () => { publications++; return { messageId: "msg_2", roomId: agent.roomId }; },
      reportNoReply: async ({ sourceMessageId }) => { noReplies++; if (sourceMessageId === "msg_2") nextSettled.resolve(); },
      yieldReplyTurn: async ({ signal }) => {
        const row = await store.getBySourceMessage(agent.agentId, agent.roomId, "msg_1");
        if (row?.outcome) {
          // A later durable silent ending is a separate scheduling boundary.
          // It must not satisfy the pre-terminal compaction proof below.
          silentYieldKinds.push(JSON.parse(row.outcome).kind);
          return;
        }
        yields++;
        assert.equal(row?.provider_turn_id, "turn");
        assert.equal(row?.state, "dispatching", "yield has not terminalized or requeued native work");
        assert.equal(row?.outcome, null);
        assert.equal(row?.attempt_count, 1);
        reported.resolve();
        if (mode === "reporting-failure") throw new Error("optional yield unavailable");
        if (stoppedDuringHttp) {
          await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
          await cleanup.promise;
        }
      },
    }, async () => {
      if (checkingCompaction && mode.endsWith("during-authority")) {
        checkingCompaction = false;
        listener?.(frame(mode === "completion-during-authority" ? "item/completed" : "turn/completed",
          mode === "truncated-terminal-during-authority" ? { payloadTruncated: true, payload: {} }
            : mode === "redacted-terminal-during-authority" ? { payloadRedacted: true, payload: {} } : {}));
        authorityObserved.resolve();
      }
      return allowed;
    }, 0);
    try {
      await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: "msg_1",
        messages: [{ source_message_id: "msg_1", source_message: { id: "msg_1", text: "Let's pause here." },
          activation: { decision: "activate", reason: "broadcast",
            ...(mode === "independent" ? {} : { turn: { position: 1, count: 2, prior_speakers: [] } }) } }] });
      const pumping = delivery.pump(agent);
      if (mode === "handoff-during-http") {
        await reported.promise;
        let drained = false;
        const stopping = delivery.fenceAndDrain().then(() => { drained = true; });
        await aborted.promise;
        assert.equal(drained, false, "Stop/handoff drains the optional request's cleanup");
        cleanup.resolve(); nativeFinish.resolve();
        await stopping;
      } else if (mode === "user-stop-during-http") {
        await reported.promise;
        assert.equal(await delivery.interruptActiveDelivery(agent), "settled");
        await aborted.promise;
        assert.equal((await store.getBySourceMessage(agent.agentId, agent.roomId, "msg_1"))?.state, "cancelled_by_user");
        nativeFinish.resolve();
        await pumping;
        await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: "msg_2",
          messages: [{ source_message_id: "msg_2", source_message: { id: "msg_2", text: "Next question." },
            activation: { decision: "activate" } }] });
        assert.equal(delivery.wake(agent), true);
        await nextSettled.promise;
        assert.equal((await store.getBySourceMessage(agent.agentId, agent.roomId, "msg_2"))?.state, "acknowledged_no_reply",
          "user Stop leaves the pump able to handle another message");
        let drained = false;
        const stopping = delivery.fenceAndDrain().then(() => { drained = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(drained, false, "the aborted optional request remains tracked until cleanup finishes");
        cleanup.resolve(); await stopping;
      }
      await pumping;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(runs, mode === "user-stop-during-http" ? 2 : 1);
      assert.equal(yields, shouldYield ? 1 : 0);
      assert.ok(silentYieldKinds.length <= 1, "at most one additional hint follows the durable silent ending");
      assert.ok(silentYieldKinds.every(kind => kind === "no_reply"));
      assert.equal(subscriptions, mode === "independent" ? 0 : 1);
      assert.equal(disposals, mode === "registration-failure" ? 0 : subscriptions, "observer is retired with this invocation");
      if (mode === "during-turn-reply") {
        assert.equal((await store.getBySourceMessage(agent.agentId, agent.roomId, "msg_1"))?.state, "acknowledged");
        assert.equal(publications, 1, "yield preserves the agent's later full reply");
      } else if (mode === "user-stop-during-http") {
        assert.equal(noReplies, 1, "only the new message, never the stopped turn, reports no-reply");
        assert.equal(publications, 0);
      } else if (mode === "handoff-during-http") {
        assert.equal(noReplies, 0);
        assert.equal(publications, 0);
      } else if (mode !== "authority-lost") {
        assert.equal((await store.getBySourceMessage(agent.agentId, agent.roomId, "msg_1"))?.state, "acknowledged_no_reply");
        assert.equal(noReplies, 1, "the eventual exact no-reply still uses the ordinary terminal path");
      } else assert.equal(noReplies, 0, "lost authority cannot assert completion");
    } finally { reported.resolve(); cleanup.resolve(); nativeFinish.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
