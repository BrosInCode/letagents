import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopAgentPresence, DesktopTaskSummary } from "../../electron/ipc-types";
import { reviewAssignmentCandidates } from "../src/components/desktop/content/room-board/review-candidates";
import {
  executionAuthorityState,
  reviewPanelState,
  workflowRefs,
} from "../src/components/desktop/content/room-board/task-state";

describe("room board helpers", () => {
  it("falls back to the legacy pull request URL when workflow refs are absent", () => {
    assert.deepEqual(workflowRefs(task({ prUrl: "https://github.com/org/repo/pull/12" })), [
      {
        provider: "github",
        kind: "pull_request",
        label: "PR",
        url: "https://github.com/org/repo/pull/12",
      },
    ]);
  });

  it("reports execution lease ownership mismatches", () => {
    const state = executionAuthorityState(task({
      assignee: "Alex",
      assigneeAgentKey: "codex/alex",
      activeLeases: [
        lease({ kind: "work", agentKey: "codex/blake", holderLabel: "Blake" }),
      ],
    }));

    assert.equal(state.state, "mismatch");
    assert.equal(state.label, "Different worker is active");
  });

  it("marks review authority as conflicted when the reviewer also holds the work lease", () => {
    const state = reviewPanelState(task({
      status: "in_review",
      activeLeases: [
        lease({ kind: "work", agentKey: "codex/alex", holderLabel: "Alex" }),
        lease({ kind: "review", agentKey: "codex/alex", holderLabel: "Alex" }),
      ],
    }));

    assert.equal(state.state, "conflict");
  });

  it("filters reviewer assignment candidates to active non-conflicting workers", () => {
    const candidates = reviewAssignmentCandidates(
      task({
        status: "in_review",
        activeLeases: [
          lease({ kind: "work", agentKey: "codex/alex", holderLabel: "Alex" }),
          lease({ kind: "review", agentKey: "codex/casey", holderLabel: "Casey" }),
        ],
      }),
      [
        presence({ displayName: "Alex", agentKey: "codex/alex", agentSessionId: "session_alex" }),
        presence({ displayName: "Blake", agentKey: "codex/blake", agentSessionId: "session_blake" }),
        presence({ displayName: "Casey", agentKey: "codex/casey", agentSessionId: "session_casey" }),
        presence({ displayName: "Dana", agentKey: "codex/dana", agentSessionId: "session_dana", freshness: "stale" }),
        presence({ displayName: "Riley", sessionKind: "controller", agentKey: "codex/riley", agentSessionId: "session_riley" }),
      ]
    );

    assert.deepEqual(candidates.map((candidate) => candidate.displayName), ["Blake"]);
  });
});

function task(overrides: Partial<DesktopTaskSummary> = {}): DesktopTaskSummary {
  return {
    id: "task_1",
    title: "Test task",
    description: null,
    status: "accepted",
    assignee: null,
    assigneeAgentKey: null,
    createdBy: null,
    prUrl: null,
    workflowArtifacts: [],
    workflowRefs: [],
    activeLeases: [],
    activeLocks: [],
    stalePromptState: null,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

function lease(
  overrides: Partial<DesktopTaskSummary["activeLeases"][number]> = {}
): DesktopTaskSummary["activeLeases"][number] {
  return {
    id: `lease_${overrides.kind || "work"}`,
    kind: "work",
    holderLabel: null,
    agentKey: null,
    agentSessionId: null,
    status: "active",
    updatedAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

function presence(overrides: Partial<DesktopAgentPresence> = {}): DesktopAgentPresence {
  return {
    roomId: "room_1",
    actorLabel: "Blake | Codex",
    agentKey: "codex/blake",
    agentInstanceId: "instance_blake",
    agentSessionId: "session_blake",
    sessionKind: "worker",
    runtime: "codex",
    displayName: "Blake",
    ownerLabel: null,
    ideLabel: "Codex",
    status: "working",
    statusText: null,
    lastHeartbeatAt: "2026-05-28T00:00:00.000Z",
    freshness: "active",
    activityState: "active",
    sourceFlags: ["presence"],
    livenessObservation: null,
    ...overrides,
  };
}
