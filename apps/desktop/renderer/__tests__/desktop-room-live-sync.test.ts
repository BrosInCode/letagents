import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computed, ref, type Ref } from "vue";

import type {
  DesktopRoomLiveMetadata,
  DesktopRoomAgentWork,
  DesktopRoomAgentWorkPollResult,
  DesktopRoomSnapshot,
  WorkerSnapshot,
} from "../../electron/ipc-types";
import { useDesktopRoomLiveSync } from "../src/composables/useDesktopRoomLiveSync";

const ROOM = "room_live";
const WORK_CURSOR = `rw1.${"a".repeat(64)}.${"b".repeat(64)}`;

describe("useDesktopRoomLiveSync periodic metadata tick", () => {
  it("fetches only poll-only metadata on a tick and preserves event-fed sections", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = snapshotWithEventData();

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.runInterval();
    });

    // The periodic tick hits the metadata IPC — never the full snapshot IPC.
    assert.deepEqual(harness.getLiveMetadataRequests, [ROOM]);
    assert.deepEqual(harness.getSnapshotRequests, []);
    // Poll-only sections are refreshed…
    assert.deepEqual(
      harness.selectedSnapshot.value?.participants.map((p) => (p as { participantKey: string }).participantKey),
      ["fresh"],
    );
    // …while event-fed sections are left exactly as they were.
    assert.deepEqual(harness.selectedSnapshot.value?.messages.map((m) => m.id), ["msg_1"]);
    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((t) => t.id), ["task_1"]);
  });

  it("skips overlapping ticks while a previous refresh is still in flight", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = snapshotWithEventData();
    const gate = deferred<DesktopRoomLiveMetadata>();
    harness.nextMetadata = gate.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      // Two ticks fire before the first resolves — the second must be skipped.
      await harness.tickOnce();
      await harness.tickOnce();
      assert.deepEqual(harness.getLiveMetadataRequests, [ROOM]);
      gate.resolve(liveMetadata());
      await harness.settle();
      // A later tick runs normally once the in-flight one settled.
      await harness.tickOnce();
    });

    assert.deepEqual(harness.getLiveMetadataRequests, [ROOM, ROOM]);
  });

  it("skips the tick entirely while the document is hidden", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = snapshotWithEventData();
    harness.documentHidden = true;
    let retainedWorkRequestsAfterStart = 0;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
      retainedWorkRequestsAfterStart = harness.pollAgentWorkRequests.length;
      await harness.runInterval();
    });

    // Hidden window: no metadata IPC, no workers refresh, snapshot untouched.
    assert.deepEqual(harness.getLiveMetadataRequests, []);
    assert.equal(harness.workersListCalls, 0);
    assert.equal(harness.pollAgentWorkRequests.length, retainedWorkRequestsAfterStart);
    assert.deepEqual(harness.selectedSnapshot.value?.participants, []);
  });

  it("catches up with a poll-only metadata refresh when called on foreground return", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = snapshotWithEventData();
    harness.documentHidden = true;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      // Hidden ticks are no-ops…
      await harness.runInterval();
      assert.deepEqual(harness.getLiveMetadataRequests, []);
      const retainedWorkRequestsWhileHidden = harness.pollAgentWorkRequests.length;
      // …then the window returns to the foreground and App.vue calls the
      // exposed refresh directly for an immediate bounded catch-up.
      harness.documentHidden = false;
      await harness.sync.refreshSelectedRoomLiveMetadata();
      await harness.settle();
      assert.ok(harness.pollAgentWorkRequests.length > retainedWorkRequestsWhileHidden);
    });

    assert.deepEqual(harness.getLiveMetadataRequests, [ROOM]);
    assert.deepEqual(harness.getSnapshotRequests, []);
    assert.deepEqual(
      harness.selectedSnapshot.value?.participants.map((p) => (p as { participantKey: string }).participantKey),
      ["fresh"],
    );
    // Event-fed sections are still left untouched by the catch-up.
    assert.deepEqual(harness.selectedSnapshot.value?.messages.map((m) => m.id), ["msg_1"]);
  });

  it("does not recreate the interval or repoll retained work when synced again for the same room", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
    });

    assert.equal(harness.setIntervalCalls, 1);
    assert.equal(harness.clearIntervalCalls, 0);
    assert.deepEqual(harness.pollAgentWorkRequests, [{ roomIdentifier: ROOM, cursor: null }]);
  });

  it("keeps retained-work refresh independent when the bridge lacks getLiveMetadata", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = snapshotWithEventData();
    // Simulate a stale live bridge whose preload predates the metadata binding.
    delete (harness.windowBridge.letagentsDesktop.room as { getLiveMetadata?: unknown }).getLiveMetadata;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.runInterval();
    });

    // No metadata call, no full-snapshot fallback, and no partial workers
    // refresh. The independently negotiated retained-work resource still runs.
    assert.deepEqual(harness.getLiveMetadataRequests, []);
    assert.deepEqual(harness.getSnapshotRequests, []);
    assert.equal(harness.workersListCalls, 0);
    assert.ok(harness.pollAgentWorkRequests.length >= 1);
    assert.equal(harness.sync.roomAgentWorkStatus.value, "ready");
    // Snapshot is untouched.
    assert.deepEqual(harness.selectedSnapshot.value?.participants, []);
    assert.deepEqual(harness.selectedSnapshot.value?.messages.map((m) => m.id), ["msg_1"]);
  });

  it("stops the interval on room deselect", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.sync.syncSelectedRoomStream(null);
    });

    assert.equal(harness.clearIntervalCalls, 1);
    assert.equal(harness.stopStreamCalls, 1);
  });
});

describe("useDesktopRoomLiveSync retained room work", () => {
  it("replaces changed snapshots and retains them across unchanged cursors", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
      assert.deepEqual(harness.sync.roomAgentWork.value.map((work) => work.agentKey), ["emmy/garden-point"]);
      assert.equal(harness.sync.roomAgentWorkStatus.value, "ready");

      harness.nextAgentWork = Promise.resolve(unchangedRoomAgentWork(
        `rw1.${"c".repeat(64)}.${"d".repeat(64)}`,
      ));
      await harness.sync.refreshSelectedRoomLiveMetadata();
    });

    assert.deepEqual(harness.sync.roomAgentWork.value.map((work) => work.agentKey), ["emmy/garden-point"]);
    assert.equal(harness.sync.roomAgentWorkStatus.value, "ready");
    assert.deepEqual(harness.pollAgentWorkRequests, [
      { roomIdentifier: ROOM, cursor: null },
      { roomIdentifier: ROOM, cursor: WORK_CURSOR },
    ]);
  });

  it("keeps one retained-work request in flight per room context", async () => {
    const harness = createHarness();
    const gate = deferred<DesktopRoomAgentWorkPollResult>();
    harness.nextAgentWork = gate.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
      const refreshes = [
        harness.sync.refreshSelectedRoomLiveMetadata(),
        harness.sync.refreshSelectedRoomLiveMetadata(),
      ];
      await harness.settle();
      assert.equal(harness.pollAgentWorkRequests.length, 1);
      gate.resolve(changedRoomAgentWork());
      await Promise.all(refreshes);
    });

    assert.equal(harness.sync.roomAgentWorkStatus.value, "ready");
  });

  it("discards responses after room, account, or session identity changes", async () => {
    const cases: Array<(harness: ReturnType<typeof createHarness>) => void> = [
      (harness) => { harness.currentRoomId.value = "room_other"; },
      (harness) => { harness.accountId.value = "account_2"; },
      (harness) => { harness.sessionGeneration.value += 1; },
    ];

    for (const mutate of cases) {
      const harness = createHarness();
      const gate = deferred<DesktopRoomAgentWorkPollResult>();
      harness.nextAgentWork = gate.promise;
      await withDesktopBridge(harness.windowBridge, async () => {
        await harness.sync.syncSelectedRoomStream(ROOM);
        await harness.settle();
        mutate(harness);
        gate.resolve(changedRoomAgentWork());
        await harness.settle();
      });
      assert.deepEqual(harness.sync.roomAgentWork.value, []);
      assert.equal(harness.sync.roomAgentWorkStatus.value, "idle");
    }
  });

  it("clears authority or payload failures instead of showing cross-context stale data", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
      harness.nextAgentWork = Promise.resolve({ status: "access_revoked", response: null });
      await harness.sync.refreshSelectedRoomLiveMetadata();
      assert.deepEqual(harness.sync.roomAgentWork.value, []);
      assert.equal(harness.sync.roomAgentWorkStatus.value, "unavailable");

      harness.nextAgentWork = Promise.resolve({ status: "invalid", response: null });
      await harness.sync.refreshSelectedRoomLiveMetadata();
    });

    assert.deepEqual(harness.sync.roomAgentWork.value, []);
    assert.equal(harness.sync.roomAgentWorkStatus.value, "error");
  });

  it("preserves the last complete replacement only for transient failures", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
      harness.nextAgentWork = Promise.reject(new Error("offline"));
      await harness.sync.refreshSelectedRoomLiveMetadata();
    });

    assert.deepEqual(harness.sync.roomAgentWork.value.map((work) => work.agentKey), ["emmy/garden-point"]);
    assert.equal(harness.sync.roomAgentWorkStatus.value, "stale");
  });

  it("degrades cleanly when a stale preload lacks the optional binding", async () => {
    const harness = createHarness();
    delete (harness.windowBridge.letagentsDesktop.room as { pollAgentWork?: unknown }).pollAgentWork;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
    });

    assert.deepEqual(harness.pollAgentWorkRequests, []);
    assert.deepEqual(harness.sync.roomAgentWork.value, []);
    assert.equal(harness.sync.roomAgentWorkStatus.value, "unavailable");
  });
});

describe("useDesktopRoomLiveSync full-refresh path", () => {
  it("scheduleLiveMetadataRefresh still triggers a FULL snapshot fetch", async () => {
    const harness = createHarness();
    harness.currentRoomId.value = ROOM;

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
    });

    // The debounced one-shot fetches the full snapshot, not the metadata slice.
    assert.deepEqual(harness.getSnapshotRequests, [ROOM]);
    assert.deepEqual(harness.getLiveMetadataRequests, []);
  });
});

function snapshotWithEventData(): DesktopRoomSnapshot {
  return {
    ...baseSnapshot(),
    messages: [
      {
        id: "msg_1",
        sender: "EmmyMay",
        text: "hello",
        attachments: [],
        agentPromptKind: null,
        source: "browser",
        timestamp: "2026-07-01T00:00:00.000Z",
        actorLabel: null,
        agentIdentity: null,
        threadRootId: "msg_1",
        threadReplyToId: null,
        thread: null,
        replyTo: null,
      },
    ],
    tasks: [{ id: "task_1" }] as unknown as DesktopRoomSnapshot["tasks"],
  };
}

function baseSnapshot(): DesktopRoomSnapshot {
  const ready = () => ({ status: "ready" as const, error: null });
  return {
    roomIdentifier: ROOM,
    access: {
      status: "ready",
      title: "",
      message: "",
      roomIdentifier: ROOM,
      deviceFlowUrl: null,
      code: null,
      httpStatus: null,
    },
    room: {
      identifier: ROOM,
      code: "",
      name: ROOM,
      displayName: ROOM,
      role: "admin",
      authenticated: true,
      kind: "main",
      parentRoomId: null,
      focusKey: null,
      sourceTaskId: null,
      focusStatus: null,
      focusParentVisibility: null,
      focusActivityScope: null,
      focusGitHubEventRouting: null,
      focusSettings: null,
      focusArchivedAt: null,
      concludedAt: null,
      conclusionSummary: null,
      conclusionDetails: null,
      gitRoom: null,
    },
    storage: {
      roomIdentifier: ROOM,
      defaultMode: "cloud",
      overrideMode: "inherit",
      effectiveMode: "cloud",
      isLocalRoom: false,
      localRoom: null,
      databasePath: "",
      localFilesPath: "",
    },
    focusRooms: [],
    tasks: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    reasoningSessions: [],
    recentActivity: [],
    roomArtifacts: [],
    messages: [],
    githubEvents: null,
    boardSettings: { managerMode: "manager_optional", activeManager: null, pendingIntentCount: 0 },
    sourceStates: {
      focusRooms: ready(),
      tasks: ready(),
      participants: ready(),
      presence: ready(),
      reasoning: ready(),
      activityHistory: ready(),
      roomArtifacts: ready(),
      boardSettings: ready(),
      messages: ready(),
      githubEvents: ready(),
    },
  };
}

function liveMetadata(): DesktopRoomLiveMetadata {
  const ready = () => ({ status: "ready" as const, error: null });
  return {
    roomIdentifier: ROOM,
    focusRooms: [],
    participants: [{ participantKey: "fresh" }] as unknown as DesktopRoomLiveMetadata["participants"],
    participantHiddenCount: 0,
    presence: [],
    recentActivity: [],
    boardSettings: { managerMode: "manager_optional", activeManager: null, pendingIntentCount: 0 },
    sourceStates: {
      focusRooms: ready(),
      participants: ready(),
      presence: ready(),
      activityHistory: ready(),
      boardSettings: ready(),
    },
  };
}

function roomAgentWork(agentKey = "emmy/garden-point"): DesktopRoomAgentWork {
  return {
    attemptId: "123e4567-e89b-42d3-a456-426614174000",
    roomId: ROOM,
    sourceMessageId: "msg_7",
    agentKey,
    revision: 1,
    summary: {
      version: 1,
      recorded_state: "completed",
      evidence_incomplete: false,
      elapsed_ms: 1_250,
      operation_counts: {
        unresolved: 0,
        succeeded: 2,
        failed: 0,
        denied_before_start: 0,
        cancelled_before_start: 0,
        interrupted_after_start: 0,
        lost_after_start: 0,
      },
    },
    updatedAt: "2026-08-31T21:00:00.000Z",
  };
}

function changedRoomAgentWork(
  work: DesktopRoomAgentWork[] = [roomAgentWork()],
  cursor = WORK_CURSOR,
): DesktopRoomAgentWorkPollResult {
  return {
    status: "ready",
    response: {
      roomId: ROOM,
      cursor,
      changed: true,
      snapshot: { work, truncated: false },
    },
  };
}

function unchangedRoomAgentWork(cursor = WORK_CURSOR): DesktopRoomAgentWorkPollResult {
  return {
    status: "ready",
    response: { roomId: ROOM, cursor, changed: false, snapshot: null },
  };
}

function createHarness() {
  const accountId = ref<string | null>("account_1");
  const currentRoomId = ref<string | null>(null);
  const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
  const rootRoomSnapshot = ref<DesktopRoomSnapshot | null>(null);
  const sessionGeneration = ref(0);
  const workers = ref<WorkerSnapshot[]>([]);

  const getSnapshotRequests: Array<string | null> = [];
  const getLiveMetadataRequests: string[] = [];
  const pollAgentWorkRequests: Array<{ roomIdentifier: string; cursor: string | null }> = [];
  let workersListCalls = 0;
  let stopStreamCalls = 0;
  let setIntervalCalls = 0;
  let clearIntervalCalls = 0;
  let intervalCallback: (() => void) | null = null;
  let timeoutCallback: (() => void) | null = null;
  let documentHidden = false;

  const state = {
    nextMetadata: Promise.resolve(liveMetadata()) as Promise<DesktopRoomLiveMetadata>,
    nextAgentWork: Promise.resolve(changedRoomAgentWork()) as Promise<DesktopRoomAgentWorkPollResult>,
  };

  const sync = useDesktopRoomLiveSync({
    accountId: computed(() => accountId.value),
    rootRoomSnapshot,
    selectedRoomIdentifier: computed(() => currentRoomId.value),
    selectedSnapshot,
    sessionGeneration,
    workers,
  });

  const windowBridge = {
    // The composable reads visibility through `window.document?.hidden` so the
    // existing window-swap harness can drive it without an ambient jsdom.
    document: {
      get hidden(): boolean {
        return documentHidden;
      },
    },
    letagentsDesktop: {
      room: {
        getSnapshot: async (roomIdentifier: string | null): Promise<DesktopRoomSnapshot> => {
          getSnapshotRequests.push(roomIdentifier);
          return baseSnapshot();
        },
        getLiveMetadata: async (roomIdentifier: string): Promise<DesktopRoomLiveMetadata> => {
          getLiveMetadataRequests.push(roomIdentifier);
          return state.nextMetadata;
        },
        pollAgentWork: async (
          roomIdentifier: string,
          cursor: string | null,
        ): Promise<DesktopRoomAgentWorkPollResult> => {
          pollAgentWorkRequests.push({ roomIdentifier, cursor });
          return state.nextAgentWork;
        },
        startStream: async (roomIdentifier: string): Promise<void> => {
          currentRoomId.value = roomIdentifier;
        },
        stopStream: async (): Promise<void> => {
          stopStreamCalls += 1;
          currentRoomId.value = null;
        },
      },
      workers: {
        list: async (): Promise<WorkerSnapshot[]> => {
          workersListCalls += 1;
          return [];
        },
      },
    },
    setInterval: (callback: () => void) => {
      setIntervalCalls += 1;
      intervalCallback = callback;
      return setIntervalCalls;
    },
    clearInterval: () => {
      clearIntervalCalls += 1;
      intervalCallback = null;
    },
    setTimeout: (callback: () => void) => {
      timeoutCallback = callback;
      return 1;
    },
    clearTimeout: () => undefined,
  };

  return {
    sync,
    accountId,
    currentRoomId,
    selectedSnapshot,
    rootRoomSnapshot,
    windowBridge,
    getSnapshotRequests,
    getLiveMetadataRequests,
    pollAgentWorkRequests,
    sessionGeneration,
    get stopStreamCalls() {
      return stopStreamCalls;
    },
    get workersListCalls() {
      return workersListCalls;
    },
    get setIntervalCalls() {
      return setIntervalCalls;
    },
    get clearIntervalCalls() {
      return clearIntervalCalls;
    },
    set nextMetadata(value: Promise<DesktopRoomLiveMetadata>) {
      state.nextMetadata = value;
    },
    set nextAgentWork(value: Promise<DesktopRoomAgentWorkPollResult>) {
      state.nextAgentWork = value;
    },
    set documentHidden(value: boolean) {
      documentHidden = value;
    },
    /** Fire the captured interval callback and await its async body to settle. */
    runInterval: async () => {
      intervalCallback?.();
      await flush();
    },
    /** Fire the interval callback without waiting for the async body. */
    tickOnce: async () => {
      intervalCallback?.();
      await flush();
    },
    runTimeout: async () => {
      timeoutCallback?.();
      await flush();
    },
    settle: flush,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function withDesktopBridge<T>(value: object, callback: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value });
  try {
    return await callback();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}
