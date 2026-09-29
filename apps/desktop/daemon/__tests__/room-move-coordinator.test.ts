import assert from "node:assert/strict";
import test from "node:test";

import { SupervisorGrantRequestError } from "../cloud-http.js";
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
  setJoinRoom: (joinRoom: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["joinRoom"]>) => void;
  setLatest: (latest: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["latest"]>) => void;
  setActivatingTurn: (item: SupervisedInboxItem, failure: "failed" | "interrupted" | null) => void;
};

function harness(): Harness {
  const events: string[] = [];
  let currentMove: DaemonRoomMoveRecord | null = roomMove();
  let pendingMoves: DaemonRoomMoveRecord[] | null = null;
  let currentEntry: DaemonManifestEntry | undefined = entry();
  let currentBinding: WorkerSessionBinding | null = workerBinding();
  let credential: string | null = "worker-secret";
  let handoff = false;
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
      assertCurrent: async () => { events.push("authority:assert"); },
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

  return {
    coordinator: new RoomMoveCoordinator(ports),
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
