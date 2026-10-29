import "./isolated-home.js";
import { ClaudeCompaction } from "../main/agents/claude-compaction.js";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { supervisedAgentTest as test } from "./platform.js";
import { NO_REPLY_FAILURE } from "../../../../shared/room-turn-no-reply.mjs";
import { CLAUDE_BACKGROUND_WORK_TEXT, ClaudeCodeProviderAdapter, createManagedClaudeMcpConfig } from "../main/agents/claude-code-provider-adapter.js";
import type { ProviderStreamEvent, NativeExecutionObservation } from "../main/agents/provider-adapter.js";
import { PROCESS_ENDED_DURING_TURN } from "../main/agents/provider-adapter.js";
import { CLAUDE_TURN_WITHOUT_MODEL_TEXT } from "../main/agents/claude-room-turn-evidence.js";
import {
  CLAUDE_API_ERROR_CAPTURES,
  CLAUDE_FAILURE_TEXT,
  CLAUDE_REAL_CAPTURES,
  realClaudeCapture,
  realClaudeResult,
} from "./claude-result-shapes.js";
import {
  providerStreamLifecycle,
  emptyExecutionProjection,
  reduceExecutionFact,
  ProviderActionPortRouter,
  argValue,
  birthIdentity,
  createHarness,
  spawnRequest,
  flush,
  claudeDaemonFixture,
  shownToOwner,
  HELD_TASK,
  CLAUDE_SESSION_WITHOUT_ANSWER,
  CLAUDE_SESSION_AFTER_A_REPLY_WITHOUT_OUTPUT,
  realClaudeSessionFile,
  CLAUDE_SESSION_READ_BACK,
  CLAUDE_STREAMS_WITH_MORE_THAN_AN_ANSWER,
  CLAUDE_BACKGROUND_WORK_READ_BACK,
  claudeAskPolicy,
  approvalHarness,
  pause,
} from "./claude-code-provider-adapter.fixture.js";

for (const [tasks, ownedTasks] of [["holds no task", undefined], ["holds a task", () => [HELD_TASK]]] as const) {
  test(`a Claude agent that ${tasks}, and whose prompt a UserPromptSubmit hook stops, posts nothing: the message fails once with a reason that holds no word of the hook or of the prompt, and the next message goes ahead`, async () => {
    const agent = await claudeDaemonFixture(ownedTasks ? { ownedTasks } : {});
    try {
      const turn = await agent.begin(1);
      // Every line that the CLI really wrote for a prompt that a hook stopped. No request went to the model, and
      // the result is a `success` whose text is the CLI's: the path of the hook's script, the hook's words, the prompt.
      const capture = realClaudeCapture(CLAUDE_REAL_CAPTURES.hook_blocks_prompt!, agent.sessionId, turn.id);
      const clisText = String(realClaudeResult(capture).result);
      const clisWords = ["PROMPT_HOOK_BLOCKS_THE_PROMPT", "/PATH", "Original prompt", "PROBE_OK", "blocked by hook"];
      assert.ok(clisWords.every((words) => clisText.includes(words)));
      for (const event of capture.stream) turn.child.emit(event);
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles as failed").catch(async (error) => {
        const row = await agent.receipt("msg_1");
        throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error}); posted ${JSON.stringify(agent.published)}`);
      });
      // Task continuity looks at a failed turn of a lease holder when the inbox is empty, and leaves its decision on the message.
      if (ownedTasks) await agent.eventually(async () => /not continued automatically/.test((await agent.receipt("msg_1"))?.last_error ?? ""), "task continuity has looked at the failed turn");
      else await pause(200);
      const afterFailure = await agent.receipts();
      assert.deepEqual(afterFailure.map((receipt) => `${receipt.source_message_id} ${receipt.state}`), ["msg_1 acknowledged_failed"],
        "no follow-up is queued: none that runs by itself, and none that waits blocked. The hook would stop it too");
      assert.equal(afterFailure[0]!.last_error, shownToOwner(ownedTasks ? `${CLAUDE_TURN_WITHOUT_MODEL_TEXT.hookStoppedPrompt} ${CLAUDE_FAILURE_TEXT.refused}` : CLAUDE_TURN_WITHOUT_MODEL_TEXT.hookStoppedPrompt));
      assert.deepEqual(agent.followUpWaits, []);
      assert.deepEqual(agent.published, [], "the CLI's text is not posted");
      assert.deepEqual(agent.recovery.requests, [], "the turn ended on its result: it is not read back");
      assert.equal(agent.turns.length, 1, "Claude is not sent the prompt a second time");
      // Neither what the daemon keeps of the message, nor what it says of the agent, holds the CLI's text.
      for (const words of clisWords) {
        assert.ok(!JSON.stringify(afterFailure).includes(words), `the message's record holds ${words}`);
        assert.ok(!JSON.stringify([(await agent.view()).last_error, (await agent.view()).room_agent_state]).includes(words), `the agent's state holds ${words}`);
      }

      const stopped = await agent.view();
      assert.deepEqual([stopped.observed_state, stopped.condition, stopped.last_error, stopped.room_agent_state.inbox.state], ["idle", "none", null, "empty"],
        "the agent is not blocked, and waits for no person");
      const next = await agent.begin(2);
      agent.reportStarted(next);
      agent.answer(next, "Answer 2.");
      await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 goes ahead and is answered");
      assert.deepEqual(agent.published, ["Answer 2."]);
      assert.equal(agent.turns.length, 2, "one turn for each room message, and no other");
      const receipts = await agent.receipts() as unknown as Array<{ source_message_id: string; timeline: Array<{ phase: string }> }>;
      assert.deepEqual(receipts.map((receipt) => receipt.source_message_id), ["msg_1", "msg_2"]);
      assert.deepEqual(receipts.flatMap((receipt) => receipt.timeline.map((event) => event.phase)).filter((phase) => phase === "blocked" || phase === "retry_scheduled"), [],
        "nothing was scheduled, and nothing waited for a person");
      await agent.eventually(() => agent.recorded().turns.every((recorded) => recorded.state === "terminal"), "both turns are closed in the record");
      assert.deepEqual(agent.recorded().endings.map((ending) => [ending.n, ending.outcome]), [[1, "completed"], [1, "completed"]],
        "one ending each; the CLI's command did complete, as the CLI says, and its message is what failed");
      assert.equal(agent.recorded().gaps, 0);
      const current = await agent.view();
      assert.equal(current.condition, "none", current.last_error ?? "");
      assert.equal(current.room_agent_state.inbox.state, "empty", "nothing waits behind the message that the hook stopped");
      assert.equal(agent.harness.children.length, 1, "the agent's process is the same");
    } finally {
      await agent.cleanup();
    }
  });
}

for (const ended of ["after the model answered", "before the model answered", "before the CLI asked for output"] as const) {
  const answered = ended === "after the model answered";
  test(`a Claude turn whose first reply had no visible output, and whose process ended ${ended}, ${answered ? "has that answer posted once" : "is settled as cut off"}, with no follow-up`, async () => {
    // The agent holds a task: a failed turn of it could be given a follow-up turn.
    const agent = await claudeDaemonFixture({ ownedTasks: () => [{ id: "task_1", title: "Existing work", leaseId: "lease-1", epoch: 2 }] });
    try {
      const turn = await agent.begin(1);
      agent.reportStarted(turn);
      await agent.eventually(() => agent.recorded().turns[0]?.state === "active", "the turn is recorded as started");
      // The process ends before it reports the turn's result. The session is all there is.
      agent.sessionRows.push(...CLAUDE_SESSION_AFTER_A_REPLY_WITHOUT_OUTPUT(agent.sessionId, turn.id, ended));
      agent.exitProcess();
      const settled = answered ? "acknowledged" : "acknowledged_failed";
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === settled, `msg_1 settles ${settled}`).catch(async (error) => {
        const row = await agent.receipt("msg_1");
        throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error})`);
      });
      if (answered) assert.deepEqual(agent.published, ["REAL ANSWER"], "the answer of the last message that ended is posted");
      else assert.equal((await agent.receipt("msg_1"))!.last_error, PROCESS_ENDED_DURING_TURN, "a turn that was cut off is not called a turn without a reply");

      const next = await agent.begin(2);
      agent.reportStarted(next);
      agent.answer(next, "Answer 2.");
      await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 goes ahead and is answered");
      assert.deepEqual(agent.published, answered ? ["REAL ANSWER", "Answer 2."] : ["Answer 2."], "nothing is posted twice, and nothing that was not said");
      assert.equal(agent.turns.length, 2, "one turn for each room message: the first is not run again, and no follow-up turn is sent");
      const receipts = await agent.receipts() as unknown as Array<{ source_message_id: string; timeline: Array<{ phase: string }> }>;
      assert.deepEqual(receipts.map((receipt) => receipt.source_message_id), ["msg_1", "msg_2"], "no follow-up is queued for the task");
      assert.deepEqual(receipts.flatMap((receipt) => receipt.timeline.map((event) => event.phase)).filter((phase) => phase === "blocked" || phase === "retry_scheduled"), []);
      assert.equal((await agent.view()).room_agent_state.inbox.state, "empty");
    } finally {
      await agent.cleanup();
    }
  });
}

for (const [left, { rows, posted }] of Object.entries(CLAUDE_SESSION_READ_BACK)) {
  test(`a Claude turn whose process ended, with ${left} in the session, ${posted ? `has ${JSON.stringify(posted)} posted once` : "is settled as cut off, and nothing is posted for it"}`, async () => {
    const agent = await claudeDaemonFixture();
    try {
      const turn = await agent.begin(1);
      agent.reportStarted(turn);
      await agent.eventually(() => agent.recorded().turns[0]?.state === "active", "the turn is recorded as started");
      // The process ends before it reports the turn's result. The session is all there is.
      agent.sessionRows.push(...rows(agent.sessionId, turn.id));
      agent.exitProcess();
      const settled = posted ? "acknowledged" : "acknowledged_failed";
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === settled, `msg_1 settles ${settled}`).catch(async (error) => {
        const row = await agent.receipt("msg_1");
        throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error}); posted ${JSON.stringify(agent.published)}`);
      });
      if (!posted) assert.equal((await agent.receipt("msg_1"))!.last_error, PROCESS_ENDED_DURING_TURN);

      const next = await agent.begin(2);
      agent.reportStarted(next);
      agent.answer(next, "Answer 2.");
      await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 goes ahead and is answered");
      assert.deepEqual(agent.published, posted ? [posted, "Answer 2."] : ["Answer 2."],
        "the turn's own reply or nothing: never another turn's answer, a sub-agent's report, or a message a hook refused");
      assert.equal(agent.turns.length, 2, "one turn for each room message");
      assert.equal((await agent.view()).room_agent_state.inbox.state, "empty");
    } finally {
      await agent.cleanup();
    }
  });
}

test("every real capture of a turn with a tool call, a hook or a sub-agent is replayed against the daemon", () => {
  // The turn that ends on an API error, and the one that completes without an answer, have replays of their own.
  const replayed = [...Object.keys(CLAUDE_STREAMS_WITH_MORE_THAN_AN_ANSWER), "task_ends_during_next_turn", "completed_without_answer", ...Object.keys(CLAUDE_API_ERROR_CAPTURES),
    // In these the recorder wrote more to the CLI than a prompt: each has a replay in which the adapter writes it.
    "interrupt_during_task_notice_answer_then_prompt", "approval_in_task_notice_answer_interrupted", "approval_in_task_notice_answer_denied_and_interrupted", "subagent_running_at_interrupt",
    // In these the recorder wrote what the adapter never writes to one process: a prompt while the notice of a task is
    // answered, the CLI's own command, and a prompt to a second process for the same session. Their sessions are read
    // back (`CLAUDE_BACKGROUND_WORK_READ_BACK`, `CLAUDE_SESSION_READ_BACK`).
    "prompt_during_task_notice_answer", "compaction_by_command", "resumed_session"];
  for (const [name, capture] of Object.entries(CLAUDE_REAL_CAPTURES)) {
    if (capture.session.some((row) => row.type === "user" && row.uuid !== "TURN_ID")) assert.ok(replayed.includes(name), `${name} has a replay`);
  }
  // Every real turn that started background work is read back from its session too.
  for (const [name, capture] of Object.entries(CLAUDE_REAL_CAPTURES)) {
    assert.equal(capture.session.some((row) => (row.toolUseResult as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId !== undefined
      || (row.toolUseResult as { isAsync?: unknown } | undefined)?.isAsync === true), name in CLAUDE_BACKGROUND_WORK_READ_BACK, `${name} is read back, or started nothing in the background`);
  }
  assert.equal(CLAUDE_BACKGROUND_WORK_TEXT.noReportInSession, "This reply was read from Claude's saved session. A report on background work that this turn started is missing from it.");
  // Where the session proves the reply complete, it is the reply that the stream gives. Elsewhere it holds the
  // same texts of the model's, and one line of the adapter's.
  const lines: readonly string[] = Object.values(CLAUDE_BACKGROUND_WORK_TEXT);
  for (const [name, readBack] of Object.entries(CLAUDE_BACKGROUND_WORK_READ_BACK)) {
    const fromStream = CLAUDE_STREAMS_WITH_MORE_THAN_AN_ANSWER[name];
    const lacks = readBack.filter((text) => lines.includes(text));
    assert.ok(lacks.length <= 1 && (!lacks.length || readBack.at(-1) === lacks[0]), name);
    if (!fromStream) continue;
    if (!lacks.length) assert.deepEqual(readBack, fromStream, `${name}: the reply that is read back is the reply from the stream`);
    else assert.deepEqual(readBack.filter((text) => !lines.includes(text)), fromStream.filter((text) => !lines.includes(text)), `${name}: the model's texts are the same`);
  }
  // No reply ever holds a sub-agent's own words.
  assert.ok(Object.values(CLAUDE_STREAMS_WITH_MORE_THAN_AN_ANSWER).flat().every((text) => !text.includes("SUBAGENT REPORT")));
});

for (const [name, texts] of Object.entries(CLAUDE_BACKGROUND_WORK_READ_BACK)) {
  test(`a Claude turn that started background work, whose process ended before its result was seen, is read back from the real session of ${name}: ${JSON.stringify(texts.at(-1))} ends its reply`, async () => {
    const agent = await claudeDaemonFixture();
    try {
      const turn = await agent.begin(1);
      agent.reportStarted(turn);
      await agent.eventually(() => agent.recorded().turns[0]?.state === "active", "the turn is recorded as started");
      // The process ends before it reports the turn's result. The session file, with all that the CLI wrote, is all there is.
      agent.sessionRows.push(...realClaudeSessionFile(name)(agent.sessionId, turn.id));
      agent.exitProcess();
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered").catch(async (error) => {
        const row = await agent.receipt("msg_1");
        throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error}); posted ${JSON.stringify(agent.published)}`);
      });
      assert.deepEqual(agent.published, [texts.join("\n\n")], "one reply, with one blank line between its texts");
    } finally {
      await agent.cleanup();
    }
  });
}

for (const [name, texts] of Object.entries(CLAUDE_STREAMS_WITH_MORE_THAN_AN_ANSWER)) {
  const answer = texts.join("\n\n");
  test(`the real stream of a Claude turn (${name}) gets one reply posted, with all that the model wrote for the room, and nothing else`, async () => {
    const agent = await claudeDaemonFixture();
    try {
      const turn = await agent.begin(1);
      // Every line the CLI wrote, in its order: the tool call and its result, a sub-agent's rows, a hook's refusal,
      // and, where a background task ended, the turn the CLI ran for its notice. That turn's result names no command:
      // its text belongs to the turn that started the task, which stays open for it.
      const { stream } = realClaudeCapture(CLAUDE_REAL_CAPTURES[name]!, agent.sessionId, turn.id);
      assert.equal(stream.filter((event) => event.type === "result" && event.user_message_uuid === turn.id).length, 1);
      for (const event of stream) turn.child.emit(event);
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered").catch(async (error) => {
        const row = await agent.receipt("msg_1");
        throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error})`);
      });

      const next = await agent.begin(2);
      agent.reportStarted(next);
      agent.answer(next, "Answer 2.");
      await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 goes ahead and is answered");
      assert.deepEqual(agent.published, [answer, "Answer 2."],
        "the room gets one reply for the turn: its own answer and, after it, the answer to each notice of its background work");
      assert.equal(agent.turns.length, 2, "one turn for each room message");
      await agent.eventually(() => agent.recorded().turns.every((recorded) => recorded.state === "terminal"), "both turns are closed in the record");
      assert.deepEqual(agent.recorded().endings.map((ending) => [ending.n, ending.outcome]), [[1, "completed"], [1, "completed"]]);
      assert.equal(agent.recorded().gaps, 0);
      const current = await agent.view();
      assert.equal(current.condition, "none", current.last_error ?? "");
      assert.equal(current.room_agent_state.inbox.state, "empty");
    } finally {
      await agent.cleanup();
    }
  });
}

for (const [left, rows] of Object.entries(CLAUDE_SESSION_WITHOUT_ANSWER)) {
  for (const ended of ["Claude process", "Claude process and daemon"] as const) {
    test(`a Claude turn that completed without an answer, whose ${ended} ended before the second read, with ${left} in the session, still ends as a turn without a reply`, async () => {
      const agent = await claudeDaemonFixture();
      try {
        const turn = await agent.begin(1);
        const letRecoveryGo = agent.holdRecovery();
        // The real stream of a turn that Claude completed with an empty answer.
        for (const event of realClaudeCapture(CLAUDE_REAL_CAPTURES.completed_without_answer!, agent.sessionId, turn.id).stream) turn.child.emit(event);
        await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "result_recovery", "the daemon has the turn saved as completed with no readable answer");
        agent.sessionRows.push(...rows(agent.sessionId, turn.id));
        // Whatever saw the empty result is gone before the turn is read again. Only the daemon's saved state says that it completed.
        if (ended === "Claude process") {
          agent.exitProcess();
          await agent.eventually(() => agent.harness.children.length === 2, "a new process replaces the one that ended");
        } else {
          // The process ends when no daemon runs. Ended while the first daemon still ran, that daemon could
          // launch a replacement before it stopped, and the next daemon would fence that one for ten seconds.
          // A new daemon has a new adapter too, with nothing of the first read in memory.
          await agent.restartDaemon(() => agent.exitProcess());
        }
        letRecoveryGo();

        await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged_failed", "msg_1 settles as failed").catch(async (error) => {
          const row = await agent.receipt("msg_1");
          throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error})`);
        });
        assert.equal((await agent.receipt("msg_1"))!.last_error, NO_REPLY_FAILURE.emptyAnswer,
          "the owner reads that the model wrote no reply, not that the turn was cut off");
        assert.equal(agent.recovery.requests.at(-1)?.savedAsUnreadable, true, "the daemon tells the adapter what it has saved");

        const next = await agent.begin(2);
        agent.reportStarted(next);
        agent.answer(next, "Answer 2.");
        await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 goes ahead and is answered");
        assert.deepEqual(agent.published, ["Answer 2."]);
        assert.equal(agent.turns.length, 2, "the turn without an answer is not run again");
        assert.equal((await agent.view()).room_agent_state.inbox.state, "empty", "nothing waits behind a message that needs a person");
      } finally {
        await agent.cleanup();
      }
    });
  }
}

for (const subtype of ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]) {
  test(`Claude ${subtype} fails only the exact turn and leaves the continuation reusable`, async () => {
    const harness = createHarness();
    const stream: ProviderStreamEvent[] = [];
    const adapter = new ClaudeCodeProviderAdapter({
      dependencies: harness.dependencies,
      streamSink: (event) => stream.push(event),
    });
    const handle = await adapter.spawn(spawnRequest());
    const child = harness.children[0]!;
    const request = { inboxItemId: "inbox-limited", actionId: "action-limited", sourceMessage: {}, activation: {} };
    const options = { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} };
    const running = adapter.runRoomTurn!(handle, request, options);
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    const frame = JSON.parse(child.written.at(-1)!) as { uuid: string };
    for (const identity of [
      { session_id: "different-session", user_message_uuid: frame.uuid },
      { session_id: handle.providerContinuationId, user_message_uuid: "different-turn" },
    ]) {
      child.emit({ type: "result", subtype, is_error: true, ...identity });
      await flush();
      assert.equal(settled, false, "uncorrelated results cannot settle the active room turn");
    }
    child.emit({
      type: "result", subtype, is_error: true,
      session_id: handle.providerContinuationId, user_message_uuid: frame.uuid,
      errors: ["Configured turn limit reached."],
    });
    assert.equal((await running).outcome, "failed");
    assert.equal(handle.observedState(), "idle");
    assert.equal(stream.at(-1)?.kind, "turn_lifecycle");
    assert.equal(stream.at(-1)?.method, `result/${subtype}`);
    assert.equal(providerStreamLifecycle(stream.at(-1)!), "idle");
    assert.equal((stream.at(-1)?.payload as { is_error: boolean }).is_error, true);

    const writesBeforeRecovery = child.written.length;
    assert.equal((await adapter.recoverRoomTurn!(handle, {
      inboxItemId: request.inboxItemId, providerTurnId: frame.uuid,
    })).outcome, "failed");
    assert.equal(child.written.length, writesBeforeRecovery, "exact failed-turn evidence is retained without replay");

    const next = adapter.runRoomTurn!(handle, { ...request, inboxItemId: "inbox-next", actionId: "action-next" }, options);
    await flush();
    const nextFrame = JSON.parse(child.written.at(-1)!) as { uuid: string };
    assert.notEqual(nextFrame.uuid, frame.uuid);
    child.emit({
      type: "result", subtype: "success", is_error: false,
      session_id: handle.providerContinuationId, user_message_uuid: nextFrame.uuid,
      result: "The next turn completed.",
    });
    assert.deepEqual(await next, { turnId: nextFrame.uuid, outcome: "reply", text: "The next turn completed.", evidence: "stream" });
    assert.equal(harness.children.length, 1);
    assert.equal(child.alive, true);
    assert.deepEqual(harness.signals, []);
  });
}

for (const subtype of ["error_during_execution", "error_max_unknown_limit", "error_max_turns_extra"]) {
  test(`Claude ${subtype} retains legacy runtime failure handling`, async () => {
    const harness = createHarness();
    const stream: ProviderStreamEvent[] = [];
    const adapter = new ClaudeCodeProviderAdapter({
      dependencies: harness.dependencies,
      streamSink: (event) => stream.push(event),
    });
    const handle = await adapter.spawn(spawnRequest());
    harness.children[0]!.emit({
      type: "result",
      subtype,
      is_error: true,
      result: "native provider failure",
    });
    await flush();

    assert.equal(handle.observedState(), "failed");
    assert.equal(stream.at(-1)?.kind, "error");
    assert.equal(stream.at(-1)?.method, `result/${subtype}`);
    assert.equal(providerStreamLifecycle(stream.at(-1)!), "failed");
  });
}

test("Claude typed observations correlate native turns and completed tools without inventing execution starts", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  const stream: ProviderStreamEvent[] = [];
  const stopStream = adapter.onStream(handle, (event) => stream.push(event));
  const events: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, () => { throw new Error("shadow persistence unavailable"); });
  adapter.onExecution(handle, (event) => events.push(event));
  assert.deepEqual(events.map(({ fact }) => fact), [{
    domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none",
  }], "subscription replays verified runtime readiness, never bootstrap room work");
  assert.deepEqual(adapter.capabilities().execution, {
    controlProbe: "unsupported", approvals: { kinds: ["command"], recovery: "native_instance_only", denyScope: "request" },
  });
  assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" });
  assert.deepEqual(events.map(({ fact }) => fact), [
    { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" },
    { domain: "control", kind: "state_changed", state: "unprobeable", sideEffects: "none" },
  ], "the unsupported probe state is still published to typed-shadow history");
  const request = { inboxItemId: "typed-inbox", actionId: "typed-action", sourceMessage: {}, activation: {} };
  const running = adapter.runRoomTurn(handle, request);
  await flush();
  const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  const session_id = handle.providerContinuationId;
  child.emit({ type: "command_lifecycle", state: "started", command_uuid: "wrong", session_id });
  child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id: "wrong" });
  child.emit({ type: "assistant", session_id, message: { content: [
    { type: "tool_use", id: "bootstrap-tail", name: "Bash", input: { command: "late-bootstrap" } },
  ] } });
  child.emit({ type: "user", session_id, message: { content: [
    { type: "tool_result", tool_use_id: "bootstrap-tail", is_error: false, content: "finished" },
  ] } });
  assert.equal(events.length, 2);
  child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id });
  child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id });
  child.emit({ type: "user", session_id, message: { content: [
    { type: "tool_result", tool_use_id: "bootstrap-tail", is_error: false, content: "finished" },
  ] } });
  child.emit({ type: "assistant", session_id, message: { content: [
    { type: "tool_use", id: "shell-1", name: "Bash", input: { command: "secret-command" } },
  ] } });
  assert.equal(events.length, 3, "the control state, runtime readiness, and native turn start are proved");
  child.emit({ type: "user", session_id, message: { content: [
    { type: "tool_result", tool_use_id: "unmatched", is_error: true, content: "secret-output" },
    { type: "tool_result", tool_use_id: "shell-1", is_error: true, content: "secret-output" },
  ] } });
  child.emit({ type: "user", session_id, message: { content: [
    { type: "tool_result", tool_use_id: "shell-1", is_error: true },
  ] } });
  const failedResult = { type: "result", subtype: "error_max_turns", is_error: true, session_id, user_message_uuid: turnId };
  child.emit(failedResult);
  assert.equal((await running).outcome, "failed");
  child.emit(failedResult);
  assert.equal(handle.observedState(), "idle", "typed collection preserves legacy containment");
  assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" }, "turn failure is not runtime death");

  const next = adapter.runRoomTurn(handle, { ...request, inboxItemId: "typed-next" });
  await flush();
  const nextId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  child.emit({ type: "result", subtype: "success", is_error: false, session_id, user_message_uuid: nextId, result: "ready" });
  assert.equal((await next).text, "ready");
  let projection = emptyExecutionProjection();
  let runtimeReadyObserved = false;
  for (const event of events) {
    projection = reduceExecutionFact(projection, {
      ...event.fact, ...("providerTurnId" in event.fact ? { turnId: event.fact.providerTurnId } : {}),
      factId: `fact-${event.sequence}`, agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: "runtime",
      observerEpoch: 1, sourceSequence: event.sequence, observedAtMs: event.observedAtMs,
    });
    assert.equal(event.nativeProcessIdentity, birthIdentity(child.pid!));
    if (event.fact.domain === "runtime" && event.fact.state === "ready") runtimeReadyObserved = true;
    if (runtimeReadyObserved) {
      assert.equal(projection.runtime, "ready", "the exact native start proves readiness, which survives turn failure");
    }
  }
  assert.equal(projection.turns.get(turnId)?.outcome, "failed");
  assert.equal(projection.turns.get(nextId)?.outcome, "completed");
  assert.equal(projection.turns.get(turnId)?.operations.get("shell-1")?.startObserved, false);
  assert.equal(projection.turns.get(turnId)?.operations.get("shell-1")?.outcome, "failed");
  assert.equal(events.filter((event) => event.fact.domain === "execution").length, 1);
  assert.doesNotMatch(JSON.stringify(events), /secret-command|secret-output/);
  const streamCheckpointIds = [...new Set(stream.flatMap((event) => event.nativeEventId ? [event.nativeEventId] : []))];
  const typedCheckpointIds = [...new Set(events.flatMap((event) => event.fact.nativeEventId ? [event.fact.nativeEventId] : []))];
  assert.deepEqual(typedCheckpointIds, streamCheckpointIds,
    "exact native command lifecycle and result records correlate both projections");
  assert.equal(stream.every((event) => !event.nativeEventId || event.nativeLifecyclePhase ===
    (event.method === "command_lifecycle" ? "turn_active" : "turn_terminal")), true,
  "correlated Claude events expose only the closed structural lifecycle phase");
  assert.equal(streamCheckpointIds.length, 3, "one start and two terminal records have distinct identities");
  const terminalIds = stream.filter((event) => event.method.startsWith("result") && event.nativeEventId)
    .map((event) => event.nativeEventId);
  assert.equal(terminalIds.length, 3);
  assert.equal(terminalIds[0], terminalIds[1], "an identical terminal replay keeps the first checkpoint identity");
  assert.equal(events.filter((event) => event.fact.domain === "turn" && event.fact.state === "terminal"
    && event.fact.nativeEventId === terminalIds[0]).length, 1, "a replay does not emit another typed terminal");
  const repeatedStartIds = stream.filter((event) => event.method === "command_lifecycle" && event.nativeEventId)
    .map((event) => event.nativeEventId);
  assert.equal(repeatedStartIds.length, 2, "only the two exact repeated native starts are eligible");
  assert.equal(new Set(repeatedStartIds).size, 1, "a replayed native start keeps the same checkpoint identity");
  assert.equal(stream.some((event) => ["assistant", "user"].includes(event.method) && event.nativeEventId !== undefined), false);
  assert.equal(events.some((event) => event.fact.domain === "execution" && event.fact.nativeEventId !== undefined), false);
  assert.deepEqual(harness.signals, []);
  stopStream();
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.deepEqual(await adapter.probeControl(handle), { state: "lost", controlEvidence: "process_exit" });
  assert.equal(events.at(-1)?.fact.domain, "runtime");
});

test("Claude shadow native terminal remains observable behind a legacy failed-state latch", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const events: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => events.push(event));
  const running = adapter.runRoomTurn(handle, { inboxItemId: "latch", actionId: "latch", sourceMessage: {}, activation: {} });
  const rejected = assert.rejects(running, /exited/);
  await flush();
  const child = harness.children[0]!;
  const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  child.emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: handle.providerContinuationId, user_message_uuid: "foreign" });
  assert.equal(handle.observedState(), "failed");
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: handle.providerContinuationId, user_message_uuid: turnId });
  assert.equal(events.length, 2);
  assert.deepEqual(events[0]!.fact, {
    domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none",
  });
  const { nativeEventId, ...terminalFact } = events[1]!.fact;
  assert.match(nativeEventId ?? "", /^nlc1:[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(terminalFact, { domain: "turn", kind: "state_changed", state: "terminal", sideEffects: "none",
    providerContinuationId: handle.providerContinuationId, providerTurnId: turnId, turnOutcome: "completed" });
  assert.equal(handle.observedState(), "failed", "shadow must not repair or rewrite legacy behavior");
  assert.deepEqual(harness.signals, []);
  child.resolveExit({ type: "exit", code: 1, signal: null });
  await rejected;
});

test("Claude Ask before writes owns prompting policy and requires native exact-turn capability", async () => {
  const h = await approvalHarness();
  try {
    assert.equal(argValue(h.harness.launches[0]!.args, "--permission-prompt-tool"), "stdio");
    assert.equal(argValue(h.harness.launches[0]!.args, "--permission-mode"), "default");
    assert.equal(argValue(h.harness.launches[0]!.args, "--setting-sources"), "");
    assert.equal(h.adapter.capabilities().execution?.approvals.denyScope, "request");
  } finally { await h.close(); }
  const old = createHarness({ noApprovalLifecycle: true, versionOutput: "2.1.272 (Claude Code)" });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: old.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest({ permissionProfileId: "ask_before_write", configurationRevision: 1, launchPolicy: claudeAskPolicy })), /exact native turn lifecycle/);
  assert.equal(old.children[0]!.alive, false);
  for (const override of [{ permissionMode: "acceptEdits" }, { allowedTools: ["*"] }, { settings: '{"permissions":{"allow":["Bash"]}}' }, { "permission-mode": "bypassPermissions" }]) {
    await assert.rejects(adapter.spawn(spawnRequest({ permissionProfileId: "ask_before_write", configurationRevision: 1, launchPolicy: { ...claudeAskPolicy, ...override } })), /authority|cannot override/);
  }
});

test("Claude Auto starts in the native mode, keeps the prompt bridge, and refuses a runtime that did not apply it", async () => {
  const claudeAutoPolicy = { ...claudeAskPolicy, permissionMode: "auto" };
  const request = () => spawnRequest({ permissionProfileId: "auto_review", configurationRevision: 1, launchPolicy: claudeAutoPolicy });
  const harness = createHarness({ versionOutput: "2.1.272 (Claude Code)", initPermissionMode: "auto" });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(request());
  try {
    const args = harness.launches[0]!.args;
    assert.equal(argValue(args, "--permission-mode"), "auto");
    assert.equal(argValue(args, "--permission-prompt-tool"), "stdio", "anything Claude leaves undecided still reaches the host");
    assert.equal(argValue(args, "--setting-sources"), "");
    assert.equal(argValue(args, "--settings"), "{}");
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
    assert.equal(args.includes("--allow-dangerously-skip-permissions"), false);
  } finally { await adapter.stop(handle); }

  const unsupported = createHarness({ versionOutput: "2.1.272 (Claude Code)" });
  await assert.rejects(new ClaudeCodeProviderAdapter({ dependencies: unsupported.dependencies }).spawn(request()), /did not start in Auto mode/);
  assert.equal(unsupported.children[0]!.alive, false);

  const old = createHarness({ versionOutput: "2.1.220 (Claude Code)", initPermissionMode: "auto" });
  await assert.rejects(new ClaudeCodeProviderAdapter({ dependencies: old.dependencies }).spawn(request()), /too old for Auto/);
  assert.equal(old.children.length, 0);

  const noLifecycle = createHarness({ noApprovalLifecycle: true, versionOutput: "2.1.272 (Claude Code)", initPermissionMode: "auto" });
  await assert.rejects(new ClaudeCodeProviderAdapter({ dependencies: noLifecycle.dependencies }).spawn(request()), /exact native turn lifecycle/);

  for (const override of [{ permissionMode: "bypassPermissions" }, { permissionMode: "default" }, { allowedTools: ["*"] }, { "permission-mode": "bypassPermissions" }, { dangerouslySkipPermissions: true }]) {
    await assert.rejects(adapter.spawn(spawnRequest({ permissionProfileId: "auto_review", configurationRevision: 1, launchPolicy: { ...claudeAutoPolicy, ...override } })), /authority|cannot override/);
  }
});

for (const reply of ["once", "reject"] as const) test(`Claude native ${reply} applies once to the exact tool and never persists permission suggestions`, async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool(); h.permission(); const expected = h.requests[0]!;
    assert.deepEqual(await h.adapter.correlatePermissionTurn(h.handle, expected), { outcome: "correlated", providerContinuationId: h.handle.providerContinuationId, providerTurnId: h.turnId });
    h.permission(); assert.equal(h.requests.length, 1);
    const order: string[] = [];
    assert.deepEqual(await h.adapter.replyPermission(h.handle, expected, reply, { beforeNativeDispatch: async () => { order.push("journal"); }, assertNativeDispatch: () => { order.push("fence"); } }), { outcome: "sent", scope: "request" });
    assert.deepEqual(order, ["journal", "fence"]);
    const response = JSON.parse(h.child.written.at(-1)!).response;
    assert.equal(response.request_id, expected.id);
    assert.deepEqual(response.response, reply === "once" ? { behavior: "allow", updatedInput: expected.request.input } : { behavior: "deny", message: "The host rejected this action." });
    assert.equal(h.requests.length, 0);
    assert.equal(h.streams.some(event => event.method === "control_request"), false);
    h.permission(); assert.equal(h.requests.length, 0, "resolved IDs cannot be reused");
    await assert.rejects(h.adapter.replyPermission(h.handle, expected, reply, { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
  } finally { await h.close(); }
});

// Claude reports a denied tool as a generic error result. Only a deny this adapter wrote for that exact
// tool, followed by an error result for it, shows that the tool never ran.
for (const scenario of ["host denied, error result", "host denied, result is not an error", "host allowed, error result",
  "no host answer, error result", "host denied another tool"] as const) {
  test(`Claude reports the outcome of a tool after: ${scenario}`, async () => {
    const h = await approvalHarness();
    try {
      h.started(); h.tool(); h.permission(); const expected = h.requests[0]!;
      if (scenario !== "no host answer, error result") {
        const other = scenario === "host denied another tool";
        if (other) {
          h.child.emit({ type: "assistant", session_id: h.handle.providerContinuationId, parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", id: "tool-other", name: "Write", input: {} }] } });
          h.child.emit({ type: "control_request", request_id: "other-request",
            request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "tool-other", input: {} } });
        }
        const target = other ? h.requests.find(request => request.id === "other-request")! : expected;
        await h.adapter.replyPermission(h.handle, target, scenario === "host allowed, error result" ? "once" : "reject", { beforeNativeDispatch: async () => {} });
      }
      h.child.emit({ type: "user", session_id: h.handle.providerContinuationId,
        message: { content: [{ type: "tool_result", tool_use_id: "tool-write", content: "result",
          is_error: scenario !== "host denied, result is not an error" }] } });
      const completed = h.facts.map(event => event.fact).filter(fact => fact.domain === "execution" && fact.kind === "completed");
      assert.equal(completed.length, 1);
      const fact = completed[0]!;
      assert.equal(fact.domain === "execution" && fact.executionId, "tool-write");
      if (scenario === "host denied, error result") {
        assert.equal(fact.domain === "execution" && fact.kind === "completed" && fact.outcome, "denied_before_start");
        assert.equal(fact.sideEffects, "none");
      } else {
        assert.equal(fact.domain === "execution" && fact.kind === "completed" && fact.outcome,
          scenario === "host denied, result is not an error" ? "succeeded" : "failed");
        assert.equal(fact.sideEffects, "possible");
      }
    } finally { await h.close(); }
  });
}

test("Claude approval correlation excludes pre-start, foreign, subagent, changed and completed tools", async () => {
  const h = await approvalHarness();
  try {
    h.tool(); h.permission({ request_id: "before-start" }); assert.equal(h.requests.length, 0);
    // Before the turn has started no approval can be shown for it. The CLI is answered, so that it does not wait.
    assert.deepEqual(JSON.parse(h.child.written.at(-1)!).response, { subtype: "success", request_id: "before-start",
      response: { behavior: "deny", message: "No room turn is open that an approval could be shown for, so this action was not allowed." } });
    h.started(); h.tool({ session_id: "foreign" }); h.permission();
    assert.deepEqual(await h.adapter.correlatePermissionTurn(h.handle, h.requests[0]!), { outcome: "correlation_unproven" });
    h.child.emit({ type: "control_cancel_request", request_id: "native-request" });
    h.tool({ parent_tool_use_id: "subagent" }); h.permission({ request_id: "subagent-request" });
    assert.deepEqual(await h.adapter.correlatePermissionTurn(h.handle, h.requests[0]!), { outcome: "correlation_unproven" });
    h.tool(); h.permission({ request_id: "valid-request" });
    const expected = h.requests.find(request => request.id === "valid-request")!;
    const changed = structuredClone(expected); changed.request.input.content = "changed";
    assert.deepEqual(await h.adapter.correlatePermissionTurn(h.handle, changed), { outcome: "correlation_unproven" });
    await assert.rejects(h.adapter.replyPermission(h.handle, changed, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
    h.child.emit({ type: "user", session_id: h.handle.providerContinuationId, parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "tool-write", content: "Denied", is_error: true }] } });
    await assert.rejects(h.adapter.replyPermission(h.handle, expected, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
  } finally { await h.close(); }
});

for (const invalidation of ["cancel", "disconnect", "process-replaced", "terminal"] as const) {
  test(`Claude approval is fenced when ${invalidation} arrives during durable admission`, async () => {
    const h = await approvalHarness();
    try {
      h.started(); h.tool(); h.permission(); const expected = h.requests[0]!;
      const before = h.child.written.length;
      await assert.rejects(h.adapter.replyPermission(h.handle, expected, "once", { beforeNativeDispatch: async () => {
        if (invalidation === "cancel") h.child.emit({ type: "control_cancel_request", request_id: expected.id });
        if (invalidation === "disconnect") h.child.disconnect();
        if (invalidation === "process-replaced") h.harness.identities.set(h.handle.pid!, "other-birth");
        if (invalidation === "terminal") h.child.emit({ type: "result", subtype: "success", is_error: false, session_id: h.handle.providerContinuationId, user_message_uuid: h.turnId, result: "Done" });
      } }), { outcome: "not_dispatched" });
      assert.equal(h.child.written.length, before);
    } finally { await h.close(); }
  });
}

test("Claude approval serializes replies and refuses retry after an uncertain stdin write", async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool(); h.permission(); const expected = h.requests[0]!;
    let release!: () => void; const admitted = new Promise<void>(resolve => { release = resolve; });
    const first = h.adapter.replyPermission(h.handle, expected, "once", { beforeNativeDispatch: () => admitted });
    await assert.rejects(h.adapter.replyPermission(h.handle, expected, "reject", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
    const original = h.child.writeLine.bind(h.child);
    h.child.writeLine = () => { throw new Error("pipe lost after write attempt"); };
    release(); await assert.rejects(first, { outcome: "uncertain" });
    h.child.writeLine = original;
    await assert.rejects(h.adapter.replyPermission(h.handle, expected, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
  } finally { await h.close(); }
});

for (const observer of ["attached", "detached before interrupt", "detached during interrupt"]) test(`Claude cancellation at a native approval uses its exact aborted-tools boundary (${observer})`, async () => {
  const delivery = new AbortController();
  const h = await approvalHarness(delivery.signal);
  try {
    h.started(); h.tool(); h.permission(); const pending = h.requests[0]!;
    if (observer === "detached before interrupt") {
      delivery.abort();
      await flush();
      assert.equal(h.handle.observedState(), "working", "detaching delivery does not stop native work");
    }
    const interrupted = h.adapter.controlTurn(h.handle, null, { targetTurnId: h.turnId });
    if (observer === "detached during interrupt") delivery.abort();
    await flush();
    h.child.emit({ type: "control_cancel_request", request_id: pending.id });
    h.child.emit({ type: "result", subtype: "error_during_execution", terminal_reason: "aborted_tools", is_error: true,
      session_id: h.handle.providerContinuationId, user_message_uuid: h.turnId });
    assert.equal((await interrupted).interrupted, true);
    assert.equal(h.handle.observedState(), "idle");
    const writes = h.child.written.length;
    const recovered = await h.adapter.recoverRoomTurn(h.handle, { inboxItemId: "approval-inbox", providerTurnId: h.turnId });
    assert.equal(recovered.outcome, "interrupted");
    assert.equal(h.child.written.length, writes, "recovery consumes the interrupted result without another native request");
    await assert.rejects(h.adapter.replyPermission(h.handle, pending, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
  } finally { await h.close(); }
});

for (const invalid of ["foreign session", "foreign turn", "missing tool turn", "natural failure"]) {
  test(`detached Claude interruption still rejects ${invalid} evidence`, async () => {
    const delivery = new AbortController();
    const h = await approvalHarness(delivery.signal);
    try {
      h.started(); h.tool(); h.permission();
      delivery.abort();
      await flush();
      const interrupted = h.adapter.controlTurn(h.handle, null, { targetTurnId: h.turnId });
      const rejected = assert.rejects(interrupted, /instead of an exact-session interrupted boundary/);
      await flush();
      h.child.emit({ type: "result", subtype: "error_during_execution", is_error: true,
        terminal_reason: invalid === "natural failure" ? "tool_error" : "aborted_tools",
        session_id: invalid === "foreign session" ? "other-session" : h.handle.providerContinuationId,
        user_message_uuid: invalid === "foreign turn" ? "other-turn" : invalid === "missing tool turn" ? undefined : h.turnId });
      await rejected;
    } finally { await h.close(); }
  });
}

test("Claude explicit foreign tool-turn UUID cannot create or resolve approval authority", async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool({ user_message_uuid: "previous-turn" }); h.permission();
    assert.deepEqual(await h.adapter.correlatePermissionTurn(h.handle, h.requests[0]!), { outcome: "correlation_unproven" });
    await assert.rejects(h.adapter.replyPermission(h.handle, h.requests[0]!, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
    h.child.emit({ type: "control_cancel_request", request_id: "native-request" });
    h.tool({ user_message_uuid: h.turnId }); h.permission({ request_id: "current-request" });
    const expected = h.requests[0]!;
    const result = { type: "user", session_id: h.handle.providerContinuationId, parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "tool-write", content: "Done" }] } };
    h.child.emit({ ...result, user_message_uuid: "previous-turn" });
    assert.equal((await h.adapter.correlatePermissionTurn(h.handle, expected)).outcome, "correlated");
    h.child.emit({ ...result, user_message_uuid: h.turnId });
    assert.equal((await h.adapter.correlatePermissionTurn(h.handle, expected)).outcome, "correlation_unproven");
  } finally { await h.close(); }
});

test("Claude refuses to fall back to npx when the sealed MCP runtime cannot be verified", async () => {
  assert.throws(() => createManagedClaudeMcpConfig("https://letagents.example", tmpdir(), undefined, () => {
    throw new Error("runtime integrity failure");
  }), /runtime integrity failure/);
});

for (const cause of ["cancel", "failed", "succeeded", "terminal"] as const) {
  test(`Claude publishes exact request closure for ${cause}, including a sent prompt`, async () => {
    const h = await approvalHarness();
    try {
      h.started(); h.tool(); h.permission();
      const expected = h.requests[0]!;
      if (cause === "failed" || cause === "succeeded") {
        await h.adapter.replyPermission(h.handle, expected, "once", { beforeNativeDispatch: async () => {} });
        assert.equal(h.requests.length, 0);
        h.child.emit({ type: "user", session_id: h.handle.providerContinuationId,
          message: { content: [{ type: "tool_result", tool_use_id: "tool-write", is_error: cause === "failed", content: "result" }] } });
      } else if (cause === "cancel") h.child.emit({ type: "control_cancel_request", request_id: expected.id });
      else h.child.emit({ type: "result", subtype: "interrupted", is_error: true,
        session_id: h.handle.providerContinuationId, user_message_uuid: h.turnId });
      assert.deepEqual(h.closures, [{ type: "request_closed", request: expected,
        providerContinuationId: h.handle.providerContinuationId, providerTurnId: h.turnId }]);
      h.child.emit({ type: "control_cancel_request", request_id: expected.id });
      assert.equal(h.closures.length, 1);
    } finally { await h.close(); }
  });
}

test("Claude cannot close a prompt from foreign tool, turn, session or process evidence", async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool(); h.permission();
    const result = { type: "user", session_id: h.handle.providerContinuationId,
      message: { content: [{ type: "tool_result", tool_use_id: "tool-write", content: "done" }] } };
    h.child.emit({ ...result, session_id: "foreign" });
    h.child.emit({ ...result, user_message_uuid: "foreign" });
    h.child.emit({ ...result, message: { content: [{ type: "tool_result", tool_use_id: "other", content: "done" }] } });
    assert.equal(h.closures.length, 0);
    h.harness.identities.set(h.handle.pid!, "different-birth");
    h.child.emit({ type: "control_cancel_request", request_id: "native-request" });
    assert.equal(h.closures.length, 0);
  } finally { await h.close(); }
});

test("Claude disconnect clears native pendingness without inventing request closure", async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool(); h.permission(); h.child.disconnect();
    assert.equal(h.closures.length, 0);
  } finally { await h.close(); }
});

for (const cause of ["cancel", "result"] as const) test(`Claude retires an evicted pending permission on exact ${cause}`, async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool(); h.permission(); const original = h.requests[0]!;
    for (let index = 0; index < 65; index++) {
      const toolId = `later-tool-${index}`;
      h.child.emit({ type: "assistant", session_id: h.handle.providerContinuationId,
        message: { content: [{ type: "tool_use", id: toolId, name: "Write", input: {} }] } });
      h.child.emit({ type: "control_request", request_id: `later-request-${index}`,
        request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: toolId, input: {} } });
    }
    if (cause === "cancel") h.child.emit({ type: "control_cancel_request", request_id: original.id });
    else h.child.emit({ type: "user", session_id: h.handle.providerContinuationId,
      message: { content: [{ type: "tool_result", tool_use_id: "tool-write", is_error: true, content: "failed" }] } });
    assert.ok(h.requests.every(request => request.id !== original.id));
    assert.equal(h.closures.length, 1);
    await assert.rejects(h.adapter.replyPermission(h.handle, original, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
  } finally { await h.close(); }
});


test("compaction uses cumulative separate budgets; repeated starts and cleared statuses never refill them", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  let wakes = 0;
  const tracker = new ClaudeCompaction("session", 30_000, 300_000,
    () => new Date(clock).toISOString(), () => { wakes++; }, () => clock);
  const tick = (ms: number) => { clock += ms; t.mock.timers.tick(ms); };
  const status = (value: unknown, extra = {}) => tracker.observe({ type: "system", subtype: "status", session_id: "session", status: value, ...extra });
  tick(10_000);
  status("compacting");
  const first = tracker.progress();
  tick(100_000);
  status("compacting");
  assert.deepEqual(tracker.progress(), first);
  assert.equal(wakes, 1);
  status(null); // Ends busy status, but is never a bootstrap result.
  tick(10_000);
  status("compacting");
  tick(199_999);
  assert.equal(tracker.failure, null);
  tick(1);
  assert.equal(await tracker.deadline, "compaction_deadline");
  assert.equal(tracker.progress(), null);
  tracker.close();
});

for (const completion of ["boundary", "success", "cleared", "requesting"] as const) {
  test(`compaction ${completion} resumes only the unused normal startup budget`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let clock = 0;
    const tracker = new ClaudeCompaction("session", 30_000, 300_000, () => "2026-09-24T00:00:00Z", undefined, () => clock);
    const tick = (ms: number) => { clock += ms; t.mock.timers.tick(ms); };
    tick(20_000);
    tracker.observe({ type: "system", subtype: "status", session_id: "session", status: "compacting" });
    tick(60_000);
    tracker.observe({ type: "system", session_id: "session", subtype: completion === "boundary" ? "compact_boundary" : "status",
      status: completion === "requesting" ? "requesting" : null, ...(completion === "success" ? { compact_result: "success" } : {}) });
    assert.equal(tracker.progress(), null);
    tick(9_999);
    assert.equal(tracker.failure, null);
    tick(1);
    assert.equal(await tracker.deadline, "deadline");
    tracker.close();
  });
}

test("foreign, missing-session and subagent compaction cannot extend startup; explicit failure wins", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  const tracker = new ClaudeCompaction("session", 30_000, 300_000, () => "now", undefined, () => clock);
  for (const extra of [{ session_id: "other" }, {}, { session_id: "session", parent_tool_use_id: "subagent" }]) {
    tracker.observe({ type: "system", subtype: "status", status: "compacting", ...extra });
    assert.equal(tracker.progress(), null);
  }
  tracker.observe({ type: "system", subtype: "status", session_id: "session", status: "compacting", compact_result: "failed", compact_error: "PRIVATE" });
  assert.equal(await tracker.deadline, "compaction_failed");
  assert.equal(tracker.progress(), null);
  tracker.close();
  tracker.observe({ type: "system", subtype: "status", session_id: "session", status: "compacting" });
  assert.equal(tracker.progress(), null);
});

test("router exposes exact child compaction before admission, then ordinary bootstrap proof is still required", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const pump = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
  const harness = createHarness({ omitBootstrapResult: true,
    bootstrapMessages: session_id => [{ type: "system", subtype: "status", status: "compacting", session_id }] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const router = new ProviderActionPortRouter({ "claude-code": async () => adapter });
  let wakes = 0;
  const req = { ...spawnRequest({ onProgress: () => wakes++ }), provider: "claude-code" };
  let admitted = false;
  const launched = router.spawn(req).then((handle: { observedState: string }) => { admitted = true; return handle; });
  await pump();
  assert.equal(router.compactionProgress(req.workAttemptId, "claude-code")?.state, "compacting");
  assert.equal(router.compactionProgress(req.workAttemptId, "codex"), null);
  assert.equal(router.compactionProgress("another-attempt", "claude-code"), null);
  clock = 60_000; t.mock.timers.tick(60_000); await pump();
  assert.equal(admitted, false);
  assert.deepEqual(harness.signals, []);
  const child = harness.children[0]!;
  const session = argValue(harness.launches[0]!.args, "--session-id")!;
  child.emit({ type: "system", subtype: "compact_boundary", session_id: session });
  await pump();
  assert.equal(admitted, false, "compaction completion is not readiness");
  assert.equal(router.compactionProgress(req.workAttemptId, "claude-code"), null);
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: session,
    user_message_uuid: JSON.parse(child.written[0]!).uuid, result: "LETAGENTS_CLAUDE_DAEMON_READY" });
  const handle = await launched;
  assert.equal(handle.observedState, "idle");
  child.emit({ type: "system", subtype: "status", session_id: session, status: "compacting" });
  assert.equal(router.compactionProgress(req.workAttemptId, "claude-code")?.state, "compacting",
    "the same owner supplies progress for later native turns");
  child.emit({ type: "system", subtype: "status", session_id: "other", status: null });
  assert.ok(router.compactionProgress(req.workAttemptId, "claude-code"));
  harness.identities.set(child.pid!, null);
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await pump();
  assert.equal(router.compactionProgress(req.workAttemptId, "claude-code"), null);
  assert.ok(wakes >= 4);
});

for (const elapsed of [299_999, 300_001]) test(`bootstrap admission accounts ${elapsed}ms compaction even before its timer runs`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const harness = createHarness({ omitBootstrapResult: true,
    bootstrapMessages: session_id => [{ type: "system", subtype: "status", status: "compacting", session_id }] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const launched = adapter.spawn(spawnRequest());
  for (let n = 0; n < 40; n++) await Promise.resolve();
  const child = harness.children[0]!;
  clock = elapsed; // Intentionally leave the overdue timer undelivered.
  child.emit({ type: "result", subtype: "success", is_error: false,
    session_id: argValue(harness.launches[0]!.args, "--session-id"),
    user_message_uuid: JSON.parse(child.written[0]!).uuid, result: "LETAGENTS_CLAUDE_DAEMON_READY" });
  if (elapsed < 300_000) {
    assert.equal((await launched).observedState(), "idle");
    harness.identities.set(child.pid!, null);
    child.resolveExit({ type: "exit", code: 0, signal: null });
  } else {
    await assert.rejects(launched, { reason: "compaction_deadline" });
    assert.deepEqual(harness.signals, [{ pid: child.pid, signal: "SIGTERM" }]);
  }
  for (let n = 0; n < 40; n++) await Promise.resolve();
  assert.equal(adapter.compactionProgress("wa-claude-1"), null);
});

for (const sameBatchExit of [false, true]) test(`buffered explicit compaction failure blocks a success result (same-batch exit=${sameBatchExit})`, async () => {
  const harness = createHarness({
    ...(sameBatchExit ? { exitAfterBootstrapResult: { type: "exit" as const, code: 0, signal: null } } : {}),
    bootstrapMessages: session_id => [{ type: "system", subtype: "status", status: null, compact_result: "failed", session_id }],
  });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest()), { reason: "compaction_failed" });
  assert.equal(adapter.compactionProgress("wa-claude-1"), null);
});
