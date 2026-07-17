import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_ACTIVITY_ECHO_MAX_LENGTH,
  collapseWorkIndicators,
  liveActivityEchoText,
  supervisedAgentWorkIndicators,
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

function indicator(id: string): ManagedAgentWorkIndicator {
  return { id, displayName: id, summary: "working", startedAt: "2026-07-17T00:00:00.000Z" };
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

test("collapse keeps all indicators when at or under the limit", () => {
  const three = [indicator("a"), indicator("b"), indicator("c")];
  const result = collapseWorkIndicators(three, 3);
  assert.equal(result.visible.length, 3);
  assert.equal(result.hiddenCount, 0);
});

test("collapse caps visible indicators and reports the overflow", () => {
  const ten = Array.from({ length: 10 }, (_, i) => indicator(`agent_${i}`));
  const result = collapseWorkIndicators(ten, 3);
  assert.equal(result.visible.length, 3);
  assert.equal(result.hiddenCount, 7);
  assert.deepEqual(result.visible.map((w) => w.id), ["agent_0", "agent_1", "agent_2"]);
});

test("supervised indicator echoes a bounded summary and uses a stable per-entry id", () => {
  const longSummary = "y".repeat(LIVE_ACTIVITY_ECHO_MAX_LENGTH + 20);
  const indicators = supervisedAgentWorkIndicators(
    [entry({ activity: [{ ...entry().activity[0]!, summary: longSummary }] })],
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
