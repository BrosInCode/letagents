import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";
import { NO_REPLY_FAILURE, noReplyFailureKind } from "../../../../shared/room-turn-no-reply.mjs";
import { ClaudeCodeProviderAdapter } from "../main/agents/claude-code-provider-adapter.js";
import type {
  ProviderActivityEvent,
  ProviderRoomTurnResult,
  ProviderStreamEvent,
  NativeExecutionObservation,
} from "../main/agents/provider-adapter.js";
import { PROCESS_ENDED_DURING_TURN } from "../main/agents/provider-adapter.js";
import {
  CLAUDE_API_ERROR_CAPTURES,
  CLAUDE_API_FAILURE_POLICY,
  CLAUDE_FAILURE_TEXT,
  CLAUDE_INVALID_REQUESTS,
  CLAUDE_REAL_CAPTURES,
  CLAUDE_RESULT_CELLS,
  CLAUDE_RESULT_TEXT,
  claudeFollowUpText,
  claudeInvalidRequestRows,
  claudeResultEvent,
  realClaudeCapture,
  realClaudeResult,
} from "./claude-result-shapes.js";
import {
  createHarness,
  spawnRequest,
  flush,
  claudeDaemonFixture,
  nextClaudeTurnId,
  shownToOwner,
  HELD_TASK,
  CLAUDE_INVALID_REQUEST_OUTCOMES,
} from "./claude-code-provider-adapter.fixture.js";

test("Claude turn control interrupts only the active bounded turn and refuses correction side turns", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  const running = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-interrupt",
    actionId: "action-interrupt",
    sourceMessage: {},
    activation: {},
  }, {
    beforeNativeDispatch: async () => {},
    checkpointTurnStarted: async () => {},
  });
  await flush();
  const turnFrame = JSON.parse(child.written.at(-1)!) as { uuid: string };

  let checkpointedTurnId: string | null = null;
  const controlled = adapter.controlTurn!(handle, null, {
    targetTurnId: turnFrame.uuid,
    checkpointTurnStarted: async (turnId) => { checkpointedTurnId = turnId; },
    markDispatched: async () => {},
  });
  await flush();
  const controlFrame = JSON.parse(child.written.at(-1)!) as Record<string, unknown>;
  assert.equal(checkpointedTurnId, turnFrame.uuid);
  assert.equal(controlFrame.type, "control_request");

  child.emit({
    type: "result",
    subtype: "interrupted",
    is_error: true,
    session_id: handle.providerContinuationId,
    user_message_uuid: turnFrame.uuid,
  });
  assert.deepEqual(await controlled, {
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "idle",
  });
  assert.equal((await running).outcome, "interrupted");
  const writesAfterInterrupt = child.written.length;
  await assert.rejects(
    adapter.controlTurn!(handle, "Start another untracked turn."),
    /cannot start an unjournaled correction turn/,
  );
  assert.equal(child.written.length, writesAfterInterrupt);
});

test("Claude 2.1.238 UUID-less interrupt boundary settles only the daemon-fenced exact turn", async () => {
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new ClaudeCodeProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => stream.push(event),
  });
  const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const child = harness.children[0]!;
  const events: NativeExecutionObservation[] = [];
  const activities: ProviderActivityEvent[] = [];
  adapter.onExecution(handle, (event) => events.push(event));
  adapter.onActivity(handle, (event) => activities.push(event));
  const request = { inboxItemId: "inbox-uuidless-interrupt", actionId: "action-uuidless-interrupt", sourceMessage: {}, activation: {} };
  const running = adapter.runRoomTurn!(handle, request);
  await flush();
  const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id: handle.providerContinuationId });

  const controlled = adapter.controlTurn!(handle, null, {
    targetTurnId: turnId,
    checkpointTurnStarted: async () => {},
    markDispatched: async () => {},
  });
  await flush();
  const boundary = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_streaming",
    session_id: handle.providerContinuationId,
  };
  child.emit(boundary);

  assert.deepEqual(await controlled, {
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "idle",
  });
  assert.equal((await running).outcome, "interrupted");
  assert.equal(handle.observedState(), "idle");
  const terminalFacts = events.filter(({ fact }) => fact.domain === "turn"
    && fact.state === "terminal"
    && fact.providerTurnId === turnId);
  assert.equal(terminalFacts.length, 1);
  const terminalFact = terminalFacts[0]!.fact;
  assert.equal(terminalFact.domain, "turn");
  if (terminalFact.domain !== "turn") throw new Error("expected an exact turn terminal");
  assert.equal(terminalFact.turnOutcome, "interrupted");
  const rawBoundary = stream.find((event) => event.method === "result/error_during_execution");
  assert.equal(rawBoundary?.nativeLifecyclePhase, "turn_terminal");
  assert.equal((rawBoundary?.payload as Record<string, unknown>).user_message_uuid, undefined,
    "the published provider payload remains raw; exact correlation is local context");

  child.emit(boundary);
  await flush();
  assert.equal(events.filter(({ fact }) => fact.domain === "turn"
    && fact.state === "terminal"
    && fact.providerTurnId === turnId).length, 1,
  "a duplicate UUID-less boundary reuses the original typed terminal");
  const replayedBoundaries = stream.filter((event) => event.method === "result/error_during_execution");
  assert.equal(replayedBoundaries.length, 2);
  assert.equal(replayedBoundaries[1]!.nativeEventId, replayedBoundaries[0]!.nativeEventId);
  assert.equal(activities.at(-1)?.summary, "Turn interrupted");

  const next = adapter.runRoomTurn!(handle, { ...request, inboxItemId: "inbox-after-interrupt", actionId: "action-after-interrupt" });
  await flush();
  const nextId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  child.emit({
    type: "result", subtype: "success", is_error: false,
    session_id: handle.providerContinuationId, user_message_uuid: nextId, result: "reused",
  });
  assert.equal((await next).text, "reused");
});

test("Claude UUID-less interrupt compatibility stays fenced across malformed and late boundaries", async () => {
  const withoutStop = createHarness();
  const standaloneAdapter = new ClaudeCodeProviderAdapter({ dependencies: withoutStop.dependencies });
  const standaloneHandle = await standaloneAdapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const standaloneChild = withoutStop.children[0]!;
  const standaloneEvents: NativeExecutionObservation[] = [];
  standaloneAdapter.onExecution(standaloneHandle, (event) => standaloneEvents.push(event));
  const standalone = standaloneAdapter.runRoomTurn!(standaloneHandle, {
    inboxItemId: "inbox-unprompted-abort", actionId: "action-unprompted-abort", sourceMessage: {}, activation: {},
  });
  let standaloneSettled = false;
  void standalone.then(() => { standaloneSettled = true; }, () => { standaloneSettled = true; });
  await flush();
  const standaloneTurnId = (JSON.parse(standaloneChild.written.at(-1)!) as { uuid: string }).uuid;
  standaloneChild.emit({
    type: "result", subtype: "error_during_execution", is_error: true,
    terminal_reason: "aborted_streaming", session_id: standaloneHandle.providerContinuationId,
  });
  await flush();
  assert.equal(standaloneSettled, false, "an identical frame without a daemon interrupt is not exact evidence");
  assert.equal(standaloneEvents.some(({ fact }) => fact.domain === "turn" && fact.state === "terminal"), false);
  standaloneChild.emit({
    type: "result", subtype: "success", is_error: false,
    session_id: standaloneHandle.providerContinuationId, user_message_uuid: standaloneTurnId, result: "natural",
  });
  assert.equal((await standalone).text, "natural");

  for (const { name, patch } of [
    { name: "wrong terminal reason", patch: { terminal_reason: "different_reason" } },
    { name: "missing terminal reason", patch: { terminal_reason: undefined } },
    { name: "wrong session", patch: { session_id: "different-session" } },
    { name: "foreign turn UUID", patch: { user_message_uuid: "foreign-turn" } },
    { name: "empty turn UUID", patch: { user_message_uuid: "" } },
    { name: "wrong subtype", patch: { subtype: "different_subtype" } },
    { name: "non-error result", patch: { is_error: false } },
  ]) {
    const harness = createHarness();
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
    const child = harness.children[0]!;
    const running = adapter.runRoomTurn!(handle, {
      inboxItemId: "inbox-late-interrupt", actionId: "action-late-interrupt", sourceMessage: {}, activation: {},
    });
    await flush();
    const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
    const controlled = adapter.controlTurn!(handle, null, {
      targetTurnId: turnId,
      checkpointTurnStarted: async () => {},
      markDispatched: async () => {},
    });
    await flush();
    const malformedFrame: Record<string, unknown> = {
      type: "result", subtype: "error_during_execution", is_error: true,
      terminal_reason: "aborted_streaming", session_id: handle.providerContinuationId,
    };
    Object.assign(malformedFrame, patch);
    child.emit(malformedFrame);
    await assert.rejects(controlled, (error: unknown) => {
      assert.equal((error as { turnControlOutcome?: unknown }).turnControlOutcome, "uncertain");
      return true;
    }, name);

    child.emit({
      type: "result", subtype: "error_during_execution", is_error: true,
      terminal_reason: "aborted_streaming", session_id: handle.providerContinuationId,
    });
    assert.equal((await running).outcome, "interrupted",
      "the retained exact-turn context recognizes the late provider boundary");
    assert.equal(handle.observedState(), "idle");
  }
});

for (const natural of [
  { name: "success", frame: { subtype: "success", is_error: false, result: "natural result" } },
  { name: "failure", frame: { subtype: "error_during_execution", is_error: true } },
]) {
  test(`Claude exact ${natural.name} racing an interrupt remains the natural terminal`, async () => {
    const harness = createHarness();
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
    const child = harness.children[0]!;
    const running = adapter.runRoomTurn!(handle, {
      inboxItemId: `inbox-natural-${natural.name}`,
      actionId: `action-natural-${natural.name}`,
      sourceMessage: {},
      activation: {},
    });
    await flush();
    const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
    const controlled = adapter.controlTurn!(handle, null, {
      targetTurnId: turnId,
      checkpointTurnStarted: async () => {},
      markDispatched: async () => {},
    });
    await flush();
    child.emit({
      type: "result",
      session_id: handle.providerContinuationId,
      user_message_uuid: turnId,
      ...natural.frame,
    });

    await assert.rejects(controlled, (error: unknown) => {
      assert.equal((error as { turnControlOutcome?: unknown }).turnControlOutcome, "not_applied");
      return true;
    });
    if (natural.name === "success") {
      assert.equal((await running).text, "natural result");
    } else {
      assert.equal((await running).outcome, "failed");
    }
    assert.equal(handle.observedState(), "idle");
  });
}

for (const lifecycleAuthorityMode of ["typed", "typed_shadow"] as const) {
  test(`Claude success-subtype API errors settle and recover without replay (${lifecycleAuthorityMode})`, async () => {
    const harness = createHarness();
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode }));
    const child = harness.children[0]!;
    const observations: NativeExecutionObservation[] = [];
    adapter.onExecution(handle, (event) => observations.push(event));
    const request = { inboxItemId: "inbox-api-error", actionId: "action-api-error", sourceMessage: {}, activation: {} };
    // No terminal checkpoint yet: retain evidence for recovery, as after a failed durable write.
    const running = adapter.runRoomTurn(handle, request);
    await flush();
    const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
    child.emit({ type: "result", subtype: "success", is_error: true,
      session_id: handle.providerContinuationId, user_message_uuid: turnId,
      result: "API Error: Response stalled mid-stream." });
    const result = await running;
    assert.deepEqual(result, { turnId, providerContinuationId: handle.providerContinuationId,
      outcome: "failed", text: null, evidence: "stream", error: "API Error: Response stalled mid-stream." });
    assert.ok(observations.some(({ fact }) => fact.domain === "turn"
      && fact.kind === "state_changed" && fact.state === "terminal" && fact.turnOutcome === "failed"));
    assert.equal(handle.observedState(), "idle");
    const writes = child.written.length;
    const checkpointed: unknown[] = [];
    assert.deepEqual(await adapter.recoverRoomTurn(handle, { inboxItemId: request.inboxItemId, providerTurnId: turnId }, {
      checkpointTerminalResult: async (terminal) => { checkpointed.push(terminal); },
    }), result);
    assert.deepEqual(checkpointed, [result]);
    assert.equal(child.written.length, writes, "recovery must not rerun the failed command");
    const next = adapter.runRoomTurn(handle, { ...request, inboxItemId: "inbox-after-error", actionId: "action-after-error" });
    await flush();
    const nextId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
    child.emit({ type: "result", subtype: "success", is_error: false,
      session_id: handle.providerContinuationId, user_message_uuid: nextId, result: "Next message handled." });
    assert.equal((await next).text, "Next message handled.");
    assert.deepEqual(harness.signals, []);
  });
}

for (const lifecycleAuthorityMode of ["typed", "typed_shadow"] as const) {
  test(`every Claude result shape ends its room turn once: no throw, no rerun, no answer it did not prove (${lifecycleAuthorityMode})`, async () => {
    const sessionRows: Array<Record<string, unknown>> = [];
    const harness = createHarness({ sessionRows });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode }));
    const child = harness.children[0]!;
    const session_id = handle.providerContinuationId!;
    const endings: Array<{ turnId: string; outcome: string }> = [];
    adapter.onExecution(handle, ({ fact }) => {
      if (fact.domain === "turn" && fact.kind === "state_changed" && fact.state === "terminal") {
        endings.push({ turnId: fact.providerTurnId, outcome: String(fact.turnOutcome) });
      }
    });
    /** One turn of the cell: the CLI is sent the message and reports the cell's result for it. */
    const turn = async (cell: (typeof CLAUDE_RESULT_CELLS)[number], save: (result: ProviderRoomTurnResult) => Promise<void>) => {
      const writtenBefore = child.written.length;
      const request = { inboxItemId: `inbox-${writtenBefore}`, actionId: `action-${writtenBefore}`, sourceMessage: {}, activation: {} };
      const running = adapter.runRoomTurn(handle, request, { checkpointTerminalResult: async (result) => { await save(result); } });
      const settled = running.then((result) => ({ result }), (error: unknown) => ({ error: error as Error }));
      const turnId = await nextClaudeTurnId(child, writtenBefore);
      child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id });
      child.emit(claudeResultEvent(cell, session_id, turnId));
      return { request, turnId, settled: await settled, written: child.written.length };
    };
    /** What the room turn must end as. A turn that completed without text is read once more, from the session. */
    const ending = (cell: (typeof CLAUDE_RESULT_CELLS)[number], turnId: string): ProviderRoomTurnResult =>
      cell.expected === "answer" ? { turnId, outcome: "reply", text: CLAUDE_RESULT_TEXT, evidence: "stream" }
        : cell.expected === "no_answer_in_result" ? { turnId, outcome: "unreadable", text: null, evidence: "none" }
          : { turnId, providerContinuationId: session_id, outcome: cell.expected, text: null, evidence: "stream", error: cell.error!,
            ...(cell.marked ? { unrecognizedResult: true as const } : {}) };
    const withoutAnswer = (turnId: string): ProviderRoomTurnResult =>
      ({ turnId, providerContinuationId: session_id, outcome: "failed", text: null, evidence: "stream", error: NO_REPLY_FAILURE.emptyAnswer });

    for (const cell of CLAUDE_RESULT_CELLS) {
      // The turn ends on its result, and the daemon is handed that ending once.
      const saved: ProviderRoomTurnResult[] = [];
      const first = await turn(cell, async (result) => { saved.push(result); });
      assert.deepEqual(first.settled, { result: ending(cell, first.turnId) }, cell.name);
      assert.deepEqual(saved, [ending(cell, first.turnId)], cell.name);
      assert.equal(handle.observedState(), "idle", `${cell.name}: the agent can take its next message`);
      if (cell.expected === "no_answer_in_result") {
        // The daemon reads the completed turn once more. The session holds no answer either: the turn ends.
        const reread: ProviderRoomTurnResult[] = [];
        assert.deepEqual(await adapter.recoverRoomTurn(handle, { inboxItemId: first.request.inboxItemId, providerTurnId: first.turnId },
          { checkpointTerminalResult: async (result) => { reread.push(result); } }), withoutAnswer(first.turnId), cell.name);
        assert.deepEqual(reread, [withoutAnswer(first.turnId)], cell.name);
      }
      assert.equal(child.written.length, first.written, `${cell.name}: the message is not sent to Claude again`);

      // The same result when the daemon could not save it: the ending is read back, and the same, with no new turn.
      const second = await turn(cell, async () => { throw new Error("the result could not be saved"); });
      assert.match("error" in second.settled ? second.settled.error.message : "", /could not be saved/, cell.name);
      const recovered = await adapter.recoverRoomTurn(handle, { inboxItemId: second.request.inboxItemId, providerTurnId: second.turnId },
        { checkpointTerminalResult: async () => {} });
      assert.deepEqual(recovered, ending(cell, second.turnId), cell.name);
      if (cell.expected === "no_answer_in_result") {
        // This time the session does hold the answer: the second read finds it, and it is the reply.
        sessionRows.push(
          { type: "user", uuid: second.turnId, sessionId: session_id, message: { role: "user", content: [{ type: "text", text: "request" }] } },
          { type: "assistant", sessionId: session_id, message: { id: `answer-${second.turnId}`, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Found in the session." }] } });
        assert.deepEqual(await adapter.recoverRoomTurn(handle, { inboxItemId: second.request.inboxItemId, providerTurnId: second.turnId },
          { checkpointTerminalResult: async () => {} }), { turnId: second.turnId, outcome: "reply", text: "Found in the session.", evidence: "transcript" }, cell.name);
      }
      assert.equal(child.written.length, second.written, `${cell.name}: reading the ending back starts no turn`);
      assert.equal(handle.observedState(), "idle", cell.name);

      // The execution record's ending for a turn never says something else than the delivery's.
      const recorded = cell.expected === "answer" || cell.expected === "no_answer_in_result" ? "completed" : cell.expected;
      const ofThisCell = endings.splice(0);
      assert.deepEqual([...new Set(ofThisCell.map((entry) => entry.outcome))], ofThisCell.length ? [recorded] : [], cell.name);
      if (lifecycleAuthorityMode === "typed") {
        assert.deepEqual(ofThisCell.map((entry) => entry.turnId), [first.turnId, second.turnId], `${cell.name}: each turn has one ending in the record`);
      }
    }

    // After all of them the same process answers a message.
    const writtenBefore = child.written.length;
    const next = adapter.runRoomTurn(handle, { inboxItemId: "inbox-last", actionId: "action-last", sourceMessage: {}, activation: {} });
    const nextId = await nextClaudeTurnId(child, writtenBefore);
    child.emit({ type: "result", subtype: "success", is_error: false, session_id, user_message_uuid: nextId, result: "Still answering." });
    assert.deepEqual(await next, { turnId: nextId, outcome: "reply", text: "Still answering.", evidence: "stream" });
    assert.equal(harness.children.length, 1, "no result shape costs the agent its process");
    assert.deepEqual(harness.signals, []);
  });

  test(`real Claude Code results end the room turn as the CLI reported it: API errors fail with Claude's text and are never a reply (${lifecycleAuthorityMode})`, async () => {
    const sessionRows: Array<Record<string, unknown>> = [];
    const harness = createHarness({ sessionRows });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode }));
    const child = harness.children[0]!;
    const session_id = handle.providerContinuationId!;
    /** Play one captured turn: the rows and the result the CLI wrote, for this session and the turn the adapter started. */
    const play = async (name: string) => {
      const writtenBefore = child.written.length;
      const saved: ProviderRoomTurnResult[] = [];
      const request = { inboxItemId: `inbox-${name}`, actionId: `action-${name}`, sourceMessage: {}, activation: {} };
      const running = adapter.runRoomTurn(handle, request, { checkpointTerminalResult: async (result) => { saved.push(result); } });
      const turnId = await nextClaudeTurnId(child, writtenBefore);
      const capture = realClaudeCapture(CLAUDE_REAL_CAPTURES[name]!, session_id, turnId);
      // Every line the CLI wrote for the turn, in its order: the lifecycle of the command, the retries, the rows, the result.
      for (const event of capture.stream) child.emit(event);
      return { request, turnId, capture, result: await running, saved, written: child.written.length };
    };

    for (const name of Object.keys(CLAUDE_API_ERROR_CAPTURES)) {
      const played = await play(name);
      // The failure carries what Claude Code said about it in its own fields, with the name the row before the result gave it.
      assert.deepEqual(played.result, { turnId: played.turnId, providerContinuationId: session_id, outcome: "failed", text: null,
        evidence: "stream", error: realClaudeResult(played.capture).result, claudeApiFailure: CLAUDE_API_FAILURE_POLICY[name]!.facts,
        ...(CLAUDE_API_FAILURE_POLICY[name]!.refusal ? { refusal: true } : {}) }, name);
      assert.deepEqual(played.saved, [played.result], name);
      assert.equal(handle.observedState(), "idle", `${name}: the same process takes the next message`);
    }

    const answered = await play("completed_answer");
    assert.deepEqual(answered.result, { turnId: answered.turnId, outcome: "reply", text: "PROBE_OK", evidence: "stream" });

    // Claude completed the turn and wrote no answer: the daemon reads it again, from the session, and the turn ends.
    const empty = await play("completed_without_answer");
    assert.deepEqual(empty.result, { turnId: empty.turnId, outcome: "unreadable", text: null, evidence: "none" });
    sessionRows.push(...empty.capture.session);
    const ended = await adapter.recoverRoomTurn(handle, { inboxItemId: empty.request.inboxItemId, providerTurnId: empty.turnId },
      { checkpointTerminalResult: async () => {} });
    assert.deepEqual(ended, { turnId: empty.turnId, providerContinuationId: session_id, outcome: "failed", text: null, evidence: "stream",
      error: "The model finished without writing a reply." });
    assert.equal(noReplyFailureKind((ended as { error?: string }).error), "emptyAnswer",
      "it is the failure task continuity follows up once, and then leaves without blocking later messages");
    assert.equal(child.written.length, empty.written, "the message is not sent to Claude again");
    assert.equal(harness.children.length, 1);
    assert.deepEqual(harness.signals, []);
  });
}

test("a Claude turn ends without an answer only on proof that it completed: its own result's, kept until the ending is saved, or the daemon's", async () => {
  // Without that proof a session that is missing or cannot be read still proves nothing, and the turn is left for its owner.
  const harness = createHarness();
  let session: "empty" | "missing" | "unreadable" = "empty";
  harness.dependencies.readSessionRows = async () => {
    if (session === "unreadable") throw new Error("the session file could not be read");
    return session === "empty" ? [] : null;
  };
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const child = harness.children[0]!;
  const session_id = handle.providerContinuationId!;
  const emptyResult = (turnId: string) => ({ type: "result", subtype: "success", is_error: false, session_id, user_message_uuid: turnId, result: "" });
  /** A turn that Claude completes with an empty answer. `save` is the daemon saving that first reading. */
  const run = async (save: () => Promise<void> = async () => {}) => {
    const writtenBefore = child.written.length;
    const running = adapter.runRoomTurn(handle, { inboxItemId: "inbox", actionId: "action", sourceMessage: {}, activation: {} },
      { checkpointTerminalResult: save });
    const settled = running.then((result) => result.outcome, (error: Error) => error.message);
    const turnId = await nextClaudeTurnId(child, writtenBefore);
    child.emit(emptyResult(turnId));
    return { turnId, first: await settled };
  };
  const recover = (turnId: string, save: () => Promise<void> = async () => {}, savedAsUnreadable = false) =>
    adapter.recoverRoomTurn(handle, { inboxItemId: "inbox", providerTurnId: turnId, ...(savedAsUnreadable ? { savedAsUnreadable: true } : {}) },
      { checkpointTerminalResult: save });
  const endedWithoutReply = async (reading: Promise<ProviderRoomTurnResult>) => assert.deepEqual(await reading,
    { turnId: (await reading).turnId, providerContinuationId: session_id, outcome: "failed", text: null, evidence: "stream", error: NO_REPLY_FAILURE.emptyAnswer });

  // The result proved the turn completed. A session that is missing, or cannot be read, changes nothing: there is no answer to find.
  for (const state of ["missing", "unreadable"] as const) {
    session = state;
    const completed = await run();
    assert.equal(completed.first, "unreadable");
    await endedWithoutReply(recover(completed.turnId));
    // That proof was used. A later read of the same turn has only the session, and is left for the owner.
    await assert.rejects(recover(completed.turnId), state === "missing" ? /found no transcript/ : /could not be read/);
  }
  // A turn that no result spoke for is left for the owner the first time too.
  session = "missing";
  await assert.rejects(recover("a-turn-with-no-result"), /found no transcript/);
  // The daemon holds the same proof saved, for a read by a process that never saw the result.
  await endedWithoutReply(recover("a-turn-the-daemon-saved-as-unreadable", async () => {}, true));
  session = "unreadable";
  await endedWithoutReply(recover("another-turn-the-daemon-saved-as-unreadable", async () => {}, true));

  // When the daemon cannot save the ending, the proof is kept, and the next read ends the turn the same way.
  session = "empty";
  const unsavedEnding = await run();
  await assert.rejects(recover(unsavedEnding.turnId, async () => { throw new Error("the ending could not be saved"); }), /could not be saved/);
  await endedWithoutReply(recover(unsavedEnding.turnId));

  // When the daemon cannot save the first reading, the next read gives that reading again. The proof outlives it.
  const unsavedReading = await run(async () => { throw new Error("the reading could not be saved"); });
  assert.match(unsavedReading.first, /could not be saved/);
  assert.equal((await recover(unsavedReading.turnId)).outcome, "unreadable");
  await endedWithoutReply(recover(unsavedReading.turnId));
});

test("a Claude session whose last message has no answer is a turn cut off when its process ended, and a turn without a reply only on proof that it completed", async () => {
  const turnId = "turn-answerless";
  const sessionId = "sess-old";
  const harness = createHarness({ sessionRows: [
    { type: "user", uuid: turnId, sessionId, message: { content: [{ type: "text", text: "source" }] } },
    { type: "assistant", sessionId, message: { id: "assistant-thinking", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "private" }] } },
  ] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.resume({ workAttemptId: "wa-claude-1", providerContinuationId: sessionId }, spawnRequest());
  const writesBefore = harness.children[0]!.written.length;
  const recover = (said: { originProcessEnded?: true; savedAsUnreadable?: true }) =>
    adapter.recoverRoomTurn(handle, { inboxItemId: "inbox", providerTurnId: turnId, ...said }, { checkpointTerminalResult: async () => {} });

  // Nothing says that the process which ran the turn has ended: the reading is what the session holds.
  assert.deepEqual(await recover({}), { turnId, outcome: "unreadable", text: null, evidence: "none" });
  // The process ended, and nobody saw the turn's result. The CLI goes on after a message with no visible output,
  // so the session does not prove that the turn ended there: it was cut off, like any turn without an ending.
  assert.deepEqual(await recover({ originProcessEnded: true }), { turnId, providerContinuationId: sessionId, outcome: "interrupted", text: null,
    evidence: "transcript", error: PROCESS_ENDED_DURING_TURN });
  // The daemon has the turn saved as completed with no readable answer: its own result was seen, and it ended the turn.
  assert.deepEqual(await recover({ originProcessEnded: true, savedAsUnreadable: true }), { turnId, providerContinuationId: sessionId, outcome: "failed",
    text: null, evidence: "stream", error: NO_REPLY_FAILURE.emptyAnswer });
  assert.equal(harness.children[0]!.written.length, writesBefore, "no reading starts a turn");
});

test("an empty Claude result is proof for its own turn, never for the turn that is running", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const child = harness.children[0]!;
  const session_id = handle.providerContinuationId!;
  const start = async () => {
    const writtenBefore = child.written.length;
    const running = adapter.runRoomTurn(handle, { inboxItemId: "inbox", actionId: "action", sourceMessage: {}, activation: {} },
      { checkpointTerminalResult: async () => {} });
    return { running, turnId: await nextClaudeTurnId(child, writtenBefore) };
  };
  const result = (turnId: string, text: string) => ({ type: "result", subtype: "success", is_error: false, session_id, user_message_uuid: turnId, result: text });
  const recover = (turnId: string) => adapter.recoverRoomTurn(handle, { inboxItemId: "inbox", providerTurnId: turnId }, { checkpointTerminalResult: async () => {} });

  const earlier = await start();
  child.emit(result(earlier.turnId, "Answer of the earlier turn."));
  assert.equal((await earlier.running).outcome, "reply");
  // While the next turn runs, the CLI sends a second result for the earlier one, and this one is empty.
  const running = await start();
  child.emit(result(earlier.turnId, ""));
  child.emit(result(running.turnId, "Answer of the running turn."));
  assert.deepEqual(await running.running, { turnId: running.turnId, outcome: "reply", text: "Answer of the running turn.", evidence: "stream" });

  // Nothing says that the turn that was running completed without an answer: a read that finds nothing proves nothing.
  await assert.rejects(recover(running.turnId), /cannot prove.*terminal boundary/);
  // The empty result spoke for the earlier turn alone.
  assert.equal((await recover(earlier.turnId)).outcome, "unreadable");
  assert.equal((await recover(earlier.turnId) as { error?: string }).error, NO_REPLY_FAILURE.emptyAnswer);
});

for (const [tasks, ownedTasks] of [["cannot be asked about its tasks", undefined], ["holds no task", () => []]] as const) test(`a Claude agent that ${tasks}, whose turns end on real API errors, settles each as failed with Claude's text, posts none of them, and keeps answering`, async () => {
  const agent = await claudeDaemonFixture(ownedTasks ? { ownedTasks: () => [...ownedTasks()] } : {});
  try {
    const names = Object.keys(CLAUDE_API_ERROR_CAPTURES);
    for (const [index, name] of names.entries()) {
      const ordinal = index + 1;
      const turn = await agent.begin(ordinal);
      // Every line the real CLI wrote for this failure, in its order.
      const capture = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES[name]!, agent.sessionId, turn.id);
      for (const event of capture.stream) turn.child.emit(event);
      await agent.eventually(async () => (await agent.receipt(`msg_${ordinal}`))?.state === "acknowledged_failed", `${name} settles as failed`).catch(async (error) => {
        const row = await agent.receipt(`msg_${ordinal}`);
        throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error})`);
      });
      assert.equal((await agent.receipt(`msg_${ordinal}`))!.last_error, shownToOwner(realClaudeResult(capture).result), `${name}: the owner reads Claude's own error`);
    }
    const last = await agent.begin(names.length + 1);
    agent.reportStarted(last);
    agent.answer(last, "Answer after the errors.");
    await agent.eventually(async () => (await agent.receipt(`msg_${names.length + 1}`))?.state === "acknowledged", "the next message is answered");

    assert.deepEqual(agent.published, ["Answer after the errors."], "no API error text is posted in the room");
    assert.equal(agent.turns.length, names.length + 1, "each message started one turn; none was run again");
    assert.deepEqual(agent.recovery.requests, [], "each turn ended on its result; none had to be read back");
    const receipts = await agent.receipts() as unknown as Array<{ state: string; timeline: Array<{ phase: string }> }>;
    assert.deepEqual(receipts.flatMap((receipt) => receipt.timeline.map((event) => event.phase)).filter((phase) => phase === "blocked" || phase === "retry_scheduled"), [],
      "nothing was retried, and nothing waited for a person");
    await agent.eventually(() => agent.recorded().turns.every((turn) => turn.state === "terminal"), "every turn has its ending in the record");
    assert.deepEqual(agent.recorded().endings.map((ending) => ending.outcome), [...names.map(() => "failed"), "completed"]);
    assert.equal(agent.recorded().gaps, 0);
    assert.equal(agent.harness.children.length, 1, "the same process ran all of them");
    assert.equal((await agent.view()).room_agent_state.inbox.state, "empty");
  } finally {
    await agent.cleanup();
  }
});

for (const [name, expected] of Object.entries(CLAUDE_API_FAILURE_POLICY)) {
  const outcome = { follow_up: "is sent a follow-up turn", blocked: "has a follow-up blocked for its owner", settled: "has nothing queued" }[expected.then];
  test(`a Claude agent that holds a task ${outcome} after the real failure ${name}${expected.before === expected.then ? "" : ` (the failure text alone gave: ${expected.before.replace("_", "-")})`}`, async () => {
    const { claudeApiFailureClass, taskFailurePolicy } = await import(new URL("../../daemon/task-continuity.ts", import.meta.url).href);
    const agent = await claudeDaemonFixture({ ownedTasks: () => [HELD_TASK], skipFollowUpDelay: true });
    try {
      const turn = await agent.begin(1);
      // Every line the real CLI wrote for this failure, in its order.
      const capture = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES[name]!, agent.sessionId, turn.id);
      for (const event of capture.stream) turn.child.emit(event);
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles as failed");
      const claudeText = shownToOwner(realClaudeResult(capture).result);

      // What the daemon saved of the turn holds Claude's own account of the failure, and that account makes the kind.
      const saved = agent.read<{ evidence: string }>("SELECT terminal_evidence_json AS evidence FROM supervised_agent_terminal_results WHERE agent_id=?");
      assert.equal(saved.length, 1);
      const evidence = JSON.parse(saved[0]!.evidence) as { claudeApiFailure?: unknown; refusal?: unknown; unrecognizedResult?: unknown };
      assert.deepEqual(evidence.claudeApiFailure, expected.facts);
      assert.equal(evidence.refusal, expected.refusal, "only a turn the provider declined is saved as refused");
      assert.equal(evidence.unrecognizedResult, undefined, "a real API error is a known shape");
      assert.equal(claudeApiFailureClass(evidence.claudeApiFailure), expected.kind);
      // The table says what the text alone gave. That is still what a failure without this account gets.
      const fromText = taskFailurePolicy(claudeText, 1) as { automatic: boolean; settle?: true };
      assert.equal(fromText.automatic ? "follow_up" : fromText.settle ? "settled" : "blocked", expected.before);

      // Task continuity decides when the inbox is empty. It has decided when it has queued a follow-up, or left its reason on the message.
      await agent.eventually(async () => (await agent.receipts()).length > 1
        || /not continued automatically/.test((await agent.receipt("msg_1"))?.last_error ?? ""), "task continuity has decided");
      type Row = { source_message_id: string; state: string; last_error: string | null; timeline: Array<{ phase: string; detail: string | null }> };
      const rows = async () => await agent.receipts() as unknown as Row[];
      const phases = async (phase: string) => (await rows()).flatMap((row) => row.timeline).filter((event) => event.phase === phase);
      const sayMessage2 = async () => {
        agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2", activation: { for_current_agent: { decision: "activate" } } });
        await agent.eventually(async () => Boolean(await agent.receipt("msg_2")), "msg_2 is in the agent's inbox");
      };

      if (expected.then === "settled") {
        assert.deepEqual((await rows()).map((row) => row.source_message_id), ["msg_1"], "no follow-up is queued");
        assert.equal((await agent.receipt("msg_1"))!.last_error, `${claudeText} ${expected.reads}`, "the owner reads Claude's text and what was done about it");
        const next = await agent.begin(2);
        agent.reportStarted(next);
        agent.answer(next, "Answer 2.");
        await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 goes ahead and is answered");
        assert.deepEqual(agent.published, ["Answer 2."]);
        assert.equal(agent.turns.length, 2, "one turn for each room message, and no follow-up turn");
        assert.deepEqual([...await phases("blocked"), ...await phases("retry_scheduled")], []);
      } else if (expected.then === "blocked") {
        const [failed, followUp] = await rows();
        assert.equal((await rows()).length, 2);
        assert.equal(failed!.last_error, claudeText, "the failed message keeps Claude's own text");
        assert.match(followUp!.source_message_id, /^task-continuation:/);
        assert.equal(followUp!.state, "blocked");
        assert.equal(followUp!.last_error, claudeFollowUpText(name, claudeText), "the follow-up says what the owner has to do");
        await sayMessage2();
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal((await agent.receipt("msg_2"))!.state, "pending", "msg_2 waits behind the blocked follow-up, as before");
        assert.equal(agent.turns.length, 1, "Claude is sent no follow-up turn, and not msg_2");
        assert.deepEqual(agent.published, []);
        assert.deepEqual(await phases("retry_scheduled"), []);
      } else {
        await agent.eventually(() => agent.turns.length === 2, "the follow-up turn is dispatched to Claude");
        const followUpTurn = agent.turns[1]!;
        const prompt = followUpTurn.child.written.at(-1)!;
        assert.match(prompt, /Continue the unfinished task after a provider failure/);
        assert.match(prompt, /task_1/);
        assert.equal(/hit the model's output limit/.test(prompt), expected.kind === "output_limit", "only a turn that hit the output limit is told so");
        const [failed, followUp] = await rows();
        assert.equal(failed!.last_error, claudeText, "the failed message keeps Claude's own text");
        assert.match(followUp!.source_message_id, /^task-continuation:/);
        assert.deepEqual((await phases("retry_scheduled")).map((event) => event.detail), [expected.reads], "the follow-up says why it runs");
        assert.deepEqual(await phases("blocked"), []);
        assert.equal(agent.followUpWaits.length, 1);
        // A short provider fault waits thirty seconds before its first follow-up. A turn that ended without a reply waits ten.
        const scheduledAheadMs = expected.kind === "short_fault" ? 30_000 : 10_000;
        assert.ok(agent.followUpWaits[0]! > scheduledAheadMs - 1_000 && agent.followUpWaits[0]! <= scheduledAheadMs,
          `the follow-up was scheduled ${scheduledAheadMs / 1000} seconds ahead (${agent.followUpWaits[0]} ms)`);
        agent.reportStarted(followUpTurn);
        agent.answer(followUpTurn, "Continued the task.");
        await agent.eventually(async () => (await rows())[1]?.state === "acknowledged", "the follow-up turn is answered");
        await sayMessage2();
        await agent.eventually(() => agent.turns.length === 3, "msg_2 starts its turn after the follow-up");
        agent.reportStarted(agent.turns[2]!);
        agent.answer(agent.turns[2]!, "Answer 2.");
        await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
        assert.deepEqual(agent.published, ["Continued the task.", "Answer 2."], "no error text is posted");
      }
    } finally {
      await agent.cleanup();
    }
  });
}

for (const [name, outcome] of Object.entries(CLAUDE_INVALID_REQUEST_OUTCOMES)) {
  for (const path of ["in the stream", "read back from the session"] as const) {
    test(`a Claude agent that holds a task ${outcome.then === "settled" ? "has nothing queued" : "has a follow-up blocked for its owner"} after ${name}, a failure Claude names invalid_request, ${path}`, async () => {
      const { claudeApiFailureClass } = await import(new URL("../../daemon/task-continuity.ts", import.meta.url).href);
      const failure = CLAUDE_INVALID_REQUESTS[name]!;
      const agent = await claudeDaemonFixture({ ownedTasks: () => [HELD_TASK], skipFollowUpDelay: true });
      try {
        const turn = await agent.begin(1);
        const rows = claudeInvalidRequestRows(name, agent.sessionId, turn.id);
        if (path === "in the stream") {
          for (const event of rows.stream) turn.child.emit(event);
        } else {
          // The process ends before it reports the result. The session is all there is.
          agent.reportStarted(turn);
          await agent.eventually(() => agent.recorded().turns[0]?.state === "active", "the turn is recorded as started");
          agent.sessionRows.push(...rows.session);
          agent.exitProcess();
        }
        await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles as failed");
        const saved = agent.read<{ evidence: string }>("SELECT terminal_evidence_json AS evidence FROM supervised_agent_terminal_results WHERE agent_id=?");
        const facts = (JSON.parse(saved[0]!.evidence) as { claudeApiFailure?: { category: string | null; status: number | null; terminalReason: string | null } }).claudeApiFailure!;
        assert.deepEqual([facts.category, facts.status], ["invalid_request", failure.status]);
        assert.equal(facts.terminalReason, path === "in the stream" ? failure.terminalReason : null, "only the stream has the terminal reason");
        assert.equal(claudeApiFailureClass(facts), failure.kind, "and the kind is the same without it");

        await agent.eventually(async () => (await agent.receipts()).length > 1
          || /not continued automatically/.test((await agent.receipt("msg_1"))?.last_error ?? ""), "task continuity has decided");
        const receipts = await agent.receipts() as unknown as Array<{ source_message_id: string; state: string; last_error: string | null }>;
        if (outcome.then === "settled") {
          assert.deepEqual(receipts.map((row) => row.source_message_id), ["msg_1"], "no follow-up is queued");
          assert.equal(receipts[0]!.last_error, `${failure.text} ${outcome.reads}`);
        } else {
          assert.deepEqual(receipts.map((row) => row.state), ["acknowledged_failed", "blocked"]);
          assert.match(receipts[1]!.source_message_id, /^task-continuation:/);
          assert.equal(receipts[0]!.last_error, failure.text, "the failed message keeps Claude's own text");
          assert.equal(receipts[1]!.last_error, failure.kind === "conversation" ? `${failure.text} ${outcome.reads}` : outcome.reads);
        }
        assert.equal(agent.turns.length, 1, "Claude is sent no follow-up turn");
        assert.deepEqual(agent.published, []);
      } finally {
        await agent.cleanup();
      }
    });
  }
}

test("Claude's account of a failure is read from what the daemon saved: a daemon that never saw the failure decides on it the same way", async () => {
  const { taskFailurePolicy } = await import(new URL("../../daemon/task-continuity.ts", import.meta.url).href);
  let answerTheLookup!: () => void;
  const lookupAnswered = new Promise<void>((resolve) => { answerTheLookup = resolve; });
  let lookups = 0;
  const agent = await claudeDaemonFixture({ skipFollowUpDelay: true, ownedTasks: async ({ signal }) => {
    lookups += 1;
    // The daemon that saw the failure never learns which tasks the agent holds: it ends while it waits, with nothing decided.
    await Promise.race([lookupAnswered, new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("the lookup was abandoned")), { once: true });
    })]);
    return [HELD_TASK];
  } });
  try {
    const turn = await agent.begin(1);
    // "Connection refused": the text reads like no temporary fault. Only Claude's fields say that it is one.
    const capture = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES.connection_refused!, agent.sessionId, turn.id);
    const claudeText = shownToOwner(realClaudeResult(capture).result);
    assert.equal(taskFailurePolicy(claudeText, 1).automatic, false);
    for (const event of capture.stream) turn.child.emit(event);
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles as failed");
    await agent.eventually(() => lookups > 0, "task continuity is at its decision, and waits for the agent's tasks");
    assert.deepEqual((await agent.receipts()).map((receipt) => `${receipt.source_message_id} ${receipt.last_error}`), [`msg_1 ${claudeText}`], "nothing is decided yet");

    // The daemon and the process end. The next daemon has a new adapter, which never saw the stream.
    await agent.restartDaemon(() => agent.exitProcess());
    answerTheLookup();

    await agent.eventually(() => agent.turns.length === 2, "the new daemon sends the follow-up turn").catch(async (error) => {
      throw new Error(`${(error as Error).message}: ${JSON.stringify((await agent.receipts()).map((receipt) => [receipt.source_message_id, receipt.state, receipt.last_error]))}`);
    });
    const receipts = await agent.receipts() as unknown as Array<{ source_message_id: string; state: string; timeline: Array<{ phase: string; detail: string | null }> }>;
    assert.equal(receipts.length, 2);
    assert.match(receipts[1]!.source_message_id, /^task-continuation:/);
    assert.deepEqual(receipts.flatMap((receipt) => receipt.timeline).filter((event) => event.phase === "retry_scheduled").map((event) => event.detail),
      [CLAUDE_FAILURE_TEXT.temporary], "it decided on the saved account, not on the text");
    assert.deepEqual(receipts.flatMap((receipt) => receipt.timeline).filter((event) => event.phase === "blocked"), []);
  } finally {
    answerTheLookup();
    await agent.cleanup();
  }
});

for (const name of ["connection_refused", "http_400_credit_balance", "http_400_prompt_too_long"] as const) {
  const expected = CLAUDE_API_FAILURE_POLICY[name]!;
  test(`Claude's account of the real failure ${name} is read from the session too: a task holder whose process ended before the result was seen ${expected.then === "follow_up" ? "is sent a follow-up turn" : "has a follow-up blocked for its owner"}`, async () => {
    const agent = await claudeDaemonFixture({ ownedTasks: () => [HELD_TASK], skipFollowUpDelay: true });
    try {
      const turn = await agent.begin(1);
      agent.reportStarted(turn);
      await agent.eventually(() => agent.recorded().turns[0]?.state === "active", "the turn is recorded as started");
      // The process ends before it reports the result. The session rows are those the real CLI wrote for this failure.
      const capture = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES[name]!, agent.sessionId, turn.id);
      agent.sessionRows.push(...capture.session);
      agent.exitProcess();
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles as failed");
      const claudeText = shownToOwner(realClaudeResult(capture).result);
      assert.equal((await agent.receipt("msg_1"))!.last_error, claudeText);
      // The session keeps the status and Claude's name for the error, and not the result's terminal reason.
      const saved = agent.read<{ evidence: string }>("SELECT terminal_evidence_json AS evidence FROM supervised_agent_terminal_results WHERE agent_id=?");
      assert.deepEqual((JSON.parse(saved[0]!.evidence) as { claudeApiFailure?: unknown }).claudeApiFailure, { ...expected.facts, terminalReason: null });

      await agent.eventually(async () => (await agent.receipts()).length > 1, "task continuity has queued its follow-up");
      const followUp = (await agent.receipts() as unknown as Array<{ source_message_id: string; state: string; last_error: string | null; timeline: Array<{ phase: string; detail: string | null }> }>)[1]!;
      assert.match(followUp.source_message_id, /^task-continuation:/);
      if (expected.then === "follow_up") {
        await agent.eventually(() => agent.turns.length === 2, "the follow-up turn is dispatched to the new process");
        assert.deepEqual(followUp.timeline.filter((event) => event.phase === "retry_scheduled").map((event) => event.detail), [expected.reads]);
      } else {
        assert.equal(followUp.state, "blocked");
        assert.equal(followUp.last_error, claudeFollowUpText(name, claudeText));
        assert.equal(agent.turns.length, 1, "Claude is sent no follow-up turn");
      }
    } finally {
      await agent.cleanup();
    }
  });
}

test("a Claude agent that holds a task and reaches the account's usage limit in a room turn is sent no follow-up turn: its follow-up waits for the owner", async () => {
  const agent = await claudeDaemonFixture({ ownedTasks: () => [HELD_TASK], skipFollowUpDelay: true });
  try {
    const turn = await agent.begin(1);
    // The real stream of a rate limit, with the line Claude writes for a usage window that rejected the request
    // put in before the error. That line is written by hand (SDKRateLimitEvent): no capture holds one.
    const capture = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES.http_429_rate_limit!, agent.sessionId, turn.id);
    const errorRow = capture.stream.findIndex((event) => event.is_api_error_message === true);
    for (const event of [...capture.stream.slice(0, errorRow),
      { type: "rate_limit_event", session_id: agent.sessionId, rate_limit_info: { status: "rejected", resetsAt: 1_790_000_000, rateLimitType: "seven_day" } },
      ...capture.stream.slice(errorRow)]) turn.child.emit(event);
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles as failed");
    const saved = agent.read<{ evidence: string }>("SELECT terminal_evidence_json AS evidence FROM supervised_agent_terminal_results WHERE agent_id=?");
    assert.deepEqual((JSON.parse(saved[0]!.evidence) as { claudeApiFailure?: unknown }).claudeApiFailure,
      { ...CLAUDE_API_FAILURE_POLICY.http_429_rate_limit!.facts, usageLimit: true });

    await agent.eventually(async () => (await agent.receipts()).length > 1, "task continuity has queued its follow-up");
    const followUp = (await agent.receipts())[1]!;
    assert.match(followUp.source_message_id, /^task-continuation:/);
    assert.equal(followUp.state, "blocked", "a usage limit does not pass in seconds: it is not retried as a short fault");
    assert.equal(followUp.last_error, CLAUDE_FAILURE_TEXT.billing);
    agent.roomMessages.push({ id: "msg_2", sender: "someone", text: "request 2", activation: { for_current_agent: { decision: "activate" } } });
    await agent.eventually(async () => Boolean(await agent.receipt("msg_2")), "msg_2 is in the agent's inbox");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(agent.turns.length, 1, "Claude is sent no follow-up turn");
    assert.deepEqual(agent.followUpWaits, [], "and none is scheduled");
    assert.equal((await agent.receipt("msg_2"))!.state, "pending");
  } finally {
    await agent.cleanup();
  }
});

test("Claude's name for an API error belongs to the turn whose stream carried it, and to no other turn", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const child = harness.children[0]!;
  const session_id = handle.providerContinuationId!;
  const start = async () => {
    const writtenBefore = child.written.length;
    const running = adapter.runRoomTurn(handle, { inboxItemId: "inbox", actionId: "action", sourceMessage: {}, activation: {} },
      { checkpointTerminalResult: async () => {} });
    return { running, turnId: await nextClaudeTurnId(child, writtenBefore) };
  };
  const named = (category: string, turnId?: string) => ({ type: "assistant", session_id, is_api_error_message: true, error: category,
    ...(turnId ? { user_message_uuid: turnId } : {}), message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } });
  const apiError = (turnId: string, status: number | null) => ({ type: "result", subtype: "success", is_error: true, session_id, user_message_uuid: turnId,
    api_error_status: status, terminal_reason: "api_error", result: "API Error" });
  const facts = async (running: Promise<ProviderRoomTurnResult>) => (await running as { claudeApiFailure?: unknown }).claudeApiFailure;

  // A row that names its command, and a row that names none, as Claude Code writes both.
  const first = await start();
  child.emit(named("authentication_failed", first.turnId));
  child.emit(apiError(first.turnId, 401));
  assert.deepEqual(await facts(first.running), { status: 401, terminalReason: "api_error", category: "authentication_failed" });
  const second = await start();
  child.emit(named("max_output_tokens"));
  child.emit(apiError(second.turnId, null));
  assert.deepEqual(await facts(second.running), { status: null, terminalReason: "api_error", category: "max_output_tokens" });

  // A turn whose stream named no error has no name: not the one of the turn before it.
  const third = await start();
  child.emit(apiError(third.turnId, 500));
  assert.deepEqual(await facts(third.running), { status: 500, terminalReason: "api_error", category: null });

  // A row of another command, or of another session, that arrives while a turn runs names nothing for that turn.
  const fourth = await start();
  child.emit(named("billing_error", first.turnId));
  child.emit({ ...named("billing_error", fourth.turnId), session_id: "another-session" });
  child.emit(apiError(fourth.turnId, 500));
  assert.deepEqual(await facts(fourth.running), { status: 500, terminalReason: "api_error", category: null });

  // An assistant row that is not marked as an API error names none, whatever it carries.
  const fifth = await start();
  child.emit({ ...named("billing_error", fifth.turnId), is_api_error_message: false });
  child.emit(apiError(fifth.turnId, 529));
  assert.deepEqual(await facts(fifth.running), { status: 529, terminalReason: "api_error", category: null });

  // A sub-agent's API error (the real row) arrives in the stream of the turn that started it, with the turn's
  // session and no command. It names nothing for the turn: `parent_tool_use_id` says it is the sub-agent's.
  const withSubAgent = await start();
  const subAgentError = realClaudeCapture(CLAUDE_REAL_CAPTURES.subagent_api_error!, session_id, withSubAgent.turnId).stream
    .find((event) => event.is_api_error_message === true)!;
  assert.deepEqual([subAgentError.error, subAgentError.user_message_uuid, typeof subAgentError.parent_tool_use_id], ["unknown", undefined, "string"]);
  child.emit(subAgentError);
  child.emit(apiError(withSubAgent.turnId, 500));
  assert.deepEqual(await facts(withSubAgent.running), { status: 500, terminalReason: "api_error", category: null });

  // The CLI reports each usage window of the account it reads (SDKRateLimitEvent). One that rejected the request,
  // in the stream of the running turn, is part of that turn's account. These lines are written by hand, as in the
  // start-up tests: no capture holds one.
  const window = (status: string, session = session_id) => ({ type: "rate_limit_event", session_id: session, rate_limit_info: { status, resetsAt: 1_790_000_000, rateLimitType: "five_hour" } });
  const sixth = await start();
  child.emit(window("allowed_warning"));
  child.emit(window("rejected"));
  child.emit(named("rate_limit", sixth.turnId));
  child.emit(apiError(sixth.turnId, 429));
  assert.deepEqual(await facts(sixth.running), { status: 429, terminalReason: "api_error", category: "rate_limit", usageLimit: true });
  // A window that is allowed, or one of another session, rejects nothing. Nor does the window of the turn before.
  const seventh = await start();
  child.emit(window("allowed"));
  child.emit(window("allowed_warning"));
  child.emit(window("rejected", "another-session"));
  child.emit(named("rate_limit", seventh.turnId));
  child.emit(apiError(seventh.turnId, 429));
  assert.deepEqual(await facts(seventh.running), { status: 429, terminalReason: "api_error", category: "rate_limit" });
});

test("a Claude agent whose turn ends on a result of a shape nobody expected settles it as failed once, and no later message waits behind it", async () => {
  const agent = await claudeDaemonFixture();
  try {
    // One of each kind of surprise. The first is the incident's nearest relative: "success" with no word on errors.
    const cells = ["success / no is_error / result present", "no subtype / no is_error / result missing",
      "a_subtype_from_the_future / is_error false / result present", "error_max_turns / is_error false / result empty",
      "interrupted / no is_error / result missing"].map((name) => CLAUDE_RESULT_CELLS.find((cell) => cell.name === name)!);
    for (const [index, cell] of cells.entries()) {
      const ordinal = index + 1;
      const turn = await agent.begin(ordinal);
      agent.reportStarted(turn);
      turn.child.emit(claudeResultEvent(cell, agent.sessionId, turn.id));
      await agent.eventually(async () => (await agent.receipt(`msg_${ordinal}`))?.state === "acknowledged_failed", `"${cell.name}" settles as failed`).catch(async (error) => {
        const row = await agent.receipt(`msg_${ordinal}`);
        throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error})`);
      });
      assert.equal((await agent.receipt(`msg_${ordinal}`))!.last_error, shownToOwner(cell.error), cell.name);
    }
    assert.deepEqual(agent.recovery.requests, [], "each of them ended on its result; none was read back, and none three times");

    // Claude really completes a turn with no answer at all. Its result and its session are as the CLI wrote them.
    const emptyOrdinal = cells.length + 1;
    const emptyTurn = await agent.begin(emptyOrdinal);
    const empty = realClaudeCapture(CLAUDE_REAL_CAPTURES.completed_without_answer!, agent.sessionId, emptyTurn.id);
    agent.sessionRows.push(...empty.session);
    for (const event of empty.stream) emptyTurn.child.emit(event);
    await agent.eventually(async () => (await agent.receipt(`msg_${emptyOrdinal}`))?.state === "acknowledged_failed", "the turn without an answer settles as failed").catch(async (error) => {
      const row = await agent.receipt(`msg_${emptyOrdinal}`);
      throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error})`);
    });
    assert.equal((await agent.receipt(`msg_${emptyOrdinal}`))!.last_error, NO_REPLY_FAILURE.emptyAnswer);
    assert.equal(agent.recovery.requests.length, 1, "the completed turn is read once more, from its session, and then it ends");

    const last = await agent.begin(emptyOrdinal + 1);
    agent.reportStarted(last);
    agent.answer(last, "Answer after the surprises.");
    await agent.eventually(async () => (await agent.receipt(`msg_${emptyOrdinal + 1}`))?.state === "acknowledged", "the next message is answered");

    assert.deepEqual(agent.published, ["Answer after the surprises."], "none of Claude's unproven text is posted in the room");
    assert.equal(agent.turns.length, emptyOrdinal + 1, "each message started one turn; none was run again");
    const receipts = await agent.receipts() as unknown as Array<{ state: string; timeline: Array<{ phase: string }> }>;
    assert.deepEqual(receipts.flatMap((receipt) => receipt.timeline.map((event) => event.phase)).filter((phase) => phase === "blocked" || phase === "retry_scheduled"), [],
      "nothing was retried, and nothing waited for a person");
    await agent.eventually(() => agent.recorded().turns.every((turn) => turn.state === "terminal"), "every turn has its ending in the record");
    assert.deepEqual(agent.recorded().endings.map((ending) => `${ending.n} ${ending.outcome}`),
      ["1 failed", "1 failed", "1 failed", "1 failed", "1 interrupted", "1 completed", "1 completed"],
      "one ending each; the turn without an answer did complete, and its message is what failed");
    assert.equal(agent.recorded().gaps, 0);
    assert.equal(agent.harness.children.length, 1);
    assert.equal((await agent.view()).room_agent_state.inbox.state, "empty", "nothing waits behind a message that needs a person");
  } finally {
    await agent.cleanup();
  }
});

for (const [words, text] of [
  ["that read like a temporary provider failure", "Done. I changed 500 lines and all tests pass."],
  ["that read like nothing in particular", "Merged the PR."],
] as const) {
  test(`a Claude agent that holds a task and ends a turn on an unproven result, with words ${words}, is sent no second turn and has nothing blocked`, async () => {
    const agent = await claudeDaemonFixture({ ownedTasks: () => [{ id: "task_1", title: "Existing work", leaseId: "lease-1", epoch: 2 }] });
    try {
      const turn = await agent.begin(1);
      agent.reportStarted(turn);
      // "success" and no word on errors: nothing proves that this text is an answer, and nothing proves that it is an error.
      turn.child.emit({ type: "result", subtype: "success", session_id: agent.sessionId, user_message_uuid: turn.id, result: text });
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles as failed");
      // Task continuity looks at a failed turn of a lease holder when the inbox is empty. It has done so
      // when it has left its decision on the message, or has queued a follow-up for the task.
      await agent.eventually(async () => (await agent.receipts()).length > 1
        || /not continued automatically/.test((await agent.receipt("msg_1"))?.last_error ?? ""), "task continuity has looked at the failed turn");
      const afterFailure = await agent.receipts();
      assert.deepEqual(afterFailure.map((receipt) => `${receipt.source_message_id} ${receipt.state}`), ["msg_1 acknowledged_failed"],
        "no follow-up is queued for the task: none that runs by itself, and none that waits blocked");
      const reason = afterFailure[0]!.last_error ?? "";
      assert.ok(reason.includes(text), "the owner still reads what Claude wrote");
      assert.match(reason, /does not recognize.*not continued automatically.*send a message to continue it/);
      assert.equal(agent.turns.length, 1, "Claude is not sent a second turn");

      const next = await agent.begin(2);
      agent.reportStarted(next);
      agent.answer(next, "Answer 2.");
      await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 goes ahead and is answered");
      assert.deepEqual(agent.published, ["Answer 2."], "the unproven text is never posted");
      assert.equal(agent.turns.length, 2, "one turn for each room message, and no other");
      const receipts = await agent.receipts() as unknown as Array<{ source_message_id: string; timeline: Array<{ phase: string }> }>;
      assert.deepEqual(receipts.map((receipt) => receipt.source_message_id), ["msg_1", "msg_2"]);
      assert.deepEqual(receipts.flatMap((receipt) => receipt.timeline.map((event) => event.phase)).filter((phase) => phase === "blocked" || phase === "retry_scheduled"), [],
        "nothing was scheduled, and nothing waited for a person");
      assert.equal((await agent.view()).room_agent_state.inbox.state, "empty");
    } finally {
      await agent.cleanup();
    }
  });
}
