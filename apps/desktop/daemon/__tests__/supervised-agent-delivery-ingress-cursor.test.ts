import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ProviderActionHandle, type ProviderRoomTurnResult } from "../provider-action-port.js";
import type { ProviderInstallationToken } from "../provider-stream-coordinator.js";
import { SupervisorDaemon } from "../main.js";
import { ManifestStore } from "../manifest-store.js";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { SupervisedDeliveryLifecycleCoordinator } from "../supervised-delivery-lifecycle-coordinator.js";
import { cursorAuthorityUnprovenDetail } from "../../electron/main/agents/cursor-turn-settlement.js";
import { type DaemonManifestEntry } from "../types.js";
import {
  agent,
  currentAuthority,
  TEST_PROVIDER_TURN_AUTHORITY,
  provider,
  deferred,
  waitForAsync,
  seedCursorRoomTurnCompletion,
  installCursorCompletionProjectionFixture,
  daemonRequest,
  installExactTestProviderBirth,
  enqueue,
  ingest,
} from "./helpers/supervised-agent-delivery-fixture.js";
import { supervisedAgentsOnly } from "../../electron/__tests__/platform.js";

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

test("Cursor dynamic checkpoint converges after manifest commit but attempt durability failure", { skip: supervisedAgentsOnly }, async () => {
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

test("first and sequential Cursor turns cross one atomic prepared boundary without losing FIFO authority", { skip: supervisedAgentsOnly }, async () => {
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
test(`a Cursor turn that finished without proof its authority ended is settled as lost, its reply is withheld, the next message still runs, and the reason ${scenario.name}`, { skip: supervisedAgentsOnly }, async () => {
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

test("handoff after Cursor native release waits for first-turn and resumed init authority without killing the turn", { skip: supervisedAgentsOnly }, async () => {
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

test("a worker bearer rotation after Cursor native release keeps the turn alive through its init checkpoint", { skip: supervisedAgentsOnly }, async () => {
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

test("a crashed Cursor turn settles as interrupted instead of blocking the FIFO after its lane fails", { skip: supervisedAgentsOnly }, async () => {
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
