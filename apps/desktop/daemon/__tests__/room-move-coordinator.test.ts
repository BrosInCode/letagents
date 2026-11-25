import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { removeTestDirectory } from "../../electron/__tests__/harness.js";
import {
  productionSupervisedDeliveryHttp,
  SupervisorGrantRequestError,
} from "../cloud-http.js";
import { DaemonStateDatabase } from "../daemon-state-database.js";
import {
  applyEffectJournalSchema,
  EffectClaimRefusedError,
  EffectExecutor,
  EffectFenceError,
  getEffect,
  listEffectsForAgent,
  ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND,
  ROOM_MOVE_EFFECT_RETRY_DELAY_MS,
  ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
  ROOM_MOVE_RETAINED_TERMINAL_EFFECTS_PER_AGENT,
  ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND,
  roomMoveBootstrapTailIdempotencyKey,
  roomMoveJoinDestinationIdempotencyKey,
  roomMoveRollbackSourceIdempotencyKey,
} from "../effect-journal/index.js";
import { EntryConcurrencyGate } from "../entry-concurrency-gate.js";
import { LifecycleAdministrationCoordinator } from "../lifecycle-administration-coordinator.js";
import { ManifestStore } from "../manifest-store.js";
import {
  RoomMoveCoordinator,
  type RoomMoveCoordinatorPorts,
  type RoomMoveInboxPort,
  type RoomMoveStorePort,
} from "../room-move-coordinator.js";
import {
  SupervisedAgentInboxStore,
  type SupervisedEffectRecord,
  type SupervisedInboxItem,
  type SupervisedProviderTurnBinding,
} from "../supervised-agent-inbox-store.js";
import type { DaemonManifestEntry, DaemonRoomMoveRecord } from "../types.js";
import { WorkerBindingStore, type WorkerSessionBinding } from "../worker-binding-store.js";
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
  setCredentialFor: (fn: (binding: WorkerSessionBinding) => Promise<string | null>) => void;
  setHandoff: (handoff: boolean) => void;
  setAssertCurrent: (fn: () => Promise<void>) => void;
  setJoinRoom: (joinRoom: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["joinRoom"]>) => void;
  setLatest: (latest: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["latest"]>) => void;
  nowMs: () => number;
  advanceNow: (deltaMs: number) => void;
  setActivatingTurn: (item: SupervisedInboxItem, failure: "failed" | "interrupted" | null) => void;
};

function harness(options?: {
  useBuiltInRecoveryTimer?: boolean;
  autoConverge?: boolean;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}): Harness {
  const effectDb = new DatabaseSync(":memory:");
  applyEffectJournalSchema(effectDb);
  const events: string[] = [];
  let currentNowMs = Date.parse(NOW_ISO);
  let currentMove: DaemonRoomMoveRecord | null = roomMove();
  let pendingMoves: DaemonRoomMoveRecord[] | null = null;
  let currentEntry: DaemonManifestEntry | undefined = entry();
  let currentBinding: WorkerSessionBinding | null = workerBinding();
  let credential: string | null = "worker-secret";
  let credentialForFn: ((binding: WorkerSessionBinding) => Promise<string | null>) | null = null;
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
      async credentialFor(binding) {
        events.push("bindings:credential");
        if (credentialForFn) return credentialForFn(binding);
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
    ...(options?.useBuiltInRecoveryTimer
      ? {
          autoConverge: options.autoConverge,
          setTimeout: options.setTimeout,
          clearTimeout: options.clearTimeout,
        }
      : {
          scheduleRecovery: (agentId, delayMs) => { events.push(`recovery:${agentId}:${delayMs}`); },
        }),
    nowMs: () => currentNowMs,
    nowIso: () => new Date(currentNowMs).toISOString(),
    externalEffectSignal: () => new AbortController().signal,
  };

  const executor = new EffectExecutor({
    getDatabase: () => effectDb,
    currentDaemonGeneration: () => GENERATION,
    assertCurrent: async () => assertCurrentFn(),
    assertWriteFence: () => {},
    isClosing: () => handoff,
    nowMs: () => currentNowMs,
    nowIso: () => new Date(currentNowMs).toISOString(),
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
    setCredentialFor(fn) { credentialForFn = fn; },
    setHandoff(next) { handoff = next; },
    setAssertCurrent(fn) { assertCurrentFn = fn; },
    setJoinRoom(next) { joinRoom = next; },
    setLatest(next) { latest = next; },
    nowMs() { return currentNowMs; },
    advanceNow(deltaMs) { currentNowMs += deltaMs; },
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
  assert.equal(phaseLostEffect?.last_error, "saga_phase_disallowed");
});

test("failed room-move settlement writes recover without restart (Layer 1 + Layer 2) while fencing live in-flight and future-epoch rows", async () => {
  // Layer 1: completion-only SQLite write failure reschedules executing -> prepared with durable nonzero backoff.
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
  assert.equal(l1Effect?.next_attempt_at_ms, l1.nowMs() + ROOM_MOVE_EFFECT_RETRY_DELAY_MS);

  l1.effectDb.exec("DROP TRIGGER fail_rm_join_complete;");
  // Immediate reconcile before backoff deadline must NOT replay HTTP.
  const backedOffL1 = await l1.coordinator.reconcile(first);
  assert.equal(l1Calls, 1);
  assert.equal(backedOffL1.phase, "joining_destination");

  l1.advanceNow(ROOM_MOVE_EFFECT_RETRY_DELAY_MS);
  const recoveredL1 = await l1.coordinator.reconcile(first);
  assert.equal(l1Calls, 2);
  assert.equal(recoveredL1.phase, "rotating_credentials");
  assert.equal(getEffect(l1.effectDb, l1Effect!.id)?.state, "completed");

  // Layer 2: full update outage leaves row executing; recovery reschedules with durable nonzero backoff and succeeds once due.
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
  const recoveredBackoffL2 = await l2.coordinator.reconcile(stuckRollback);
  assert.equal(l2Calls, 1, "Layer 2 recovery enforces durable nonzero backoff before replaying HTTP");
  assert.equal(recoveredBackoffL2.phase, "rollback_required");
  const requeuedL2 = getEffect(l2.effectDb, stuckEffect!.id);
  assert.equal(requeuedL2?.state, "prepared");
  assert.equal(requeuedL2?.last_error, "recovered_inactive_executing_effect");
  assert.equal(requeuedL2?.next_attempt_at_ms, l2.nowMs() + ROOM_MOVE_EFFECT_RETRY_DELAY_MS);

  l2.advanceNow(ROOM_MOVE_EFFECT_RETRY_DELAY_MS);
  const recoveredL2 = await l2.coordinator.reconcile(recoveredBackoffL2);
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

test("retry HTTP rejection after settlement failure, lost response, or crash escalates to rollback_required instead of claiming pre-membership failure", async () => {
  // Case 1: Settlement-write failure loses a committed remote join receipt; retry returns HTTP 403.
  const settledLoss = harness();
  settledLoss.setMove(roomMove({ phase: "joining_destination" }));
  let remoteRoom = "source-room";
  let joinAttempt = 0;
  settledLoss.setJoinRoom(async (input) => {
    if (input.roomId === "destination-alias") {
      joinAttempt += 1;
      if (joinAttempt === 1) {
        remoteRoom = "canonical-destination";
        return { roomId: "canonical-destination" };
      }
      throw new SupervisorGrantRequestError(403, "join room");
    }
    remoteRoom = input.roomId;
    return { roomId: input.roomId };
  });
  settledLoss.effectDb.exec(`
    CREATE TRIGGER fail_rm_join_receipt_then_403
    BEFORE UPDATE OF state ON effects
    WHEN NEW.kind = '${ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND}' AND NEW.state = 'completed'
    BEGIN SELECT RAISE(ABORT, 'simulated_settlement_write_failure'); END;
  `);
  const afterSettlementFail = await settledLoss.coordinator.reconcile(roomMove({ phase: "joining_destination" }));
  assert.equal(remoteRoom, "canonical-destination");
  assert.equal(afterSettlementFail.phase, "joining_destination");

  settledLoss.effectDb.exec("DROP TRIGGER fail_rm_join_receipt_then_403;");
  settledLoss.advanceNow(ROOM_MOVE_EFFECT_RETRY_DELAY_MS);
  const afterRetry403 = await settledLoss.coordinator.reconcile(afterSettlementFail);
  assert.equal(afterRetry403.phase, "rollback_required", "retry 403 after prior attempt must require source compensation");
  assert.equal(settledLoss.events.includes("delivery:restart:agent-1"), false, "source delivery must not restart while remote room is diverged");
  const [failedJoinEffect] = listEffectsForAgent(settledLoss.effectDb, "agent-1", { kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND });
  assert.equal(failedJoinEffect?.state, "failed");
  assert.equal(failedJoinEffect?.last_error, "http_403");
  assert.deepEqual(failedJoinEffect?.outcome, { authoritative_rejection: false, ambiguous_prior_attempt: true });

  // Next reconciliation runs rollback compensation, restores remote membership to source-room, and only then marks failed.
  const compensated = await settledLoss.coordinator.reconcile(afterRetry403);
  assert.equal(remoteRoom, "source-room", "source compensation restores remote membership before terminalizing");
  assert.equal(compensated.phase, "failed");
  assert.equal(settledLoss.events.at(-1), "delivery:restart:agent-1");

  // Case 2: If rollback compensation itself cannot restore remote membership, saga stays rollback_required (truthful uncertainty).
  const uncertain = harness();
  uncertain.setMove(roomMove({ phase: "joining_destination" }));
  let uncertainRemote = "source-room";
  let uncertainAttempt = 0;
  uncertain.setJoinRoom(async (input) => {
    if (input.roomId === "destination-alias") {
      uncertainAttempt += 1;
      if (uncertainAttempt === 1) {
        uncertainRemote = "canonical-destination";
        throw new Error("connection reset after server commit");
      }
      throw new SupervisorGrantRequestError(403, "join room");
    }
    throw new SupervisorGrantRequestError(403, "source rollback denied");
  });
  const lostResponse = await uncertain.coordinator.reconcile(roomMove({ phase: "joining_destination" }));
  assert.equal(lostResponse.phase, "joining_destination");
  uncertain.advanceNow(ROOM_MOVE_EFFECT_RETRY_DELAY_MS);
  const needsRollback = await uncertain.coordinator.reconcile(lostResponse);
  assert.equal(needsRollback.phase, "rollback_required");
  const stillUncertain = await uncertain.coordinator.reconcile(needsRollback);
  assert.equal(stillUncertain.phase, "rollback_required", "failed rollback keeps truthful uncertainty instead of falsely marking failed");
  assert.equal(uncertainRemote, "canonical-destination");
  assert.equal(uncertain.events.includes("delivery:restart:agent-1"), false);

  // Case 3: Interrupted predecessor executing row recovered at startup, then retry returns HTTP 403 -> rollback_required.
  const crash = harness();
  const crashMove = roomMove({ phase: "joining_destination" });
  crash.setMove(crashMove);
  crash.effectDb.prepare(`
    INSERT INTO effects (
      id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
      retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
    ) VALUES ('eff-crash-prior', 'agent-1', ?, ?, ?, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
  `).run(
    ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
    roomMoveJoinDestinationIdempotencyKey({ operationId: crashMove.operation_id, destinationRoomId: crashMove.destination_room_id }),
    GENERATION - 1,
    JSON.stringify({
      destination_room_id: crashMove.destination_room_id,
      execution_generation_id: crashMove.execution_generation_id,
      operation_id: crashMove.operation_id,
      source_room_id: crashMove.source_room_id,
      work_attempt_id: crashMove.work_attempt_id,
    }),
    NOW_ISO,
    NOW_ISO,
  );
  await crash.executor.recoverOnStartup();
  crash.setJoinRoom(async () => { throw new SupervisorGrantRequestError(403, "join room"); });
  const crashRetry = await crash.coordinator.reconcile(crashMove);
  assert.equal(crashRetry.phase, "rollback_required");
  assert.equal(crash.events.includes("delivery:restart:agent-1"), false);

  // Control: first-attempt HTTP 403 still fails immediately without changing remote membership.
  const firstAttemptControl = harness();
  firstAttemptControl.setMove(roomMove({ phase: "joining_destination" }));
  firstAttemptControl.setJoinRoom(async () => { throw new SupervisorGrantRequestError(403, "join room"); });
  const controlFailed = await firstAttemptControl.coordinator.reconcile(roomMove({ phase: "joining_destination" }));
  assert.equal(controlFailed.phase, "failed");
  assert.match(controlFailed.error ?? "", /authoritatively rejected before local membership changed/);
  assert.equal(firstAttemptControl.events.at(-1), "delivery:restart:agent-1");
});

test("effects journal stores only bounded allowlisted error codes on malformed JSON, raw transport errors, and dispatch-context failures", async () => {
  // 1. Real productionSupervisedDeliveryHttp.latest with malformed JSON body PRIVATE_ROOM_BODY.
  const tailHarness = harness();
  tailHarness.setMove(roomMove({
    phase: "bootstrapping_destination_tail",
    remote_room_id: "canonical-destination",
    source_credentials_revoked: true,
  }));
  tailHarness.setEntry(entry("canonical-destination"));
  tailHarness.setBinding(workerBinding("canonical-destination"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("PRIVATE_ROOM_BODY", {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    tailHarness.setLatest((input) => productionSupervisedDeliveryHttp.latest!(input));
    const afterMalformed = await tailHarness.coordinator.reconcile(tailHarness.getMove()!);
    assert.equal(afterMalformed.phase, "bootstrapping_destination_tail");
    const [tailEffect] = listEffectsForAgent(tailHarness.effectDb, "agent-1", { kind: ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND });
    assert.equal(tailEffect?.state, "prepared");
    assert.equal(tailEffect?.last_error, "invalid_json_response");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 2. Thrown transport error carrying raw server text on joinRoom & rollback.
  const transportHarness = harness();
  transportHarness.setMove(roomMove({ phase: "joining_destination" }));
  transportHarness.setJoinRoom(async () => {
    throw new Error("raw server response: PRIVATE_TRANSPORT_SNIPPET");
  });
  await transportHarness.coordinator.reconcile(transportHarness.getMove()!);
  const [joinEffect] = listEffectsForAgent(transportHarness.effectDb, "agent-1", { kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND });
  assert.equal(joinEffect?.last_error, "transport_error");

  // 3. Failure thrown while resolving dispatch context during direct executor.runEffect().
  const dispatchHarness = harness();
  dispatchHarness.setCredentialFor(async () => {
    throw new Error("keychain fault containing RAW_CREDENTIAL_EXCERPT");
  });
  const preparedDispatch = await dispatchHarness.executor.prepare({
    agent_id: "agent-1",
    kind: ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND,
    idempotency_key: roomMoveRollbackSourceIdempotencyKey({
      operationId: "move-dispatch-err",
      sourceRoomId: "source-room",
    }),
    payload: {
      operation_id: "move-dispatch-err",
      source_room_id: "source-room",
      destination_room_id: "destination-alias",
      work_attempt_id: "attempt-1",
      execution_generation_id: "execution-1",
    },
    retryable: true,
    max_attempts: 1_000_000,
  });
  const afterDispatchFailure = await dispatchHarness.executor.runEffect(preparedDispatch.effect.id);
  assert.equal(afterDispatchFailure.state, "prepared");
  assert.equal(afterDispatchFailure.last_error, "dispatch_context_resolution_failed");

  const dumped = JSON.stringify([
    ...tailHarness.effectDb.prepare("SELECT payload, outcome, last_error FROM effects").all(),
    ...transportHarness.effectDb.prepare("SELECT payload, outcome, last_error FROM effects").all(),
    ...dispatchHarness.effectDb.prepare("SELECT payload, outcome, last_error FROM effects").all(),
  ]);
  assert.doesNotMatch(dumped, /PRIVATE_ROOM_BODY|PRIVATE_TRANSPORT_SNIPPET|RAW_CREDENTIAL_EXCERPT|worker-secret/);
});

test("durable EffectExecutor retry backoff blocks immediate replay across direct calls and restart until the clock advances", async () => {
  const h = harness();
  const move = roomMove({ phase: "joining_destination" });
  h.setMove(move);
  let calls = 0;
  h.setJoinRoom(async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient network outage");
    return { roomId: "canonical-destination" };
  });

  const t0 = h.nowMs();
  const first = await h.coordinator.reconcile(move);
  assert.equal(calls, 1);
  assert.equal(first.phase, "joining_destination");
  assert.equal(h.events.includes(`recovery:agent-1:${ROOM_MOVE_EFFECT_RETRY_DELAY_MS}`), true);
  const [eff] = listEffectsForAgent(h.effectDb, "agent-1", { kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND });
  assert.equal(eff?.state, "prepared");
  assert.equal(eff?.next_attempt_at_ms, t0 + ROOM_MOVE_EFFECT_RETRY_DELAY_MS);
  assert.equal(eff?.last_error, "transport_error");

  // Direct reconcile at unchanged clock t0 must NOT replay HTTP.
  await h.coordinator.reconcile(first);
  assert.equal(calls, 1, "direct reconcile before durable deadline must not replay HTTP");

  // Direct executor.runEffect at unchanged clock t0 is also fenced by SQLite claimEffectForExecution.
  await assert.rejects(() => h.executor.runEffect(eff!.id), EffectFenceError);
  assert.equal(calls, 1);

  // Simulated restart (startup recovery + reconcile at unchanged clock t0) preserves the durable deadline.
  await h.executor.recoverOnStartup();
  assert.equal(getEffect(h.effectDb, eff!.id)?.next_attempt_at_ms, t0 + ROOM_MOVE_EFFECT_RETRY_DELAY_MS);
  await h.coordinator.reconcile(first);
  assert.equal(calls, 1, "startup recovery + reconcile before durable deadline must not replay HTTP");

  // Advancing clock to 1ms before deadline still blocks; advancing to exact deadline executes attempt 2.
  h.advanceNow(ROOM_MOVE_EFFECT_RETRY_DELAY_MS - 1);
  await h.coordinator.reconcile(first);
  assert.equal(calls, 1);

  h.advanceNow(1);
  const second = await h.coordinator.reconcile(first);
  assert.equal(calls, 2);
  assert.equal(second.phase, "rotating_credentials");
  assert.equal(getEffect(h.effectDb, eff!.id)?.state, "completed");
});

test("real ManifestStore + RoomMoveCoordinator + LifecycleAdministrationCoordinator retire prepared join/tail/rollback effects on rollback/failure so purge succeeds with zero post-purge HTTP", async () => {
  async function createRealHarness() {
    const root = await mkdtemp(join(tmpdir(), "letagents-rm-real-"));
    const dbPath = join(root, "daemon-state.sqlite");
    const stateDb = await DaemonStateDatabase.open(dbPath);
    const db = stateDb.connection;
    let now = Date.parse(NOW_ISO);
    const store = new ManifestStore(dbPath);
    const inbox = new SupervisedAgentInboxStore(dbPath);
    const bindings = new WorkerBindingStore(join(root, "bindings.json"), undefined, dbPath);
    store.attachDatabase(db, () => {});
    inbox.attachDatabase(db, () => {});
    bindings.attachDatabase(db, () => {});
    await store.load();
    const runtimeCustody = new WorkerRuntimeCustody();
    const executor = new EffectExecutor({
      getDatabase: () => (db.isOpen ? db : null),
      currentDaemonGeneration: () => GENERATION,
      assertCurrent: async () => {},
      assertWriteFence: () => {},
      isClosing: () => false,
      nowMs: () => now,
    });
    let joinCalls = 0;
    let latestCalls = 0;
    let joinRoomImpl: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["joinRoom"]> = async ({ roomId }) => {
      joinCalls += 1;
      return { roomId: roomId === "destination-alias" ? "canonical-destination" : roomId };
    };
    let latestImpl: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["latest"]> = async () => {
      latestCalls += 1;
      return { messages: [{ id: "msg_dest_1" }] };
    };
    const updateManifestEntry = async (
      entryId: string,
      update: (current: DaemonManifestEntry) => DaemonManifestEntry,
    ): Promise<DaemonManifestEntry> => {
      const loaded = await store.getEntryWithVersion(entryId);
      assert.ok(loaded, `expected entry ${entryId}`);
      const next = update(loaded.entry);
      const saved = await store.replaceEntry(loaded.version, next);
      return saved.entry;
    };
    const coordinator = new RoomMoveCoordinator({
      store,
      inbox,
      bindings,
      runtimeCustody,
      deliveryHttp: {
        joinRoom: (input) => joinRoomImpl(input),
        latest: (input) => latestImpl(input),
      },
      authority: {
        currentGeneration: () => GENERATION,
        isHandoffScheduled: () => false,
        assertCurrent: async () => {},
        ownsDaemonGeneration: async (expected) => expected === GENERATION,
        fenceCommit: async (commit) => { await commit(); },
      },
      entryConcurrency: new EntryConcurrencyGate({ isHandoffScheduled: () => false }),
      serializeEntry: async (_entryId, op) => op(),
      updateManifestEntry,
      currentHandle: () => null,
      pauseIngress: () => {},
      restartDelivery: async () => {},
      scheduleRecovery: () => {},
      nowMs: () => now,
      nowIso: () => new Date(now).toISOString(),
    });
    coordinator.attachEffectExecutor(executor, db, () => {});
    const lifecycle = new LifecycleAdministrationCoordinator({
      store,
      bindings,
      durability: {
        getAttempt: async () => { throw new Error("unexpected attempt lookup"); },
        listAttempts: async () => [],
        recordTerminal: async () => {},
        releaseTerminalExecutionFence: async () => {},
        concludeAttempt: async () => { throw new Error("unexpected concludeAttempt"); },
        garbageCollectEphemeralAttempt: async () => false,
      },
      authority: {
        currentDaemonGeneration: () => GENERATION,
        assertCurrent: async () => {},
        fenceCommit: async (commit) => { await commit(); },
        serializeManifestMutation: async (op) => op(),
      },
      beginLifecycle: () => () => {},
      serializeEntry: async (_entryId, op) => op(),
      setDesiredStateExclusive: async (entryId, desiredState) => updateManifestEntry(entryId, (c) => ({ ...c, desired_state: desiredState })),
      updateManifestEntry,
      entryWithDerivedLiveness: async (current) => current,
      stopDelivery: async () => {},
      hasLiveHandle: () => false,
      runtimeCustody,
      deleteAgentStream: () => {},
      reconcileRoomMovesForPurge: (entryId) => { coordinator.recoverInactiveExecutingForAgent(entryId); },
      ephemeralProvisioner: { garbageCollectOrphans: async () => [] },
      nowMs: () => now,
    });
    const seedRunningAgent = async (roomId = "source-room") => {
      await store.write([entry(roomId)]);
      await bindings.bind({
        entry_id: "agent-1",
        room_id: roomId,
        api_url: "https://letagents.test",
        agent_session_id: "session-1",
        agent_session_token: "worker-secret",
        work_attempt_id: "attempt-1",
        execution_generation_id: "execution-1",
      });
    };
    const stopAndUnbindForPurge = async () => {
      const currentBinding = await bindings.get("agent-1");
      if (currentBinding) {
        await bindings.unbind("agent-1", currentBinding.agent_session_id, currentBinding.execution_generation_id);
      }
      await updateManifestEntry("agent-1", (current) => ({
        ...current,
        desired_state: "stopped",
        observed_state: "stopped",
        workspace_path: null,
        work_attempt_id: null,
        provider_ref: null,
        last_worker_binding: {
          agent_session_id: "session-1",
          work_attempt_id: "attempt-1",
          execution_generation_id: "execution-1",
          updated_at: new Date(now).toISOString(),
        },
      }));
    };
    return {
      db,
      store,
      bindings,
      executor,
      coordinator,
      lifecycle,
      seedRunningAgent,
      stopAndUnbindForPurge,
      advanceNow: (ms: number) => { now += ms; },
      setJoinRoom: (fn: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["joinRoom"]>) => { joinRoomImpl = fn; },
      setLatest: (fn: NonNullable<RoomMoveCoordinatorPorts["deliveryHttp"]["latest"]>) => { latestImpl = fn; },
      getJoinCalls: () => joinCalls,
      getLatestCalls: () => latestCalls,
      cleanup: async () => {
        executor.fence();
        await store.close().catch(() => undefined);
        await inbox.close().catch(() => undefined);
        await bindings.close().catch(() => undefined);
        stateDb.close();
        removeTestDirectory(root);
      },
    };
  }

  // Case 1: Refused room_move_join_destination -> operator rollback -> rollback_source succeeds -> purge succeeds with 0 post-purge HTTP.
  {
    const h = await createRealHarness();
    try {
      await h.seedRunningAgent("source-room");
      const { move } = await h.store.prepareRoomMove({
        operation_id: "move-join-rb",
        request_id: "req-join-rb",
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
      });
      let failDest = true;
      h.setJoinRoom(async ({ roomId }) => {
        if (roomId === "destination-alias" && failDest) throw new Error("destination 503");
        return { roomId };
      });
      const retrying = await h.coordinator.reconcile(move);
      assert.equal(retrying.phase, "joining_destination");
      const [joinBeforeRollback] = listEffectsForAgent(h.db, "agent-1", { kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND });
      assert.equal(joinBeforeRollback?.state, "prepared");

      const rolledBack = await h.coordinator.rollbackInspector({
        operationId: move.operation_id,
        entryId: "agent-1",
        detail: "operator cancelled move",
        daemonGeneration: GENERATION,
      });
      assert.equal(rolledBack.phase, "rollback_required");
      assert.equal(getEffect(h.db, joinBeforeRollback!.id)?.state, "failed");
      assert.equal(getEffect(h.db, joinBeforeRollback!.id)?.last_error, "room_move_rollback_required");

      const terminal = await h.coordinator.reconcile(rolledBack);
      assert.equal(terminal.phase, "failed");
      const [rbEffect] = listEffectsForAgent(h.db, "agent-1", { kind: ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND });
      assert.equal(rbEffect?.state, "completed");

      await h.stopAndUnbindForPurge();
      const revokePrompt = await h.lifecycle.purgeAgent("agent-1", GENERATION);
      assert.equal(revokePrompt.outcome, "revocation_required");
      const purged = await h.lifecycle.purgeAgent("agent-1", GENERATION, "session-1", false);
      assert.deepEqual(purged, { outcome: "purged" });
      assert.equal(Number((h.db.prepare("SELECT COUNT(*) AS n FROM effects WHERE agent_id='agent-1'").get() as { n: number }).n), 0);
      assert.equal(Number((h.db.prepare("SELECT COUNT(*) AS n FROM agent_room_moves WHERE agent_id='agent-1'").get() as { n: number }).n), 0);

      let postPurgeCalls = 0;
      h.setJoinRoom(async ({ roomId }) => { postPurgeCalls += 1; return { roomId }; });
      h.advanceNow(24 * 60 * 60 * 1000);
      await h.executor.recoverOnStartup();
      await h.coordinator.reconcilePrepared();
      assert.equal(postPurgeCalls, 0);
    } finally {
      await h.cleanup();
    }
  }

  // Case 2: Refused room_move_bootstrap_tail -> operator rollback -> rollback_source succeeds -> purge succeeds.
  {
    const h = await createRealHarness();
    try {
      await h.seedRunningAgent("canonical-destination");
      const { move } = await h.store.prepareRoomMove({
        operation_id: "move-tail-rb",
        request_id: "req-tail-rb",
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
      });
      const inTail = await h.store.advanceRoomMove({
        operationId: move.operation_id,
        agentId: "agent-1",
        expectedDaemonGeneration: GENERATION,
        expectedExecutionGenerationId: "execution-1",
        from: ["prepared"],
        to: "bootstrapping_destination_tail",
        remoteRoomId: "canonical-destination",
        sourceCredentialsRevoked: true,
      });
      h.setLatest(async () => { throw new Error("tail 503"); });
      const retryingTail = await h.coordinator.reconcile(inTail);
      assert.equal(retryingTail.phase, "bootstrapping_destination_tail");
      const [tailEffect] = listEffectsForAgent(h.db, "agent-1", { kind: ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND });
      assert.equal(tailEffect?.state, "prepared");

      const rolledBack = await h.coordinator.rollbackInspector({
        operationId: move.operation_id,
        entryId: "agent-1",
        detail: "operator rolled back during tail bootstrap",
        daemonGeneration: GENERATION,
      });
      assert.equal(rolledBack.phase, "rollback_required");
      assert.equal(getEffect(h.db, tailEffect!.id)?.state, "failed");
      assert.equal(getEffect(h.db, tailEffect!.id)?.last_error, "room_move_rollback_required");

      h.setJoinRoom(async ({ roomId }) => ({ roomId }));
      const terminal = await h.coordinator.reconcile(rolledBack);
      assert.equal(terminal.phase, "failed");

      await h.stopAndUnbindForPurge();
      assert.equal((await h.lifecycle.purgeAgent("agent-1", GENERATION)).outcome, "revocation_required");
      assert.deepEqual(await h.lifecycle.purgeAgent("agent-1", GENERATION, "session-1", false), { outcome: "purged" });
      assert.equal(Number((h.db.prepare("SELECT COUNT(*) AS n FROM effects WHERE agent_id='agent-1'").get() as { n: number }).n), 0);
    } finally {
      await h.cleanup();
    }
  }

  // Case 3: Refused room_move_rollback_source in backoff -> superseded by operator room change -> failed -> purge succeeds.
  {
    const h = await createRealHarness();
    try {
      await h.seedRunningAgent("canonical-destination");
      const { move } = await h.store.prepareRoomMove({
        operation_id: "move-rb-superseded",
        request_id: "req-rb-superseded",
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
      });
      const inRollback = await h.store.advanceRoomMove({
        operationId: move.operation_id,
        agentId: "agent-1",
        expectedDaemonGeneration: GENERATION,
        expectedExecutionGenerationId: "execution-1",
        from: ["prepared"],
        to: "rollback_required",
        remoteRoomId: "canonical-destination",
      });
      h.setJoinRoom(async () => { throw new Error("source rejoin 503"); });
      const retryingRb = await h.coordinator.reconcile(inRollback);
      assert.equal(retryingRb.phase, "rollback_required");
      const [rbEffect] = listEffectsForAgent(h.db, "agent-1", { kind: ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND });
      assert.equal(rbEffect?.state, "prepared");

      // Operator moves agent to a third room, superseding rollback compensation.
      const loaded = await h.store.getEntryWithVersion("agent-1");
      await h.store.replaceEntry(loaded!.version, { ...loaded!.entry, room_id: "third-room" });
      const superseded = await h.coordinator.reconcile(retryingRb);
      assert.equal(superseded.phase, "failed");
      assert.equal(getEffect(h.db, rbEffect!.id)?.state, "failed");
      assert.equal(getEffect(h.db, rbEffect!.id)?.last_error, "room_move_failed");

      await h.stopAndUnbindForPurge();
      assert.equal((await h.lifecycle.purgeAgent("agent-1", GENERATION)).outcome, "revocation_required");
      assert.deepEqual(await h.lifecycle.purgeAgent("agent-1", GENERATION, "session-1", false), { outcome: "purged" });
    } finally {
      await h.cleanup();
    }
  }
});

test("racing retry settlement fences against saga transition, live executing blocks purge, inactive executing recovers, and startup reconcilePrepared heals orphaned prepared rows", async () => {
  // 1. Racing in-flight executing join_destination getting a transport retry after saga moved to rollback_required
  //    must settle as failed (saga_phase_disallowed) instead of resurrecting a prepared row.
  const race = harness();
  const raceMove = roomMove({ phase: "joining_destination" });
  race.setMove(raceMove);
  race.effectDb.exec(`
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
  race.setJoinRoom(async () => {
    race.effectDb.prepare("UPDATE agent_room_moves SET phase = 'rollback_required' WHERE operation_id = 'move-1'").run();
    throw new Error("transient network error during concurrent rollback");
  });
  await race.coordinator.reconcile(raceMove);
  const [racedEffect] = listEffectsForAgent(race.effectDb, "agent-1", { kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND });
  assert.equal(racedEffect?.state, "failed");
  assert.equal(racedEffect?.last_error, "saga_phase_disallowed");
  assert.equal(racedEffect?.next_attempt_at_ms, null);

  // 2. Real DB: live executing room-move effect blocks purge & rolls back prepared retirement;
  //    once inactive on a terminal move, reconcileRoomMovesForPurge fails it and purge succeeds;
  //    startup recoverOnStartup + reconcilePrepared heals orphaned prepared rows immediately.
  const root = await mkdtemp(join(tmpdir(), "letagents-rm-exec-"));
  const dbPath = join(root, "daemon-state.sqlite");
  const stateDb = await DaemonStateDatabase.open(dbPath);
  const db = stateDb.connection;
  const store = new ManifestStore(dbPath);
  const inbox = new SupervisedAgentInboxStore(dbPath);
  const bindings = new WorkerBindingStore(join(root, "bindings.json"), undefined, dbPath);
  try {
    store.attachDatabase(db, () => {});
    inbox.attachDatabase(db, () => {});
    bindings.attachDatabase(db, () => {});
    await store.load();
    const now = Date.parse(NOW_ISO);
    const runtimeCustody = new WorkerRuntimeCustody();
    const executor = new EffectExecutor({
      getDatabase: () => (db.isOpen ? db : null),
      currentDaemonGeneration: () => GENERATION,
      assertCurrent: async () => {},
      assertWriteFence: () => {},
      isClosing: () => false,
      nowMs: () => now,
    });
    let releaseLiveJoin!: () => void;
    let markLiveStarted!: () => void;
    const liveStarted = new Promise<void>((resolve) => { markLiveStarted = resolve; });
    const coordinator = new RoomMoveCoordinator({
      store,
      inbox,
      bindings,
      runtimeCustody,
      deliveryHttp: {
        joinRoom: async () => {
          markLiveStarted();
          await new Promise<void>((resolve) => { releaseLiveJoin = resolve; });
          throw new Error("connection aborted");
        },
        latest: async () => ({ messages: [] }),
      },
      authority: {
        currentGeneration: () => GENERATION,
        isHandoffScheduled: () => false,
        assertCurrent: async () => {},
        ownsDaemonGeneration: async (expected) => expected === GENERATION,
        fenceCommit: async (commit) => { await commit(); },
      },
      entryConcurrency: new EntryConcurrencyGate({ isHandoffScheduled: () => false }),
      serializeEntry: async (_entryId, op) => op(),
      updateManifestEntry: async (entryId, update) => {
        const loaded = await store.getEntryWithVersion(entryId);
        const saved = await store.replaceEntry(loaded!.version, update(loaded!.entry));
        return saved.entry;
      },
      currentHandle: () => null,
      pauseIngress: () => {},
      restartDelivery: async () => {},
      scheduleRecovery: () => {},
      nowMs: () => now,
      nowIso: () => NOW_ISO,
    });
    coordinator.attachEffectExecutor(executor, db, () => {});
    const lifecycle = new LifecycleAdministrationCoordinator({
      store,
      bindings,
      durability: {
        getAttempt: async () => { throw new Error("unexpected attempt lookup"); },
        listAttempts: async () => [],
        recordTerminal: async () => {},
        releaseTerminalExecutionFence: async () => {},
        concludeAttempt: async () => { throw new Error("unexpected concludeAttempt"); },
        garbageCollectEphemeralAttempt: async () => false,
      },
      authority: {
        currentDaemonGeneration: () => GENERATION,
        assertCurrent: async () => {},
        fenceCommit: async (commit) => { await commit(); },
        serializeManifestMutation: async (op) => op(),
      },
      beginLifecycle: () => () => {},
      serializeEntry: async (_entryId, op) => op(),
      setDesiredStateExclusive: async (entryId, desiredState) => {
        const loaded = await store.getEntryWithVersion(entryId);
        const saved = await store.replaceEntry(loaded!.version, { ...loaded!.entry, desired_state: desiredState });
        return saved.entry;
      },
      updateManifestEntry: async (entryId, update) => {
        const loaded = await store.getEntryWithVersion(entryId);
        const saved = await store.replaceEntry(loaded!.version, update(loaded!.entry));
        return saved.entry;
      },
      entryWithDerivedLiveness: async (current) => current,
      stopDelivery: async () => {},
      hasLiveHandle: () => false,
      runtimeCustody,
      deleteAgentStream: () => {},
      reconcileRoomMovesForPurge: (entryId) => { coordinator.recoverInactiveExecutingForAgent(entryId); },
      ephemeralProvisioner: { garbageCollectOrphans: async () => [] },
      nowMs: () => now,
    });

    await store.write([entry("source-room")]);
    await bindings.bind({
      entry_id: "agent-1",
      room_id: "source-room",
      api_url: "https://letagents.test",
      agent_session_id: "session-1",
      agent_session_token: "worker-secret",
      work_attempt_id: "attempt-1",
      execution_generation_id: "execution-1",
    });
    await store.prepareRoomMove({
      operation_id: "move-live",
      request_id: "req-live",
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
    });
    await store.advanceRoomMove({
      operationId: "move-live",
      agentId: "agent-1",
      expectedDaemonGeneration: GENERATION,
      expectedExecutionGenerationId: "execution-1",
      from: ["prepared"],
      to: "joining_destination",
    });
    const preparedLive = await executor.prepare({
      agent_id: "agent-1",
      kind: ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
      idempotency_key: roomMoveJoinDestinationIdempotencyKey({ operationId: "move-live", destinationRoomId: "destination-alias" }),
      payload: {
        operation_id: "move-live",
        source_room_id: "source-room",
        destination_room_id: "destination-alias",
        work_attempt_id: "attempt-1",
        execution_generation_id: "execution-1",
      },
      retryable: true,
      max_attempts: 1_000_000,
    });
    const liveRun = executor.runEffect(preparedLive.effect.id);
    await liveStarted;
    assert.equal(executor.isEffectActive(preparedLive.effect.id), true);

    // Move reaches failed and agent stops while live HTTP is still in flight; also seed an extra prepared row.
    await store.advanceRoomMove({
      operationId: "move-live",
      agentId: "agent-1",
      expectedDaemonGeneration: GENERATION,
      expectedExecutionGenerationId: "execution-1",
      from: ["joining_destination"],
      to: "failed",
      error: "aborted",
    });
    db.prepare(`
      INSERT INTO effects (
        id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
        retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
      ) VALUES ('eff-extra-prep', 'agent-1', ?, 'rmt:v1:extra', ?, 'prepared', ?, NULL, 1, 1, 1000000, ?, 'transport_error', ?, ?)
    `).run(
      ROOM_MOVE_BOOTSTRAP_TAIL_EFFECT_KIND,
      GENERATION,
      JSON.stringify({ operation_id: "move-live", destination_room_id: "destination-alias", work_attempt_id: "attempt-1", execution_generation_id: "execution-1" }),
      now + 5_000,
      NOW_ISO,
      NOW_ISO,
    );
    await bindings.unbind("agent-1", "session-1", "execution-1");
    const loadedStopped = await store.getEntryWithVersion("agent-1");
    await store.replaceEntry(loadedStopped!.version, {
      ...loadedStopped!.entry,
      desired_state: "stopped",
      observed_state: "stopped",
      workspace_path: null,
      work_attempt_id: null,
      provider_ref: null,
      last_worker_binding: {
        agent_session_id: "session-1",
        work_attempt_id: "attempt-1",
        execution_generation_id: "execution-1",
        updated_at: NOW_ISO,
      },
    });

    // Live executing effect must block purge and roll back eff-extra-prep retirement.
    const blocked = await lifecycle.purgeAgent("agent-1", GENERATION);
    assert.equal(blocked.outcome, "invalid");
    assert.equal(getEffect(db, preparedLive.effect.id)?.state, "executing");
    assert.equal(getEffect(db, "eff-extra-prep")?.state, "prepared");

    // Let live execution finish -> racing retry settles cleanly as failed (saga_phase_disallowed).
    releaseLiveJoin();
    const liveSettled = await liveRun;
    assert.equal(liveSettled.state, "failed");
    assert.equal(liveSettled.last_error, "saga_phase_disallowed");

    // Seed an interrupted predecessor executing row on already-failed move-live -> recoverOnStartup + reconcilePrepared heals it immediately.
    db.prepare(`
      INSERT INTO effects (
        id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
        retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
      ) VALUES ('eff-crash-orphan', 'agent-1', ?, 'rmj:v1:crash-orphan', ?, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
    `).run(
      ROOM_MOVE_JOIN_DESTINATION_EFFECT_KIND,
      GENERATION - 1,
      JSON.stringify({ operation_id: "move-live", source_room_id: "source-room", destination_room_id: "destination-alias", work_attempt_id: "attempt-1", execution_generation_id: "execution-1" }),
      NOW_ISO,
      NOW_ISO,
    );
    await executor.recoverOnStartup();
    assert.equal(getEffect(db, "eff-crash-orphan")?.state, "prepared");
    await coordinator.reconcilePrepared();
    assert.equal(getEffect(db, "eff-crash-orphan")?.state, "failed");
    assert.equal(getEffect(db, "eff-crash-orphan")?.last_error, "saga_phase_disallowed");
    assert.equal(getEffect(db, "eff-extra-prep")?.state, "failed");
    assert.equal(getEffect(db, "eff-extra-prep")?.last_error, "saga_phase_disallowed");

    // Seed an inactive in-process executing row (same generation, !isEffectActive) -> reconcileRoomMovesForPurge fails it and purge succeeds.
    db.prepare(`
      INSERT INTO effects (
        id, agent_id, kind, idempotency_key, epoch, state, payload, outcome,
        retryable, attempt_count, max_attempts, next_attempt_at_ms, last_error, created_at, updated_at
      ) VALUES ('eff-inactive-exec', 'agent-1', ?, 'rmr:v1:inactive-exec', ?, 'executing', ?, NULL, 1, 1, 1000000, NULL, NULL, ?, ?)
    `).run(
      ROOM_MOVE_ROLLBACK_SOURCE_EFFECT_KIND,
      GENERATION,
      JSON.stringify({ operation_id: "move-live", source_room_id: "source-room", destination_room_id: "destination-alias", work_attempt_id: "attempt-1", execution_generation_id: "execution-1" }),
      NOW_ISO,
      NOW_ISO,
    );
    assert.equal((await lifecycle.purgeAgent("agent-1", GENERATION)).outcome, "revocation_required");
    assert.equal(getEffect(db, "eff-inactive-exec")?.state, "failed");
    assert.equal(getEffect(db, "eff-inactive-exec")?.last_error, "saga_phase_disallowed");
    assert.deepEqual(await lifecycle.purgeAgent("agent-1", GENERATION, "session-1", false), { outcome: "purged" });
  } finally {
    await store.close().catch(() => undefined);
    await inbox.close().catch(() => undefined);
    await bindings.close().catch(() => undefined);
    stateDb.close();
    removeTestDirectory(root);
  }
});

test("reconcile re-arms room-move recovery when temporarily excluded by an active lifecycle action, but never during handoff", async () => {
  const h = harness();
  const joining = roomMove({ phase: "joining_destination" });
  h.setMove(joining);
  let joinCalls = 0;
  h.setJoinRoom(async ({ roomId }) => { joinCalls += 1; return { roomId }; });

  const releaseLifecycle = h.gate.beginLifecycle("agent-1");
  const excluded = await h.coordinator.reconcile(joining);
  assert.equal(excluded.phase, "joining_destination");
  assert.equal(joinCalls, 0);
  assert.equal(
    h.events.includes("recovery:agent-1:250"),
    true,
    "temporary lifecycle exclusion must re-arm room-move recovery instead of dropping the retry",
  );

  // Terminal snapshots never schedule recovery even if excluded.
  h.events.length = 0;
  await h.coordinator.reconcile(roomMove({ phase: "failed" }));
  assert.equal(h.events.some((event) => event.startsWith("recovery:")), false);

  // Handoff exclusion never schedules recovery.
  h.setHandoff(true);
  await h.coordinator.reconcile(joining);
  assert.equal(h.events.some((event) => event.startsWith("recovery:")), false);
  releaseLifecycle();
});

test("built-in room-move recovery timer keeps earliest deadline, defers during lifecycle exclusion, clears on handoff/purge, and respects autoConverge", async () => {
  let nextTimerId = 1;
  const timers = new Map<number, { delayMs: number; fn: () => void }>();
  const fakeSetTimeout = ((fn: () => void, delay = 0) => {
    const id = nextTimerId++;
    timers.set(id, { delayMs: Number(delay), fn });
    return { id, unref() { return this; } } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const fakeClearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const id = (handle as unknown as { id?: number })?.id;
    if (id !== undefined) timers.delete(id);
  }) as typeof clearTimeout;

  // autoConverge: false suppresses timers completely.
  const disabled = harness({ useBuiltInRecoveryTimer: true, autoConverge: false, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout });
  disabled.coordinator.scheduleRecovery("agent-1", 500);
  assert.equal(timers.size, 0);

  // Earliest deadline wins; later deadline does not replace an earlier timer.
  const h = harness({ useBuiltInRecoveryTimer: true, autoConverge: true, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout });
  let joinCalls = 0;
  const joining = roomMove({ phase: "joining_destination" });
  h.setMove(joining);
  h.setJoinRoom(async ({ roomId }) => { joinCalls += 1; return { roomId }; });

  h.coordinator.scheduleRecovery("agent-1", 1_000);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0]!.delayMs, 1_000);
  h.coordinator.scheduleRecovery("agent-1", 5_000);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0]!.delayMs, 1_000, "later deadline must not delay earlier retry");
  h.coordinator.scheduleRecovery("agent-1", 200);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0]!.delayMs, 200, "earlier deadline replaces later retry");

  // Firing while lifecycle-excluded re-arms at 250ms without calling joinRoom.
  const releaseLifecycle = h.gate.beginLifecycle("agent-1");
  const [firstId, firstTimer] = [...timers.entries()][0]!;
  timers.delete(firstId);
  firstTimer.fn();
  assert.equal(joinCalls, 0);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0]!.delayMs, 250);
  releaseLifecycle();

  // Firing once lifecycle exclusion clears reconciles the pending move automatically.
  const [secondId, secondTimer] = [...timers.entries()][0]!;
  timers.delete(secondId);
  secondTimer.fn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(joinCalls, 1);
  assert.equal(h.getMove()?.phase, "rotating_credentials");

  // clearRecovery and clearRecoveryTimers cancel pending timers cleanly.
  h.coordinator.scheduleRecovery("agent-1", 1_000);
  assert.equal(timers.size, 1);
  h.coordinator.clearRecovery("agent-1");
  assert.equal(timers.size, 0);
  h.coordinator.scheduleRecovery("agent-1", 1_000);
  h.coordinator.scheduleRecovery("agent-2", 1_000);
  assert.equal(timers.size, 2);
  h.coordinator.clearRecoveryTimers();
  assert.equal(timers.size, 0);
});
