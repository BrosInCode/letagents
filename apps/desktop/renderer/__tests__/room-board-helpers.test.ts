import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, effectScope, h, nextTick, reactive } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

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
  boardOwnerOptions,
  boardOwnerValue,
  boardStatusOptions,
  deriveTaskTitle,
  visibleBoardGroups,
} from "../src/components/desktop/content/room-board/board-presentation";
import { findLocalRoomWorker } from "../src/components/desktop/content/room-board/board-workers";
import { useRoomBoardPresentation } from "../src/components/desktop/content/room-board/useRoomBoardPresentation";
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

let vite: ViteDevServer;
let TaskCard: object;
let Kanban: object;
let Toolbar: object;
before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  TaskCard = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-board/RoomBoardTaskCard.vue")).default;
  Kanban = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-board/RoomBoardKanban.vue")).default;
  Toolbar = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-board/RoomBoardToolbar.vue")).default;
});
after(async () => { await vite?.close(); });

describe("board card hierarchy", () => {
  it("renders labelled filters and shows Clear filters only for active refinements", async () => {
    const render = (filters: { searchQuery?: string; ownerFilter?: string; statusFilter?: string; sort?: string } = {}) => renderToString(createSSRApp({
      render: () => h(Toolbar, {
        searchQuery: "", activeFilter: "open", filterOptions: [], busy: false,
        managerMode: "off", managerTitle: "Off", pendingIntentCount: 0, governanceOpen: false,
        ownerFilter: "all", ownerOptions: boardOwnerOptions([task({ assignee: "Alex" })]),
        statusFilter: "all", statusOptions: boardStatusOptions(), sort: "recent",
        ...filters,
      }),
    }));
    const html = await render();
    for (const label of ["Filter by owner", "Filter by status", "Sort tasks"]) {
      assert.match(html, new RegExp(`<select[^>]*aria-label="${label}"`));
    }
    assert.match(html, /value="label:Alex"/);
    assert.match(html, /value="unassigned"/);
    assert.match(html, /value="oldest">Oldest first/);
    assert.match(html, /value="done"/);
    assert.doesNotMatch(html, /Clear filters/);
    assert.doesNotMatch(await render({ sort: "oldest", searchQuery: "   " }), /Clear filters/);
    for (const filters of [{ searchQuery: "Test" }, { ownerFilter: "unassigned" }, { statusFilter: "done" }]) {
      assert.match(await render(filters), /<button[^>]*class="desktop-board-clear-filter"[^>]*>[\s\S]*?Clear filters\s*<\/button>/);
    }
  });

  it("keeps the primary action visible without making cancellation the default", async () => {
    const render = (actions: object[]) => renderToString(createSSRApp({
      render: () => h(TaskCard, { task: task(), actions, busyAction: null, draggableTask: false, selected: false }),
    }));
    const cancel = { id: "cancel", label: "Cancel task", tone: "danger" };
    const html = await render([cancel, { id: "accept", label: "Accept", tone: "primary" }]);
    assert.match(html, />Accept<\/button>/);
    assert.doesNotMatch(html, /Cancel task/);
    assert.match(await render([cancel]), /aria-label="Open Test task"/);
  });

  it("preserves reviewers, lock detail, and access to overflow links", async () => {
    const html = await renderToString(createSSRApp({
      render: () => h(TaskCard, {
        task: task({
          activeLeases: [lease({ kind: "review", holderLabel: "Casey" })],
          activeLocks: [{ id: "lock", scope: "task", reason: "Access", message: "Needs repo access", createdBy: "Emmy" }],
          workflowRefs: [1, 2, 3].map(number => ({
            provider: "github", kind: "pull_request", label: `PR #${number}`, url: `https://github.com/org/repo/pull/${number}`,
          })),
        }),
        actions: [], busyAction: null, draggableTask: false, selected: false,
      }),
    }));
    assert.match(html, /Reviewer: Casey/);
    assert.match(html, /task lock: Access - Needs repo access/);
    assert.match(html, /<button[^>]*desktop-task-more-links[^>]*>\s*\+1 links/);
  });

  it("retains a labelled target for collapsed columns", async () => {
    const html = await renderToString(createSSRApp({
      render: () => h(Kanban, {
        groups: [{ status: "accepted", label: "Accepted", tasks: [task()] }],
        activeFilter: "open", selectedTaskId: null, busyAction: null,
        collapsedGroups: new Set(["accepted"]), actionsFor: () => [],
      }),
    }));
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /aria-controls="desktop-task-group-accepted"/);
    assert.match(html, /id="desktop-task-group-accepted"/);
    assert.match(html, /display:none/);
  });
});

describe("room board helpers", () => {
  it("uses stable owner identities and keeps known owners distinct from unassigned", () => {
    const tasks = [
      task(),
      task({ id: "task_2", assignee: "Alex", assigneeAgentKey: "codex/alex" }),
      task({ id: "task_3", assignee: "Alex", assigneeAgentKey: "codex/alex" }),
      task({ id: "task_4", assignee: "Alex", assigneeAgentKey: "claude/alex" }),
      task({ id: "task_5", assignee: "all" }),
      task({ id: "task_6", assigneeAgentKey: "codex/key-only" }),
    ];
    assert.equal(boardOwnerValue(tasks[0]), "unassigned");
    assert.equal(boardOwnerValue(tasks[5]), "key:codex/key-only");
    assert.deepEqual(new Set(boardOwnerOptions(tasks).map(option => option.id)), new Set([
      "all", "unassigned", "key:codex/alex", "key:claude/alex", "label:all", "key:codex/key-only",
    ]));
  });

  it("combines owner, status, search and board-view filters without mutating tasks", () => {
    const tasks = [
      task({ id: "task_1", title: "Ship tests", assignee: "Alex", assigneeAgentKey: "codex/alex" }),
      task({ id: "task_2", title: "Ship tests", assignee: "Blake", status: "in_review" }),
      task({ id: "task_3", title: "Ship tests", assignee: "Alex", assigneeAgentKey: "codex/alex", status: "done" }),
      task({ id: "task_4", title: "Ship tests" }),
    ];
    const input = { tasks, filter: "open" as const, searchQuery: "ship", localWorker: null };
    assert.deepEqual(visibleBoardGroups({ ...input, ownerFilter: "key:codex/alex", statusFilter: "accepted" })
      .flatMap(group => group.tasks.map(entry => entry.id)), ["task_1"]);
    assert.deepEqual(visibleBoardGroups({ ...input, ownerFilter: "unassigned" })
      .flatMap(group => group.tasks.map(entry => entry.id)), ["task_4"]);
    assert.deepEqual(visibleBoardGroups({ ...input, filter: "closeout", statusFilter: "done" })
      .flatMap(group => group.tasks.map(entry => entry.id)), ["task_3"]);
    assert.equal(visibleBoardGroups({ ...input, searchQuery: "missing" }).flatMap(group => group.tasks).length, 0);
    assert.deepEqual(tasks.map(entry => entry.id), ["task_1", "task_2", "task_3", "task_4"]);
  });

  it("sorts recent by update time, oldest by creation time, and title with deterministic ties", () => {
    const tasks = [
      task({ id: "task_2", title: "Beta", createdAt: "2026-05-26T00:00:00Z", updatedAt: "2026-05-29T00:00:00Z" }),
      task({ id: "task_1", title: "Alpha", updatedAt: "", createdAt: "2026-05-27T00:00:00Z" }),
      task({ id: "task_3", title: "Beta", updatedAt: "2026-05-29T00:00:00Z" }),
    ];
    const input = { tasks, filter: "open" as const, searchQuery: "", localWorker: null };
    const ids = (sort: "recent" | "oldest" | "title") => visibleBoardGroups({ ...input, sort })
      .flatMap(group => group.tasks.map(entry => entry.id));
    assert.deepEqual(ids("recent"), ["task_2", "task_3", "task_1"]);
    assert.deepEqual(ids("oldest"), ["task_2", "task_1", "task_3"]);
    assert.deepEqual(ids("title"), ["task_1", "task_2", "task_3"]);
    assert.deepEqual(tasks.map(entry => entry.id), ["task_2", "task_1", "task_3"]);
  });

  it("resets room filters and recovers empty views without dropping the selected modal", async () => {
    const props = reactive({ roomIdentifier: "room_1", tasks: [task()], workers: [] as WorkerSnapshot[] });
    const scope = effectScope();
    const board = scope.run(() => useRoomBoardPresentation(props, () => {}))!;
    try {
      board.selectTask("task_1");
      board.ownerFilter.value = "label:nobody";
      board.setStatusFilter("in_review");
      board.searchQuery.value = "missing";
      board.setSort("title");
      assert.equal(board.visibleTaskCount.value, 0);
      assert.equal(board.modalTask.value?.id, "task_1");
      assert.equal(board.emptyState.value.actionLabel, "Clear filters");
      board.runEmptyStateAction(board.emptyState.value.action);
      assert.equal(board.visibleTaskCount.value, 1);
      assert.equal(board.ownerFilter.value, "all");
      assert.equal(board.statusFilter.value, "all");
      assert.equal(board.searchQuery.value, "");
      assert.equal(board.sort.value, "title");

      board.ownerFilter.value = "unassigned";
      board.setStatusFilter("accepted");
      board.searchQuery.value = "Test";
      board.setSort("oldest");
      assert.equal(board.visibleTaskCount.value, 1);
      board.clearFilters();
      assert.equal(board.ownerFilter.value, "all");
      assert.equal(board.statusFilter.value, "all");
      assert.equal(board.searchQuery.value, "");
      assert.equal(board.sort.value, "oldest");
      assert.equal(board.visibleTaskCount.value, 1);

      board.setStatusFilter("accepted");
      board.setActiveFilter("closeout");
      assert.equal(board.statusFilter.value, "all");
      assert.deepEqual(board.statusOptions.value.map(option => option.id), ["all", ...TASK_STATUS_ORDER]);
      board.ownerFilter.value = "unassigned";
      board.setStatusFilter("done");
      board.searchQuery.value = "again";
      props.roomIdentifier = "room_2";
      await nextTick();
      assert.equal(board.activeFilter.value, "open");
      assert.equal(board.ownerFilter.value, "all");
      assert.equal(board.statusFilter.value, "all");
      assert.equal(board.searchQuery.value, "");
      assert.equal(board.sort.value, "recent");

      props.tasks = [task({ status: "done" })];
      board.ownerFilter.value = "label:nobody";
      board.runEmptyStateAction("clear-filters");
      assert.equal(board.activeFilter.value, "closeout");
      assert.equal(board.visibleTaskCount.value, 1);
    } finally {
      scope.stop();
    }
  });

  it("keeps quick views compatible with specific statuses in both directions", () => {
    const props = reactive({
      roomIdentifier: "room_1", workers: [] as WorkerSnapshot[],
      tasks: TASK_STATUS_ORDER.map(status => task({ id: `task_${status}`, status })),
    });
    const scope = effectScope();
    const board = scope.run(() => useRoomBoardPresentation(props, () => {}))!;
    try {
      for (const status of TASK_STATUS_ORDER) {
        board.setActiveFilter("mine");
        board.setStatusFilter(status);
        assert.equal(board.activeFilter.value, ["merged", "done", "cancelled"].includes(status) ? "closeout" : "open");
        assert.equal(board.statusFilter.value, status);
        assert.deepEqual(board.visibleGroups.value.flatMap(group => group.tasks.map(entry => entry.id)), [`task_${status}`]);
      }
      for (const filter of ["open", "mine", "unclaimed", "needs-review", "closeout"]) {
        board.setStatusFilter("accepted");
        board.setActiveFilter(filter);
        assert.equal(board.activeFilter.value, filter);
        assert.equal(board.statusFilter.value, "all");
      }
      board.ownerFilter.value = "unassigned";
      board.searchQuery.value = "Test";
      board.setSort("title");
      board.setStatusFilter("done");
      board.setStatusFilter("all");
      assert.equal(board.activeFilter.value, "closeout");
      assert.equal(board.visibleTaskCount.value, 3);
      assert.equal(board.ownerFilter.value, "unassigned");
      assert.equal(board.searchQuery.value, "Test");
      assert.equal(board.sort.value, "title");
      board.setStatusFilter("not-a-status");
      assert.equal(board.statusFilter.value, "all");
    } finally {
      scope.stop();
    }
  });

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
