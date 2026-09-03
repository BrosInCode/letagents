import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ProviderActionFailure, type ProviderActionHandle, type ProviderActionPort } from "../provider-action-port.js";
import type { ProviderInstallationToken } from "../provider-stream-coordinator.js";
import { SupervisorDaemon } from "../main.js";
import { ManifestStore } from "../manifest-store.js";
import {
  SupervisedAgentDelivery,
  supervisedReplyTargetForSourceMessage,
} from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { SupervisedDeliveryLifecycleCoordinator } from "../supervised-delivery-lifecycle-coordinator.js";
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
    isHandoffScheduled: () => false,
    supportsRoomTurns: () => true,
    isLifecycleActive: () => false,
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
    providerAuthority: { isExactAuthority: async () => true },
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
            terminal: { terminal_cause: "crashed" };
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
        terminal: { terminal_cause: "crashed" },
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
        endedAt: new Date().toISOString(),
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

async function enqueue(store: SupervisedAgentInboxStore, id = "1") {
  await ingest(store, id);
  return (await store.claimHead(agent.agentId))!;
}

async function ingest(store: SupervisedAgentInboxStore, id = "1") {
  await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: id, messages: [{ source_message_id: id, source_message: { id }, activation: {} }] });
}

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
    assert.equal(turns, 1, "the stopped poll cannot launch a stale delivery pump after ingest");
    assert.equal(turnHandles[0], successor.handle, "only the successor context may run the recovered delivery turn");
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply", "successor recovery and delivery happen before its hanging poll");
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
    const skipExact = { ...exact, source_message_id: "msg_2" };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.skip_room_delivery", skipExact)).ok, true);
    assert.equal((await internals.supervisedInbox.get(skippable!.inbox_item_id))?.state, "cancelled_by_user");

    await internals.supervisedInbox.ingestPoll({
      agent_id: "stone", room_id: "room", last_observed_message_id: "msg_3",
      messages: [{ source_message_id: "msg_3", source_message: { id: "msg_3" }, activation: {} }],
    });
    const ambiguous = await internals.supervisedInbox.claimHead("stone");
    await internals.supervisedInbox.checkpointTurnStarted(ambiguous!.inbox_item_id, "turn-ambiguous", TEST_PROVIDER_TURN_AUTHORITY);
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
        const delivery = new SupervisedAgentDelivery(store, port, http, currentAuthority);
        try {
          await delivery.pump(agent);
          await ingest(store, "1"); await ingest(store, "2");
          await delivery.pump(agent);
          const receipts = await store.receipts(agent.agentId);
          assert.deepEqual(receipts.map((item) => item.state), ["acknowledged_failed", "acknowledged_no_reply"]);
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
          error: "\u001b[31mOpen Model request failed\u001b[0m at the model provider (HTTP 404):\u0000 expired model. \u202etoken=super-secret-provider-token",
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
      "Open Model request failed at the model provider (HTTP 404): expired model. token=[REDACTED]",
      "the failed receipt retains an actionable provider explanation without credentials or display controls",
    );
    const inspection = new DatabaseSync(join(root, "daemon.sqlite"));
    try {
      const persisted = inspection.prepare("SELECT terminal_evidence_json FROM supervised_agent_terminal_results WHERE inbox_item_id=?")
        .get(receipts[0]!.inbox_item_id) as { terminal_evidence_json: string };
      assert.equal(
        (JSON.parse(persisted.terminal_evidence_json) as { error?: string }).error,
        "Open Model request failed at the model provider (HTTP 404): expired model. token=[REDACTED]",
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
