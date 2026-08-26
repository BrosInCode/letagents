import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedEffectCoordinator,
  type BoundedEffectContext,
  type BoundedEffectCoordinatorOptions,
  type CompleteBoundedEffectInput,
  type ExecuteBoundedToolInput,
  type PrepareBoundedEffectInput,
} from "../bounded-effect-coordinator.js";
import { structuredRoomTurnCompletion, type SupervisedEffectRecord } from "../supervised-agent-inbox-store.js";
import type { DaemonToolAgentSession, SupervisedToolRuntime } from "../supervised-tool-runtime.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const coordinates = {
  entryId: "agent-a",
  workAttemptId: "attempt-a",
  executionGenerationId: "execution-current",
  daemonGeneration: 7,
  providerTurnId: "turn-a",
};

function executeInput(overrides: Partial<ExecuteBoundedToolInput> = {}): ExecuteBoundedToolInput {
  return {
    ...coordinates,
    mcpRequestId: "request-a",
    toolName: "send_message",
    input: { text: "hello" },
    ...overrides,
  };
}

function prepareInput(overrides: Partial<PrepareBoundedEffectInput> = {}): PrepareBoundedEffectInput {
  return {
    ...executeInput(overrides),
    mutation: overrides.mutation ?? true,
  };
}

function completeInput(overrides: Partial<CompleteBoundedEffectInput> = {}): CompleteBoundedEffectInput {
  return {
    ...coordinates,
    effectId: "effect-a",
    result: { ok: true },
    ...overrides,
  };
}

function effect(overrides: Partial<SupervisedEffectRecord> = {}): SupervisedEffectRecord {
  return {
    effect_id: "effect-a",
    agent_id: "agent-a",
    room_id: "room-a",
    execution_generation_id: "execution-origin",
    provider_turn_id: "turn-a",
    mcp_request_id: "request-a",
    tool_name: "send_message",
    request: { text: "hello" },
    mutation: true,
    state: "prepared",
    result: null,
    error: null,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function session(provider = "codex"): DaemonToolAgentSession {
  return {
    session_id: "session-a",
    session_token: "unused-public-shape",
    room_id: "room-a",
    session_kind: "worker",
    runtime: provider,
    actor_label: "Agent",
    agent_key: "agent-key-a",
    agent_instance_id: "daemon:agent-a",
    display_name: "Agent",
    owner_label: "Owner",
    ide_label: "Desktop",
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    last_seen_at: "2026-08-26T00:00:00.000Z",
    ended_at: null,
  };
}

function boundedContext(provider = "codex"): BoundedEffectContext {
  return {
    entry: { id: "agent-a", room_id: "room-a", provider, workspace_path: "/workspace/a" },
    agent: {
      agentSessionId: "session-a",
      bearer: "bearer-a",
      apiUrl: "https://letagents.test",
      workAttemptId: "attempt-a",
      executionGenerationId: "execution-current",
      providerContinuationId: "continuation-a",
    },
    binding: { credential_ref: "bearer-id-a" },
    active: { inboxItemId: "inbox-a", sourceMessageId: "source-a", phase: "responding" },
    inbox: { inbox_item_id: "inbox-a", provider_turn_id: "turn-a" },
    providerTurnBinding: { origin_execution_generation_id: "execution-origin" },
  };
}

type HarnessOptions = {
  provider?: string;
  prepareResult?: { created: boolean; effect: SupervisedEffectRecord };
  roomMoveResult?: { created: boolean; effect: SupervisedEffectRecord };
  markResult?: SupervisedEffectRecord;
  runtimeMutation?: boolean;
  missingEntry?: boolean;
  execute?: SupervisedToolRuntime["executeDaemonTool"];
  complete?: BoundedEffectCoordinatorOptions["journal"]["complete"];
};

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const context = boundedContext(options.provider);
  let contextCalls = 0;
  let capturedPrepare: Record<string, unknown> | null = null;
  let capturedRoomMove: Record<string, unknown> | null = null;
  let capturedExecution: Record<string, unknown> | null = null;
  let capturedCompletion: Record<string, unknown> | null = null;
  const runtimeSession = session(context.entry.provider);
  const prepareResult = options.prepareResult ?? { created: true, effect: effect() };
  const roomMoveResult = options.roomMoveResult ?? {
    created: true,
    effect: effect({ tool_name: "join_room" }),
  };
  const markResult = options.markResult ?? effect({ state: "executing" });
  const execute = options.execute ?? (async (input) => {
    capturedExecution = input as unknown as Record<string, unknown>;
    events.push("runtime:execute");
    return { liveResult: { live: true }, durableResult: { durable: true } };
  });
  let subject!: BoundedEffectCoordinator;
  subject = new BoundedEffectCoordinator({
    context: {
      exactActive: async () => {
        contextCalls += 1;
        events.push(`context:${contextCalls}`);
        return context;
      },
    },
    entries: {
      get: async () => {
        events.push("entry:get");
        if (options.missingEntry) return undefined;
        return { id: context.entry.id, provider: context.entry.provider, work_attempt_id: "attempt-a" };
      },
    },
    authorizations: {
      get: () => {
        events.push("authorization:get");
        return {
          agentSessionId: "session-a",
          bearer: "bearer-a",
          bearerId: "bearer-id-a",
          roomId: "room-a",
          agentKey: "agent-key-a",
          agentSession: runtimeSession,
        };
      },
    },
    journal: {
      prepare: async (input, fence) => {
        capturedPrepare = input;
        events.push("journal:prepare");
        await fence(async () => { events.push("commit:prepare"); });
        return prepareResult;
      },
      markExecuting: async (_input, fence) => {
        events.push("journal:mark");
        await fence(async () => { events.push("commit:mark"); });
        return markResult;
      },
      complete: options.complete ?? (async (input, fence) => {
        capturedCompletion = input;
        events.push("journal:complete");
        await fence(async () => { events.push("commit:complete"); });
        return effect({ state: input.error ? "failed" : "completed", result: input.result ?? null, error: input.error ?? null });
      }),
    },
    roomMoves: {
      prepare: async (input, fence) => {
        capturedRoomMove = input;
        events.push("room-move:prepare");
        await fence(async () => { events.push("commit:room-move"); });
        return roomMoveResult;
      },
    },
    runtime: {
      load: async () => {
        events.push("runtime:load");
        return {
          supervisedToolIsMutation: () => {
            events.push("runtime:classify");
            return options.runtimeMutation ?? true;
          },
          executeDaemonTool: execute,
        };
      },
    },
    executionCompletion: {
      complete: (input, admittedDaemonExecution) => {
        events.push("execution-completion");
        return subject.completeOnce(input, admittedDaemonExecution);
      },
    },
    authority: {
      assertCurrent: async () => { events.push("authority:assert"); },
      currentGeneration: () => {
        events.push("authority:generation");
        return 7;
      },
      fenceCommit: async (commit) => {
        events.push("fence:ordinary");
        await commit();
      },
      fenceAdmittedTransitionCommit: async (commit) => {
        events.push("fence:admitted");
        await commit();
      },
    },
    policy: { structuredRoomTurnCompletion },
  });
  return {
    subject,
    events,
    context,
    get contextCalls() { return contextCalls; },
    get capturedPrepare() { return capturedPrepare; },
    get capturedRoomMove() { return capturedRoomMove; },
    get capturedExecution() { return capturedExecution; },
    get capturedCompletion() { return capturedCompletion; },
  };
}

test("journal and external-execution reservations drain independently and clean up every settlement path", async () => {
  const { subject } = harness();
  const journalGate = deferred<void>();
  const executionGate = deferred<void>();
  const journal = subject.reserveJournal(() => journalGate.promise);
  const execution = subject.reserveExecution(() => executionGate.promise);

  let journalDrained = false;
  const drainJournal = subject.drainJournalReservations().then(() => { journalDrained = true; });
  let executionDrained = false;
  const drainExecution = subject.drainExternalExecutions().then(() => { executionDrained = true; });
  await flushMicrotasks();
  assert.equal(journalDrained, false);
  assert.equal(executionDrained, false);

  journalGate.resolve();
  await journal;
  await drainJournal;
  assert.equal(journalDrained, true);
  assert.equal(executionDrained, false, "journal drain must not adopt external execution work");

  executionGate.resolve();
  await execution;
  await drainExecution;
  assert.equal(executionDrained, true);

  assert.throws(
    () => subject.reserveJournal(() => { throw new Error("synchronous journal failure"); }),
    /synchronous journal failure/,
  );
  await subject.drainJournalReservations();
  await assert.rejects(subject.reserveExecution(async () => { throw new Error("execution failure"); }), /execution failure/);
  await subject.drainExternalExecutions();
});

test("prepare preserves validation order and exact public errors", async () => {
  const invalidIdentity = harness();
  await assert.rejects(
    invalidIdentity.subject.prepareOnce(prepareInput({ mcpRequestId: "" })),
    /A supervised effect requires MCP request and tool identities\./,
  );
  assert.equal(invalidIdentity.contextCalls, 0, "identity validation precedes authority resolution");

  const codexCompletion = harness({ provider: "codex" });
  await assert.rejects(
    codexCompletion.subject.prepareOnce(prepareInput({
      toolName: "complete_room_turn",
      input: { outcome: "reply", text: "done" },
    })),
    /structured room-turn completion channel is reserved for supervised Cursor turns/,
  );

  const malformedCompletion = harness({ provider: "cursor" });
  await assert.rejects(
    malformedCompletion.subject.prepareOnce(prepareInput({
      toolName: "complete_room_turn",
      input: { outcome: "reply", text: "" },
    })),
    /supervised room-turn completion proposal is malformed/,
  );

  const sameRoomMove = harness();
  await assert.rejects(
    sameRoomMove.subject.prepareOnce(prepareInput({ toolName: "join_room", input: { name: " room-a " } })),
    /A room move requires a different valid destination room\./,
  );
});

test("join_room uses only the room-move port and preserves exact durable coordinates", async () => {
  const state = harness();
  const result = await state.subject.prepareOnce(prepareInput({
    toolName: "join_room",
    input: { name: " destination-room " },
  }));

  assert.deepEqual(result, {
    state: "prepared",
    effect_id: "effect-a",
    action: "room_move_prepared",
    destination_room: "destination-room",
    room_id: "room-a",
  });
  assert.deepEqual(state.capturedRoomMove, {
    agent_id: "agent-a",
    room_id: "room-a",
    effect_execution_generation_id: "execution-origin",
    provider_turn_id: "turn-a",
    mcp_request_id: "request-a",
    request: { name: " destination-room " },
    destination_room_id: "destination-room",
    daemon_generation: 7,
    work_attempt_id: "attempt-a",
    execution_generation_id: "execution-current",
    provider_continuation_id: "continuation-a",
    agent_session_id: "session-a",
    activating_inbox_item_id: "inbox-a",
  });
  assert.equal(state.capturedPrepare, null);
  assert.deepEqual(state.events, [
    "context:1",
    "authority:generation",
    "room-move:prepare",
    "fence:ordinary",
    "commit:room-move",
  ]);
});

test("prepare preserves idempotent terminal, uncertain, duplicate, and final-answer outcomes", async () => {
  const completed = harness({
    prepareResult: { created: false, effect: effect({ state: "completed", result: { prior: true } }) },
  });
  assert.deepEqual(await completed.subject.prepareOnce(prepareInput()), {
    state: "completed",
    result: { prior: true },
    room_id: "room-a",
  });
  assert.equal(completed.events.includes("journal:mark"), false);

  const uncertain = harness({
    prepareResult: { created: false, effect: effect({ state: "uncertain", error: null }) },
  });
  assert.deepEqual(await uncertain.subject.prepareOnce(prepareInput()), {
    state: "uncertain",
    effect_id: "effect-a",
    mutation: true,
    error: "The mutating tool outcome is uncertain.",
    room_id: "room-a",
  });

  const failed = harness({
    prepareResult: { created: false, effect: effect({ state: "failed", error: "prior failure" }) },
  });
  await assert.rejects(failed.subject.prepareOnce(prepareInput()), /prior failure/);

  const executing = harness({
    prepareResult: { created: false, effect: effect({ state: "executing" }) },
  });
  await assert.rejects(
    executing.subject.prepareOnce(prepareInput()),
    /prior supervised effect is still executing; refusing a duplicate side effect/,
  );

  const finalAnswer = harness();
  assert.deepEqual(await finalAnswer.subject.prepareOnce(prepareInput({
    toolName: "send_message",
    input: { reply_to: "source-a", text: "answer" },
  })), {
    state: "prepared",
    effect_id: "effect-a",
    action: "use_final_answer",
    source_message_id: "source-a",
    room_id: "room-a",
  });
  assert.equal(finalAnswer.events.includes("journal:mark"), false);
});

test("execute turns non-I/O journal actions into the exact supervised instructions", async () => {
  const uncertain = harness({
    prepareResult: {
      created: false,
      effect: effect({ state: "uncertain", error: "outcome unknown" }),
    },
  });
  const uncertainResult = await uncertain.subject.execute(executeInput()) as {
    result: { structuredContent: Record<string, unknown> };
  };
  assert.deepEqual(uncertainResult.result.structuredContent, {
    code: "SUPERVISED_EFFECT_OUTCOME_UNCERTAIN",
    effect_id: "effect-a",
    detail: "outcome unknown",
    instruction: "This mutating tool may already have completed, but its result was not durably checkpointed. Verify the external state before issuing a new request; this exact request will not be repeated automatically.",
  });
  assert.equal(uncertain.events.includes("authorization:get"), false);
  assert.equal(uncertain.events.includes("runtime:execute"), false);

  const finalAnswer = harness({ provider: "cursor" });
  const finalAnswerResult = await finalAnswer.subject.execute(executeInput({
    input: { reply_to: "source-a", text: "answer" },
  })) as { result: { structuredContent: Record<string, unknown> } };
  assert.deepEqual(finalAnswerResult.result.structuredContent, {
    code: "USE_FINAL_ANSWER",
    source_message_id: "source-a",
    instruction: "Do not send the activating room reply with a message tool. Keep working, then record the one public answer with complete_room_turn; Cursor's aggregate final text is live evidence only.",
  });
  assert.equal(finalAnswer.events.includes("runtime:execute"), false);

  const roomMove = harness({ provider: "codex" });
  const roomMoveResult = await roomMove.subject.execute(executeInput({
    toolName: "join_room",
    input: { name: "destination-room" },
  })) as { result: { structuredContent: Record<string, unknown> } };
  assert.deepEqual(roomMoveResult.result.structuredContent, {
    code: "ROOM_MOVE_PREPARED",
    destination_room: "destination-room",
    instruction: "The room move is prepared. Finish this turn normally; the daemon will publish the activating response and then move the agent.",
  });
  assert.equal(roomMove.events.includes("runtime:execute"), false);
});

test("execute classifies before preparation, revalidates authority, executes, then commits admitted success", async () => {
  const state = harness({ runtimeMutation: false });
  const result = await state.subject.execute(executeInput({ toolName: "read_messages", input: { limit: 1 } }));

  assert.deepEqual(result, { state: "completed", room_id: "room-a", result: { live: true } });
  assert.equal(state.contextCalls, 2, "authority is resolved once for prepare and again before external I/O");
  assert.equal(state.capturedPrepare?.mutation, false);
  assert.deepEqual(state.capturedExecution, {
    provider: "codex",
    toolName: "read_messages",
    input: { limit: 1 },
    requestId: "request-a",
    roomId: "room-a",
    apiUrl: "https://letagents.test",
    bearer: "bearer-a",
    cwd: "/workspace/a",
    agentSession: session("codex"),
  });
  assert.deepEqual(state.capturedCompletion, {
    effect_id: "effect-a",
    result: { durable: true },
    error: undefined,
    expected: {
      agent_id: "agent-a",
      work_attempt_id: "attempt-a",
      provider_turn_id: "turn-a",
    },
  });
  assert.deepEqual(state.events, [
    "runtime:load",
    "runtime:classify",
    "context:1",
    "journal:prepare",
    "fence:ordinary",
    "commit:prepare",
    "journal:mark",
    "fence:ordinary",
    "commit:mark",
    "context:2",
    "authorization:get",
    "runtime:execute",
    "execution-completion",
    "authority:assert",
    "authority:generation",
    "entry:get",
    "journal:complete",
    "fence:admitted",
    "commit:complete",
  ]);
  await state.subject.drainJournalReservations();
  await state.subject.drainExternalExecutions();
});

test("execution failure attempts admitted journal settlement but preserves the original error", async () => {
  const original = new Error("external execution failed");
  let completionInput: Record<string, unknown> | null = null;
  const state = harness({
    execute: async () => { throw original; },
    complete: async (input) => {
      completionInput = input;
      throw new Error("journal settlement also failed");
    },
  });

  await assert.rejects(
    state.subject.execute(executeInput()),
    (error) => error === original,
  );
  assert.deepEqual(completionInput, {
    effect_id: "effect-a",
    result: undefined,
    error: "external execution failed",
    expected: {
      agent_id: "agent-a",
      work_attempt_id: "attempt-a",
      provider_turn_id: "turn-a",
    },
  });
  await state.subject.drainJournalReservations();
  await state.subject.drainExternalExecutions();
});

test("complete preserves validation order, Cursor capability enforcement, and fence selection", async () => {
  const stale = harness();
  await assert.rejects(
    stale.subject.completeOnce(completeInput({ daemonGeneration: 6 })),
    /completion belongs to a stale daemon generation/,
  );
  assert.deepEqual(stale.events, ["authority:assert", "authority:generation"]);

  const cursor = harness({ provider: "cursor" });
  await assert.rejects(
    cursor.subject.completeOnce(completeInput({ providerTurnId: "" })),
    /Cursor supervised effect completion requires its exact provider turn capability/,
  );
  assert.deepEqual(cursor.events, ["authority:assert", "authority:generation", "entry:get"]);

  const missing = harness({ missingEntry: true });
  await assert.rejects(
    missing.subject.completeOnce(completeInput()),
    /completion lost its exact agent work authority/,
  );
  assert.deepEqual(missing.events, ["authority:assert", "authority:generation", "entry:get"]);

  const ordinary = harness();
  assert.deepEqual(await ordinary.subject.complete(completeInput()), { completed: true });
  assert.equal(ordinary.events.includes("fence:ordinary"), true);
  assert.equal(ordinary.events.includes("fence:admitted"), false);

  const admitted = harness();
  assert.deepEqual(await admitted.subject.completeOnce(completeInput(), true), { completed: true });
  assert.equal(admitted.events.includes("fence:ordinary"), false);
  assert.equal(admitted.events.includes("fence:admitted"), true);
});
