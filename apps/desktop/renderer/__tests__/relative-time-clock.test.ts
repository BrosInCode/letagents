import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { computed, effectScope } from "vue";

import { useNow } from "../src/composables/useNow";
import { formatRelativeTime } from "../src/domain/time";
import { remoteAgentWorkIndicators } from "../src/domain/managed-agents";
import { relativeTime } from "../src/components/desktop/content/room-board/formatters";
import { hasAgentSignal } from "../src/components/desktop/content/room-activity/signals";
import type { ActivityParticipant } from "../src/components/desktop/content/room-activity/types";

const START = Date.parse("2026-10-19T12:00:00.000Z");

describe("time-dependent labels follow the shared clock with unchanged data", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: START }));
  afterEach(() => mock.timers.reset());

  it("advances a board card label and a roster label with no data change", () => {
    const updatedAt = new Date(START).toISOString();
    const scope = effectScope();
    const labels = scope.run(() => {
      const now = useNow(30_000);
      return { board: computed(() => relativeTime(updatedAt, now.value)), roster: computed(() => formatRelativeTime(updatedAt, now.value)) };
    })!;
    assert.equal(labels.board.value, "just now");
    assert.equal(labels.roster.value, "just now");
    mock.timers.tick(5 * 60_000);
    assert.equal(labels.board.value, "5m ago");
    assert.equal(labels.roster.value, "5m ago");
    mock.timers.tick(20 * 60_000);
    assert.equal(labels.board.value, "25m ago");
    scope.stop();
  });

  it("expires the recent-signal window and the 90 s working window with no data change", () => {
    const seen = new Date(START).toISOString();
    const participant = {
      kind: "agent", livenessObservation: null, workState: "working", statusText: "x",
      lastSeenAt: seen, activeReasoning: [], currentTasks: [],
    } as unknown as ActivityParticipant;
    const presence = [{
      agentKey: "a/b", agentSessionId: "s1", status: "working", lastHeartbeatAt: seen,
      displayName: "B", actorLabel: "agent:b", statusText: "x",
    }] as unknown as Parameters<typeof remoteAgentWorkIndicators>[0];
    const scope = effectScope();
    const state = scope.run(() => {
      const now = useNow(30_000);
      return {
        signal: computed(() => hasAgentSignal(participant, now.value)),
        working: computed(() => remoteAgentWorkIndicators(presence, [], [], now.value).length),
      };
    })!;
    assert.equal(state.signal.value, true);
    assert.equal(state.working.value, 1);
    mock.timers.tick(2 * 60_000);
    assert.equal(state.working.value, 0);
    assert.equal(state.signal.value, true);
    mock.timers.tick(14 * 60_000);
    assert.equal(state.signal.value, false);
    scope.stop();
  });
});
