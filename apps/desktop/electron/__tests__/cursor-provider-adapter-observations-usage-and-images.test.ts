import "./isolated-home.js";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  boundedCursorRoomTurnPrompt,
  CursorProviderAdapter,
  cursorLiveDisplayProjections,
  type CursorProviderAdapterDependencies,
} from "../main/agents/cursor-provider-adapter.js";
import type { ProviderStreamEvent, ProviderTerminalPayload, NativeExecutionObservation } from "../main/agents/provider-adapter.js";
import { prepareCursorSupervisedProfile } from "../main/agents/cursor-managed-profile.js";
import {
  emptyExecutionProjection,
  reduceExecutionFact,
  birthIdentity,
  initializeGitWorkspace,
  productionPersonalIdentityDependencies,
  cursorConversationStoreFixtureSource,
  materializeAttestableMcpRuntime,
  createHarness,
  daemonSpawnRequest,
  supervisedAdapter,
  spawnDaemonLane,
  roomTurnRequest,
  flush,
  waitFor,
  withLoopAlive,
  cursorDaemonFixture,
  stagedImageAttachments,
} from "./cursor-provider-adapter.fixture.js";

test("documented Cursor stream-json shapes project to namespaced response and tool display events", () => {
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Checking " }, { type: "text", text: "now" }] },
    session_id: "session-exact",
  }, "turn-exact", "event-1"), [
    { method: "item/agentMessage/delta", kind: "text_delta", payload: { partId: "cursor:turn-exact:assistant:event-1", delta: "Checking now" } },
  ]);
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "assistant", message: { role: "assistant", content: "String-shaped reply" }, session_id: "session-exact",
  }, "turn-exact", "event-string"), [{
    method: "item/agentMessage/delta", kind: "text_delta",
    payload: { partId: "cursor:turn-exact:assistant:event-string", delta: "String-shaped reply" },
  }]);
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "tool_call", subtype: "started", call_id: "toolu_1",
    tool_call: { metadata: { durationMs: 12 }, readToolCall: { args: { path: "README.md" } } }, session_id: "session-exact",
  }, "turn-exact", "event-2"), [{
    method: "item/toolCall/updated", kind: "tool_lifecycle", payload: {
      callID: "cursor:turn-exact:toolu_1", tool: "readToolCall", status: "running",
      input: { path: "README.md" }, output: null, error: null,
    },
  }]);
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "tool_call", subtype: "completed", call_id: "toolu_1",
    tool_call: { readToolCall: { args: { path: "README.md" }, result: { success: { totalLines: 54 } } } },
    session_id: "session-exact",
  }, "turn-exact", "event-3"), [{
    method: "item/toolCall/updated", kind: "tool_lifecycle", payload: {
      callID: "cursor:turn-exact:toolu_1", tool: "readToolCall", status: "completed",
      input: { path: "README.md" }, output: { totalLines: 54 }, error: null,
    },
  }]);
  for (const [callId, result, detail] of [
    ["rejected", { rejected: { reason: "not approved" } }, { reason: "not approved" }],
    ["permission-denied", { permissionDenied: { error: "permission denied" } }, { error: "permission denied" }],
    ["spawn-error", { spawnError: { error: "spawn failed" } }, { error: "spawn failed" }],
    ["nonzero-exit", { success: { exitCode: 1 } }, { exitCode: 1 }],
  ] as const) {
    assert.deepEqual(cursorLiveDisplayProjections({
      type: "tool_call", subtype: "completed", call_id: callId,
      tool_call: { shellToolCall: { args: { command: "false" }, result } },
      session_id: "session-exact",
    }, "turn-exact", `event-${callId}`), [{
      method: "item/toolCall/updated", kind: "tool_lifecycle", payload: {
        callID: `cursor:turn-exact:${callId}`, tool: "shellToolCall", status: "error",
        input: { command: "false" }, output: null, error: JSON.stringify(detail, null, 2),
      },
    }], `${callId} uses the shared typed outcome instead of visually completing`);
  }
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "user", message: { role: "user", content: [{ type: "text", text: "prompt echo" }] },
  }, "turn-exact", "event-4"), [], "the user event is never misrendered as a tool");
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "tool_call", subtype: "started", call_id: "ambiguous-tool",
    tool_call: { readToolCall: { args: {} }, writeToolCall: { args: {} } },
  }, "turn-exact", "event-5"), [], "an ambiguous native envelope cannot choose an arbitrary tool card");
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "tool_call", subtype: "started", call_id: " padded-id ",
    tool_call: { readToolCall: { args: {} } },
  }, "turn-exact", "event-6"), [], "display uses the exact typed execution-id grammar without trimming");
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "tool_call", subtype: "started", call_id: "unknown-tool",
    tool_call: { browserToolCall: { args: {} } },
  }, "turn-exact", "event-7"), [], "an unknown native tool remains raw diagnostic evidence");
  assert.deepEqual(cursorLiveDisplayProjections({
    type: "tool_call", subtype: "started", call_id: "shadowed-tool",
    tool_call: { readToolCall: { args: {} }, writeToolCall: null },
  }, "turn-exact", "event-8"), [], "a second tool key invalidates the envelope even when its value is not an object");
  for (const [label, toolCall] of [
    ["contradictory variants", { readToolCall: { result: { success: {}, failure: { errorMessage: "boom" } } } }],
    ["missing variant", { readToolCall: { result: {} } }],
    ["malformed variant", { readToolCall: { result: { success: null } } }],
    ["command timeout", { shellToolCall: { result: { timeout: {} } } }],
    ["invalid exit code", { shellToolCall: { result: { success: { exitCode: "0" } } } }],
    ["background handoff", { shellToolCall: { result: { success: { exitCode: 0 }, isBackground: true } } }],
    ["invalid background flag", { shellToolCall: { result: { success: { exitCode: 0 }, isBackground: "false" } } }],
  ] as const) {
    assert.deepEqual(cursorLiveDisplayProjections({
      type: "tool_call", subtype: "completed", call_id: `invalid-${label.replaceAll(" ", "-")}`,
      tool_call: toolCall,
    }, "turn-exact", `event-invalid-${label}`), [], `${label} cannot visually complete a rejected typed terminal`);
  }
});

test("Cursor typed observations fence each native child and exclude synthetic display completion", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const stream: ProviderStreamEvent[] = [];
  const stopStream = adapter.onStream(handle, (event) => stream.push(event));
  const events: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, () => { throw new Error("observer unavailable"); });
  adapter.onExecution(handle, (event) => events.push(event));
  assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" });
  assert.deepEqual(adapter.capabilities().execution, {
    controlProbe: "unsupported", approvals: { kinds: [], recovery: "unsupported", denyScope: "unsupported" },
  });
  assert.equal(events.length, 0, "an idle lane has no runtime birth and cannot poison capture with a processless fact");
  const settledBirths: string[] = [];
  const settleExactBirth = async () => {
    const connection = handle.providerConnection;
    assert.equal(connection?.kind, "cursor_cli");
    assert.ok(connection?.processIdentity, "typed settlement retains the exact child birth");
    const birth = connection.processIdentity;
    assert.ok(events.some(({ nativeProcessIdentity, fact }) => nativeProcessIdentity === birth
      && fact.domain === "turn" && fact.state === "terminal"), "validated turn evidence precedes settlement");
    assert.ok(events.some(({ nativeProcessIdentity, fact }) => nativeProcessIdentity === birth
      && fact.domain === "runtime" && fact.state === "exited"), "historical child exit precedes settlement");
    const settledPosition = events.length;
    assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" });
    assert.equal(events.length, settledPosition,
      "a heartbeat during durable settlement cannot revive control on an exited child");
    settledBirths.push(birth);
  };
  const first = adapter.runRoomTurn(handle, roomTurnRequest(), { settleLifecycleBeforeIdle: settleExactBirth });
  await waitFor(() => harness.children[0]?.isReleased === true);
  const child = harness.children[0]!;
  const session_id = "sess-cursor-1";
  child.emit({ type: "system", subtype: "init", session_id, model: "cursor-fast" });
  const started = { type: "tool_call", subtype: "started", call_id: "same-call", session_id,
    tool_call: { readToolCall: { args: { path: "secret-path" } } } };
  child.emit(started);
  child.emit(started);
  child.emit({ ...started, call_id: "missing-session", session_id: undefined });
  child.emit({ type: "tool_call", subtype: "completed", call_id: "same-call", session_id,
    tool_call: { readToolCall: { result: { failure: { errorMessage: "secret-output" } } } } });
  child.emit({ type: "tool_call", subtype: "started", call_id: "unclosed-write", session_id,
    tool_call: { writeToolCall: { args: { path: "secret-path", fileText: "secret-content" } } } });
  assert.equal(handle.providerConnection?.processIdentity, birthIdentity(child.pid!), "the active child has an exact runtime birth");
  assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" }, "live output does not imply a responsive control channel");
  const controlObservations = events.filter(event => event.fact.domain === "control");
  assert.equal(controlObservations.length, 1, "the steady probe coalesces with the native child control observation");
  const probeObservation = controlObservations[0]!;
  assert.equal(probeObservation.nativeProcessIdentity, birthIdentity(child.pid!));
  assert.deepEqual(probeObservation.fact,
    { domain: "control", kind: "state_changed", state: "unprobeable", sideEffects: "none" },
    "an active child publishes the probe result with its exact runtime birth");
  const firstResult = { type: "result", subtype: "success", is_error: false, result: "done", session_id };
  child.emit(firstResult);
  child.emit(firstResult);
  assert.equal(events.some(({ fact }) => fact.domain === "turn" && fact.state === "terminal"), false,
    "raw result is only a correlation checkpoint until the wrapper terminal validates it");
  assert.equal(events.filter((event) => event.fact.domain === "execution"
    && event.fact.executionId === "unclosed-write" && event.fact.kind === "completed").length, 0,
  "a display-only interrupted card cannot become native interruption evidence");
  child.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await first).text, "done");
  await flush();
  assert.equal(handle.observedState(), "idle");
  assert.equal(handle.providerConnection?.processIdentity, null,
    "the reusable lane becomes processless only after typed settlement returns");
  const second = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "second" }), {
    settleLifecycleBeforeIdle: settleExactBirth,
  });
  await waitFor(() => harness.children[1]?.isReleased === true);
  const nextChild = harness.children[1]!;
  nextChild.emit(started);
  nextChild.emit({ type: "tool_call", subtype: "completed", call_id: "same-call", session_id,
    tool_call: { readToolCall: { result: { success: { content: "secret-output" } } } } });
  nextChild.emit({ type: "result", subtype: "success", is_error: false, result: "next", session_id });
  nextChild.resolveExit({ type: "exit", code: 0, signal: null });
  assert.equal((await second).text, "next");
  await flush();
  const runtimes = new Map<string, ReturnType<typeof emptyExecutionProjection>>();
  for (const event of events) {
    assert.ok(event.nativeProcessIdentity, "every Cursor observation is safe for runtime-birth keyed capture");
    const runtimeId = event.nativeProcessIdentity!;
    runtimes.set(runtimeId, reduceExecutionFact(runtimes.get(runtimeId) ?? emptyExecutionProjection(), {
      ...event.fact, ...("providerTurnId" in event.fact ? { turnId: event.fact.providerTurnId } : {}),
      factId: `fact-${event.sequence}`, agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: runtimeId,
      observerEpoch: 1, sourceSequence: event.sequence, observedAtMs: event.observedAtMs,
    }));
  }
  assert.equal(runtimes.size, 2, "sequential child births cannot share runtime authority");
  const firstTurn = [...runtimes.get(birthIdentity(child.pid!))!.turns.values()][0]!;
  const nextTurn = [...runtimes.get(birthIdentity(nextChild.pid!))!.turns.values()][0]!;
  assert.equal(firstTurn.operations.get("same-call")?.outcome, "failed");
  assert.equal(firstTurn.operations.get("same-call")?.startObserved, false);
  assert.equal(firstTurn.operations.has("unclosed-write"), false, "a tool request without a native result has no proven execution");
  assert.equal(nextTurn.operations.get("same-call")?.outcome, "succeeded");
  assert.notEqual(firstTurn.providerTurnId, nextTurn.providerTurnId);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.doesNotMatch(JSON.stringify(events), /secret-path|secret-content|secret-output/);
  assert.deepEqual(harness.signals, []);
  const replay: NativeExecutionObservation[] = [];
  const replaySubscription = adapter.onExecution(handle, event => replay.push(event));
  assert.deepEqual(replay, events, "late subscribers retain both exact child births and the shared original sequence");
  assert.ok(replay.every(event => event.sourceId === replaySubscription.sourceId), "successive child births share one observation source");
  replaySubscription.dispose();
  const streamCheckpointIds = [...new Set(stream.flatMap((event) => event.nativeEventId ? [event.nativeEventId] : []))];
  const typedCheckpointIds = [...new Set(events.flatMap((event) => event.fact.nativeEventId ? [event.fact.nativeEventId] : []))];
  assert.deepEqual(typedCheckpointIds, streamCheckpointIds,
    "each exact per-child init/result boundary correlates typed and legacy projections");
  assert.equal(stream.every((event) => !event.nativeEventId || event.nativeLifecyclePhase ===
    (event.method === "system/init" ? "turn_active" : "turn_terminal")), true,
  "correlated Cursor events expose only the closed structural lifecycle phase");
  assert.equal(streamCheckpointIds.length, 4, "two child starts and two native terminals are independently correlated");
  assert.deepEqual(
    [...new Set(stream.map((event) => event.nativeProcessIdentity))].sort(),
    [birthIdentity(child.pid!), birthIdentity(nextChild.pid!)].sort(),
    "every Cursor display event carries the exact child birth that emitted it",
  );
  assert.ok(stream.every((event) => event.nativeProcessIdentity),
    "a Cursor stream event can never borrow the next child's installation token");
  const terminalIds = stream.filter((event) => event.method.startsWith("result") && event.nativeEventId)
    .map((event) => event.nativeEventId);
  assert.equal(terminalIds.length, 3);
  assert.equal(terminalIds[0], terminalIds[1], "an identical terminal replay keeps the first checkpoint identity");
  assert.equal(events.filter((event) => event.fact.domain === "turn" && event.fact.state === "terminal"
    && event.fact.nativeEventId === terminalIds[0]).length, 1, "a replay does not emit another typed terminal");
  assert.deepEqual(settledBirths, [birthIdentity(child.pid!), birthIdentity(nextChild.pid!)],
    "each child birth crosses the settlement barrier exactly once");
  assert.equal(stream.find((event) => event.method === "system/init_duplicate")?.nativeEventId, undefined,
    "duplicate init diagnostics do not mint a second lifecycle checkpoint");
  assert.equal(stream.some((event) => event.kind === "tool_lifecycle" && event.nativeEventId !== undefined), false);
  assert.equal(events.some((event) => event.fact.domain === "execution" && event.fact.nativeEventId !== undefined), false);
  stopStream();
});

test("Cursor typed child loss differs from an exact user interruption", async () => {
  for (const exitKind of ["exit", "error", "interrupted"] as const) {
    const interrupted = exitKind === "interrupted";
    const harness = createHarness();
    const adapter = supervisedAdapter(harness);
    const handle = await spawnDaemonLane(adapter, harness);
    const events: NativeExecutionObservation[] = [];
    adapter.onExecution(handle, (event) => events.push(event));
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));
    const exitsAtSettlement: number[] = [];
    let settlementCalls = 0;
    const running = adapter.runRoomTurn(handle, roomTurnRequest(), {
      settleLifecycleBeforeIdle: async () => {
        settlementCalls++;
        assert.ok(handle.providerConnection?.processIdentity, "the terminal effect settles against the exact child birth");
        assert.ok(events.some(({ fact }) => fact.domain === "runtime" && fact.state === "exited"));
      },
      checkpointTerminalResult: async () => { exitsAtSettlement.push(terminals.length); },
    });
    const rejected = interrupted
      ? running.then(result => { assert.equal(result.outcome, "interrupted"); })
      : exitKind === "exit"
        // A child that exits without its result is a proven turn ending.
        ? running.then(result => {
          assert.equal(result.outcome, "interrupted");
          assert.match(result.error ?? "", /ended before.*terminal result/);
        })
        : assert.rejects(running, /ended before.*terminal result/);
    await waitFor(() => harness.children[0]?.isReleased === true);
    const child = harness.children[0]!;
    child.emit({ type: "tool_call", subtype: "started", call_id: "shell", session_id: "sess-cursor-1",
      tool_call: { shellToolCall: { args: { command: "slow-command" } } } });
    if (interrupted) await adapter.controlTurn(handle);
    else if (exitKind === "error") child.resolveExit({ type: "error", error: new Error("native child error") });
    else child.resolveExit({ type: "exit", code: 1, signal: null });
    await rejected;
    await flush();
    assert.equal(events.filter((event) => event.fact.domain === "execution").length, 0,
      "a pending tool request cannot become lost_after_start or interrupted_after_start without start proof");
    const terminal = events.find((event) => event.fact.domain === "turn" && event.fact.state !== "active")?.fact;
    assert.ok(terminal && "state" in terminal);
    assert.equal(terminal.state, interrupted ? "terminal" : "lost");
    const runtime = events.find((event) => event.fact.domain === "runtime" && event.fact.state === "exited")?.fact;
    assert.ok(runtime && "controlEvidence" in runtime);
    assert.equal(runtime.controlEvidence, exitKind === "error" ? "native_session_terminated" : "process_exit");
    assert.equal(settlementCalls, 1);
    assert.equal(handle.providerConnection?.processIdentity, null);
    if (!interrupted) assert.deepEqual(harness.signals, []);
    // The turn's ending is recorded while the lane is still live; only then
    // does a crash retire the lane (and with it the daemon's live handle).
    assert.deepEqual(exitsAtSettlement, exitKind === "error" ? [] : [0]);
    assert.equal(terminals.length, interrupted ? 0 : 1);
  }
});

test("Cursor typed shell completion preserves native exit codes and does not complete a background handoff", async () => {
  const harness = createHarness();
  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness);
  const events: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => events.push(event));
  const running = adapter.runRoomTurn(handle, roomTurnRequest());
  await waitFor(() => harness.children[0]?.isReleased === true);
  const child = harness.children[0]!;
  const session_id = "sess-cursor-1";
  for (const [call_id, result] of [
    ["zero", { success: { exitCode: 0, stdout: "secret-output" } }],
    ["nonzero", { failure: { exitCode: 2, stderr: "secret-output" } }],
    ["nonzero-success-envelope", { success: { exitCode: 1 } }],
    ["rejected", { rejected: { reason: "secret-reason" } }],
    ["permission-denied", { permissionDenied: { error: "secret-error" } }],
    ["spawn-failed", { spawnError: { error: "secret-error" } }],
    ["malformed", { success: { exitCode: "0" } }],
    ["background", { success: { exitCode: 0, shellId: 7 }, isBackground: true }],
  ] as const) {
    child.emit({ type: "tool_call", subtype: "started", call_id, session_id,
      tool_call: { shellToolCall: { args: { command: "secret-command" } } } });
    child.emit({ type: "tool_call", subtype: "completed", call_id, session_id,
      tool_call: { shellToolCall: { result } } });
  }
  const completions = events.map(({ fact }) => fact).filter((fact) => fact.domain === "execution" && fact.kind === "completed");
  assert.deepEqual(completions.map((fact) => ({ id: fact.executionId, outcome: fact.outcome, exitCode: fact.exitCode })), [
    { id: "zero", outcome: "succeeded", exitCode: 0 },
    { id: "nonzero", outcome: "failed", exitCode: 2 },
    { id: "nonzero-success-envelope", outcome: "failed", exitCode: 1 },
    { id: "rejected", outcome: "denied_before_start", exitCode: undefined },
    { id: "permission-denied", outcome: "denied_before_start", exitCode: undefined },
    { id: "spawn-failed", outcome: "failed", exitCode: undefined },
  ]);
  for (const fact of completions.filter((fact) => ["rejected", "permission-denied", "spawn-failed"].includes(fact.executionId))) {
    assert.equal(fact.sideEffects, "none");
  }
  child.emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await running;
  await flush();
  assert.equal(events.filter(({ fact }) => fact.domain === "execution" && fact.kind === "completed" && fact.executionId === "zero").length, 1,
    "an observed successful command must not later become lost at child exit");
  assert.equal(events.filter(({ fact }) => fact.domain === "execution" && ["malformed", "background"].includes(fact.executionId)).length, 0);
  assert.doesNotMatch(JSON.stringify(events), /secret-command|secret-output|secret-reason|secret-error/);
  assert.deepEqual(harness.signals, [], "a nonzero shell exit cannot signal the provider");
});

test("a Cursor turn that finished while its daemon was replaced is answered from its terminal, and the agent answers its next message", { timeout: 60_000 }, async () => {
  const agent = await cursorDaemonFixture();
  try {
    const first = await agent.begin(1);
    await agent.complete(first.id, "Answer 1.");
    await agent.eventually(() => agent.recorded().turns[0]?.state === "active", "turn 1 is recorded as started");
    await agent.restartDaemon();
    // While no daemon watched it, the wrapper finished the turn and wrote its terminal.
    agent.writeTerminal(first.id, { type: "result", subtype: "success", is_error: false, result: "Answer 1.", session_id: agent.sessionId });
    agent.exitChild(first.child);
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered from the durable terminal");
    assert.equal(agent.recovery.requests.at(-1)?.recordEnding, true, "the new daemon reads from its saved record that the turn is open");
    assert.equal(agent.recorded().turns[0]?.state, "active", "a successor's Cursor adapter has no child to record that ending with");

    // The child that ran turn 1 is gone, and Cursor's lane keeps its generation: nothing else will end that turn in the record.
    const second = await agent.begin(2);
    await agent.complete(second.id, "Answer 2.");
    second.child.emit({ type: "result", subtype: "success", is_error: false, result: "Answer 2.", session_id: agent.sessionId });
    agent.exitChild(second.child);
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered").catch(async (error) => {
      const row = await agent.receipt("msg_2");
      throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error})`);
    });
    assert.deepEqual(agent.published, ["Answer 1.", "Answer 2."], "turn 1 is not run again");
    assert.equal(agent.harness.launches.length, 2);
    const record = agent.recorded();
    assert.deepEqual(record.turns.map((turn) => turn.state), ["lost", "terminal"],
      "turn 1 is archived behind a recovery boundary, lost rather than finished; turn 2 is recorded in full");
    assert.deepEqual(record.boundaries, ["complete"]);
    assert.equal(record.gaps, 0);
    const current = await agent.view();
    assert.equal(current.condition, "none", current.last_error ?? "");
    assert.equal(current.room_agent_state.inbox.state, "empty", "nothing waits for a person");
  } finally {
    await agent.cleanup();
  }
});

test("Cursor usage reads idle sessions without inference, throttles account reads, and clears missing context", async () => {
  const h = createHarness();
  let now = Date.parse("2026-10-11T10:00:00Z"), calls = 0, fail = false;
  let reading: ReturnType<CursorProviderAdapterDependencies["readUsageContext"]> = {
    context: { usedTokens: 39386, capacityTokens: 256000, observedAt: new Date(now).toISOString() }, rootId: "root", summaryId: null,
  };
  h.dependencies.now = () => new Date(now).toISOString();
  h.dependencies.readUsageOwner = () => 12345;
  h.dependencies.readUsageContext = (_config, cwd, id) => {
    assert.equal(cwd, "/tmp/wa-cursor-1"); assert.equal(id, "sess-cursor-usage"); return reading;
  };
  h.dependencies.readUsageAccount = async (auth, at) => {
    assert.equal(auth, "Bearer test-provider-authorization"); calls++;
    if (fail) throw new Error("offline");
    return { state: "available", windows: [{ id: "cursor-plan", label: "Included usage", usedPercent: 20, resetsAt: null, observedAt: at }] };
  };
  const adapter = supervisedAdapter(h);
  const handle = await adapter.resume({ workAttemptId: "wa-cursor-1", providerContinuationId: "sess-cursor-usage" }, daemonSpawnRequest());
  const [first, concurrent] = await Promise.all([adapter.readUsage(handle), adapter.readUsage(handle)]);
  assert.equal(first?.account.windows[0]?.usedPercent, 20);
  assert.deepEqual(first, concurrent);
  assert.equal(first?.context?.usedTokens, 39386);
  assert.equal(calls, 1);
  assert.equal(h.launches.length, 0, "usage must never start an inference or room turn");
  assert.equal(h.identityAttestations.length, 1);
  assert.ok(!existsSync(h.identityAttestations[0]!.writableProfileRoot), "temporary identity profile is removed");
  reading = { ...reading!, rootId: "compacted", summaryId: "summary", context: { ...reading!.context!, usedTokens: 9000 } };
  now += 31000;
  const compacted = await Promise.all([adapter.readUsage(handle), adapter.readUsage(handle)]);
  assert.ok(compacted.every(value => value?.compaction === "compacted"));
  assert.equal((await adapter.readUsage(handle))?.compaction, "compacted");
  reading = null;
  assert.equal((await adapter.readUsage(handle))?.context, null);
  fail = true; now += 31000;
  const stale = await adapter.readUsage(handle);
  assert.equal(stale?.account.state, "stale");
  assert.equal(stale?.account.windows[0]?.usedPercent, 20);
  assert.equal(calls, 3);
  await adapter.stop(handle);
});

test("Cursor usage rejects another account and discards a read after the exact handle is retired", async () => {
  const h = createHarness();
  let calls = 0, owner = 999, now = Date.now();
  h.dependencies.readUsageOwner = () => owner;
  h.dependencies.now = () => new Date(now).toISOString();
  let complete!: (value: Awaited<ReturnType<CursorProviderAdapterDependencies["readUsageAccount"]>>) => void;
  let started!: () => void;
  const didStart = new Promise<void>(resolve => { started = resolve; });
  h.dependencies.readUsageAccount = () => { calls++; started(); return new Promise(resolve => { complete = resolve; }); };
  const adapter = supervisedAdapter(h);
  const handle = await adapter.resume({ workAttemptId: "wa-cursor-1", providerContinuationId: "sess-cursor-usage" }, daemonSpawnRequest());
  assert.equal((await adapter.readUsage(handle))?.account.state, "unavailable");
  assert.equal(calls, 0, "never query the current account for another account's agent");
  owner = 12345; now += 31000;
  const pending = adapter.readUsage(handle);
  await didStart;
  await adapter.stop(handle);
  complete({ state: "available", windows: [] });
  assert.equal(await pending, null);
  assert.equal(await adapter.readUsage(handle), null);
});

test("a Cursor room turn names its staged images in the prompt and may only read their folder", async () => {
  const folder = mkdtempSync(join(tmpdir(), "letagents-cursor-turn-images-"));
  try {
    const harness = createHarness();
    const adapter = supervisedAdapter(harness);
    assert.equal(adapter.roomTurnImageDelivery(), "file");
    const handle = await adapter.spawn(daemonSpawnRequest({
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const pending = adapter.runRoomTurn(handle, { ...roomTurnRequest(), attachments: stagedImageAttachments(folder) });
    await waitFor(() => harness.children[0]?.isReleased === true);
    const launch = harness.launches[0]!;
    const prompt = launch.args.at(-1)!;
    assert.ok(prompt.includes([
      `- Attachment 1: "screen.png" (image/png, 12 bytes). Included after this text as image 1.`,
      `- Attachment 2: "notes.pdf" (application/pdf, 5 bytes). Not shown: only images (PNG, JPEG, GIF, WebP) reach agents.`,
      "The attached images are files on this machine. Open each one with your file-reading tool to see it before you answer:",
      `- Image 1 ("screen.png"): ${join(folder, "1.png")}`,
    ].join("\n")), prompt.slice(-800));
    const variants = [folder, realpathSync(folder)];
    for (const path of variants) {
      assert.equal(launch.allowedReadSubpaths?.includes(path), true, `read ${path}`);
      assert.equal(launch.deniedWriteSubpaths?.includes(path), true, `no write ${path}`);
      assert.equal(launch.deniedExecSubpaths?.includes(path), true, `no exec ${path}`);
      assert.equal(launch.allowedWriteSubpaths?.includes(path) ?? false, false, `not writable ${path}`);
    }
    harness.children[0]!.emit({ type: "result", subtype: "success", is_error: false, result: "seen", session_id: "sess-cursor-1" });
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await withLoopAlive(pending);

    // The read permission belongs to that one launch: the next turn on the same lane has none of it.
    const next = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "inbox_cursor_2", actionId: "action_cursor_2" }));
    await waitFor(() => harness.children[1]?.isReleased === true);
    const nextLaunch = harness.launches[1]!;
    assert.doesNotMatch(nextLaunch.args.at(-1)!, /Open each one with your file-reading tool/);
    for (const path of variants) {
      for (const list of [nextLaunch.allowedReadSubpaths, nextLaunch.deniedWriteSubpaths, nextLaunch.deniedExecSubpaths]) {
        assert.equal(list?.includes(path) ?? false, false, `the next launch does not carry ${path}`);
      }
    }
    harness.children[1]!.emit({ type: "result", subtype: "success", is_error: false, result: "next", session_id: "sess-cursor-1" });
    harness.children[1]!.resolveExit({ type: "exit", code: 0, signal: null });
    await withLoopAlive(next);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("a staged image folder replaced by a link is never named or opened to the sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-image-link-"));
  try {
    const target = join(root, "home-like");
    mkdirSync(target);
    const linked = join(root, "turn-linked");
    symlinkSync(target, linked);
    const prompt = boundedCursorRoomTurnPrompt({ ...roomTurnRequest(), attachments: stagedImageAttachments(linked) }, "cursor:turn");
    assert.doesNotMatch(prompt, /Open each one with your file-reading tool/);
    const harness = createHarness();
    const adapter = supervisedAdapter(harness);
    const handle = await adapter.spawn(daemonSpawnRequest({ permissionProfileId: "sandboxed_write", launchPolicy: { force: true, sandbox: "enabled" } }));
    const pending = adapter.runRoomTurn(handle, { ...roomTurnRequest(), attachments: stagedImageAttachments(linked) });
    await waitFor(() => harness.children[0]?.isReleased === true);
    const launch = harness.launches[0]!;
    for (const path of [linked, target, realpathSync(target)]) {
      assert.equal(launch.allowedReadSubpaths?.includes(path) ?? false, false, `not readable ${path}`);
    }
    harness.children[0]!.emit({ type: "result", subtype: "success", is_error: false, result: "seen", session_id: "sess-cursor-1" });
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await withLoopAlive(pending);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a Cursor prompt without staged images gets no image lines", async () => {
  const prompt = boundedCursorRoomTurnPrompt(roomTurnRequest(), "cursor:turn");
  assert.doesNotMatch(prompt, /Open each one with your file-reading tool/);
  const unstaged = boundedCursorRoomTurnPrompt({ ...roomTurnRequest(), attachments: [
    { index: 1, fileName: "screen.png", mimeType: "image/png", sizeBytes: 12, status: "provider_unsupported" },
  ] }, "cursor:turn");
  assert.match(unstaged, /Not shown: this agent cannot view images/);
  assert.doesNotMatch(unstaged, /Open each one with your file-reading tool/);
});

test("under the real sandbox a Cursor turn reads its staged image but cannot write there or read another turn's images", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-image-sandbox-"));
  try {
    const workspace = join(root, "workspace");
    const sourceHomeDir = join(root, "source-home");
    const stableProfileRoot = join(root, "stable-profile");
    const executable = join(root, "fake-cursor-agent");
    const stagedRoot = join(root, "room-turn-attachments");
    const ownFolder = join(stagedRoot, "turn-own");
    const otherFolder = join(stagedRoot, "turn-other");
    initializeGitWorkspace(workspace);
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    mkdirSync(ownFolder, { recursive: true, mode: 0o700 });
    mkdirSync(otherFolder, { recursive: true, mode: 0o700 });
    writeFileSync(join(ownFolder, "1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { mode: 0o600 });
    writeFileSync(join(otherFolder, "1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]), { mode: 0o600 });
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const prompt = process.argv[process.argv.length - 1];
const image = /- Image 1 \\("screen.png"\\): (.+)$/m.exec(prompt)[1];
function attempt(run) { try { return { ok: true, value: run() }; } catch (error) { return { ok: false, code: error.code }; } }
const outcome = {
  read: attempt(() => fs.readFileSync(image).length),
  write: attempt(() => fs.writeFileSync(path.join(path.dirname(image), "planted.txt"), "x")),
  replace: attempt(() => fs.writeFileSync(image, "x")),
  other: attempt(() => fs.readFileSync(${JSON.stringify(join(otherFolder, "1.png"))}).length),
};
${cursorConversationStoreFixtureSource("sess-image-sandbox")}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-image-sandbox" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-image-sandbox" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input,
        apiBaseUrl: "https://desktop.letagents.example",
        workspaceRoot: input.cwd,
        sourceHomeDir,
        profileRoot: input.profileRoot ?? stableProfileRoot,
        ...(input.inspectionOnly ? {} : {
          mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
        }),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      cwd: workspace,
      workAttemptId: "wa-image-sandbox",
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, {
      ...roomTurnRequest({ inboxItemId: "inbox-image-sandbox" }), attachments: stagedImageAttachments(ownFolder),
    }));
    const outcome = JSON.parse(result.text!) as Record<string, { ok: boolean; value?: number; code?: string }>;
    assert.deepEqual(outcome.read, { ok: true, value: 8 }, "the staged image is readable");
    assert.equal(outcome.write?.ok, false, "nothing can be planted next to it");
    assert.equal(outcome.replace?.ok, false, "the image itself cannot be replaced");
    assert.equal(outcome.other?.ok, false, "another turn's images stay unreadable");
    assert.deepEqual(readdirSync(ownFolder), ["1.png"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
