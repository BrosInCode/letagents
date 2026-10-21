import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_BACKGROUND_COMMAND_WAIT_LIMIT_MS,
  CLAUDE_BACKGROUND_NOTICE_START_LIMIT_MS,
  CLAUDE_BACKGROUND_SUBAGENT_WAIT_LIMIT_MS,
  CLAUDE_BACKGROUND_WORK_ANSWER_METHOD,
  CLAUDE_BACKGROUND_WORK_FINISHED_METHOD,
  CLAUDE_BACKGROUND_WORK_METHOD,
  CLAUDE_BACKGROUND_WORK_TEXT,
  ClaudeCodeProviderAdapter,
  claudeBackgroundWorkWaitSummary,
} from "../main/agents/claude-code-provider-adapter.js";
import { CLAUDE_TURN_WITHOUT_MODEL_TEXT } from "../main/agents/claude-room-turn-evidence.js";
import { CLAUDE_REAL_CAPTURES, claudeCapturedTask, realClaudeCapture, realClaudeResult } from "./claude-result-shapes.js";
import { mapEntry } from "../main/supervisor-daemon.js";
import {
  providerStreamLifecycle,
  humanFacingSupervisorActivitySummary,
  isHumanVisibleSupervisorActivity,
  supervisedAgentWorkIndicators,
  createHarness,
  spawnRequest,
  flush,
  claudeDaemonFixture,
  nextClaudeTurnId,
  TURNS_ANSWER,
  NOTICE_ANSWER,
  approvalHarness,
  ROOM_SERVER,
  OWNER_SERVER,
  OWN_SETUP,
  ownSetupAskPolicy,
  splitAtOwnResult,
  withText,
  pause,
  MINUTE,
  COMMAND_TASK,
  FAILING_COMMAND_TASK,
  FAILED_ANSWER_COMMAND_TASK,
  APPROVAL_COMMAND_TASK,
  INTERRUPTED_SUBAGENT_TASK,
  SUBAGENT_TASK,
  COMMAND_BESIDE_SUBAGENT_TASK,
  ONE_AFTER_THE_OTHER_TASKS,
  WAITS_FOR_COMMAND,
  WAITS_FOR_ANSWER,
  claudeBackgroundHarness,
  methodOf,
  reply,
  withoutRepeats,
  withTasks,
  forNextTurn,
} from "./claude-code-provider-adapter.fixture.js";

test("a request nobody can answer is turned down at once instead of holding the turn", async () => {
  const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [OWNER_SERVER, ROOM_SERVER] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({
    configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP,
  }));
  const child = harness.children[0]!;
  const answers = () => child.written.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.type === "control_response");
  const observed: unknown[] = [];
  const controller = new AbortController();
  void adapter.observePermissions(handle, (event) => { observed.push(event); }, controller.signal);
  const activity: string[] = [];
  // The background service keeps an agent's activity from its stream, so that is where each one must be.
  adapter.onStream(handle, (event) => { if (event.method === "control_request/declined") activity.push(event.summary ?? ""); });

  // One of the owner's MCP servers asks the person to type something.
  child.emit({ type: "control_request", request_id: "elicit-1", request: {
    subtype: "elicitation", mcp_server_name: "owner_browser", message: "Which account?", mode: "form",
    requested_schema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] },
  } });
  // A skill's helper agent wants a tool approved.
  child.emit({ type: "control_request", request_id: "sub-1", request: {
    subtype: "can_use_tool", tool_name: "mcp__owner_browser__owner_write", input: {}, tool_use_id: "toolu_sub_1", agent_id: "a37a052b",
  } });
  assert.deepEqual(answers(), [
    { type: "control_response", response: { subtype: "success", request_id: "elicit-1", response: { action: "decline" } } },
    { type: "control_response", response: { subtype: "success", request_id: "sub-1", response: {
      behavior: "deny", message: "LetAgents cannot show an approval for a sub-agent's action, so it was not allowed.",
    } } },
  ]);

  // The owner can see in the agent's activity what was turned down, and whose request it was.
  assert.deepEqual(activity, [
    'Declined a request for typed input from your MCP server "owner_browser". LetAgents cannot show it.',
    "Did not allow the tool \"mcp__owner_browser__owner_write\" for a skill's helper agent. LetAgents cannot show an approval for it.",
  ]);
  child.emit({ type: "control_request", request_id: "elicit-2", request: {
    subtype: "elicitation", mcp_server_name: "owner_browser", message: "Sign in", mode: "url", url: "https://example.invalid/sign-in",
  } });
  assert.equal(activity.at(-1), 'Declined a request for a sign-in from your MCP server "owner_browser". LetAgents cannot show it.');
  activity.length = 0;

  // The agent's own tool call in a room turn is never answered here: it waits for the owner's decision.
  const writtenBefore = child.written.length;
  const running = adapter.runRoomTurn(handle, { inboxItemId: "inbox", actionId: "action", sourceMessage: {}, activation: {} });
  const turnId = await nextClaudeTurnId(child, writtenBefore);
  child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id: handle.providerContinuationId });
  child.emit({ type: "control_request", request_id: "own-1", request: {
    subtype: "can_use_tool", tool_name: "mcp__owner_browser__owner_write", input: {}, tool_use_id: "toolu_1",
    mcp_server: { name: "owner_browser", source: "user" }, display_name: "Owner Write",
  } });
  // Neither is anything the room's own server might one day ask.
  child.emit({ type: "control_request", request_id: "room-1", request: {
    subtype: "elicitation", mcp_server_name: "letagents", message: "?", mode: "form", requested_schema: { type: "object", properties: {} },
  } });
  assert.equal(answers().length, 3);
  assert.deepEqual(activity, [], "nothing is reported as declined that was not");
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: handle.providerContinuationId, user_message_uuid: turnId, result: "Done" });
  await running;
  controller.abort();
  assert.equal(JSON.stringify(observed).includes("elicit-1") || JSON.stringify(observed).includes("sub-1"), false,
    "a declined request is never offered as an approval");
});

test("one of the owner's MCP tools asks for approval through the same flow as the agent's built-in tools", async () => {
  for (const reply of ["once", "reject"] as const) {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [OWNER_SERVER, ROOM_SERVER] });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP,
    }));
    const child = harness.children[0]!;
    const controller = new AbortController();
    let requests: import("../../shared/provider-permissions.js").ClaudeNativePermissionRequest[] = [];
    const observing = adapter.observePermissions(handle, event => { if (event.type === "snapshot") requests = [...event.requests]; }, controller.signal);
    const running = adapter.runRoomTurn(handle, { inboxItemId: "inbox", actionId: "action", sourceMessage: { text: "Click the button" }, activation: {} }, {});
    void running.catch(() => {});
    await flush();
    const turnId = JSON.parse(child.written.at(-1)!).uuid as string;
    child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id: handle.providerContinuationId });
    child.emit({ type: "assistant", session_id: handle.providerContinuationId, parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_owner", name: "mcp__owner_browser__owner_write", input: { selector: "#buy" } }] } });
    // The request exactly as Claude Code 2.1.278 sends it for a user-scope MCP tool.
    child.emit({ type: "control_request", request_id: "native-owner-tool", request: {
      subtype: "can_use_tool", tool_name: "mcp__owner_browser__owner_write", mcp_server: { name: "owner_browser", source: "user" },
      display_name: "Owner Write", input: { selector: "#buy" }, tool_use_id: "toolu_owner",
      permission_suggestions: [{ type: "addRules", rules: [{ toolName: "mcp__owner_browser__owner_write" }], behavior: "allow", destination: "localSettings" }],
    } });
    await flush();
    assert.equal(requests.length, 1, "the owner sees it as a pending approval");
    assert.equal(requests[0]!.request.tool_name, "mcp__owner_browser__owner_write");
    assert.equal(child.written.some((line) => line.includes("control_response")), false, "nothing is decided for the owner");
    assert.deepEqual(await adapter.correlatePermissionTurn(handle, requests[0]!),
      { outcome: "correlated", providerContinuationId: handle.providerContinuationId, providerTurnId: turnId });
    assert.deepEqual(await adapter.replyPermission(handle, requests[0]!, reply, { beforeNativeDispatch: async () => {} }),
      { outcome: "sent", scope: "request" });
    assert.deepEqual(JSON.parse(child.written.at(-1)!), { type: "control_response", response: {
      subtype: "success", request_id: "native-owner-tool",
      response: reply === "once" ? { behavior: "allow", updatedInput: { selector: "#buy" } } : { behavior: "deny", message: "The host rejected this action." },
    } });
    child.emit({ type: "result", subtype: "success", is_error: false, session_id: handle.providerContinuationId, user_message_uuid: turnId, result: "Done" });
    await running.catch(() => {}); controller.abort(); await observing; await adapter.stop(handle);
  }
});

// A room turn stays open for background work that it started.

test("a Claude turn that started background work stays open: the owner reads what it waits for, the next message waits behind it, and the room gets one reply", async () => {
  const agent = await claudeDaemonFixture();
  try {
    const turn = await agent.begin(1);
    const { own, after } = splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.background_command!, agent.sessionId, turn.id).stream, turn.id);
    for (const event of own) turn.child.emit(event);
    // The turn's own result has arrived, and the command that the turn started still runs.
    const waiting = async () => (await agent.view()).activity.filter((event) => event.method === CLAUDE_BACKGROUND_WORK_METHOD).at(-1);
    await agent.eventually(async () => Boolean(await waiting()), "the owner is told that the turn waits");
    const notice = (await waiting())!;
    assert.deepEqual([notice.summary, notice.status, notice.kind], [WAITS_FOR_COMMAND, "working", "provider_event"]);
    assert.equal(isHumanVisibleSupervisorActivity(notice), true, "Chat shows it");
    assert.equal(humanFacingSupervisorActivitySummary(notice), WAITS_FOR_COMMAND, "in the adapter's own words");

    // A message that arrives now waits behind the open turn, as behind any turn that runs.
    agent.send(2);
    await agent.eventually(async () => Boolean(await agent.receipt("msg_2")), "msg_2 is in the inbox");
    await pause(200);
    assert.deepEqual(agent.published, [], "nothing is posted while the turn is open");
    assert.equal(agent.turns.length, 1, "and the CLI is sent no new prompt");
    assert.equal((await agent.receipt("msg_1"))!.state, "dispatching");
    assert.equal((await agent.receipt("msg_2"))!.state, "pending");
    const open = await agent.view();
    assert.deepEqual([open.observed_state, open.condition, open.room_agent_state.turn.state], ["working", "none", "responding"]);
    assert.deepEqual(agent.recorded().turns.map((recorded) => recorded.state), ["active"], "the record holds the turn open too");

    // The command ends, and the CLI answers its notice in a turn of its own.
    for (const event of after) turn.child.emit(event);
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered");
    assert.deepEqual(agent.published, [`${TURNS_ANSWER}\n\n${NOTICE_ANSWER}`], "one reply: the interim answer, a blank line, the later answer");
    await agent.eventually(() => agent.turns.length === 2, "msg_2 starts its turn when the first has ended");
    agent.reportStarted(agent.turns[1]!);
    agent.answer(agent.turns[1]!, "Answer 2.");
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
    assert.deepEqual(agent.published, [`${TURNS_ANSWER}\n\n${NOTICE_ANSWER}`, "Answer 2."], "and nothing is posted twice");
    await agent.eventually(() => agent.recorded().turns.every((recorded) => recorded.state === "terminal"), "both turns are closed in the record");
    assert.deepEqual(agent.recorded().endings.map((ending) => [ending.n, ending.outcome]), [[1, "completed"], [1, "completed"]]);
    assert.equal(agent.recorded().gaps, 0);
    assert.equal((await agent.view()).room_agent_state.inbox.state, "empty");
  } finally {
    await agent.cleanup();
  }
});

for (const lateNotice of ["after the next turn's result, as the CLI wrote it", "before the next turn's result"] as const) {
  test(`a Claude turn whose background command outlasts its limit ends with its answer and one line, and the agent is free; the notice that is answered ${lateNotice} is posted nowhere and ends no turn`, async () => {
    const agent = await claudeDaemonFixture({ adapter: { backgroundCommandWaitLimitMs: 400 } });
    try {
      const turn = await agent.begin(1);
      // Real lines: a turn, then a second prompt, and the task ends while the second turn runs.
      const stream = realClaudeCapture(CLAUDE_REAL_CAPTURES.task_ends_during_next_turn!, agent.sessionId, turn.id).stream;
      const { own, after } = splitAtOwnResult(stream, turn.id);
      for (const event of own) turn.child.emit(event);
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered at the limit");
      assert.deepEqual(agent.published, [`${TURNS_ANSWER}\n\n${CLAUDE_BACKGROUND_WORK_TEXT.commandStillRuns}`]);

      const next = await agent.begin(2);
      const later = withText(after, "SECOND_TURN_ID", next.id);
      const nextResult = later.findIndex((event) => event.type === "result" && event.user_message_uuid === next.id);
      assert.ok(nextResult > 0 && later.slice(nextResult).some((event) => event.type === "result" && event.user_message_uuid === undefined));
      // The lines of the task's end and of the answer to its notice, which the CLI wrote after the second turn's result.
      const noticeAnswer = later.slice(nextResult + 2);
      if (lateNotice === "before the next turn's result") {
        // The same lines, in the order of a CLI that answers the notice before it starts the prompt that waits.
        for (const event of [...later.slice(0, nextResult - 1).filter((event) => event.type === "system"), ...noticeAnswer]) next.child.emit(event);
        await pause(200);
        assert.equal((await agent.receipt("msg_2"))!.state, "dispatching", "the answer to another turn's notice does not end this turn");
        assert.equal(agent.published.length, 1, "and is not posted as its answer");
        for (const event of later.slice(0, nextResult + 2).filter((event) => event.type !== "system")) next.child.emit(event);
      } else {
        for (const event of later) next.child.emit(event);
      }
      await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
      const third = await agent.begin(3);
      agent.reportStarted(third);
      agent.answer(third, "Answer 3.");
      await agent.eventually(async () => (await agent.receipt("msg_3"))?.state === "acknowledged", "msg_3 is answered");
      assert.deepEqual(agent.published, [`${TURNS_ANSWER}\n\n${CLAUDE_BACKGROUND_WORK_TEXT.commandStillRuns}`, "ANSWER OF THE SECOND TURN", "Answer 3."],
        "the late answer to the notice is in no reply");
      await agent.eventually(async () => (await agent.view()).activity.some((event) => event.summary === CLAUDE_BACKGROUND_WORK_TEXT.notPosted), "the owner reads that it was not posted");
      const current = await agent.view();
      assert.equal(current.activity.some((event) => event.summary === CLAUDE_BACKGROUND_WORK_TEXT.limitReached), false, "a command that still runs is no fault to report");
      assert.equal(current.condition, "none", current.last_error ?? "");
      assert.deepEqual(agent.recorded().endings.map((ending) => [ending.n, ending.outcome]), [[1, "completed"], [1, "completed"], [1, "completed"]]);
    } finally {
      await agent.cleanup();
    }
  });
}

test("the owner's Stop on a Claude turn that waits for background work posts the answer the turn has, and frees the agent; the work's later notice is no other turn's", async () => {
  const agent = await claudeDaemonFixture();
  try {
    const turn = await agent.begin(1);
    const first = splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.background_command!, agent.sessionId, turn.id).stream, turn.id);
    for (const event of first.own) turn.child.emit(event);
    await agent.eventually(async () => (await agent.view()).activity.some((event) => event.method === CLAUDE_BACKGROUND_WORK_METHOD), "the turn waits");
    const written = turn.child.written.length;
    const startedAt = Date.now();
    const stopped = await agent.stopTurn("msg_1", turn);
    assert.equal(stopped.ok, true, stopped.error);
    assert.ok(Date.now() - startedAt < 5_000, "Stop does not wait for the CLI: the command had ended with its answer");
    assert.equal(stopped.result.interrupted, false, "nothing was interrupted: the turn's reply stands");
    assert.deepEqual(turn.child.written.slice(written).map((line) => (JSON.parse(line) as { request?: { subtype?: string } }).request?.subtype), ["interrupt"],
      "the CLI is sent an interrupt, which stops the answer to a notice when one runs, and no background work");
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered").catch(async (error) => {
      const row = await agent.receipt("msg_1");
      throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error}); posted ${JSON.stringify(agent.published)}`);
    });
    assert.deepEqual(agent.published, [`${TURNS_ANSWER}\n\n${CLAUDE_BACKGROUND_WORK_TEXT.ownerEnded}`], "the answer is not thrown away: it is posted, with a line that the owner ended the wait");
    assert.equal((await agent.receipt("msg_1"))!.last_error, null);

    // The next message starts background work of its own. Then the first turn's command ends, and its notice is answered.
    const next = await agent.begin(2);
    const second = splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.background_command_fails!, agent.sessionId, next.id).stream, next.id);
    for (const event of second.own) next.child.emit(event);
    for (const event of withText(first.after, NOTICE_ANSWER, "ANSWER TO THE STOPPED TURN'S TASK NOTICE")) next.child.emit(event);
    await pause(200);
    assert.equal((await agent.receipt("msg_2"))!.state, "dispatching", "the notice of the first turn's work does not end the turn that waits for its own");
    assert.equal(agent.published.length, 1);
    for (const event of second.after) next.child.emit(event);
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
    assert.deepEqual(agent.published.slice(1), [`${TURNS_ANSWER}\n\n${NOTICE_ANSWER}`], "with the answer to its own work's notice, and not to the other's. Nothing is posted twice");
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

for (const ended of ["Claude process", "Claude process and daemon"] as const) for (const left of ["the turn alone", "the turn and the task's notice", "the turn, the task's notice and the answer to it"] as const) {
  test(`a Claude turn that waits for background work when its ${ended} ends, with ${left} in the session, gets the reply that the session holds posted once, and never its interim answer as if that were all`, async () => {
    const agent = await claudeDaemonFixture();
    try {
      const turn = await agent.begin(1);
      const capture = realClaudeCapture(CLAUDE_REAL_CAPTURES.background_command!, agent.sessionId, turn.id);
      for (const event of splitAtOwnResult(capture.stream, turn.id).own) turn.child.emit(event);
      await agent.eventually(async () => (await agent.view()).activity.some((event) => event.method === CLAUDE_BACKGROUND_WORK_METHOD), "the turn waits");
      assert.deepEqual(agent.published, []);
      // The session as the CLI kept it when the process ended: the turn alone, the task's notice too, or also the answer to it.
      const [messages, expected] = left === "the turn alone" ? [4, `${TURNS_ANSWER}\n\n${CLAUDE_BACKGROUND_WORK_TEXT.noReportInSession}`]
        : left === "the turn and the task's notice" ? [5, `${TURNS_ANSWER}\n\n${CLAUDE_BACKGROUND_WORK_TEXT.notReported}`] : [6, `${TURNS_ANSWER}\n\n${NOTICE_ANSWER}`];
      const lastMessage = capture.session[messages - 1]!;
      agent.sessionRows.push(...capture.session_file.slice(0, capture.session_file.indexOf(capture.session_file.find((row) => row.uuid === lastMessage.uuid)!) + 1));
      if (ended === "Claude process") agent.exitProcess();
      else await agent.restartDaemon(() => agent.exitProcess());
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered").catch(async (error) => {
        const row = await agent.receipt("msg_1");
        throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error})`);
      });
      const next = await agent.begin(2);
      agent.reportStarted(next);
      agent.answer(next, "Answer 2.");
      await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 goes ahead and is answered");
      assert.deepEqual(agent.published, [expected, "Answer 2."],
        "one reply: the answers that the session proves, as the adapter would have posted them, and one line when the session does not prove them complete");
      assert.equal(agent.turns.length, 2, "the turn is not run again");
      assert.equal((await agent.view()).room_agent_state.inbox.state, "empty");
    } finally {
      await agent.cleanup();
    }
  });
}

test("a Claude agent that holds a task gets one reply for a turn with background work, and no follow-up when the answer to the notice fails", async () => {
  const agent = await claudeDaemonFixture({ ownedTasks: () => [{ id: "task_1", title: "Task", leaseId: "lease_1", epoch: 1 }], skipFollowUpDelay: true });
  try {
    for (const [ordinal, name, reply] of [[1, "background_command", `${TURNS_ANSWER}\n\n${NOTICE_ANSWER}`],
      [2, "background_command_notice_api_error", `${TURNS_ANSWER}\n\n${CLAUDE_BACKGROUND_WORK_TEXT.notReported}`]] as const) {
      const turn = await agent.begin(ordinal);
      for (const event of realClaudeCapture(CLAUDE_REAL_CAPTURES[name]!, agent.sessionId, turn.id).stream) turn.child.emit(event);
      await agent.eventually(async () => (await agent.receipt(`msg_${ordinal}`))?.state === "acknowledged", `msg_${ordinal} is answered`);
      assert.equal(agent.published.at(-1), reply);
    }
    await pause(200);
    assert.equal(agent.published.length, 2);
    assert.deepEqual((await agent.receipts()).map((item) => item.state), ["acknowledged", "acknowledged"], "no follow-up turn is queued, and nothing is blocked");
    assert.deepEqual(agent.followUpWaits, []);
    const failure = async () => (await agent.view()).activity.find((event) => event.method === CLAUDE_BACKGROUND_WORK_ANSWER_METHOD && event.summary.startsWith(CLAUDE_BACKGROUND_WORK_TEXT.answerFailed));
    await agent.eventually(async () => Boolean(await failure()), "the failure is in the agent's activity");
    assert.equal((await failure())!.summary, `${CLAUDE_BACKGROUND_WORK_TEXT.answerFailed} API Error: 400 probe says the request with the task's notice is invalid`,
      "the failure's text is kept for the owner");
    assert.equal((await agent.view()).condition, "none");
  } finally {
    await agent.cleanup();
  }
});

for (const lifecycleAuthorityMode of ["typed", "typed_shadow"] as const) {
  test(`a Claude turn with no background work, a foreground sub-agent, a skill or a Stop hook is published line for line and ends on its own result (${lifecycleAuthorityMode})`, async () => {
    const agent = await claudeBackgroundHarness({ lifecycleAuthorityMode });
    for (const [name, answer] of [["completed_answer", "PROBE_OK"], ["subagent_in_foreground", TURNS_ANSWER], ["skill_call", TURNS_ANSWER],
      ["stop_hook_refuses_end_once", "ANSWER AFTER THE HOOK"], ["task_ends_while_turn_goes_on", "ANSWER OF THE TURN, TO A REQUEST THAT HOLDS THE TASK NOTICE"]] as const) {
      const turn = await agent.start(name);
      const result = turn.lines.findIndex((event) => event.type === "result");
      agent.emit(turn.lines.slice(0, result));
      assert.equal(turn.settled(), false, name);
      agent.emit(turn.lines.slice(result, result + 1));
      assert.deepEqual(await turn.running, reply(turn.turnId, answer), `${name}: the turn ends on its own result`);
      agent.emit(turn.lines.slice(result + 1));
      const published = agent.stream.slice(turn.publishedBefore);
      assert.deepEqual(published.map((event) => event.method), turn.lines.map(methodOf), `${name}: each line of the CLI is published once, as itself, in its order`);
      assert.deepEqual(published.map((event) => event.payload), turn.lines, `${name}: with the line as its payload`);
      assert.deepEqual(published.filter((event) => event.nativeLifecyclePhase === "turn_terminal").map((event) => event.method), ["result/success"], name);
      assert.deepEqual(turn.saved, [reply(turn.turnId, answer)], name);
      assert.equal(agent.handle.observedState(), "idle", name);
    }
    assert.equal(agent.endings.length, 5, "one ending for each turn");
    await agent.adapter.stop(agent.handle);
  });

  test(`a Claude turn that is held open for background work publishes its own result when it ends, and says that it waits until then (${lifecycleAuthorityMode})`, async () => {
    const agent = await claudeBackgroundHarness({ lifecycleAuthorityMode });
    const turn = await agent.start("background_command");
    const written = agent.child.written.length;
    agent.emit(turn.own);
    await flush();
    assert.equal(turn.settled(), false, "the turn's own result does not end the turn");
    assert.equal(agent.handle.observedState(), "working", "and the agent is not idle");
    assert.deepEqual(agent.endings, [], "nothing says that the turn has ended");
    assert.deepEqual(agent.activity.at(-1), { workAttemptId: "wa-claude-1", providerContinuationId: agent.sessionId, observedAt: agent.activity.at(-1)!.observedAt,
      source: "native_harness", method: CLAUDE_BACKGROUND_WORK_METHOD, summary: WAITS_FOR_COMMAND, status: "working", checking: "", nextAction: "" });
    // A second prompt is refused while the turn is open, as for any turn that runs.
    await assert.rejects(agent.adapter.runRoomTurn(agent.handle, { inboxItemId: "inbox-other", actionId: "action-other", sourceMessage: {}, activation: {} }),
      /already has a bounded room turn in progress/);
    agent.emit(turn.after);
    assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER, NOTICE_ANSWER));
    assert.deepEqual(turn.saved, [reply(turn.turnId, TURNS_ANSWER, NOTICE_ANSWER)], "the result is saved once");
    assert.deepEqual(agent.writtenSince(written), [], "every notice was answered: the CLI runs nothing, and is sent no interrupt");
    assert.deepEqual(agent.endings, [{ turnId: turn.turnId, outcome: "completed" }], "one ending, when the turn ended");
    assert.equal(agent.handle.observedState(), "idle");

    const published = withoutRepeats(agent.stream.slice(turn.publishedBefore));
    const result = turn.lines.findIndex((event) => event.type === "result");
    assert.deepEqual(published.map((event) => event.method), [
      ...turn.lines.slice(0, result).map(methodOf),
      // In place of the turn's own result: the turn waits for the command.
      CLAUDE_BACKGROUND_WORK_METHOD,
      "command_lifecycle", "system/background_tasks_changed", "system/task_updated", "system/task_notification",
      // The command has ended: the turn waits for the answer to its notice.
      CLAUDE_BACKGROUND_WORK_METHOD,
      "assistant",
      // The result that answers the notice. It names no command and ends no turn.
      CLAUDE_BACKGROUND_WORK_ANSWER_METHOD,
      // The turn's own result, now that the turn has ended.
      "result/success",
    ]);
    assert.deepEqual(published.filter((event) => event.method === CLAUDE_BACKGROUND_WORK_METHOD).map((event) => event.summary), [WAITS_FOR_COMMAND, WAITS_FOR_ANSWER]);
    // What the model writes in the turn itself is what Chat shows. While the turn is held open the wait is: the rows
    // of the answer to the notice are published too, as events that do not take the place of the wait.
    assert.deepEqual(published.filter((event) => event.method === "assistant" || event.method === "user").map((event) => [event.method, event.kind, isHumanVisibleSupervisorActivity(event)]),
      [["assistant", "text_delta", true], ["user", "tool_lifecycle", true], ["assistant", "text_delta", true], ["assistant", "provider_event", false]]);
    assert.deepEqual(published.at(-1)!.payload, turn.lines[result], "the line is the CLI's own");
    assert.deepEqual(published.filter((event) => event.nativeLifecyclePhase !== undefined).map((event) => [event.method, event.nativeLifecyclePhase]),
      [["command_lifecycle", "turn_active"], ["result/success", "turn_terminal"]]);
    // The daemon reads the agent as working for as long as the turn is open, and never as failed.
    const waitStarted = published.findIndex((event) => event.method === CLAUDE_BACKGROUND_WORK_METHOD);
    assert.deepEqual([...new Set(published.slice(waitStarted, -1).map((event) => providerStreamLifecycle(event, true)))], ["working"]);
    assert.equal(providerStreamLifecycle(published.at(-1)!, true), "terminal");
    const count = agent.stream.length;
    await pause(60);
    assert.equal(agent.stream.length, count, "a turn that has ended says nothing more");
    await agent.adapter.stop(agent.handle);
  });
}

test("what the owner reads while a Claude turn is held open: what it waits for, by kind, and what to expect", async () => {
  assert.equal(CLAUDE_BACKGROUND_SUBAGENT_WAIT_LIMIT_MS, 30 * MINUTE);
  assert.equal(CLAUDE_BACKGROUND_COMMAND_WAIT_LIMIT_MS, 2 * MINUTE);
  assert.equal(CLAUDE_BACKGROUND_NOTICE_START_LIMIT_MS, 5 * MINUTE);
  const shown = (summary: string) => humanFacingSupervisorActivitySummary({ kind: "provider_event", method: CLAUDE_BACKGROUND_WORK_METHOD, summary });
  const command = (description: string, running = true) => ({ description, kind: "command" as const, running });
  const subagent = (description: string, running = true) => ({ description, kind: "subagent" as const, running });
  const other = (description: string, running = true) => ({ description, kind: "other" as const, running });
  for (const [waitsFor, waitedMs, endedMs, summary] of [
    // A command: the owner reads how long the turn waits for it at most.
    [[command("probe")], 0, 0, WAITS_FOR_COMMAND],
    [[command("Start the server"), command("Watch the tests")], 90_000, 0, 'Waiting up to 2 min for background commands: "Start the server", "Watch the tests".'],
    // Work of a kind that is not a command and not a sub-agent has the same limit, and is not called a command.
    [[other("Monitor")], 0, 0, 'Waiting up to 2 min for background work: "Monitor".'],
    [[command("Server"), other("Monitor")], 0, 0, 'Waiting up to 2 min for background work: "Server", "Monitor".'],
    // A sub-agent: the owner reads how long the turn has waited.
    [[subagent("Review")], 59_999, 0, 'Waiting for a sub-agent to finish (under 1 min): "Review".'],
    [[subagent("Review"), subagent("Plan")], 12 * MINUTE + 5, 0, 'Waiting for sub-agents to finish (12 min): "Review", "Plan".'],
    [[subagent("one"), subagent("two"), subagent("three"), subagent("four"), subagent("five")], 29 * MINUTE, 0, 'Waiting for sub-agents to finish (29 min): "one", "two", "three" and 2 more.'],
    // Both, in one line.
    [[command("Server"), subagent("Review")], MINUTE, 0, 'Waiting for a sub-agent to finish (1 min): "Review". Also up to 2 min for a background command: "Server".'],
    // Work that has ended is no longer named: the turn waits for the answer about it, and says when the work ended.
    [[command("Server", false), subagent("Review")], 3 * MINUTE, 0, 'Waiting for a sub-agent to finish (3 min): "Review".'],
    [[command("Server", false)], 3 * MINUTE, 20_000, "Waiting for Claude's answer about background work that ended under 1 min ago."],
    [[subagent("Review", false)], 20 * MINUTE, 4 * MINUTE, "Waiting for Claude's answer about background work that ended 4 min ago."],
  ] as const) {
    assert.equal(claudeBackgroundWorkWaitSummary(waitsFor, waitedMs, endedMs), summary);
    // Chat shows the adapter's sentence, and cuts a line of more than a hundred characters at its end.
    assert.equal(shown(summary), summary.length <= 100 ? summary : `${summary.slice(0, 99).trimEnd()}…`);
  }
  // Only the event that says the turn waits is shown in Chat. The rest stays in the agent's activity.
  assert.equal(isHumanVisibleSupervisorActivity({ kind: "provider_event", method: CLAUDE_BACKGROUND_WORK_METHOD }), true);
  for (const method of [CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, CLAUDE_BACKGROUND_WORK_FINISHED_METHOD]) {
    assert.equal(isHumanVisibleSupervisorActivity({ kind: "provider_event", method }), false);
  }
  // The daemon reads an answer to a notice that belongs to no open turn as the end of work, and never as a failure of the agent.
  const failedAnswer = { provider: "claude-code", kind: "provider_event", payload: { type: "result", subtype: "success", is_error: true } };
  assert.equal(providerStreamLifecycle({ ...failedAnswer, method: CLAUDE_BACKGROUND_WORK_FINISHED_METHOD }, true), "idle");
  assert.equal(providerStreamLifecycle({ ...failedAnswer, method: CLAUDE_BACKGROUND_WORK_ANSWER_METHOD }, true), "working");
  assert.equal(providerStreamLifecycle({ ...failedAnswer, method: "result/success" }, true), "failed", "as the same result is under its own name");

  // The time is the adapter's clock. The description is the model's own, as one printable line.
  const agent = await claudeBackgroundHarness();
  // Real lines of a turn whose sub-agent still runs after the turn's own result.
  const turn = await agent.start("subagent_stopped_by_request");
  agent.emit(withText(turn.own, "probe", "Review the\n\"full\" diff\u0007 " + "x".repeat(200)));
  const described = `Review the full diff ${"x".repeat(59)}`;
  assert.equal(agent.waits(), `Waiting for a sub-agent to finish (under 1 min): "${described}".`);
  await agent.after(3 * MINUTE + 20);
  assert.equal(agent.waits(), `Waiting for a sub-agent to finish (3 min): "${described}".`, "the turn says again that it waits, with the time it has waited");
  assert.deepEqual(agent.stream.filter((event) => event.method === CLAUDE_BACKGROUND_WORK_METHOD).at(-1)!.payload, { waiting_for: [described], waited_ms: 3 * MINUTE + 20 });
  assert.equal(shown(agent.waits()!), `${agent.waits()!.slice(0, 99).trimEnd()}…`, "Chat cuts a long line at its end, after the time");
  assert.equal(turn.settled(), false);
  await agent.adapter.stop(agent.handle);
});

test("a Claude turn waits two minutes for a background command that still runs, then posts its answer with one line and frees the agent", async () => {
  const agent = await claudeBackgroundHarness();
  const turn = await agent.start("background_command");
  agent.emit(turn.own);
  assert.equal(agent.waits(), WAITS_FOR_COMMAND, "the owner reads what to expect");
  await agent.after(2 * MINUTE - 1);
  assert.equal(turn.settled(), false, "before the limit the turn waits");
  const written = agent.child.written.length;
  await agent.after(1);
  // A server or a watcher is meant to go on: the turn does not wait for it any longer.
  assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.commandStillRuns));
  assert.deepEqual(agent.writtenSince(written), [], "the CLI is sent no interrupt: only the command runs, and it is meant to go on");
  assert.deepEqual(agent.endings, [{ turnId: turn.turnId, outcome: "completed" }]);
  assert.equal(agent.handle.observedState(), "idle");
  assert.equal(agent.stream.some((event) => event.summary === CLAUDE_BACKGROUND_WORK_TEXT.limitReached), false, "this is the usual end, and no fault for the owner to read");

  // The agent is free: the next turn starts. The command ends during it, and its notice is answered. That reaches no turn.
  const next = await agent.start("completed_answer");
  agent.emit(turn.after);
  await flush();
  assert.equal(next.settled(), false, "the next turn does not end on the answer to the notice");
  assert.deepEqual([agent.stream.at(-1)!.method, agent.stream.at(-1)!.summary], [CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, CLAUDE_BACKGROUND_WORK_TEXT.notPosted]);
  agent.emit(next.lines);
  assert.deepEqual(await next.running, reply(next.turnId, "PROBE_OK"), "and is in no reply");

  // Work of a kind that has not been captured is waited for as long as a command, and is not called one. These are
  // the lines of a command, with another name for the kind of task.
  const other = await agent.start("background_command_fails");
  agent.emit(JSON.parse(JSON.stringify(other.own).replaceAll("\"local_bash\"", "\"local_workflow\"")) as Array<Record<string, unknown>>);
  assert.equal(agent.waits(), 'Waiting up to 2 min for background work: "probe".');
  const writtenThen = agent.child.written.length;
  await agent.after(2 * MINUTE);
  assert.deepEqual(await other.running, reply(other.turnId, TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.stillRunning));
  assert.deepEqual(agent.writtenSince(writtenThen), [], "and is not interrupted either");
  assert.equal(CLAUDE_BACKGROUND_WORK_TEXT.stillRunning, "Background work that this turn started was still running when this reply was posted. Claude's later answer about it will not be posted.");
  await agent.adapter.stop(agent.handle);
});

test("a Claude turn with a sub-agent and a long-running command waits for the sub-agent, and not for the command beyond its two minutes", async () => {
  const agent = await claudeBackgroundHarness();
  // Real lines: one message starts a sub-agent and a background command. The sub-agent ends first.
  const turn = await agent.start("subagent_and_background_command");
  agent.emit(turn.own);
  assert.equal(agent.waits(), 'Waiting for a sub-agent to finish (under 1 min): "review probe". Also up to 2 min for a background command: "server probe".');
  await agent.after(2 * MINUTE);
  // The command has passed its limit. The sub-agent has not: the turn stays open for the sub-agent alone.
  assert.equal(turn.settled(), false, "a command that passed its limit does not end a turn that still waits for a sub-agent");
  assert.equal(agent.waits(), 'Waiting for a sub-agent to finish (2 min): "review probe".', "and the owner reads that the turn waits for the sub-agent only");
  await agent.after(20 * MINUTE);
  assert.equal(turn.settled(), false, "the sub-agent has thirty minutes");
  // The sub-agent ends, and the model answers its notice. The command still runs.
  const firstAnswer = turn.after.findIndex((event) => event.type === "result");
  agent.emit(turn.after.slice(0, firstAnswer + 1));
  assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", CLAUDE_BACKGROUND_WORK_TEXT.commandStillRuns),
    "the turn ends when the sub-agent is answered: it does not go back to waiting for the command");
  // The command ends later. The answer to its notice is posted nowhere.
  agent.emit(turn.after.slice(firstAnswer + 1));
  assert.deepEqual([agent.stream.at(-1)!.method, agent.stream.at(-1)!.summary], [CLAUDE_BACKGROUND_WORK_FINISHED_METHOD, CLAUDE_BACKGROUND_WORK_TEXT.notPosted]);
  assert.deepEqual(turn.saved, [reply(turn.turnId, TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", CLAUDE_BACKGROUND_WORK_TEXT.commandStillRuns)], "one result");

  // A command that ends within its two minutes is answered in the same reply, whenever the sub-agent ends.
  const both = await agent.start("subagent_and_background_command");
  const another = (events: Array<Record<string, unknown>>) => JSON.parse(JSON.stringify(events).replaceAll(SUBAGENT_TASK, "a0there5ubagent").replaceAll(COMMAND_BESIDE_SUBAGENT_TASK, "b0therta5k")) as Array<Record<string, unknown>>;
  agent.emit(another(both.lines));
  assert.deepEqual(await both.running, reply(both.turnId, TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", "ANSWER TO THE SECOND TASK NOTICE"));

  // A sub-agent that does not finish in thirty minutes is a fault, and the reply says so. The command is still no fault.
  const slow = await agent.start("subagent_and_background_command");
  const slower = (events: Array<Record<string, unknown>>) => JSON.parse(JSON.stringify(events).replaceAll(SUBAGENT_TASK, "a510w5ubagent").replaceAll(COMMAND_BESIDE_SUBAGENT_TASK, "b510wta5k")) as Array<Record<string, unknown>>;
  agent.emit(slower(slow.own));
  await agent.after(30 * MINUTE - 1);
  assert.equal(slow.settled(), false);
  const written = agent.child.written.length;
  await agent.after(1);
  assert.deepEqual(await slow.running, reply(slow.turnId, TURNS_ANSWER, `${CLAUDE_BACKGROUND_WORK_TEXT.subagentTimedOut} ${CLAUDE_BACKGROUND_WORK_TEXT.commandStillRuns}`));
  // No answer runs. The interrupt is for the sub-agent: no turn waits for its report any more. The command goes on.
  assert.deepEqual(agent.writtenSince(written), ["interrupt"], "the sub-agent that passed its limit is stopped with the turn");
  // The lines are true wherever they are posted: a command of any length, and a sub-agent that the turn or a later answer started.
  assert.equal(CLAUDE_BACKGROUND_WORK_TEXT.commandStillRuns, "A command that this turn started was still running in the background when this reply was posted. Claude's later answer about it will not be posted.");
  assert.equal(CLAUDE_BACKGROUND_WORK_TEXT.subagentTimedOut, "A sub-agent that this turn started did not finish in the time allowed, and was stopped. Its report is not in this reply and will not be posted.");
  assert.equal(agent.stream.filter((event) => event.summary === CLAUDE_BACKGROUND_WORK_TEXT.limitReached).length, 1, "and the owner reads that a limit was reached");
  await agent.adapter.stop(agent.handle);
});

test("the owner's Stop on a Claude turn that waits for background work ends the wait at once and keeps the answer; what the CLI writes afterwards reaches no later turn", async () => {
  const agent = await claudeBackgroundHarness();
  // Real lines: a turn, then the answer to its task's notice, which an interrupt ends.
  const turn = await agent.start("interrupt_during_task_notice_answer");
  agent.emit(turn.own);
  const notification = turn.after.findIndex((event) => event.subtype === "task_notification");
  // The command has ended, and the CLI answers its notice when the owner stops the turn.
  agent.emit(turn.after.slice(0, notification + 1));
  assert.equal(turn.settled(), false);
  const calls: string[] = [];
  const written = agent.child.written.length;
  const startedAt = Date.now();
  const control = await agent.adapter.controlTurn(agent.handle, null, { targetTurnId: turn.turnId,
    checkpointTurnStarted: async (turnId) => { calls.push(`checkpoint ${turnId === turn.turnId}`); }, markDispatched: async () => { calls.push("dispatched"); } });
  // The turn's command had ended with its answer: nothing was interrupted, and the daemon lets the reply stand.
  assert.deepEqual(control, { capability: "native_interrupt", interrupted: false, resumed: false, state: "idle" });
  assert.ok(Date.now() - startedAt < 2_000, "with no wait for a result of the CLI");
  assert.deepEqual(calls, ["checkpoint true", "dispatched"], "the daemon is told before the wait is ended");
  assert.deepEqual(agent.child.written.slice(written).map((line) => (JSON.parse(line) as { request?: { subtype?: string } }).request?.subtype), ["interrupt"],
    "the CLI is sent an interrupt for the answer that runs. Nothing asks it to stop the background work");
  assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.ownerEnded), "the answer is posted, with one line that the owner ended the wait");
  assert.deepEqual(turn.saved, [reply(turn.turnId, TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.ownerEnded)]);
  assert.deepEqual(agent.endings, [{ turnId: turn.turnId, outcome: "completed" }]);
  assert.equal(agent.handle.observedState(), "idle");
  assert.equal(agent.activity.at(-1)!.summary, "Turn completed");

  // The next turn has started when the CLI writes how the interrupted answer ended: a result with an error, which names no command.
  const next = await agent.start("completed_answer");
  agent.emit(turn.after.slice(notification + 1));
  await flush();
  assert.equal(next.settled(), false, "the next turn does not end on it");
  assert.equal(agent.handle.observedState(), "working", "and the agent has not failed: it runs the next turn");
  assert.deepEqual([agent.stream.at(-1)!.method, agent.stream.at(-1)!.summary], [CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, CLAUDE_BACKGROUND_WORK_TEXT.notPostedUnfinished],
    "the owner reads that an answer was stopped, not that Claude answered");
  agent.emit(next.lines);
  assert.deepEqual(await next.running, reply(next.turnId, "PROBE_OK"));
  // A second Stop for the turn that has ended does nothing.
  assert.deepEqual(await agent.adapter.controlTurn(agent.handle, null, { targetTurnId: turn.turnId }), { capability: "native_interrupt", interrupted: false, resumed: false, state: "idle" });

  // A turn in which the model had no reply for the room posts nothing when its owner ends the wait.
  const silent = await agent.start("background_command");
  agent.emit(withText(silent.own, TURNS_ANSWER, "LETAGENTS_NO_ROOM_REPLY"));
  await agent.adapter.controlTurn(agent.handle, null, { targetTurnId: silent.turnId });
  assert.deepEqual(await silent.running, { turnId: silent.turnId, outcome: "no_reply", text: null, evidence: "stream" });
  await agent.adapter.stop(agent.handle);
});

test("a Stop that the owner sent before a Claude turn's own result is an ordinary stop, with background work or without", async () => {
  const agent = await claudeBackgroundHarness();
  // The model had answered before the interrupt reached it: the turn ends with its answer, and is not held open.
  const answered = await agent.start("background_command");
  const result = answered.own.findIndex((event) => event.type === "result");
  agent.emit(answered.own.slice(0, result));
  const written = agent.child.written.length;
  const refused = assert.rejects(agent.adapter.controlTurn(agent.handle, null, { targetTurnId: answered.turnId }),
    (error: unknown) => (error as { turnControlOutcome?: string }).turnControlOutcome === "not_applied");
  while (agent.child.written.length === written) await new Promise((resolve) => setImmediate(resolve));
  agent.emit(answered.own.slice(result));
  assert.deepEqual(await answered.running, reply(answered.turnId, TURNS_ANSWER), "the turn is not held open against the owner's Stop");
  await refused;

  // The interrupt reached the model: the turn ends interrupted, as before, and nothing of it is posted.
  const stopped = await agent.start("background_command_fails");
  agent.emit(stopped.own.slice(0, stopped.own.findIndex((event) => event.type === "result")));
  const writtenThen = agent.child.written.length;
  const stopping = agent.adapter.controlTurn(agent.handle, null, { targetTurnId: stopped.turnId });
  while (agent.child.written.length === writtenThen) await new Promise((resolve) => setImmediate(resolve));
  agent.emit([{ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", session_id: agent.sessionId, user_message_uuid: stopped.turnId }]);
  assert.deepEqual(await stopping, { capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" });
  assert.deepEqual(await stopped.running, { turnId: stopped.turnId, providerContinuationId: agent.sessionId, outcome: "interrupted", text: null, evidence: "stream",
    error: "Claude command ended interrupted." });
  assert.equal(agent.stream.some((event) => event.method === CLAUDE_BACKGROUND_WORK_METHOD), false, "neither turn was held open");
  await agent.adapter.stop(agent.handle);
});

test("a Claude turn whose background work has all ended does not wait long for an answer that never begins", async () => {
  const agent = await claudeBackgroundHarness();
  const turn = await agent.start("background_command");
  agent.emit(turn.own);
  await agent.after(MINUTE);
  assert.equal(turn.settled(), false);
  const notification = turn.after.findIndex((event) => event.subtype === "task_notification");
  // The command ends and the CLI writes nothing more: a turn that still ran took the notice with its last request.
  agent.emit(turn.after.slice(0, notification + 1));
  assert.equal(agent.waits(), WAITS_FOR_ANSWER, "the time is counted from when the work ended, not from the turn's own result a minute before");
  await agent.after(3 * MINUTE);
  assert.equal(agent.waits(), "Waiting for Claude's answer about background work that ended 3 min ago.");
  await agent.after(-3 * MINUTE);
  await agent.after(5 * MINUTE - 1);
  assert.equal(turn.settled(), false, "the answer has five minutes to begin, whatever the limit for the command was");
  await agent.after(1);
  assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER), "the turn ends with the answer it has, and no added line");
  assert.deepEqual(agent.stream.slice(-2).map((event) => [event.method, event.summary]),
    [[CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, CLAUDE_BACKGROUND_WORK_TEXT.noAnswerBegan], ["result/success", undefined]], "the owner reads why");

  // A first line of the answer shows that it has begun. From then on the turn waits for its result.
  const second = await agent.start("background_command");
  // Another command: the CLI gives each task an id of its own.
  const another = (events: Array<Record<string, unknown>>) => JSON.parse(JSON.stringify(events).replaceAll(COMMAND_TASK, "b0therta5k")) as Array<Record<string, unknown>>;
  agent.emit(another(second.own));
  agent.emit(another(second.after.slice(0, -1)));
  await agent.after(20 * MINUTE);
  assert.equal(second.settled(), false, "the answer that has begun is waited for");
  agent.emit(another(second.after.slice(-1)));
  assert.deepEqual(await second.running, reply(second.turnId, TURNS_ANSWER, NOTICE_ANSWER));

  // No turn stays open for more than thirty minutes after its own result: an answer that never ends is given up.
  const third = await agent.start("background_command_fails");
  agent.emit(third.own);
  agent.emit(third.after.slice(0, -1));
  await agent.after(30 * MINUTE - 1);
  assert.equal(third.settled(), false);
  const written = agent.child.written.length;
  await agent.after(1);
  assert.deepEqual(await third.running, reply(third.turnId, TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.notReported));
  assert.equal(agent.stream.filter((event) => event.summary === CLAUDE_BACKGROUND_WORK_TEXT.limitReached).length, 1);
  assert.deepEqual(agent.writtenSince(written), ["interrupt"], "the answer that still runs is interrupted, so the next prompt does not wait behind it");
  await agent.adapter.stop(agent.handle);
});

test("a Claude turn's reply holds each of the model's texts once, in their order, and never a text that was not for the room", async () => {
  const agent = await claudeBackgroundHarness();
  const play = async (name: string, change: (lines: Array<Record<string, unknown>>) => Array<Record<string, unknown>>, thenAfterMs = 0) => {
    const turn = await agent.start(name);
    agent.emit(change(turn.lines));
    if (thenAfterMs) await agent.after(thenAfterMs);
    return { turnId: turn.turnId, result: await turn.running };
  };
  // The answer to the notice repeats the turn's own answer.
  const repeated = await play("background_command", (lines) => withText(lines, NOTICE_ANSWER, TURNS_ANSWER));
  assert.deepEqual(repeated.result, reply(repeated.turnId, TURNS_ANSWER), "the same text is not posted twice");
  // Only a text that repeats the text before it is left out. Two tasks can have the same answer, and the turn's
  // own answer can come again after another text: each of those was written for the room.
  const again = await play("two_background_commands", (lines) => withText(lines, "ANSWER TO THE SECOND TASK NOTICE", TURNS_ANSWER));
  assert.deepEqual(again.result, reply(again.turnId, TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE", TURNS_ANSWER));
  // The model had no reply for the room at first, and one after the work ended.
  const later = await play("background_command", (lines) => withText(lines, TURNS_ANSWER, "LETAGENTS_NO_ROOM_REPLY"));
  assert.deepEqual(later.result, reply(later.turnId, NOTICE_ANSWER));
  // The model has no more to say after the work ended.
  const interim = await play("background_command", (lines) => withText(lines, NOTICE_ANSWER, "LETAGENTS_NO_ROOM_REPLY"));
  assert.deepEqual(interim.result, reply(interim.turnId, TURNS_ANSWER));
  // The model has no reply for the room at all: nothing is posted, with or without a line of the adapter's.
  const none = await play("background_command", (lines) => withText(withText(lines, TURNS_ANSWER, "LETAGENTS_NO_ROOM_REPLY"), NOTICE_ANSWER, "LETAGENTS_NO_ROOM_REPLY"));
  assert.deepEqual(none.result, { turnId: none.turnId, outcome: "no_reply", text: null, evidence: "stream" });
  const ownLines = (lines: Array<Record<string, unknown>>) => splitAtOwnResult(lines, lines.find((event) => event.type === "result")!.user_message_uuid as string);
  const silent = await play("background_command", (lines) => ownLines(withText(lines, TURNS_ANSWER, "LETAGENTS_NO_ROOM_REPLY")).own, 2 * MINUTE);
  assert.deepEqual(silent.result, { turnId: silent.turnId, outcome: "no_reply", text: null, evidence: "stream" }, "at a limit too");
  // A sub-agent's report reaches the model, and is in no reply.
  for (const name of ["subagent_in_background", "two_subagents_in_background", "subagent_stopped_by_request", "subagent_and_background_command"]) {
    const played = await play(name, (lines) => lines);
    assert.equal(played.result.outcome, "reply", name);
    assert.ok(!(played.result as { text: string }).text.includes("SUBAGENT REPORT"), name);
  }
  await agent.adapter.stop(agent.handle);
});

for (const lifecycleAuthorityMode of ["typed", "typed_shadow"] as const) test(`a Claude turn that failed ends on its own result, whatever background work it started; the agent is idle after a late answer (${lifecycleAuthorityMode})`, async () => {
  const agent = await claudeBackgroundHarness({ lifecycleAuthorityMode });
  const turn = await agent.start("background_command");
  // The same lines, with the result of a request that the provider refused.
  const failed = realClaudeResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.http_400_invalid_request!, agent.sessionId, turn.turnId));
  agent.emit(turn.own.map((event) => event.type === "result" ? failed : event));
  const result = await turn.running;
  assert.deepEqual([result.outcome, result.text], ["failed", null]);
  assert.equal(agent.stream.some((event) => event.method === CLAUDE_BACKGROUND_WORK_METHOD), false, "a failed turn is not held open");
  // The answer to the notice comes when no room turn runs: the agent is idle after it, and nothing ends on it.
  agent.emit(turn.after);
  assert.deepEqual([agent.stream.at(-1)!.method, agent.stream.at(-1)!.summary], [CLAUDE_BACKGROUND_WORK_FINISHED_METHOD, CLAUDE_BACKGROUND_WORK_TEXT.notPosted]);
  assert.equal(providerStreamLifecycle(agent.stream.at(-1)!, true), "idle");
  assert.equal(agent.handle.observedState(), "idle", "the agent itself says so too: the rows of the answer had made it working");
  const next = await agent.start("completed_answer");
  agent.emit(next.lines);
  assert.deepEqual(await next.running, reply(next.turnId, "PROBE_OK"));
  await agent.adapter.stop(agent.handle);
});

for (const capture of ["approval_in_task_notice_answer_denied_and_interrupted", "approval_in_task_notice_answer_interrupted"] as const) {
  test(`a Claude turn that ends at its limit while an answer to a notice waits for an approval denies the approval and interrupts the answer, and the next turn runs (${capture})`, async () => {
    const agent = await claudeBackgroundHarness({ asksForApproval: true });
    // Real lines of an agent that asks before it writes: the model answers the task's notice with a command that needs approval.
    const turn = await agent.start(capture);
    agent.emit(turn.own);
    const asks = turn.after.findIndex((event) => event.type === "control_request");
    agent.emit(turn.after.slice(0, asks + 1));
    await flush();
    assert.equal(turn.settled(), false);
    assert.equal(agent.approvals.pending.length, 1, "the owner is shown the approval, for the turn that is held open");
    const requestId = agent.approvals.pending[0]!.id;
    // Nobody answers. The answer to the notice cannot go on, and the turn reaches the end of its time.
    await agent.after(30 * MINUTE - 1);
    assert.equal(turn.settled(), false);
    const written = agent.child.written.length;
    await agent.after(1);
    assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.notReported));
    // With the turn the approval's card goes. The CLI is told that the action is denied, and to stop the answer.
    assert.deepEqual(agent.writtenSince(written), [`deny ${requestId}`, "interrupt"], "the CLI does not wait for an approval that nobody can give any more");
    assert.deepEqual([agent.approvals.pending.length, agent.approvals.closed], [0, [requestId]]);

    // The next room turn. Real lines again: what the CLI wrote after the interrupt, and for the prompt that followed it.
    const next = await agent.start("completed_answer");
    assert.equal(JSON.parse(agent.child.written.at(-1)!).uuid, next.turnId, "the prompt is written after the interrupt");
    const following = forNextTurn(turn.after.slice(asks + 1), next.turnId);
    const nextResult = following.findIndex((event) => event.type === "result" && event.user_message_uuid === next.turnId);
    assert.ok(nextResult > 0);
    agent.emit(following.slice(0, nextResult));
    await flush();
    assert.equal(next.settled(), false, "how the interrupted answer ended does not end the next turn");
    assert.equal(agent.stream.filter((event) => event.summary === CLAUDE_BACKGROUND_WORK_TEXT.notPostedUnfinished).length, 1);
    agent.emit(following.slice(nextResult));
    assert.deepEqual(await next.running, reply(next.turnId, "ANSWER OF THE SECOND TURN"), "the next turn starts and ends as any turn");
    assert.equal(agent.handle.observedState(), "idle");
    assert.deepEqual(agent.endings.map((ending) => ending.outcome), ["completed", "completed"]);
    await agent.adapter.stop(agent.handle);
  });
}

test("a Claude turn that gives up an answer to a notice interrupts it, so the next message does not wait behind it", async () => {
  const agent = await claudeDaemonFixture({ adapter: { backgroundNoticeStartLimitMs: 400 } });
  try {
    const turn = await agent.begin(1);
    // Real lines: a turn, then the answer to its task's notice, which an interrupt ends, and the prompt that was sent with the interrupt.
    const { own, after } = splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.interrupt_during_task_notice_answer_then_prompt!, agent.sessionId, turn.id).stream, turn.id);
    for (const event of own) turn.child.emit(event);
    const notification = after.findIndex((event) => event.subtype === "task_notification");
    const written = turn.child.written.length;
    // The command ends. The model is asked about it, and no line of its answer comes in time.
    for (const event of after.slice(0, notification + 1)) turn.child.emit(event);
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered with what the turn has");
    assert.deepEqual(agent.published, [TURNS_ANSWER]);
    assert.deepEqual(turn.child.written.slice(written).map((line) => (JSON.parse(line) as { request?: { subtype?: string } }).request?.subtype), ["interrupt"],
      "the CLI is told to stop the answer that the turn no longer waits for");

    const next = await agent.begin(2);
    for (const event of forNextTurn(after.slice(notification + 1), next.id)) next.child.emit(event);
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 starts and is answered");
    assert.deepEqual(agent.published, [TURNS_ANSWER, "ANSWER OF THE SECOND TURN"]);
    await agent.eventually(() => agent.recorded().turns.every((recorded) => recorded.state === "terminal"), "both turns are closed in the record");
    assert.deepEqual(agent.recorded().endings.map((ending) => [ending.n, ending.outcome]), [[1, "completed"], [1, "completed"]]);
    const current = await agent.view();
    assert.equal(current.condition, "none", current.last_error ?? "");
    assert.equal(current.room_agent_state.inbox.state, "empty");
  } finally {
    await agent.cleanup();
  }
});

test("while a Claude turn waits for a sub-agent, Chat shows the wait and the button for the whole wait, whatever the sub-agent writes", async () => {
  const agent = await claudeDaemonFixture();
  try {
    const turn = await agent.begin(1);
    // Real lines: one message starts a sub-agent and a background command, and the sub-agent writes a row before it ends.
    const { own, after } = splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.subagent_and_background_command!, agent.sessionId, turn.id).stream, turn.id);
    for (const event of own) turn.child.emit(event);
    const subagentRow = after.find((event) => event.type === "assistant" && typeof event.parent_tool_use_id === "string")!;
    assert.deepEqual((subagentRow.message as { content: unknown }).content, [{ type: "text", text: "SUBAGENT REPORT" }]);
    // A sub-agent that works writes many rows. Here it is the one captured row, forty times.
    for (let row = 0; row < 40; row += 1) turn.child.emit(subagentRow);
    // The CLI can write lines that are not JSON, and a sub-agent can ask for approvals, which are turned down
    // at once. Each of these is an event of the agent too, twenty times here.
    for (let line = 0; line < 20; line += 1) for (const listener of [...turn.child.lines]) listener(`a line of a tool that writes to the CLI's output ${line}`);
    for (let asked = 0; asked < 20; asked += 1) {
      turn.child.emit({ type: "control_request", request_id: `sub-${asked}`, request: { subtype: "can_use_tool", tool_name: "Bash", input: {}, tool_use_id: `toolu_sub_${asked}`, agent_id: "a37a052b" } });
    }
    type Entry = Parameters<typeof mapEntry>[0];
    const entry = async () => (await agent.request("manifest.list")).result[0] as Entry & { activity: Array<{ method: string; kind: string }> };
    await agent.eventually(async () => {
      const methods = (await entry()).activity.map((event) => event.kind === "provider_event" ? event.method : "");
      return [40, 20, 20].every((count, index) => methods.filter((method) => method === ["assistant", "stdout/raw", "control_request/declined"][index]).length === count);
    }, "the sub-agent's rows, the other lines and the requests that were turned down are in the agent's activity");
    const full = await entry();
    const waitStarted = full.activity.findIndex((event) => event.method === CLAUDE_BACKGROUND_WORK_METHOD);
    assert.ok(waitStarted > 0);
    // Chat reads the newest sixteen events of the agent. At each moment of the wait they show the wait, and offer the answer.
    const seen = new Set<string>();
    for (let last = waitStarted; last < full.activity.length; last += 1) {
      const [indicator] = supervisedAgentWorkIndicators([mapEntry({ ...full, activity: full.activity.slice(0, last + 1) } as Entry, 16)], [], "room_1");
      assert.equal(indicator?.waitsForBackgroundWork, true, `after event ${last} (${full.activity[last]!.method}) the button is there`);
      seen.add(indicator!.summary);
    }
    const waitText = 'Waiting for a sub-agent to finish (under 1 min): "review probe". Also up to 2 min for a background command: "server probe".';
    assert.deepEqual([...seen], [`${waitText.slice(0, 99).trimEnd()}…`], "and the text is the wait, never the sub-agent's writing");
    assert.ok(full.activity.filter((event) => event.method === CLAUDE_BACKGROUND_WORK_METHOD).length >= 10, "the turn says again what it waits for, between the lines of every kind");
    assert.deepEqual(agent.published, []);

    // The sub-agent ends and the model answers. The reply has no word of the sub-agent's own.
    for (const event of after) turn.child.emit(event);
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered");
    assert.deepEqual(agent.published, [`${TURNS_ANSWER}\n\nANSWER TO THE FIRST TASK NOTICE\n\nANSWER TO THE SECOND TASK NOTICE`]);
  } finally {
    await agent.cleanup();
  }
});

test("one answer of Claude's that is about the notices of two turns is the answer of the turn that is held open", async () => {
  const agent = await claudeBackgroundHarness();
  /** An earlier turn: its command, with this task id, passes its limit and still runs when the turn has ended. */
  const earlierTurn = async (taskId: string) => {
    const turn = await agent.start("background_command");
    agent.emit(withTasks(turn.own, { [COMMAND_TASK]: taskId }));
    await agent.after(2 * MINUTE);
    assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.commandStillRuns));
    return turn;
  };

  // Both tasks end together. Real lines: the model gets both notices with one request, and the CLI writes a result
  // for each. The first is empty and has no turn of the model in it.
  for (const [first, earlierTask, heldTask] of [["the held turn's", "bearlier0", "bheld0"], ["the earlier turn's", "bearlier1", "bheld1"]] as const) {
    await earlierTurn(earlierTask);
    const held = await agent.start("background_command_fails");
    agent.emit(withTasks(held.own, { [FAILING_COMMAND_TASK]: heldTask }));
    const together = splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.two_background_commands_end_together!, agent.sessionId, held.turnId).stream, held.turnId).after;
    const [empty, answer] = together.filter((event) => event.type === "result");
    assert.deepEqual([empty!.num_turns, empty!.result, answer!.result], [0, "", "ANSWER TO THE FIRST TASK NOTICE"]);
    // The same lines, for these two tasks. Which of the capture's two notices the CLI wrote first is read from its lines.
    const [firstNoticed, secondNoticed] = together.filter((event) => event.subtype === "task_notification").map((event) => event.task_id as string);
    assert.deepEqual([firstNoticed, secondNoticed].sort(), [claudeCapturedTask("two_background_commands_end_together", "toolu_probe_1"), claudeCapturedTask("two_background_commands_end_together", "toolu_probe_2")].sort());
    const lines = withTasks(together, first === "the held turn's" ? { [firstNoticed!]: heldTask, [secondNoticed!]: earlierTask } : { [firstNoticed!]: earlierTask, [secondNoticed!]: heldTask });
    const emptyResult = lines.findIndex((event) => event.type === "result");
    agent.emit(lines.slice(0, emptyResult + 1));
    await flush();
    assert.equal(held.settled(), false, `${first} notice first: the empty result is not the end of the answer, and does not end the turn`);
    agent.emit(lines.slice(emptyResult + 1));
    assert.deepEqual(await held.running, reply(held.turnId, TURNS_ANSWER, "ANSWER TO THE FIRST TASK NOTICE"), `${first} notice first: the answer is not lost`);
  }

  // The earlier turn's task ends first, and the model answers its notice with a tool call. The held turn's task ends
  // while that tool runs. Real lines: the request after the tool takes both notices, and one result follows.
  await earlierTurn("bearlier2");
  const held = await agent.start("background_command_fails");
  agent.emit(withTasks(held.own, { [FAILING_COMMAND_TASK]: "bheld2" }));
  const during = withTasks(splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.task_ends_while_notice_is_answered!, agent.sessionId, held.turnId).stream, held.turnId).after,
    { [ONE_AFTER_THE_OTHER_TASKS[0]!]: "bearlier2", [ONE_AFTER_THE_OTHER_TASKS[1]!]: "bheld2" });
  const toolResult = during.findIndex((event) => event.type === "user");
  agent.emit(during.slice(0, toolResult + 1));
  await flush();
  assert.equal(held.settled(), false, "the answer that took the held turn's notice still runs: the turn does not end");
  // The held turn's command has ended, and an answer has its notice. It is not a command that still runs: the
  // turn waits for the answer, and the command's two minutes do not end it.
  assert.equal(agent.waits(), WAITS_FOR_ANSWER, "the owner reads that the turn waits for the answer");
  await agent.after(2 * MINUTE);
  assert.equal(held.settled(), false, "a notice that an answer has taken is not work that passed its limit");
  assert.equal(agent.waits(), "Waiting for Claude's answer about background work that ended 2 min ago.");
  agent.emit(during.slice(toolResult + 1));
  assert.deepEqual(await held.running, reply(held.turnId, TURNS_ANSWER, "ANSWER NUMBER 1 AFTER THE TURN, TO A REQUEST THAT HOLDS 2 TASK NOTICES"));

  // Two notices that are answered one after the other. Each answer is about the notice that was first in line.
  const earlier = await earlierTurn("bearlier3");
  const last = await agent.start("background_command_fails");
  agent.emit(withTasks(last.own, { [FAILING_COMMAND_TASK]: "bheld3" }));
  // Real lines of each task's end and answer, in the order of a second task that ends while the first notice is answered.
  const earlierAnswer = withText(withTasks(earlier.after, { [COMMAND_TASK]: "bearlier3" }), NOTICE_ANSWER, "ANSWER ABOUT THE EARLIER TURN'S TASK");
  const heldAnswer = withTasks(last.after, { [FAILING_COMMAND_TASK]: "bheld3" });
  const answerStarts = (events: Array<Record<string, unknown>>) => events.findIndex((event) => event.type === "assistant");
  const notPosted = () => agent.stream.filter((event) => event.summary === CLAUDE_BACKGROUND_WORK_TEXT.notPosted).map((event) => (event.payload as { result?: unknown }).result);
  const before = notPosted().length;
  agent.emit(earlierAnswer.slice(0, answerStarts(earlierAnswer) + 1));
  agent.emit(heldAnswer.slice(0, answerStarts(heldAnswer)));
  agent.emit(earlierAnswer.slice(answerStarts(earlierAnswer) + 1));
  await flush();
  assert.equal(last.settled(), false, "the answer about the earlier turn's task is not the held turn's");
  assert.deepEqual(notPosted().slice(before), ["ANSWER ABOUT THE EARLIER TURN'S TASK"], "it is posted nowhere, and the owner reads so");
  agent.emit(heldAnswer.slice(answerStarts(heldAnswer)));
  assert.deepEqual(await last.running, reply(last.turnId, TURNS_ANSWER, NOTICE_ANSWER), "the held turn gets the answer about its own task, and not the other");

  // The other order: the held turn's notice is answered while the notice of the earlier turn's task waits in line.
  const before4 = await earlierTurn("bearlier4");
  const answered = await agent.start("background_command_fails");
  agent.emit(withTasks(answered.own, { [FAILING_COMMAND_TASK]: "bheld4" }));
  const ownAnswer = withTasks(answered.after, { [FAILING_COMMAND_TASK]: "bheld4" });
  const otherEnds = withTasks(before4.after, { [COMMAND_TASK]: "bearlier4" });
  const written = agent.child.written.length;
  agent.emit(ownAnswer.slice(0, answerStarts(ownAnswer) + 1));
  agent.emit(otherEnds.slice(0, answerStarts(otherEnds)));
  agent.emit(ownAnswer.slice(answerStarts(ownAnswer) + 1));
  assert.deepEqual(await answered.running, reply(answered.turnId, TURNS_ANSWER, NOTICE_ANSWER));
  assert.deepEqual(agent.writtenSince(written), [], "all of the turn's work was answered: the CLI is not interrupted, whatever other notice waits");
  await agent.adapter.stop(agent.handle);
});

test("an interrupt in a Claude turn that waits for a sub-agent stops the sub-agent, and the model is not told: no later turn waits for it", async () => {
  const agent = await claudeBackgroundHarness();
  // Real lines: the sub-agent still runs when the CLI is sent an interrupt, with no turn running.
  const turn = await agent.start("subagent_running_at_interrupt");
  assert.deepEqual(turn.after.filter((event) => event.subtype === "task_notification").map((event) => event.status), ["stopped"], "the CLI stopped the sub-agent");
  assert.equal(turn.after.some((event) => event.type === "result"), false, "and answered no notice about it");
  agent.emit(turn.own);
  assert.equal(agent.waits(), 'Waiting for a sub-agent to finish (under 1 min): "probe".');
  const written = agent.child.written.length;
  await agent.adapter.controlTurn(agent.handle, null, { targetTurnId: turn.turnId });
  assert.deepEqual(agent.writtenSince(written), ["interrupt"]);
  assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.ownerEnded));

  // The next turn starts a command of its own. What the CLI writes about the sub-agent comes late: after the last
  // row of a tool in the next turn, so no request of that turn takes the notice.
  const next = await agent.start("background_command");
  const lastToolRow = next.own.map((event) => event.type).lastIndexOf("user");
  agent.emit(next.own.slice(0, lastToolRow + 1));
  agent.emit(turn.after);
  agent.emit(next.own.slice(lastToolRow + 1));
  assert.equal(agent.waits(), WAITS_FOR_COMMAND, "the next turn waits for its own command only");
  agent.emit(next.after);
  await flush();
  // The answer to its notice is its own: the notice of the sub-agent is not in line before it.
  assert.equal(next.settled(), true, "the next turn does not wait for an answer about the sub-agent, which the model is never asked for");
  assert.deepEqual(await next.running, reply(next.turnId, TURNS_ANSWER, NOTICE_ANSWER));
  assert.equal(agent.stream.some((event) => event.summary === CLAUDE_BACKGROUND_WORK_TEXT.notPosted), false, "and its own answer is not taken for one that no turn waits for");
  await agent.adapter.stop(agent.handle);
});

test("an approval that Claude asks for while it answers a task's notice reaches the owner, for the turn that is held open", async () => {
  const h = await approvalHarness();
  try {
    const sessionId = h.handle.providerContinuationId!;
    // Real lines of a turn that starts a background command, for the turn that the harness started.
    const { own, after } = splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.background_command!, sessionId, h.turnId).stream, h.turnId);
    for (const event of own) h.child.emit(event);
    const notification = after.findIndex((event) => event.subtype === "task_notification");
    for (const event of after.slice(0, notification + 1)) h.child.emit(event);
    // The model answers the notice with a tool call that the owner has to allow.
    h.tool();
    h.permission();
    await flush();
    assert.equal(h.requests.length, 1, "the owner sees it as a pending approval");
    assert.deepEqual(await h.adapter.correlatePermissionTurn(h.handle, h.requests[0]!), { outcome: "correlated", providerContinuationId: sessionId, providerTurnId: h.turnId });
    assert.deepEqual(await h.adapter.replyPermission(h.handle, h.requests[0]!, "once", { beforeNativeDispatch: async () => {} }), { outcome: "sent", scope: "request" });
    assert.equal((JSON.parse(h.child.written.at(-1)!) as { response: { response: { behavior: string } } }).response.response.behavior, "allow");
    h.child.emit({ type: "user", session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-write", content: "written", is_error: false }] } });
    for (const event of after.slice(notification + 1)) h.child.emit(event);
    assert.equal(h.streams.at(-1)!.nativeLifecyclePhase, "turn_terminal", "the turn has ended");
    assert.equal(h.streams.filter((event) => event.method === CLAUDE_BACKGROUND_WORK_ANSWER_METHOD).length, 1);
  } finally {
    await h.close();
  }
});

test("an approval that Claude asks for when no room turn has started is denied at once: no turn could show it, and the next message would wait behind it", async () => {
  const agent = await claudeBackgroundHarness({ asksForApproval: true });
  /**
   * Real lines of an agent that asks before it writes: a command in the background, and an answer to its notice
   * with a command that needs an approval. Here the command passes its two minutes first, and the turn ends.
   */
  const outlivesItsTurn = async (taskId: string, requestId: string) => {
    const turn = await agent.start("approval_in_task_notice_answer_denied_and_interrupted");
    const { own, after } = splitAtOwnResult(withTasks(turn.lines, { [APPROVAL_COMMAND_TASK]: taskId }), turn.turnId);
    agent.emit(own);
    const written = agent.child.written.length;
    await agent.after(2 * MINUTE);
    assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.commandStillRuns));
    const asks = after.findIndex((event) => event.type === "control_request");
    assert.equal((after[asks]!.request as { subtype: string; agent_id?: unknown }).subtype, "can_use_tool");
    return { written, upToTheRequest: [...after.slice(0, asks), { ...after[asks]!, request_id: requestId }], afterTheRequest: after.slice(asks + 1) };
  };
  // What the CLI writes after a deny alone has not been captured. These are the captured row of the tool that was
  // denied, and the captured end of an answer to a notice.
  const deniedTool = (lines: Array<Record<string, unknown>>) => lines.find((event) => event.type === "user" && JSON.stringify(event.message).includes("tool_result"))!;
  const answerEnds = realClaudeCapture(CLAUDE_REAL_CAPTURES.background_command!, agent.sessionId, "no turn").stream.slice(-2);
  assert.deepEqual(answerEnds.map((event) => [event.type, (event.origin as { kind?: string } | undefined)?.kind]), [["assistant", undefined], ["result", "task-notification"]]);
  const declined = () => agent.stream.filter((event) => event.method === "control_request/declined").map((event) => event.summary);

  // No room turn is open when the command ends and the model answers its notice.
  const first = await outlivesItsTurn("bfirst0", "request-1");
  assert.deepEqual(agent.writtenSince(first.written), [], "the turn ended at the command's limit, and the CLI was sent nothing");
  agent.emit(first.upToTheRequest);
  await flush();
  assert.equal(agent.approvals.pending.length, 0, "the owner is shown no approval: an approval belongs to a turn that is open");
  assert.deepEqual(agent.writtenSince(first.written), ["deny request-1"], "the CLI is told at once that the action is not allowed, and does not wait");
  assert.deepEqual(declined(), ['Did not allow the tool "Bash", which Claude asked for outside a room turn. LetAgents shows an approval only for a turn that is open.'],
    "the owner reads in the agent's activity what was turned down");
  agent.emit([deniedTool(first.afterTheRequest), ...answerEnds]);
  assert.deepEqual([agent.stream.at(-1)!.method, agent.stream.at(-1)!.summary], [CLAUDE_BACKGROUND_WORK_FINISHED_METHOD, CLAUDE_BACKGROUND_WORK_TEXT.notPosted]);
  assert.equal(agent.handle.observedState(), "idle");

  // The next message's prompt has been written. The CLI has it in its queue, behind the answer to the notice.
  const second = await outlivesItsTurn("bsecond0", "request-2");
  const next = await agent.start("completed_answer");
  const following = forNextTurn(second.afterTheRequest, next.turnId);
  const isLifecycle = (state: string) => (event: Record<string, unknown>) => event.type === "command_lifecycle" && event.command_uuid === next.turnId && event.state === state;
  agent.emit([following.find(isLifecycle("queued"))!, ...second.upToTheRequest]);
  await flush();
  assert.equal(agent.approvals.pending.length, 0, "the next message's turn has not started: the approval is not for it");
  assert.deepEqual(agent.writtenSince(second.written), ["deny request-2"], "the answer that the next message waits behind is not left to wait for an approval");
  assert.equal(declined().length, 2);
  agent.emit([deniedTool(following), ...answerEnds]);
  assert.deepEqual([agent.stream.at(-1)!.method, agent.stream.at(-1)!.summary], [CLAUDE_BACKGROUND_WORK_ANSWER_METHOD, CLAUDE_BACKGROUND_WORK_TEXT.notPosted]);
  assert.equal(next.settled(), false, "the answer to the notice does not end the next turn");
  // Real lines again: the CLI starts the next message's turn.
  agent.emit(following.slice(following.findIndex(isLifecycle("started"))));
  assert.deepEqual(await next.running, reply(next.turnId, "ANSWER OF THE SECOND TURN"));
  assert.deepEqual(agent.endings.map((ending) => ending.outcome), ["completed", "completed", "completed"]);
  await agent.adapter.stop(agent.handle);
});

test("a Claude turn that ends while a sub-agent it started still runs stops the sub-agent, and the reply says so; no later turn waits for it", async () => {
  const agent = await claudeBackgroundHarness();
  // Real lines: one message starts a sub-agent and a background command.
  const turn = await agent.start("subagent_and_background_command");
  agent.emit(turn.own);
  // The command ends first here, and the answer to its notice fails. Real lines of such an answer, for this command.
  const failedAnswer = withTasks(splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.background_command_notice_api_error!, agent.sessionId, turn.turnId).stream, turn.turnId).after,
    { [FAILED_ANSWER_COMMAND_TASK]: COMMAND_BESIDE_SUBAGENT_TASK });
  const written = agent.child.written.length;
  agent.emit(failedAnswer);
  // The turn ends with what it has. The sub-agent still runs, and nothing waits for its report: it is stopped.
  assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER, `${CLAUDE_BACKGROUND_WORK_TEXT.notReported} ${CLAUDE_BACKGROUND_WORK_TEXT.subagentStopped}`));
  assert.equal(CLAUDE_BACKGROUND_WORK_TEXT.subagentStopped, "A sub-agent that this turn started still ran when the turn ended, and was stopped. Its report is not in this reply and will not be posted.");
  assert.deepEqual(agent.writtenSince(written), ["interrupt"]);

  // Real lines of a sub-agent that an interrupt stopped, for this sub-agent: the model is not told, and answers nothing.
  const stopped = withTasks(splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.subagent_running_at_interrupt!, agent.sessionId, turn.turnId).stream, turn.turnId).after,
    { [INTERRUPTED_SUBAGENT_TASK]: SUBAGENT_TASK });
  assert.deepEqual(stopped.filter((event) => event.subtype === "task_notification").map((event) => [event.task_id, event.status]), [[SUBAGENT_TASK, "stopped"]]);
  agent.emit(stopped);
  // The next turn's own answer about its own command is not taken for an answer about the sub-agent.
  const next = await agent.start("background_command");
  agent.emit(next.lines);
  assert.deepEqual(await next.running, reply(next.turnId, TURNS_ANSWER, NOTICE_ANSWER));
  await agent.adapter.stop(agent.handle);
});

test("an empty result of Claude's that is the only result for a task's notice ends the answer: the turn does not wait for another", async () => {
  const agent = await claudeBackgroundHarness();
  const turn = await agent.start("background_command");
  agent.emit(turn.own);
  // Real line: the result that the CLI writes first when two notices went to the model with one request. It is
  // empty and has no turn of the model in it. Here one notice went to the model, and it is the only result.
  const empty = splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.two_background_commands_end_together!, agent.sessionId, turn.turnId).stream, turn.turnId)
    .after.find((event) => event.type === "result")!;
  assert.deepEqual([empty.num_turns, empty.result, (empty.origin as { kind: string }).kind], [0, "", "task-notification"]);
  const notification = turn.after.findIndex((event) => event.subtype === "task_notification");
  agent.emit([...turn.after.slice(0, notification + 1), empty]);
  await flush();
  assert.equal(turn.settled(), true, "no other notice is in line, so no other result follows: the turn does not wait five minutes for one");
  assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER));
  await agent.adapter.stop(agent.handle);
});

test("a result for a task's notice with no call to the model and a text is not the model's answer: the turn ends with what it has, and the CLI's text is in no reply", async () => {
  // Real line: the result that the CLI writes first when two notices went to the model with one request. It
  // names no command, and has no turn of the model in it. No capture holds one with a text.
  const noCall = (agent: Awaited<ReturnType<typeof claudeBackgroundHarness>>, turnId: string) =>
    splitAtOwnResult(realClaudeCapture(CLAUDE_REAL_CAPTURES.two_background_commands_end_together!, agent.sessionId, turnId).stream, turnId).after.find((event) => event.type === "result")!;
  // Real text: what the CLI wrote as the result of a prompt that a hook stopped.
  const clisText = String(realClaudeResult(CLAUDE_REAL_CAPTURES.hook_blocks_prompt!).result);
  assert.match(clisText, /^UserPromptSubmit operation blocked by hook:[^]*PROMPT_HOOK_BLOCKS_THE_PROMPT[^]*Original prompt: /);
  for (const [text, reason] of [[clisText, CLAUDE_TURN_WITHOUT_MODEL_TEXT.hookStoppedPrompt], ["A text that the CLI wrote by itself.", CLAUDE_TURN_WITHOUT_MODEL_TEXT.noCallToTheModel]] as const) {
    const agent = await claudeBackgroundHarness();
    const turn = await agent.start("background_command");
    agent.emit(turn.own);
    const result: Record<string, unknown> = { ...noCall(agent, turn.turnId), result: text };
    assert.deepEqual([result.num_turns, result.subtype, result.is_error, result.user_message_uuid ?? null, (result.origin as { kind: string }).kind], [0, "success", false, null, "task-notification"]);
    const notification = turn.after.findIndex((event) => event.subtype === "task_notification");
    agent.emit([...turn.after.slice(0, notification + 1), result]);
    await flush();
    assert.equal(turn.settled(), true, "the answer has ended: the turn does not wait for another");
    // The model's own answer is posted, with the line that says what the reply lacks. The CLI's text is not.
    assert.deepEqual(await turn.running, reply(turn.turnId, TURNS_ANSWER, CLAUDE_BACKGROUND_WORK_TEXT.notReported));
    assert.deepEqual(turn.saved.map((saved) => saved.text), [`${TURNS_ANSWER}\n\n${CLAUDE_BACKGROUND_WORK_TEXT.notReported}`]);
    // What the owner reads of the answer that failed is the reason, and no word of the CLI's text.
    const said = agent.stream.slice(turn.publishedBefore).filter((event) => event.method === CLAUDE_BACKGROUND_WORK_ANSWER_METHOD).map((event) => event.summary);
    assert.deepEqual(said.filter((summary) => summary?.startsWith(CLAUDE_BACKGROUND_WORK_TEXT.answerFailed)), [`${CLAUDE_BACKGROUND_WORK_TEXT.answerFailed} ${reason}`]);
    assert.ok([...said, ...agent.activity.map((event) => event.summary)].every((summary) => !String(summary).includes(text.slice(0, 30))));
    // The agent is free: the next turn runs, and gets its own reply.
    const next = await agent.start("background_command");
    agent.emit(next.lines);
    assert.deepEqual(await next.running, reply(next.turnId, TURNS_ANSWER, NOTICE_ANSWER));
    await agent.adapter.stop(agent.handle);
  }
});

test("inspector usage retains native Claude measurements without a Live subscriber", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  const session_id = handle.providerContinuationId;
  child.emit({ type: "rate_limit_event", session_id, rate_limit_info: { rateLimitType: "five_hour", utilization: .2 } });
  child.emit({ type: "assistant", session_id, parent_tool_use_id: null,
    message: { model: "opus", usage: { input_tokens: 3000, cache_read_input_tokens: 14000, cache_creation_input_tokens: 6000 }, content: [] } });
  const usage = await adapter.readUsage(handle);
  assert.equal(usage?.account.windows[0]?.usedPercent, 20);
  assert.equal(usage?.context?.usedTokens, 23000);
  assert.equal(usage?.context?.capacityTokens, null, "no guessed model capacity");
  child.emit({ type: "assistant", session_id: "another", message: { model: "opus", usage: { input_tokens: 1 }, content: [] } });
  assert.equal((await adapter.readUsage(handle))?.context?.usedTokens, 23000);
});

for (const invalidation of ["none", "compaction", "compaction-success", "disconnect", "checkpoint", "detach"] as const) {
  test(`Claude context reuse retains human instructions and resets after ${invalidation}`, async () => {
    const harness = createHarness();
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    let handle = await adapter.spawn(spawnRequest());
    let child = harness.children[0]!;
    const observedContext = [
      { id: "msg_1", source: "agent", text: "OLDER_AGENT_CONTENT" },
      { id: "msg_2", source: "human", text: "HUMAN_CONSTRAINT" },
      ...[3, 4, 5].map(id => ({ id: `msg_${id}`, source: "agent", text: `RECENT_${id}` })),
    ];
    const run = async (index: number) => {
      const controller = new AbortController();
      const pending = adapter.runRoomTurn(handle, {
        roomId: "room", inboxItemId: `inbox-${index}`, actionId: `action-${index}`,
        sourceMessage: { id: `msg_${10 + index}`, source: "human", text: "Next question" }, observedContext, activation: {},
      }, {
        detachSignal: controller.signal,
        checkpointTerminalResult: async () => {
          if (index === 1 && invalidation === "checkpoint") throw new Error("checkpoint failed");
          if (index === 1 && invalidation === "detach") controller.abort();
        },
      });
      await flush();
      const frame = JSON.parse(child.written.at(-1)!);
      if (index === 1 && invalidation === "compaction") child.emit({
        type: "system", subtype: "compact_boundary", session_id: handle.providerContinuationId,
      });
      if (index === 1 && invalidation === "compaction-success") child.emit({
        type: "system", subtype: "status", status: null, compact_result: "success", session_id: handle.providerContinuationId,
      });
      if (index === 1 && invalidation === "disconnect") child.disconnect();
      child.emit({ type: "result", subtype: "success", is_error: false,
        session_id: handle.providerContinuationId, user_message_uuid: frame.uuid, result: "LETAGENTS_NO_ROOM_REPLY" });
      if (index === 1 && invalidation === "checkpoint") await assert.rejects(pending, /checkpoint failed/);
      else await pending;
      return frame.message.content[0].text as string;
    };
    assert.match(await run(1), /OLDER_AGENT_CONTENT/);
    if (invalidation === "disconnect") {
      handle = await adapter.resume({ workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId! }, spawnRequest());
      child = harness.children.at(-1)!;
    }
    const next = await run(2);
    assert.match(next, /HUMAN_CONSTRAINT/);
    assert.match(next, /RECENT_3/);
    if (invalidation === "none") { assert.doesNotMatch(next, /OLDER_AGENT_CONTENT/); assert.match(next, /previously_supplied/); }
    else assert.match(next, /OLDER_AGENT_CONTENT/);
  });
}
