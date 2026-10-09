import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, effectScope, h, nextTick, reactive, ref } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

import type {
  DesktopAgentPresence,
  DesktopBoardGovernanceSnapshot,
  DesktopBoardIntentSummary,
  DesktopBoardSettingsSummary,
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
  canManageRoomBoard,
  deriveTaskTitle,
  visibleBoardGroups,
} from "../src/components/desktop/content/room-board/board-presentation";
import { findLocalRoomWorker } from "../src/components/desktop/content/room-board/board-workers";
import { useRoomBoardPresentation } from "../src/components/desktop/content/room-board/useRoomBoardPresentation";
import {
  activeBoardManagerAgents,
  denyIntentReason,
  liveManagerCandidates,
  managerCandidateName,
  managerCandidateRuntime,
  readableIntentBody,
} from "../src/components/desktop/content/room-board/governance-presentation";
import { reviewAssignmentCandidates } from "../src/components/desktop/content/room-board/review-candidates";
import { useBoardGovernance } from "../src/components/desktop/content/room-board/useBoardGovernance";
import { useRoomBoardController } from "../src/components/desktop/content/room-board/useRoomBoardController";
import {
  useGovernanceDenyForm,
  type DenyFormFocusTarget,
} from "../src/components/desktop/content/room-board/useGovernanceDenyForm";
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
let GovernanceManagerSection: object;
let GovernanceIntentSection: object;
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
  GovernanceManagerSection = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-board/RoomBoardGovernanceManagerSection.vue")).default;
  GovernanceIntentSection = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-board/RoomBoardGovernanceIntentSection.vue")).default;
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
    assert.equal((html.match(/class="[^"]*\bdesktop-select-caret\b[^"]*"/g) || []).length, 3);
    assert.equal((html.match(/class="[^"]*\bsr-only\b[^"]*"[^>]*>(?:Filter by owner|Filter by status|Sort tasks)</g) || []).length, 3);
    assert.match(html, /value="label:Alex"/);
    assert.match(html, /value="unassigned"/);
    assert.match(html, /value="oldest"[^>]*>Oldest first/);
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

describe("board manager panel", () => {
  const casey = presence({ agentSessionId: "session_casey", actorLabel: "Casey | Cursor", displayName: "Casey" });
  const blake = presence();
  const avery = presence({ agentSessionId: "session_avery", actorLabel: "Avery | Claude", displayName: "Avery" });

  it("keeps live candidates in a stable order across presence refreshes", () => {
    const names = (liveAgents: DesktopAgentPresence[], snapshot = governance()) =>
      liveManagerCandidates(snapshot, liveAgents).map(managerCandidateName);
    assert.deepEqual(names([casey, blake, avery]), ["Avery", "Blake", "Casey"]);
    assert.deepEqual(names([blake, avery, casey]), ["Avery", "Blake", "Casey"]);
    // Assigning a manager marks the row as Current without moving it.
    const managed = governance({ activeManager: activeManager("session_casey") });
    assert.deepEqual(names([avery, casey, blake], managed), ["Avery", "Blake", "Casey"]);
    assert.deepEqual(
      liveManagerCandidates(managed, [blake, avery, casey]).map((candidate) => candidate.isActiveManager),
      [false, false, true],
    );
  });

  it("keeps the primary action in place when a manager is assigned", async () => {
    const render = (snapshot: DesktopBoardGovernanceSnapshot, selectedCandidateId: string | null) => renderToString(createSSRApp({
      render: () => h(GovernanceManagerSection, {
        governance: snapshot, busy: false, selectedCandidateId, liveAgents: [blake, casey],
      }),
    }));
    const actions = (html: string) => [...html.matchAll(/data-testid="board-governance-(promote|release)"/g)].map((match) => match[1]);
    const before = await render(governance(), "session_blake");
    assert.deepEqual(actions(before), ["promote"]);
    assert.match(before, />\s*Make manager\s*</);
    const after = await render(governance({ activeManager: activeManager("session_blake") }), "session_blake");
    // The primary stays last (rightmost), so a second click lands on the
    // disabled "Current manager" button instead of the new Release button.
    assert.deepEqual(actions(after), ["release", "promote"]);
    assert.match(after, /<button[^>]*disabled[^>]*data-testid="board-governance-promote"[^>]*>\s*Current manager\s*</);
  });

  it("offers an optional reason when a request is denied", async () => {
    assert.equal(denyIntentReason("  Duplicate of task_2.  "), "Duplicate of task_2.");
    assert.equal(denyIntentReason("   "), null);
    const html = await renderToString(createSSRApp({
      render: () => h(GovernanceIntentSection, {
        governance: governance({ pendingIntents: [intent({ id: "intent_close", actionType: "task_close", taskId: "task_2" })] }),
        busy: false,
      }),
    }));
    assert.match(html, /data-testid="board-governance-deny"[^>]*>\s*Deny\s*</);
    assert.doesNotMatch(html, /board-governance-deny-reason/, "the reason field opens only when asked");
  });

  it("runs the deny form: open, keep each reason, submit once, close and move focus when the request leaves", () => {
    const intents = ref([
      intent({ id: "intent_a", actionType: "task_close", taskId: "task_1" }),
      intent({ id: "intent_b", actionType: "task_claim", taskId: "task_2" }),
      intent({ id: "intent_c", actionType: "task_claim", taskId: "task_3" }),
    ]);
    const busy = ref(false);
    const denied: Array<[string, string | null]> = [];
    const focused: DenyFormFocusTarget[] = [];
    const form = useGovernanceDenyForm({
      intents: () => intents.value,
      busy: () => busy.value,
      deny: (intentId, reason) => denied.push([intentId, reason]),
      focus: (target) => focused.push(target),
    });

    form.start("intent_a");
    assert.equal(form.denyingIntentId.value, "intent_a");
    assert.deepEqual(focused.at(-1), { kind: "reason", intentId: "intent_a" });
    form.reason.value = "Already merged.";
    // Opening another request's form keeps the first reason for later.
    form.start("intent_b");
    assert.equal(form.reason.value, "");
    form.start("intent_a");
    assert.equal(form.reason.value, "Already merged.");

    form.submit();
    busy.value = true;
    form.submit();
    form.cancel();
    assert.deepEqual(denied, [["intent_a", "Already merged."]], "one request while busy; Cancel waits");
    assert.equal(form.denyingIntentId.value, "intent_a", "the form stays open while the denial is in flight");

    // A failed denial keeps the typed reason for a retry.
    busy.value = false;
    intents.value = [...intents.value];
    assert.equal(form.reason.value, "Already merged.");

    form.submit();
    intents.value = intents.value.filter((candidate) => candidate.id !== "intent_a");
    assert.equal(form.denyingIntentId.value, null);
    assert.deepEqual(focused.at(-1), { kind: "request", intentId: "intent_b" }, "focus moves to the next request");

    form.start("intent_c");
    form.submit();
    intents.value = intents.value.filter((candidate) => candidate.id !== "intent_c");
    assert.deepEqual(focused.at(-1), { kind: "request", intentId: "intent_b" }, "the last request falls back to the one before it");

    form.start("intent_b");
    form.reason.value = "Not needed.";
    form.cancel();
    assert.deepEqual(focused.at(-1), { kind: "deny", intentId: "intent_b" });
    form.start("intent_b");
    assert.equal(form.reason.value, "", "Cancel discards the reason");
    form.submit();
    intents.value = [];
    assert.deepEqual(focused.at(-1), { kind: "list" });
    assert.deepEqual(denied.at(-1), ["intent_b", null]);
  });

  it("sends the deny reason to the board", async () => {
    const decisions: unknown[] = [];
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        letagentsDesktop: {
          room: {
            decideBoardIntent: async (_room: string, intentId: string, input: unknown) => {
              decisions.push({ intentId, input });
              return { governance: governance() };
            },
          },
        },
      },
    });
    try {
      const board = useBoardGovernance("room_1");
      assert.equal(await board.decideIntent("intent_a", "deny", "Already merged."), true);
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else delete (globalThis as { window?: unknown }).window;
    }
    assert.deepEqual(decisions, [{ intentId: "intent_a", input: { decision: "deny", reason: "Already merged." } }]);
  });
});

describe("board toolbar count", () => {
  const renderToolbar = (pendingIntentCount: number) => renderToString(createSSRApp({
    render: () => h(Toolbar, {
      searchQuery: "", activeFilter: "open", filterOptions: [], busy: false,
      managerMode: "manager_optional", managerTitle: "Manager optional", pendingIntentCount, governanceOpen: false,
      ownerFilter: "all", ownerOptions: boardOwnerOptions([]), statusFilter: "all", statusOptions: boardStatusOptions(), sort: "recent",
    }),
  }));

  for (const decision of ["approve", "deny"] as const) {
    it(`drops the Manager badge when the owner ${decision === "approve" ? "approves" : "denies"} the only request`, async () => {
      // Stands in for the room snapshot, which the parent refreshes later.
      const roomSettings = ref<DesktopBoardSettingsSummary | null>({
        managerMode: "manager_optional", activeManager: null, pendingIntentCount: 1,
      });
      const pending = intent({ id: "intent_a", actionType: "task_claim", taskId: "task_1" });
      const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          letagentsDesktop: {
            room: {
              getBoardGovernance: async () => governance({ pendingIntents: [pending], pendingIntentCount: 1 }),
              decideBoardIntent: async () => ({ governance: governance({ pendingIntentCount: 0 }) }),
            },
          },
        },
      });
      try {
        const board = useBoardGovernance("room_1", () => roomSettings.value);
        await board.openGovernance();
        assert.equal(board.pendingIntentCount.value, 1);
        assert.match(await renderToolbar(board.pendingIntentCount.value), /desktop-board-manager-pending-count/);

        assert.equal(await board.decideIntent("intent_a", decision), true);
        assert.equal(roomSettings.value?.pendingIntentCount, 1, "the room snapshot has not refreshed yet");
        assert.equal(board.pendingIntentCount.value, 0, "the toolbar uses the count from the decision");
        assert.doesNotMatch(await renderToolbar(board.pendingIntentCount.value), /desktop-board-manager-pending-count/);

        roomSettings.value = { managerMode: "manager_optional", activeManager: null, pendingIntentCount: 2 };
        assert.equal(board.pendingIntentCount.value, 2, "a newer room snapshot is the source again");
      } finally {
        if (previous) Object.defineProperty(globalThis, "window", previous);
        else delete (globalThis as { window?: unknown }).window;
      }
    });
  }

  it("feeds the toolbar from the board manager count in the board view", () => {
    const view = readFileSync(fileURLToPath(new URL(
      "../src/components/desktop/content/RoomBoardView.vue",
      import.meta.url,
    )), "utf8");
    assert.match(view, /useBoardGovernance\(props\.roomIdentifier, \(\) => props\.boardSettings\)/);
    assert.match(view, /:pending-intent-count="pendingIntentCount"/);
  });
});

describe("board task actions", () => {
  it("lets the owner release each reviewer's lease by name, including one a recovered agent left behind", async () => {
    const reviewed = task({
      status: "in_review",
      activeLeases: [
        lease({ id: "lease_work", kind: "work", agentKey: "owner/lunar-amber", agentSessionId: "session_lunar", holderLabel: "LunarAmber | Owner's agent | Open Model" }),
        lease({ id: "lease_review_retired", kind: "review", agentKey: "owner/field-trail", agentSessionId: "session_retired", holderLabel: "FieldTrail | Owner's agent | Cursor" }),
        lease({ id: "lease_review_harbor", kind: "review", agentKey: "owner/harbor-marsh", agentSessionId: "session_harbor", holderLabel: "HarborMarsh | Owner's agent | Codex" }),
      ],
    });
    const board = useRoomBoardController({ roomIdentifier: "room_1", tasks: [reviewed], presence: [], workers: [], canEditTasks: true }, () => undefined);
    const releases = board.actionsFor(reviewed).filter((action) => action.id.startsWith("release-review"));
    assert.deepEqual(releases.map((action) => action.label), ["Release FieldTrail's review", "Release HarborMarsh's review"]);
    assert.ok(board.actionsFor(reviewed).some((action) => action.id === "release-work"));

    const released: unknown[] = [];
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        letagentsDesktop: {
          room: {
            updateTaskReviewLease: async (room: string, taskId: string, input: { action: string; lease_id: string }) => {
              released.push({ room, taskId, action: input.action, leaseId: input.lease_id });
              return { task: reviewed };
            },
          },
        },
      },
    });
    try {
      await board.runTaskAction(reviewed, releases[0]!);
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else delete (globalThis as { window?: unknown }).window;
    }
    assert.equal(board.errorMessage.value, null);
    assert.deepEqual(released, [{ room: "room_1", taskId: "task_1", action: "release", leaseId: "lease_review_retired" }]);
  });

  it("offers someone who is not a room admin only the release of their own worker's review", () => {
    const reviewed = task({
      status: "in_review",
      activeLeases: [
        lease({ id: "lease_work", kind: "work", agentKey: "owner/lunar-amber", agentSessionId: "session_lunar", holderLabel: "LunarAmber" }),
        lease({ id: "lease_review_blake", kind: "review", agentKey: "codex/blake", agentSessionId: "session_blake", holderLabel: "Blake | Codex" }),
        lease({ id: "lease_review_harbor", kind: "review", agentKey: "owner/harbor-marsh", agentSessionId: "session_harbor", holderLabel: "HarborMarsh" }),
      ],
    });
    const releases = (workers: WorkerSnapshot[]) => useRoomBoardController(
      { roomIdentifier: "room_1", tasks: [reviewed], presence: [], workers, canEditTasks: false }, () => undefined,
    ).actionsFor(reviewed).filter((action) => action.id.startsWith("release-")).map((action) => action.id);
    assert.deepEqual(releases([]), []);
    assert.deepEqual(releases([worker()]), ["release-review:lease_review_blake"]);
  });

  it("lets the owner of a local room manage its board, as a room admin does", () => {
    assert.equal(canManageRoomBoard("admin"), true);
    assert.equal(canManageRoomBoard("local"), true);
    for (const role of ["participant", "anonymous", null, undefined]) assert.equal(canManageRoomBoard(role), false);
    const held = task({ status: "in_review", activeLeases: [
      lease({ id: "lease_work", kind: "work", agentKey: "local/agent", holderLabel: "Local agent" }),
      lease({ id: "lease_review", kind: "review", agentKey: "local/reviewer", holderLabel: "Reviewer" }),
    ] });
    const board = useRoomBoardController({ roomIdentifier: "local_room", tasks: [held], presence: [], workers: [],
      canEditTasks: canManageRoomBoard("local") }, () => undefined);
    assert.deepEqual(board.actionsFor(held).filter((action) => action.id.startsWith("release-")).map((action) => action.id),
      ["release-work", "release-review:lease_review"]);
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
    assert.equal(state.label, "Different agent is working");
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

  it("shows only the stages that hold cards in focused views, so review cards stay on screen", () => {
    const tasks = [
      task({ id: "task_review", status: "in_review" }),
      task({ id: "task_blocked", status: "blocked" }),
      task({ id: "task_unclaimed" }),
    ];
    const statuses = (filter: "open" | "needs-review" | "unclaimed" | "closeout") => visibleBoardGroups({
      tasks, filter, searchQuery: "", localWorker: null,
    }).map((group) => group.status);

    // Blocked work needs a follow-up review too; the four empty stages before it are gone.
    assert.deepEqual(statuses("needs-review"), ["blocked", "in_review"]);
    assert.deepEqual(statuses("unclaimed"), ["accepted"]);
    // The full lifecycle views keep every stage as a drop target.
    assert.deepEqual(statuses("open"), TASK_STATUS_ORDER.slice(0, 6));
    assert.deepEqual(statuses("closeout"), TASK_STATUS_ORDER.slice(6));
  });

  it("keeps an empty stage in a focused view when one of its cards can be dragged there", () => {
    const accepted = task({ id: "task_accepted" });
    const assigned = task({ id: "task_assigned", status: "assigned", assigneeAgentKey: "codex/blake" });
    const statuses = (filter: "unclaimed" | "mine", tasks: DesktopTaskSummary[]) => visibleBoardGroups({
      tasks, filter, searchQuery: "", localWorker: worker(),
      dropTargets: (candidate) => candidate.status === "accepted" ? ["assigned"]
        : candidate.status === "assigned" ? ["in_progress", "blocked"] : [],
    }).map((group) => group.status);
    // Claiming drags an Unclaimed card onto Assigned, which Unclaimed never holds.
    assert.deepEqual(statuses("unclaimed", [accepted]), ["accepted", "assigned"]);
    assert.deepEqual(statuses("mine", [assigned]).sort(), ["assigned", "blocked", "in_progress"]);
  });

  it("the board view gives focused views the drop targets of each card's actions", () => {
    const view = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/RoomBoardView.vue", import.meta.url)), "utf8");
    assert.match(view, /useRoomBoardPresentation\(props, emit, \{\s*dropTargets: \(task\) => actionsFor\(task\)\.flatMap\(\(action\) => action\.targetStatus/);
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
    // Approving this lets the worker reopen or accept the task itself.
    assert.equal(readableIntentBody(intent({
      actionType: "task_override",
      taskId: "task_9",
      payload: { task_id: "task_9", status: "accepted" },
    })), "Move task_9 to accepted");
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

function governance(
  overrides: Partial<DesktopBoardGovernanceSnapshot> = {}
): DesktopBoardGovernanceSnapshot {
  return {
    roomId: "room_1",
    managerMode: "manager_optional",
    activeManager: null,
    candidates: [],
    pendingIntents: [],
    pendingIntentCount: 0,
    audit: [],
    warnings: [],
    capabilities: {
      canViewGovernance: true,
      canAssignManager: true,
      canReleaseManager: true,
      canSetManagerMode: true,
      canDecideIntents: true,
    },
    ...overrides,
  };
}

function activeManager(agentSessionId: string): NonNullable<DesktopBoardGovernanceSnapshot["activeManager"]> {
  return {
    assignmentId: `assignment_${agentSessionId}`,
    agentSessionId,
    agentKey: `agent/${agentSessionId}`,
    actorLabel: agentSessionId,
    runtimeSource: "desktop_managed",
    assignedBy: "EmmyMay",
    lastHeartbeatAt: null,
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
