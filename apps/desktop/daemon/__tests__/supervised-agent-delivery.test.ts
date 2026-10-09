import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ProviderActionFailure, type ProviderActionHandle, type ProviderActionPort, type ProviderRoomTurnResult } from "../provider-action-port.js";
import type { ProviderInstallationToken } from "../provider-stream-coordinator.js";
import { SupervisorDaemon } from "../main.js";
import { ManifestStore } from "../manifest-store.js";
import {
  SupervisedAgentDelivery,
  supervisedReplyTargetForSourceMessage,
} from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { SupervisedDeliveryLifecycleCoordinator } from "../supervised-delivery-lifecycle-coordinator.js";
import { claudeApiFailureClass, defaultFollowUpDelayMs, MAX_AUTOMATIC_FOLLOW_UPS, parseClaudeApiFailure, SHORT_FAULT_FOLLOW_UP_DELAYS_MS, taskFailurePolicy } from "../task-continuity.js";
import { projectDeliveryReceipts } from "../manifest-view-projection.js";
import { cursorAuthorityUnprovenDetail } from "../../electron/main/agents/cursor-turn-settlement.js";
import { NO_REPLY_FAILURE } from "../../../../shared/room-turn-no-reply.mjs";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry } from "../types.js";

const agent = {
  agentId: "stone", roomId: "room", provider: "codex", deliveryMode: "daemon_inbox" as const, apiUrl: "https://letagents.test", agentSessionId: "session-1", bearer: "memory", executionGenerationId: "generation-1", daemonGeneration: 1,
  handle: { workAttemptId: "attempt", providerContinuationId: "thread", pid: 1, providerConnection: { kind: "codex_app_server" as const, url: "ws://127.0.0.1:1", pid: 1, processIdentity: "test-process-birth" }, observedState: "working" as const },
  workAttemptId: "attempt", providerContinuationId: "thread", providerConnection: { kind: "codex_app_server" as const, url: "ws://127.0.0.1:1", pid: 1, processIdentity: "test-process-birth" },
};
const currentAuthority = async () => true;
const TEST_PROVIDER_TURN_AUTHORITY = {
  work_attempt_id: "attempt",
  origin_execution_generation_id: "generation-1",
  provider_continuation_id: "thread",
} as const;
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

test("the central delivery lifecycle rejects every start until the exact provider birth is admitted", async () => {
  let admitted = false;
  let revokeWhileLoading = false;
  let lifecycleActive = false;
  let handoffScheduled = false;
  let whileCheckingAuthority = () => {};
  let refreshes = 0;
  const entry: DaemonManifestEntry = {
    id: "stone", room_id: "room", display_name: "Stone", provider: "codex", model: null,
    charter: "test", desired_state: "running", observed_state: "working", condition: "none",
    permission_profile_id: "supervised", created_by: "test", created_at: new Date().toISOString(),
    work_attempt_id: "attempt", delivery_mode: "daemon_inbox",
    provider_ref: {
      work_attempt_id: "attempt", execution_generation_id: "generation-1",
      provider_continuation_id: "thread", provider_connection: agent.providerConnection,
    },
  };
  const binding = {
    entry_id: "stone", room_id: "room", work_attempt_id: "attempt",
    execution_generation_id: "generation-1", agent_session_id: "session-1",
    credential_ref: "credential", api_url: "https://letagents.test", updated_at: new Date().toISOString(),
    room_cursor: null,
  };
  const lifecycle = new SupervisedDeliveryLifecycleCoordinator({
    isHandoffScheduled: () => handoffScheduled,
    supportsRoomTurns: () => true,
    isLifecycleActive: () => lifecycleActive,
    isOperationallyAdmitted: () => admitted,
    currentDaemonGeneration: () => 1,
    delivery: {
      activeTurn: () => null,
      ensureStarted: async () => { refreshes += 1; },
      refresh: async () => { refreshes += 1; },
      wake: () => {},
    },
    manifest: {
      unresolvedDeliveryDrain: async () => null,
      getEntry: async () => entry,
      getAgentConfiguration: async () => ({}),
      pendingRoomMoves: async () => [],
    },
    roomMoves: { reconcile: async move => move },
    cutovers: { start: async () => {} },
    inbox: {
      get: async () => null,
      preparedRoomMove: async () => null,
      providerTurnBinding: async () => null,
      receipts: async () => [],
    },
    bindings: {
      get: async () => {
        if (revokeWhileLoading) admitted = false;
        return binding;
      },
      credentialFor: async () => "memory",
    },
    liveHandle: () => agent.handle,
    providerAuthority: { isExactAuthority: async () => { whileCheckingAuthority(); return true; } },
    scheduleRecovery: () => {},
  });

  await lifecycle.start("stone");
  assert.equal(refreshes, 0, "worker bind, restart, wake, and recovery share this inert gate");
  admitted = true;
  revokeWhileLoading = true;
  await lifecycle.start("stone");
  assert.equal(refreshes, 0,
    "a birth replaced while durable identity loads cannot cross the final delivery gate");
  admitted = true;
  revokeWhileLoading = false;
  for (const mode of ["refresh", "ensure", "wake"] as const) {
    whileCheckingAuthority = () => { lifecycleActive = true; };
    await lifecycle.start("stone", mode);
    assert.equal(refreshes, 0, "a start suspended before lifecycle admission must remain fenced");
    lifecycleActive = false;
    whileCheckingAuthority = () => { handoffScheduled = true; };
    await lifecycle.start("stone", mode);
    assert.equal(refreshes, 0, "handoff during authority reads must prevent delivery admission");
    handoffScheduled = false;
  }
  whileCheckingAuthority = () => {};
  await lifecycle.start("stone");
  assert.equal(refreshes, 1);
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

test("idle-only stop refuses both sides of native turn admission without aborting work", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-idle-stop-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    const delivery = new SupervisedAgentDelivery(
      store,
      provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })),
      { poll: async () => ({}), publish: async () => {} },
      currentAuthority,
    );
    const internals = delivery as unknown as {
      activeTurnAborts: Map<string, { inboxItemId: string; controller: AbortController }>;
      activeTurns: Map<string, unknown>;
      stoppingAgents: Set<string>;
    };
    const preNative = new AbortController();
    internals.activeTurnAborts.set(agent.agentId, { inboxItemId: "item-1", controller: preNative });
    assert.equal(await delivery.stopIfIdle(agent.agentId), false);
    assert.equal(preNative.signal.aborted, false, "a rejected apply cannot interrupt pre-native work");

    internals.activeTurnAborts.delete(agent.agentId);
    internals.activeTurns.set(agent.agentId, {});
    assert.equal(await delivery.stopIfIdle(agent.agentId), false);
    internals.activeTurns.delete(agent.agentId);

    const stopped = delivery.stopIfIdle(agent.agentId);
    assert.equal(internals.stoppingAgents.has(agent.agentId), true,
      "the idle lane is fenced synchronously before its drain crosses an await");
    assert.equal(await stopped, true);
    assert.equal(internals.stoppingAgents.has(agent.agentId), false);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("idle reservation keeps delayed and new delivery starts fenced until replacement settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-idle-reservation-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const entered = deferred<void>();
  const proceed = deferred<void>();
  let suspend = true;
  let polls = 0;
  const delivery = new SupervisedAgentDelivery(store,
    provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })),
    { poll: async () => { polls += 1; return {}; }, publish: async () => {} },
    async () => {
      if (suspend) { suspend = false; entered.resolve(); await proceed.promise; }
      return true;
    });
  try {
    const delayed = delivery.ensureStarted(agent);
    await entered.promise;
    const release = await delivery.reserveIdle(agent.agentId);
    assert.ok(release);
    assert.equal(await delivery.reserveIdle(agent.agentId), null, "one lifecycle owner per agent");
    proceed.resolve();
    await delayed;
    await delivery.ensureStarted(agent);
    await delivery.refresh(agent);
    await delivery.poll(agent);
    assert.equal(polls, 0, "neither a paused predecessor nor a fresh caller may restart intake");
    release();
    release();
    await delivery.poll(agent);
    assert.equal(polls, 1, "normal delivery can resume after release");
  } finally {
    proceed.resolve();
    await delivery.stop(agent.agentId);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor delivery exposes the exact-agent lifecycle settlement barrier to the adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cursor-settlement-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const recordCompletion = installCursorCompletionProjectionFixture(store);
  const settledAgents: string[] = [];
  const cursorAgent = { ...agent, provider: "cursor" };
  const delivery = new SupervisedAgentDelivery(
    store,
    provider(async (_handle, request, options) => {
      assert.equal(typeof options?.settleLifecycleBeforeIdle, "function");
      await options!.settleLifecycleBeforeIdle!();
      recordCompletion(request.inboxItemId, { outcome: "no_reply" });
      return { turnId: request.inboxItemId, outcome: "no_reply", text: null };
    }),
    { poll: async () => ({}), publish: async () => { throw new Error("no-reply must not publish"); } },
    currentAuthority,
    50,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (settledAgent) => { settledAgents.push(settledAgent.agentId); },
  );
  try {
    await ingest(store);
    await delivery.pump(cursorAgent);
    assert.deepEqual(settledAgents, [cursorAgent.agentId]);
    assert.equal((await store.receipts(cursorAgent.agentId))[0]?.state, "acknowledged_no_reply");
  } finally {
    await delivery.fenceAndDrain().catch(() => undefined);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor recovery receives the same exact-agent lifecycle settlement barrier", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cursor-recovery-settlement-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const recordCompletion = installCursorCompletionProjectionFixture(store);
  const settledAgents: string[] = [];
  const cursorAgent = { ...agent, provider: "cursor" };
  const delivery = new SupervisedAgentDelivery(
    store,
    provider(
      async () => { throw new Error("recovery must not redispatch the Cursor turn"); },
      async (_handle, request, options) => {
        assert.equal(typeof options?.settleLifecycleBeforeIdle, "function");
        await options!.settleLifecycleBeforeIdle!();
        recordCompletion(request.providerTurnId, { outcome: "no_reply" });
        return { turnId: request.providerTurnId, outcome: "no_reply", text: null };
      },
    ),
    { poll: async () => ({}), publish: async () => { throw new Error("no-reply must not publish"); } },
    currentAuthority,
    50,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (settledAgent) => { settledAgents.push(settledAgent.agentId); },
  );
  try {
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "cursor:recover-settlement", TEST_PROVIDER_TURN_AUTHORITY);
    await delivery.pump(cursorAgent);
    assert.deepEqual(settledAgents, [cursorAgent.agentId]);
    assert.equal((await store.receipts(cursorAgent.agentId))[0]?.state, "acknowledged_no_reply");
  } finally {
    await delivery.fenceAndDrain().catch(() => undefined);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor publication and recovery use only the exact-turn structured completion proposal", async () => {
  const proposal = {
    state: "completed",
    request: { outcome: "reply", text: "The actual room answer." },
  };
  let proposalRows: Array<typeof proposal> = [proposal];
  const queries: Array<[string, string, string]> = [];
  const inbox = {
    roomTurnCompletionEffects: async (agentId: string, generationId: string, turnId: string) => {
      queries.push([agentId, generationId, turnId]);
      return proposalRows;
    },
  };
  const project = (delivery: SupervisedAgentDelivery) => (delivery as unknown as {
    publicationResult: (
      candidate: typeof agent,
      result: { turnId: string; outcome: "reply"; text: string; evidence: "stream"; publicationContract: "structured_room_turn_v1" },
      originExecutionGenerationId: string,
    ) => Promise<{ turnId: string; outcome: string; text: string | null; evidence: string }>;
  }).publicationResult(
    { ...agent, provider: "cursor" },
    {
      turnId: "cursor-turn-1",
      outcome: "reply",
      // Cursor joins every assistant delta into this aggregate. It deliberately
      // contains progress prose that must never become the room answer.
      text: "I'll investigate. Running a tool. The actual room answer.",
      evidence: "stream",
      publicationContract: "structured_room_turn_v1",
    },
    "generation-1",
  );
  const makeDelivery = () => new SupervisedAgentDelivery(
    inbox as unknown as SupervisedAgentInboxStore,
    provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })),
    { poll: async () => ({}), publish: async () => {} },
    currentAuthority,
  );

  const first = await project(makeDelivery());
  assert.deepEqual(first, {
    turnId: "cursor-turn-1", outcome: "reply", text: "The actual room answer.", evidence: "stream",
  });
  const recovered = await project(makeDelivery());
  assert.deepEqual(recovered, first, "a replacement delivery reconstructs the same public answer from the journal");
  assert.deepEqual(queries, [
    [agent.agentId, "generation-1", "cursor-turn-1"],
    [agent.agentId, "generation-1", "cursor-turn-1"],
  ], "publication is namespaced to the exact origin generation and provider turn");

  proposalRows = [];
  const legacyRecovered = await (makeDelivery() as unknown as {
    publicationResult: (
      candidate: typeof agent,
      result: { turnId: string; outcome: "reply"; text: string; evidence: "stream"; publicationContract: "legacy_cursor_aggregate_v0" },
      originExecutionGenerationId: string,
    ) => Promise<unknown>;
  }).publicationResult(
    { ...agent, provider: "cursor" },
    {
      turnId: "cursor-legacy-turn", outcome: "reply", text: "Legacy recovered aggregate.", evidence: "stream",
      publicationContract: "legacy_cursor_aggregate_v0",
    },
    "generation-1",
  );
  assert.deepEqual(legacyRecovered, {
    turnId: "cursor-legacy-turn", outcome: "reply", text: "Legacy recovered aggregate.", evidence: "stream",
    publicationContract: "legacy_cursor_aggregate_v0",
  }, "only explicitly versioned legacy durable evidence may use the old aggregate publication path");
  assert.deepEqual(await project(makeDelivery()), {
    turnId: "cursor-turn-1", outcome: "unreadable", text: null, evidence: "none",
  }, "a missing proposal never falls back to Cursor's aggregate text");
  proposalRows = [proposal, { ...proposal }];
  assert.deepEqual(await project(makeDelivery()), {
    turnId: "cursor-turn-1", outcome: "unreadable", text: null, evidence: "none",
  }, "conflicting proposals fail closed instead of picking one by row order");
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
    await delivery.poll({ ...agent, handle: null, providerConnection: null });
    assert.equal(turns, 0);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "pending");
    assert.equal((await store.ingressHealth(agent.agentId))?.state, "observing");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("new-source custody is selected before the asynchronous poll and never refreshed for a replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-source-custody-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const entered = deferred<void>(); const release = deferred<void>();
  let custody = "original-grant"; let selections = 0;
  const observed: Array<{ custody: string; origin: string; session: string; ids: string[] }> = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
    poll: async () => { assert.ok(selections > 0, "custody must be frozen before HTTP starts"); entered.resolve(); await release.promise;
      return { messages: [{ id: "msg_1", activation: { for_current_agent: { decision: "activate" } } }] }; },
    publish: async () => { throw new Error("ingress-only observation must not publish"); },
  }, currentAuthority, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, candidate => {
    selections++;
    const snapshot = { custody, origin: candidate.apiUrl, session: candidate.agentSessionId };
    return ids => observed.push({ ...snapshot, ids: [...ids] });
  });
  try {
    await store.bootstrapCursor({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: null });
    const ingress = { ...agent, handle: null, providerConnection: null };
    const pending = delivery.poll(ingress); await entered.promise;
    custody = "replacement-grant"; release.resolve(); await pending;
    assert.deepEqual(observed, [{ custody: "original-grant", origin: agent.apiUrl, session: agent.agentSessionId, ids: ["msg_1"] }]);
    await delivery.poll(ingress);
    assert.equal(selections, 2); assert.equal(observed.length, 1, "a later current grant cannot reattribute existing work");
  } finally { release.resolve(); await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("throwing source observation hooks cannot block native delivery", async () => {
  for (const failure of ["selection", "notification"] as const) {
    const root = await mkdtemp(join(tmpdir(), "letagents-delivery-source-hint-failure-"));
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    let selections = 0; let notifications = 0; let turns = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      turns++; await options?.beforeNativeDispatch?.(); await options?.checkpointTurnStarted?.("native-turn");
      return { turnId: "native-turn", outcome: "no_reply", text: null, evidence: "stream" };
    }), {
      poll: async () => ({ messages: [{ id: "msg_1", activation: { for_current_agent: { decision: "activate" } } }] }),
      publish: async () => { throw new Error("no-reply delivery must not publish"); },
    }, currentAuthority, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => {
      selections++; if (failure === "selection") throw new Error("optional source snapshot unavailable");
      return () => { notifications++; throw new Error("optional publication receipt unavailable"); };
    });
    try {
      await store.bootstrapCursor({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: null });
      await delivery.poll(agent);
      assert.equal(selections, 1); assert.equal(notifications, failure === "notification" ? 1 : 0);
      assert.equal(turns, 1); assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
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

async function seedCursorRoomTurnCompletion(
  store: SupervisedAgentInboxStore,
  input: {
    agentId: string; roomId: string; executionGenerationId: string; workAttemptId: string;
    providerContinuationId: string; providerTurnId: string; outcome: "reply" | "no_reply"; text?: string;
  },
): Promise<void> {
  await store.prepareEffect({
    agent_id: input.agentId,
    room_id: input.roomId,
    execution_generation_id: input.executionGenerationId,
    provider_turn_id: input.providerTurnId,
    work_attempt_id: input.workAttemptId,
    current_execution_generation_id: input.executionGenerationId,
    provider_continuation_id: input.providerContinuationId,
    mcp_request_id: `test-complete:${input.providerTurnId}`,
    tool_name: "complete_room_turn",
    request: input.outcome === "reply"
      ? { outcome: "reply", text: input.text ?? "" }
      : { outcome: "no_reply" },
    mutation: true,
  });
}

function installCursorCompletionProjectionFixture(store: SupervisedAgentInboxStore): (
  providerTurnId: string,
  completion: { outcome: "reply" | "no_reply"; text?: string },
) => void {
  const completions = new Map<string, { outcome: "reply" | "no_reply"; text?: string }>();
  const original = store.roomTurnCompletionEffects.bind(store);
  (store as unknown as {
    roomTurnCompletionEffects: (
      agentId: string, originExecutionGenerationId: string, providerTurnId: string,
    ) => Promise<Array<{ state: "completed"; request: { outcome: "reply" | "no_reply"; text?: string } }>>;
  }).roomTurnCompletionEffects = async (agentId, originExecutionGenerationId, providerTurnId) => {
    const completion = completions.get(providerTurnId);
    return completion
      ? [{ state: "completed", request: completion }]
      : original(agentId, originExecutionGenerationId, providerTurnId) as never;
  };
  return (providerTurnId, completion) => { completions.set(providerTurnId, completion); };
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

async function installExactTestProviderBirth(
  internals: {
    store: ManifestStore;
    manifestGeneration: number;
    providerStreams: {
      install(
        entryId: string,
        handle: ProviderActionHandle,
        executionGenerationId: string,
        mayStartDelivery: () => boolean,
      ): Promise<void>;
    };
  },
  entryId: string,
  handle: ProviderActionHandle,
  executionGenerationId: string,
): Promise<void> {
  const entry = await internals.store.getEntry(entryId);
  assert.ok(entry?.work_attempt_id && entry.workspace_path && handle.providerConnection);
  const database = (internals.store as unknown as { database: DatabaseSync }).database;
  database.prepare(`INSERT OR IGNORE INTO work_attempts(
    work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,
    workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    entry.work_attempt_id,
    `task:${entryId}`,
    `lease:${entryId}`,
    1,
    entry.workspace_path,
    "repo",
    "remote",
    "revision",
    `${entry.workspace_path}/.bare`,
    "active",
    new Date().toISOString(),
  );
  database.prepare(`INSERT OR IGNORE INTO work_attempt_executions(
    execution_generation_id,work_attempt_id,started_at,actor,generation,terminal_json
  ) VALUES(?,?,?,?,?,NULL)`).run(
    executionGenerationId,
    entry.work_attempt_id,
    new Date().toISOString(),
    "test",
    1,
  );
  const snapshot = await internals.store.load();
  const birth = await internals.store.checkpointProviderBirth(snapshot.generation, {
    entry,
    executionGenerationId,
    providerConnection: handle.providerConnection,
    appliedRevision: handle.appliedConfigurationRevision ?? 1,
    requestedAuthorityMode: "typed_shadow",
    observedAtMs: Date.now(),
  });
  internals.manifestGeneration = birth.generation;
  await internals.providerStreams.install(entryId, handle, executionGenerationId, () => false);
}

test("Cursor dynamic checkpoint converges after manifest commit but attempt durability failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-cursor-provider-checkpoint-"));
  let daemon: SupervisorDaemon | null = null;
  try {
    const paths = {
      lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"),
      manifestPath: join(root, "daemon.sqlite"), auditPath: join(root, "audit.log"),
      attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempts"),
      workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
    };
    const workAttemptId = "00000000-0000-4000-8000-000000000041";
    const executionGenerationId = "00000000-0000-4000-8000-000000000042";
    const pendingContinuation = "cursor-pending:checkpoint";
    const realContinuation = "sess-cursor-checkpoint";
    const providerConnection = {
      kind: "cursor_cli" as const,
      pid: 43141,
      processIdentity: "pid:43141:birth:exact",
    };
    const terminalAt = new Date().toISOString();
    let liveContinuation = pendingContinuation;
    const liveHandle = {
      workAttemptId,
      get providerContinuationId() { return liveContinuation; },
      pid: providerConnection.pid,
      providerConnection,
      appliedConfigurationRevision: 1,
      observedState: () => "working" as const,
    };
    const ingressAgent = {
      agentId: "cursor-checkpoint", roomId: "room", provider: "cursor",
      deliveryMode: "daemon_inbox" as const, apiUrl: "https://letagents.test",
      agentSessionId: "agent-session", bearer: "memory",
      executionGenerationId, daemonGeneration: 1,
      handle: liveHandle, workAttemptId,
      providerContinuationId: pendingContinuation, providerConnection,
    };
    daemon = new SupervisorDaemon(
      paths,
      "darwin",
      provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })),
      false,
      60_000,
      undefined,
      {},
      {
        poll: ({ signal }) => new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({}), { once: true });
        }),
        publish: async () => {},
      },
    );
    await daemon.start();
    const put = await daemonRequest(paths.socketPath, "manifest.put", {
      entry: {
        id: ingressAgent.agentId, room_id: ingressAgent.roomId,
        display_name: "Cursor Checkpoint", provider: "cursor", model: null,
        charter: "test", desired_state: "running", observed_state: "working",
        condition: "none", permission_profile_id: "read_only",
        delivery_mode: "daemon_inbox", created_by: "test",
        created_at: new Date().toISOString(), workspace_path: root,
        work_attempt_id: workAttemptId,
        provider_ref: {
          work_attempt_id: workAttemptId,
          provider_continuation_id: pendingContinuation,
          provider_connection: providerConnection,
          execution_generation_id: executionGenerationId,
        },
      },
    });
    assert.equal(put.ok, true, put.error);

    const durableCheckpoints: string[] = [];
    let checkpointCalls = 0;
    const internals = daemon as unknown as {
      liveHandles: Map<string, typeof liveHandle>;
      manifestGeneration: number;
      providerStreams: {
        install(
          entryId: string,
          handle: ProviderActionHandle,
          executionGenerationId: string,
          mayStartDelivery: () => boolean,
        ): Promise<void>;
        currentInstallation(entryId: string): ProviderInstallationToken | undefined;
      };
      providerTerminals: { handleTerminal(installation: ProviderInstallationToken, terminal: {
        endedAt: string; exitCode: number; signal: null; terminalCause: "crashed";
        providerContinuationId: string;
      }): Promise<void> };
      workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
      supervisedInbox: SupervisedAgentInboxStore;
      store: ManifestStore;
      durability: {
        getAttempt(id: string): Promise<{
          checkpoints: Array<{ provider_continuation_id: string | null }>;
          execution_generations: Array<{
            execution_generation_id: string;
            actor: string;
            generation: number;
            terminal: import("../types.js").ExecutionTerminalPayload;
          }>;
        }>;
        checkpoint(id: string, input: { provider_continuation_id: string | null }): Promise<void>;
      };
      providerCheckpoints: {
        checkpointDynamicState(input: {
          agent: typeof ingressAgent;
          inboxItemId: string;
          providerTurnId: string;
          providerContinuationId: string;
          providerConnection: typeof providerConnection;
        }): Promise<void>;
      };
    };
    await installExactTestProviderBirth(
      internals,
      ingressAgent.agentId,
      liveHandle,
      executionGenerationId,
    );
    await internals.workerBindings.bind({
      entry_id: ingressAgent.agentId,
      room_id: ingressAgent.roomId,
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      agent_session_id: ingressAgent.agentSessionId,
      agent_session_token: ingressAgent.bearer,
      credential_ref: "credential-ref",
      api_url: ingressAgent.apiUrl,
    });
    await internals.supervisedInbox.ingestPoll({
      agent_id: ingressAgent.agentId,
      room_id: ingressAgent.roomId,
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { id: "1" }, activation: {} }],
    });
    const inboxItem = await internals.supervisedInbox.claimHead(ingressAgent.agentId);
    assert.ok(inboxItem);
    const providerTurnId = "cursor:checkpoint-transition";
    await internals.supervisedInbox.checkpointTurnStarted(inboxItem.inbox_item_id, providerTurnId, {
      work_attempt_id: workAttemptId,
      origin_execution_generation_id: executionGenerationId,
      provider_continuation_id: pendingContinuation,
    });
    internals.durability.getAttempt = async () => ({
      checkpoints: durableCheckpoints.map((provider_continuation_id) => ({ provider_continuation_id })),
      execution_generations: [{
        execution_generation_id: executionGenerationId,
        actor: "test",
        generation: 1,
        terminal: { ended_at: terminalAt, exit_code: 1, signal: null, terminal_cause: "crashed",
          provider_continuation_id: realContinuation, actor: "test", generation: 1, stdio_archive_ref: null, stdio_tail: "" },
      }],
    });
    internals.durability.checkpoint = async (_id, checkpoint) => {
      checkpointCalls += 1;
      if (checkpointCalls === 1) throw new Error("attempt database unavailable after manifest commit");
      assert.equal(checkpoint.provider_continuation_id, realContinuation);
      durableCheckpoints.push(realContinuation);
    };

    liveContinuation = realContinuation;
    await internals.providerCheckpoints.checkpointDynamicState({
      agent: ingressAgent,
      inboxItemId: inboxItem.inbox_item_id,
      providerTurnId,
      providerContinuationId: realContinuation,
      providerConnection,
    });
    assert.equal(
      (await internals.store.getEntry(ingressAgent.agentId))?.provider_ref.provider_continuation_id,
      realContinuation,
      "manifest commit is retained",
    );
    assert.equal(ingressAgent.providerContinuationId, realContinuation, "ingress authority converges to the committed manifest");
    assert.equal(liveHandle.providerContinuationId, realContinuation);

    await internals.providerCheckpoints.checkpointDynamicState({
      agent: ingressAgent,
      inboxItemId: inboxItem.inbox_item_id,
      providerTurnId,
      providerContinuationId: realContinuation,
      providerConnection,
    });
    assert.deepEqual(durableCheckpoints, [realContinuation], "retry finishes only the missing idempotent checkpoint");

    const installation = internals.providerStreams.currentInstallation(ingressAgent.agentId);
    assert.ok(installation);
    await internals.providerTerminals.handleTerminal(installation, {
        endedAt: terminalAt,
        exitCode: 1,
        signal: null,
        terminalCause: "crashed",
        providerContinuationId: realContinuation,
      });
    assert.equal(internals.liveHandles.has(ingressAgent.agentId), false, "terminal notification retires the live handle");
    await assert.rejects(
      internals.providerCheckpoints.checkpointDynamicState({
        agent: ingressAgent,
        inboxItemId: inboxItem.inbox_item_id,
        providerTurnId,
        providerContinuationId: realContinuation,
        providerConnection,
      }),
      /Cursor provider state no longer belongs to the exact supervised lane/,
      "a Cursor recovery callback must checkpoint before emitting its terminal notification",
    );
  } finally {
    await daemon?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("first and sequential Cursor turns cross one atomic prepared boundary without losing FIFO authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "la-cfa-"));
  let daemon: SupervisorDaemon | null = null;
  const preparedStoreEntered = deferred<void>();
  const releasePreparedStore = deferred<void>();
  try {
    const paths = {
      lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"),
      manifestPath: join(root, "daemon.sqlite"), auditPath: join(root, "audit.log"),
      attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempts"),
      workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
    };
    const workAttemptId = "00000000-0000-4000-8000-000000000051";
    const executionGenerationId = "00000000-0000-4000-8000-000000000052";
    let continuation = "cursor-pending:first-turn";
    let connection = { kind: "cursor_cli" as const, pid: null as number | null, processIdentity: null as string | null };
    const liveHandle = {
      workAttemptId,
      get pid() { return connection.pid; },
      get providerContinuationId() { return continuation; },
      get providerConnection() { return connection; },
      appliedConfigurationRevision: 1,
      observedState: () => connection.pid === null ? "idle" as const : "working" as const,
    };
    const order: string[] = [];
    const published: string[] = [];
    let turns = 0;
    let staleCheckpoint: ((state: { providerContinuationId: string; providerConnection: typeof connection }) => Promise<void>) | undefined;
    const port = provider(async (_handle, request, options) => {
      turns += 1;
      const turn = turns;
      const providerTurnId = `cursor:atomic:${turn}`;
      await options?.beforeNativeDispatch?.();
      order.push(`intent:${turn}`);
      connection = { kind: "cursor_cli", pid: 81_000 + turn, processIdentity: `wrapper-birth:${turn}` };
      await options?.checkpointPreparedTurn?.({
        providerTurnId,
        providerContinuationId: continuation,
        providerConnection: connection,
      });
      order.push(`prepared:${turn}`);
      const current = await internals.supervisedInbox.get(request.inboxItemId);
      assert.equal(current?.provider_turn_id, providerTurnId, "turn id is durable in the same boundary as wrapper birth");
      options?.markDurableTurnStarted?.();
      order.push(`released:${turn}`);
      if (turn === 1) {
        continuation = "cursor-session:first-turn";
      } else if (staleCheckpoint) {
        await assert.rejects(staleCheckpoint({
          providerContinuationId: continuation,
          providerConnection: connection,
        }), /exact durable turn|supervised lane/,
        "a callback bound to the acknowledged first turn cannot mutate the second turn");
      }
      await options?.checkpointProviderState?.({ providerContinuationId: continuation, providerConnection: connection });
      assert.equal(
        (await internals.supervisedInbox.providerTurnBinding(request.inboxItemId))?.provider_continuation_id,
        continuation,
        "the exact Cursor turn binding follows its atomic pending-to-real continuation transition",
      );
      if (turn === 1) staleCheckpoint = options?.checkpointProviderState as typeof staleCheckpoint;
      connection = { kind: "cursor_cli", pid: null, processIdentity: null };
      await options?.checkpointProviderState?.({ providerContinuationId: continuation, providerConnection: connection });
      await seedCursorRoomTurnCompletion(internals.supervisedInbox, {
        agentId: "cursor-atomic", roomId: "room", executionGenerationId, workAttemptId,
        providerContinuationId: continuation, providerTurnId, outcome: "reply", text: `reply ${turn}`,
      });
      const raw = { turnId: providerTurnId, outcome: "reply" as const, text: `ignored aggregate ${turn}` };
      return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw;
    });
    daemon = new SupervisorDaemon(paths, "darwin", port, false, 60_000, undefined, {}, {
      poll: async () => ({ messages: [
        { id: "1", text: "first", activation: { for_current_agent: { decision: "activate" } } },
        { id: "2", text: "second", activation: { for_current_agent: { decision: "activate" } } },
      ] }),
      publish: async (input) => {
        published.push(input.text);
        return { messageId: `published:${published.length}`, roomId: input.roomId };
      },
    });
    const internals = daemon as unknown as {
      liveHandles: Map<string, typeof liveHandle>;
      workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
      supervisedInbox: SupervisedAgentInboxStore;
      startSupervisedDelivery(entryId: string): Promise<void>;
      setDisplayName(entryId: string, displayName: string): Promise<unknown>;
      store: ManifestStore;
      manifestGeneration: number;
      providerStreams: {
        install(
          entryId: string,
          handle: ProviderActionHandle,
          executionGenerationId: string,
          mayStartDelivery: () => boolean,
        ): Promise<void>;
      };
    };
    await daemon.start();
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      id: "cursor-atomic", room_id: "room", display_name: "Cursor Atomic", provider: "cursor", model: null,
      charter: "test", desired_state: "running", observed_state: "idle", condition: "none",
      permission_profile_id: "read_only", delivery_mode: "daemon_inbox", created_by: "test",
      created_at: new Date().toISOString(), workspace_path: root, work_attempt_id: workAttemptId,
      provider_ref: {
        work_attempt_id: workAttemptId,
        provider_continuation_id: continuation,
        provider_connection: connection,
        execution_generation_id: executionGenerationId,
      },
    } });
    assert.equal(put.ok, true, put.error);
    await installExactTestProviderBirth(
      internals,
      "cursor-atomic",
      liveHandle,
      executionGenerationId,
    );
    await internals.workerBindings.bind({
      entry_id: "cursor-atomic", room_id: "room", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "cursor-agent-session",
      agent_session_token: "cursor-memory-bearer", credential_ref: "cursor-credential-ref",
      api_url: "https://letagents.test",
    });
    await internals.supervisedInbox.bootstrapCursor({ agent_id: "cursor-atomic", room_id: "room", last_observed_message_id: null });
    const checkpointPrepared = internals.store.checkpointCursorPreparedTurn.bind(internals.store);
    let pausePreparedStore = true;
    internals.store.checkpointCursorPreparedTurn = async (...args: Parameters<ManifestStore["checkpointCursorPreparedTurn"]>) => {
      if (pausePreparedStore) {
        pausePreparedStore = false;
        preparedStoreEntered.resolve();
        await releasePreparedStore.promise;
      }
      return checkpointPrepared(...args);
    };
    await internals.startSupervisedDelivery("cursor-atomic");
    await preparedStoreEntered.promise;
    let renameSettled = false;
    const rename = internals.setDisplayName("cursor-atomic", "Cursor Atomic Renamed")
      .then(() => { renameSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(renameSettled, false, "a full-entry writer cannot pass an in-flight atomic Cursor checkpoint");
    releasePreparedStore.resolve();
    await rename;
    await waitForAsync(async () => {
      const receipts = await internals.supervisedInbox.receipts("cursor-atomic");
      return receipts.length === 2 && receipts.every((receipt) => receipt.state === "acknowledged");
    }, 2_000);
    assert.equal(turns, 2);
    assert.deepEqual(published, ["reply 1", "reply 2"]);
    assert.deepEqual(order, [
      "intent:1", "prepared:1", "released:1",
      "intent:2", "prepared:2", "released:2",
    ]);
    const durable = await internals.store.getEntry("cursor-atomic");
    assert.equal(durable?.display_name, "Cursor Atomic Renamed");
    assert.equal(durable?.provider_ref?.provider_continuation_id, "cursor-session:first-turn");
    assert.deepEqual(durable?.provider_ref?.provider_connection, { kind: "cursor_cli", pid: null, processIdentity: null });
  } finally {
    releasePreparedStore.resolve();
    await daemon?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "restarts the agent", priorLaneEndings: 0, fileChangesLost: true,
    expected: "Cursor finished this turn, but LetAgents could not confirm that the turn's helper processes had stopped. "
      + "The turn's reply was not posted and its file changes were not kept. LetAgents restarts the agent.",
  },
  {
    name: "leaves a quarantined agent to its owner", priorLaneEndings: 4, fileChangesLost: false,
    expected: "Cursor finished this turn, but LetAgents could not confirm that the turn's helper processes had stopped. "
      + "The turn's reply was not posted. Automatic recovery was stopped after repeated provider exits. The agent needs you to recover it.",
  },
] as const) {
test(`a Cursor turn that finished without proof its authority ended is settled as lost, its reply is withheld, the next message still runs, and the reason ${scenario.name}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "la-cursor-unproven-"));
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"),
    manifestPath: join(root, "daemon.sqlite"), auditPath: join(root, "audit.log"),
    attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempts"),
    workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
  };
  const agentId = "cursor-unproven";
  const workAttemptId = "00000000-0000-4000-8000-000000000101";
  const executionGenerationId = "00000000-0000-4000-8000-000000000102";
  const continuation = "cursor-session:unproven";
  const idle = { kind: "cursor_cli" as const, pid: null as number | null, processIdentity: null as string | null };
  let connection = idle;
  const liveHandle = {
    workAttemptId,
    get pid() { return connection.pid; },
    get providerContinuationId() { return continuation; },
    get providerConnection() { return connection; },
    appliedConfigurationRevision: 1,
    observedState: () => connection.pid === null ? "idle" as const : "working" as const,
  };
  const published: string[] = [];
  // What the adapter reports; the daemon appends what happens to the agent next.
  const detail = cursorAuthorityUnprovenDetail(scenario.fileChangesLost);
  let turns = 0;
  let daemon!: SupervisorDaemon;
  const port = provider(async (_handle, request, options) => {
    turns += 1;
    const turn = turns;
    const providerTurnId = `cursor:unproven:${turn}`;
    await options?.beforeNativeDispatch?.();
    connection = { kind: "cursor_cli", pid: 95_000 + turn, processIdentity: `wrapper:unproven:${turn}` };
    await options?.checkpointPreparedTurn?.({ providerTurnId, providerContinuationId: continuation, providerConnection: connection });
    options?.markDurableTurnStarted?.();
    await options?.checkpointProviderState?.({ providerContinuationId: continuation, providerConnection: connection });
    connection = idle;
    await options?.checkpointProviderState?.({ providerContinuationId: continuation, providerConnection: connection });
    // The model journaled a reply for both messages through complete_room_turn.
    await seedCursorRoomTurnCompletion(internals().supervisedInbox, {
      agentId, roomId: "room", executionGenerationId, workAttemptId,
      providerContinuationId: continuation, providerTurnId, outcome: "reply", text: `reply ${turn}`,
    });
    const raw: ProviderRoomTurnResult = turn === 1
      // The wrapper saw a successful result but could not prove it revoked the turn's remote authority.
      ? { turnId: providerTurnId, providerContinuationId: continuation, outcome: "interrupted", text: null,
        evidence: "stream", error: detail, authorityUnproven: true }
      : { turnId: providerTurnId, outcome: "reply", text: `ignored aggregate ${turn}` };
    return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw;
  });
  daemon = new SupervisorDaemon(paths, "darwin", port, false, 60_000, undefined, {}, {
    poll: async () => ({}),
    publish: async (input) => {
      published.push(input.text);
      return { messageId: `published:${published.length}`, roomId: input.roomId };
    },
  });
  const internals = () => daemon as unknown as {
    liveHandles: Map<string, typeof liveHandle>;
    workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
    supervisedInbox: SupervisedAgentInboxStore;
    startSupervisedDelivery(entryId: string): Promise<void>;
    store: ManifestStore;
    manifestGeneration: number;
    providerStreams: {
      install(entryId: string, handle: ProviderActionHandle, executionGenerationId: string, mayStartDelivery: () => boolean): Promise<void>;
    };
  };
  try {
    await daemon.start();
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      id: agentId, room_id: "room", display_name: "Cursor Unproven", provider: "cursor", model: null,
      charter: "test", desired_state: "running", observed_state: "idle", condition: "none",
      permission_profile_id: "read_only", delivery_mode: "daemon_inbox", created_by: "test",
      created_at: new Date().toISOString(), workspace_path: root, work_attempt_id: workAttemptId,
      provider_ref: {
        work_attempt_id: workAttemptId, provider_continuation_id: continuation,
        provider_connection: connection, execution_generation_id: executionGenerationId,
      },
      reconciliation: {
        // Lane endings already inside the crash-loop window; the lane about to end is the next one.
        exit_timestamps_ms: Array.from({ length: scenario.priorLaneEndings }, (_, index) => Date.now() - 1_000 * (index + 1)),
        consecutive_action_failures: 0, last_observed_state: "idle", next_restart_at_ms: null,
        completed_action_ids: [], last_action_sequence: 0, pending_action: null,
      },
    } });
    assert.equal(put.ok, true, put.error);
    await installExactTestProviderBirth(internals(), agentId, liveHandle, executionGenerationId);
    await internals().workerBindings.bind({
      entry_id: agentId, room_id: "room", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "session:unproven",
      agent_session_token: "bearer:unproven", credential_ref: "credential:unproven", api_url: "https://letagents.test",
    });
    await internals().supervisedInbox.bootstrapCursor({ agent_id: agentId, room_id: "room", last_observed_message_id: null });
    await internals().supervisedInbox.ingestPoll({
      agent_id: agentId, room_id: "room", last_observed_message_id: "2",
      messages: ["1", "2"].map((id) => ({ source_message_id: id, source_message: { id, text: `relay ${id}` },
        activation: { for_current_agent: { decision: "activate" } } })),
    });
    await internals().startSupervisedDelivery(agentId);

    await waitForAsync(async () => {
      const receipts = await internals().supervisedInbox.receipts(agentId);
      return receipts.length === 2 && receipts.every((receipt) => ["acknowledged", "acknowledged_failed"].includes(receipt.state));
    }, 5_000);
    const receipts = await internals().supervisedInbox.receipts(agentId);
    assert.deepEqual(receipts.map((receipt) => receipt.state), ["acknowledged_failed", "acknowledged"],
      "the unproven turn is settled, not blocked, and the next message runs");
    assert.equal(receipts[0]!.last_error, scenario.expected, "the lost turn carries its plain reason and what happens next");
    assert.equal(await internals().supervisedInbox.nativeFailure(receipts[0]!.inbox_item_id), "interrupted");
    assert.deepEqual(published, ["reply 2"], "the journaled reply of the unproven turn is never published");
    assert.equal(turns, 2, "no turn was run twice");
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
}

test("handoff after Cursor native release waits for first-turn and resumed init authority without killing the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "la-cursor-init-handoff-"));
  const bounded = async <T>(operation: Promise<T>, label: string): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 5_000);
        }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
  };
  try {
    for (const initial of ["pending", "established"] as const) {
      const caseRoot = join(root, initial);
      const paths = {
        lockPath: join(caseRoot, "daemon.lock"), socketPath: join(caseRoot, "daemon.sock"),
        manifestPath: join(caseRoot, "daemon.sqlite"), auditPath: join(caseRoot, "audit.log"),
        attemptsPath: join(caseRoot, "attempts.sqlite"), attemptsRoot: join(caseRoot, "attempts"),
        workspaceRoot: caseRoot, workerBindingsPath: join(caseRoot, "bindings.sqlite"),
      };
      const workAttemptId = initial === "pending"
        ? "00000000-0000-4000-8000-000000000061"
        : "00000000-0000-4000-8000-000000000071";
      const executionGenerationId = initial === "pending"
        ? "00000000-0000-4000-8000-000000000062"
        : "00000000-0000-4000-8000-000000000072";
      let continuation = initial === "pending" ? "cursor-pending:handoff-init" : "cursor-session:existing";
      let connection = { kind: "cursor_cli" as const, pid: null as number | null, processIdentity: null as string | null };
      const liveHandle = {
        workAttemptId,
        get pid() { return connection.pid; },
        get providerContinuationId() { return continuation; },
        get providerConnection() { return connection; },
        appliedConfigurationRevision: 1,
        observedState: () => connection.pid === null ? "idle" as const : "working" as const,
      };
      const nativeReleased = deferred<void>();
      const releaseInit = deferred<void>();
      const initCheckpointed = deferred<void>();
      const lateResult = deferred<{ turnId: string; outcome: "reply"; text: string }>();
      let published = 0;
      const port = provider(async (_handle, _request, options) => {
        const providerTurnId = `cursor:handoff-init:${initial}`;
        await options?.beforeNativeDispatch?.();
        connection = { kind: "cursor_cli", pid: initial === "pending" ? 92_001 : 92_002, processIdentity: `wrapper:${initial}` };
        await options?.checkpointPreparedTurn?.({
          providerTurnId,
          providerContinuationId: continuation,
          providerConnection: connection,
        });
        options?.markDurableTurnStarted?.();
        nativeReleased.resolve();
        await releaseInit.promise;
        if (initial === "pending") continuation = "cursor-session:first-init";
        await options?.checkpointProviderState?.({ providerContinuationId: continuation, providerConnection: connection });
        initCheckpointed.resolve();
        return lateResult.promise;
      });
      let daemon: SupervisorDaemon | null = new SupervisorDaemon(paths, "darwin", port, false, 60_000, undefined, {}, {
        poll: async () => ({}),
        publish: async () => { published += 1; },
      });
      try {
        const internals = daemon as unknown as {
          handoffScheduled: boolean;
          liveHandles: Map<string, typeof liveHandle>;
          workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
          supervisedInbox: SupervisedAgentInboxStore;
          supervisedDelivery: SupervisedAgentDelivery;
          startSupervisedDelivery(entryId: string): Promise<void>;
          store: ManifestStore;
          manifestGeneration: number;
          providerStreams: {
            install(
              entryId: string,
              handle: ProviderActionHandle,
              executionGenerationId: string,
              mayStartDelivery: () => boolean,
            ): Promise<void>;
          };
        };
        await daemon.start();
        const agentId = `cursor-init-handoff:${initial}`;
        const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
          id: agentId, room_id: "room", display_name: `Cursor ${initial}`, provider: "cursor", model: null,
          charter: "test", desired_state: "running", observed_state: "idle", condition: "none",
          permission_profile_id: "read_only", delivery_mode: "daemon_inbox", created_by: "test",
          created_at: new Date().toISOString(), workspace_path: caseRoot, work_attempt_id: workAttemptId,
          provider_ref: {
            work_attempt_id: workAttemptId, provider_continuation_id: continuation,
            provider_connection: connection, execution_generation_id: executionGenerationId,
          },
        } });
        assert.equal(put.ok, true, put.error);
        await installExactTestProviderBirth(
          internals,
          agentId,
          liveHandle,
          executionGenerationId,
        );
        await internals.workerBindings.bind({
          entry_id: agentId, room_id: "room", work_attempt_id: workAttemptId,
          execution_generation_id: executionGenerationId, agent_session_id: `session:${initial}`,
          agent_session_token: `bearer:${initial}`, credential_ref: `credential:${initial}`,
          api_url: "https://letagents.test",
        });
        await internals.supervisedInbox.bootstrapCursor({ agent_id: agentId, room_id: "room", last_observed_message_id: null });
        await internals.supervisedInbox.ingestPoll({
          agent_id: agentId,
          room_id: "room",
          last_observed_message_id: initial === "pending" ? "1" : "2",
          messages: [{
            source_message_id: initial === "pending" ? "1" : "2",
            source_message: { id: initial === "pending" ? "1" : "2", text: "hello" },
            activation: { for_current_agent: { decision: "activate" } },
          }],
        });
        await internals.startSupervisedDelivery(agentId);
        await bounded(nativeReleased.promise, `${initial} native release`);

        internals.handoffScheduled = true;
        let drained = false;
        const drain = internals.supervisedDelivery.fenceAndDrain().then(() => { drained = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(drained, false, "handoff remains joined until Cursor init authority is durable");
        releaseInit.resolve();
        await bounded(initCheckpointed.promise, `${initial} init checkpoint`);
        await bounded(drain, `${initial} handoff drain`);

        const durable = await internals.store.getEntry(agentId);
        assert.equal(durable?.provider_ref?.provider_continuation_id, continuation);
        assert.deepEqual(durable?.provider_ref?.provider_connection, connection);
        assert.equal(connection.pid === null, false, "handoff never reaped the released native wrapper");
        assert.equal(published, 0);
        lateResult.resolve({ turnId: `cursor:handoff-init:${initial}`, outcome: "reply", text: "late" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(published, 0, "the fenced old daemon cannot publish late output");
      } finally {
        releaseInit.resolve();
        lateResult.resolve({ turnId: `cursor:handoff-init:${initial}`, outcome: "reply", text: "cleanup" });
        await daemon?.stop().catch(() => undefined);
        daemon = null;
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a worker bearer rotation after Cursor native release keeps the turn alive through its init checkpoint", async () => {
  // A periodic bearer rotation used to land between Cursor's native release
  // and its stream-json init. The init checkpoint then saw a stale bearer, so
  // the adapter reaped the live wrapper (exit 143) and the turn was lost.
  // Delivery adopts the new bearer only when it is refreshed, which comes
  // after the bind's announcement and waits for the turn birth's admission,
  // so the init checkpoint can still run against the old in-memory bearer.
  const root = await mkdtemp(join(tmpdir(), "la-cursor-rotation-"));
  const bounded = async <T>(operation: Promise<T>, label: string): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 5_000);
        }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
  };
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"),
    manifestPath: join(root, "daemon.sqlite"), auditPath: join(root, "audit.log"),
    attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempts"),
    workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
  };
  const agentId = "cursor-rotation";
  const workAttemptId = "00000000-0000-4000-8000-000000000081";
  const executionGenerationId = "00000000-0000-4000-8000-000000000082";
  const providerTurnId = "cursor:rotation-init";
  const continuation = "cursor-session:rotation";
  const idle = { kind: "cursor_cli" as const, pid: null as number | null, processIdentity: null as string | null };
  let connection = idle;
  const liveHandle = {
    workAttemptId,
    get pid() { return connection.pid; },
    get providerContinuationId() { return continuation; },
    get providerConnection() { return connection; },
    appliedConfigurationRevision: 1,
    observedState: () => connection.pid === null ? "idle" as const : "working" as const,
  };
  const nativeReleased = deferred<void>();
  const releaseInit = deferred<void>();
  const initCheckpoint = deferred<string>();
  const lateResult = deferred<{ turnId: string; outcome: "reply"; text: string }>();
  const published: string[] = [];
  let recoveries = 0;
  let internals!: { supervisedInbox: SupervisedAgentInboxStore };
  const port = provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.();
    connection = { kind: "cursor_cli", pid: 93_001, processIdentity: "wrapper:rotation" };
    await options?.checkpointPreparedTurn?.({
      providerTurnId,
      providerContinuationId: continuation,
      providerConnection: connection,
    });
    options?.markDurableTurnStarted?.();
    nativeReleased.resolve();
    await releaseInit.promise;
    try {
      await options?.checkpointProviderState?.({ providerContinuationId: continuation, providerConnection: connection });
      initCheckpoint.resolve("accepted");
    } catch (error) {
      // The production adapter reaps the released wrapper on this failure.
      initCheckpoint.resolve(`rejected: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const raw = await lateResult.promise;
    connection = idle;
    await options?.checkpointProviderState?.({ providerContinuationId: continuation, providerConnection: connection });
    await seedCursorRoomTurnCompletion(internals.supervisedInbox, {
      agentId, roomId: "room", executionGenerationId, workAttemptId,
      providerContinuationId: continuation, providerTurnId, outcome: "reply", text: "after rotation",
    });
    return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw;
  }, async (_handle, request, options) => {
    recoveries += 1;
    assert.equal(request.providerTurnId, providerTurnId, "the successor reattaches the exact released turn");
    const raw = await lateResult.promise;
    connection = idle;
    await options?.checkpointProviderState?.({ providerContinuationId: continuation, providerConnection: connection });
    await seedCursorRoomTurnCompletion(internals.supervisedInbox, {
      agentId, roomId: "room", executionGenerationId, workAttemptId,
      providerContinuationId: continuation, providerTurnId, outcome: "reply", text: "after rotation",
    });
    return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw;
  });
  const daemon = new SupervisorDaemon(paths, "darwin", port, false, 60_000, undefined, {}, {
    // A long poll, as in production: the loop does not re-check its bearer
    // until the poll returns, so the refresh adopts it rather than replacing it.
    poll: ({ signal }) => new Promise((resolve) => {
      if (signal.aborted) resolve({});
      else signal.addEventListener("abort", () => resolve({}), { once: true });
    }),
    publish: async (input) => {
      published.push(input.text);
      return { messageId: `published:${published.length}`, roomId: input.roomId };
    },
  });
  try {
    const daemonInternals = daemon as unknown as {
      liveHandles: Map<string, typeof liveHandle>;
      workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
      supervisedInbox: SupervisedAgentInboxStore;
      startSupervisedDelivery(entryId: string): Promise<void>;
      store: ManifestStore;
      manifestGeneration: number;
      providerStreams: {
        install(
          entryId: string,
          handle: ProviderActionHandle,
          executionGenerationId: string,
          mayStartDelivery: () => boolean,
        ): Promise<void>;
        isDeliveryAdmitted(entryId: string): boolean;
      };
    };
    internals = daemonInternals;
    await daemon.start();
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      id: agentId, room_id: "room", display_name: "Cursor Rotation", provider: "cursor", model: null,
      charter: "test", desired_state: "running", observed_state: "idle", condition: "none",
      permission_profile_id: "read_only", delivery_mode: "daemon_inbox", created_by: "test",
      created_at: new Date().toISOString(), workspace_path: root, work_attempt_id: workAttemptId,
      provider_ref: {
        work_attempt_id: workAttemptId, provider_continuation_id: continuation,
        provider_connection: connection, execution_generation_id: executionGenerationId,
      },
    } });
    assert.equal(put.ok, true, put.error);
    await installExactTestProviderBirth(daemonInternals, agentId, liveHandle, executionGenerationId);
    const binding = {
      entry_id: agentId, room_id: "room", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "session:rotation",
      api_url: "https://letagents.test",
    };
    await daemonInternals.workerBindings.bind({ ...binding, agent_session_token: "bearer:before", credential_ref: "credential:before" });
    await daemonInternals.supervisedInbox.bootstrapCursor({ agent_id: agentId, room_id: "room", last_observed_message_id: null });
    await daemonInternals.supervisedInbox.ingestPoll({
      agent_id: agentId, room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { id: "1", text: "large relay" },
        activation: { for_current_agent: { decision: "activate" } } }],
    });
    await daemonInternals.startSupervisedDelivery(agentId);
    await bounded(nativeReleased.promise, "native release");

    // The same worker session gets a fresh bearer before delivery hears of it.
    await daemonInternals.workerBindings.bind({ ...binding, agent_session_token: "bearer:rotated", credential_ref: "credential:rotated" });
    releaseInit.resolve();
    assert.equal(await bounded(initCheckpoint.promise, "init checkpoint"), "accepted",
      "a bearer rotation must not fence the released turn's init identity");
    const durable = await daemonInternals.store.getEntry(agentId);
    assert.deepEqual(durable?.provider_ref?.provider_connection, connection, "the released wrapper stays the live runtime");

    // Production refreshes once the typed turn birth is admitted; this fixture
    // has no execution capture, so admit it directly. The refresh adopts the
    // rotated bearer in place instead of detaching the live turn.
    daemonInternals.providerStreams.isDeliveryAdmitted = () => true;
    await bounded(daemonInternals.startSupervisedDelivery(agentId), "delivery refresh");
    lateResult.resolve({ turnId: providerTurnId, outcome: "reply", text: "ignored aggregate" });
    await waitForAsync(async () => published.length === 1
      && (await daemonInternals.supervisedInbox.receipts(agentId))[0]?.state === "acknowledged", 5_000);
    assert.deepEqual(published, ["after rotation"]);
    assert.equal(recoveries, 0, "the original delivery finishes the turn; nothing had to re-attach");
  } finally {
    releaseInit.resolve();
    lateResult.resolve({ turnId: providerTurnId, outcome: "reply", text: "cleanup" });
    await daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a crashed Cursor turn settles as interrupted instead of blocking the FIFO after its lane fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "la-cursor-crash-"));
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"),
    manifestPath: join(root, "daemon.sqlite"), auditPath: join(root, "audit.log"),
    attemptsPath: join(root, "attempts.sqlite"), attemptsRoot: join(root, "attempts"),
    workspaceRoot: root, workerBindingsPath: join(root, "bindings.sqlite"),
  };
  const agentId = "cursor-crash";
  const workAttemptId = "00000000-0000-4000-8000-000000000091";
  const executionGenerationId = "00000000-0000-4000-8000-000000000092";
  const providerTurnId = "cursor:crashed-turn";
  const continuation = "cursor-session:crash";
  const idle = { kind: "cursor_cli" as const, pid: null as number | null, processIdentity: null as string | null };
  let connection = idle;
  const liveHandle = {
    workAttemptId,
    get pid() { return connection.pid; },
    get providerContinuationId() { return continuation; },
    get providerConnection() { return connection; },
    appliedConfigurationRevision: 1,
    observedState: () => connection.pid === null ? "idle" as const : "working" as const,
  };
  const ending = deferred<string>();
  let daemon!: SupervisorDaemon;
  let retireLane!: () => void;
  const port = provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.();
    connection = { kind: "cursor_cli", pid: 94_001, processIdentity: "wrapper:crash" };
    await options?.checkpointPreparedTurn?.({
      providerTurnId,
      providerContinuationId: continuation,
      providerConnection: connection,
    });
    options?.markDurableTurnStarted?.();
    await options?.checkpointProviderState?.({ providerContinuationId: continuation, providerConnection: connection });
    // The wrapper exits 143 without a result. Typed lifecycle marks the lane
    // failed before the adapter reports the turn's exact ending.
    await daemon.transition(agentId, "failed", "none", "provider runtime exited", "test");
    connection = idle;
    await options?.checkpointProviderState?.({ providerContinuationId: continuation, providerConnection: connection });
    const raw = {
      turnId: providerTurnId, providerContinuationId: continuation, outcome: "interrupted" as const,
      text: null, evidence: "stream" as const,
      error: "Cursor ended before the bounded room turn produced a terminal result.",
    };
    try {
      const disposition = await options?.checkpointTerminalResult?.(raw);
      ending.resolve("recorded");
      return disposition?.acceptedResult ?? raw;
    } catch (error) {
      ending.resolve(`rejected: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      // As in production: the adapter then commits lane death, and the exit
      // notification removes the daemon's live handle before delivery resumes.
      retireLane();
    }
  });
  daemon = new SupervisorDaemon(paths, "darwin", port, false, 60_000, undefined, {}, {
    poll: async () => ({}),
    publish: async () => { throw new Error("an interrupted turn publishes nothing"); },
  });
  try {
    const internals = daemon as unknown as {
      liveHandles: Map<string, typeof liveHandle>;
      workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
      supervisedInbox: SupervisedAgentInboxStore;
      startSupervisedDelivery(entryId: string): Promise<void>;
      store: ManifestStore;
      manifestGeneration: number;
      providerStreams: {
        install(
          entryId: string,
          handle: ProviderActionHandle,
          executionGenerationId: string,
          mayStartDelivery: () => boolean,
        ): Promise<void>;
        currentInstallation(entryId: string): ProviderInstallationToken | undefined;
        remove(installation: ProviderInstallationToken): boolean;
      };
    };
    retireLane = () => {
      const installation = internals.providerStreams.currentInstallation(agentId);
      assert.ok(installation, "the crashed lane is still installed when its ending is recorded");
      internals.providerStreams.remove(installation);
    };
    await daemon.start();
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      id: agentId, room_id: "room", display_name: "Cursor Crash", provider: "cursor", model: null,
      charter: "test", desired_state: "running", observed_state: "idle", condition: "none",
      permission_profile_id: "read_only", delivery_mode: "daemon_inbox", created_by: "test",
      created_at: new Date().toISOString(), workspace_path: root, work_attempt_id: workAttemptId,
      provider_ref: {
        work_attempt_id: workAttemptId, provider_continuation_id: continuation,
        provider_connection: connection, execution_generation_id: executionGenerationId,
      },
    } });
    assert.equal(put.ok, true, put.error);
    await installExactTestProviderBirth(internals, agentId, liveHandle, executionGenerationId);
    await internals.workerBindings.bind({
      entry_id: agentId, room_id: "room", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "session:crash",
      agent_session_token: "bearer:crash", credential_ref: "credential:crash", api_url: "https://letagents.test",
    });
    await internals.supervisedInbox.bootstrapCursor({ agent_id: agentId, room_id: "room", last_observed_message_id: null });
    await internals.supervisedInbox.ingestPoll({
      agent_id: agentId, room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { id: "1", text: "relay" },
        activation: { for_current_agent: { decision: "activate" } } }],
    });
    await internals.startSupervisedDelivery(agentId);

    assert.equal(await ending.promise, "recorded", "the failed lane's lease still records its turn's exact ending");
    assert.equal(internals.liveHandles.has(agentId), false, "the crashed lane was retired");
    await waitForAsync(async () => (await internals.supervisedInbox.receipts(agentId))[0]?.state === "acknowledged_failed", 5_000);
    const [receipt] = await internals.supervisedInbox.receipts(agentId);
    assert.match(receipt!.last_error ?? "", /Cursor ended before/);
    assert.equal(await internals.supervisedInbox.nativeFailure(receipt!.inbox_item_id), "interrupted");
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function enqueue(store: SupervisedAgentInboxStore, id = "1") {
  await ingest(store, id);
  return (await store.claimHead(agent.agentId))!;
}

async function ingest(store: SupervisedAgentInboxStore, id = "1", activation: Record<string, unknown> = {}) {
  await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: id, messages: [{ source_message_id: id, source_message: { id }, activation }] });
}

test("a transient provider failure continues its unfinished task without another room message", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-task-continuity-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  let runs = 0;
  let partialWrites = 0;
  let completed = false;
  const task = { id: "task_1", title: "Finish the existing change", leaseId: "lease-1", epoch: 0 };
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    runs += 1;
    await options?.beforeNativeDispatch?.();
    const turnId = `turn-${runs}`;
    await options?.checkpointTurnStarted?.(turnId);
    if (runs === 1) {
      partialWrites += 1;
      return { turnId, providerContinuationId: "thread", outcome: "failed", text: null,
        evidence: "stream", error: "HTTP 503 Service Unavailable" };
    }
    assert.match(JSON.stringify(request.sourceMessage), /task_1/);
    assert.match(JSON.stringify(request.sourceMessage), /existing work/i);
    completed = true;
    return { turnId, outcome: "reply", text: "The remaining work is finished." };
  }), {
    poll: async () => ({}),
    ownedTasks: async () => completed ? [] : [task],
    publish: async () => ({ roomId: agent.roomId, messageId: "msg_2" }),
  }, currentAuthority, 0, async () => {});
  try {
    await ingest(store);
    await delivery.pump(agent);
    assert.equal(runs, 2, "the failed turn must not strand the task when the room stays quiet");
    assert.equal(partialWrites, 1, "the original turn and its completed work must not be replayed");
    assert.equal(completed, true);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_failed");
    assert.equal((await store.cursor(agent.agentId))?.last_observed_message_id, "1");
  } finally {
    await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true });
  }
});

const continuityTask = { id: "task_1", title: "Existing work", leaseId: "lease-1", epoch: 2 };

/**
 * A lease holder whose provider turns end with `failures` in order, then succeed with no reply.
 * A turn listed in `refusedTurns` (counted from one) is one the provider marked as a refusal.
 */
async function runNoReplyContinuity(failures: readonly string[], rounds: readonly (readonly string[])[], refusedTurns: readonly number[] = [],
  /** What the room's messages carry as activation: everything in it comes from the server. */
  activation: Record<string, unknown> = {},
  /** Turns (counted from one) that the provider's adapter marked as ended on a result of a shape it does not know. */
  unrecognizedTurns: readonly number[] = []) {
  const root = await mkdtemp(join(tmpdir(), "continuity-no-reply-"));
  let tick = 0;
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"),
    () => new Date(Date.parse("2026-10-01T00:00:00.000Z") + (tick++) * 1_000).toISOString());
  const sources: string[] = []; const prompts: string[] = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const source = request.sourceMessage as { id?: string; source?: string; text?: string };
    sources.push(source.source === "system" ? "continuation" : String(source.id));
    if (source.source === "system") prompts.push(String(source.text));
    const turnId = `turn-${sources.length}`;
    await options?.checkpointTurnStarted?.(turnId);
    const error = failures[sources.length - 1];
    return error
      ? { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "transcript", error,
        ...(refusedTurns.includes(sources.length) ? { refusal: true as const } : {}),
        ...(unrecognizedTurns.includes(sources.length) ? { unrecognizedResult: true as const } : {}) }
      : { turnId, outcome: "no_reply", text: null };
  }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] },
  currentAuthority, 0, async () => {});
  try {
    for (const ids of rounds) {
      for (const id of ids) await ingest(store, id, activation);
      await delivery.pump(agent);
    }
    return { receipts: await store.receipts(agent.agentId), sources, prompts };
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
}

for (const kind of ["outputLimit", "emptyAnswer", "deniedTool"] as const) {
  test(`a lease holder's ${kind} failure gets one follow-up turn that says why, without blocking later messages`, async () => {
    const policy = taskFailurePolicy(NO_REPLY_FAILURE[kind], 1);
    assert.equal(policy.automatic, true);
    assert.equal(taskFailurePolicy(NO_REPLY_FAILURE[kind], 2).settle, true, "a repeat stops instead of blocking");
    const { receipts, sources, prompts } = await runNoReplyContinuity([NO_REPLY_FAILURE[kind]], [["1"], ["2"]]);
    assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply", "acknowledged_no_reply"]);
    assert.deepEqual(sources, ["1", "continuation", "2"], "the follow-up is a new turn and the next room message still runs");
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]!.includes(policy.note!), "the follow-up prompt says why the previous turn failed");
    if (kind === "deniedTool") assert.match(policy.note!, /a tool call was denied.*Do not run it again/);
  });
}

test("a model that hits its output limit every turn never blocks later room messages", async () => {
  const limit = NO_REPLY_FAILURE.outputLimit;
  const { receipts, sources } = await runNoReplyContinuity([limit, limit, limit, limit, limit], [["1"], ["2", "3"]]);
  assert.deepEqual(sources, ["1", "continuation", "2", "3", "continuation"]);
  assert.ok(receipts.every((item) => item.state === "acknowledged_failed"), JSON.stringify(receipts.map((item) => item.state)));
  assert.equal(receipts.length, 5, "no blocked follow-up was queued");
  for (const index of [0, 1, 3, 4]) {
    assert.match(receipts[index]!.last_error ?? "", /happened again.*send a message to continue it/,
      "the reason reaches the follow-up and the room message it continued");
    assert.ok(receipts[index]!.updated_at > receipts[index]!.acknowledged_at!, "the change is visible to change detection");
  }
  assert.equal(receipts[2]!.last_error, limit, "a message with no follow-up keeps its own reason");
});

test("a content-filter failure is settled without a follow-up and without blocking later messages", async () => {
  const { receipts, sources } = await runNoReplyContinuity([NO_REPLY_FAILURE.contentFilter], [["1"], ["2"]]);
  assert.deepEqual(sources, ["1", "2"]);
  assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply"]);
  assert.match(receipts[0]!.last_error ?? "", /content filter.*not continued automatically/);
});

test("a provider's refusal of a lease holder's turn is settled with its reason and never blocks later messages", async () => {
  const reason = "This content was flagged by the provider. Try rephrasing your request.";
  const policy = taskFailurePolicy(reason, 1, true);
  assert.deepEqual({ automatic: policy.automatic, settle: policy.settle }, { automatic: false, settle: true });
  assert.ok(policy.detail.startsWith(reason), "the provider's own reason leads the message");
  // A follow-up turn that is refused as well is settled the same way, however many came before it.
  for (const attempt of [2, 3, 4, 9]) assert.deepEqual(taskFailurePolicy(reason, attempt, true), policy, `attempt ${attempt}`);

  const { receipts, sources } = await runNoReplyContinuity([reason, reason], [["1"], ["2"], ["3"]], [1, 2]);
  assert.deepEqual(sources, ["1", "2", "3"], "no follow-up turn repeats the refused context, and each next message still runs");
  assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_failed", "acknowledged_no_reply"],
    "a second refusal in a row is settled the same way; no blocked follow-up was queued");
  for (const refused of receipts.slice(0, 2)) {
    assert.equal(Object.hasOwn(refused.activation, "task_continuity_refusal"), false, "nothing is kept on the message that would need clearing");
    assert.ok(refused.last_error?.startsWith(reason), refused.last_error ?? "");
    assert.match(refused.last_error ?? "", /not continued automatically.*send a message to continue it/);
  }
});

test("a lease holder's failure that the owner can clear still blocks until Retry delivery", async () => {
  // The same wording without the provider's refusal mark is an unknown
  // failure, and a rejected key is one only the owner can fix. Continuing is
  // how the held task resumes after that, so the follow-up waits, blocked.
  for (const reason of [
    "This content was flagged by the provider. Try rephrasing your request.",
    "unexpected status 401 Unauthorized: the provider rejected this key.",
  ]) {
    assert.equal(taskFailurePolicy(reason, 1).settle, undefined, reason);
    const { receipts, sources } = await runNoReplyContinuity([reason], [["1"], ["2"]]);
    assert.deepEqual(sources, ["1"], reason);
    assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"], reason);
    assert.match(receipts[1]!.last_error ?? "", /use Retry delivery to continue the existing task/, reason);
  }
});

test("only the provider's own result marks a turn refused: a message that arrives claiming it is treated as any other", async () => {
  const reason = "unexpected status 401 Unauthorized: the provider rejected this key.";
  const { receipts, sources } = await runNoReplyContinuity([reason], [["1"], ["2"]], [], { task_continuity_refusal: true });
  assert.deepEqual(sources, ["1"]);
  assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"],
    "the failure blocks until Retry delivery, as without the claim");
});

test("a lease holder's turn that ended on an unrecognized result is settled with its text, whatever the text says: no follow-up and no block", async () => {
  // The text of such a failure may be the model's own words. The first reads
  // like a temporary provider failure and the second like nothing at all.
  for (const words of ["Done. I changed 500 lines and all tests pass.", "Merged the PR.", "429 rate limit overloaded 401 unauthorized credit limit"]) {
    const reason = `Claude ended this turn with a result LetAgents does not recognize (subtype "success", no is_error), so nothing was posted. Claude's text: ${words}`;
    const policy = taskFailurePolicy(reason, 1, false, true);
    assert.deepEqual({ automatic: policy.automatic, settle: policy.settle }, { automatic: false, settle: true }, words);
    assert.ok(policy.detail.startsWith(reason), "the text stays for the owner to read");
    for (const attempt of [2, 3, 4, 9]) assert.deepEqual(taskFailurePolicy(reason, attempt, false, true), policy, `attempt ${attempt}`);

    const { receipts, sources } = await runNoReplyContinuity([reason], [["1"], ["2"]], [], {}, [1]);
    assert.deepEqual(sources, ["1", "2"], `${words}: no follow-up turn is started, and the next message runs`);
    assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply"], `${words}: no blocked follow-up is queued`);
    assert.ok(receipts[0]!.last_error?.startsWith(reason), receipts[0]!.last_error ?? "");
    assert.match(receipts[0]!.last_error ?? "", /not continued automatically.*send a message to continue it/);
  }
});

test("only the adapter's mark keeps a failure text from being read: the same words without it are a provider error as before", async () => {
  // Without the mark the text is a provider's error text, and what it says decides what happens next.
  const temporary = "Done. I changed 500 lines and all tests pass.";
  assert.equal(taskFailurePolicy(temporary, 1).automatic, true);
  const continued = await runNoReplyContinuity([temporary], [["1"], ["2"]]);
  assert.deepEqual(continued.sources, ["1", "continuation", "2"], "a follow-up turn is started");

  const unknown = "Merged the PR.";
  assert.deepEqual({ automatic: taskFailurePolicy(unknown, 1).automatic, settle: taskFailurePolicy(unknown, 1).settle }, { automatic: false, settle: undefined });
  const blocked = await runNoReplyContinuity([unknown], [["1"], ["2"]]);
  assert.deepEqual(blocked.receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"], "the next message waits behind a blocked follow-up");

  // A message from the room cannot set the mark: it is read from the saved result of the turn alone.
  const claimed = await runNoReplyContinuity([unknown], [["1"], ["2"]], [], { unrecognizedResult: true, task_continuity_unrecognized_result: true });
  assert.deepEqual(claimed.receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"]);
});

type ClaudeFacts = { status: number | null; terminalReason: string | null; category: string | null; usageLimit?: true; promptTooLong?: true };
const RETRY_DELIVERY = "Resolve this issue, then use Retry delivery to continue the existing task.";
/** How long each of the three follow-ups waits after a short provider fault: 30 seconds, 2 minutes, 10 minutes. */
const SHORT_FAULT_WAITS = [30_000, 120_000, 600_000] as const;
/** The decision for a short fault at this follow-up attempt. */
const temporaryAt = (attempt: number) => ({ automatic: true, detail: "The provider failed temporarily. The agent will try again by itself.",
  delayMs: SHORT_FAULT_WAITS[attempt - 1]! });
/** Added to Claude's own text on the follow-up of a request that does not fit the model's context. */
const DOES_NOT_FIT = "The request does not fit the model's context, so each turn in this conversation fails the same way. Start fresh opens a new conversation and discards the context of this one. After it, use Retry delivery, then send a message to continue the task. If the size comes from attachments or tools, a new conversation may not help.";
const STOPPED_AFTER_THREE = "All three automatic attempts failed. The agent now waits for you: check the provider, then use Retry delivery to try again. Existing work is preserved.";
/** What the manifest says of a follow-up that waits for its time after a short provider fault. */
const scheduledFault = (at_ms: number, attempt: number, for_message_id: string | null = "1") =>
  ({ for_message_id, state: "scheduled", scheduled: { at_ms, attempt, attempts: 3, kind: "provider_fault" } });
const STOPPED_BY_OWNER = "You stopped the automatic attempts. The task is still assigned to this agent. Send it a message to continue.";

/**
 * A lease holder on the provider `providerId` whose turns fail as listed, in order, and then end with no reply. A
 * follow-up's delay is not waited for: the clock of the inbox is moved ahead by it, and `waits` keeps
 * what was asked for.
 */
async function runFailingLeaseHolder(providerId: string, failures: ReadonlyArray<{ error: string; claudeApiFailure?: ClaudeFacts }>,
  rounds: readonly (readonly string[])[]) {
  const root = await mkdtemp(join(tmpdir(), "continuity-claude-facts-"));
  let nowMs = Date.parse("2026-10-01T00:00:00.000Z");
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"), () => new Date(nowMs).toISOString());
  const sources: string[] = []; const waits: number[] = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const source = request.sourceMessage as { id?: string; source?: string };
    sources.push(source.source === "system" ? "continuation" : String(source.id));
    const turnId = `turn-${sources.length}`;
    await options?.checkpointTurnStarted?.(turnId);
    const failure = failures[sources.length - 1];
    return failure
      ? { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", ...failure }
      : { turnId, outcome: "no_reply", text: null };
  }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] },
  currentAuthority, 50, async () => {}, async (delayMs) => { waits.push(delayMs); nowMs += delayMs; });
  try {
    for (const ids of rounds) {
      for (const id of ids) await ingest(store, id);
      await delivery.pump({ ...agent, provider: providerId });
    }
    return { receipts: await store.receipts(agent.agentId), sources, waits };
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
}

test("Claude's structured account of a failure makes its kind: the status of a refused credential, then its name for the error, then the provider's status", () => {
  const kind = (status: number | null, terminalReason: string | null, category: string | null) => claudeApiFailureClass({ status, terminalReason, category });
  // A short fault: a rate limit, a server error, and a connection that was refused or lost (no status at all).
  for (const facts of [[429, "api_error", "rate_limit"], [500, "api_error", "server_error"], [529, "api_error", "server_error"],
    [null, "api_error", "server_error"], [503, null, null], [429, "api_error", "unknown"], [529, "api_error", "overloaded"]] as const) {
    assert.equal(kind(...facts), "short_fault", JSON.stringify(facts));
  }
  // Only the owner can clear these.
  assert.equal(kind(401, "api_error", "authentication_failed"), "authentication");
  assert.equal(kind(403, null, null), "authentication");
  assert.equal(kind(404, "api_error", "model_not_found"), "model");
  // A low credit balance and a malformed request are both HTTP 400. Claude's name for the error tells them apart.
  assert.equal(kind(400, "api_error", "billing_error"), "billing");
  assert.equal(kind(413, "image_error", "invalid_request"), "request");
  // `invalid_request` is Claude's name for many failures. A 400 with that name is a request that cannot succeed as
  // it was sent, and it is the same kind with the result's terminal reason (the stream) and without it (the session).
  for (const terminalReason of ["api_error", null]) {
    assert.equal(kind(400, terminalReason, "invalid_request"), "request", `terminal reason ${terminalReason}`);
    assert.equal(kind(413, terminalReason, "invalid_request"), "request", `terminal reason ${terminalReason}`);
    // A refused credential is the owner's to put right, whatever name Claude gave it: the status is read before that name.
    assert.equal(kind(401, terminalReason, "invalid_request"), "authentication", `terminal reason ${terminalReason}`);
    assert.equal(kind(403, terminalReason, "invalid_request"), "authentication", `terminal reason ${terminalReason}`);
    assert.equal(kind(403, terminalReason, "unknown"), "authentication", `terminal reason ${terminalReason}`);
  }
  // That status is read before every name: a 401 that Claude named a server error is not retried as a short fault.
  for (const category of ["server_error", "rate_limit", "model_not_found", "billing_error", "max_output_tokens", "authentication_failed", null]) {
    assert.equal(kind(401, "api_error", category), "authentication", `a 401 named ${category}`);
    assert.equal(kind(403, "api_error", category), "authentication", `a 403 named ${category}`);
  }
  assert.equal(kind(404, "api_error", "model_not_found"), "model");
  // A 400 is a request that cannot succeed only when Claude named the error at all, if only as `unknown`. A bare
  // 400 says too little: a low credit balance is a 400 too. Its text is read.
  assert.equal(kind(400, "api_error", "unknown"), "request");
  assert.equal(kind(400, "api_error", null), null);
  assert.equal(kind(400, null, null), null);
  assert.equal(kind(413, null, null), "request", "a request that is too large says so by its status");
  // A request that does not fit the model's context is told by the result's terminal reason: the provider refused
  // it (`prompt_too_long`), or Claude Code did not send it (`blocking_limit`, with no status). The session keeps no
  // terminal reason: there the start of the error's text says it, and nothing else does.
  assert.equal(kind(400, "prompt_too_long", "invalid_request"), "conversation");
  assert.equal(kind(400, "prompt_too_long", null), "conversation");
  assert.equal(kind(413, "prompt_too_long", "invalid_request"), "conversation");
  assert.equal(kind(null, "blocking_limit", "invalid_request"), "conversation");
  assert.equal(kind(null, "blocking_limit", null), "conversation");
  assert.equal(claudeApiFailureClass({ status: 400, terminalReason: null, category: "invalid_request", promptTooLong: true }), "conversation");
  assert.equal(claudeApiFailureClass({ status: null, terminalReason: null, category: "invalid_request", promptTooLong: true }), "conversation");
  assert.equal(claudeApiFailureClass({ status: null, terminalReason: null, category: null, promptTooLong: true }), "conversation");
  assert.equal(kind(null, null, "invalid_request"), "request", "the name alone, with nothing that says the context is full");
  assert.equal(kind(null, "rapid_refill_breaker", "invalid_request"), "request");
  // The account's usage limit and a brief rate limit have one name and one status. A usage window that rejected the turn tells them apart.
  assert.equal(claudeApiFailureClass({ status: 429, terminalReason: "api_error", category: "rate_limit", usageLimit: true }), "billing");
  assert.equal(claudeApiFailureClass({ status: null, terminalReason: null, category: "rate_limit", usageLimit: true }), "billing");
  for (const category of [null, "unknown", "invalid_request"]) {
    assert.equal(claudeApiFailureClass({ status: 429, terminalReason: null, category, usageLimit: true }), "billing", `a 429 named ${category}`);
  }
  assert.equal(kind(429, null, null), "short_fault");
  assert.equal(claudeApiFailureClass({ status: 401, terminalReason: "api_error", category: "authentication_failed", usageLimit: true }), "authentication",
    "a rejected usage window makes no other failure a usage limit");
  assert.equal(claudeApiFailureClass({ status: 500, terminalReason: "api_error", category: "server_error", usageLimit: true }), "short_fault");
  assert.equal(kind(null, "api_error", "max_output_tokens"), "output_limit");
  // The fields say nothing that decides: the text is read, as for any provider.
  for (const facts of [[null, "api_error", "unknown"], [null, null, null], [404, "api_error", "unknown"], [418, "api_error", "a_name_from_the_future"]] as const) {
    assert.equal(kind(...facts), null, JSON.stringify(facts));
  }
  assert.equal(claudeApiFailureClass(null), null);
  // What was saved is read back with no trust in it: a status and short names, and nothing else.
  assert.deepEqual(parseClaudeApiFailure({ status: 500, terminalReason: "api_error", category: "server_error", more: "ignored" }),
    { status: 500, terminalReason: "api_error", category: "server_error" });
  assert.deepEqual(parseClaudeApiFailure({ status: "500", terminalReason: "rate limit, retry at once", category: ["server_error"], usageLimit: "true" }),
    { status: null, terminalReason: null, category: null });
  assert.deepEqual(parseClaudeApiFailure({ status: 429, terminalReason: "api_error", category: "rate_limit", usageLimit: true }),
    { status: 429, terminalReason: "api_error", category: "rate_limit", usageLimit: true });
  assert.deepEqual(parseClaudeApiFailure({ status: 400, terminalReason: null, category: "invalid_request", promptTooLong: true }),
    { status: 400, terminalReason: null, category: "invalid_request", promptTooLong: true });
  for (const saved of [undefined, null, "server_error", ["server_error"], 500]) assert.equal(parseClaudeApiFailure(saved), null);
});

test("what was saved of Claude's account is read back within bounds: an HTTP status, short names, and marks that are exactly true", () => {
  const read = (saved: Record<string, unknown>) => parseClaudeApiFailure({ terminalReason: "api_error", category: "server_error", ...saved });
  // A status is a whole number from 100 to 599. Anything else is not a status, and decides nothing.
  for (const status of [100, 400, 429, 599]) assert.equal(read({ status })?.status, status, String(status));
  for (const status of [99, 600, 0, -429, 429.5, 4290, Number.NaN, Number.POSITIVE_INFINITY, "429", true, null, [429], { status: 429 }]) {
    assert.equal(read({ status })?.status, null, JSON.stringify(status) ?? String(status));
  }
  // So a saved value out of range cannot make a kind by its status: with no name, nothing is said.
  assert.equal(claudeApiFailureClass(parseClaudeApiFailure({ status: 4290, terminalReason: null, category: null })), null);
  assert.equal(claudeApiFailureClass(parseClaudeApiFailure({ status: 600, terminalReason: null, category: null })), null);
  assert.equal(claudeApiFailureClass(parseClaudeApiFailure({ status: 599, terminalReason: null, category: null })), "short_fault");
  // A name is lower case, starts with a letter, and has at most 64 characters.
  for (const name of ["rate_limit", "a", "x9_y", `a${"b".repeat(63)}`]) {
    assert.deepEqual([read({ category: name })?.category, read({ terminalReason: name })?.terminalReason], [name, name], name);
  }
  for (const name of ["", "Rate_Limit", "rate limit", "9lives", "_private", "rate-limit", `a${"b".repeat(64)}`, "prompt_too_long\n", 429, null, ["rate_limit"]]) {
    assert.deepEqual([read({ category: name })?.category, read({ terminalReason: name })?.terminalReason], [null, null], JSON.stringify(name));
  }
  // A mark is kept only when it is exactly true.
  for (const mark of ["true", 1, {}, [], null, false]) {
    assert.deepEqual(parseClaudeApiFailure({ status: 429, terminalReason: null, category: "rate_limit", usageLimit: mark, promptTooLong: mark }),
      { status: 429, terminalReason: null, category: "rate_limit" }, JSON.stringify(mark));
  }
});

test("each kind of Claude failure has its own decision for a lease holder, whatever else its text reads like", () => {
  // The text of every failure here reads like something else than its kind.
  const policy = (text: string, attempt: number, facts: ClaudeFacts) => taskFailurePolicy(text, attempt, false, false, facts);
  const shortFault = { status: null, terminalReason: "api_error", category: "server_error" };
  for (const attempt of [1, 2, 3]) {
    assert.deepEqual(policy("Connection refused. 401 unauthorized, credit limit.", attempt, shortFault), temporaryAt(attempt));
  }
  assert.deepEqual(policy("Connection refused.", 4, shortFault), { automatic: false, detail: STOPPED_AFTER_THREE }, "the bound holds for a short fault");
  for (const attempt of [1, 4]) {
    assert.deepEqual(policy("Invalid API key. 503 temporarily overloaded.", attempt, { status: 401, terminalReason: "api_error", category: "authentication_failed" }),
      { automatic: false, detail: `The model provider needs authentication or account access. ${RETRY_DELIVERY}` });
    assert.deepEqual(policy("Credit balance is too low", attempt, { status: 400, terminalReason: "api_error", category: "billing_error" }),
      { automatic: false, detail: `The model provider has insufficient credit or quota. ${RETRY_DELIVERY}` });
    assert.deepEqual(policy("There's an issue with the selected model. 500.", attempt, { status: 404, terminalReason: "api_error", category: "model_not_found" }),
      { automatic: false, detail: `The model provider cannot find the selected model, or this account cannot use it. ${RETRY_DELIVERY}` });
    assert.deepEqual(policy("Request too large (max 32MB). 429 rate limit.", attempt, { status: 413, terminalReason: "image_error", category: "invalid_request" }),
      { automatic: false, settle: true, detail: "Request too large (max 32MB). 429 rate limit. Sending it again unchanged cannot help, so the unfinished task was not continued automatically. Existing work is preserved; send a message to continue it." });
    // A request that does not fit the model's context is the owner's to clear. The follow-up shows Claude's own
    // text, which says what takes the room, and says what the action that can clear it costs.
    for (const tooLong of [{ status: 400, terminalReason: "prompt_too_long", category: "invalid_request" }, { status: null, terminalReason: "blocking_limit", category: "invalid_request" },
      { status: 400, terminalReason: null, category: "invalid_request", promptTooLong: true as const }]) {
      assert.deepEqual(policy("Prompt is too long. 429 rate limit.", attempt, tooLong), { automatic: false, detail: `Prompt is too long. 429 rate limit. ${DOES_NOT_FIT}` });
    }
    // A 400 that Claude names `invalid_request` and that is no such request is settled with Claude's own text, in the
    // stream and in the session alike. It is never called a conversation that is too long.
    for (const terminalReason of ["api_error", null]) {
      for (const text of ["API Error: 400 due to tool use concurrency issues.", "PDF too large (max 100 pages, 20MB). Try reading the file a different way (e.g., extract text with pdftotext).",
        "An image in the conversation exceeds the dimension limit for many-image requests (2000px). Run /compact to remove old images from context, or start a new session.",
        "Claude Opus is not available with the Claude Pro plan. If you have updated your subscription plan recently, run /logout and /login for the plan to take effect.",
        "Your ANTHROPIC_API_KEY belongs to a disabled organization \u00b7 Update or unset the environment variable"]) {
        assert.deepEqual(policy(text, attempt, { status: 400, terminalReason, category: "invalid_request" }), { automatic: false, settle: true,
          detail: `${text} Sending it again unchanged cannot help, so the unfinished task was not continued automatically. Existing work is preserved; send a message to continue it.` }, text);
      }
      // A key or an access that the owner can put right blocks, and Retry delivery then continues the task. It is not settled.
      for (const [status, text] of [[403, "Your organization has disabled API key authentication \u00b7 Unset ANTHROPIC_API_KEY and run /login to sign in with your claude.ai account"],
        [401, "Your apiKeyHelper script is failing \u00b7 This usually means you need to re-authenticate with your provider \u00b7 Run /status to see the script's error output"]] as const) {
        assert.deepEqual(policy(text, attempt, { status, terminalReason, category: "invalid_request" }),
          { automatic: false, detail: `The model provider needs authentication or account access. ${RETRY_DELIVERY}` }, text);
      }
    }
    // A bare 400 is not settled on its status: its text is read. A low credit balance is a 400.
    for (const facts of [{ status: 400, terminalReason: "api_error", category: null }, { status: 400, terminalReason: null, category: null }]) {
      assert.deepEqual(policy("Credit balance is too low", attempt, facts), { automatic: false, detail: `The model provider has insufficient credit or quota. ${RETRY_DELIVERY}` });
      // With no words that say more, it is blocked for the owner as any unknown failure is. It is not settled.
      assert.deepEqual(policy("API Error: 400 messages.0.content: this request is invalid", attempt, facts), { automatic: false,
        detail: attempt > 3 ? STOPPED_AFTER_THREE : `The provider failed and safe automatic recovery could not be established. ${RETRY_DELIVERY}` });
    }
  }
  assert.deepEqual(policy("", 1, { status: 400, terminalReason: "prompt_too_long", category: "invalid_request" }),
    { automatic: false, detail: `Claude reported that the prompt is too long. ${DOES_NOT_FIT}` }, "with no text of Claude's to show");
  // The output limit takes the path every provider's output limit takes: one follow-up that says why, then no more.
  const outputLimit = { status: null, terminalReason: "api_error", category: "max_output_tokens" };
  assert.deepEqual(policy("API Error: Claude's response exceeded the 64000 output token maximum.", 1, outputLimit), taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 1));
  assert.deepEqual(policy("API Error: Claude's response exceeded the 64000 output token maximum.", 2, outputLimit), taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 2));
  assert.equal(taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 1).automatic, true);
  assert.equal(taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 2).settle, true);
  // A refusal, and a result of a shape nobody knows, are decided before any account is read.
  assert.deepEqual(taskFailurePolicy("refused", 1, true, false, shortFault), taskFailurePolicy("refused", 1, true));
  assert.deepEqual(taskFailurePolicy("words", 1, false, true, shortFault), taskFailurePolicy("words", 1, false, true));
});

test("the account's usage limit is never retried as a short fault: a rejected usage window, or the text that names the limit, decides first", async () => {
  const quota = { automatic: false, detail: `The model provider has insufficient credit or quota. ${RETRY_DELIVERY}` };
  const temporary = temporaryAt(1);
  const rateLimit = { status: 429, terminalReason: "api_error", category: "rate_limit" };
  // A brief rate limit, as Claude Code 2.1.278 words it with an API key: retried, as before.
  const brief = "API Error: Request rejected (429) · This request would exceed your organization's rate limit.";
  assert.deepEqual(taskFailurePolicy(brief, 1, false, false, rateLimit), temporary);
  // Claude reported the usage window that rejected the turn: whatever the text says, it is the account's limit.
  for (const attempt of [1, 2, 4]) assert.deepEqual(taskFailurePolicy(brief, attempt, false, false, { ...rateLimit, usageLimit: true }), quota, `attempt ${attempt}`);
  // The window wins for any failure with the status of a rate limit, whatever its name.
  for (const category of [null, "unknown"]) {
    assert.deepEqual(taskFailurePolicy(brief, 1, false, false, { status: 429, terminalReason: null, category, usageLimit: true }), quota, `a 429 named ${category}`);
  }
  // No window was reported: a turn that is read back from its session has none. The text that names the limit
  // decides, for a failure Claude names a rate limit and for one that has only the status of one.
  const bare429 = { status: 429, terminalReason: null, category: null };
  const unknown = { automatic: false, detail: `The provider failed and safe automatic recovery could not be established. ${RETRY_DELIVERY}` };
  /** A failure of Claude Code that has no account at all, as from a CLI that sends none of the fields. */
  const claudeWithNoAccount = (text: string, attempt = 1) => taskFailurePolicy(text, attempt, false, false, null, true);
  /** The same text from any other provider. */
  const anotherProvider = (text: string, attempt = 1) => taskFailurePolicy(text, attempt, false, false, null, false);
  // Words that name a usage, spend or credit limit are a limit of the account for every provider, as before.
  for (const text of ["Claude AI usage limit reached", "You've hit your monthly spend limit", "You've hit your org's monthly spend limit", "Your group's usage limit is set to $0",
    "quota exceeded for this account"]) {
    for (const policy of [taskFailurePolicy(text, 1), anotherProvider(text), claudeWithNoAccount(text), taskFailurePolicy(text, 1, false, false, rateLimit),
      taskFailurePolicy(text, 1, false, false, bare429)]) assert.deepEqual(policy, quota, text);
  }
  // The words Claude Code 2.1.278 has for its own limits name no "usage limit". They are read for a Claude
  // failure alone. From another provider the same words are read as they always were: here, as a failure that
  // nothing is known about.
  const claudeLimits = ["You've hit your session limit \u00b7 resets 3pm", "You've hit your weekly limit \u00b7 resets Oct 12, 9am", "You've hit your Opus limit \u00b7 resets Oct 12, 9am",
    "You're out of extra usage \u00b7 resets 5pm", "You've hit your Sonnet limit", "You've hit your limit \u00b7 resets 3pm \u00b7 progress saved",
    "You've hit your team's shared budget \u00b7 ask your admin to raise it at claude.ai/admin-settings/usage",
    "You've reached your Fable limit. Switch to another model to continue.", "You\u2019ve hit your session limit", "You're out of usage credits \u00b7 resets 3pm",
    "Your org is out of usage \u00b7 contact your admin", "Your seat type doesn't include usage credits", "Your seat type doesn't include extra usage",
    "Your usage allocation has been disabled by your admin", "Fable 5 requires usage credits", "This service is disabled for your org", "Credit balance is too low"];
  for (const text of claudeLimits) {
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, rateLimit), quota, text);
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, { ...rateLimit, terminalReason: null }), quota, `${text} (read back from a session)`);
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, bare429), quota, `${text} (a 429 with no name)`);
    assert.deepEqual(claudeWithNoAccount(text), quota, `${text} (Claude, no account)`);
    assert.deepEqual(anotherProvider(text), unknown, `${text} (another provider)`);
    assert.deepEqual(taskFailurePolicy(text, 1), unknown, `${text} (no provider said)`);
  }
  // A brief rate limit stays a short fault, in each of the wordings Claude Code has for one. For a subscription
  // login it says "(not your usage limit)": those words name no usage limit.
  const notUsageLimit = ["API Error: Server is temporarily limiting requests (not your usage limit) \u00b7 this may be a temporary capacity issue.",
    "API Error: Server is temporarily limiting requests (not your usage limit) \u00b7 Rate limited"];
  const briefLimits = [brief, ...notUsageLimit, "You've hit your organization's rate limit, try again in 20 seconds", "You've hit your rate limit.", "You've hit your rate-limit."];
  for (const text of briefLimits) {
    for (const attempt of [1, 2, 3]) {
      assert.deepEqual(taskFailurePolicy(text, attempt, false, false, rateLimit), temporaryAt(attempt), text);
      assert.deepEqual(taskFailurePolicy(text, attempt, false, false, bare429), temporaryAt(attempt), `${text} (a 429 with no name)`);
      assert.deepEqual(claudeWithNoAccount(text, attempt), temporaryAt(attempt), `${text} (Claude, no account)`);
      // From another provider those words are not excused: "usage limit" is read in them, as before.
      assert.deepEqual(anotherProvider(text, attempt), notUsageLimit.includes(text) ? quota : temporaryAt(attempt), `${text} (another provider)`);
    }
  }
  // Claude Code writes a limit of the account as the whole text, and knows it by its start. The same words inside
  // a longer text are a server's own: a gateway can say "You've hit your concurrency limit", and the CLI puts
  // that after "API Error: ...". That is a brief limit, with a follow-up, whatever account the failure has.
  for (const text of ["API Error: Request rejected (429) \u00b7 You've hit your concurrency limit", "API Error: Request rejected (429) \u00b7 You've reached your requests per minute limit",
    "API Error: Server is temporarily limiting requests (not your usage limit) \u00b7 You've hit your session limit", "API Error: 429 You're out of extra usage",
    "API Error: Request rejected (429) \u00b7 Fable 5 requires usage credits", "Request rejected (429): Credit balance is too low"]) {
    for (const policy of [taskFailurePolicy(text, 1, false, false, rateLimit), taskFailurePolicy(text, 1, false, false, { ...rateLimit, terminalReason: null }),
      taskFailurePolicy(text, 1, false, false, bare429), claudeWithNoAccount(text)]) assert.deepEqual(policy, temporary, text);
  }
  // At the start they are Claude Code's own, with or without space before them.
  for (const text of ["You've hit your concurrency limit", "  You've hit your session limit \u00b7 resets 3pm", "Opus 4.5 requires usage credits. Switch to another model to continue."]) {
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, rateLimit), quota, text);
    assert.deepEqual(claudeWithNoAccount(text), quota, text);
  }
  // Four texts that another provider can write. They get what they got before Claude's words were read. The first
  // three have Claude's words in the middle, so Claude Code gets the same for them. The last has the words that
  // Claude Code excuses.
  const elsewhere: Array<[text: string, anotherProviders: ReturnType<typeof taskFailurePolicy>, claudes: ReturnType<typeof taskFailurePolicy>]> = [
    ["429 Too Many Requests: you've hit your concurrency limit", temporary, temporary],
    ["429 You've reached your requests per minute limit", temporary, temporary],
    ["stream error: You've hit your context window limit", unknown, unknown],
    ["temporarily overloaded (not your usage limit)", quota, temporary],
  ];
  for (const [text, anotherProviders, claudes] of elsewhere) {
    assert.deepEqual(anotherProvider(text), anotherProviders, `${text} (another provider)`);
    assert.deepEqual(taskFailurePolicy(text, 1), anotherProviders, `${text} (no provider said)`);
    assert.deepEqual(claudeWithNoAccount(text), claudes, `${text} (Claude)`);
    // The delivery says which provider failed: Claude Code with no account of the failure, and three others.
    for (const providerId of ["claude-code", "codex", "cursor", "open-model"]) {
      const expected = providerId === "claude-code" ? claudes : anotherProviders;
      const { receipts, sources } = await runFailingLeaseHolder(providerId, [{ error: text }], [["1"], []]);
      assert.deepEqual(sources, expected.automatic ? ["1", "continuation"] : ["1"], `${providerId}: ${text}`);
      if (!expected.automatic) assert.equal(receipts[1]!.last_error, expected.detail, `${providerId}: ${text}`);
    }
  }
  // Those words excuse nothing else in the text: a usage limit named beside them is still one.
  assert.deepEqual(taskFailurePolicy("Server is temporarily limiting requests (not your usage limit). Your usage limit resets at 3pm.", 1, false, false, rateLimit), quota);
  // The limit text is read for a rate limit, and for no other short fault.
  assert.deepEqual(taskFailurePolicy("500 while the usage limit page loaded", 1, false, false, { status: 500, terminalReason: "api_error", category: "server_error" }), temporary);
  assert.deepEqual(taskFailurePolicy("You've hit your session limit", 1, false, false, { status: null, terminalReason: "api_error", category: "server_error" }), temporary);

  // A lease holder at its usage limit is sent no follow-up turn. The follow-up waits for the owner, and so does the next message.
  for (const failure of [{ error: brief, claudeApiFailure: { ...rateLimit, usageLimit: true as const } }, { error: "Claude AI usage limit reached", claudeApiFailure: rateLimit },
    { error: "Claude AI usage limit reached", claudeApiFailure: bare429 }, { error: "You've hit your session limit \u00b7 resets 3pm", claudeApiFailure: { ...rateLimit, terminalReason: null } },
    { error: "You've hit your weekly limit \u00b7 resets Oct 12, 9am", claudeApiFailure: rateLimit }, { error: "You've hit your Opus limit \u00b7 resets Oct 12, 9am", claudeApiFailure: rateLimit },
    { error: "You're out of extra usage \u00b7 resets 5pm", claudeApiFailure: rateLimit }]) {
    const { receipts, sources, waits } = await runFailingLeaseHolder("claude-code", [failure, failure, failure], [["1"], ["2"]]);
    assert.deepEqual(sources, ["1"], failure.error);
    assert.deepEqual(waits, [], failure.error);
    assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"], failure.error);
    assert.equal(receipts[1]!.last_error, quota.detail, failure.error);
  }
  // A lease holder at a brief rate limit of a subscription login gets its follow-up turn, and is not told that it has no credit.
  const notUsage = { error: notUsageLimit[0]!, claudeApiFailure: rateLimit };
  const retried = await runFailingLeaseHolder("claude-code", [notUsage], [["1"], []]);
  assert.deepEqual(retried.sources, ["1", "continuation"]);
  assert.deepEqual(retried.waits, [SHORT_FAULT_WAITS[0]]);
  assert.deepEqual(retried.receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply"]);
});

test("a refused credential that Claude names `invalid_request` blocks the follow-up for the owner, and Retry delivery then continues the task", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-claude-key-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const sources: string[] = [];
  let keyIsRight = false;
  const disabled = { error: "Your organization has disabled API key authentication \u00b7 Unset ANTHROPIC_API_KEY and run /login to sign in with your claude.ai account",
    claudeApiFailure: { status: 403, terminalReason: "api_error", category: "invalid_request" } };
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const source = request.sourceMessage as { id?: string; source?: string };
    sources.push(source.source === "system" ? "continuation" : String(source.id));
    const turnId = `turn-${sources.length}`;
    await options?.checkpointTurnStarted?.(turnId);
    return keyIsRight ? { turnId, outcome: "no_reply", text: null }
      : { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", ...disabled };
  }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] }, currentAuthority, 0, async () => {});
  const claude = { ...agent, provider: "claude-code" };
  try {
    await ingest(store, "1");
    await delivery.pump(claude);
    const blocked = await store.receipts(agent.agentId);
    assert.deepEqual(blocked.map((item) => item.state), ["acknowledged_failed", "blocked"], "nothing is settled with 'sending it again cannot help'");
    assert.equal(blocked[0]!.last_error, disabled.error);
    assert.equal(blocked[1]!.last_error, `The model provider needs authentication or account access. ${RETRY_DELIVERY}`);
    assert.deepEqual(sources, ["1"]);

    // The owner puts the key right and uses Retry delivery: the follow-up turn runs, in the same conversation.
    keyIsRight = true;
    await delivery.retry(claude, blocked[1]!.source_message_id);
    await waitForAsync(async () => (await store.receipts(agent.agentId))[1]?.state === "acknowledged_no_reply");
    assert.deepEqual(sources, ["1", "continuation"]);
  } finally {
    await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true });
  }
});

for (const [ending, claudeApiFailure] of Object.entries({
  "the provider refused it": { status: 400, terminalReason: "prompt_too_long", category: "invalid_request", promptTooLong: true },
  "Claude Code did not send it": { status: null, terminalReason: "blocking_limit", category: "invalid_request", promptTooLong: true },
  "its error was read back from the session": { status: 400, terminalReason: null, category: "invalid_request", promptTooLong: true },
} as const)) test(`a request that does not fit the model's context (${ending}) blocks its follow-up for the owner; after a new conversation, Retry delivery ends that follow-up without a turn`, async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-claude-too-long-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const sources: string[] = [];
  const tooLong = { error: "Prompt is too long · the request is ~250000 tokens (limit 200000)", claudeApiFailure };
  const delivery = new SupervisedAgentDelivery(store, provider(async (handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const source = request.sourceMessage as { id?: string; source?: string };
    sources.push(`${source.source === "system" ? "continuation" : source.id} in ${handle.providerContinuationId}`);
    const turnId = `turn-${sources.length}`;
    await options?.checkpointTurnStarted?.(turnId);
    // Every turn in the old conversation fails the same way. A new conversation answers.
    return handle.providerContinuationId === "thread"
      ? { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", ...tooLong }
      : { turnId, outcome: "no_reply", text: null };
  }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] }, currentAuthority, 0, async () => {});
  const claude = { ...agent, provider: "claude-code" };
  try {
    await ingest(store, "1");
    await delivery.pump(claude);
    await ingest(store, "2");
    await delivery.pump(claude);
    const blocked = await store.receipts(agent.agentId);
    assert.deepEqual(blocked.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"], "the next message waits behind the follow-up");
    assert.equal(blocked[1]!.last_error, `${tooLong.error} ${DOES_NOT_FIT}`, "the owner reads Claude's own text, and what a new conversation costs");
    assert.deepEqual(sources, ["1 in thread"], "no follow-up turn is sent into the conversation that is too long");

    // The owner uses Start fresh: the agent has a new conversation. The follow-up belongs to the old one.
    const fresh = { ...claude, providerContinuationId: "thread-2", handle: { ...claude.handle, providerContinuationId: "thread-2" } };
    await delivery.retry(fresh, blocked[1]!.source_message_id);
    await waitForAsync(async () => (await store.receipts(agent.agentId))[2]?.state === "acknowledged_no_reply");
    const released = await store.receipts(agent.agentId);
    assert.deepEqual(released.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply", "acknowledged_no_reply"]);
    assert.equal(released[1]!.last_error, "The agent did not try again: its session, conversation or workspace changed after the failure. Send it a message to continue the task.",
      "the task is not continued by itself in the new conversation");
    assert.deepEqual(sources, ["1 in thread", "2 in thread-2"], "the next message runs in the new conversation, and the follow-up runs nowhere");
  } finally {
    await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true });
  }
});

test("a failure with no structured account is decided on its text, exactly as before", async () => {
  const temporary = temporaryAt(1);
  const authentication = { automatic: false, detail: `The model provider needs authentication or account access. ${RETRY_DELIVERY}` };
  const quota = { automatic: false, detail: `The model provider has insufficient credit or quota. ${RETRY_DELIVERY}` };
  const unknown = { automatic: false, detail: `The provider failed and safe automatic recovery could not be established. ${RETRY_DELIVERY}` };
  const today: Array<[text: string, policy: ReturnType<typeof taskFailurePolicy>]> = [
    ["HTTP 503 Service Unavailable", temporary],
    ["unexpected status 401 Unauthorized: the provider rejected this key.", authentication],
    ["The account has insufficient credit for this request.", quota],
    ["Something went wrong.", unknown],
  ];
  for (const [text, policy] of today) {
    assert.deepEqual(taskFailurePolicy(text, 1), policy, text);
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, null), policy, text);
    // An account that says nothing that decides, such as Claude's `unknown` with no status, changes nothing.
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, { status: null, terminalReason: "api_error", category: "unknown" }), policy, text);
    // A Claude turn that failed in another way than an API error carries no account. Another provider's turn never has one.
    for (const providerId of ["claude-code", "codex", "open-model"]) {
      const { receipts, sources } = await runFailingLeaseHolder(providerId, [{ error: text }], [["1"], ["2"]]);
      assert.deepEqual(sources, policy.automatic ? ["1", "continuation", "2"] : ["1"], `${providerId}: ${text}`);
      assert.deepEqual(receipts.map((item) => item.state), policy.automatic
        ? ["acknowledged_failed", "acknowledged_no_reply", "acknowledged_no_reply"] : ["acknowledged_failed", "blocked", "pending"], `${providerId}: ${text}`);
      if (!policy.automatic) assert.equal(receipts[1]!.last_error, policy.detail, `${providerId}: ${text}`);
    }
  }

  // What a provider that is not Claude Code got for each of these texts before Claude's fields and words were
  // read, written out from a run of that function. It gets the same now, whatever Claude Code would make of them.
  const before: Array<[text: string, policy: ReturnType<typeof taskFailurePolicy>]> = [
    // Limits, credit and quota.
    ["429 Too Many Requests: you've hit your concurrency limit", temporary], ["429 You've reached your requests per minute limit", temporary],
    ["stream error: You've hit your context window limit", unknown], ["temporarily overloaded (not your usage limit)", quota],
    ["You've hit your usage limit. Upgrade to Pro or try again in 3 hours.", quota], ["You've hit your session limit \u00b7 resets 3pm", unknown], ["You've hit your weekly limit", unknown],
    ["You're out of extra usage \u00b7 resets 5pm", unknown], ["You've hit your rate limit.", temporary], ["You've hit your rate-limit, slow down", temporary],
    ["Rate limit reached for gpt-5 in organization org-x on requests per min. Limit: 500 / min.", temporary],
    ["You exceeded your current quota, please check your plan and billing details.", unknown], ["insufficient_quota", quota], ["Insufficient credits. Add more using the billing page.", quota],
    ["402 Payment Required", quota], ["Credit balance is too low", unknown], ["Your account has exhausted its output budget", quota], ["spend limit reached for this month", quota],
    ["quota_exceeded", quota], ["This service is disabled for your org", unknown], ["Your org is out of usage \u00b7 contact your admin", unknown],
    // A status in the text.
    ["HTTP 400 Bad Request: invalid_request_error", unknown], ["400 messages.0.content: this request is invalid", unknown], ["401 Unauthorized", authentication],
    ["HTTP 403 Forbidden: access denied for this key", authentication], ["404 model not found", unknown], ["413 Request Entity Too Large", unknown], ["429 Too Many Requests", temporary],
    ["500 Internal Server Error", temporary], ["502 Bad Gateway", temporary], ["503 Service Unavailable", temporary], ["504 Gateway Timeout", temporary], ["529 Overloaded", temporary],
    // The context, a key, a connection.
    ["Prompt is too long", unknown], ["prompt is too long: 250000 tokens > 200000 maximum", unknown], ["context_length_exceeded: This model's maximum context length is 128000 tokens", unknown],
    ["Request too large (max 32MB).", unknown], ["Invalid API key", authentication], ["Sign in required to continue", authentication], ["authentication failed for provider", authentication],
    ["OAuth token expired", unknown], ["Connection refused", unknown], ["connection reset by peer", temporary], ["ECONNRESET", temporary], ["ETIMEDOUT", temporary],
    ["socket closed unexpectedly", temporary], ["network error", temporary], ["Service temporarily unavailable", temporary], ["The model is overloaded. Please try again later.", temporary],
    ["Cursor Agent exited with code 1", unknown], ["Codex turn failed: stream disconnected before completion", unknown], ["unknown error", unknown], ["", unknown],
  ];
  const stopped = { automatic: false, detail: STOPPED_AFTER_THREE };
  for (const [text, policy] of before) {
    assert.deepEqual(taskFailurePolicy(text, 1), policy, text);
    assert.deepEqual(taskFailurePolicy(text, 1, false, false, null, false), policy, text);
    // After three follow-ups a text that is retried, or that nothing is known about, stops. The others say the same again.
    assert.deepEqual(taskFailurePolicy(text, 4, false, false, null, false), policy === temporary || policy === unknown ? stopped : policy, `${text} (attempt 4)`);
  }
  // The delivery says which provider failed. A few of these, run for each provider that is not Claude Code.
  for (const [text, policy] of [before[0]!, before[3]!, before[5]!, before[15]!]) {
    for (const providerId of ["codex", "cursor", "open-model"]) {
      const { receipts, sources } = await runFailingLeaseHolder(providerId, [{ error: text }], [["1"], []]);
      assert.deepEqual(sources, policy.automatic ? ["1", "continuation"] : ["1"], `${providerId}: ${text}`);
      if (!policy.automatic) assert.equal(receipts[1]!.last_error, policy.detail, `${providerId}: ${text}`);
    }
  }
});

test("Claude's account decides for a Claude failure only: the same failure from another provider is decided on its text", async () => {
  // A connection that was refused. The text reads like no temporary fault; Claude's fields say that it is one.
  const refused = { error: "API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)",
    claudeApiFailure: { status: null, terminalReason: "api_error", category: "server_error" } };
  const claude = await runFailingLeaseHolder("claude-code", [refused], [["1"], ["2"]]);
  assert.deepEqual(claude.sources, ["1", "continuation", "2"], "Claude: a follow-up turn, then the next message");
  assert.deepEqual(claude.waits, [SHORT_FAULT_WAITS[0]], "the follow-up waits thirty seconds");
  assert.deepEqual(claude.receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply", "acknowledged_no_reply"]);
  assert.equal(claude.receipts[0]!.last_error, refused.error, "the failed message keeps the provider's own text");

  for (const providerId of ["codex", "open-model", "cursor"]) {
    const other = await runFailingLeaseHolder(providerId, [refused], [["1"], ["2"]]);
    assert.deepEqual(other.sources, ["1"], providerId);
    assert.deepEqual(other.receipts.map((item) => item.state), ["acknowledged_failed", "blocked", "pending"], providerId);
    assert.equal(other.receipts[1]!.last_error, `The provider failed and safe automatic recovery could not be established. ${RETRY_DELIVERY}`, providerId);
  }
});

test("a short fault that does not end gets three follow-up turns, after thirty seconds, two minutes and ten minutes, and then waits for the owner", async () => {
  const refused = { error: "API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)",
    claudeApiFailure: { status: null, terminalReason: "api_error", category: "server_error" } };
  const { receipts, sources, waits } = await runFailingLeaseHolder("claude-code", Array.from({ length: 8 }, () => refused), [["1"], ["2"]]);
  assert.deepEqual(sources, ["1", "continuation", "continuation", "continuation"], "the message's own turn and three follow-ups: four turns, and no more");
  assert.deepEqual(waits, [30_000, 120_000, 600_000]);
  assert.deepEqual(receipts.map((item) => item.state),
    ["acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "blocked", "pending"],
    "the fourth failure queues a follow-up that waits for the owner, and the next message waits behind it");
  assert.equal(receipts[4]!.last_error, STOPPED_AFTER_THREE);
  for (const failed of receipts.slice(0, 4)) assert.equal(failed.last_error, refused.error, "each failed turn keeps the provider's own text");
});

test("the waits of a follow-up: thirty seconds, two minutes and ten minutes after a short fault of any provider, and ten, twenty and forty seconds otherwise", async () => {
  assert.deepEqual([...SHORT_FAULT_FOLLOW_UP_DELAYS_MS], [30_000, 120_000, 600_000]);
  assert.equal(MAX_AUTOMATIC_FOLLOW_UPS, 3);
  assert.deepEqual([1, 2, 3].map(defaultFollowUpDelayMs), [10_000, 20_000, 40_000]);
  // A short fault is the same thing whoever reports it: with Claude's account of it, and by its text for any provider.
  for (const attempt of [1, 2, 3]) {
    assert.equal(taskFailurePolicy("Overloaded", attempt, false, false, { status: 529, terminalReason: "api_error", category: "server_error" }).delayMs, SHORT_FAULT_WAITS[attempt - 1]);
    assert.equal(taskFailurePolicy("HTTP 503 Service Unavailable", attempt).delayMs, SHORT_FAULT_WAITS[attempt - 1]);
  }
  // A turn that ended without a reply gets one follow-up, and has no schedule of its own: it waits ten seconds.
  assert.deepEqual([taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 1).automatic, taskFailurePolicy(NO_REPLY_FAILURE.outputLimit, 1).delayMs], [true, undefined]);
  const noReply = await runNoReplyContinuity([NO_REPLY_FAILURE.emptyAnswer], [["1"], []]);
  assert.deepEqual(noReply.sources, ["1", "continuation"]);
  // No decision that stops has a wait.
  for (const stopped of [taskFailurePolicy("HTTP 503", 4), taskFailurePolicy("HTTP 401 unauthorized", 1), taskFailurePolicy("Something went wrong.", 1)]) {
    assert.deepEqual([stopped.automatic, stopped.delayMs], [false, undefined]);
  }

  // Through the delivery, for a provider that is not Claude Code: three follow-ups at those times, and then the owner.
  for (const providerId of ["codex", "cursor", "open-model"]) {
    const fault = { error: "stream error: 503 Service Unavailable" };
    const { receipts, sources, waits } = await runFailingLeaseHolder(providerId, Array.from({ length: 8 }, () => fault), [["1"], ["2"]]);
    assert.deepEqual(sources, ["1", "continuation", "continuation", "continuation"], providerId);
    assert.deepEqual(waits, [30_000, 120_000, 600_000], providerId);
    assert.deepEqual(receipts.map((item) => item.state),
      ["acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "blocked", "pending"], providerId);
    assert.equal(receipts[4]!.last_error, STOPPED_AFTER_THREE, providerId);
  }
});

/**
 * A lease holder whose every turn ends on a short provider fault, on a daemon whose waits end only when something
 * ends them: the daemon stops, or the owner uses Try now or Stop trying. The clock of the inbox is the test's.
 */
async function scheduledRetryFixture(providerId = "claude-code") {
  const root = await mkdtemp(join(tmpdir(), "continuity-scheduled-retry-"));
  const path = join(root, "state.sqlite");
  const clock = { nowMs: Date.parse("2026-10-01T00:00:00.000Z") };
  const fault: { error: string; claudeApiFailure?: ClaudeFacts } =
    { error: "API Error: Repeated 529 Overloaded errors.", claudeApiFailure: { status: 529, terminalReason: "api_error", category: "server_error" } };
  const sources: string[] = []; const waits: number[] = [];
  let failing = true;
  /**
   * `turnStarts`: the next turn is held here, after it was claimed and before its turn id is saved.
   * `ownedTasks`: runs once, the next time the daemon asks which tasks the agent holds. `held`: what it then holds.
   */
  const hooks: { turnStarts: Promise<void> | null; ownedTasks: (() => Promise<void>) | null; held: typeof continuityTask[] } =
    { turnStarts: null, ownedTasks: null, held: [continuityTask] };
  const port = provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const source = request.sourceMessage as { id?: string; source?: string };
    sources.push(source.source === "system" ? "continuation" : String(source.id));
    const turnId = `turn-${sources.length}`;
    await hooks.turnStarts;
    await options?.checkpointTurnStarted?.(turnId);
    return failing ? { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", ...fault }
      : { turnId, outcome: "no_reply", text: null };
  });
  const claude = { ...agent, provider: providerId };
  let store = new SupervisedAgentInboxStore(path, () => new Date(clock.nowMs).toISOString());
  const makeDelivery = () => new SupervisedAgentDelivery(store, port, { poll: async () => ({}), publish: async () => {},
    ownedTasks: async () => { const hook = hooks.ownedTasks; hooks.ownedTasks = null; await hook?.(); return hooks.held; } },
    currentAuthority, 50, async () => {}, (delayMs, signal) => new Promise<void>((resolve) => {
      waits.push(delayMs);
      if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
    }));
  let delivery = makeDelivery();
  const view = async () => projectDeliveryReceipts(await store.receiptProjection(agent.agentId), null)!;
  return { clock, fault, sources, waits, claude, view, hooks, path,
    store: () => store, delivery: () => delivery,
    /** The provider recovers: the next turn ends with no reply instead of the fault. */
    providerRecovers: () => { failing = false; },
    /** The follow-up that waits for its time, as the manifest shows it. */
    scheduled: async () => (await view()).find((receipt) => receipt.follow_up?.scheduled) ?? null,
    /** Send room message `id` and let the daemon work until it waits `waiting` times in all, or is idle. */
    say: async (id: string, waiting: number) => {
      await ingest(store, id);
      void delivery.pump(claude).catch(() => undefined);
      await waitForAsync(async () => waits.length >= waiting);
    },
    /**
     * The daemon ends and a new one takes the same saved state over. The clock goes on by `downMs` in between. The
     * new one works for `as`, and `beforePump` runs on it before it starts to work. `pump` settles when that work ends:
     * while a follow-up waits for its time, that is when something ends the wait.
     */
    restartDaemon: async (downMs: number, as: typeof claude = claude, beforePump?: () => void) => {
      await delivery.fenceAndDrain();
      await store.close();
      clock.nowMs += downMs;
      store = new SupervisedAgentInboxStore(path, () => new Date(clock.nowMs).toISOString());
      delivery = makeDelivery();
      beforePump?.();
      return { pump: delivery.pump(as).catch(() => undefined) };
    },
    cleanup: async () => { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("a scheduled follow-up says when it starts, which attempt it is and which message it is for; Try now starts it at once, as that attempt", async () => {
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    const failedAt = retry.clock.nowMs;
    assert.deepEqual(retry.sources, ["1"]);
    assert.deepEqual(retry.waits, [30_000]);
    const first = (await retry.scheduled())!;
    assert.match(first.source_message_id, /^task-continuation:/);
    assert.equal(first.state, "pending");
    assert.deepEqual(first.follow_up, scheduledFault(failedAt + 30_000, 1));
    // What failed stays on the failed message, in the provider's own words. Nothing is blocked, so nothing needs the owner.
    const [failed] = await retry.view();
    assert.deepEqual([failed!.source_message_id, failed!.state, failed!.error, failed!.follow_up], ["1", "acknowledged_failed", retry.fault.error, undefined]);
    assert.deepEqual((await retry.view()).filter((receipt) => receipt.state === "blocked"), []);

    retry.clock.nowMs += 5_000;
    // Try now. The follow-up runs at once, 25 seconds early. The provider still fails, so the next follow-up is
    // attempt 2 with the wait of attempt 2: Try now was attempt 1, not an attempt of its own.
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => retry.waits.length === 2);
    assert.deepEqual(retry.sources, ["1", "continuation"]);
    assert.deepEqual(retry.waits, [30_000, 120_000]);
    const second = (await retry.scheduled())!;
    assert.notEqual(second.source_message_id, first.source_message_id);
    assert.deepEqual(second.follow_up, scheduledFault(retry.clock.nowMs + 120_000, 2));
    assert.deepEqual((await retry.view()).map((receipt) => receipt.state), ["acknowledged_failed", "acknowledged_failed", "pending"]);
    const tried = (await retry.store().receipts(agent.agentId))[1]!;
    assert.ok(tried.timeline.some((event) => event.phase === "retry_scheduled" && event.detail === "Started now, as its owner asked."));

    // Try now again, and once more: attempt 2, then attempt 3, the last. After it the follow-up waits for the owner.
    await retry.delivery().retry(retry.claude, second.source_message_id);
    await waitForAsync(async () => retry.waits.length === 3);
    const third = (await retry.scheduled())!;
    assert.deepEqual(third.follow_up, scheduledFault(retry.clock.nowMs + 600_000, 3));
    await retry.delivery().retry(retry.claude, third.source_message_id);
    await waitForAsync(async () => (await retry.view()).some((receipt) => receipt.state === "blocked"));
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation", "continuation"], "three follow-ups in all, however they were started");
    assert.deepEqual(retry.waits, [30_000, 120_000, 600_000]);
    assert.equal(await retry.scheduled(), null, "the blocked follow-up is not a scheduled one");
    const blocked = (await retry.view()).find((receipt) => receipt.state === "blocked")!;
    assert.equal(blocked.error, STOPPED_AFTER_THREE);
    // It has no room message of its own. It names the one the work began with, so that message can say that the
    // automatic attempts are over, with Retry for this follow-up.
    assert.deepEqual(blocked.follow_up, { for_message_id: "1", state: "waiting_for_owner", scheduled: null });
    await ingest(retry.store(), "2");
    assert.equal((await retry.view()).at(-1)!.state, "queued_behind_blocked", "a later message now waits for the owner");
    // Try now is for a follow-up that waits for its time. A message that failed, or one that waits behind, has none.
    await assert.rejects(retry.delivery().retry(retry.claude, "1"), /no longer available/);
    await assert.rejects(retry.delivery().retry(retry.claude, "2"), /no longer available/);
    // The inbox refuses the same by itself: only a follow-up that waits for its time is started now or stopped. Not
    // the follow-up that waits for the owner, not one that ran, and not a room message.
    const items = await retry.store().receipts(agent.agentId);
    assert.deepEqual(items.map((item) => item.state), ["acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "blocked", "pending"]);
    for (const item of [items[4]!, items[1]!, items[0]!, items[5]!]) {
      await assert.rejects(retry.store().startTaskContinuationNow(item.inbox_item_id), /already started or ended/, item.state);
      await assert.rejects(retry.store().stopTaskContinuation(item.inbox_item_id, "stopped"), /already started or ended/, item.state);
    }
    assert.deepEqual((await retry.store().receipts(agent.agentId)).map((item) => [item.state, item.next_attempt_at_ms]), items.map((item) => [item.state, item.next_attempt_at_ms]),
      "and nothing changed");
  } finally { await retry.cleanup(); }
});

test("Stop trying ends a scheduled follow-up before anything starts: no other is made, and the next message goes ahead", async () => {
  const retry = await scheduledRetryFixture("codex");
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    assert.deepEqual(first.follow_up, scheduledFault(retry.clock.nowMs + 30_000, 1));
    // A message that arrives during the wait is kept behind the follow-up: it is queued, and nothing runs.
    await ingest(retry.store(), "2");
    retry.clock.nowMs += 5_000;
    await retry.delivery().pump(retry.claude);
    assert.deepEqual((await retry.view()).map((receipt) => receipt.state), ["acknowledged_failed", "pending", "pending"]);
    assert.deepEqual(retry.sources, ["1"]);
    retry.providerRecovers();

    await retry.delivery().skipMessage(retry.claude, first.source_message_id);
    await waitForAsync(async () => (await retry.view()).at(-1)!.state === "acknowledged_no_reply");
    assert.deepEqual(retry.sources, ["1", "2"], "no follow-up turn was started, and the message that waited ran");
    assert.deepEqual(retry.waits, [30_000], "nothing else was scheduled");
    const receipts = await retry.store().receipts(agent.agentId);
    assert.deepEqual(receipts.map((item) => [item.source_message_id.replace(/:.*/, ""), item.state]),
      [["1", "acknowledged_failed"], ["task-continuation", "cancelled_by_user"], ["2", "acknowledged_no_reply"]]);
    assert.equal(receipts[0]!.last_error, retry.fault.error, "the failed message keeps the provider's own words");
    assert.equal(receipts[1]!.last_error, STOPPED_BY_OWNER);
    assert.equal(receipts[1]!.next_attempt_at_ms, null);
    // The failed message is where its owner reads that: the stopped follow-up names it, and keeps the reason.
    const stopped = (await retry.view())[1]!;
    assert.deepEqual([stopped.follow_up, stopped.error], [{ for_message_id: "1", state: "ended", scheduled: null }, STOPPED_BY_OWNER]);
    assert.ok(receipts[1]!.timeline.some((event) => event.phase === "user_cancelled"));
    assert.equal(await retry.scheduled(), null);
    // It is over: neither control finds it again, and a later pump starts nothing for the old failure.
    await assert.rejects(retry.delivery().skipMessage(retry.claude, first.source_message_id), /^Error: This automatic attempt has already started or ended\.$/);
    await assert.rejects(retry.delivery().retry(retry.claude, first.source_message_id), /^Error: This automatic attempt has already started or ended\.$/);
    await retry.delivery().pump(retry.claude);
    assert.deepEqual(retry.sources, ["1", "2"]);
  } finally { await retry.cleanup(); }
});

test("a scheduled follow-up keeps its time across a daemon restart, and Try now and Stop trying work after one", async () => {
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    const dueAt = first.follow_up!.scheduled!.at_ms;
    assert.equal(dueAt, retry.clock.nowMs + 30_000);

    // The daemon is down for 12 seconds of the 30. The next daemon waits the 18 that are left, to the same time.
    await retry.restartDaemon(12_000);
    await waitForAsync(async () => retry.waits.length === 2);
    assert.deepEqual(retry.waits, [30_000, 18_000]);
    assert.deepEqual((await retry.scheduled())!.follow_up, scheduledFault(dueAt, 1));
    assert.deepEqual(retry.sources, ["1"], "nothing ran early");

    // Try now on the new daemon: attempt 1 runs, fails, and attempt 2 is scheduled two minutes ahead.
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => retry.waits.length === 3);
    assert.deepEqual(retry.sources, ["1", "continuation"]);
    const second = (await retry.scheduled())!;
    assert.deepEqual(second.follow_up, scheduledFault(retry.clock.nowMs + 120_000, 2));

    // Down again, for longer than the wait. The time has passed, so the next daemon starts attempt 2 without waiting.
    await retry.restartDaemon(150_000);
    await waitForAsync(async () => retry.sources.length === 3);
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"]);
    await waitForAsync(async () => retry.waits.length === 4);
    assert.equal(retry.waits.at(-1), 600_000);
    const third = (await retry.scheduled())!;
    assert.deepEqual(third.follow_up, scheduledFault(retry.clock.nowMs + 600_000, 3));

    // Stop trying on a daemon that was started during the wait.
    await retry.restartDaemon(60_000);
    await waitForAsync(async () => retry.waits.length === 5);
    assert.equal(retry.waits.at(-1), 540_000);
    await retry.delivery().skipMessage(retry.claude, third.source_message_id);
    assert.equal(await retry.scheduled(), null);
    assert.deepEqual((await retry.view()).map((receipt) => receipt.state), ["acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "cancelled_by_user"]);
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"], "the third follow-up never ran");
    // And it stays stopped across one more restart, and still says so on the failed message.
    await retry.restartDaemon(1_000);
    await retry.delivery().pump(retry.claude);
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"]);
    assert.equal(retry.waits.length, 5);
    const stopped = (await retry.view()).at(-1)!;
    assert.deepEqual([stopped.follow_up, stopped.error], [{ for_message_id: "1", state: "ended", scheduled: null }, STOPPED_BY_OWNER]);
  } finally { await retry.cleanup(); }
});

test("a follow-up says which room message its work began with, and where it stands: scheduled, waiting for its owner, or ended unstarted", () => {
  const receipt = (over: Record<string, unknown>) => ({ inbox_item_id: "item", agent_id: "agent", room_id: "room", source_message_id: "msg", fifo_sequence: 1,
    state: "pending", receipt_state: "pending", attempt_count: 0, action_id: "action", reply_client_message_id: "reply", provider_turn_id: null, outcome: null, last_error: null,
    failure_code: null, blocked_by_inbox_item_id: null, next_attempt_at_ms: null, terminal_reason: null, created_at: "t", updated_at: "t", acknowledged_at: null,
    canonical_message_id: null, timeline: [], ...over }) as unknown as Parameters<typeof projectDeliveryReceipts>[0][number];
  const followUps = (receipts: ReturnType<typeof receipt>[]) => projectDeliveryReceipts(receipts, null)!.map((item) => item.follow_up ?? null);
  const failed = receipt({ inbox_item_id: "a", source_message_id: "msg_1", state: "acknowledged_failed", receipt_state: "acknowledged_failed" });
  const followUp = (id: string, parent: string, over: Record<string, unknown> = {}) =>
    receipt({ inbox_item_id: id, source_message_id: `task-continuation:${parent}`, next_attempt_at_ms: 5_000, ...over });
  const ran = { state: "acknowledged_failed", receipt_state: "acknowledged_failed", provider_turn_id: "turn", next_attempt_at_ms: null };
  // The chain back to the room message says which attempt this is.
  assert.deepEqual(followUps([failed, followUp("b", "a")]), [null, scheduledFault(5_000, 1, "msg_1")]);
  assert.deepEqual(followUps([failed, followUp("b", "a", ran), followUp("c", "b")]), [null, null, scheduledFault(5_000, 2, "msg_1")]);
  // A receipt that is no longer kept: the attempt is counted as far as the chain goes, and no message is named.
  assert.deepEqual(followUps([followUp("c", "b")]), [scheduledFault(5_000, 1, null)]);
  // A turn that ended without a reply gets one automatic attempt, not three. The follow-up's own text says which it is.
  assert.deepEqual(followUps([failed, followUp("b", "a", { last_error: "The model stopped before writing a reply. The agent will try again once, after a short wait." })]),
    [null, { for_message_id: "msg_1", state: "scheduled", scheduled: { at_ms: 5_000, attempt: 1, attempts: 1, kind: "no_reply" } }]);
  assert.deepEqual(followUps([failed, followUp("b", "a", { last_error: "The provider failed temporarily. The agent will try again by itself." })]), [null, scheduledFault(5_000, 1, "msg_1")]);

  // A follow-up that waits for its owner has no time. It still names the room message: after all three automatic
  // attempts it is four follow-ups back, and after its owner used Retry on that one, five.
  const waiting = { for_message_id: "msg_1", state: "waiting_for_owner", scheduled: null };
  const blocked = { state: "blocked", receipt_state: "blocked", next_attempt_at_ms: null, last_error: STOPPED_AFTER_THREE };
  assert.deepEqual(followUps([failed, followUp("b", "a", blocked)]), [null, waiting]);
  assert.deepEqual(followUps([failed, followUp("b", "a", ran), followUp("c", "b", ran), followUp("d", "c", ran), followUp("e", "d", blocked)]), [null, null, null, null, waiting]);
  assert.deepEqual(followUps([failed, followUp("b", "a", ran), followUp("c", "b", ran), followUp("d", "c", ran), followUp("e", "d", ran), followUp("f", "e", blocked)]),
    [null, null, null, null, null, waiting]);
  // A message that waits behind it is shown as that, but it is not a follow-up.
  assert.deepEqual(followUps([failed, followUp("b", "a", blocked), receipt({ inbox_item_id: "c", source_message_id: "msg_2", receipt_state: "queued_behind_blocked" })]), [null, waiting, null]);

  // A follow-up that ended with nothing started says so, with its reason, for each way that it can end so.
  const ended = { for_message_id: "msg_1", state: "ended", scheduled: null };
  for (const [state, reason] of [
    ["cancelled_by_user", STOPPED_BY_OWNER],
    ["acknowledged_no_reply", "The agent did not try again: its session, conversation or workspace changed after the failure. Send it a message to continue the task."],
    ["acknowledged_no_reply", "The agent did not try again: the task is finished, or is no longer this agent's."],
    ["acknowledged_no_reply", "The agent did not try again: an earlier action has an uncertain result. Check that result, then send an instruction to continue only the verified unfinished work."],
  ] as const) {
    const [, projected] = projectDeliveryReceipts([failed, followUp("b", "a", { state, receipt_state: state, next_attempt_at_ms: null, last_error: reason })], null)!;
    assert.deepEqual([projected!.follow_up, projected!.error], [ended, reason], reason);
    // The room message shows at most 180 characters of a reason.
    assert.ok(reason.length <= 180, reason);
  }
  assert.ok(STOPPED_AFTER_THREE.length <= 180);

  // Not a follow-up to show: one that runs, one whose turn ran, one that is pending with no time, and a room message.
  // One that ended with a turn, or with a text that is not one of those reasons, is not one that ended unstarted: a
  // blocked follow-up that its owner skipped keeps the text of its block.
  for (const other of [followUp("b", "a", { state: "dispatching", receipt_state: "dispatching" }), followUp("b", "a", ran),
    followUp("b", "a", { next_attempt_at_ms: null }),
    followUp("b", "a", { state: "acknowledged_no_reply", receipt_state: "acknowledged_no_reply", next_attempt_at_ms: null, provider_turn_id: "turn", last_error: STOPPED_BY_OWNER }),
    followUp("b", "a", { state: "cancelled_by_user", receipt_state: "cancelled_by_user", next_attempt_at_ms: null, last_error: STOPPED_AFTER_THREE }),
    followUp("b", "a", { state: "cancelled_by_user", receipt_state: "cancelled_by_user", next_attempt_at_ms: null }),
    followUp("b", "a", { state: "acknowledged", receipt_state: "acknowledged", next_attempt_at_ms: null, last_error: STOPPED_BY_OWNER }),
    receipt({ inbox_item_id: "b", source_message_id: "msg_2", next_attempt_at_ms: 5_000 }),
    receipt({ inbox_item_id: "b", source_message_id: "msg_2", state: "blocked", receipt_state: "blocked" })]) {
    assert.deepEqual(followUps([failed, other]), [null, null], JSON.stringify(other));
  }
});

test("after a turn that ended without a reply the follow-up says that it is the only automatic attempt, and a repeat ends the series on the failed message", async () => {
  const retry = await scheduledRetryFixture("codex");
  try {
    // Every turn ends without a reply: the model stopped, and no provider fault is reported.
    retry.fault.error = NO_REPLY_FAILURE.emptyAnswer;
    delete retry.fault.claudeApiFailure;
    await retry.say("1", 1);
    assert.deepEqual(retry.waits, [10_000]);
    const first = (await retry.scheduled())!;
    assert.equal(first.error, "The model stopped before writing a reply. The agent will try again once, after a short wait.");
    assert.deepEqual(first.follow_up, { for_message_id: "1", state: "scheduled", scheduled: { at_ms: retry.clock.nowMs + 10_000, attempt: 1, attempts: 1, kind: "no_reply" } });

    // Try now. It ends without a reply again: no second attempt, nothing waits for the owner, and the reason is on the room message.
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => (await retry.view())[1]!.state === "acknowledged_failed");
    await retry.delivery().drainAdmittedTurns([agent.agentId]);
    const receipts = await retry.view();
    assert.deepEqual(receipts.map((receipt) => [receipt.state, receipt.follow_up]), [["acknowledged_failed", undefined], ["acknowledged_failed", undefined]]);
    assert.match(receipts[0]!.error!, /It happened again, so the unfinished task was not continued automatically\. Existing work is preserved; send a message to continue it\.$/);
    assert.equal(receipts[1]!.error, receipts[0]!.error);
    assert.deepEqual(retry.sources, ["1", "continuation"]);
    assert.deepEqual(retry.waits, [10_000]);
  } finally { await retry.cleanup(); }
});

test("a daemon handoff during a ten-minute wait is not held up by it, and the follow-up keeps its saved time", async () => {
  const retry = await scheduledRetryFixture();
  /** Settles like `work`, or says that it did not within a second: a wait of ten minutes must not be awaited. */
  const prompt = (work: Promise<unknown>) => Promise.race([work.then(() => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 1_000))]);
  try {
    // Two attempts fail, started by Try now. The third waits ten minutes.
    await retry.say("1", 1);
    await retry.delivery().retry(retry.claude, (await retry.scheduled())!.source_message_id);
    await waitForAsync(async () => retry.waits.length === 2);
    await retry.delivery().retry(retry.claude, (await retry.scheduled())!.source_message_id);
    await waitForAsync(async () => retry.waits.length === 3);
    assert.deepEqual(retry.waits, [30_000, 120_000, 600_000]);
    const third = (await retry.scheduled())!;
    const dueAt = third.follow_up!.scheduled!.at_ms;
    assert.deepEqual(third.follow_up, scheduledFault(retry.clock.nowMs + 600_000, 3));

    // The handoff pauses dispatch and drains the admitted turns. The pump only waits: it holds no turn, so it ends.
    retry.clock.nowMs += 100_000;
    retry.delivery().pauseDispatch();
    assert.equal(await prompt(retry.delivery().drainAdmittedTurns([agent.agentId])), "settled");
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"], "the follow-up did not start early");
    assert.deepEqual((await retry.scheduled())!.follow_up, scheduledFault(dueAt, 3), "and it keeps its saved time");
    // While dispatch is paused nothing new starts and nothing waits: a pump ends at once.
    assert.equal(await prompt(retry.delivery().pump(retry.claude)), "settled");
    assert.equal(retry.waits.length, 3);

    // Try now during the pause is accepted and saved, and no turn starts until dispatch goes on.
    await retry.delivery().retry(retry.claude, third.source_message_id);
    assert.equal(await prompt(retry.delivery().drainAdmittedTurns([agent.agentId])), "settled");
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"]);
    assert.deepEqual((await retry.scheduled())!.follow_up, scheduledFault(retry.clock.nowMs, 3), "it is due now, as the same attempt");
    assert.equal(retry.waits.length, 3);
    // The handoff is put off, so the same daemon goes on: the attempt that is due starts.
    retry.delivery().resumeDispatch();
    await waitForAsync(async () => (await retry.view()).some((receipt) => receipt.state === "blocked"));
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation", "continuation"]);
  } finally { await retry.cleanup(); }
});

test("after a daemon handoff the same wait goes on to the saved time, and Try now and Stop trying work at once", async () => {
  const retry = await scheduledRetryFixture();
  /** The handoff's first steps: no new turn is admitted, and the admitted ones are drained. */
  const pauseAndDrain = async () => { retry.delivery().pauseDispatch(); await retry.delivery().drainAdmittedTurns([agent.agentId]); };
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    const firstDueAt = first.follow_up!.scheduled!.at_ms;
    // Handoff put off after 10 of the 30 seconds, with nothing but the daemon's own wait in play: the same daemon
    // goes on, and waits the 20 seconds that are left. Not 30 again, and not none.
    retry.clock.nowMs += 10_000;
    await pauseAndDrain();
    retry.delivery().resumeDispatch();
    await waitForAsync(async () => retry.waits.length === 2);
    assert.deepEqual(retry.waits, [30_000, 20_000]);
    assert.deepEqual(retry.sources, ["1"], "it did not start at once");
    assert.deepEqual((await retry.scheduled())!.follow_up, scheduledFault(firstDueAt, 1));

    // Attempt 1 runs by Try now and fails. Attempt 2 waits two minutes.
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => retry.waits.length === 3);
    const second = (await retry.scheduled())!;
    const dueAt = second.follow_up!.scheduled!.at_ms;
    assert.equal(dueAt, retry.clock.nowMs + 120_000);

    // Handoff put off after 20 seconds: the same daemon waits the 100 seconds that are left.
    retry.clock.nowMs += 20_000;
    await pauseAndDrain();
    retry.delivery().resumeDispatch();
    await waitForAsync(async () => retry.waits.length === 4);
    assert.deepEqual(retry.waits, [30_000, 20_000, 120_000, 100_000]);
    assert.deepEqual(retry.sources, ["1", "continuation"], "it did not start at once");

    // Handoff done after 30 more seconds: the new daemon waits the 70 that are left, to the same saved time.
    retry.clock.nowMs += 30_000;
    await pauseAndDrain();
    await retry.restartDaemon(0);
    await waitForAsync(async () => retry.waits.length === 5);
    assert.deepEqual(retry.waits, [30_000, 20_000, 120_000, 100_000, 70_000]);
    assert.deepEqual((await retry.scheduled())!.follow_up, scheduledFault(dueAt, 2));
    assert.deepEqual(retry.sources, ["1", "continuation"]);

    // Try now right after the handoff: attempt 2 runs and fails, and attempt 3 waits ten minutes.
    await retry.delivery().retry(retry.claude, second.source_message_id);
    await waitForAsync(async () => retry.waits.length === 6);
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"]);
    const third = (await retry.scheduled())!;
    assert.deepEqual(third.follow_up, scheduledFault(retry.clock.nowMs + 600_000, 3));

    // Another handoff, and Stop trying right after it.
    retry.clock.nowMs += 60_000;
    await pauseAndDrain();
    await retry.restartDaemon(0);
    await waitForAsync(async () => retry.waits.length === 7);
    assert.equal(retry.waits.at(-1), 540_000);
    await retry.delivery().skipMessage(retry.claude, third.source_message_id);
    assert.deepEqual((await retry.view()).map((receipt) => receipt.state), ["acknowledged_failed", "acknowledged_failed", "acknowledged_failed", "cancelled_by_user"]);
    assert.deepEqual(retry.sources, ["1", "continuation", "continuation"], "the third follow-up never ran");
  } finally { await retry.cleanup(); }
});

test("a pump that is ended while it reads a follow-up's wait does not sleep that wait", async () => {
  for (const end of ["fence", "pauseDispatch"] as const) {
    const retry = await scheduledRetryFixture();
    try {
      await retry.say("1", 1);
      const first = (await retry.scheduled())!;
      // The next daemon is ended at the worst moment: after it read how long to wait, before it waits.
      const { pump } = await retry.restartDaemon(5_000, retry.claude, () => {
        const store = retry.store();
        const read = store.taskContinuationDelay.bind(store);
        store.taskContinuationDelay = async (inboxItemId) => {
          const delay = await read(inboxItemId);
          retry.delivery()[end]();
          return delay;
        };
      });
      const outcome = await Promise.race([pump.then(() => "ended"), new Promise<string>((resolve) => setTimeout(() => resolve("asleep"), 1_000))]);
      assert.equal(outcome, "ended", end);
      assert.deepEqual(retry.sources, ["1"], `${end}: the follow-up did not start`);
      assert.deepEqual((await retry.scheduled())!.follow_up, first.follow_up, `${end}: and it keeps its saved time`);
    } finally { await retry.cleanup(); }
  }
});

test("Try now and Stop trying come too late for a follow-up whose turn is starting: one turn runs, and nothing is stopped", async () => {
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    // The turn of the follow-up is held after it was claimed and before its turn id is saved: only its state says
    // that it started.
    const turn = deferred<void>();
    retry.hooks.turnStarts = turn.promise;
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => retry.sources.length === 2);
    const [, running] = await retry.store().receipts(agent.agentId);
    assert.deepEqual([running!.state, running!.provider_turn_id, running!.outcome], ["dispatching", null, null]);
    assert.equal((await retry.view())[1]!.follow_up, undefined, "it is no longer shown as one that waits");

    // Both controls, through the delivery and at the inbox itself.
    await assert.rejects(retry.delivery().retry(retry.claude, first.source_message_id), /^Error: This automatic attempt has already started or ended\.$/);
    await assert.rejects(retry.delivery().skipMessage(retry.claude, first.source_message_id), /^Error: This automatic attempt has already started or ended\.$/);
    await assert.rejects(retry.store().startTaskContinuationNow(running!.inbox_item_id), /^Error: This automatic attempt has already started or ended\.$/);
    await assert.rejects(retry.store().stopTaskContinuation(running!.inbox_item_id, STOPPED_BY_OWNER), /^Error: This automatic attempt has already started or ended\.$/);
    const [, still] = await retry.store().receipts(agent.agentId);
    assert.deepEqual([still!.state, still!.next_attempt_at_ms, still!.last_error], [running!.state, running!.next_attempt_at_ms, running!.last_error], "nothing changed");

    retry.hooks.turnStarts = null;
    turn.resolve();
    await waitForAsync(async () => retry.waits.length === 2);
    assert.deepEqual(retry.sources, ["1", "continuation"], "the turn ran once");
    assert.deepEqual((await retry.view()).map((receipt) => receipt.state), ["acknowledged_failed", "acknowledged_failed", "pending"]);
  } finally { await retry.cleanup(); }
});

test("a follow-up that ends unstarted during its wait says why on the failed message", async () => {
  const AGENT_CHANGED = "The agent did not try again: its session, conversation or workspace changed after the failure. Send it a message to continue the task.";
  const TASK_NOT_HELD = "The agent did not try again: the task is finished, or is no longer this agent's.";
  const ended = { for_message_id: "1", state: "ended", scheduled: null };
  // The agent comes back as another session, with another conversation, or in another workspace.
  for (const change of [{ agentSessionId: "session-2" }, { providerContinuationId: "thread-2" }, { workAttemptId: "attempt-2" }]) {
    const retry = await scheduledRetryFixture();
    try {
      await retry.say("1", 1);
      const changed = { ...retry.claude, ...change, handle: { ...retry.claude.handle, ...change } };
      await (await retry.restartDaemon(5_000, changed)).pump;
      const receipts = await retry.view();
      assert.deepEqual(receipts.map((receipt) => [receipt.state, receipt.error]), [["acknowledged_failed", retry.fault.error], ["acknowledged_no_reply", AGENT_CHANGED]], JSON.stringify(change));
      assert.deepEqual(receipts[1]!.follow_up, ended, JSON.stringify(change));
      assert.deepEqual(retry.sources, ["1"], "nothing ran");
      assert.deepEqual(retry.waits, [30_000], "and nothing waits");
    } finally { await retry.cleanup(); }
  }
  // The task was finished, or went to another agent, while the follow-up waited.
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    retry.hooks.held = [];
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => (await retry.view())[1]!.state === "acknowledged_no_reply");
    const receipts = await retry.view();
    assert.deepEqual([receipts[1]!.error, receipts[1]!.follow_up], [TASK_NOT_HELD, ended]);
    assert.deepEqual(retry.sources, ["1"], "nothing ran");
  } finally { await retry.cleanup(); }
});

test("a series that ends on an action with an uncertain result says so on the room message it began with", async () => {
  const UNCERTAIN = "The agent did not try again: an earlier action has an uncertain result. Check that result, then send an instruction to continue only the verified unfinished work.";
  const retry = await scheduledRetryFixture();
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    // The follow-up's turn starts an action that changes something outside, and fails before the action's result is known.
    const db = new DatabaseSync(retry.path);
    db.prepare(`INSERT INTO supervised_agent_effects
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      VALUES ('effect',?,?,?,'turn-2','request','publish_room_artifact','{}',1,'executing',NULL,NULL,?,?)`)
      .run(agent.agentId, agent.roomId, "generation-1", new Date().toISOString(), new Date().toISOString());
    db.close();
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => (await retry.view())[1]!.state === "acknowledged_failed");
    await retry.delivery().drainAdmittedTurns([agent.agentId]);
    // No other follow-up is made. The failed follow-up has no room message, so the reason is also on the one it began with.
    assert.deepEqual((await retry.view()).map((receipt) => [receipt.source_message_id.replace(/:.*/, ""), receipt.state, receipt.error]),
      [["1", "acknowledged_failed", UNCERTAIN], ["task-continuation", "acknowledged_failed", UNCERTAIN]]);
    assert.deepEqual(retry.sources, ["1", "continuation"]);
    assert.deepEqual(retry.waits, [30_000], "nothing else waits");
  } finally { await retry.cleanup(); }
});

test("Stop trying at the moment a follow-up's time came is not a delivery fault", async () => {
  const retry = await scheduledRetryFixture();
  const warned: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...parts: unknown[]) => { warned.push(parts); };
  try {
    await retry.say("1", 1);
    const first = (await retry.scheduled())!;
    const item = (await retry.store().receipts(agent.agentId))[1]!;
    // The follow-up is due, and the daemon asks which tasks the agent holds. At that moment its owner stops it.
    retry.hooks.ownedTasks = () => retry.store().stopTaskContinuation(item.inbox_item_id, STOPPED_BY_OWNER);
    await retry.delivery().retry(retry.claude, first.source_message_id);
    await waitForAsync(async () => (await retry.view())[1]!.state === "cancelled_by_user");
    await retry.delivery().drainAdmittedTurns([agent.agentId]);
    assert.deepEqual(retry.sources, ["1"], "nothing ran");
    assert.deepEqual(retry.waits, [30_000], "the pump did not back off as after a fault");
    assert.deepEqual(warned, [], "and it reported none");
    assert.deepEqual([(await retry.view())[1]!.follow_up, (await retry.view())[1]!.error], [{ for_message_id: "1", state: "ended", scheduled: null }, STOPPED_BY_OWNER]);
  } finally { console.warn = warn; await retry.cleanup(); }
});

test("task continuity survives restart after native failure, preserves files and deduplicates completed effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-restart-"));
  const path = join(root, "state.sqlite");
  let store = new SupervisedAgentInboxStore(path);
  const effectRequest = { agent_id: agent.agentId, room_id: agent.roomId, execution_generation_id: "generation-1",
    provider_turn_id: "failed-turn", work_attempt_id: "attempt", current_execution_generation_id: "generation-2",
    provider_continuation_id: "thread", mcp_request_id: "publish-pr", tool_name: "publish_room_artifact",
    request: { url: "https://github.com/example/repo/pull/1" }, mutation: true };
  const http = { poll: async () => ({}), ownedTasks: async () => [continuityTask],
    publish: async () => ({ roomId: agent.roomId, messageId: "published" }) };
  let runs = 0;
  let delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    runs++;
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("failed-turn");
    await writeFile(join(root, "work.txt"), "partial implementation\n");
    // An already executed external mutation has its durable receipt before the provider fails.
    const db = new DatabaseSync(path);
    db.prepare(`INSERT INTO supervised_agent_effects
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      VALUES ('effect',?,?,?,?,?,?,?,1,'completed',?,NULL,?,?)`).run(agent.agentId, agent.roomId, "generation-1",
      "failed-turn", effectRequest.mcp_request_id, effectRequest.tool_name, JSON.stringify(effectRequest.request),
      JSON.stringify({ artifact_id: "pr-1" }), new Date().toISOString(), new Date().toISOString());
    db.close();
    const failed = { turnId: "failed-turn", providerContinuationId: "thread", outcome: "failed" as const,
      text: null, evidence: "stream" as const, error: "HTTP 503 unavailable" };
    await options?.checkpointTerminalResult?.(failed);
    delivery.fence(); // Crash window: native failure is saved, child continuation does not yet exist.
    return failed;
  }), http, currentAuthority, 0);
  try {
    await ingest(store);
    await delivery.pump(agent);
    await delivery.fenceAndDrain(); await store.close();
    store = new SupervisedAgentInboxStore(path);
    const afterRestart = { ...agent, executionGenerationId: "generation-2", daemonGeneration: 2 };
    delivery = new SupervisedAgentDelivery(store, provider(async (handle, request, options) => {
      runs++;
      assert.equal(handle.providerContinuationId, "thread");
      assert.equal(request.activation.task_continuity !== undefined, true);
      assert.equal(await readFile(join(root, "work.txt"), "utf8"), "partial implementation\n");
      const replay = await store.prepareEffect(effectRequest);
      assert.equal(replay.created, false);
      assert.equal(replay.effect.state, "completed");
      assert.deepEqual(replay.effect.result, { artifact_id: "pr-1" });
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.("new-continuation");
      await writeFile(join(root, "work.txt"), "partial implementation\nremaining implementation\n");
      return { turnId: "new-continuation", outcome: "reply", text: "Finished the existing task." };
    }, async () => { throw new Error("The failed native turn must never be replayed or reattached."); }), http, currentAuthority, 0);
    await delivery.pump(afterRestart);
    await delivery.pump(afterRestart);
    assert.equal(runs, 2);
    assert.equal(await readFile(join(root, "work.txt"), "utf8"), "partial implementation\nremaining implementation\n");
    assert.equal((await store.cursor(agent.agentId))?.last_observed_message_id, "1");
    const receipts = await store.receipts(agent.agentId);
    assert.deepEqual(receipts.map(r => r.state), ["acknowledged_failed", "acknowledged"]);
    assert.equal((await store.taskContinuation(receipts[1]!.inbox_item_id))?.agentSessionId, "session-1");
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("recovering a failed turn under a replacement worker session cannot inherit its task", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-recovered-owner-"));
  const path = join(root, "state.sqlite"); let store = new SupervisedAgentInboxStore(path);
  let nativeStarts = 0; let ownershipReads = 0;
  const http = { poll: async () => ({}), publish: async () => {},
    ownedTasks: async () => { ownershipReads++; return [continuityTask]; } };
  let delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.(); nativeStarts++;
    await options?.checkpointTurnStarted?.("old-turn");
    delivery.fence();
    return { turnId: "old-turn", outcome: "unreadable", text: null, evidence: "none" };
  }), http, currentAuthority, 0);
  try {
    await ingest(store); await delivery.pump(agent);
    await delivery.fenceAndDrain(); await store.close(); store = new SupervisedAgentInboxStore(path);
    delivery = new SupervisedAgentDelivery(store, provider(async () => {
      nativeStarts++; throw new Error("must not run another native turn");
    }, async () => ({ turnId: "old-turn", providerContinuationId: "thread", outcome: "failed", text: null,
      evidence: "transcript", error: "HTTP 503" })), http, currentAuthority, 0);
    await delivery.pump({ ...agent, daemonGeneration: 2, executionGenerationId: "generation-2", agentSessionId: "replacement-worker" });
    assert.equal(nativeStarts, 1);
    assert.equal(ownershipReads, 0);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_failed");
    assert.equal(await store.head(agent.agentId), null);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("task continuity persists its delay and three-continuation budget across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-budget-"));
  const path = join(root, "state.sqlite");
  let now = Date.parse("2026-09-09T00:00:00Z");
  let store = new SupervisedAgentInboxStore(path, () => new Date(now).toISOString());
  let runs = 0;
  const port = provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.();
    const turnId = `failed-${++runs}`;
    await options?.checkpointTurnStarted?.(turnId);
    return { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", error: "HTTP 429 rate limit" };
  });
  const http = { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] };
  let delivery: SupervisedAgentDelivery;
  const makeDelivery = () => new SupervisedAgentDelivery(store, port, http, currentAuthority, 1, async () => {}, async () => { delivery.fence(); });
  delivery = makeDelivery();
  try {
    await ingest(store);
    for (let expected = 1; expected <= 4; expected++) {
      await delivery.pump({ ...agent, daemonGeneration: expected });
      assert.equal(runs, expected);
      const head = (await store.head(agent.agentId))!;
      if (expected < 4) {
        const delay = SHORT_FAULT_WAITS[expected - 1]!;
        assert.equal(head.next_attempt_at_ms, now + delay);
        await delivery.fenceAndDrain(); await store.close();
        store = new SupervisedAgentInboxStore(path, () => new Date(now).toISOString());
        assert.equal(await store.claimHead(agent.agentId), null, "restart cannot bypass the persisted due time");
        now += delay;
        delivery = makeDelivery();
      } else {
        assert.equal(head.state, "blocked");
        assert.equal(head.last_error, STOPPED_AFTER_THREE);
        await delivery.pump(agent);
        assert.equal(runs, 4, "the original turn plus three automatic continuations is the hard bound");
      }
    }
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [error, explanation] of [["HTTP 402 insufficient credits", /credit/], ["HTTP 401 unauthorized", /authentication/],
  ["HTTP 429 insufficient_quota", /credit/], ["Unclassified native failure", /could not be established/]] as const) {
  test(`task continuity pauses ${error} and resumes existing work through Retry delivery`, async () => {
    const root = await mkdtemp(join(tmpdir(), "continuity-account-"));
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    let runs = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      const turnId = `turn-${++runs}`;
      await options?.checkpointTurnStarted?.(turnId);
      return runs === 1 ? { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", error }
        : { turnId, outcome: "no_reply", text: null };
    }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] }, currentAuthority, 0);
    try {
      await ingest(store); await delivery.pump(agent);
      const head = (await store.head(agent.agentId))!;
      assert.equal(runs, 1); assert.equal(head.state, "blocked");
      assert.match(head.last_error!, explanation); assert.match(head.last_error!, /Retry delivery/);
      await store.retryBlocked(head.inbox_item_id); await delivery.pump(agent);
      assert.equal(runs, 2);
      assert.equal(await store.head(agent.agentId), null);
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("continuation survives an unavailable ownership snapshot and drops only tasks no longer owned", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-snapshot-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const second = { ...continuityTask, id: "task_2", leaseId: "lease-2" };
  let owned = [continuityTask, second]; let unavailable = true; let runs = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const turnId = `turn-${++runs}`;
    await options?.checkpointTurnStarted?.(turnId);
    if (runs === 1) return { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", error: "HTTP 503" };
    assert.match(JSON.stringify(request.sourceMessage), /task_2/);
    assert.doesNotMatch(JSON.stringify(request.sourceMessage), /task_1/);
    return { turnId, outcome: "no_reply", text: null };
  }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async input => {
    assert.ok(input.heldBefore);
    if (unavailable) throw new Error("room offline");
    return owned;
  } }, currentAuthority, 0);
  try {
    await ingest(store); await delivery.pump(agent);
    const head = (await store.head(agent.agentId))!;
    assert.equal((await store.taskContinuation(head.inbox_item_id))?.tasks, null);
    unavailable = false;
    await store.retryBlocked(head.inbox_item_id);
    await store.refreshTaskContinuationSnapshot(head.inbox_item_id, owned);
    owned = [second];
    await delivery.pump(agent);
    assert.equal(runs, 2);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

for (const changed of ["session", "workAttempt", "conversation", "lease", "epoch", "finished", "agentInstance"] as const) {
  test(`task continuity refuses changed ${changed} after restart`, async () => {
    const root = await mkdtemp(join(tmpdir(), "continuity-owner-"));
    const path = join(root, "state.sqlite"); let store = new SupervisedAgentInboxStore(path);
    let runs = 0; let owned = [continuityTask];
    const port = provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.(); runs++;
      await options?.checkpointTurnStarted?.("failed");
      return { turnId: "failed", providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", error: "HTTP 402" };
    });
    const http = { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => owned };
    let delivery = new SupervisedAgentDelivery(store, port, http, currentAuthority, 0);
    try {
      await ingest(store); await delivery.pump(agent);
      const head = (await store.head(agent.agentId))!;
      await store.retryBlocked(head.inbox_item_id);
      await delivery.fenceAndDrain(); await store.close(); store = new SupervisedAgentInboxStore(path);
      if (changed === "lease") owned = [{ ...continuityTask, leaseId: "new-lease" }];
      if (changed === "epoch") owned = [{ ...continuityTask, epoch: 3 }];
      if (changed === "finished") owned = [];
      const nextAgent = { ...agent,
        ...(changed === "session" ? { agentSessionId: "session-2" } : {}),
        ...(changed === "workAttempt" ? { workAttemptId: "attempt-2" } : {}),
        ...(changed === "conversation" ? { providerContinuationId: "thread-2" } : {}),
        ...(changed === "agentInstance" ? { agentId: "another-stone" } : {}) };
      delivery = new SupervisedAgentDelivery(store, port, http, currentAuthority, 0);
      await delivery.pump(nextAgent);
      assert.equal(runs, 1);
      owned = [{ ...continuityTask, id: "task-new" }];
      await delivery.pump(nextAgent);
      assert.equal(runs, 1, "an old failure cannot acquire subsequently assigned work");
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("an uncertain mutation prevents automatic continuation across restart without blocking new instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-uncertain-"));
  const path = join(root, "state.sqlite"); let store = new SupervisedAgentInboxStore(path);
  let runs = 0;
  const port = provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.(); runs++;
    await options?.checkpointTurnStarted?.("failed");
    const db = new DatabaseSync(path);
    db.prepare(`INSERT INTO supervised_agent_effects
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      VALUES ('effect',?,?,?,'failed','request','publish_room_artifact','{}',1,'executing',NULL,NULL,?,?)`)
      .run(agent.agentId, agent.roomId, "generation-1", new Date().toISOString(), new Date().toISOString()); db.close();
    return { turnId: "failed", providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", error: "HTTP 503" };
  });
  const http = { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] };
  let delivery = new SupervisedAgentDelivery(store, port, http, currentAuthority, 0);
  try {
    await ingest(store); await delivery.pump(agent);
    assert.equal(await store.head(agent.agentId), null);
    const receipt = (await store.receipts(agent.agentId))[0]!;
    assert.equal(receipt.state, "acknowledged_failed"); assert.match(receipt.last_error!, /uncertain result/);
    await delivery.fenceAndDrain(); await store.close(); store = new SupervisedAgentInboxStore(path);
    delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.(); runs++;
      await options?.checkpointTurnStarted?.("human-follow-up");
      return { turnId: "human-follow-up", outcome: "no_reply", text: null };
    }), http, currentAuthority, 0);
    await delivery.pump(agent);
    assert.equal(runs, 1);
    await ingest(store, "2"); await delivery.pump(agent);
    assert.equal(runs, 2, "the uncertain result cannot silently replay work or deadlock later human instructions");
    assert.equal(await store.head(agent.agentId), null);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("supervised reply targets inherit true threads but not top-level quote replies", () => {
  assert.deepEqual(
    supervisedReplyTargetForSourceMessage({
      id: "msg_45",
      reply_to: { id: "msg_44" },
      thread_root_id: "msg_44",
      thread: { root_message_id: "msg_44", is_thread_reply: true },
    }),
    { replyTo: "msg_45", threadRootId: "msg_44" },
  );
  assert.deepEqual(
    supervisedReplyTargetForSourceMessage({
      id: "msg_49",
      reply_to: { id: "msg_48" },
      thread_root_id: "msg_49",
      thread: { root_message_id: "msg_49", is_thread_reply: false },
    }),
    { replyTo: null, threadRootId: null },
  );
});

async function recordThreadIntent(path: string, store: SupervisedAgentInboxStore, turnId: string): Promise<void> {
  const manifest = new ManifestStore(path);
  try {
    const loaded = await manifest.load();
    await manifest.write(loaded.generation, [{
      id: agent.agentId, room_id: agent.roomId, display_name: "Stone", provider: "codex", model: null,
      charter: "test", desired_state: "running", observed_state: "working", condition: "none",
      permission_profile_id: null, delivery_mode: "daemon_inbox", provider_launch_policy: {}, created_by: "test",
      created_at: new Date().toISOString(), work_attempt_id: agent.workAttemptId,
      provider_ref: { work_attempt_id: agent.workAttemptId, execution_generation_id: agent.executionGenerationId,
        provider_continuation_id: agent.providerContinuationId, provider_connection: agent.providerConnection },
    }]);
  } finally { await manifest.close(); }
  const intent = await store.prepareEffect({ agent_id: agent.agentId, room_id: agent.roomId,
    execution_generation_id: agent.executionGenerationId, current_execution_generation_id: agent.executionGenerationId,
    provider_turn_id: turnId, provider_continuation_id: agent.providerContinuationId, work_attempt_id: agent.workAttemptId,
    mcp_request_id: "thread-choice", tool_name: "set_reply_thread", request: {}, mutation: true });
  assert.equal(intent.effect.state, "completed");
}

test("an intercepted thread choice survives publication failure and restart without another provider turn", async () => {
  for (const { toolName, effectState, existingRoot } of [
    ...["send_thread_message", "send_message"].flatMap(toolName => ["prepared", "failed"].map(effectState => ({ toolName, effectState, existingRoot: null }))),
    { toolName: "set_reply_thread", effectState: "completed", existingRoot: null },
    { toolName: "set_reply_thread", effectState: "completed", existingRoot: "msg_70" },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "letagents-thread-intent-"));
    const path = join(root, "state.sqlite");
    let store = new SupervisedAgentInboxStore(path);
    let runs = 0;
    let ownsLane = true;
    const publications: Array<{ clientMessageId: string; replyTo: string | null; threadRootId: string | null }> = [];
    const http = {
      poll: async () => ({}),
      publish: async (input: { clientMessageId: string; roomId: string; replyTo: string | null; threadRootId: string | null }) => {
        publications.push({ clientMessageId: input.clientMessageId, replyTo: input.replyTo, threadRootId: input.threadRootId });
        if (publications.length === 1) { ownsLane = false; throw new Error("publication acknowledgement lost during handoff"); }
        return { messageId: "published", roomId: input.roomId };
      },
    };
    let delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      runs++;
      await options?.checkpointTurnStarted?.("native-turn");
      if (toolName === "set_reply_thread") {
        await recordThreadIntent(path, store, "native-turn");
      } else {
        // The coordinator retains the intercepted request before returning USE_FINAL_ANSWER.
        const db = new DatabaseSync(path);
        try {
          db.prepare(`INSERT INTO supervised_agent_effects
            (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
            VALUES ('thread-choice',?,?,?,'native-turn','request',?,?,1,?,NULL,NULL,?,?)`)
            .run(agent.agentId, agent.roomId, "generation-1", toolName,
              JSON.stringify({ thread_parent_id: "msg_72", text: "draft" }), effectState, new Date().toISOString(), new Date().toISOString());
        } finally { db.close(); }
      }
      return { turnId: "native-turn", outcome: "reply", text: "final answer" };
    }), http, async () => ownsLane, 0);
    try {
      await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: "msg_72",
        messages: [{ source_message_id: "msg_72", source_message: { id: "msg_72", thread_root_id: existingRoot }, activation: {} }] });
      await delivery.pump(agent);
      assert.equal(publications.length, 1);
      assert.deepEqual(publications[0], {
        clientMessageId: "supervised-room:stone:room:msg_72:reply:v1", replyTo: "msg_72", threadRootId: existingRoot ?? "msg_72",
      });
      await delivery.fenceAndDrain(); await store.close();
      store = new SupervisedAgentInboxStore(path);
      ownsLane = true;
      delivery = new SupervisedAgentDelivery(store, provider(async () => {
        runs++; throw new Error("must not rerun the provider");
      }), http, currentAuthority, 0);
      await delivery.pump(agent);
      assert.equal(runs, 1);
      assert.deepEqual(publications, [publications[0], publications[0]]);
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("unrelated or non-thread message effects cannot redirect the daemon's activating reply", async () => {
  for (const variation of ["agent", "room", "generation", "turn", "parent", "quote", "tool", "executing", "completed", "uncertain"] as const) {
    const root = await mkdtemp(join(tmpdir(), "letagents-thread-fence-"));
    const path = join(root, "state.sqlite");
    const store = new SupervisedAgentInboxStore(path);
    let published = false;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.checkpointTurnStarted?.("native-turn");
      const db = new DatabaseSync(path);
      try {
        db.prepare(`INSERT INTO supervised_agent_effects
          (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
          VALUES ('other-effect',?,?,?,?,'request',?,?,1,?,NULL,NULL,?,?)`)
          .run(variation === "agent" ? "other-agent" : agent.agentId,
            variation === "room" ? "other-room" : agent.roomId,
            variation === "generation" ? "old-generation" : "generation-1",
            variation === "turn" ? "other-turn" : "native-turn",
            variation === "tool" ? "publish_room_artifact" : "send_message",
            JSON.stringify(variation === "quote" ? { reply_to: "msg_72" }
              : { thread_parent_id: variation === "parent" ? "msg_71" : "msg_72" }),
            ["executing", "completed", "uncertain"].includes(variation) ? variation : "prepared",
            new Date().toISOString(), new Date().toISOString());
      } finally { db.close(); }
      return { turnId: "native-turn", outcome: "reply", text: "final answer" };
    }), {
      poll: async () => ({}),
      publish: async input => {
        assert.equal(input.replyTo, null, variation);
        assert.equal(input.threadRootId, null, variation);
        published = true;
        return { messageId: "published", roomId: input.roomId };
      },
    }, currentAuthority, 0);
    try {
      await ingest(store, "msg_72"); await delivery.pump(agent);
      assert.equal(published, true, variation);
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("worker-authenticated activation ingress deduplicates replay and publishes one bounded reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const polls: unknown[] = [];
    const published: Array<{ clientMessageId: string; replyTo: string | null; threadRootId: string | null }> = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => ({ turnId: `turn:${request.inboxItemId}`, outcome: "reply", text: "hello" })), {
      poll: async (input) => { polls.push(input); return { messages: [{ id: "1", thread_root_id: "root", thread: { root_message_id: "root", is_thread_reply: true }, activation: { for_current_agent: { decision: "activate", reason: "server" } }, text: "hi" }, { id: "2", text: "ignored" }] }; },
      publish: async (input) => {
        published.push({ clientMessageId: input.clientMessageId, replyTo: input.replyTo, threadRootId: input.threadRootId });
        return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId };
      },
    }, currentAuthority, 0);
    await delivery.poll(agent); await new Promise((resolve) => setTimeout(resolve, 5));
    await delivery.poll(agent); await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(polls.length, 2);
    assert.equal((await store.receipts("stone")).length, 1);
    assert.deepEqual(published, [{
      clientMessageId: "supervised-room:stone:room:1:reply:v1",
      replyTo: "1",
      threadRootId: "root",
    }]);
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

test("bounded room turns never resolve or inject the legacy charter", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-charter-refresh-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let resolverCalls = 0;
  const seen: Array<{ source: unknown; hasCharter: boolean }> = [];
  const delivery = new SupervisedAgentDelivery(
    store,
    provider(async (_handle, request) => {
      seen.push({ source: request.sourceMessage, hasCharter: Object.hasOwn(request, "charter") });
      return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
    }),
    { poll: async () => ({}), publish: async () => { throw new Error("no-reply turn must not publish"); } },
    currentAuthority,
    0,
    undefined,
    undefined,
    undefined,
    async () => { resolverCalls += 1; return { charter: "must never be injected" }; },
  );
  try {
    await ingest(store, "1");
    await delivery.pump(agent);
    await ingest(store, "2");
    await delivery.pump(agent);
    assert.equal(resolverCalls, 0);
    assert.deepEqual(seen.map((turn) => turn.hasCharter), [false, false]);
    assert.deepEqual(seen.map((turn) => (turn.source as { id?: string }).id), ["1", "2"]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

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

async function writeAgentRuntime(path: string, providerContinuationId: string): Promise<void> {
  const manifest = new ManifestStore(path);
  try {
    const loaded = await manifest.load();
    await manifest.write(loaded.generation, [{
      id: agent.agentId, room_id: agent.roomId, display_name: "Stone", provider: "codex", model: null,
      charter: "test", desired_state: "running", observed_state: "working", condition: "none",
      permission_profile_id: null, delivery_mode: "daemon_inbox", provider_launch_policy: {}, created_by: "test",
      created_at: new Date().toISOString(), work_attempt_id: agent.workAttemptId,
      provider_ref: { work_attempt_id: agent.workAttemptId, execution_generation_id: agent.executionGenerationId,
        provider_continuation_id: providerContinuationId, provider_connection: agent.providerConnection },
    }]);
  } finally { await manifest.close(); }
}

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
    assert.match(receipt.timeline.at(-1)!.detail ?? "", /re-read and was not rerun/);
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

for (const phase of ["preflight", "admitted"] as const) {
  test(`duplicate same-owner start preserves Codex ${phase} and publishes exactly once`, async () => {
    const root = await mkdtemp(join(tmpdir(), "letagents-delivery-duplicate-start-"));
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    const release = deferred<void>();
    let calls = 0; let recovered = 0; let published = 0; let normalizations = 0; let entered = false;
    let turnSignal: AbortSignal | undefined;
    const normalize = store.normalizeStartupRecovery.bind(store);
    store.normalizeStartupRecovery = async (...args) => { normalizations += 1; return normalize(...args); };
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      calls += 1;
      turnSignal = options?.detachSignal;
      if (phase === "admitted") {
        await options?.beforeNativeDispatch?.();
        await options?.checkpointTurnStarted?.("turn:one");
      }
      entered = true;
      await Promise.race([release.promise, new Promise<void>(resolve => {
        options?.detachSignal?.addEventListener("abort", () => resolve(), { once: true });
      })]);
      if (options?.detachSignal?.aborted) throw new Error("delivery detached during preflight");
      if (phase === "preflight") {
        await options?.beforeNativeDispatch?.();
        await options?.checkpointTurnStarted?.("turn:one");
      }
      return { turnId: "turn:one", outcome: "reply", text: "Ready." };
    }, async () => { recovered += 1; return { turnId: "turn:one", outcome: "unreadable", text: null }; }), {
      poll: ({ signal }) => new Promise(resolve => {
        if (signal.aborted) resolve({});
        else signal.addEventListener("abort", () => resolve({}), { once: true });
      }),
      publish: async input => { published += 1; return { messageId: "reply:one", roomId: input.roomId }; },
    }, currentAuthority);
    try {
      await ingest(store);
      await delivery.start(agent);
      await waitFor(() => entered);
      const duplicate = delivery.refresh({ ...agent });
      await Promise.race([duplicate, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("duplicate start did not settle")), 1000))]);
      await delivery.refresh({ ...agent });
      assert.equal(turnSignal?.aborted, false, "duplicate readiness must not detach the existing turn");
      assert.equal(normalizations, 1, "a live owner must not be mistaken for crash recovery");
      release.resolve();
      await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged");
      assert.equal(calls, 1); assert.equal(recovered, 0); assert.equal(published, 1);
    } finally {
      release.resolve(); await delivery.fenceAndDrain(); await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("refresh still replaces changed ownership, including provider-less lanes, but adopts a rotated bearer in place", async (t) => {
  for (const coordinate of ["handle", "agentSessionId", "executionGenerationId", "daemonGeneration", "bearer", "no-provider-api", "no-provider-workspace"] as const) {
    await t.test(coordinate, async () => {
      const root = await mkdtemp(join(tmpdir(), "letagents-delivery-owner-change-"));
      const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
      const original = { ...agent, handle: coordinate.startsWith("no-provider") ? null : agent.handle };
      const pollSignals: AbortSignal[] = [];
      const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("no work queued"); }), {
        poll: ({ signal }) => new Promise(resolve => {
          pollSignals.push(signal);
          if (signal.aborted) resolve({});
          else signal.addEventListener("abort", () => resolve({}), { once: true });
        }),
        publish: async () => { throw new Error("no reply expected"); },
      }, currentAuthority);
      try {
        await delivery.start(original);
        await waitFor(() => pollSignals.length === 1);
        if (coordinate === "handle") original.handle = { ...agent.handle };
        if (coordinate === "agentSessionId") original.agentSessionId = "new-worker";
        if (coordinate === "executionGenerationId") original.executionGenerationId = "new-execution";
        if (coordinate === "daemonGeneration") original.daemonGeneration = 2;
        if (coordinate === "bearer") original.bearer = "rotated-memory-only-token";
        if (coordinate === "no-provider-api") original.apiUrl = "https://other.letagents.test";
        if (coordinate === "no-provider-workspace") original.workAttemptId = "new-attempt";
        await delivery.refresh(original);
        if (coordinate === "bearer") {
          // Same worker session, new memory-only bearer: the lane is kept.
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(pollSignals.length, 1, "a rotated bearer of the same session keeps the registered lane");
          assert.equal(pollSignals[0]?.aborted, false);
          await delivery.refresh({ ...original });
          assert.equal(pollSignals.length, 1, "the rotated owner is idempotent too");
          return;
        }
        await waitFor(() => pollSignals.length === 2);
        assert.equal(pollSignals[0]?.aborted, true, "changed owner must retire the registered lane");
        assert.equal(pollSignals[1]?.aborted, false);
        await delivery.refresh({ ...original });
        assert.equal(pollSignals.length, 2, "the new exact owner is idempotent too");
      } finally {
        await delivery.fenceAndDrain(); await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a same-session bearer rotation keeps the in-flight turn, its approvals and the pump; a new session still tears down", async (t) => {
  for (const change of ["rotation", "new-session", "stale-bearer"] as const) {
    await t.test(change, async () => {
      const root = await mkdtemp(join(tmpdir(), "letagents-delivery-rotation-"));
      const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
      let currentBearer = "bearer-before";
      let authorityGate: Promise<void> = Promise.resolve();
      const entered = deferred<void>();
      const release = deferred<{ turnId: string; outcome: "reply"; text: string }>();
      let detachSignal: AbortSignal | undefined;
      const publishedWith: string[] = [];
      const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
        await options?.beforeNativeDispatch?.();
        await options?.checkpointTurnStarted?.("turn:rotation");
        detachSignal = options?.detachSignal;
        entered.resolve();
        return release.promise;
      }), {
        poll: ({ signal }) => new Promise((resolve) => {
          if (signal.aborted) resolve({});
          else signal.addEventListener("abort", () => resolve({}), { once: true });
        }),
        publish: async (input) => {
          publishedWith.push(input.bearer);
          return { messageId: "reply:rotation", roomId: input.roomId };
        },
      }, async (authority) => { await authorityGate; return authority.bearer === currentBearer; });
      const before = { ...agent, bearer: "bearer-before" };
      try {
        await ingest(store);
        await delivery.start(before);
        await entered.promise;
        const successor = change === "rotation"
          ? { ...agent, bearer: "bearer-after" }
          : change === "stale-bearer"
            // Same session, but not the bearer the binding now holds.
            ? { ...agent, bearer: "bearer-stale" }
            : { ...agent, agentSessionId: "session-2", bearer: "bearer-after" };
        currentBearer = "bearer-after";
        const gate = deferred<void>();
        authorityGate = gate.promise;
        const refreshed = delivery.refresh(successor);
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (change === "rotation") {
          assert.equal(delivery.activeTurn(successor)?.inboxItemId !== undefined, true,
            "an approval arriving during the rotation still matches the bounded turn");
        }
        gate.resolve();
        authorityGate = Promise.resolve();
        await refreshed;
        if (change !== "rotation") {
          assert.equal(detachSignal?.aborted, true, change === "new-session"
            ? "a different worker session still replaces the lane"
            : "a bearer the binding no longer holds is never adopted");
          return;
        }
        assert.equal(detachSignal?.aborted, false, "rotation never detaches the in-flight provider turn");
        assert.ok(delivery.activeTurn(successor), "the active turn survives for approvals and bounded effects");
        assert.notEqual((await store.ingressHealth(agent.agentId))?.state, "stopped");
        release.resolve({ turnId: "turn:rotation", outcome: "reply", text: "Done." });
        await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged");
        assert.deepEqual(publishedWith, ["bearer-after"], "the live turn publishes with the rotated bearer");
        const timeline = (await store.receipts(agent.agentId))[0]!.timeline;
        assert.equal(timeline.filter((event) => event.phase === "queued").length, 1,
          "no restart recovery was written onto the in-flight row");
        assert.equal(timeline.some((event) => /restarted/i.test(event.detail ?? "")), false);
      } finally {
        authorityGate = Promise.resolve();
        release.resolve({ turnId: "turn:rotation", outcome: "reply", text: "cleanup" });
        await delivery.fenceAndDrain(); await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a turn that ends before delivery adopts a rotated bearer is recovered instead of stranding the FIFO", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-rotation-window-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  let currentBearer = "bearer-before";
  const entered = deferred<void>();
  const release = deferred<{ turnId: string; outcome: "reply"; text: string }>();
  const publishedWith: string[] = [];
  let recovers = 0;
  let runError = "";
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("turn:rotation");
    entered.resolve();
    const raw = await release.promise;
    try { return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw; }
    catch (error) { runError = String(error); throw error; }
  }, async (_handle, _request, options) => {
    recovers += 1;
    const raw = { turnId: "turn:rotation", outcome: "reply" as const, text: "Done." };
    return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw;
  }), {
    poll: ({ signal }) => new Promise((resolve) => {
      if (signal.aborted) resolve({});
      else signal.addEventListener("abort", () => resolve({}), { once: true });
    }),
    publish: async (input) => {
      publishedWith.push(input.bearer);
      return { messageId: "reply:rotation", roomId: input.roomId };
    },
  }, async (authority) => authority.bearer === currentBearer);
  try {
    await ingest(store);
    await delivery.start({ ...agent, bearer: "bearer-before" });
    await entered.promise;
    // The binding rotates before delivery hears of it, and the turn ends then.
    currentBearer = "bearer-after";
    release.resolve({ turnId: "turn:rotation", outcome: "reply", text: "Done." });
    await waitFor(() => runError !== "");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching",
      "the revoked bearer could not record the result, so the row has no owner");
    await delivery.refresh({ ...agent, bearer: "bearer-after" });
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged", 3_000);
    assert.deepEqual(publishedWith, ["bearer-after"]);
    assert.equal(recovers, 1, "the saved turn is re-read once and never rerun");
  } finally {
    release.resolve({ turnId: "turn:rotation", outcome: "reply", text: "cleanup" });
    await delivery.fenceAndDrain(); await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an older rotation that finishes its authority check last cannot replace a newer adopted bearer", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-rotation-order-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const entered = deferred<void>();
  const release = deferred<{ turnId: string; outcome: "reply"; text: string }>();
  const firstCheck = deferred<void>();
  let detachSignal: AbortSignal | undefined;
  const publishedWith: string[] = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("turn:rotation-order");
    detachSignal = options?.detachSignal;
    entered.resolve();
    return release.promise;
  }), {
    poll: ({ signal }) => new Promise((resolve) => {
      if (signal.aborted) resolve({});
      else signal.addEventListener("abort", () => resolve({}), { once: true });
    }),
    publish: async (input) => {
      publishedWith.push(input.bearer);
      return { messageId: "reply:rotation-order", roomId: input.roomId };
    },
  }, async (authority) => {
    // The first rotation's check passed before the second rotation landed.
    if (authority.bearer === "bearer-1") await firstCheck.promise;
    return ["bearer-before", "bearer-1", "bearer-2"].includes(authority.bearer);
  });
  try {
    await ingest(store);
    await delivery.start({ ...agent, bearer: "bearer-before" });
    await entered.promise;
    const older = delivery.refresh({ ...agent, bearer: "bearer-1" });
    await delivery.refresh({ ...agent, bearer: "bearer-2" });
    firstCheck.resolve();
    await older;
    assert.equal(detachSignal?.aborted, false);
    release.resolve({ turnId: "turn:rotation-order", outcome: "reply", text: "Done." });
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged");
    assert.deepEqual(publishedWith, ["bearer-2"], "the newest rotation's bearer stays adopted");
  } finally {
    firstCheck.resolve();
    release.resolve({ turnId: "turn:rotation-order", outcome: "reply", text: "cleanup" });
    await delivery.fenceAndDrain(); await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stop or ingress pause during a refresh's authority check is not undone by that refresh", async (t) => {
  for (const interruption of ["stop", "pause"] as const) {
    await t.test(interruption, async () => {
      const root = await mkdtemp(join(tmpdir(), "letagents-delivery-refresh-interrupted-"));
      const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
      const pollSignals: AbortSignal[] = [];
      const checking = deferred<void>();
      const gate = deferred<void>();
      const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("no work queued"); }), {
        poll: ({ signal }) => new Promise((resolve) => {
          pollSignals.push(signal);
          if (signal.aborted) resolve({});
          else signal.addEventListener("abort", () => resolve({}), { once: true });
        }),
        publish: async () => { throw new Error("no reply expected"); },
      }, async (authority) => {
        if (authority.bearer === "bearer-after") { checking.resolve(); await gate.promise; }
        return true;
      });
      try {
        await delivery.start({ ...agent, bearer: "bearer-before" });
        await waitFor(() => pollSignals.length === 1);
        const refreshed = delivery.refresh({ ...agent, bearer: "bearer-after" });
        await checking.promise;
        const interrupted = interruption === "stop" ? delivery.stop(agent.agentId) : delivery.pauseIngress(agent.agentId);
        gate.resolve();
        await refreshed; await interrupted;
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(pollSignals.length, 1, `the ${interruption} owns the lane; the stale refresh must not restart it`);
        assert.equal(pollSignals[0]?.aborted, true);
      } finally {
        gate.resolve();
        await delivery.fenceAndDrain(); await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a task ownership lookup revoked by a same-session rotation is retried with the adopted bearer", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-rotation-lookup-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  let currentBearer = "bearer-before";
  let runs = 0;
  let completed = false;
  const lookups: string[] = [];
  const lookupInFlight = deferred<void>();
  const rotated = deferred<void>();
  const task = { id: "task_1", title: "Finish the existing change", leaseId: "lease-1", epoch: 0 };
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    runs += 1;
    await options?.beforeNativeDispatch?.();
    const turnId = `turn-${runs}`;
    await options?.checkpointTurnStarted?.(turnId);
    if (runs === 1) {
      return { turnId, providerContinuationId: "thread", outcome: "failed", text: null,
        evidence: "stream", error: "HTTP 503 Service Unavailable" };
    }
    completed = true;
    return { turnId, outcome: "reply", text: "The remaining work is finished." };
  }), {
    poll: ({ signal }) => new Promise((resolve) => {
      if (signal.aborted) resolve({});
      else signal.addEventListener("abort", () => resolve({}), { once: true });
    }),
    ownedTasks: async (input) => {
      lookups.push(input.bearer);
      if (input.bearer === "bearer-before") {
        lookupInFlight.resolve();
        await rotated.promise;
        throw new Error("HTTP 401 Unauthorized");
      }
      return completed ? [] : [task];
    },
    publish: async () => ({ roomId: agent.roomId, messageId: "msg_2" }),
  }, async (authority) => authority.bearer === currentBearer, 0, async () => {});
  try {
    await ingest(store);
    await delivery.start({ ...agent, bearer: "bearer-before" });
    await lookupInFlight.promise;
    currentBearer = "bearer-after";
    await delivery.refresh({ ...agent, bearer: "bearer-after" });
    rotated.resolve();
    await waitFor(() => completed, 3_000);
    assert.equal(runs, 2, "the unfinished task continues after the rotation");
    assert.deepEqual(lookups.slice(0, 2), ["bearer-before", "bearer-after"]);
    assert.equal((await store.receipts(agent.agentId)).some((receipt) => receipt.state === "blocked"), false);
  } finally {
    rotated.resolve();
    await delivery.fenceAndDrain(); await store.close();
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
    const ingest = store.ingestSuccessfulPoll.bind(store);
    (store as unknown as { ingestSuccessfulPoll(input: Parameters<typeof store.ingestSuccessfulPoll>[0]): ReturnType<typeof store.ingestSuccessfulPoll> }).ingestSuccessfulPoll = async (input) => {
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
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged_no_reply");
    assert.equal(turns, 1, "the stopped poll cannot launch a stale delivery pump after ingest");
    assert.equal(turnHandles[0], successor.handle, "only the successor context may run the recovered delivery turn");
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply", "successor recovery and delivery finish independently of its hanging poll");
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh joins a start paused in its health write before installing the successor loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-start-health-"));
  const releaseStarting = deferred<void>();
  let store: SupervisedAgentInboxStore | undefined;
  let delivery: SupervisedAgentDelivery | undefined;
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    await ingest(store, "1");
    const startingEntered = deferred<void>();
    const setIngressHealth = store.setIngressHealth.bind(store);
    let startingWrites = 0;
    (store as unknown as { setIngressHealth(input: Parameters<typeof store.setIngressHealth>[0]): ReturnType<typeof store.setIngressHealth> }).setIngressHealth = async (input) => {
      if (input.state === "starting" && startingWrites++ === 0) {
        startingEntered.resolve();
        await releaseStarting.promise;
      }
      return setIngressHealth(input);
    };
    const turnHandles: unknown[] = [];
    delivery = new SupervisedAgentDelivery(store, provider(async (handle) => {
      turnHandles.push(handle);
      return { turnId: `turn:${turnHandles.length}`, outcome: "no_reply", text: null };
    }), {
      poll: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true })),
      publish: async () => { throw new Error("no-reply must not publish"); },
    }, currentAuthority);

    const staleStart = delivery.start(agent);
    await startingEntered.promise;
    const internals = delivery as unknown as { loops: Map<string, Promise<void>>; loopEpochs: Map<string, number> };
    assert.equal(internals.loops.has(agent.agentId), true, "the paused startup is registered before its health write settles");
    assert.equal(internals.loopEpochs.get(agent.agentId), 0);

    const successor = { ...agent, executionGenerationId: "generation-successor", handle: { ...agent.handle, pid: 2 } };
    let refreshed = false;
    const refresh = delivery.refresh(successor).then(() => { refreshed = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(refreshed, false, "refresh must drain the registered stale startup before starting its successor");

    releaseStarting.resolve();
    await Promise.all([staleStart, refresh]);
    await waitForAsync(async () => (await store!.receipts(agent.agentId))[0]?.state === "acknowledged_no_reply");
    assert.deepEqual(turnHandles, [successor.handle], "only the successor handle may drain recovered FIFO work");
    assert.equal(internals.loops.has(agent.agentId), true, "the successor remains in its long poll");
    assert.equal(internals.loopEpochs.get(agent.agentId), 1, "the live loop belongs to the successor epoch");
  } finally {
    releaseStarting.resolve();
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("convergence ensure never joins or replaces a mismatched loop and fills the later absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-ensure-loop-"));
  let store: SupervisedAgentInboxStore | undefined;
  let delivery: SupervisedAgentDelivery | undefined;
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const pollBearers: string[] = [];
    const deliveryStarted = deferred<void>();
    const successorStarted = deferred<void>();
    delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      poll: ({ bearer, signal }) => new Promise((resolve) => {
        pollBearers.push(bearer);
        if (pollBearers.length === 1) deliveryStarted.resolve();
        if (pollBearers.length === 2) successorStarted.resolve();
        signal.addEventListener("abort", () => resolve({}), { once: true });
      }),
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);

    await delivery.start(agent);
    await deliveryStarted.promise;
    const internals = delivery as unknown as {
      loops: Map<string, Promise<void>>;
      loopEpochs: Map<string, number>;
      loopControllers: Map<string, AbortController>;
      refreshEpochs: Map<string, number>;
    };
    const existingLoop = internals.loops.get(agent.agentId);
    const existingController = internals.loopControllers.get(agent.agentId);
    assert.ok(existingLoop);
    assert.ok(existingController);
    assert.equal(internals.loopEpochs.get(agent.agentId), 0);

    // Model convergence observing an epoch that advanced while the lifecycle
    // owner is still draining the old loop under the same per-entry lock.
    internals.refreshEpochs.set(agent.agentId, 1);
    const successor = { ...agent, bearer: "successor-memory-token", executionGenerationId: "generation-successor" };
    await Promise.race([
      delivery.ensureStarted(successor),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("ensure joined the mismatched loop")), 100)),
    ]);
    assert.equal(internals.loops.get(agent.agentId), existingLoop, "ensure leaves the lifecycle-owned loop in place");
    assert.equal(internals.loopControllers.get(agent.agentId), existingController, "ensure does not replace its controller");
    assert.equal(existingController.signal.aborted, false, "ensure does not abort work owned by another lifecycle path");
    assert.deepEqual(pollBearers, [agent.bearer], "ensure cannot overlap the mismatched loop");

    await delivery.stop(agent.agentId);
    assert.equal(internals.loops.has(agent.agentId), false, "the lifecycle owner completes its own drain");
    await delivery.ensureStarted(successor);
    await successorStarted.promise;
    assert.deepEqual(pollBearers, [agent.bearer, successor.bearer], "a later convergence pass fills the genuine absence");
  } finally {
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent refreshes install only the newest epoch and its handle drains recovered FIFO work", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-refresh-epoch-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const ingestEntered = deferred<void>(); const releaseIngest = deferred<void>(); const currentPoll = deferred<void>();
    const ingest = store.ingestSuccessfulPoll.bind(store);
    (store as unknown as { ingestSuccessfulPoll(input: Parameters<typeof store.ingestSuccessfulPoll>[0]): ReturnType<typeof store.ingestSuccessfulPoll> }).ingestSuccessfulPoll = async (input) => {
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
    await waitForAsync(async () => (await store.receipts(agent.agentId)).every(item => item.state === "acknowledged_no_reply"));
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
    const ingest = store.ingestSuccessfulPoll.bind(store);
    (store as unknown as { ingestSuccessfulPoll(input: Parameters<typeof store.ingestSuccessfulPoll>[0]): ReturnType<typeof store.ingestSuccessfulPoll> }).ingestSuccessfulPoll = async (input) => {
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
    await store.checkpointTurnStarted(item.inbox_item_id, "turn", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(item.inbox_item_id, "awaiting_result", { outcome: JSON.stringify({ kind: "reply", text: "durable" }) });
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
      workerBindings: { bind(input: Record<string, string>): Promise<unknown> };
      store: ManifestStore;
      manifestGeneration: number;
      providerStreams: {
        install(
          entryId: string,
          handle: ProviderActionHandle,
          executionGenerationId: string,
          mayStartDelivery: () => boolean,
        ): Promise<void>;
      };
    };
    await daemon.start();
    await internals.putManifestEntry({
      id: "stone", room_id: "room", display_name: "Stone", provider: "codex", model: null, charter: "supervised test", desired_state: "running", observed_state: "working", condition: "none", permission_profile_id: null,
      delivery_mode: "daemon_inbox",
      created_by: "test", created_at: new Date().toISOString(), workspace_path: root, work_attempt_id: "attempt",
      provider_ref: { work_attempt_id: "attempt", provider_continuation_id: "thread", provider_connection: agent.providerConnection, execution_generation_id: "generation-1" },
    });
    const exactHandle = { ...agent.handle, appliedConfigurationRevision: 1 };
    await installExactTestProviderBirth(internals, "stone", exactHandle, "generation-1");
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
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.("turn:daemon-stop-live");
      entered.resolve();
      return late.promise;
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
      provider_ref: { work_attempt_id: agent.handle.workAttemptId, provider_continuation_id: agent.handle.providerContinuationId, provider_connection: agent.providerConnection, execution_generation_id: agent.executionGenerationId },
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

test("handoff drains a non-Cursor turn through its late exact checkpoint and the successor recovers it", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-late-turn-checkpoint-"));
  const lateResult = deferred<{ turnId: string; outcome: "no_reply"; text: null }>();
  const authorityCheckEntered = deferred<void>();
  const releaseAuthorityCheck = deferred<void>();
  let pauseAuthorityCheck = false;
  let store: SupervisedAgentInboxStore | undefined;
  let retiring: SupervisedAgentDelivery | undefined;
  let successor: SupervisedAgentDelivery | undefined;
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const claudeAgent = { ...agent, provider: "claude-code" };
    retiring = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      pauseAuthorityCheck = true;
      await options?.checkpointTurnStarted?.("claude:late-durable-turn");
      return lateResult.promise;
    }), {
      poll: async () => ({}),
      publish: async () => { throw new Error("must not publish"); },
    }, async () => {
      if (pauseAuthorityCheck) {
        authorityCheckEntered.resolve();
        await releaseAuthorityCheck.promise;
      }
      return true;
    });
    await retiring.pump(claudeAgent);
    await ingest(store);
    const pump = retiring.pump(claudeAgent);
    await authorityCheckEntered.promise;

    let drained = false;
    const drain = retiring.fenceAndDrain().then(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false, "retirement waits while the admitted provider turn has no durable recovery key");

    releaseAuthorityCheck.resolve();
    await Promise.all([drain, pump]);
    const interrupted = (await store.receipts(claudeAgent.agentId))[0]!;
    assert.equal(interrupted.state, "dispatching");
    assert.equal(interrupted.provider_turn_id, "claude:late-durable-turn");
    await store.normalizeStartupRecovery(claudeAgent.agentId);
    assert.equal((await store.receipts(claudeAgent.agentId))[0]?.state, "pending");

    const recoveredTurns: string[] = [];
    successor = new SupervisedAgentDelivery(store, provider(
      async () => { throw new Error("the successor must not redispatch a new model turn"); },
      async (_handle, request) => {
        recoveredTurns.push(request.providerTurnId);
        return { turnId: request.providerTurnId, outcome: "no_reply", text: null };
      },
    ), {
      poll: async () => ({}),
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);
    await successor.pump(claudeAgent);
    assert.deepEqual(recoveredTurns, ["claude:late-durable-turn"]);
    assert.equal((await store.receipts(claudeAgent.agentId))[0]?.state, "acknowledged_no_reply");
  } finally {
    releaseAuthorityCheck.resolve();
    lateResult.resolve({ turnId: "claude:late-durable-turn", outcome: "no_reply", text: null });
    await successor?.fenceAndDrain().catch(() => undefined);
    await retiring?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff waits for pre-native provider cleanup before releasing the delivery drain", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-pre-native-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const cursorAgent = { ...agent, provider: "cursor" };
    const entered = deferred<void>();
    const cleanupStarted = deferred<void>();
    const releaseCleanup = deferred<void>();
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      entered.resolve();
      await new Promise<void>((resolve) => {
        const detach = () => {
          cleanupStarted.resolve();
          void releaseCleanup.promise.then(resolve);
        };
        if (options?.detachSignal?.aborted) detach();
        else options?.detachSignal?.addEventListener("abort", detach, { once: true });
      });
      throw Object.assign(
        new Error("pre-native provider cleanup completed after handoff"),
        { roomTurnRecoveryOutcome: "not_dispatched" as const },
      );
    }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await delivery.pump(cursorAgent); await ingest(store);
    const pump = delivery.pump(cursorAgent); await entered.promise;

    let drained = false;
    const drain = delivery.fenceAndDrain().then(() => { drained = true; });
    await cleanupStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false, "handoff cannot release authority while pre-native cleanup is incomplete");

    releaseCleanup.resolve();
    await drain; await pump;
    assert.equal(
      (await store.receipts(cursorAgent.agentId))[0]?.state,
      "pending",
      "proven-not-dispatched handoff cleanup returns the FIFO head to pending",
    );
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cursor Stop and handoff retain an atomically prepared turn until idle compensation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-prepared-retirement-"));
  try {
    for (const retirement of ["stop", "handoff"] as const) {
      const store = new SupervisedAgentInboxStore(join(root, `${retirement}.sqlite`));
      const recordCompletion = installCursorCompletionProjectionFixture(store);
      let continuation = `cursor-pending:${retirement}`;
      let connection = { kind: "cursor_cli" as const, pid: null as number | null, processIdentity: null as string | null };
      const cursorAgent = {
        ...agent,
        provider: "cursor",
        providerContinuationId: continuation,
        providerConnection: connection,
        handle: {
          workAttemptId: agent.workAttemptId,
          get pid() { return connection.pid; },
          get providerContinuationId() { return continuation; },
          get providerConnection() { return connection; },
          observedState: "idle" as const,
        },
      };
      const prepared = deferred<void>();
      const exactTurnId = `cursor:prepared:${retirement}`;
      const retiring = new SupervisedAgentDelivery(
        store,
        provider(async (_handle, _request, options) => {
          await options?.beforeNativeDispatch?.();
          connection = { kind: "cursor_cli", pid: retirement === "stop" ? 91_001 : 91_002, processIdentity: `wrapper:${retirement}` };
          await options?.checkpointPreparedTurn?.({
            providerTurnId: exactTurnId,
            providerContinuationId: continuation,
            providerConnection: connection,
          });
          prepared.resolve();
          await new Promise<void>((resolve) => {
            const abort = () => resolve();
            if (options?.detachSignal?.aborted) abort();
            else options?.detachSignal?.addEventListener("abort", abort, { once: true });
          });
          connection = { kind: "cursor_cli", pid: null, processIdentity: null };
          throw Object.assign(new Error("prepared wrapper reaped before native release"), {
            roomTurnRecoveryOutcome: "not_dispatched" as const,
          });
        }),
        { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } },
        currentAuthority,
        0,
        async () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async ({ agent: activeAgent, inboxItemId, providerTurnId, providerConnection }) => {
          await store.checkpointTurnStarted(inboxItemId, providerTurnId, {
            work_attempt_id: activeAgent.workAttemptId,
            origin_execution_generation_id: activeAgent.executionGenerationId,
            provider_continuation_id: activeAgent.providerContinuationId!,
          });
          activeAgent.providerConnection = providerConnection;
        },
      );
      await retiring.pump(cursorAgent);
      await ingest(store);
      const pump = retiring.pump(cursorAgent);
      await prepared.promise;
      await Promise.all([
        retirement === "stop" ? retiring.stop(cursorAgent.agentId) : retiring.fenceAndDrain(),
        pump,
      ]);

      const retained = (await store.receipts(cursorAgent.agentId))[0]!;
      assert.equal(retained.state, "dispatching");
      assert.equal(
        retained.provider_turn_id,
        exactTurnId,
        "retirement cannot tear the exact turn away from its committed wrapper identity",
      );

      let recoveries = 0;
      let redispatches = 0;
      const successor = new SupervisedAgentDelivery(
        store,
        provider(
          async (_handle, _request, options) => {
            redispatches += 1;
            await options?.beforeNativeDispatch?.();
            await options?.checkpointTurnStarted?.(`cursor:redispatched:${retirement}`);
            options?.markDurableTurnStarted?.();
            const providerTurnId = `cursor:redispatched:${retirement}`;
            recordCompletion(providerTurnId, { outcome: "no_reply" });
            const raw = { turnId: providerTurnId, outcome: "no_reply" as const, text: null };
            return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw;
          },
          async () => {
            recoveries += 1;
            throw Object.assign(new Error("durable wrapper journal proves no native dispatch"), {
              roomTurnRecoveryOutcome: "not_dispatched" as const,
            });
          },
        ),
        { poll: async () => ({}), publish: async () => { throw new Error("no reply must not publish"); } },
        currentAuthority,
        0,
        async () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        async ({ agent: activeAgent, providerContinuationId, providerConnection }) => {
          activeAgent.providerContinuationId = providerContinuationId;
          activeAgent.providerConnection = providerConnection;
        },
      );
      await successor.pump(cursorAgent);
      const settled = (await store.receipts(cursorAgent.agentId))[0]!;
      assert.equal(recoveries, 1, "the successor inspects the retained exact turn before any redispatch");
      assert.equal(redispatches, 1, "only proven-not-dispatched recovery admits a fresh turn");
      assert.equal(settled.state, "acknowledged_no_reply");
      assert.equal(settled.provider_turn_id, `cursor:redispatched:${retirement}`);
      await successor.fenceAndDrain();
      await store.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cursor handoff restores a claimed FIFO head when retirement wins before provider entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cursor-pre-entry-handoff-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const cursorAgent = { ...agent, provider: "cursor" };
    let providerTurns = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => {
      providerTurns += 1;
      throw new Error("provider must not be entered after clean retirement");
    }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await delivery.pump(cursorAgent); await ingest(store);
    const observedContext = store.observedContext.bind(store);
    const contextEntered = deferred<void>();
    const releaseContext = deferred<void>();
    (store as unknown as {
      observedContext(agentId: string, roomId: string, limit?: number): ReturnType<typeof store.observedContext>;
    }).observedContext = async (agentId, roomId, limit) => {
      contextEntered.resolve();
      await releaseContext.promise;
      return observedContext(agentId, roomId, limit);
    };

    const pump = delivery.pump(cursorAgent);
    await contextEntered.promise;
    const drain = delivery.fenceAndDrain();
    releaseContext.resolve();
    await drain; await pump;

    assert.equal(providerTurns, 0);
    assert.equal(
      (await store.receipts(cursorAgent.agentId))[0]?.state,
      "pending",
      "a clean pre-entry handoff cannot leave a no-turn dispatching claim",
    );
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cursor handoff restores an evidence-free pre-native retry backoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cursor-retry-handoff-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const cursorAgent = { ...agent, provider: "cursor" };
    const retryEntered = deferred<void>();
    const releaseRetry = deferred<void>();
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      throw new Error("Cursor preflight failed before a wrapper existed");
    }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority, 50, async () => {
      retryEntered.resolve();
      await releaseRetry.promise;
    });
    await delivery.pump(cursorAgent); await ingest(store);
    const pump = delivery.pump(cursorAgent);
    await retryEntered.promise;
    assert.equal((await store.receipts(cursorAgent.agentId))[0]?.state, "retryable");

    const drain = delivery.fenceAndDrain();
    releaseRetry.resolve();
    await drain; await pump;

    assert.equal(
      (await store.receipts(cursorAgent.agentId))[0]?.state,
      "pending",
      "clean retirement during pre-native backoff cannot become a blocked startup ambiguity",
    );
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cursor handoff detaches immediately after the exact durable wrapper milestone", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-cursor-durable-detach-"));
  let late: ReturnType<typeof deferred<{ turnId: string; outcome: "reply"; text: string }>> | null = null;
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const cursorAgent = { ...agent, provider: "cursor" };
    const entered = deferred<void>();
    late = deferred<{ turnId: string; outcome: "reply"; text: string }>();
    let published = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.("cursor:durable-wrapper");
      options?.markDurableTurnStarted?.();
      entered.resolve();
      return late!.promise;
    }), { poll: async () => ({}), publish: async () => { published += 1; } }, currentAuthority);
    await delivery.pump(cursorAgent); await ingest(store);
    const pump = delivery.pump(cursorAgent); await entered.promise;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        delivery.fenceAndDrain(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("durable Cursor turn retained the retiring daemon")),
            1_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    assert.equal((await store.receipts(cursorAgent.agentId))[0]?.provider_turn_id, "cursor:durable-wrapper");
    assert.equal(published, 0);

    late.resolve({ turnId: "cursor:durable-wrapper", outcome: "reply", text: "must not publish" });
    await pump;
    assert.equal(published, 0);
    await store.close();
  } finally {
    late?.resolve({ turnId: "cursor:durable-wrapper", outcome: "reply", text: "cleanup" });
    await rm(root, { recursive: true, force: true });
  }
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
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.("turn:unresolved-live");
      entered.resolve();
      return late!.promise;
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
    assert.equal((await store.receipts(agent.agentId))[0]?.provider_turn_id, "turn:unresolved-live");
    late.resolve({ turnId: "late", outcome: "reply", text: "must not publish" });
    await pump;
    await Promise.resolve();
    assert.equal(published, 0, "a late provider resolution cannot publish after authority retirement");
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching", "a late result cannot checkpoint or acknowledge");
    await store.close(); store = null;
    let newTurns = 0; const recoveredTurns: string[] = [];
    const reopened = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const successor = new SupervisedAgentDelivery(reopened, provider(
      async () => {
        newTurns += 1;
        throw new Error("a persisted exact turn must not rerun automatically");
      },
      async (_handle, request) => {
        recoveredTurns.push(request.providerTurnId);
        return { turnId: request.providerTurnId, outcome: "no_reply", text: null };
      },
    ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await successor.pump(agent);
    assert.equal(newTurns, 0);
    assert.deepEqual(recoveredTurns, ["turn:unresolved-live"]);
    assert.equal((await reopened.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
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
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.("turn:late-rejection");
      entered.resolve();
      return late!.promise;
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
    assert.equal((await store.receipts(agent.agentId))[0]?.provider_turn_id, "turn:late-rejection");
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
      providerContinuationId: "thread", providerConnection: agent.providerConnection, handle: agent.handle,
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
        provider_ref: { work_attempt_id: identity.attempt, provider_continuation_id: `${id}-thread`, provider_connection: { ...agent.providerConnection, pid: id === "stone" ? 1 : 2, processIdentity: `${id}-process-birth` }, execution_generation_id: identity.execution },
      } });
      assert.equal(put.ok, true, put.error);
      internals.liveHandles.set(id, { workAttemptId: identity.attempt, providerContinuationId: `${id}-thread`, pid: id === "stone" ? 1 : 2, providerConnection: { ...agent.providerConnection, pid: id === "stone" ? 1 : 2, processIdentity: `${id}-process-birth` }, observedState: "working" });
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
    internals.liveHandles.set("stone", { workAttemptId: identities.stone.attempt, providerContinuationId: "stone-thread", pid: 1, providerConnection: { ...agent.providerConnection, processIdentity: "stone-process-birth" }, observedState: "working" });
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
    await internals.supervisedInbox.checkpointTurnStarted(otherHead.inbox_item_id, "other-turn", {
      work_attempt_id: identities.other.attempt,
      origin_execution_generation_id: identities.other.execution,
      provider_continuation_id: "other-thread",
    });
    await internals.supervisedInbox.transition(otherHead.inbox_item_id, "awaiting_result");
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
      appliedConfigurationRevision: 1,
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
      store: ManifestStore;
      manifestGeneration: number;
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
    const manifestEntry = {
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
      } as const;
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: manifestEntry });
    assert.equal(put.ok, true, put.error);
    const manifestDatabase = (internals.store as unknown as { database: DatabaseSync }).database;
    manifestDatabase.prepare(`INSERT INTO work_attempts(
      work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,
      workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      identity.attempt,
      "task-restore",
      "lease-restore",
      1,
      root,
      "repo",
      "remote",
      "revision",
      root,
      "active",
      new Date().toISOString(),
    );
    manifestDatabase.prepare(`INSERT INTO work_attempt_executions(
      execution_generation_id,work_attempt_id,started_at,actor,generation,terminal_json
    ) VALUES(?,?,?,?,?,NULL)`).run(
      identity.execution,
      identity.attempt,
      new Date().toISOString(),
      "test",
      1,
    );
    const snapshot = await internals.store.load();
    const birth = await internals.store.checkpointProviderBirth(snapshot.generation, {
      entry: manifestEntry,
      executionGenerationId: identity.execution,
      providerConnection: connection,
      appliedRevision: 1,
      requestedAuthorityMode: "typed_shadow",
      observedAtMs: Date.now(),
    });
    internals.manifestGeneration = birth.generation;
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
    const attention = async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as Array<{
      id: string; delivery_attention?: { source_message_id: string; retry: string; can_skip: boolean; skip_unavailable_reason: string | null } | null;
    }>).find((entry) => entry.id === "stone")?.delivery_attention;
    assert.deepEqual(await attention(), { reason: "message_blocked", source_message_id: "msg_2", blocked_since: (await internals.supervisedInbox.get(skippable!.inbox_item_id))!.updated_at,
      detail: "safe pre-turn block", waiting_count: 0, provider_work_started: false, retry: "start_turn", can_skip: true, skip_unavailable_reason: null });
    const skipExact = { ...exact, source_message_id: "msg_2" };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.skip_room_delivery", skipExact)).ok, true);
    assert.equal((await internals.supervisedInbox.get(skippable!.inbox_item_id))?.state, "cancelled_by_user");

    await internals.supervisedInbox.ingestPoll({
      agent_id: "stone", room_id: "room", last_observed_message_id: "msg_3",
      messages: [{ source_message_id: "msg_3", source_message: { id: "msg_3" }, activation: {} }],
    });
    const ambiguous = await internals.supervisedInbox.claimHead("stone");
    // The turn ran in the agent's current conversation and has no terminal
    // result, so it may still be running there.
    await internals.supervisedInbox.checkpointTurnStarted(ambiguous!.inbox_item_id, "turn-ambiguous", {
      work_attempt_id: identity.attempt,
      origin_execution_generation_id: identity.execution,
      provider_continuation_id: "thread-replacement",
    });
    await internals.supervisedInbox.transition(ambiguous!.inbox_item_id, "blocked", { last_error: "ambiguous native result" });
    assert.equal(
      (await daemonRequest(paths.socketPath, "supervisor.skip_room_delivery", {
        ...exact,
        source_message_id: "msg_3",
      })).ok,
      false,
      "skip is unavailable while a started provider turn may still be running",
    );
    const refused = await attention();
    assert.deepEqual([refused?.source_message_id, refused?.retry, refused?.can_skip], ["msg_3", "reread_saved_turn", false]);
    assert.match(refused?.skip_unavailable_reason ?? "", /may still be running/);

    await daemon.stop();
    daemon = null;
  } finally {
    await daemon?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("exact native failure settles once, advances FIFO, and survives cleanup errors and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-native-terminal-"));
  try {
    for (const outcome of ["failed", "interrupted"] as const) {
      for (const cleanupFails of [false, true]) {
        const path = join(root, `${outcome}-${cleanupFails}.sqlite`);
        let store = new SupervisedAgentInboxStore(path);
        let runs = 0;
        let recoveries = 0;
        const port = provider(async (_handle, _request, options) => {
          runs += 1;
          await options?.beforeNativeDispatch?.();
          const turnId = `turn-${runs}`;
          await options?.checkpointTurnStarted?.(turnId);
          if (runs > 1) return { turnId, outcome: "no_reply", text: null };
          const result = { turnId, providerContinuationId: "thread", outcome, text: null, evidence: "stream" as const };
          const checkpoint = await options?.checkpointTerminalResult?.(result);
          assert.equal(checkpoint?.acceptedResult.outcome, outcome);
          assert.equal(checkpoint?.cleanupRecoveryEvidence, true);
          if (cleanupFails) throw new Error("native journal cleanup unavailable after terminal commit");
          return result;
        }, async () => { recoveries += 1; throw new Error("must not re-read a settled native failure"); });
        const http = { poll: async () => ({}), publish: async () => { throw new Error("failure has no room reply"); } };
        const snapshots: string[] = [];
        const delivery = new SupervisedAgentDelivery(store, port, http, currentAuthority,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
          async (_agent, source) => { snapshots.push(source); });
        try {
          await delivery.pump(agent);
          await ingest(store, "1"); await ingest(store, "2");
          await delivery.pump(agent);
          const receipts = await store.receipts(agent.agentId);
          assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply"]);
          assert.deepEqual(snapshots, ["1", "2"], "settled failures capture changes even when adapter cleanup rejects");
          assert.equal(JSON.parse(receipts[0]!.outcome!).kind, outcome);
          assert.equal(receipts[0]!.canonical_message_id, null);
          assert.equal(receipts[0]!.attempt_count, 1);
          assert.equal(receipts[0]!.timeline.filter((event) => event.phase === "turn_finished").length, 1);
          assert.equal(receipts[0]!.timeline.some((event) => ["retry_scheduled", "published", "no_reply"].includes(event.phase)), false);
          await delivery.fenceAndDrain(); await store.close();
          store = new SupervisedAgentInboxStore(path);
          const reopened = new SupervisedAgentDelivery(store, port, http, currentAuthority);
          await reopened.pump({ ...agent, executionGenerationId: "generation-2", daemonGeneration: 2 });
          assert.equal(runs, 2); assert.equal(recoveries, 0);
          assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_failed");
          await reopened.fenceAndDrain();
        } finally { await delivery.fenceAndDrain(); await store.close(); }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native failure cannot invent a dispatch checkpoint or use another continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-invalid-terminal-"));
  try {
    for (const defect of ["missing_dispatch", "wrong_continuation"] as const) {
      const store = new SupervisedAgentInboxStore(join(root, `${defect}.sqlite`));
      let runs = 0;
      const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
        runs += 1;
        if (defect !== "missing_dispatch") await options?.checkpointTurnStarted?.("turn");
        return { turnId: "turn", providerContinuationId: defect === "wrong_continuation" ? "other" : "thread",
          outcome: "failed", text: null, evidence: "stream" };
      }, async () => { throw Object.assign(new Error("exact native state unknown"), { roomTurnRecoveryOutcome: "ambiguous" }); }),
      { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority, 1, async () => {});
      try {
        await delivery.pump(agent); await ingest(store); await delivery.pump(agent);
        const receipt = (await store.receipts(agent.agentId))[0]!;
        assert.equal(receipt.state, "blocked"); assert.equal(receipt.outcome, null); assert.equal(runs, 1);
        assert.equal(await store.nativeFailure(receipt.inbox_item_id), null);
      } finally { await delivery.fenceAndDrain(); await store.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a saved reply or Cursor completion proposal wins a late exact native failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-terminal-winner-"));
  try {
    for (const candidate of ["codex", "cursor"]) {
      const store = new SupervisedAgentInboxStore(join(root, `${candidate}.sqlite`));
      const recordCompletion = installCursorCompletionProjectionFixture(store);
      const published: string[] = [];
      const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
        await options?.checkpointTurnStarted?.("turn");
        if (candidate === "cursor") {
          recordCompletion("turn", { outcome: "reply", text: "Saved answer." });
        } else {
          await options?.checkpointTerminalResult?.({ turnId: "turn", outcome: "reply", text: "Saved answer.", evidence: "stream" });
        }
        const failure = { turnId: "turn", providerContinuationId: "thread", outcome: "failed" as const, text: null, evidence: "stream" as const };
        const accepted = await options?.checkpointTerminalResult?.(failure);
        assert.equal(accepted?.acceptedResult.outcome, "reply");
        return failure;
      }), { poll: async () => ({}), publish: async ({ text, roomId }) => { published.push(text); return { roomId, messageId: "published" }; } }, currentAuthority);
      try {
        const currentAgent = { ...agent, provider: candidate };
        await delivery.pump(currentAgent); await ingest(store); await delivery.pump(currentAgent);
        assert.deepEqual(published, ["Saved answer."], candidate);
        assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
      } finally { await delivery.fenceAndDrain(); await store.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery republishes a durable publishing outcome without rerunning its provider turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-republish-recovery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite")); const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "turn", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(item.inbox_item_id, "awaiting_result", { outcome: JSON.stringify({ kind: "reply", text: "durable" }) });
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
    const first = await enqueue(store, "1");
    await store.checkpointTurnStarted(first.inbox_item_id, "turn", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(first.inbox_item_id, "awaiting_result");
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("must not run"); }), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await delivery.pump(agent);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "blocked");
    await store.close();

    const retryStore = new SupervisedAgentInboxStore(join(root, "retry.sqlite")); const retry = await enqueue(retryStore, "1");
    await retryStore.checkpointTurnStarted(retry.inbox_item_id, "turn", TEST_PROVIDER_TURN_AUTHORITY);
    await retryStore.transition(retry.inbox_item_id, "awaiting_result");
    await retryStore.transition(retry.inbox_item_id, "retryable", { last_error: "lost response" });
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
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-exact", TEST_PROVIDER_TURN_AUTHORITY);
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
    await ambiguousStore.checkpointTurnStarted(ambiguous.inbox_item_id, "turn-ambiguous", TEST_PROVIDER_TURN_AUTHORITY);
    const ambiguousDelivery = new SupervisedAgentDelivery(ambiguousStore, provider(
      async () => { throw new Error("must not rerun"); },
      async () => { throw Object.assign(new Error("exact turn missing"), { roomTurnRecoveryOutcome: "ambiguous" as const }); },
    ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority, 0);
    await ambiguousDelivery.pump(agent);
    assert.equal((await ambiguousStore.receipts(agent.agentId))[0]?.state, "blocked");
    await ambiguousStore.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery rejects an exact turn after its provider continuation is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-continuation-swap-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-old-continuation", {
      ...TEST_PROVIDER_TURN_AUTHORITY,
      provider_continuation_id: "thread-old",
    });
    await store.transition(item.inbox_item_id, "awaiting_result");
    let recoveries = 0;
    const successor = {
      ...agent,
      providerContinuationId: "thread-successor",
      handle: { ...agent.handle, providerContinuationId: "thread-successor" },
    };
    const delivery = new SupervisedAgentDelivery(store, provider(
      async () => { throw new Error("must not redispatch"); },
      async () => { recoveries += 1; throw new Error("must not recover through successor authority"); },
    ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority);
    await delivery.pump(successor);
    assert.equal(recoveries, 0);
    const blocked = (await store.receipts(agent.agentId))[0]!;
    assert.equal(blocked.state, "blocked");
    assert.match(blocked.last_error ?? "", /different or unverifiable provider authority/i);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

/** The saved turn's own execution, `generation-1` of work attempt `attempt`, with or without a recorded terminal. */
function recordExecution(database: { exec(sql: string): void; prepare(sql: string): { run(...values: Array<string | null>): unknown } }, ended: boolean): void {
  database.exec(`INSERT INTO work_attempts(work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
    VALUES('attempt','task','lease',1,'/private/workspace','repo','remote','revision','/private/bare','active','2026-08-31T00:00:00.000Z')`);
  database.prepare("INSERT INTO work_attempt_executions VALUES('generation-1','attempt','2026-08-31T00:00:00.000Z','test',1,?)")
    .run(ended ? JSON.stringify({ ended_at: "2026-08-31T00:01:00.000Z", terminal_cause: "crashed" }) : null);
}

test("a saved turn is recovered as one whose process has ended only when a later runtime recovers it and that process's terminal is on record", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-process-ended-"));
  const { DatabaseSync } = await import("node:sqlite");
  try {
    /** Recover one saved turn of `generation-1` with a runtime of `runsIn`, the turn's own process ended or not. */
    const recover = async (name: string, runsIn: string, ended: boolean) => {
      const path = join(root, `${name}.sqlite`);
      const store = new SupervisedAgentInboxStore(path);
      const item = await enqueue(store);
      await store.checkpointTurnStarted(item.inbox_item_id, "turn-saved", TEST_PROVIDER_TURN_AUTHORITY);
      const database = new DatabaseSync(path);
      recordExecution(database, ended);
      database.close();
      const requests: Array<Record<string, unknown>> = [];
      const delivery = new SupervisedAgentDelivery(store, provider(
        async () => { throw new Error("must not rerun"); },
        async (_handle, request) => { requests.push({ ...request }); return { turnId: "turn-saved", outcome: "reply", text: "recovered" }; },
      ), { poll: async () => ({}), publish: async (input) => ({ messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }) }, currentAuthority, 0);
      await delivery.pump({ ...agent, executionGenerationId: runsIn });
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
      await store.close();
      return requests[0]!;
    };
    assert.equal((await recover("later-runtime-ended", "generation-2", true)).originProcessEnded, true);
    assert.equal((await recover("later-runtime-alive", "generation-2", false)).originProcessEnded, undefined,
      "a process with no recorded terminal may still be running the turn");
    assert.equal((await recover("own-runtime", "generation-1", true)).originProcessEnded, undefined,
      "a runtime is never told that its own process has ended");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a turn of a session an ended Open Model process ran is read in that session by its replacement; no other mismatch of authority is", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-earlier-session-"));
  const { DatabaseSync } = await import("node:sqlite");
  const reason = "The agent's process ended during this turn, and the turn's result could not be recovered. The message was not run again.";
  try {
    const recover = async (name: string, input: { provider: string; ended: boolean; workAttemptId?: string }) => {
      const path = join(root, `${name}.sqlite`);
      const store = new SupervisedAgentInboxStore(path);
      const item = await enqueue(store);
      await store.checkpointTurnStarted(item.inbox_item_id, "turn-old-session", { ...TEST_PROVIDER_TURN_AUTHORITY, provider_continuation_id: "session-old" });
      await store.transition(item.inbox_item_id, "awaiting_result");
      const database = new DatabaseSync(path);
      recordExecution(database, input.ended);
      database.close();
      const requests: Array<Record<string, unknown>> = [];
      const successor = { ...agent, provider: input.provider, executionGenerationId: "generation-2", providerContinuationId: "session-new",
        workAttemptId: input.workAttemptId ?? agent.workAttemptId,
        handle: { ...agent.handle, providerContinuationId: "session-new", workAttemptId: input.workAttemptId ?? agent.workAttemptId } };
      const delivery = new SupervisedAgentDelivery(store, provider(
        async () => { throw new Error("must not rerun"); },
        async (_handle, request, options) => {
          requests.push({ ...request });
          const result = { turnId: "turn-old-session", providerContinuationId: "session-old", outcome: "interrupted" as const, text: null, evidence: "transcript" as const, error: reason };
          await options?.checkpointTerminalResult?.(result);
          return result;
        },
      ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority, 0);
      await delivery.pump(successor);
      const receipt = (await store.receipts(agent.agentId))[0]!;
      await store.close();
      return { receipt, requests };
    };
    const read = await recover("open-model-ended", { provider: "open-model", ended: true });
    assert.deepEqual(read.requests.map((request) => [request.providerTurnId, request.providerContinuationId, request.originProcessEnded]),
      [["turn-old-session", "session-old", true]], "the adapter is given the turn's own session");
    assert.equal(read.receipt.state, "acknowledged_failed");
    assert.equal(read.receipt.last_error, reason, "and the message settles with what the session showed");

    for (const [name, input] of Object.entries({
      "open-model-alive": { provider: "open-model", ended: false },
      "codex-ended": { provider: "codex", ended: true },
      "claude-ended": { provider: "claude-code", ended: true },
      "another-work-attempt": { provider: "open-model", ended: true, workAttemptId: "another-attempt" },
    })) {
      const refused = await recover(name, input);
      assert.deepEqual(refused.requests, [], `${name}: the turn is not read through another authority`);
      assert.equal(refused.receipt.state, "blocked", name);
      assert.match(refused.receipt.last_error ?? "", /different or unverifiable provider authority/i, name);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same-continuation successor recovery preserves the provider turn's origin generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-origin-generation-"));
  try {
    const databasePath = join(root, "daemon.sqlite");
    const store = new SupervisedAgentInboxStore(databasePath);
    const item = await enqueue(store);
    const originExecutionGenerationId = "generation-origin";
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-origin", {
      ...TEST_PROVIDER_TURN_AUTHORITY,
      origin_execution_generation_id: originExecutionGenerationId,
    });
    await store.transition(item.inbox_item_id, "awaiting_result");
    let recoveries = 0;
    const successor = {
      ...agent,
      executionGenerationId: "generation-successor",
      handle: { ...agent.handle },
    };
    const delivery = new SupervisedAgentDelivery(store, provider(
      async () => { throw new Error("must not redispatch"); },
      async (_handle, request) => {
        recoveries += 1;
        assert.equal(request.providerTurnId, "turn-origin");
        return { turnId: "turn-origin", outcome: "no_reply", text: null };
      },
    ), { poll: async () => ({}), publish: async () => { throw new Error("no reply must not publish"); } }, currentAuthority);
    await delivery.pump(successor);
    assert.equal(recoveries, 1);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
    await store.close();
    const inspection = new DatabaseSync(databasePath);
    try {
      assert.equal(
        (inspection.prepare("SELECT execution_generation_id FROM supervised_agent_terminal_results WHERE inbox_item_id=?")
          .get(item.inbox_item_id) as { execution_generation_id: string }).execution_generation_id,
        originExecutionGenerationId,
      );
    } finally { inspection.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery retries exactly once when wrapper evidence proves native dispatch never began", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-not-dispatched-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "cursor:prepared-only", TEST_PROVIDER_TURN_AUTHORITY);
    let recoveries = 0;
    let newTurns = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(
      async (_handle, _request, options) => {
        newTurns += 1;
        await options?.beforeNativeDispatch?.();
        await options?.checkpointTurnStarted?.("cursor:actual-turn");
        return { turnId: "cursor:actual-turn", outcome: "no_reply", text: null };
      },
      async () => {
        recoveries += 1;
        throw Object.assign(new Error("prepared wrapper never released"), {
          roomTurnRecoveryOutcome: "not_dispatched" as const,
        });
      },
    ), {
      poll: async () => ({}),
      publish: async () => { throw new Error("no-reply must not publish"); },
    }, currentAuthority, 0);

    await delivery.pump(agent);

    const receipt = (await store.receipts(agent.agentId))[0]!;
    assert.equal(recoveries, 1);
    assert.equal(newTurns, 1);
    assert.equal(receipt.state, "acknowledged_no_reply");
    assert.equal(receipt.provider_turn_id, "cursor:actual-turn");
    assert.equal(receipt.attempt_count, 1, "the never-dispatched wrapper did not consume a model attempt");
    assert.equal(receipt.timeline.filter((event) => event.phase === "retry_scheduled").length, 1);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const admitted of [false, true]) test(`persistent undispatched wrapper failures are bounded (turn admitted: ${admitted})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-not-dispatched-cap-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    await ingest(store);
    let turns = 0;
    const delays: number[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(
      async (_handle, _request, options) => {
        turns += 1;
        await options?.beforeNativeDispatch?.();
        if (admitted) await options?.checkpointTurnStarted?.(`cursor:prepared-only:${turns}`);
        throw Object.assign(new Error("persistent pre-release provider checkpoint failure"), {
          roomTurnRecoveryOutcome: "not_dispatched" as const,
        });
      },
    ), {
      poll: async () => ({}),
      publish: async () => { throw new Error("an undispatched turn cannot publish"); },
    }, currentAuthority, 10, async (ms) => { delays.push(ms); });

    await delivery.pump({ ...agent, provider: "cursor" });

    const receipt = (await store.receipts(agent.agentId))[0]!;
    assert.equal(turns, 3, "safe redispatch is capped at the same three-attempt budget as ordinary delivery");
    assert.deepEqual(delays, [10, 20], "undispatched retries use exponential backoff");
    assert.equal(receipt.state, "blocked");
    assert.equal(receipt.timeline.filter((event) => event.phase === "retry_scheduled").length, 3,
      "the exhausted failure is journaled atomically with its block");
    assert.match(receipt.last_error ?? "", /failed 3 times/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed Cursor idle compensation spends only recovery budget and retains exact authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-compensation-budget-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  try {
    const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "cursor:prepared", TEST_PROVIDER_TURN_AUTHORITY);
    const binding = await store.providerTurnBinding(item.inbox_item_id);
    let recoveries = 0; let compensations = 0; const delays: number[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(
      async () => { throw new Error("must never redispatch before compensation succeeds"); },
      async () => {
        recoveries += 1;
        throw Object.assign(new Error("wrapper never released"), { roomTurnRecoveryOutcome: "not_dispatched" });
      },
    ), { poll: async () => ({}), publish: async () => { throw new Error("must not publish"); } }, currentAuthority,
    10, async (ms) => { delays.push(ms); }, undefined, undefined, undefined, undefined,
    async () => { compensations += 1; throw new Error("idle checkpoint unavailable"); });
    await delivery.pump({ ...agent, provider: "cursor" });
    assert.equal(recoveries, 3); assert.equal(compensations, 3);
    assert.deepEqual(delays, [10, 20]);
    const blocked = (await store.receipts(agent.agentId))[0]!;
    assert.equal(blocked.state, "blocked"); assert.equal(blocked.provider_turn_id, "cursor:prepared");
    assert.deepEqual(await store.providerTurnBinding(item.inbox_item_id), binding);
    const inspection = new DatabaseSync(join(root, "daemon.sqlite"));
    try {
      const events = inspection.prepare("SELECT idempotency_key FROM supervised_agent_inbox_events WHERE phase='retry_scheduled'").all();
      assert.deepEqual(events.map((event) => event.idempotency_key), [1, 2, 3].map((ordinal) => `retry_failure:result_recovery:${ordinal}`));
    } finally { inspection.close(); }
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a checkpointed terminal provider rejection settles failed and advances FIFO without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-terminal-provider-failure-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const bidiControls = [
      "\u061c", "\u200e", "\u200f",
      "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
      "\u2066", "\u2067", "\u2068", "\u2069",
    ];
    const disguisedCredentials = bidiControls.map((control, index) => (
      index % 2 === 0
        ? `to${control}ken=secret-${index}-value`
        : `api_${control}key=secret-${index}-value`
    )).join(" ");
    const redactedCredentials = bidiControls.map((_control, index) => (
      index % 2 === 0 ? "token=[REDACTED]" : "api_key=[REDACTED]"
    )).join(" ");
    const expectedProviderError = `Open Model request failed at the model provider (HTTP 404): expired model. ${redactedCredentials}`;
    let turns = 0;
    let recoveries = 0;
    const delivery = new SupervisedAgentDelivery(
      store,
      provider(async (_handle, _request, options) => {
        turns += 1;
        await options?.beforeNativeDispatch?.();
        const turnId = `turn-${turns}`;
        await options?.checkpointTurnStarted?.(turnId);
        if (turns > 1) return { turnId, outcome: "no_reply", text: null };
        await options?.checkpointTerminalResult?.({
          turnId,
          providerContinuationId: "thread",
          outcome: "failed",
          text: null,
          evidence: "transcript",
          error: `\u001b[31mOpen Model request failed\u001b[0m at the model provider (HTTP 404):\u0000 expired model. ${disguisedCredentials}`,
        });
        throw Object.assign(
          new Error("The provider completed, but its final answer could not be read."),
          { roomTurnRecoveryOutcome: "terminal_failure" as const },
        );
      }, async () => {
        recoveries += 1;
        throw new Error("must not recover a checkpointed terminal provider rejection");
      }),
      {
        poll: async () => ({}),
        publish: async () => { throw new Error("must not publish"); },
      },
      currentAuthority,
      0,
    );

    const openModelAgent = { ...agent, provider: "open-model" };
    await delivery.pump(openModelAgent);
    await ingest(store, "1");
    await ingest(store, "2");
    await delivery.pump(openModelAgent);

    const receipts = await store.receipts(agent.agentId);
    assert.equal(turns, 2);
    assert.equal(recoveries, 0);
    assert.deepEqual(receipts.map((receipt) => receipt.state), [
      "acknowledged_failed",
      "acknowledged_no_reply",
    ]);
    assert.deepEqual(JSON.parse(receipts[0]!.outcome!), {
      kind: "failed",
      text: null,
      evidence: "transcript",
    });
    assert.equal(
      receipts[0]!.last_error,
      expectedProviderError,
      "the failed receipt retains an actionable provider explanation without credentials or display controls",
    );
    const inspection = new DatabaseSync(join(root, "daemon.sqlite"));
    try {
      const persisted = inspection.prepare("SELECT terminal_evidence_json FROM supervised_agent_terminal_results WHERE inbox_item_id=?")
        .get(receipts[0]!.inbox_item_id) as { terminal_evidence_json: string };
      assert.equal(
        (JSON.parse(persisted.terminal_evidence_json) as { error?: string }).error,
        expectedProviderError,
        "durable terminal evidence contains only the same safe display text",
      );
    } finally {
      inspection.close();
    }
    assert.equal(
      receipts[0]?.timeline.some((event) => event.phase === "retry_scheduled"),
      false,
    );
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
