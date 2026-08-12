import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computed, ref, type Ref } from "vue";

import type {
  DesktopRoomLiveMetadata,
  DesktopRoomSnapshot,
  WorkerSnapshot,
} from "../../electron/ipc-types";
import { useDesktopRoomLiveSync } from "../src/composables/useDesktopRoomLiveSync";

const ROOM = "room_live";

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

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.runInterval();
    });

    // Hidden window: no metadata IPC, no workers refresh, snapshot untouched.
    assert.deepEqual(harness.getLiveMetadataRequests, []);
    assert.equal(harness.workersListCalls, 0);
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
      // …then the window returns to the foreground and App.vue calls the
      // exposed refresh directly for an immediate metadata-only catch-up.
      harness.documentHidden = false;
      await harness.sync.refreshSelectedRoomLiveMetadata();
      await harness.settle();
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

  it("does not recreate the interval when synced again for the same room", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.sync.syncSelectedRoomStream(ROOM);
    });

    assert.equal(harness.setIntervalCalls, 1);
    assert.equal(harness.clearIntervalCalls, 0);
  });

  it("skips the tick entirely when the live bridge lacks getLiveMetadata", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = snapshotWithEventData();
    // Simulate a stale live bridge whose preload predates the metadata binding.
    delete (harness.windowBridge.letagentsDesktop.room as { getLiveMetadata?: unknown }).getLiveMetadata;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.runInterval();
    });

    // No metadata call, no full-snapshot fallback, no workers refresh — the
    // tick is a clean no-op instead of a swallowed throw inside the interval.
    assert.deepEqual(harness.getLiveMetadataRequests, []);
    assert.deepEqual(harness.getSnapshotRequests, []);
    assert.equal(harness.workersListCalls, 0);
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

function createHarness() {
  const currentRoomId = ref<string | null>(null);
  const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
  const rootRoomSnapshot = ref<DesktopRoomSnapshot | null>(null);
  const workers = ref<WorkerSnapshot[]>([]);

  const getSnapshotRequests: Array<string | null> = [];
  const getLiveMetadataRequests: string[] = [];
  let workersListCalls = 0;
  let stopStreamCalls = 0;
  let setIntervalCalls = 0;
  let clearIntervalCalls = 0;
  let intervalCallback: (() => void) | null = null;
  let timeoutCallback: (() => void) | null = null;
  let documentHidden = false;

  const state = {
    nextMetadata: Promise.resolve(liveMetadata()) as Promise<DesktopRoomLiveMetadata>,
  };

  const sync = useDesktopRoomLiveSync({
    rootRoomSnapshot,
    selectedRoomIdentifier: computed(() => currentRoomId.value),
    selectedSnapshot,
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
    currentRoomId,
    selectedSnapshot,
    rootRoomSnapshot,
    windowBridge,
    getSnapshotRequests,
    getLiveMetadataRequests,
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
