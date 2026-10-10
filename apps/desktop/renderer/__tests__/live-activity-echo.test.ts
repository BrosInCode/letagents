import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_ACTIVITY_ECHO_MAX_LENGTH,
  WORK_INDICATOR_ECHO_MIN_INTERVAL_MS,
  coalesceWorkIndicatorEchoes,
  collapseWorkIndicators,
  humanFacingSupervisorActivitySummary,
  liveActivityEchoText,
  isHumanVisibleSupervisorActivity,
  supervisedAgentWorkIndicators,
  workIndicatorOverflowLabel,
  workIndicatorSupersededByAgentMessage,
  type ManagedAgentWorkIndicator,
} from "../src/domain/managed-agents";
import { waitingAgentIndicators } from "../src/domain/scheduled-retry";
import type { DesktopSupervisorManifestEntry } from "../../electron/ipc-types";

function entry(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_1",
    roomId: "room_1",
    displayName: "MistyMorrow",
    provider: "claude-code",
    model: null,
    charter: "",
    desiredState: "running",
    observedState: "working",
    condition: "none",
    lastError: null,
    permissionProfileId: null,
    createdBy: "desktop",
    createdAt: "2026-07-17T00:00:00.000Z",
    workspacePath: "/tmp/wt",
    workAttemptId: "attempt",
    agentSessionId: "agent_session_1",
    agentSessionBindingState: "active",
    bindingUpdatedAt: "2026-07-17T00:00:00.000Z",
    executionGenerationId: "gen_1",
    providerContinuationId: "cont_1",
    providerPid: 4242,
    workplaceLiveness: { state: "reachable", observedAt: null, detail: null },
    nativeLiveness: { state: "active", observedAt: null, detail: null },
    restartCount: 0,
    lastTerminal: null,
    roomAgentState: {
      connection: { state: "connected", observedAt: "2026-07-17T00:00:00.000Z", detail: null },
      ingress: { state: "observing", observedAt: "2026-07-17T00:00:00.000Z", detail: null },
      inbox: { state: "queued", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: {
        state: "responding",
        inboxItemId: "inbox_1",
        sourceMessageId: "message_source",
        providerTurnId: "turn_1",
        detail: null,
      },
      task: { state: "none", taskId: null, title: null },
    },
    deliveryReceipts: [{
      inboxItemId: "inbox_1",
      sourceMessageId: "message_source",
      state: "awaiting_result",
      attemptCount: 1,
      providerTurnId: "turn_1",
      blockedByMessageId: null,
      error: null,
      updatedAt: "2026-07-17T00:00:00.500Z",
      timeline: [{ sequence: 1, phase: "turn_started", observedAt: "2026-07-17T00:00:00.500Z", detail: null }],
    }],
    activity: [{
      observedAt: "2026-07-17T00:00:01.000Z",
      sequence: 5,
      provider: "claude-code",
      kind: "tool_lifecycle",
      method: "assistant",
      summary: "running focused tests",
      status: "working",
      payload: null,
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    }],
    ...overrides,
  };
}

function indicator(
  id: string,
  startedAt = "2026-07-17T00:00:00.000Z",
  summary = "working",
): ManagedAgentWorkIndicator {
  return { id, displayName: id, summary, startedAt };
}

test("an Open Model provider retry is shown in the adapter's own words only", () => {
  const notice = {
    kind: "provider_event",
    method: "letagents/providerRetry",
    summary: "The model provider returned an error. Retrying (attempt 2).",
  };
  assert.equal(isHumanVisibleSupervisorActivity(notice), true);
  assert.equal(
    humanFacingSupervisorActivitySummary(notice),
    "The model provider returned an error. Retrying (attempt 2).",
  );
  // Every other provider event stays in diagnostics.
  assert.equal(isHumanVisibleSupervisorActivity({ kind: "provider_event", method: "letagents/turnAttention" }), false);
  assert.equal(isHumanVisibleSupervisorActivity({ kind: "provider_event", method: "system/api_retry" }), false);
  // Provider text under this method is never shown.
  for (const summary of [
    "This request requires more credits. You can only afford 1500 tokens.",
    "The model provider returned an error. Retrying (attempt 2). Visit https://provider.example",
    "open-model · letagents/providerRetry",
    "",
  ]) {
    assert.equal(
      humanFacingSupervisorActivitySummary({ ...notice, summary }),
      "Waiting for the model provider",
    );
  }
});

test("a Claude turn that waits for background work says so in the adapter's own words only", () => {
  const notice = { kind: "provider_event", method: "letagents/backgroundWork", summary: "" };
  assert.equal(isHumanVisibleSupervisorActivity(notice), true);
  // The sentences of the adapter: what the turn waits for, by kind, in the model's own short descriptions.
  for (const summary of [
    "Waiting up to 2 min for a background command: \"Start the server\".",
    "Waiting up to 2 min for background commands: \"Server\", \"Watcher\".",
    "Waiting up to 2 min for background work: \"Monitor\".",
    "Waiting for a sub-agent to finish (under 1 min): \"Review the diff\".",
    "Waiting for sub-agents to finish (12 min): \"Review\", \"Plan\", \"Build\" and 2 more.",
    "Waiting for a sub-agent to finish (3 min): \"A\". Also up to 2 min for a background command: \"B\".",
    "Waiting for Claude's answer about background work that ended under 1 min ago.",
    "Waiting for Claude's answer about background work that ended 3 min ago.",
  ]) {
    assert.ok(summary.length <= 100, summary);
    assert.equal(humanFacingSupervisorActivitySummary({ ...notice, summary }), summary);
  }
  // A long description is cut at the end of the line, after the time.
  assert.equal(
    humanFacingSupervisorActivitySummary({ ...notice, summary: `Waiting for a sub-agent to finish (29 min): "${"x".repeat(80)}".` }),
    `Waiting for a sub-agent to finish (29 min): "${"x".repeat(54)}…`,
  );
  // Any other text under this method gets fixed copy.
  for (const summary of [
    "claude-code · letagents/backgroundWork",
    "Waiting for a sub-agent to finish: \"Review\".",
    "Waiting for a sub-agent to finish (3 min): \"Review\nthe diff\".",
    "Waiting up to 2 min for a background command: Start the server.",
    "Waiting for Claude's answer about background work that ended 3 min ago. Visit https://provider.example",
    "Waiting for Claude's answer about background work that has ended (3 min).",
    "",
  ]) {
    assert.equal(humanFacingSupervisorActivitySummary({ ...notice, summary }), "Waiting for background work to finish");
  }
  // The answer to a task's notice, and the note that one was not posted, stay in diagnostics.
  assert.equal(isHumanVisibleSupervisorActivity({ kind: "provider_event", method: "letagents/backgroundWorkAnswer" }), false);
  assert.equal(isHumanVisibleSupervisorActivity({ kind: "provider_event", method: "letagents/backgroundWorkFinished" }), false);
});

test("the work indicator of a turn that waits for background work offers its owner the answer now, and only then", () => {
  const waiting = {
    ...entry().activity[0]!,
    provider: "claude-code",
    kind: "provider_event",
    method: "letagents/backgroundWork",
    summary: "Waiting up to 2 min for a background command: \"Start the server\".",
    observedAt: "2026-07-17T00:00:02.000Z",
    sequence: 6,
  };
  // The wait stands in the place of "Thinking", and the owner can end it.
  const held = supervisedAgentWorkIndicators([entry({ activity: [...entry().activity, waiting] })], [], "room_1");
  assert.equal(held.length, 1);
  assert.equal(held[0]!.summary, "Waiting up to 2 min for a background command: \"Start the server\".");
  assert.equal(held[0]!.waitsForBackgroundWork, true);
  assert.equal(held[0]!.id, "supervised_1", "the indicator names the agent whose wait it is");
  // An agent that works has no answer to post yet.
  assert.equal(supervisedAgentWorkIndicators([entry()], [], "room_1")[0]!.waitsForBackgroundWork, undefined);
  // The agent goes on: it answers a notice. The offer goes with the wait.
  const answering = supervisedAgentWorkIndicators([entry({ activity: [...entry().activity, waiting, {
    ...waiting, kind: "text_delta", method: "assistant", summary: "", observedAt: "2026-07-17T00:00:03.000Z", sequence: 7,
  }] })], [], "room_1");
  assert.deepEqual([answering[0]!.summary, answering[0]!.waitsForBackgroundWork], ["Writing a response", undefined]);
  // The wait must be this turn's own. When the start of the turn is not known, the newest activity can be an
  // earlier turn's wait, and the button would stop a turn that works.
  const startUnknown = entry({ activity: [...entry().activity, waiting] });
  startUnknown.deliveryReceipts![0]!.timeline = [];
  const unknown = supervisedAgentWorkIndicators([startUnknown], [], "room_1");
  assert.deepEqual([unknown.length, unknown[0]!.waitsForBackgroundWork], [1, undefined]);
  const earlierWait = entry({ activity: [{ ...waiting, observedAt: "2026-07-17T00:00:00.100Z", sequence: 4 }, ...entry().activity] });
  assert.equal(supervisedAgentWorkIndicators([earlierWait], [], "room_1")[0]!.waitsForBackgroundWork, undefined, "a wait from before this turn started is not this turn's");
  // What is shown may be old: the offer is made on fresh state only, and for a turn that is responding.
  assert.equal(supervisedAgentWorkIndicators([entry({ activity: [...entry().activity, waiting] })], [], "room_1", "stale")[0]!.waitsForBackgroundWork, undefined);
  const publishing = entry({ activity: [...entry().activity, waiting] });
  publishing.roomAgentState!.turn.state = "publishing";
  assert.equal(supervisedAgentWorkIndicators([publishing], [], "room_1")[0]!.waitsForBackgroundWork, undefined);
  // The echo of the text is held back for a moment at a time. The offer comes through with the indicator.
  const coalesced = coalesceWorkIndicatorEchoes({ supervised_1: { summary: "Thinking", shownAtMs: 0, pending: null } }, held, 10);
  assert.deepEqual([coalesced.indicators[0]!.summary, coalesced.indicators[0]!.waitsForBackgroundWork], ["Thinking", true]);
});

test("a turn that is held open for background work keeps the look of work, and an agent that waits to try again rests: two rows that never share a key", () => {
  const wait = {
    ...entry().activity[0]!,
    provider: "claude-code",
    kind: "provider_event",
    method: "letagents/backgroundWork",
    summary: "Waiting for a sub-agent to finish (3 min): \"Review the diff\".",
    observedAt: "2026-07-17T00:00:02.000Z",
    sequence: 6,
  };
  const held = entry({ activity: [...entry().activity, wait] });
  // Something runs while a turn is held open: the command, the sub-agent, or Claude's answer. Its row is a row of work.
  const [working] = supervisedAgentWorkIndicators([held], [], "room_1");
  assert.deepEqual([working!.id, working!.waiting, working!.waitsForBackgroundWork], ["supervised_1", undefined, true]);
  assert.deepEqual(waitingAgentIndicators([held], "room_1"), [], "it does not wait for a time: it has no row at rest");

  // The background service runs one item of an agent's queue at a time, and an automatic attempt waits at the head
  // of the queue while nothing runs. So one agent does not have a held turn and an attempt that waits. This is
  // that state all the same: the live strip, built as the room shell builds it, has one row of each, with its own key.
  const both = entry({ activity: [...entry().activity, wait] });
  both.deliveryReceipts!.push({ ...both.deliveryReceipts![0]!, inboxItemId: "inbox_2", sourceMessageId: "task-continuation:inbox_0", fifoSequence: 2,
    state: "pending", providerTurnId: null, timeline: [],
    followUp: { forMessageId: null, state: "scheduled", scheduled: { atMs: Date.parse("2026-07-17T00:05:00.000Z"), attempt: 2, attempts: 3, kind: "provider_fault" } } });
  const strip: ManagedAgentWorkIndicator[] = [
    ...waitingAgentIndicators([both], "room_1", () => "00:05"),
    ...supervisedAgentWorkIndicators([both], [], "room_1"),
  ];
  assert.deepEqual(strip.map((row) => [row.id, row.summary, row.waiting ?? false, row.waitsForBackgroundWork ?? false]), [
    ["supervised_1:waiting", "Waiting to try again, due at 00:05 (attempt 2 of 3)", true, false],
    ["supervised_1", "Waiting for a sub-agent to finish (3 min): \"Review the diff\".", false, true],
  ]);
  assert.equal(new Set(strip.map((row) => row.id)).size, strip.length, "no two rows of the strip have the same key");
  // Each row keeps its own look and its own offer through the strip's collapse and its echo.
  const shown = coalesceWorkIndicatorEchoes({}, collapseWorkIndicators(strip).visible, 10).indicators;
  assert.deepEqual(shown.map((row) => [row.id, row.waiting ?? false, row.waitsForBackgroundWork ?? false]).sort(),
    [["supervised_1", false, true], ["supervised_1:waiting", true, false]]);
});

test("the work indicator shows a provider retry, then gives way to the answer", () => {
  const retry = {
    ...entry().activity[0]!,
    provider: "open-model",
    kind: "provider_event",
    method: "letagents/providerRetry",
    summary: "The model provider returned an error. Retrying (attempt 2).",
    observedAt: "2026-07-17T00:00:02.000Z",
    sequence: 6,
  };
  const retrying = supervisedAgentWorkIndicators([entry({ activity: [...entry().activity, retry] })], [], "room_1");
  assert.equal(retrying.length, 1);
  assert.equal(retrying[0]!.summary, "The model provider returned an error. Retrying (attempt 2).");

  const answering = supervisedAgentWorkIndicators([entry({ activity: [...entry().activity, retry, {
    ...retry,
    kind: "text_delta",
    method: "item/agentMessage/delta",
    summary: "",
    observedAt: "2026-07-17T00:00:09.000Z",
    sequence: 7,
  }] })], [], "room_1");
  assert.equal(answering[0]!.summary, "Writing a response");

  // The notice refines an indicator; it never raises one for a finished turn.
  const finished = entry({
    activity: [retry],
    roomAgentState: {
      ...entry().roomAgentState!,
      inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
    },
  });
  assert.deepEqual(supervisedAgentWorkIndicators([finished], [], "room_1"), []);
});

test("echo trims, collapses whitespace, and keeps short summaries verbatim", () => {
  assert.equal(liveActivityEchoText("  running focused tests  "), "running focused tests");
  assert.equal(liveActivityEchoText("checking the\n renderer   route"), "checking the renderer route");
});

test("echo strips control characters that could break the one-line row", () => {
  assert.equal(liveActivityEchoText("edit" + String.fromCharCode(1, 2) + "main.ts"), "edit main.ts");
  assert.equal(liveActivityEchoText("line one\r\nline two\ttabbed"), "line one line two tabbed");
});

test("echo length-bounds with an ellipsis", () => {
  const long = "x".repeat(LIVE_ACTIVITY_ECHO_MAX_LENGTH + 50);
  const echoed = liveActivityEchoText(long);
  assert.equal(echoed.length, LIVE_ACTIVITY_ECHO_MAX_LENGTH);
  assert.ok(echoed.endsWith("…"));
});

test("echo falls back for empty/whitespace/nullish input", () => {
  assert.equal(liveActivityEchoText(""), "Working in the room.");
  assert.equal(liveActivityEchoText("   "), "Working in the room.");
  assert.equal(liveActivityEchoText(null), "Working in the room.");
  assert.equal(liveActivityEchoText(undefined), "Working in the room.");
});

test("a matching agent reply retires an older progress echo before a pending label can replay", () => {
  const work: ManagedAgentWorkIndicator = {
    ...indicator("agent_a", "2026-07-22T15:00:00.000Z", "Writing a response"),
    agentSessionId: "session_a",
    agentKey: "codex:agent_a",
    sourceMessageId: "message_source",
  };
  const source = {
    id: "message_source",
    agentIdentity: null,
  };
  const reply = {
    id: "message_reply",
    agentIdentity: { agentSessionId: "session_a", agentKey: "codex:agent_a" },
  };
  assert.equal(workIndicatorSupersededByAgentMessage(work, [source, reply]), true);
  assert.equal(workIndicatorSupersededByAgentMessage(work, [source, {
    ...reply,
    agentIdentity: { agentSessionId: "session_b", agentKey: "codex:agent_b" },
  }]), false, "one agent replying never clears another agent's work");
  assert.equal(
    workIndicatorSupersededByAgentMessage(work, [reply, source]),
    false,
    "a previous reply cannot suppress progress for a later activating message",
  );
  assert.equal(
    workIndicatorSupersededByAgentMessage({ ...work, sourceMessageId: "message_not_loaded" }, [source, reply]),
    false,
    "missing causal context fails safe by keeping progress visible",
  );
});

test("agent-key fallback retires stale work only when session identity is unavailable", () => {
  const work: ManagedAgentWorkIndicator = {
    ...indicator("agent_a", "2026-07-22T15:00:00.000Z"),
    agentKey: "CODEX:Agent_A",
    sourceMessageId: "message_source",
  };
  assert.equal(workIndicatorSupersededByAgentMessage(work, [
    { id: "message_source", agentIdentity: null },
    { id: "message_reply", agentIdentity: { agentSessionId: null, agentKey: "codex:agent_a" } },
  ]), true);
});

test("collapse keeps all indicators when at or under the limit", () => {
  const three = [indicator("a"), indicator("b"), indicator("c")];
  const result = collapseWorkIndicators(three, 3);
  assert.equal(result.visible.length, 3);
  assert.equal(result.hiddenCount, 0);
});

test("collapse shows the MOST RECENT indicators (newest first) and reports the overflow", () => {
  // Intentionally oldest-first input to prove recency selection, not head-slice.
  const ten = Array.from({ length: 10 }, (_, i) =>
    indicator(`agent_${i}`, `2026-07-17T00:00:${String(i).padStart(2, "0")}.000Z`));
  const result = collapseWorkIndicators(ten, 3);
  assert.equal(result.visible.length, 3);
  assert.equal(result.hiddenCount, 7);
  assert.deepEqual(result.visible.map((w) => w.id), ["agent_9", "agent_8", "agent_7"]);
});

test("an agent that waits to try again never hides an agent that works, and the strip names the rows that it does not show", () => {
  // A row that waits has the future time of its attempt as its time. It must not rank as the newest for that.
  const waits = (id: string, dueAt: string): ManagedAgentWorkIndicator => ({ ...indicator(id, dueAt, "Waiting to try again"), waiting: true });
  const soon = waits("waits_soon", "2026-07-17T00:10:00.000Z");
  const later = waits("waits_later", "2026-07-17T00:20:00.000Z");
  const olderWork = indicator("works_old", "2026-07-17T00:00:01.000Z");
  const newerWork = indicator("works_new", "2026-07-17T00:00:02.000Z");

  // Two agents wait and two work: both that work are shown, as given, and the row that waits and tries first takes the place that is left.
  const mixed = collapseWorkIndicators([later, soon, olderWork, newerWork]);
  assert.deepEqual(mixed.visible.map((row) => row.id), ["works_old", "works_new", "waits_soon"]);
  assert.deepEqual([mixed.hiddenCount, mixed.hiddenWaitingCount], [1, 1]);
  assert.equal(workIndicatorOverflowLabel(mixed), "+1 more agent waiting to try again");
  // Rows of work are all shown before any row that waits, however many work.
  const busy = collapseWorkIndicators([soon, later, ...Array.from({ length: 4 }, (_, index) => indicator(`w${index}`, `2026-07-17T00:00:0${index}.000Z`))]);
  assert.deepEqual(busy.visible.map((row) => row.id), ["w3", "w2", "w1"]);
  assert.deepEqual([busy.hiddenCount, busy.hiddenWaitingCount], [3, 2]);
  assert.equal(workIndicatorOverflowLabel(busy), "+3 more agents working or waiting to try again");
  // Only agents that work are hidden: the strip says "working", as before.
  const crowd = collapseWorkIndicators(Array.from({ length: 5 }, (_, index) => indicator(`w${index}`, `2026-07-17T00:00:0${index}.000Z`)));
  assert.deepEqual([crowd.hiddenCount, crowd.hiddenWaitingCount], [2, 0]);
  assert.equal(workIndicatorOverflowLabel(crowd), "+2 more agents working");
  assert.equal(workIndicatorOverflowLabel({ hiddenCount: 1, hiddenWaitingCount: 0 }), "+1 more agent working");
  assert.equal(workIndicatorOverflowLabel({ hiddenCount: 2, hiddenWaitingCount: 2 }), "+2 more agents waiting to try again");
  // The order does not depend on how many rows there are. Under the limit, nothing is hidden, and a row that waits is below a row of work.
  const few = collapseWorkIndicators([soon, olderWork, later]);
  assert.deepEqual(few.visible.map((row) => row.id), ["works_old", "waits_soon", "waits_later"]);
  assert.deepEqual([few.hiddenCount, few.hiddenWaitingCount], [0, 0]);
  assert.deepEqual(collapseWorkIndicators([later, soon, newerWork, olderWork]).visible.map((row) => row.id), ["works_new", "works_old", "waits_soon"]);
  // A turn that is held open for background work has a control: "Post answer now". It is the oldest row of work, and still is shown,
  // before the rows without a control, and before a row that waits. It is a row of work, not a row that waits.
  const held: ManagedAgentWorkIndicator = { ...indicator("held", "2026-07-17T00:00:00.000Z", "Waiting for a sub-agent to finish"), waitsForBackgroundWork: true };
  const four = Array.from({ length: 4 }, (_, index) => indicator(`w${index}`, `2026-07-17T00:00:0${index + 1}.000Z`));
  const crowded = collapseWorkIndicators([held, ...four]);
  assert.deepEqual(crowded.visible.map((row) => row.id), ["held", "w3", "w2"]);
  assert.deepEqual([crowded.hiddenCount, crowded.hiddenWaitingCount], [2, 0]);
  assert.deepEqual(collapseWorkIndicators([soon, ...four, held]).visible.map((row) => row.id), ["held", "w3", "w2"]);
  assert.deepEqual(collapseWorkIndicators([soon, later, held]).visible.map((row) => row.id), ["held", "waits_soon", "waits_later"]);
  assert.deepEqual(collapseWorkIndicators([held, soon]).visible.map((row) => row.id), ["held", "waits_soon"]);

  // A row never jumps because a time ticked. The rows of a kind keep the order that they were given when they all are shown. Time decides
  // only for a kind that does not fit: its rows are ordered by time, and the places go to the first.
  const tick = (row: ManagedAgentWorkIndicator, startedAt: string) => ({ ...row, startedAt });
  const ids = (rows: ManagedAgentWorkIndicator[]) => collapseWorkIndicators(rows).visible.map((row) => row.id);
  assert.deepEqual(ids([olderWork, newerWork]), ["works_old", "works_new"]);
  assert.deepEqual(ids([tick(olderWork, "2026-07-17T00:00:09.000Z"), newerWork]), ["works_old", "works_new"], "its time is now the newer: it stays first");
  assert.deepEqual(ids([newerWork, olderWork]), ["works_new", "works_old"]);
  assert.deepEqual(ids([tick(soon, "2026-07-17T00:50:00.000Z"), later]), ["waits_soon", "waits_later"], "a row that waits keeps its place when its time moves");
  assert.deepEqual(ids([soon, olderWork, held]), ["held", "works_old", "waits_soon"], "the kinds keep their order");
  assert.deepEqual(ids([later, soon, olderWork]), ["works_old", "waits_later", "waits_soon"], "and a kind keeps the order given, whatever the times of its rows");
  assert.deepEqual(ids([soon, olderWork, held, later]), ["held", "works_old", "waits_soon"], "of the rows that wait, the one that tries first keeps the place that is left");
  const five = Array.from({ length: 5 }, (_, index) => indicator(`w${index}`, `2026-07-17T00:00:0${index + 1}.000Z`));
  // Rows are hidden: the most recent are shown, the newest first.
  assert.deepEqual(ids([five[3]!, five[0]!, five[4]!, five[1]!, five[2]!]), ["w4", "w3", "w2"]);
  assert.deepEqual(ids(five), ["w4", "w3", "w2"]);
  // Several rows that carry a control keep the order given when they all fit. When they do not, the oldest is hidden first.
  const heldRows = ["a", "b", "c", "d"].map((id, index): ManagedAgentWorkIndicator => ({ ...indicator(`held_${id}`, `2026-07-17T00:00:0${index}.000Z`), waitsForBackgroundWork: true }));
  assert.deepEqual(ids([heldRows[1]!, heldRows[0]!]), ["held_b", "held_a"], "all shown: as given");
  assert.deepEqual(ids([heldRows[2]!, heldRows[0]!, heldRows[1]!]), ["held_c", "held_a", "held_b"]);
  assert.deepEqual(ids([heldRows[1]!, heldRows[3]!, heldRows[0]!, heldRows[2]!]), ["held_d", "held_c", "held_b"], "four held rows: the oldest is hidden");
  assert.deepEqual(ids([...heldRows, ...five]), ["held_d", "held_c", "held_b"], "rows with a control fill the places before any other");
  // The rows that wait fill the places that are left, the one that tries first coming first.
  assert.deepEqual(collapseWorkIndicators([later, soon, waits("waits_last", "2026-07-17T00:30:00.000Z"), waits("waits_next", "2026-07-17T00:05:00.000Z")]).visible.map((row) => row.id),
    ["waits_next", "waits_soon", "waits_later"]);
});

test("echo coalescing shows a new entry immediately", () => {
  const { state, indicators, hasPending } = coalesceWorkIndicatorEchoes(
    {}, [indicator("a", "2026-07-17T00:00:00.000Z", "step one")], 1_000,
  );
  assert.equal(indicators[0]!.summary, "step one");
  assert.equal(hasPending, false);
  assert.equal(state["a"]!.summary, "step one");
});

test("echo coalescing holds a change inside the window (latest value wins after it elapses)", () => {
  const t0 = 10_000;
  const first = coalesceWorkIndicatorEchoes({}, [indicator("a", "t", "step one")], t0);
  // A change 1s later (< 2.5s window) is held back; prior text stays shown.
  const withinWindow = coalesceWorkIndicatorEchoes(first.state, [indicator("a", "t", "step two")], t0 + 1_000);
  assert.equal(withinWindow.indicators[0]!.summary, "step one", "held inside window");
  assert.equal(withinWindow.hasPending, true);
  // A newer change still inside the window — latest value must win once flushed.
  const stillWithin = coalesceWorkIndicatorEchoes(withinWindow.state, [indicator("a", "t", "step three")], t0 + 2_000);
  assert.equal(stillWithin.indicators[0]!.summary, "step one", "still held");
  // After the window elapses, the latest summary surfaces.
  const afterWindow = coalesceWorkIndicatorEchoes(stillWithin.state, [indicator("a", "t", "step three")], t0 + WORK_INDICATOR_ECHO_MIN_INTERVAL_MS + 1);
  assert.equal(afterWindow.indicators[0]!.summary, "step three", "latest value wins after window");
  assert.equal(afterWindow.hasPending, false);
});

test("echo coalescing keeps an unchanged summary stable without pending", () => {
  const first = coalesceWorkIndicatorEchoes({}, [indicator("a", "t", "same")], 0);
  const again = coalesceWorkIndicatorEchoes(first.state, [indicator("a", "t", "same")], 100_000);
  assert.equal(again.indicators[0]!.summary, "same");
  assert.equal(again.hasPending, false);
  assert.equal(again.state["a"]!.shownAtMs, first.state["a"]!.shownAtMs, "shownAt unchanged when text is stable");
});

test("echo coalescing drops entries that go idle (cancellation, no stale echo)", () => {
  const first = coalesceWorkIndicatorEchoes({}, [indicator("a"), indicator("b")], 0);
  const idle = coalesceWorkIndicatorEchoes(first.state, [indicator("a")], 1_000);
  assert.deepEqual(idle.indicators.map((w) => w.id), ["a"]);
  assert.equal("b" in idle.state, false, "idle entry cleared from state");
});

test("supervised indicator echoes a bounded summary and uses a stable per-entry id", () => {
  const longSummary = "y".repeat(LIVE_ACTIVITY_ECHO_MAX_LENGTH + 20);
  const indicators = supervisedAgentWorkIndicators(
    [entry({ activity: [{ ...entry().activity[0]!, kind: "product_progress", method: "progress", summary: longSummary }] })],
    [{ agentSessionId: "agent_session_1", displayName: "MistyMorrow", actorLabel: "MistyMorrow" }],
    "room_1",
  );
  assert.equal(indicators.length, 1);
  // Stable id: no per-sequence suffix, so the row updates in place, not remounts.
  assert.equal(indicators[0]!.id, "supervised_1");
  assert.equal(indicators[0]!.summary.length, LIVE_ACTIVITY_ECHO_MAX_LENGTH);
  assert.ok(indicators[0]!.summary.endsWith("…"));
});

test("supervised indicator clears when the agent is only idle-polling (composes with task_67)", () => {
  const idlePoll = entry({
    observedState: "idle",
    roomAgentState: {
      ...entry().roomAgentState!,
      inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
    },
  });
  assert.deepEqual(supervisedAgentWorkIndicators([idlePoll], [], "room_1"), []);
});

test("provider account notifications stay in diagnostics but never masquerade as room work", () => {
  const rateLimitEvent = {
    ...entry().activity[0]!,
    kind: "provider_event",
    method: "account/rateLimits/updated",
    summary: "account/rateLimits/updated",
  };
  const withNoiseOnly = entry({
    activity: [rateLimitEvent],
    roomAgentState: {
      ...entry().roomAgentState!,
      inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
    },
  });
  assert.deepEqual(supervisedAgentWorkIndicators([withNoiseOnly], [], "room_1"), []);
  assert.equal(isHumanVisibleSupervisorActivity(rateLimitEvent), false);
  assert.equal(isHumanVisibleSupervisorActivity({ kind: "turn_lifecycle", method: "turn/completed" }), true);
});

test("provider protocol summaries become calm product progress labels", () => {
  assert.equal(humanFacingSupervisorActivitySummary({ kind: "item_lifecycle", method: "item/started", summary: "codex · item/started" }), "Thinking");
  assert.equal(humanFacingSupervisorActivitySummary({ kind: "text_delta", method: "item/agentMessage/delta", summary: "codex · item/agentMessage/delta" }), "Writing a response");
  assert.equal(humanFacingSupervisorActivitySummary({ kind: "command_output", method: "item/commandExecution/outputDelta", summary: "codex · item/commandExecution/outputDelta" }), "Working in the project");
});

test("provider-approved reasoning summaries replace the generic thinking label", () => {
  assert.equal(humanFacingSupervisorActivitySummary({
    kind: "text_delta",
    method: "item/reasoning/summaryTextDelta",
    summary: "Checking the delivery boundary before replying",
  }), "Checking the delivery boundary before replying");
  assert.equal(humanFacingSupervisorActivitySummary({
    kind: "text_delta",
    method: "item/reasoning/summaryTextDelta",
    summary: "codex · item/reasoning/summaryTextDelta",
  }), "Thinking through the request");
  assert.equal(humanFacingSupervisorActivitySummary({
    kind: "text_delta",
    method: "item/reasoning/textDelta",
    summary: "Codex raw reasoning text is streaming.",
  }), "Thinking through the request");
});
