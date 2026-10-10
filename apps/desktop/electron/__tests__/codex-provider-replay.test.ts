import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { SIGN_IN_NOT_HIDDEN, codexReadOnlyProfileId } from "../main/agents/codex-agent-home.js";
import { READ_ONLY_POLICY_WITHOUT_LEVEL } from "../main/agents/codex-app-server.js";
import { CodexProviderAdapter } from "../main/agents/codex-provider-adapter.js";
import type { ProviderObservedState, ProviderStreamEvent } from "../main/agents/provider-adapter.js";
import type { NativeExecutionObservation } from "../../shared/execution-protocol.js";
import { CODEX_REPLAY_PROMPT, CodexReplay, normalizeCodexOutbound, type CodexReplayOptions } from "./provider-replay/codex-replay.js";
import {
  CODEX_SCENARIOS,
  CODEX_SCENARIO_REASONING_EFFORT,
  CODEX_SCENARIO_WORK_ATTEMPT_ID,
  runCodexScenario,
  scenarioSourceMessageLine,
  type CodexScenarioName,
} from "./provider-replay/codex-scenarios.js";
import type { ProviderReplaySession } from "./provider-replay/replay-session.js";
import {
  loadProviderReplayTranscript,
  type EmitInboundEntry,
  type JsonObject,
  type Located,
  type ProviderReplayTranscript,
  type RuntimeExitEntry,
} from "./provider-replay/transcript.js";

// These tests run the real Codex adapter and the real RPC client against
// recordings of a real `codex app-server`. Nothing here says what Codex
// sends: the recording does. See docs/provider-replay-tests.md.

const WORKSPACE = "/replay/workspace";

/**
 * Every scenario's agent has the Read-only access level, so its launch defines this permission profile, and
 * its conversations and turns name it in place of a sandbox. The name is made from the work attempt.
 */
const READ_ONLY_PROFILE = codexReadOnlyProfileId(CODEX_SCENARIO_WORK_ATTEMPT_ID);
/** The `config` a conversation of a Read-only agent is started or resumed with, for one reasoning effort. */
const readOnlyThreadConfig = (effort: string) => ({ model_reasoning_effort: effort, web_search: "disabled" });

function loadFixture(name: CodexScenarioName): ProviderReplayTranscript {
  return loadProviderReplayTranscript(
    fileURLToPath(new URL(`./provider-replay/fixtures/codex/${name}.ndjson`, import.meta.url)),
  );
}

type Row = Record<string, any>;

/** What the recording itself says happened, read from its frames. */
function recorded(transcript: ProviderReplayTranscript) {
  const inbound = transcript.entries.filter((entry): entry is Located<EmitInboundEntry> => entry.type === "emit_inbound");
  const isNotification = (entry: Located<EmitInboundEntry>) =>
    typeof entry.frame.method === "string" && !Object.hasOwn(entry.frame, "id");
  const response = (label: string): Located<EmitInboundEntry> => {
    const entry = inbound.find((candidate) => candidate.label === label && !isNotification(candidate));
    assert.ok(entry, `the recording holds a reply to ${label}`);
    return entry;
  };
  const notifications = inbound.filter(isNotification);
  const turnCompleted = notifications.find((entry) => entry.frame.method === "turn/completed");
  assert.ok(turnCompleted, "the recording holds turn/completed");
  return {
    inbound,
    response,
    notifications,
    turnCompleted,
    // A recording opens its conversation with a start, or with a resume of one that an earlier process started.
    threadId: (response(inbound.some((entry) => entry.label === "thread/start") ? "thread/start" : "thread/resume").frame.result as Row).thread.id as string,
    turnId: (response("turn/start").frame.result as Row).turn.id as string,
    exit: transcript.entries.at(-1) as Located<RuntimeExitEntry>,
  };
}

/** Every session this file ran. A frame sent after a replay ended is found when the file ends. */
const sessions: ProviderReplaySession[] = [];
test.after(() => {
  assert.deepEqual(sessions.flatMap((session) => session.lateFrames), [], "no adapter sent a frame after its replay ended");
});

async function replayScenario(
  name: CodexScenarioName,
  transcript = loadFixture(name),
  /**
   * Called as each recorded frame reaches the adapter. `published` reads the
   * stream events the adapter has published by the time it is called, and
   * `observedState` the state it shows its caller then: null before the spawn.
   */
  afterInbound?: (
    entry: Located<EmitInboundEntry>,
    published: () => ProviderStreamEvent[],
    replay: CodexReplay,
    observedState: () => ProviderObservedState | null,
  ) => void,
  /** What the stand-in launch is told of the launch's own checks. */
  launch: Pick<CodexReplayOptions, "codexHonoursDeny"> = {},
) {
  const replay = new CodexReplay(transcript, { workspace: WORKSPACE, ...launch });
  sessions.push(replay.session);
  const published: ProviderStreamEvent[] = [];
  let spawnedState: (() => ProviderObservedState) | null = null;
  replay.session.onInboundDelivered((entry) => afterInbound?.(entry, () => [...published], replay, () => spawnedState?.() ?? null));
  // A recording that resumes a conversation names it in its first `thread/resume`. An earlier process started it.
  const resumed = transcript.entries.find((entry) => entry.type === "expect_outbound" && entry.label === "thread/resume");
  const resumeThreadId = resumed?.type === "expect_outbound" ? (resumed.frame.params as Row | undefined)?.threadId as string | undefined : undefined;
  const outcome = await replay.session.run(() => runCodexScenario(CODEX_SCENARIOS[name], {
    dependencies: replay.dependencies,
    codexBin: "codex-replay",
    workspace: WORKSPACE,
    settled: () => replay.session.untilExitIsNext(),
    onStream: (event) => { published.push(event); },
    onSpawned: (observedState) => { spawnedState = observedState; },
    ...(resumeThreadId ? { resumeThreadId } : {}),
  }));
  return { transcript, replay, outcome };
}

/** A stream event that carries a provider notification, as opposed to the adapter's own transcript read. */
function providerEvents(stream: ProviderStreamEvent[]): ProviderStreamEvent[] {
  return stream.filter((event) => event.kind !== "transcript_snapshot");
}

function lifecycle(stream: ProviderStreamEvent[]): Array<[string, string]> {
  return stream.flatMap((event) => event.nativeLifecyclePhase ? [[event.method, event.nativeLifecyclePhase] as [string, string]] : []);
}

function executionFacts(execution: NativeExecutionObservation[]): string[] {
  return execution.map(({ fact }) => {
    const detail = fact.domain === "turn" && fact.turnOutcome ? `(${fact.turnOutcome})`
      : "controlEvidence" in fact && fact.controlEvidence ? `(${fact.controlEvidence})` : "";
    return `${fact.domain}:${"state" in fact ? fact.state : fact.kind}${detail}`;
  });
}

/** The facts every recorded run ends with: the socket and the process end in the recorded order. */
function stopFacts(exit: RuntimeExitEntry): string[] {
  return [
    ...(exit.transportClosedBeforeExit ? ["control:degraded"] : []),
    "control:lost(process_exit)",
    "runtime:exited(process_exit)",
  ];
}

function sentFrames(replay: CodexReplay, method: string): JsonObject[] {
  return replay.session.outbound.filter((frame) => frame.method === method);
}

/**
 * The prompt wording is not compared with the recording, so the part that
 * carries the room message is checked here: one turn started, and its prompt
 * holds the scenario's message.
 */
function assertOneTurnCarriesTheMessage(replay: CodexReplay, name: CodexScenarioName): void {
  const turnStarts = sentFrames(replay, "turn/start");
  assert.equal(turnStarts.length, 1, "the adapter starts exactly one turn");
  const prompt = (turnStarts[0]!.params as Row).input[0].text as string;
  assert.equal(
    prompt.split("\n").find((line) => line.startsWith("Source message:")),
    scenarioSourceMessageLine(CODEX_SCENARIOS[name]),
    "the turn/start prompt carries the scenario's room message on its `Source message:` line",
  );
}

test("Codex replay, simple: one room message completes with the reply Codex gave", async () => {
  const { transcript, replay, outcome } = await replayScenario("simple");
  const real = recorded(transcript);
  const answer = ((real.turnCompleted.frame.params as Row).turn.items as Row[])
    .filter((item) => item.type === "agentMessage").map((item) => item.text as string).join("");
  assert.ok(answer.trim(), "the recorded turn holds an answer");

  // Every frame the adapter sent matched the recording, or the run above failed.
  assertOneTurnCarriesTheMessage(replay, "simple");
  assert.deepEqual(sentFrames(replay, "turn/interrupt"), []);

  assert.equal(outcome.stateAfterSpawn, "idle");
  assert.equal(outcome.threadId, real.threadId);
  assert.deepEqual(outcome.roomTurn, { turnId: real.turnId, outcome: "reply", text: answer, evidence: "transcript" });
  assert.equal(outcome.stateAfterTurn, "idle");

  // The stream shows every provider notification once, in the order Codex sent them.
  assert.deepEqual(providerEvents(outcome.stream).map((event) => event.method),
    real.notifications.map((entry) => entry.frame.method));
  assert.deepEqual(outcome.stream.map((event) => event.sequence), outcome.stream.map((_, index) => index + 1));
  assert.deepEqual(lifecycle(outcome.stream), [["turn/started", "turn_active"], ["turn/completed", "turn_terminal"]]);
  assert.equal(
    outcome.stream.filter((event) => event.method === "item/agentMessage/delta").map((event) => (event.payload as Row).delta).join(""),
    answer,
  );
  assert.equal(outcome.activity.find((event) => event.method === "turn/started")?.status, "working");
  assert.deepEqual(
    (({ source, method, status, summary }) => ({ source, method, status, summary }))(outcome.activity.at(-1)!),
    { source: "transcript_tail", method: "thread/read", status: "idle", summary: answer },
  );

  assert.deepEqual(executionFacts(outcome.execution), [
    "runtime:ready", "runtime:ready", "turn:active", "turn:terminal(completed)", ...stopFacts(real.exit),
  ]);
  assert.equal(replay.signals[0], "SIGTERM");
  assert.deepEqual(
    (({ exitCode, signal, terminalCause, providerContinuationId }) => ({ exitCode, signal, terminalCause, providerContinuationId }))(outcome.terminal),
    { exitCode: real.exit.code, signal: real.exit.signal, terminalCause: "stopped", providerContinuationId: real.threadId },
  );
  assert.equal(outcome.stateAfterStop, "stopped");
});

test("Codex replay, simple: the agent shows working until turn/completed, not until the thread goes idle", async () => {
  const transcript = loadFixture("simple");
  const real = recorded(transcript);
  // What real Codex did: it reported the thread idle, and the turn's own end after that.
  const threadIdle = real.notifications.filter((entry) => entry.frame.method === "thread/status/changed"
    && (entry.frame.params as Row).status?.type === "idle" && entry.line < real.turnCompleted.line).at(-1);
  assert.ok(threadIdle, "the recording holds thread/status/changed idle before turn/completed");

  // The daemon starts and ends every turn of an agent it delivers to (`lifecycleAuthorityMode: "typed"`),
  // so only the turn's own end may show the agent idle. In the other mode the thread's status does.
  // The look is taken after the adapter reacted to that frame, and before the next one is played.
  const afterThreadIdle: Array<{ state: ProviderObservedState | null; lifecycle: Array<[string, string]> }> = [];
  await replayScenario("simple", transcript, (entry, published, _replay, observedState) => {
    if (entry.line !== threadIdle.line) return;
    setImmediate(() => afterThreadIdle.push({ state: observedState(), lifecycle: lifecycle(published()) }));
  });
  assert.deepEqual(afterThreadIdle, [{ state: "working", lifecycle: [["turn/started", "turn_active"]] }],
    "the thread is idle, turn/completed has not arrived, and the agent still shows working");
});

test("Codex replay, turn_interrupt: the interrupt's acknowledgement does not end the turn; turn/completed does", async () => {
  const transcript = loadFixture("turn_interrupt");
  const real = recorded(transcript);
  const acknowledgement = real.response("turn/interrupt");
  // What real Codex did: it answered the interrupt, and reported the turn's end later, in its own frame.
  assert.deepEqual(acknowledgement.frame.result, {});
  assert.ok(acknowledgement.line < real.turnCompleted.line, "the acknowledgement comes before turn/completed");
  assert.equal((real.turnCompleted.frame.params as Row).turn.status, "interrupted");

  // What the adapter had done once it had reacted to the acknowledgement, and to nothing after it.
  // It continues from the awaited reply on a later microtask, so the look is taken one turn of the
  // event loop after the delivery: after that reaction, and before the session plays its next entry.
  const afterAcknowledgement: Array<{ published: ProviderStreamEvent[]; sent: string[] }> = [];
  const { replay, outcome } = await replayScenario("turn_interrupt", transcript, (entry, published, running) => {
    if (entry.line !== acknowledgement.line) return;
    setImmediate(() => afterAcknowledgement.push({
      published: published(),
      sent: running.session.outbound.map((frame) => String(frame.method)),
    }));
  });
  assert.equal(afterAcknowledgement.length, 1, "the acknowledgement reached the adapter once");
  // The adapter had moved on from the reply: its next request, a thread read, was already sent.
  assert.deepEqual(afterAcknowledgement[0]!.sent.slice(-2), ["turn/interrupt", "thread/read"],
    "the adapter continued from the acknowledgement before the look was taken");
  assert.deepEqual(lifecycle(afterAcknowledgement[0]!.published), [["turn/started", "turn_active"]],
    "the adapter reacted to the acknowledgement and still shows the turn running");
  assertOneTurnCarriesTheMessage(replay, "turn_interrupt");

  const [interrupt, ...otherInterrupts] = sentFrames(replay, "turn/interrupt");
  assert.deepEqual(otherInterrupts, []);
  assert.deepEqual(interrupt!.params, { threadId: real.threadId, turnId: real.turnId });
  assert.deepEqual(outcome.interrupt, { outcome: "interrupt_dispatched", targetTurnId: real.turnId });
  assert.deepEqual(outcome.roomTurn, {
    turnId: real.turnId,
    providerContinuationId: real.threadId,
    outcome: "interrupted",
    text: null,
    evidence: "transcript",
    error: "Codex bounded room turn ended interrupted.",
  });
  // An interrupted turn leaves the same app-server at a turn boundary, ready for the next message.
  assert.equal(outcome.stateAfterTurn, "idle");

  assert.deepEqual(providerEvents(outcome.stream).map((event) => event.method),
    real.notifications.map((entry) => entry.frame.method));
  assert.deepEqual(lifecycle(outcome.stream), [["turn/started", "turn_active"], ["turn/completed", "turn_terminal"]]);
  assert.deepEqual(executionFacts(outcome.execution), [
    "runtime:ready", "runtime:ready", "turn:active", "turn:terminal(interrupted)", ...stopFacts(real.exit),
  ]);
  assert.equal(outcome.terminal.terminalCause, "stopped");
  assert.equal(outcome.stateAfterStop, "stopped");
});

test("Codex replay: the thread runs with the reasoning effort the agent was given", async () => {
  // The adapter once sent `reasoningEffort`, a parameter Codex does not have.
  // Codex ignored it, and its reply reported the effort of its owner's own
  // settings instead of the agent's.
  for (const name of ["simple", "turn_interrupt"] as const) {
    const { transcript, replay, outcome } = await replayScenario(name);
    const real = recorded(transcript);
    // What the adapter sent: the effort in the form Codex takes it, and after Codex listed its models.
    const [threadStart, ...otherThreadStarts] = sentFrames(replay, "thread/start");
    assert.deepEqual(otherThreadStarts, [], name);
    assert.deepEqual((threadStart!.params as Row).config, readOnlyThreadConfig(CODEX_SCENARIO_REASONING_EFFORT), name);
    assert.equal(Object.hasOwn(threadStart!.params as Row, "reasoningEffort"), false, name);
    const sent = replay.session.outbound.map((frame) => frame.method);
    assert.ok(sent.indexOf("model/list") >= 0 && sent.indexOf("model/list") < sent.indexOf("thread/start"), name);
    // A turn names no effort of its own: it runs with the thread's.
    for (const turnStart of sentFrames(replay, "turn/start")) assert.equal(Object.hasOwn(turnStart.params as Row, "effort"), false, name);
    // What real Codex answered: the thread has that effort from its start, and keeps it through the turn.
    const started = real.response("thread/start").frame.result as Row;
    assert.equal(started.reasoningEffort, CODEX_SCENARIO_REASONING_EFFORT, name);
    assert.equal(started.thread.reasoningEffort, CODEX_SCENARIO_REASONING_EFFORT, name);
    const reads = real.inbound.filter((entry) => entry.label === "thread/read" && Object.hasOwn(entry.frame, "result"));
    assert.ok(reads.length > 0, `${name}: the recording holds a thread/read reply`);
    for (const read of reads) {
      assert.equal((read.frame.result as Row).thread.reasoningEffort, CODEX_SCENARIO_REASONING_EFFORT, `${name}, line ${read.line}`);
    }
    // The effort was one Codex lists for its models, and the adapter read in the reply that Codex
    // took it. So the launch has nothing to tell the owner.
    const listed = (real.response("model/list").frame.result as Row).data as Row[];
    assert.ok(listed.length > 0 && listed.every((model) =>
      (model.supportedReasoningEfforts as Row[]).some((option) => option.reasoningEffort === CODEX_SCENARIO_REASONING_EFFORT)), name);
    assert.deepEqual(outcome.launchNotices, [], name);
  }
});

test("Codex replay: a reply that reports another effort than the agent's is told to the owner, and the agent still works", async () => {
  const fixture = loadFixture("simple");
  // Not a recording: the effort in the recorded reply is changed here to the one real Codex
  // reported when it ignored the agent's effort. Nothing else told anyone then.
  const ignored: ProviderReplayTranscript = {
    ...fixture,
    entries: fixture.entries.map((entry) => entry.type === "emit_inbound" && entry.label === "thread/start" && Object.hasOwn(entry.frame, "result")
      ? { ...entry, frame: { ...entry.frame, result: { ...(entry.frame.result as JsonObject), reasoningEffort: "xhigh" } } }
      : entry),
  };
  const { outcome } = await replayScenario("simple", ignored);
  assert.deepEqual(outcome.launchNotices, [
    `This agent's reasoning effort "${CODEX_SCENARIO_REASONING_EFFORT}" was given to Codex, but Codex reports "xhigh" for the conversation. `
    + "The agent runs with the effort Codex reports.",
  ]);
  assert.equal(outcome.stateAfterSpawn, "idle");
  assert.equal(outcome.roomTurn.outcome, "reply");
});

test("Codex replay: a reply that reports no effort is told to the owner, and a reply with no effort field is not", async () => {
  const fixture = loadFixture("simple");
  // What real Codex 0.153.4 answered: the effort as a string, and a value it does not have as an
  // explicit null. So a null effort is Codex saying that the conversation has none.
  const real = recorded(fixture).response("thread/start").frame.result as Row;
  assert.equal(real.reasoningEffort, CODEX_SCENARIO_REASONING_EFFORT);
  // The work folder of the recording is no Git repository.
  assert.equal(Object.hasOwn(real.thread, "gitInfo") && real.thread.gitInfo, null);
  // Not a recording: the effort in the recorded reply is changed here.
  const replied = (change: (result: JsonObject) => JsonObject): ProviderReplayTranscript => ({
    ...fixture,
    entries: fixture.entries.map((entry) => entry.type === "emit_inbound" && entry.label === "thread/start" && Object.hasOwn(entry.frame, "result")
      ? { ...entry, frame: { ...entry.frame, result: change(entry.frame.result as JsonObject) } }
      : entry),
  });

  const none = await replayScenario("simple", replied((result) => ({ ...result, reasoningEffort: null })));
  assert.deepEqual(none.outcome.launchNotices, [
    `This agent's reasoning effort "${CODEX_SCENARIO_REASONING_EFFORT}" was given to Codex, but Codex reports no effort for the conversation. `
    + "The agent runs with the effort Codex gives it.",
  ]);
  assert.equal(none.outcome.stateAfterSpawn, "idle");
  assert.equal(none.outcome.roomTurn.outcome, "reply");

  // An app-server that does not report the effort leaves the field out. That says nothing either way.
  const silent = await replayScenario("simple", replied(({ reasoningEffort: _notReported, ...result }) => result));
  assert.deepEqual(silent.outcome.launchNotices, []);
  assert.equal(silent.outcome.roomTurn.outcome, "reply");
});

test("Codex replay: a resume in a second process gives the conversation the effort it names, and a resume of a loaded conversation does not", async () => {
  // An earlier process started the conversation with "low". Its traffic is not in the recording.
  const { transcript, replay, outcome } = await replayScenario("resume");
  const real = recorded(transcript);
  const { reasoningEffort, loadedReasoningEffort } = CODEX_SCENARIOS.resume.resume;

  // What the adapter sent: it starts no conversation, and resumes the one it was given twice.
  assert.deepEqual(sentFrames(replay, "thread/start"), []);
  const [resume, loadedResume, ...otherResumes] = sentFrames(replay, "thread/resume");
  assert.deepEqual(otherResumes, []);
  for (const [sent, effort] of [[resume!, reasoningEffort], [loadedResume!, loadedReasoningEffort]] as const) {
    assert.equal((sent.params as Row).threadId, real.threadId);
    assert.deepEqual((sent.params as Row).config, readOnlyThreadConfig(effort));
    assert.equal(Object.hasOwn(sent.params as Row, "reasoningEffort"), false);
  }
  // It asks Codex for its models before each resume. (That it waits for the answer is a matter for the adapter's own tests.)
  const sent = replay.session.outbound.map((frame) => frame.method);
  assert.deepEqual(sent.filter((method) => method === "model/list" || method === "thread/resume"),
    ["model/list", "thread/resume", "model/list", "thread/resume"]);

  const [resumed, resumedLoaded, ...otherReplies] = real.inbound
    .filter((entry) => entry.label === "thread/resume" && Object.hasOwn(entry.frame, "result"))
    .map((entry) => entry.frame.result as Row);
  assert.deepEqual(otherReplies, []);

  // What real Codex answered to the resume in a new process: the reply holds the effort, as the
  // reply of a start does, and it is the effort that the resume named.
  assert.equal(resumed.thread.id, real.threadId);
  assert.equal(resumed.reasoningEffort, reasoningEffort);
  assert.equal(resumed.thread.reasoningEffort, reasoningEffort);
  // Codex can report that effort for one reason only. It is not the effort the conversation was
  // started with, and it is not the default effort of the conversation's model, which Codex
  // listed in this same recording.
  assert.notEqual(reasoningEffort, CODEX_SCENARIO_REASONING_EFFORT);
  const listed = (real.response("model/list").frame.result as Row).data as Row[];
  const model = listed.find((entry) => entry.model === resumed.model);
  assert.ok(model, "the recording lists the conversation's model");
  assert.equal(typeof model.defaultReasoningEffort, "string");
  assert.notEqual(reasoningEffort, model.defaultReasoningEffort);
  // The conversation holds the one turn of the earlier process, with its answer.
  assert.equal(resumed.thread.turns.length, 1);
  assert.notEqual(resumed.thread.turns[0].id, real.turnId);
  const earlierAnswers = (resumed.thread.turns[0].items as Row[]).filter((item) => item.type === "agentMessage").map((item) => item.text);
  assert.deepEqual(earlierAnswers, ["ready"]);
  // So the launch has nothing to tell the owner.
  assert.deepEqual(outcome.launchNotices, []);
  assert.equal(outcome.stateAfterSpawn, "idle");

  // What real Codex answered to the resume of the conversation it had loaded: the conversation
  // keeps its own effort. It takes neither the effort that the resume names nor, here, the
  // default of its model. This is the resume a continuation repair sends first; the recording
  // does not hold a repair of a conversation that Codex did not find.
  assert.notEqual(loadedReasoningEffort, reasoningEffort);
  assert.equal(resumedLoaded.thread.id, real.threadId);
  assert.equal(resumedLoaded.reasoningEffort, reasoningEffort);
  assert.equal(resumedLoaded.thread.reasoningEffort, reasoningEffort);
  // The adapter read that in the reply, replaced nothing, and returned the line for the owner.
  assert.deepEqual(outcome.loadedResume, {
    outcome: "rematerialized",
    notices: [
      `This agent's reasoning effort "${loadedReasoningEffort}" was given to Codex, but Codex reports "${reasoningEffort}" for the conversation. `
      + "The agent runs with the effort Codex reports.",
    ],
  });

  // The turn after it names no effort of its own, and Codex reports the conversation's effort through it.
  const [turnStart, ...otherTurnStarts] = sentFrames(replay, "turn/start");
  assert.deepEqual(otherTurnStarts, []);
  assert.equal((turnStart!.params as Row).threadId, real.threadId);
  assert.equal(Object.hasOwn(turnStart!.params as Row, "effort"), false);
  const reads = real.inbound.filter((entry) => entry.label === "thread/read" && Object.hasOwn(entry.frame, "result"));
  assert.ok(reads.length > 0, "the recording holds a thread/read reply");
  for (const read of reads) {
    assert.equal((read.frame.result as Row).thread.reasoningEffort, reasoningEffort, `line ${read.line}`);
  }
  // The answer is this turn's: the recorded turn of the earlier process answered with another word.
  assert.equal(outcome.roomTurn.outcome, "reply");
  assert.equal(outcome.roomTurn.turnId, real.turnId);
  assert.equal(outcome.roomTurn.text, "resumed");
  assert.equal(earlierAnswers.includes(outcome.roomTurn.text!), false);
  assert.equal(outcome.stateAfterTurn, "idle");
  assert.equal(outcome.terminal.terminalCause, "stopped");
  assert.equal(outcome.stateAfterStop, "stopped");
});

test("Codex replay: a resume reply that reports no effort is told to the owner, and one with no effort field is not", async () => {
  const fixture = loadFixture("resume");
  const { reasoningEffort, loadedReasoningEffort } = CODEX_SCENARIOS.resume.resume;
  // Not a recording: the effort in the first recorded resume reply, the one of the launch, is changed here.
  const replied = (change: (result: JsonObject) => JsonObject): ProviderReplayTranscript => {
    const launchReply = fixture.entries.find((entry) => entry.type === "emit_inbound" && entry.label === "thread/resume" && Object.hasOwn(entry.frame, "result"));
    return {
      ...fixture,
      entries: fixture.entries.map((entry) => entry === launchReply && entry.type === "emit_inbound"
        ? { ...entry, frame: { ...entry.frame, result: change(entry.frame.result as JsonObject) } }
        : entry),
    };
  };
  const loadedLine = `This agent's reasoning effort "${loadedReasoningEffort}" was given to Codex, but Codex reports "${reasoningEffort}" for the conversation. `
    + "The agent runs with the effort Codex reports.";

  const none = await replayScenario("resume", replied((result) => ({ ...result, reasoningEffort: null })));
  assert.deepEqual(none.outcome.launchNotices, [
    `This agent's reasoning effort "${reasoningEffort}" was given to Codex, but Codex reports no effort for the conversation. `
    + "The agent runs with the effort Codex gives it.",
  ]);
  assert.equal(none.outcome.stateAfterSpawn, "idle");
  // The resume of the loaded conversation is as recorded, and its line is another one.
  assert.deepEqual(none.outcome.loadedResume, { outcome: "rematerialized", notices: [loadedLine] });
  assert.equal(none.outcome.roomTurn.outcome, "reply");

  const silent = await replayScenario("resume", replied(({ reasoningEffort: _notReported, ...result }) => result));
  assert.deepEqual(silent.outcome.launchNotices, []);
  assert.deepEqual(silent.outcome.loadedResume, { outcome: "rematerialized", notices: [loadedLine] });
  assert.equal(silent.outcome.roomTurn.outcome, "reply");
});

test("Codex replay fails when the adapter no longer sends what was recorded", async () => {
  const fixture = loadFixture("simple");
  // Not a recording: one recorded frame is changed here to stand for an adapter that has moved on.
  const stale: ProviderReplayTranscript = {
    ...fixture,
    entries: fixture.entries.map((entry) => entry.type === "expect_outbound" && entry.label === "thread/start"
      ? { ...entry, frame: { ...entry.frame, params: { ...(entry.frame.params as JsonObject), permissions: "another_profile" } } }
      : entry),
  };
  await assert.rejects(replayScenario("simple", stale), (error: Error) => {
    // The two frames are on the error as data, and in its message as a diff.
    const { actual, expected } = error.cause as { actual: Row; expected: Row };
    assert.equal(actual.params.permissions, READ_ONLY_PROFILE);
    assert.equal(expected.params.permissions, "another_profile");
    // A terminal that asks for colour gets colour codes in the diff. They are not part of the text.
    const message = stripVTControlCharacters(error.message);
    assert.match(message, /Outbound frame \d+ does not match the recording .*expect_outbound "thread\/start"/);
    assert.match(message, new RegExp(`\\+\\s+permissions: '${READ_ONLY_PROFILE}'`));
    assert.match(message, /-\s+permissions: 'another_profile'/);
    return true;
  });
});

test("Codex replay: each recording is a Read-only agent's launch: the launch defines its permission profile, every conversation and every turn names that profile and no sandbox, and Codex reports it", async () => {
  const sends = {
    simple: ["thread/start", "turn/start"],
    turn_interrupt: ["thread/start", "turn/start"],
    resume: ["thread/resume", "thread/resume", "turn/start"],
  } as const satisfies Record<CodexScenarioName, readonly string[]>;
  for (const name of Object.keys(sends) as CodexScenarioName[]) {
    const { transcript, replay } = await replayScenario(name);
    const real = recorded(transcript);

    // The launch the adapter asked for: one, sandboxed, with the Read-only policy and the profile of the agent's work attempt.
    const [launch, ...otherLaunches] = replay.launches;
    assert.deepEqual(otherLaunches, [], name);
    assert.deepEqual(
      [launch!.options.sandboxed, launch!.options.readOnlySandbox, launch!.options.hideSignInProfile, Object.hasOwn(launch!.options, "writableSandbox")],
      [true, true, READ_ONLY_PROFILE, false], name);
    assert.equal(launch!.options.configOverrides.includes('web_search="disabled"'), true, name);
    // What the product's launch gives Codex for it, once Codex has shown that it keeps a denied file from a command:
    // the profile, which is Codex's read-only one with the sign-in file denied at the owner's path and at the link in
    // the agents' home, and that profile as the default. The recorded Codex ran with that home, and said so.
    const home = (real.response("initialize").frame.result as Row).codexHome as string;
    assert.match(home, /^\/home\/replay-user\/\.letagents\/codex-agent-home(?:-<redacted>)?$/, name);
    assert.equal(launch!.codexHome, home, name);
    assert.deepEqual(launch!.profileOverrides, [
      `permissions.${READ_ONLY_PROFILE}={ extends = ":read-only", filesystem = { "/home/replay-user/.codex/auth.json" = "deny", ${JSON.stringify(`${home}/auth.json`)} = "deny" } }`,
      `default_permissions="${READ_ONLY_PROFILE}"`,
    ], name);

    // What the adapter sent: each frame that gives a conversation or a turn its access names the profile, and none names a sandbox.
    const access = replay.session.outbound.filter((frame) => ["thread/start", "thread/resume", "turn/start"].includes(String(frame.method)));
    assert.deepEqual(access.map((frame) => frame.method), sends[name], name);
    for (const frame of access) {
      const params = frame.params as Row;
      assert.deepEqual([params.permissions, params.approvalPolicy, params.approvalsReviewer], [READ_ONLY_PROFILE, "never", "user"], `${name}, ${String(frame.method)}`);
    }
    const namesASandbox = (frame: JsonObject) => {
      const params = (frame.params ?? {}) as Row;
      return Object.hasOwn(params, "sandbox") || Object.hasOwn(params, "sandboxPolicy");
    };
    assert.deepEqual(replay.session.outbound.filter(namesASandbox).map((frame) => frame.method), [], `${name}: no frame names a sandbox`);

    // What real Codex answered to each start and each resume: the profile by name, as an extension of its own
    // read-only one, the read-only sandbox with no network, and nobody to ask. A reply to `turn/start` holds none of it.
    const opened = real.inbound
      .filter((entry) => (entry.label === "thread/start" || entry.label === "thread/resume") && Object.hasOwn(entry.frame, "result"))
      .map((entry) => entry.frame.result as Row);
    assert.equal(opened.length, sends[name].length - 1, name);
    for (const reply of opened) {
      assert.deepEqual(reply.activePermissionProfile, { id: READ_ONLY_PROFILE, extends: ":read-only" }, name);
      assert.deepEqual(reply.sandbox, { type: "readOnly", networkAccess: false }, name);
      assert.deepEqual([reply.approvalPolicy, reply.approvalsReviewer], ["never", "user"], name);
    }
    // Codex reported no change of those settings afterwards.
    assert.deepEqual(real.notifications.filter((entry) => entry.frame.method === "thread/settings/updated"), [], name);
  }
});

test("Codex replay: a start or a resume whose reply does not report the launch's permission profile starts no Read-only agent", async () => {
  const notConfirmed = "This version of Codex did not confirm that it keeps your Codex sign-in file from this agent's commands, so the agent was not started. "
    + "If Codex is not up to date, update it. If it is, update LetAgents, or choose another access level: at every other level the agent's commands can read that file.";
  // Not recordings: the reply that opens the conversation is changed here. Everything else in it stays as Codex sent it.
  const changes: Array<[string, (result: JsonObject) => JsonObject]> = [
    ["no profile", (result) => ({ ...result, activePermissionProfile: null })],
    ["no field for it", ({ activePermissionProfile: _notReported, ...result }) => result],
    ["another profile", (result) => ({ ...result, activePermissionProfile: { id: "another_profile", extends: ":read-only" } })],
    ["the profile, as an extension of another one", (result) => ({ ...result, activePermissionProfile: { id: READ_ONLY_PROFILE, extends: ":workspace" } })],
  ];
  for (const [name, label] of [["simple", "thread/start"], ["resume", "thread/resume"]] as const) {
    const fixture = loadFixture(name);
    const reply = fixture.entries.find((entry) => entry.type === "emit_inbound" && entry.label === label && Object.hasOwn(entry.frame, "result"));
    assert.ok(reply && reply.type === "emit_inbound", `${name} holds a reply to ${label}`);
    for (const [what, change] of changes) {
      const changed: ProviderReplayTranscript = {
        ...fixture,
        entries: fixture.entries.map((entry) => entry === reply ? { ...reply, frame: { ...reply.frame, result: change(reply.frame.result as JsonObject) } } : entry),
      };
      await assert.rejects(replayScenario(name, changed), (error: Error) => error.message === notConfirmed, `${name}: ${what}`);
    }
  }
});

test("Codex replay: the stand-in launch refuses what the product's launch refuses, and then no frame is sent", async () => {
  // A Codex that did not show that it keeps a denied file from a command: no Read-only agent is started with it.
  const careless = new CodexReplay(loadFixture("simple"), { workspace: WORKSPACE, codexHonoursDeny: false });
  await assert.rejects(runCodexScenario(CODEX_SCENARIOS.simple, {
    dependencies: careless.dependencies, codexBin: "codex-replay", workspace: WORKSPACE, settled: async () => {},
  }), (error: Error) => error.message === SIGN_IN_NOT_HIDDEN);
  assert.deepEqual([careless.launches, careless.session.outbound, careless.signals], [[], [], []]);
  careless.session.dispose();

  // The Read-only policy without the name of the level has no profile: the launch starts nothing for it.
  const unnamed = new CodexReplay(loadFixture("simple"), { workspace: WORKSPACE });
  await assert.rejects(new CodexProviderAdapter({ codexBin: "codex-replay", dependencies: unnamed.dependencies }).spawn({
    workAttemptId: CODEX_SCENARIO_WORK_ATTEMPT_ID, roomId: "replay-room", agentDisplayName: "ReplayFinch", cwd: WORKSPACE,
    deliveryMode: "daemon_inbox", lifecycleAuthorityMode: "typed",
    launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } },
  }), (error: Error) => error.message === READ_ONLY_POLICY_WITHOUT_LEVEL);
  assert.deepEqual([unnamed.launches, unnamed.session.outbound, unnamed.signals], [[], [], []]);
  unnamed.session.dispose();
});

test("Codex outbound frames are compared without this run's workspace path and without the prompt wording", () => {
  const sent: JsonObject = {
    id: 5,
    method: "turn/start",
    params: {
      threadId: "thread-1",
      cwd: `${WORKSPACE}/packages/app`,
      approvalPolicy: "never",
      input: [{ type: "text", text: "Any wording at all.", text_elements: [] }, { type: "localImage", path: `${WORKSPACE}/shot.png` }],
    },
  };
  assert.deepEqual(normalizeCodexOutbound(sent, WORKSPACE), {
    id: 5,
    method: "turn/start",
    params: {
      threadId: "thread-1",
      cwd: "<workspace>/packages/app",
      approvalPolicy: "never",
      input: [{ type: "text", text: CODEX_REPLAY_PROMPT, text_elements: [] }, { type: "localImage", path: "<workspace>/shot.png" }],
    },
  });
  // Only the input of `turn/start` is prompt wording. Every other frame is compared whole,
  // also one that has the same shape: its text is protocol, and a change to it must fail a replay.
  for (const method of ["turn/steer", "review/start", "thread/read", "turn/startX", "x/turn/start"]) {
    const other: JsonObject = { ...sent, method, params: { threadId: "thread-1", input: [{ type: "text", text: "kept", text_elements: [] }] } };
    assert.deepEqual(normalizeCodexOutbound(other, WORKSPACE), other, `${method} keeps its input text`);
  }
});
