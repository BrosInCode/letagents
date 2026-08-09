import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DesktopAgentPresence,
  DesktopBoardIntentSummary,
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../electron/ipc-types";
import {
  BOARD_HANDOFF_STAGE_LABELS,
  boardEmptyState,
  boardFilterCount,
  deriveTaskTitle,
  visibleBoardGroups,
} from "../src/components/desktop/content/room-board/board-presentation";
import { findLocalRoomWorker } from "../src/components/desktop/content/room-board/board-workers";
import {
  activeBoardManagerAgents,
  managerCandidateName,
  managerCandidateRuntime,
  readableIntentBody,
} from "../src/components/desktop/content/room-board/governance-presentation";
import { reviewAssignmentCandidates } from "../src/components/desktop/content/room-board/review-candidates";
import {
  executionAuthorityState,
  reviewPanelState,
  workflowRefs,
} from "../src/components/desktop/content/room-board/task-state";
import { TASK_STATUS_ORDER, sortTasks } from "../src/domain/tasks";

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

  it("shares local-worker matching across board filters and grouping", () => {
    const localWorker = findLocalRoomWorker([
      worker({ roomId: "other-room", agentSessionId: "wrong-session" }),
      worker(),
    ], "ROOM_1");
    const tasks = [
      task({ id: "task_mine", assigneeAgentKey: "codex/blake" }),
      task({ id: "task_other", assigneeAgentKey: "codex/casey" }),
      task({ id: "task_done", status: "done" }),
    ];

    assert.equal(localWorker?.agentSessionId, "session_blake");
    assert.equal(boardFilterCount(tasks, "mine", localWorker), 1);
    assert.deepEqual(
      visibleBoardGroups({
        tasks,
        filter: "mine",
        searchQuery: "task_mine",
        localWorker,
      }).flatMap((group) => group.tasks.map((entry) => entry.id)),
      ["task_mine"]
    );
  });

  it("uses one canonical task lifecycle for board grouping and sorting", () => {
    const tasks = TASK_STATUS_ORDER.map((status, index) => task({
      id: `task_${index}`,
      status,
    })).reverse();

    assert.deepEqual(sortTasks(tasks).map((entry) => entry.status), TASK_STATUS_ORDER);
    assert.deepEqual(
      visibleBoardGroups({
        tasks,
        filter: "open",
        searchQuery: "",
        localWorker: null,
      }).map((group) => group.status),
      TASK_STATUS_ORDER.slice(0, 6)
    );
    assert.deepEqual(BOARD_HANDOFF_STAGE_LABELS, [
      "Proposed",
      "Accepted",
      "Assigned",
      "In Progress",
      "Review",
      "Closeout",
    ]);
  });

  it("keeps board empty-state copy and actions deterministic", () => {
    assert.deepEqual(boardEmptyState({
      taskCount: 0,
      hasSearchQuery: false,
      filter: "open",
      closeoutTaskCount: 0,
    }), {
      variant: "first-task",
      title: "Start the first handoff",
      description: "Create a task, then route it to a teammate or agent when it is ready.",
      actionLabel: "Create first task",
      action: "add-task",
      testId: "room-board-empty",
    });
    assert.equal(boardEmptyState({
      taskCount: 2,
      hasSearchQuery: true,
      filter: "open",
      closeoutTaskCount: 0,
    }).action, "clear-search");
    assert.equal(boardEmptyState({
      taskCount: 2,
      hasSearchQuery: false,
      filter: "open",
      closeoutTaskCount: 2,
    }).action, "show-closeout");
  });

  it("derives stable task titles without duplicating form logic", () => {
    assert.equal(deriveTaskTitle(" Explicit title ", "ignored"), "Explicit title");
    assert.equal(deriveTaskTitle("", "\n First useful line\nSecond"), "First useful line");
    assert.equal(deriveTaskTitle("", "x".repeat(120)), `${"x".repeat(93)}...`);
  });

  it("deduplicates active board-manager candidates by worker session", () => {
    const active = presence();
    assert.deepEqual(activeBoardManagerAgents([
      active,
      { ...active, displayName: "Duplicate" },
      presence({ agentSessionId: "session_stale", freshness: "stale" }),
      presence({ agentSessionId: "session_offline", activityState: "offline" }),
    ]).map((entry) => entry.agentSessionId), ["session_blake"]);
  });

  it("keeps governance candidate and intent copy in shared presenters", () => {
    const candidate = {
      agentSessionId: "session_blake",
      actorLabel: "Blake | Emmy's agent | Agent",
      displayName: "Blake | Emmy's agent | Agent",
      runtime: "codex:room-1",
      runtimeSource: "desktop_managed" as const,
      isActiveManager: false,
    };
    assert.equal(managerCandidateName(candidate), "Blake");
    assert.equal(managerCandidateRuntime(candidate), "Codex");
    assert.equal(readableIntentBody(intent({
      actionType: "task_override",
      taskId: "task_9",
      payload: { action: "handoff", target_actor_key: "codex/casey" },
    })), "Hand off task_9 to codex/casey");
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
    repoBranch: null,
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

function worker(overrides: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return {
    id: "worker_blake",
    runtime: "codex",
    state: "connected",
    roomId: "room_1",
    actorLabel: "Blake | Codex",
    agentKey: "codex/blake",
    agentSessionId: "session_blake",
    detail: "Blake",
    ...overrides,
  };
}

function intent(
  overrides: Partial<DesktopBoardIntentSummary> = {}
): DesktopBoardIntentSummary {
  return {
    id: "intent_1",
    taskId: null,
    actionType: "task_create",
    status: "pending",
    proposerActorLabel: "Blake",
    payload: {},
    createdAt: "2026-05-28T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}
