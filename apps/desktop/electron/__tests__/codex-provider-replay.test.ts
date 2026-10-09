import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import type { ProviderStreamEvent } from "../main/agents/provider-adapter.js";
import type { NativeExecutionObservation } from "../../shared/execution-protocol.js";
import { CODEX_REPLAY_PROMPT, CodexReplay, normalizeCodexOutbound } from "./provider-replay/codex-replay.js";
import {
  CODEX_SCENARIOS,
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
    threadId: (response("thread/start").frame.result as Row).thread.id as string,
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
   * stream events the adapter has published by the time it is called.
   */
  afterInbound?: (entry: Located<EmitInboundEntry>, published: () => ProviderStreamEvent[], replay: CodexReplay) => void,
) {
  const replay = new CodexReplay(transcript, { workspace: WORKSPACE });
  sessions.push(replay.session);
  const published: ProviderStreamEvent[] = [];
  replay.session.onInboundDelivered((entry) => afterInbound?.(entry, () => [...published], replay));
  const outcome = await replay.session.run(() => runCodexScenario(CODEX_SCENARIOS[name], {
    dependencies: replay.dependencies,
    codexBin: "codex-replay",
    workspace: WORKSPACE,
    settled: () => replay.session.untilExitIsNext(),
    onStream: (event) => { published.push(event); },
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

test("Codex replay fails when the adapter no longer sends what was recorded", async () => {
  const fixture = loadFixture("simple");
  // Not a recording: one recorded frame is changed here to stand for an adapter that has moved on.
  const stale: ProviderReplayTranscript = {
    ...fixture,
    entries: fixture.entries.map((entry) => entry.type === "expect_outbound" && entry.label === "thread/start"
      ? { ...entry, frame: { ...entry.frame, params: { ...(entry.frame.params as JsonObject), sandbox: "workspace-write" } } }
      : entry),
  };
  await assert.rejects(replayScenario("simple", stale), (error: Error) => {
    // The two frames are on the error as data, and in its message as a diff.
    const { actual, expected } = error.cause as { actual: Row; expected: Row };
    assert.equal(actual.params.sandbox, "read-only");
    assert.equal(expected.params.sandbox, "workspace-write");
    // A terminal that asks for colour gets colour codes in the diff. They are not part of the text.
    const message = stripVTControlCharacters(error.message);
    assert.match(message, /Outbound frame \d+ does not match the recording .*expect_outbound "thread\/start"/);
    assert.match(message, /\+\s+sandbox: 'read-only'/);
    assert.match(message, /-\s+sandbox: 'workspace-write'/);
    return true;
  });
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
