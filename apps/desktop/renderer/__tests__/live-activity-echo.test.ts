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
  workIndicatorSupersededByAgentMessage,
  type ManagedAgentWorkIndicator,
} from "../src/domain/managed-agents";
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
  };
  const reply = {
    timestamp: "2026-07-22T15:00:01.000Z",
    agentIdentity: { agentSessionId: "session_a", agentKey: "codex:agent_a" },
  };
  assert.equal(workIndicatorSupersededByAgentMessage(work, [reply]), true);
  assert.equal(workIndicatorSupersededByAgentMessage(work, [{
    ...reply,
    agentIdentity: { agentSessionId: "session_b", agentKey: "codex:agent_b" },
  }]), false, "one agent replying never clears another agent's work");
  assert.equal(workIndicatorSupersededByAgentMessage(work, [{
    ...reply,
    timestamp: "2026-07-22T14:59:59.000Z",
  }]), false, "historical messages do not suppress a newer turn");
});

test("agent-key fallback retires stale work only when session identity is unavailable", () => {
  const work: ManagedAgentWorkIndicator = {
    ...indicator("agent_a", "2026-07-22T15:00:00.000Z"),
    agentKey: "CODEX:Agent_A",
  };
  assert.equal(workIndicatorSupersededByAgentMessage(work, [{
    timestamp: "2026-07-22T15:00:01.000Z",
    agentIdentity: { agentSessionId: null, agentKey: "codex:agent_a" },
  }]), true);
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
  const idlePoll = entry({ observedState: "idle" });
  assert.deepEqual(supervisedAgentWorkIndicators([idlePoll], [], "room_1"), []);
});

test("provider account notifications stay in diagnostics but never masquerade as room work", () => {
  const rateLimitEvent = {
    ...entry().activity[0]!,
    kind: "provider_event",
    method: "account/rateLimits/updated",
    summary: "account/rateLimits/updated",
  };
  const withNoiseOnly = entry({ activity: [rateLimitEvent] });
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
