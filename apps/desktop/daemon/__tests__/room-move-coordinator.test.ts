import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SupervisorGrantRequestError } from "../cloud-http.js";
import {
  applyEffectJournalSchema,
  EffectClaimRefusedError,
  EffectExecutor,
  getEffect,
  listEffectsForAgent,
  ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND,
  ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
  ROOM_MOVE_RETAINED_TERMINAL_EFFECTS_PER_AGENT,
  ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND,
  roomMoveBootstrapTailIdempotencyKey,
  roomMoveJoinDestinationIdempotencyKey,
  roomMoveRollbackSourceIdempotencyKey,
} from "../effect-journal/index.js";
import { EntryConcurrencyGate } from "../entry-concurrency-gate.js";
import {
  RoomMoveCoordinator,
  type RoomMoveCoordinatorPorts,
  type RoomMoveInboxPort,
  type RoomMoveStorePort,
} from "../room-move-coordinator.js";
import type {
  SupervisedEffectRecord,
  SupervisedInboxItem,
  SupervisedProviderTurnBinding,
} from "../supervised-agent-inbox-store.js";
import type { DaemonManifestEntry, DaemonRoomMoveRecord } from "../types.js";
import type { WorkerSessionBinding } from "../worker-binding-store.js";
import { WorkerRuntimeCustody } from "../worker-runtime-custody.js";

const GENERATION = 7;
const NOW_ISO = "2026-08-26T10:00:00.000Z";

function entry(roomId = "source-room"): DaemonManifestEntry {
  return {
    id: "agent-1",
    room_id: roomId,
    display_name: "Agent One",
    provider: "codex",
    model: null,
    charter: "Handle room work.",
    desired_state: "running",
    observed_state: "working",
    condition: "none",
    permission_profile_id: null,
    delivery_mode: "daemon_inbox",
    created_by: "user-1",
    created_at: NOW_ISO,
    work_attempt_id: "attempt-1",
    provider_ref: {
      work_attempt_id: "attempt-1",
      provider_continuation_id: "continuation-1",
      provider_connection: null,
      execution_generation_id: "execution-1",
    },
    last_worker_binding: {
      agent_session_id: "session-1",
      work_attempt_id: "attempt-1",
      execution_generation_id: "execution-1",
      updated_at: NOW_ISO,
    },
  };
}

function roomMove(overrides: Partial<DaemonRoomMoveRecord> = {}): DaemonRoomMoveRecord {
  return {
    operation_id: "move-1",
    request_id: "request-1",
    agent_id: "agent-1",
    source_room_id: "source-room",
    destination_room_id: "destination-alias",
    daemon_generation: GENERATION,
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-1",
    activating_inbox_item_id: null,
    provider_turn_id: null,
    effect_id: null,
    phase: "prepared",
    remote_room_id: null,
    destination_cursor: null,
    source_credentials_revoked: false,
    source_cursor_present: true,
    source_cursor: "40",
    error: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

function workerBinding(roomId = "source-room"): WorkerSessionBinding {
  return {
    entry_id: "agent-1",
    room_id: roomId,
    work_attempt_id: "attempt-1",
    execution_generation_id: "execution-1",
    agent_session_id: "session-1",
    credential_ref: "credential-1",
    api_url: "https://letagents.chat",
    room_cursor: "40",
    last_sequence: 1,
    last_observed_at_ms: Date.parse(NOW_ISO),
    updated_at: NOW_ISO,
  };
}

function inboxItem(overrides: Partial<SupervisedInboxItem> = {}): SupervisedInboxItem {
  return {
    inbox_item_id: "inbox-1",
    agent_id: "agent-1",
    room_id: "source-room",
    source_message_id: "message-1",
    source_message: {},
    activation: {},
    fifo_sequence: 9,
    state: "acknowledged",
    attempt_count: 1,
    action_id: "action-1",
    reply_client_message_id: "reply-1",
    provider_turn_id: "turn-1",
    outcome: "reply",
    last_error: null,
    failure_code: null,
    blocked_by_inbox_item_id: null,
    next_attempt_at_ms: null,
    terminal_reason: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    acknowledged_at: NOW_ISO,
    ...overrides,
  };
}

function effect(overrides: Partial<SupervisedEffectRecord> = {}): SupervisedEffectRecord {
  return {
    effect_id: "effect-1",
    agent_id: "agent-1",
    room_id: "source-room",
    execution_generation_id: "origin-execution-1",
    provider_turn_id: "turn-1",
    mcp_request_id: "mcp-request-1",
    tool_name: "join_room",
    request: {},
    mutation: true,
    state: "prepared",
    result: null,
    error: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

type Harness = {
  coordinator: RoomMoveCoordinator;
  effectDb: DatabaseSync;
  executor: EffectExecutor;
  events: string[];
  custody: WorkerRuntimeCustody;
  gate: EntryConcurrencyGate;
  setMove: (move: DaemonRoomMoveRecord | null) => void;
  getMove: () => DaemonRoomMoveRecord | null;
  setMoves: (moves: DaemonRoomMoveRecord[]) => void;
  setEntry: (entry: DaemonManifestEntry | undefined) => void;
  getEntry: () => DaemonManifestEntry | undefined;
  setBinding: (binding: WorkerSessionBinding | null) => void;
  setCredential: (credential: string | null) => void;
  setHandoff: (handoff: boolean) => void;
  setAssertCurrent: (fn: () => Promise<void>) => void;
  setJoinRoom: (joinRoom: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["joinRoom"]>) => void;
  setLatest: (latest: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["latest"]>) => void;
  setActivatingTurn: (item: SupervisedInboxItem, failure: "failed" | "interrupted" | null) => void;
};

function harness(): Harness {
  const effectDb = new DatabaseSync(":memory:");
  applyEffectJournalSchema(effectDb);
  const events: string[] = [];
  let currentMove: DaemonRoomMoveRecord | null = roomMove();
  let pendingMoves: DaemonRoomMoveRecord[] | null = null;
  let currentEntry: DaemonManifestEntry | undefined = entry();
  let currentBinding: WorkerSessionBinding | null = workerBinding();
  let credential: string | null = "worker-secret";
  let handoff = false;
  let assertCurrentFn: () => Promise<void> = async () => { events.push("authority:assert"); };
  let joinRoom: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["joinRoom"]> = async (input) => {
    events.push(`http:join:${input.roomId}`);
    return { roomId: input.roomId };
  };
  let latest: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["latest"]> = async (input) => {
    events.push(`http:latest:${input.roomId}`);
    return { messages: [] };
  };
  const items = new Map<string, SupervisedInboxItem>();
  const effects = new Map<string, SupervisedEffectRecord>();
  const turnBindings = new Map<string, SupervisedProviderTurnBinding>();
  const nativeFailures = new Map<string, "failed" | "interrupted">();
  const custody = new WorkerRuntimeCustody();
  const gate = new EntryConcurrencyGate({ isHandoffScheduled: () => handoff });

  const fence = async (commit: () => Promise<void>): Promise<void> => {
    events.push("authority:fence");
    await commit();
  };
  const store: RoomMoveStorePort = {
    async getEntry(agentId) {
      events.push(`store:get-entry:${agentId}`);
      return currentEntry;
    },
    async getRoomMove(operationId) {
      events.push(`store:get-move:${operationId}`);
      return currentMove?.operation_id === operationId ? currentMove : null;
    },
    async pendingRoomMoves(agentId) {
      events.push(`store:pending:${agentId ?? "all"}`);
      return (pendingMoves ?? (currentMove && !["active", "failed"].includes(currentMove.phase)
        ? [currentMove]
        : [])).filter((move) => agentId === undefined || move.agent_id === agentId);
    },
    async prepareRoomMove(input, commitFence) {
      let prepared!: DaemonRoomMoveRecord;
      await (commitFence ?? fence)(async () => {
        events.push("store:prepare");
        prepared = roomMove({
          ...input,
          remote_room_id: null,
          destination_cursor: null,
          source_credentials_revoked: false,
          source_cursor_present: true,
          source_cursor: "40",
          error: null,
          created_at: NOW_ISO,
          updated_at: NOW_ISO,
        });
        currentMove = prepared;
      });
      return { created: true, move: prepared };
    },
    async advanceRoomMove(input, commitFence) {
      let advanced!: DaemonRoomMoveRecord;
      await (commitFence ?? fence)(async () => {
        if (!currentMove || currentMove.operation_id !== input.operationId) throw new Error("missing move");
        assert.equal(currentMove.daemon_generation, input.expectedDaemonGeneration);
        assert.equal(currentMove.execution_generation_id, input.expectedExecutionGenerationId);
        assert.equal(input.from.includes(currentMove.phase), true);
        events.push(`store:advance:${currentMove.phase}->${input.to}`);
        advanced = {
          ...currentMove,
          phase: input.to,
          daemon_generation: input.adoptDaemonGeneration ?? currentMove.daemon_generation,
          remote_room_id: input.remoteRoomId ?? currentMove.remote_room_id,
          destination_cursor: input.destinationCursor ?? currentMove.destination_cursor,
          source_credentials_revoked: input.sourceCredentialsRevoked
            ? true
            : currentMove.source_credentials_revoked,
          error: input.error ?? null,
          updated_at: NOW_ISO,
        };
        currentMove = advanced;
      });
      return advanced;
    },
  };

  const inbox: RoomMoveInboxPort = {
    async get(itemId) {
      events.push(`inbox:get:${itemId}`);
      return items.get(itemId) ?? null;
    },
    async nativeFailure(itemId) {
      events.push(`inbox:native-failure:${itemId}`);
      if (items.get(itemId)?.state === "acknowledged_failed" && !nativeFailures.has(itemId)) {
        throw new Error("Failed delivery has no exact native terminal evidence.");
      }
      return nativeFailures.get(itemId) ?? null;
    },
    async receipts(agentId) {
      events.push(`inbox:receipts:${agentId}`);
      return [];
    },
    async providerTurnBinding(itemId) {
      events.push(`inbox:turn-binding:${itemId}`);
      return turnBindings.get(itemId) ?? null;
    },
    async preparedRoomMove(agentId, originExecutionGenerationId, providerTurnId) {
      events.push(`inbox:prepared:${agentId}:${originExecutionGenerationId}:${providerTurnId}`);
      return [...effects.values()].find((candidate) => candidate.agent_id === agentId
        && candidate.execution_generation_id === originExecutionGenerationId
        && candidate.provider_turn_id === providerTurnId) ?? null;
    },
    async preparedRoomMoves(agentId) {
      events.push(`inbox:prepared-all:${agentId ?? "all"}`);
      return [...effects.values()].filter((candidate) => agentId === undefined || candidate.agent_id === agentId);
    },
    async commitRoomMoveQueue(input, commitFence) {
      await (commitFence ?? fence)(async () => {
        events.push(`inbox:commit-queue:${input.old_room_id}:${input.after_fifo_sequence}`);
      });
      return 0;
    },
    async commitRoomMoveCursor(input, commitFence) {
      await (commitFence ?? fence)(async () => {
        events.push(`inbox:commit-cursor:${input.destination_room_id}:${input.last_observed_message_id}`);
      });
    },
    async rollbackRoomMoveIngress(input, commitFence) {
      await (commitFence ?? fence)(async () => {
        events.push(`inbox:rollback:${input.destination_room_id}:${input.source_cursor}`);
      });
      return 0;
    },
  };

  const ports: RoomMoveCoordinatorPorts = {
    store,
    inbox,
    bindings: {
      async get(agentId) {
        events.push(`bindings:get:${agentId}`);
        return currentBinding;
      },
      async credentialFor() {
        events.push("bindings:credential");
        return credential;
      },
      async unbind(agentId) {
        events.push(`bindings:unbind:${agentId}`);
        currentBinding = null;
        return true;
      },
    },
    runtimeCustody: custody,
    deliveryHttp: {
      joinRoom: (input) => joinRoom(input),
      latest: (input) => latest(input),
    },
    authority: {
      currentGeneration: () => GENERATION,
      isHandoffScheduled: () => handoff,
      assertCurrent: async () => assertCurrentFn(),
      ownsDaemonGeneration: async (expected) => {
        events.push(`authority:owns:${expected}`);
        return !handoff && expected === GENERATION;
      },
      fenceCommit: fence,
    },
    entryConcurrency: gate,
    serializeEntry: (agentId, operation) => {
      events.push(`entry:serialize:${agentId}`);
      return gate.run(agentId, operation);
    },
    async updateManifestEntry(agentId, update) {
      events.push(`manifest:update:${agentId}`);
      if (!currentEntry) throw new Error("missing entry");
      currentEntry = update(currentEntry);
      return currentEntry;
    },
    currentHandle: () => ({
      workAttemptId: "attempt-1",
      pid: 10,
      providerContinuationId: "continuation-1",
      observedState: "working",
    }),
    pauseIngress: (agentId) => { events.push(`delivery:pause:${agentId}`); },
    restartDelivery: async (agentId) => { events.push(`delivery:restart:${agentId}`); },
    scheduleRecovery: (agentId, delayMs) => { events.push(`recovery:${agentId}:${delayMs}`); },
    nowIso: () => NOW_ISO,
    externalEffectSignal: () => new AbortController().signal,
  };

  const executor = new EffectExecutor({
    getDatabase: () => effectDb,
    currentDaemonGeneration: () => GENERATION,
    assertCurrent: async () => assertCurrentFn(),
    assertWriteFence: () => {},
    isClosing: () => handoff,
    nowMs: () => Date.parse(NOW_ISO),
    nowIso: () => NOW_ISO,
  });
  const coordinator = new RoomMoveCoordinator(ports);
  coordinator.attachEffectExecutor(executor, effectDb, () => {});

  return {
    coordinator,
    effectDb,
    executor,
    events,
    custody,
    gate,
    setMove(move) { currentMove = move; },
    getMove() { return currentMove; },
    setMoves(moves) { pendingMoves = moves; },
    setEntry(next) { currentEntry = next; },
    getEntry() { return currentEntry; },
    setBinding(binding) { currentBinding = binding; },
    setCredential(next) { credential = next; },
    setHandoff(next) { handoff = next; },
    setAssertCurrent(fn) { assertCurrentFn = fn; },
    setJoinRoom(next) { joinRoom = next; },
    setLatest(next) { latest = next; },
    setActivatingTurn(item, failure) {
      items.set(item.inbox_item_id, item);
      effects.set("effect-1", effect());
      turnBindings.set(item.inbox_item_id, {
        inbox_item_id: item.inbox_item_id,
        agent_id: item.agent_id,
        room_id: item.room_id,
        work_attempt_id: "attempt-1",
        origin_execution_generation_id: "origin-execution-1",
        provider_continuation_id: "continuation-1",
        provider_turn_id: "turn-1",
      });
      if (failure) nativeFailures.set(item.inbox_item_id, failure);
      else nativeFailures.delete(item.inbox_item_id);
    },
  };
}

test("Inspector preparation validates and journals the exact live source runtime", async () => {
  const h = harness();

  const prepared = await h.coordinator.prepareInspector({
    entryId: "agent-1",
    destinationRoomId: " destination-alias ",
    requestId: "request-1",
    daemonGeneration: GENERATION,
  });

  assert.equal(prepared.operation_id, "inspector-room-move:agent-1:request-1");
  assert.equal(prepared.request_id, "inspector:request-1");
  assert.equal(prepared.source_room_id, "source-room");
  assert.equal(prepared.destination_room_id, "destination-alias");
  assert.equal(prepared.agent_session_id, "session-1");
  assert.deepEqual(h.events.slice(0, 8), [
    "entry:serialize:agent-1",
    "authority:assert",
    "store:get-entry:agent-1",
    "bindings:get:agent-1",
    "bindings:credential",
    "authority:fence",
    "store:prepare",
  ]);

  await assert.rejects(() => h.coordinator.prepareInspector({
    entryId: "agent-1",
    destinationRoomId: "source-room",
    requestId: "request-2",
    daemonGeneration: GENERATION,
  }), /exact current live provider and source-room credential binding/);
});

test("reconciles an alias join in exact effect/commit order and activates only after credential acknowledgement", async () => {
  const h = harness();
  h.setJoinRoom(async (input) => {
    h.events.push(`http:join:${input.roomId}`);
    return { roomId: "canonical-destination" };
  });

  const rotating = await h.coordinator.reconcile(roomMove());

  assert.equal(rotating.phase, "rotating_credentials");
  assert.equal(rotating.remote_room_id, "canonical-destination");
  assert.equal(h.getEntry()?.room_id, "canonical-destination");
  const ordered = [
    "store:advance:prepared->waiting_for_current_turn",
    "store:advance:waiting_for_current_turn->joining_destination",
    "delivery:pause:agent-1",
    "http:join:destination-alias",
    "store:advance:joining_destination->joining_destination",
    "manifest:update:agent-1",
    "store:advance:joining_destination->membership_committed",
    "inbox:commit-queue:source-room:0",
    "store:advance:membership_committed->rotating_credentials",
  ];
  let cursor = -1;
  for (const event of ordered) {
    const next = h.events.indexOf(event, cursor + 1);
    assert.notEqual(next, -1, event);
    cursor = next;
  }

  h.setBinding(workerBinding("canonical-destination"));
  h.custody.installHostGrant({
    entryId: "agent-1",
    roomId: "canonical-destination",
    agentKey: "agent-key",
    grantId: "grant-1",
    supervisorGrant: "host-secret",
    grantGeneration: 2,
    apiUrl: "https://letagents.chat",
    daemonGeneration: GENERATION,
    hostId: "host-1",
    installationId: "installation-1",
    expiresAt: "2026-08-27T10:00:00.000Z",
  });
  const acknowledged = await h.coordinator.acknowledgeSourceRevocation({
    operationId: "move-1",
    entryId: "agent-1",
    sourceAgentSessionId: "session-1",
    daemonGeneration: GENERATION,
  });
  assert.equal(acknowledged.source_credentials_revoked, true);
  h.setLatest(async (input) => {
    h.events.push(`http:latest:${input.roomId}`);
    return { messages: [{ id: "41" }, { text: "missing id" }, { id: "42" }] };
  });

  const active = await h.coordinator.reconcile(acknowledged);

  assert.equal(active.phase, "active");
  assert.equal(active.destination_cursor, "42");
  assert.equal(h.events.includes("inbox:commit-cursor:canonical-destination:42"), true);
  assert.equal(h.events.at(-1), "delivery:restart:agent-1");
});

test("adopts only the durable journal generation before evaluating current runtime authority", async () => {
  const h = harness();
  const stale = roomMove({
    daemon_generation: GENERATION - 1,
    phase: "rotating_credentials",
    remote_room_id: "canonical-destination",
  });
  h.setMove(stale);
  h.setEntry(entry("canonical-destination"));

  const adopted = await h.coordinator.reconcile(stale);

  assert.equal(adopted.daemon_generation, GENERATION);
  assert.equal(adopted.phase, "rotating_credentials");
  const assertIndex = h.events.indexOf("authority:assert");
  const adoptIndex = h.events.indexOf("store:advance:rotating_credentials->rotating_credentials");
  const ownsIndex = h.events.indexOf(`authority:owns:${GENERATION}`);
  assert.equal(assertIndex < adoptIndex && adoptIndex < ownsIndex, true);
});

test("distinguishes ambiguous destination outcomes from authoritative pre-membership rejection", async () => {
  const ambiguous = harness();
  const joining = roomMove({ phase: "joining_destination" });
  ambiguous.setMove(joining);
  ambiguous.setJoinRoom(async () => { throw new Error("network disappeared"); });

  const retrying = await ambiguous.coordinator.reconcile(joining);
  assert.equal(retrying.phase, "joining_destination");
  assert.equal(retrying.error, "Destination join outcome was ambiguous and will retry: network disappeared");
  assert.equal(ambiguous.events.includes("recovery:agent-1:1000"), true);

  const rejected = harness();
  rejected.setMove(joining);
  rejected.setJoinRoom(async () => {
    throw new SupervisorGrantRequestError(403, "join room");
  });

  const failed = await rejected.coordinator.reconcile(joining);
  assert.equal(failed.phase, "failed");
  assert.equal(
    failed.error,
    "Destination join was authoritatively rejected before local membership changed: join room failed with HTTP 403.",
  );
  assert.equal(rejected.events.at(-1), "delivery:restart:agent-1");
});

test("rollback compensation restores external membership, manifest, ingress, and secrets before terminalizing", async () => {
  const h = harness();
  const rollback = roomMove({
    phase: "rollback_required",
    remote_room_id: "canonical-destination",
    source_credentials_revoked: true,
  });
  h.setMove(rollback);
  h.setEntry(entry("canonical-destination"));
  h.setBinding(workerBinding("canonical-destination"));
  h.custody.installLiveBinding("agent-1", {
    agentSessionId: "session-1",
    executionGenerationId: "execution-1",
    updatedAt: NOW_ISO,
  });
  h.custody.installWorkerAuthorization({
    entryId: "agent-1",
    roomId: "canonical-destination",
    agentKey: "agent-key",
    workAttemptId: "attempt-1",
    grantId: "grant-1",
    grantGeneration: 2,
    daemonGeneration: GENERATION,
    apiUrl: "https://letagents.chat",
    agentSessionId: "session-1",
    bearer: "worker-secret",
    bearerId: "bearer-1",
    expiresAt: null,
    mintedAtMs: Date.parse(NOW_ISO),
  });
  h.custody.installHostGrant({
    entryId: "agent-1",
    roomId: "canonical-destination",
    agentKey: "agent-key",
    grantId: "grant-1",
    supervisorGrant: "host-secret",
    grantGeneration: 2,
    apiUrl: "https://letagents.chat",
    daemonGeneration: GENERATION,
    hostId: "host-1",
    installationId: "installation-1",
    expiresAt: "2026-08-27T10:00:00.000Z",
  });
  h.setJoinRoom(async (input) => {
    h.events.push(`http:join:${input.roomId}`);
    return { roomId: "source-room" };
  });

  const failed = await h.coordinator.reconcile(rollback);

  assert.equal(failed.phase, "failed");
  assert.equal(failed.error, "Room move failed after destination join and was durably restored to the source room.");
  assert.equal(h.getEntry()?.room_id, "source-room");
  assert.equal(h.custody.liveBinding("agent-1"), undefined);
  assert.equal(h.custody.workerAuthorization("agent-1"), undefined);
  assert.equal(h.custody.hostGrant("agent-1"), undefined);
  const order = [
    "http:join:source-room",
    "manifest:update:agent-1",
    "inbox:rollback:canonical-destination:40",
    "bindings:unbind:agent-1",
    "store:advance:rollback_required->failed",
    "delivery:restart:agent-1",
  ];
  let cursor = -1;
  for (const event of order) {
    const next = h.events.indexOf(event, cursor + 1);
    assert.notEqual(next, -1, event);
    cursor = next;
  }
});

test("Inspector rollback journals rollback_required before restoring local source membership", async () => {
  const h = harness();
  const committed = roomMove({
    phase: "membership_committed",
    remote_room_id: "canonical-destination",
  });
  h.setMove(committed);
  h.setEntry(entry("canonical-destination"));

  const rollback = await h.coordinator.rollbackInspector({
    operationId: "move-1",
    entryId: "agent-1",
    detail: "destination grant unavailable token=secret-value",
    daemonGeneration: GENERATION,
  });

  assert.equal(rollback.phase, "rollback_required");
  assert.match(rollback.error ?? "", /^Destination credential preparation failed:/);
  assert.equal(rollback.error?.includes("secret-value"), false);
  assert.equal(h.getEntry()?.room_id, "source-room");
  assert.equal(
    h.events.indexOf("store:advance:membership_committed->rollback_required")
      < h.events.indexOf("manifest:update:agent-1"),
    true,
  );
});

test("terminal prepared-effect replay settles the split before enumerating nonterminal moves", async () => {
  const h = harness();
  const terminal = roomMove({
    operation_id: "room_move:effect-1",
    phase: "active",
    effect_id: "effect-1",
  });
  h.setMove(terminal);

  await h.coordinator.reconcilePreparedEffect(effect());

  assert.equal(h.events.includes("store:advance:active->active"), true);
});

test("an agent-requested room move fails before joining when its activating turn ended unsuccessfully", async () => {
  for (const failure of ["failed", "interrupted"] as const) {
    for (const state of ["awaiting_result", "acknowledged_failed"] as const) {
      const h = harness();
      const moving = roomMove({
        phase: "waiting_for_current_turn", activating_inbox_item_id: "inbox-1",
        provider_turn_id: "turn-1", effect_id: "effect-1",
      });
      h.setMove(moving);
      h.setActivatingTurn(inboxItem({ state }), failure);

      const result = await h.coordinator.reconcile(moving);

      assert.equal(result.phase, "failed", "no indefinite wait after the activating turn ends");
      assert.match(result.error ?? "", /activating provider turn ended unsuccessfully/);
      assert.equal(h.events.some((event) => event.startsWith("http:")), false);
      assert.equal(h.getEntry()?.room_id, "source-room");
      assert.equal(h.events.includes("store:advance:waiting_for_current_turn->failed"), true);
    }
  }
});

test("a room move the agent asked for is not made once its owner saved Read-only, and a move its owner makes is", async () => {
  const waiting = () => roomMove({
    phase: "waiting_for_current_turn", activating_inbox_item_id: "inbox-1", provider_turn_id: "turn-1", effect_id: "effect-1",
  });
  // The agent's own call was prepared, its turn ended well, and its level is Read-only now.
  const h = harness();
  h.setMove(waiting());
  h.setActivatingTurn(inboxItem({ state: "acknowledged" }), null);
  h.setEntry({ ...entry(), permission_profile_id: "read_only" });
  const refused = await h.coordinator.reconcile(waiting());
  assert.equal(refused.phase, "failed");
  assert.equal(refused.error, "The agent's access level is now Read-only, which does not let it move to another room.");
  assert.equal(h.events.some((event) => event.startsWith("http:")), false, "the destination was never joined");
  assert.equal(h.getEntry()?.room_id, "source-room");

  // The same move at another level, or for another agent app, goes on to join the destination.
  for (const saved of [{ permission_profile_id: null }, { permission_profile_id: "ask_before_write" }, { permission_profile_id: "read_only", provider: "claude-code" }]) {
    const other = harness();
    other.setMove(waiting());
    other.setActivatingTurn(inboxItem({ state: "acknowledged" }), null);
    other.setEntry({ ...entry(), ...saved });
    const moved = await other.coordinator.reconcile(waiting());
    assert.notEqual(moved.error, refused.error, JSON.stringify(saved));
    assert.equal(other.events.includes("store:advance:waiting_for_current_turn->joining_destination"), true, JSON.stringify(saved));
  }

  // A move the owner makes in the Inspector is no call of the agent's: it has no effect of the agent's, and is not held to its level.
  const inspector = harness();
  const owned = roomMove({ phase: "waiting_for_current_turn", activating_inbox_item_id: null, provider_turn_id: null, effect_id: null });
  inspector.setMove(owned);
  inspector.setEntry({ ...entry(), permission_profile_id: "read_only" });
  const made = await inspector.coordinator.reconcile(owned);
  assert.notEqual(made.error, refused.error);
  assert.equal(inspector.events.includes("store:advance:waiting_for_current_turn->joining_destination"), true);
});

test("a failed inbox label alone cannot authorize room-move terminalization", async () => {
  const h = harness();
  const moving = roomMove({
    phase: "waiting_for_current_turn", activating_inbox_item_id: "inbox-1",
    provider_turn_id: "turn-1", effect_id: "effect-1",
  });
  h.setMove(moving);
  h.setActivatingTurn(inboxItem({ state: "acknowledged_failed" }), null);

  await assert.rejects(() => h.coordinator.reconcile(moving), /no exact native terminal evidence/);

  assert.equal(h.getMove()?.phase, "waiting_for_current_turn");
  assert.equal(h.events.some((event) => event.startsWith("http:")), false);
});

test("queued admission and active external effects both return the captured snapshot when handoff fences them", async () => {
  const queued = harness();
  let releaseBlocker!: () => void;
  const blocker = queued.gate.run("agent-1", () => new Promise<void>((resolve) => { releaseBlocker = resolve; }));
  await Promise.resolve();
  const captured = roomMove({ phase: "joining_destination" });
  queued.setMove(captured);
  const waiting = queued.coordinator.reconcile(captured);
  await Promise.resolve();
  queued.setHandoff(true);
  queued.gate.wakeRoomMoveWaiters();

  assert.equal(await waiting, captured);
  assert.equal(queued.events.some((event) => event.startsWith("store:get-move")), false);
  releaseBlocker();
  await blocker;

  const active = harness();
  active.setMove(captured);
  active.setJoinRoom(async (input) => {
    active.events.push(`http:join:${input.roomId}`);
    active.setHandoff(true);
    return { roomId: "canonical-destination" };
  });

  assert.equal(await active.coordinator.reconcile(captured), captured);
  assert.equal(active.getMove()?.phase, "joining_destination");
  assert.equal(active.events.some((event) => event.startsWith("recovery:")), false);
});

test("status and current discovery preserve exact agent and generation fences", async () => {
  const h = harness();
  const move = roomMove({ phase: "rotating_credentials" });
  h.setMove(move);

  assert.equal(await h.coordinator.getInspector({
    operationId: "move-1",
    entryId: "agent-1",
    daemonGeneration: GENERATION,
  }), move);
  assert.equal(await h.coordinator.getCurrentInspector({
    entryId: "agent-1",
    daemonGeneration: GENERATION,
  }), move);
  await assert.rejects(() => h.coordinator.getInspector({
    operationId: "move-1",
    entryId: "agent-1",
    daemonGeneration: GENERATION - 1,
  }), /Room-move status is stale or invalid/);

  h.setMoves([move, roomMove({ operation_id: "move-2" })]);
  await assert.rejects(() => h.coordinator.getCurrentInspector({
    entryId: "agent-1",
    daemonGeneration: GENERATION,
  }), /More than one nonterminal room move exists/);
});

test("EffectExecutor replays interrupted room-move HTTP effects on startup and deduplicates completed outcomes across crashes", async () => {
  const h = harness();
  const move = roomMove({ phase: "joining_destination" });
  h.setMove(move);

  const joinKey = roomMoveJoinDestinationIdempotencyKey({
    operationId: move.operation_id,
    destinationRoomId: move.destination_room_id,
  });
  // Seed an interrupted predecessor generation executing row for destination join.
  h.effectDb.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES (?, 'agent-1', ?, ?, ?, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
  `).run(
    "eff-rm-crash-join",
    ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
    joinKey,
    GENERATION - 1,
    JSON.stringify({
      destination_room_id: move.destination_room_id,
      execution_generation_id: move.execution_generation_id,
      operation_id: move.operation_id,
      source_room_id: move.source_room_id,
      work_attempt_id: move.work_attempt_id,
    }),
    NOW_ISO,
    NOW_ISO,
  );

  const recovery = await h.executor.recoverOnStartup();
  assert.deepEqual(recovery.requeuedIds, ["eff-rm-crash-join"]);
  assert.equal(getEffect(h.effectDb, "eff-rm-crash-join")?.state, "prepared");
  assert.equal(getEffect(h.effectDb, "eff-rm-crash-join")?.epoch, GENERATION);

  let joinCalls = 0;
  h.setJoinRoom(async (input) => {
    joinCalls += 1;
    h.events.push(`http:join:${input.roomId}`);
    return { roomId: "canonical-destination" };
  });

  const rotating = await h.coordinator.reconcile(move);
  assert.equal(rotating.phase, "rotating_credentials");
  assert.equal(joinCalls, 1);
  const completedJoin = getEffect(h.effectDb, "eff-rm-crash-join")!;
  assert.equal(completedJoin.state, "completed");
  assert.equal(completedJoin.attempt_count, 2);
  assert.equal(listEffectsForAgent(h.effectDb, "agent-1", { kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND }).length, 1);

  // Re-reconciling a crash-reverted `joining_destination` phase reuses the durable outcome with ZERO duplicate HTTP.
  h.setMove(roomMove({ phase: "joining_destination" }));
  h.setEntry(entry("source-room"));
  const deduped = await h.coordinator.reconcile(roomMove({ phase: "joining_destination" }));
  assert.equal(deduped.phase, "rotating_credentials");
  assert.equal(deduped.remote_room_id, "canonical-destination");
  assert.equal(joinCalls, 1, "completed room_move_join_destination effect prevents duplicate joinRoom HTTP on crash replay");

  // Tail bootstrap also deduplicates and never persists raw room message text or credentials.
  let latestCalls = 0;
  h.setLatest(async () => {
    latestCalls += 1;
    return { messages: [{ id: "msg_91", text: "PRIVATE_ROOM_MESSAGE_BODY" }] };
  });
  h.setMove(roomMove({
    phase: "bootstrapping_destination_tail",
    remote_room_id: "canonical-destination",
    source_credentials_revoked: true,
  }));
  h.setEntry(entry("canonical-destination"));
  h.setBinding(workerBinding("canonical-destination"));
  const active = await h.coordinator.reconcile(h.getMove()!);
  assert.equal(active.phase, "active");
  assert.equal(active.destination_cursor, "msg_91");
  assert.equal(latestCalls, 1);

  h.setMove(roomMove({
    phase: "bootstrapping_destination_tail",
    remote_room_id: "canonical-destination",
    source_credentials_revoked: true,
  }));
  const dedupedTail = await h.coordinator.reconcile(h.getMove()!);
  assert.equal(dedupedTail.phase, "active");
  assert.equal(dedupedTail.destination_cursor, "msg_91");
  assert.equal(latestCalls, 1, "completed room_move_bootstrap_tail effect prevents duplicate latest() HTTP on crash replay");

  const allEffectsJson = JSON.stringify(h.effectDb.prepare("SELECT payload, outcome, last_error FROM effects").all());
  assert.doesNotMatch(allEffectsJson, /worker-secret|PRIVATE_ROOM_MESSAGE_BODY/);
});

test("handoff scheduled during EffectExecutor's final pre-settlement await never commits a stale room-move receipt", async () => {
  const h = harness();
  const move = roomMove({ phase: "joining_destination" });
  h.setMove(move);

  let joinReturned = false;
  let intercepted = false;
  h.setJoinRoom(async (input) => {
    h.events.push(`http:join:${input.roomId}`);
    joinReturned = true;
    return { roomId: "canonical-destination" };
  });
  let assertCountAfterJoin = 0;
  h.setAssertCurrent(async () => {
    h.events.push("authority:assert");
    if (joinReturned) {
      assertCountAfterJoin += 1;
      // Call 1 after join is execute()'s own post-HTTP assertExternalAuthority();
      // Call 2 is EffectExecutor's pre-settlement await assertAuthority().
      if (assertCountAfterJoin === 2) {
        intercepted = true;
        h.setHandoff(true);
      }
    }
  });

  const result = await h.coordinator.reconcile(move);
  assert.equal(intercepted, true, "must intercept EffectExecutor's final pre-settlement assertAuthority await");
  assert.equal(result, move, "fenced reconciliation returns the captured snapshot");
  assert.equal(h.getMove()?.phase, "joining_destination");
  const [effectRow] = listEffectsForAgent(h.effectDb, "agent-1", { kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND });
  assert.equal(effectRow?.state, "executing", "handoff before settlement never commits completed");

  // Planned handoff inside execute() must throw EffectFenceError without calling EffectExecutor.fence({ abortInFlight: true })
  // and aborting unrelated in-flight bounded external effects draining during retireForHandoff().
  const shared = harness();
  const sharedMove = roomMove({ phase: "joining_destination" });
  shared.setMove(sharedMove);
  let otherSignalAborted = false;
  let releaseOther!: () => void;
  shared.executor.registerHandler("test_unrelated_bounded_effect", {
    retryable: false,
    autoPump: false,
    execute: async (_claimed, context) => {
      context.signal.addEventListener("abort", () => { otherSignalAborted = true; });
      await new Promise<void>((resolve) => { releaseOther = resolve; });
      return { status: "completed", outcome: { ok: true } };
    },
  });
  const otherPrepared = await shared.executor.prepare({
    agent_id: "agent-other",
    kind: "test_unrelated_bounded_effect",
    idempotency_key: "other-1",
    payload: { ok: true },
    retryable: false,
  });
  const otherRunning = shared.executor.runEffect(otherPrepared.effect.id);
  await new Promise((resolve) => setTimeout(resolve, 10));
  shared.setJoinRoom(async () => {
    shared.setHandoff(true);
    return { roomId: "canonical-destination" };
  });
  assert.equal(await shared.coordinator.reconcile(sharedMove), sharedMove);
  assert.equal(otherSignalAborted, false, "room-move handoff fencing must not abort unrelated in-flight effects");
  releaseOther();
  assert.equal((await otherRunning).state, "completed");

  // Saga phase moving out of joining_destination during EffectExecutor's final pre-settlement await
  // settles the stale room-move effect atomically as failed (without authoritative_rejection or a zombie prepared row).
  const phaseLost = harness();
  const phaseMove = roomMove({ phase: "joining_destination" });
  phaseLost.setMove(phaseMove);
  phaseLost.effectDb.exec(`
    CREATE TABLE agent_room_moves (
      operation_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      work_attempt_id TEXT,
      execution_generation_id TEXT
    );
    INSERT INTO agent_room_moves (operation_id, agent_id, phase, work_attempt_id, execution_generation_id)
    VALUES ('move-1', 'agent-1', 'joining_destination', 'attempt-1', 'execution-1');
  `);
  let phaseJoinDone = false;
  let phaseAssertsAfterJoin = 0;
  phaseLost.setJoinRoom(async () => {
    phaseJoinDone = true;
    return { roomId: "canonical-destination" };
  });
  phaseLost.setAssertCurrent(async () => {
    if (phaseJoinDone) {
      phaseAssertsAfterJoin += 1;
      if (phaseAssertsAfterJoin === 2) {
        phaseLost.effectDb.prepare("UPDATE agent_room_moves SET phase = 'rollback_required' WHERE operation_id = 'move-1'").run();
      }
    }
  });
  const afterPhaseLoss = await phaseLost.coordinator.reconcile(phaseMove);
  assert.equal(afterPhaseLoss.phase, "joining_destination", "must not misclassify phase loss as authoritative HTTP 403 rejection");
  const [phaseLostEffect] = listEffectsForAgent(phaseLost.effectDb, "agent-1", { kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND });
  assert.equal(phaseLostEffect?.state, "failed");
  assert.equal(phaseLostEffect?.outcome, null);
  assert.match(phaseLostEffect?.last_error ?? "", /rollback_required/);
});

test("failed room-move settlement writes recover without restart (Layer 1 + Layer 2) while fencing live in-flight and future-epoch rows", async () => {
  // Layer 1: completion-only SQLite write failure reschedules executing -> prepared.
  const l1 = harness();
  l1.setMove(roomMove({ phase: "joining_destination" }));
  let l1Calls = 0;
  l1.setJoinRoom(async () => { l1Calls += 1; return { roomId: "canonical-destination" }; });
  l1.effectDb.exec(`
    CREATE TRIGGER fail_rm_join_complete
    BEFORE UPDATE OF state ON effects
    WHEN NEW.kind = '${ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND}' AND NEW.state = 'completed'
    BEGIN SELECT RAISE(ABORT, 'simulated_rm_complete_failure'); END;
  `);
  const first = await l1.coordinator.reconcile(roomMove({ phase: "joining_destination" }));
  assert.equal(l1Calls, 1);
  assert.equal(first.phase, "joining_destination");
  const [l1Effect] = listEffectsForAgent(l1.effectDb, "agent-1", { kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND });
  assert.equal(l1Effect?.state, "prepared");
  assert.equal(l1Effect?.last_error, "settlement_write_failed");

  l1.effectDb.exec("DROP TRIGGER fail_rm_join_complete;");
  const recoveredL1 = await l1.coordinator.reconcile(first);
  assert.equal(l1Calls, 2);
  assert.equal(recoveredL1.phase, "rotating_credentials");
  assert.equal(getEffect(l1.effectDb, l1Effect!.id)?.state, "completed");

  // Layer 2: full update outage leaves row executing, next reconcile recovers without restart.
  const l2 = harness();
  l2.setMove(roomMove({ phase: "rollback_required", remote_room_id: "canonical-destination" }));
  l2.setEntry(entry("canonical-destination"));
  l2.setBinding(workerBinding("canonical-destination"));
  let l2Calls = 0;
  l2.setJoinRoom(async () => { l2Calls += 1; return { roomId: "source-room" }; });
  l2.effectDb.exec(`
    CREATE TRIGGER fail_rm_rollback_all_updates
    BEFORE UPDATE ON effects
    WHEN OLD.kind = '${ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND}' AND OLD.state = 'executing'
    BEGIN SELECT RAISE(ABORT, 'simulated_rm_outage'); END;
  `);
  const stuckRollback = await l2.coordinator.reconcile(l2.getMove()!);
  assert.equal(l2Calls, 1);
  assert.equal(stuckRollback.phase, "rollback_required");
  const [stuckEffect] = listEffectsForAgent(l2.effectDb, "agent-1", { kind: ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND });
  assert.equal(stuckEffect?.state, "executing");

  l2.effectDb.exec("DROP TRIGGER fail_rm_rollback_all_updates;");
  const recoveredL2 = await l2.coordinator.reconcile(stuckRollback);
  assert.equal(l2Calls, 2);
  assert.equal(recoveredL2.phase, "failed");
  assert.equal(getEffect(l2.effectDb, stuckEffect!.id)?.state, "completed");

  // Live in-flight executing row (isEffectActive === true) is joined rather than rescheduled or duplicated.
  const live = harness();
  const liveMove = roomMove({ phase: "joining_destination" });
  live.setMove(liveMove);
  let liveCalls = 0;
  let releaseLiveJoin!: (value: { roomId: string }) => void;
  let markLiveJoinStarted!: () => void;
  const liveJoinStarted = new Promise<void>((resolve) => { markLiveJoinStarted = resolve; });
  live.setJoinRoom(async () => {
    liveCalls += 1;
    markLiveJoinStarted();
    return new Promise<{ roomId: string }>((resolve) => { releaseLiveJoin = resolve; });
  });
  const prePrepared = await live.executor.prepare({
    agent_id: "agent-1",
    kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
    idempotency_key: roomMoveJoinDestinationIdempotencyKey({
      operationId: liveMove.operation_id,
      destinationRoomId: liveMove.destination_room_id,
    }),
    payload: {
      operation_id: liveMove.operation_id,
      source_room_id: liveMove.source_room_id,
      destination_room_id: liveMove.destination_room_id,
      work_attempt_id: liveMove.work_attempt_id,
      execution_generation_id: liveMove.execution_generation_id,
    },
    retryable: true,
    max_attempts: 1_000_000,
  });
  const directRun = live.executor.runEffect(prePrepared.effect.id);
  await liveJoinStarted;
  assert.equal(live.executor.isEffectActive(prePrepared.effect.id), true);
  const reconciledWhileActive = live.coordinator.reconcile(liveMove);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(liveCalls, 1, "reconcile joins live in-flight executing effect without rescheduling or duplicating HTTP");
  releaseLiveJoin({ roomId: "canonical-destination" });
  assert.equal((await directRun).state, "completed");
  assert.equal((await reconciledWhileActive).phase, "rotating_credentials");
  assert.equal(liveCalls, 1);

  // Future-epoch executing row is refused fail-closed without replaying HTTP.
  const future = harness();
  const futureMove = roomMove({ phase: "joining_destination" });
  future.setMove(futureMove);
  let futureCalls = 0;
  future.setJoinRoom(async () => { futureCalls += 1; return { roomId: "canonical-destination" }; });
  future.effectDb.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES ('eff-future-rm', 'agent-1', ?, ?, ?, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
  `).run(
    ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
    roomMoveJoinDestinationIdempotencyKey({ operationId: futureMove.operation_id, destinationRoomId: futureMove.destination_room_id }),
    GENERATION + 5,
    JSON.stringify({
      destination_room_id: futureMove.destination_room_id,
      execution_generation_id: futureMove.execution_generation_id,
      operation_id: futureMove.operation_id,
      source_room_id: futureMove.source_room_id,
      work_attempt_id: futureMove.work_attempt_id,
    }),
    NOW_ISO,
    NOW_ISO,
  );
  const fenced = await future.coordinator.reconcile(futureMove);
  assert.equal(futureCalls, 0, "stale generation never replays a future-epoch executing room-move effect");
  assert.equal(fenced.phase, "joining_destination");
  assert.equal(getEffect(future.effectDb, "eff-future-rm")?.state, "executing");
});

test("authorizeClaim refuses stale saga phases against agent_room_moves and terminal room-move effects stay bounded", async () => {
  const h = harness();
  h.effectDb.exec(`
    CREATE TABLE agent_room_moves (
      operation_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      work_attempt_id TEXT,
      execution_generation_id TEXT
    );
    INSERT INTO agent_room_moves (operation_id, agent_id, phase, work_attempt_id, execution_generation_id)
    VALUES ('move-terminal', 'agent-1', 'failed', 'attempt-1', 'execution-1');
  `);
  let calls = 0;
  h.setJoinRoom(async () => { calls += 1; return { roomId: "canonical-destination" }; });

  const prepared = await h.executor.prepare({
    agent_id: "agent-1",
    kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
    idempotency_key: roomMoveJoinDestinationIdempotencyKey({
      operationId: "move-terminal",
      destinationRoomId: "destination-alias",
    }),
    payload: {
      operation_id: "move-terminal",
      source_room_id: "source-room",
      destination_room_id: "destination-alias",
      work_attempt_id: "attempt-1",
      execution_generation_id: "execution-1",
    },
    retryable: true,
    max_attempts: 1_000_000,
  });
  await assert.rejects(() => h.executor.runEffect(prepared.effect.id), EffectClaimRefusedError);
  assert.equal(calls, 0);
  assert.equal(getEffect(h.effectDb, prepared.effect.id)?.state, "failed");

  // Seed >512 terminal room-move effects plus one active prepared row and confirm pruning keeps exact cap.
  const seedCount = ROOM_MOVE_RETAINED_TERMINAL_EFFECTS_PER_AGENT + 20;
  h.effectDb.exec("BEGIN IMMEDIATE");
  const insert = h.effectDb.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES (?, 'agent-1', ?, ?, ?, 'completed', '{"seeded":true}', '{"remote_room_id":"r"}', 1, 1, 1000000, NULL, NULL, ?, ?)
  `);
  for (let i = 0; i < seedCount; i += 1) {
    const ts = new Date(Date.parse("2026-08-01T00:00:00Z") + i * 1000).toISOString();
    insert.run(`eff-rm-old-${i}`, ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND, `rmj:v1:seed-${i}`, GENERATION, ts, ts);
  }
  h.effectDb.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES ('eff-rm-active-keep', 'agent-1', ?, 'rmj:v1:keep-active', ?, 'prepared', '{"keep":true}', NULL, 1, 0, 1000000, NULL, NULL, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `).run(ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND, GENERATION);
  h.effectDb.prepare(`
    INSERT INTO agent_room_moves (operation_id, agent_id, phase, work_attempt_id, execution_generation_id)
    VALUES ('move-1', 'agent-1', 'joining_destination', 'attempt-1', 'execution-1')
  `).run();
  h.effectDb.exec("COMMIT");

  h.setMove(roomMove({ phase: "joining_destination" }));
  const completed = await h.coordinator.reconcile(roomMove({ phase: "joining_destination" }));
  assert.equal(completed.phase, "rotating_credentials");
  assert.equal(getEffect(h.effectDb, "eff-rm-active-keep")?.state, "prepared");
  assert.equal(getEffect(h.effectDb, "eff-rm-old-0"), null);
  const terminalCount = Number((h.effectDb.prepare(`
    SELECT COUNT(*) AS n FROM effects
    WHERE agent_id = 'agent-1' AND kind IN (?, ?, ?) AND state IN ('completed', 'failed')
  `).get(
    ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
    ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND,
    ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND,
  ) as { n: number }).n);
  assert.equal(terminalCount, ROOM_MOVE_RETAINED_TERMINAL_EFFECTS_PER_AGENT);
});
