import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computed, ref, type Ref } from "vue";

import type {
  DesktopAccountRoomEntry,
  DesktopAccountRoomListOptions,
  DesktopAppInfo,
  DesktopAuthStatus,
  DesktopFocusRoomInfo,
  DesktopGitHubRoomEvent,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopReasoningSession,
  DesktopRepoRoomSelection,
  DesktopRoomInfo,
  DesktopRoomMessage,
  DesktopRoomDeliveryRepair,
  DesktopRoomSharedArtifact,
  DesktopRoomSnapshot,
  DesktopTaskSummary,
  DiagnosticsSnapshot,
  RepoStatus,
  WorkerSnapshot,
} from "../../electron/ipc-types";
import type { RoomEntry, SidebarEntry } from "../src/components/desktop/types";
import {
  buildRoomStreamDeliveryRepair,
  useDesktopAppData,
} from "../src/composables/useDesktopAppData";
import type { RecentRootRoom } from "../src/domain/sidebar-rooms";

it("builds managed-agent repairs only from authoritative snapshot deltas", () => {
  const existingTask = { ...taskSummary("task_1"), updatedAt: "2026-08-11T10:00:00.000Z" };
  const updatedTask = { ...existingTask, updatedAt: "2026-08-11T10:01:00.000Z" };
  const repair = buildRoomStreamDeliveryRepair(
    roomSnapshot("focus_a", {
      messages: [roomMessage("msg_1", "existing")],
      tasks: [existingTask],
    }),
    roomSnapshot("focus_a", {
      messages: [roomMessage("msg_1", "existing"), roomMessage("msg_2", "missed target")],
      tasks: [updatedTask, { ...taskSummary("task_2"), updatedAt: "2026-08-11T10:02:00.000Z" }],
    }),
  );
  assert.deepEqual(repair.messages.map((message) => message.id), ["msg_2"]);
  assert.deepEqual(repair.tasks.map((task) => task.id), ["task_1", "task_2"]);
});

describe("useDesktopAppData selected focus room snapshots", () => {
  it("shows an optimistic snapshot only for uncached focus room loads", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      const firstSnapshot = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = firstSnapshot.promise;

      const firstRefresh = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      assert.equal(harness.state.selectedSnapshotLoading.value, true);
      assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "focus_a");
      assert.deepEqual(harness.selectedSnapshot.value?.messages, []);

      firstSnapshot.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Cached focus message")],
      }));
      await firstRefresh;

      assert.equal(harness.state.selectedSnapshotLoading.value, false);
      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1"]);
    });
  });

  it("keeps cached focus messages visible while refreshing in the background", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Cached focus message")],
      }));
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      harness.activeEntry.value = parentEntry();
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      const backgroundSnapshot = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = backgroundSnapshot.promise;
      harness.activeEntry.value = focusEntry("focus_a", "Focus A");

      const backgroundRefresh = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();

      assert.equal(harness.state.selectedSnapshotLoading.value, false);
      assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "focus_a");
      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1"]);
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_a"]);

      backgroundSnapshot.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [
          roomMessage("msg_1", "Cached focus message"),
          roomMessage("msg_2", "Fresh focus message"),
        ],
      }));
      await backgroundRefresh;

      assert.equal(harness.state.selectedSnapshotLoading.value, false);
      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1", "msg_2"]);
    });
  });

  it("keeps independent cached snapshots for multiple focus rooms and updates them after sends", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Focus A")],
      }));
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      harness.state.handleMessageSent(roomMessage("msg_3", "Local send in Focus A"));

      harness.activeEntry.value = focusEntry("focus_b", "Focus B");
      harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("focus_b", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_2", "Focus B")],
      }));
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      const focusARefresh = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = focusARefresh.promise;
      harness.activeEntry.value = focusEntry("focus_a", "Focus A");
      const pendingFocusA = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1", "msg_3"]);
      assert.equal(harness.state.selectedSnapshotLoading.value, false);

      focusARefresh.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Focus A")],
      }));
      await pendingFocusA;

      const focusBRefresh = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = focusBRefresh.promise;
      harness.activeEntry.value = focusEntry("focus_b", "Focus B");
      const pendingFocusB = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_2"]);
      assert.equal(harness.state.selectedSnapshotLoading.value, false);

      focusBRefresh.resolve(roomSnapshot("focus_b", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [
          roomMessage("msg_2", "Focus B"),
          roomMessage("msg_4", "Fresh Focus B"),
        ],
      }));
      await pendingFocusB;

      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_2", "msg_4"]);
    });
  });

  it("keeps cache current when selectedSnapshot is updated outside the data composable", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Focus A")],
      }));
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      harness.selectedSnapshot.value = roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [
          roomMessage("msg_1", "Focus A"),
          roomMessage("msg_5", "Live metadata refresh"),
        ],
      });

      harness.activeEntry.value = parentEntry();
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      const focusARefresh = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = focusARefresh.promise;
      harness.activeEntry.value = focusEntry("focus_a", "Focus A");
      const pendingFocusA = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1", "msg_5"]);
      assert.equal(harness.state.selectedSnapshotLoading.value, false);

      focusARefresh.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [
          roomMessage("msg_1", "Focus A"),
          roomMessage("msg_5", "Live metadata refresh"),
        ],
      }));
      await pendingFocusA;
    });
  });

  it("drops a cached focus snapshot after an authoritative non-ready refresh", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_1", "Focus A")],
      }));
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      harness.activeEntry.value = parentEntry();
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      harness.nextSelectedSnapshot = Promise.resolve(nonReadySnapshot("focus_a", "forbidden"));
      harness.activeEntry.value = focusEntry("focus_a", "Focus A");
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      assert.equal(harness.selectedSnapshot.value?.access.status, "forbidden");

      harness.activeEntry.value = parentEntry();
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      const focusARefresh = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = focusARefresh.promise;
      harness.activeEntry.value = focusEntry("focus_a", "Focus A");
      const pendingFocusA = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);

      assert.equal(harness.state.selectedSnapshotLoading.value, true);
      assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "focus_a");
      assert.deepEqual(messageIds(harness.selectedSnapshot.value), []);

      focusARefresh.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        messages: [roomMessage("msg_2", "Focus A restored")],
      }));
      await pendingFocusA;
      assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_2"]);
    });
  });
});

describe("useDesktopAppData handleRoomStreamEvent refresh gating", () => {
  it("ignores transport open until the server establishes a sync boundary", () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot([roomMessage("msg_1", "Existing")]);

    harness.state.handleRoomStreamEvent({
      type: "open",
      roomIdentifier: "focus_a",
      checkpoint: "msg_1",
      gap: false,
      verified: false,
    });

    assert.deepEqual(harness.metadataRefreshCalls, []);
    assert.deepEqual(harness.getSnapshotRequests, []);
  });

  it("falls back to a full snapshot when the stream reports a cursor gap", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot([roomMessage("msg_9", "Stale")]);

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      harness.getSnapshotRequests.length = 0;
      harness.state.handleRoomStreamEvent({
        type: "open",
        roomIdentifier: "focus_a",
        checkpoint: "msg_4",
        gap: true,
        verified: false,
      });
      await flushAsync();
    });

    assert.deepEqual(harness.getSnapshotRequests, ["focus_a"]);
  });

  it("hands authoritative gap deltas back to managed-agent delivery once", async () => {
    const harness = createHarness();
    const priorTask = { ...taskSummary("task_1"), updatedAt: "2026-08-11T10:00:00.000Z" };
    harness.selectedSnapshot.value = roomSnapshot("focus_a", {
      kind: "focus",
      parentRoomId: "room_parent",
      messages: [roomMessage("msg_1", "Existing")],
      tasks: [priorTask],
    });
    const repairedSnapshot = roomSnapshot("focus_a", {
      kind: "focus",
      parentRoomId: "room_parent",
      messages: [
        roomMessage("msg_1", "Existing"),
        roomMessage("msg_2", "Missed target"),
      ],
      tasks: [
        { ...priorTask, updatedAt: "2026-08-11T10:01:00.000Z" },
        { ...taskSummary("task_2"), updatedAt: "2026-08-11T10:02:00.000Z" },
      ],
    });
    harness.nextSelectedSnapshot = Promise.resolve(harness.selectedSnapshot.value);

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      harness.deliveryRepairs.length = 0;
      harness.nextSelectedSnapshot = Promise.resolve(repairedSnapshot);
      harness.state.handleRoomStreamEvent({
        type: "open",
        roomIdentifier: "focus_a",
        checkpoint: "msg_2",
        gap: true,
        verified: true,
        deliveryRepairToken: 41,
      });
      await flushAsync();
      await flushAsync();
    });

    assert.equal(harness.deliveryRepairs.length, 1);
    assert.equal(harness.deliveryRepairs[0]?.roomIdentifier, "focus_a");
    assert.equal(harness.deliveryRepairs[0]?.repair.token, 41);
    assert.deepEqual(harness.deliveryRepairs[0]?.repair.messages.map((message) => message.id), ["msg_2"]);
    assert.deepEqual(harness.deliveryRepairs[0]?.repair.tasks.map((task) => task.id), ["task_1", "task_2"]);
  });

  it("retries a rejected managed-agent handoff with the same baseline and token", async () => {
    const harness = createHarness({ deliveryRepairRetryMs: 1 });
    harness.selectedSnapshot.value = focusSnapshot([roomMessage("msg_1", "Existing")]);
    harness.nextSelectedSnapshot = Promise.resolve(focusSnapshot([
      roomMessage("msg_1", "Existing"),
      roomMessage("msg_2", "Missed target"),
    ]));
    harness.deliveryRepairFailures = 1;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.state.syncSelectedRoomStream("focus_a");
      harness.state.handleRoomStreamEvent({
        type: "open",
        roomIdentifier: "focus_a",
        gap: true,
        verified: true,
        deliveryRepairToken: 42,
      });
      await waitForDesktop(() => harness.deliveryRepairs.length === 2);
    });

    assert.deepEqual(
      harness.deliveryRepairs.map(({ repair }) => ({
        token: repair.token,
        messages: repair.messages.map((message) => message.id),
      })),
      [
        { token: 42, messages: ["msg_2"] },
        { token: 42, messages: ["msg_2"] },
      ],
    );
  });

  it("retries a not-ready gap snapshot until its delivery sources recover", async () => {
    const harness = createHarness({ deliveryRepairRetryMs: 5 });
    harness.selectedSnapshot.value = focusSnapshot([roomMessage("msg_1", "Existing")]);
    const firstSnapshot = deferred<DesktopRoomSnapshot>();
    harness.nextSelectedSnapshot = firstSnapshot.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.state.syncSelectedRoomStream("focus_a");
      harness.state.handleRoomStreamEvent({
        type: "open",
        roomIdentifier: "focus_a",
        gap: true,
        verified: true,
        deliveryRepairToken: 43,
      });
      await waitForDesktop(() => harness.getSnapshotRequests.length === 1);
      firstSnapshot.resolve(nonReadySnapshot("focus_a", "unavailable"));
      harness.nextSelectedSnapshot = Promise.resolve(focusSnapshot([
        roomMessage("msg_1", "Existing"),
        roomMessage("msg_2", "Recovered target"),
      ]));
      await waitForDesktop(() => harness.deliveryRepairs.length === 1);
    });

    assert.equal(harness.deliveryRepairs[0]?.repair.token, 43);
    assert.deepEqual(
      harness.deliveryRepairs[0]?.repair.messages.map((message) => message.id),
      ["msg_2"],
    );
    assert.equal(harness.getSnapshotRequests.length, 2);
  });

  it("retries when the repair IPC appears after a same-room bridge upgrade", async () => {
    const harness = createHarness({ deliveryRepairRetryMs: 5 });
    harness.selectedSnapshot.value = focusSnapshot([roomMessage("msg_1", "Existing")]);
    harness.nextSelectedSnapshot = Promise.resolve(focusSnapshot([
      roomMessage("msg_1", "Existing"),
      roomMessage("msg_2", "Recovered target"),
    ]));
    harness.repairStreamDeliveryAvailable = false;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.state.syncSelectedRoomStream("focus_a");
      harness.state.handleRoomStreamEvent({
        type: "open",
        roomIdentifier: "focus_a",
        gap: true,
        verified: true,
        deliveryRepairToken: 44,
      });
      await waitForDesktop(() => messageIds(harness.selectedSnapshot.value).includes("msg_2"));
      harness.repairStreamDeliveryAvailable = true;
      await waitForDesktop(() => harness.deliveryRepairs.length === 1);
    });

    assert.equal(harness.deliveryRepairs[0]?.repair.token, 44);
    assert.equal(harness.getSnapshotRequests.length, 2);
  });

  it("cancels a pending delivery retry when the room stream stops", async () => {
    const harness = createHarness({ deliveryRepairRetryMs: 20 });
    harness.selectedSnapshot.value = focusSnapshot();
    harness.nextSelectedSnapshot = Promise.resolve(focusSnapshot([roomMessage("msg_2", "Missed")]));
    harness.deliveryRepairFailures = 1;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.state.syncSelectedRoomStream("focus_a");
      harness.state.handleRoomStreamEvent({
        type: "open",
        roomIdentifier: "focus_a",
        gap: true,
        verified: true,
        deliveryRepairToken: 45,
      });
      await waitForDesktop(() => harness.deliveryRepairs.length === 1);
      await harness.state.syncSelectedRoomStream(null);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    assert.equal(harness.deliveryRepairs.length, 1);
  });

  it("cancels a pending delivery retry when stream ownership moves rooms", async () => {
    const harness = createHarness({ deliveryRepairRetryMs: 20 });
    harness.selectedSnapshot.value = focusSnapshot();
    harness.nextSelectedSnapshot = Promise.resolve(focusSnapshot([roomMessage("msg_2", "Missed")]));
    harness.deliveryRepairFailures = 1;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.state.syncSelectedRoomStream("focus_a");
      harness.state.handleRoomStreamEvent({
        type: "open",
        roomIdentifier: "focus_a",
        gap: true,
        verified: true,
        deliveryRepairToken: 46,
      });
      await waitForDesktop(() => harness.deliveryRepairs.length === 1);
      await harness.state.syncSelectedRoomStream("focus_b");
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    assert.equal(harness.deliveryRepairs.length, 1);
  });

  it("replays non-message events that arrive while the verified snapshot is loading", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot();
    const pending = deferred<DesktopRoomSnapshot>();
    harness.nextSelectedSnapshot = pending.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const refresh = harness.state.refreshSelectedSnapshot();
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "task_update",
        roomIdentifier: "focus_a",
        task: taskSummary("task_during_snapshot"),
      });
      pending.resolve(focusSnapshot());
      await refresh;
    });

    assert.deepEqual(
      harness.selectedSnapshot.value?.tasks.map((task) => task.id),
      ["task_during_snapshot"],
    );
  });

  it("waits for stream readiness and buffers events even before a selected snapshot exists", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = null;
    const streamReady = deferred<void>();
    const snapshotReady = deferred<DesktopRoomSnapshot>();
    harness.nextStreamReady = streamReady.promise;
    harness.nextSelectedSnapshot = snapshotReady.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const refresh = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      assert.deepEqual(harness.getSnapshotRequests, []);
      harness.state.handleRoomStreamEvent({
        type: "task_update",
        roomIdentifier: "focus_a",
        task: taskSummary("task_before_snapshot"),
      });
      streamReady.resolve();
      await flushAsync();
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a"]);
      snapshotReady.resolve(focusSnapshot());
      await refresh;
    });

    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_before_snapshot"]);
  });

  it("releases an exact barrier when stream startup rejects", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot();
    harness.nextStreamReady = Promise.reject(new Error("stream unavailable"));

    await withDesktopBridge(harness.windowBridge, async () => {
      await assert.rejects(harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value), /stream unavailable/);
      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "focus_a", task: taskSummary("task_after_rejection"),
      });
    });

    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_after_rejection"]);
  });

  it("a stale startup rejection cannot release a newer room barrier", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = null;
    const roomAReady = deferred<void>();
    harness.nextStreamReady = roomAReady.promise;
    await withDesktopBridge(harness.windowBridge, async () => {
      const refreshA = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      const refreshARejection = assert.rejects(refreshA, /stale stream failure/);
      await flushAsync();

      const roomBReady = deferred<void>();
      const roomBSnapshot = deferred<DesktopRoomSnapshot>();
      harness.nextStreamReady = roomBReady.promise;
      harness.nextSelectedSnapshot = roomBSnapshot.promise;
      harness.activeEntry.value = focusEntry("focus_b", "Focus B");
      const refreshB = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "focus_b", task: taskSummary("task_b"),
      });

      roomAReady.reject(new Error("stale stream failure"));
      await refreshARejection;
      roomBReady.resolve();
      await flushAsync();
      roomBSnapshot.resolve(roomSnapshot("focus_b", { kind: "focus", parentRoomId: "room_parent" }));
      await refreshB;
    });

    assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "focus_b");
    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_b"]);
  });

  it("times out a hung snapshot, releases its buffer, and ignores late resolution", async () => {
    const harness = createHarness({ snapshotTimeoutMs: 5 });
    harness.selectedSnapshot.value = focusSnapshot();
    const hungSnapshot = deferred<DesktopRoomSnapshot>();
    harness.nextSelectedSnapshot = hungSnapshot.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const refresh = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "focus_a", task: taskSummary("task_during_timeout"),
      });
      await assert.rejects(refresh, /snapshot timed out/);
      assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_during_timeout"]);

      hungSnapshot.resolve(focusSnapshot());
      await flushAsync();
      assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_during_timeout"]);

      harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        tasks: [taskSummary("task_recovered")],
      }));
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
    });

    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_recovered"]);
  });

  it("bounds the full root refresh aggregate and releases buffered events", async () => {
    const harness = createHarness({ snapshotTimeoutMs: 5 });
    harness.activeEntry.value = parentEntry();
    harness.selectedSnapshot.value = roomSnapshot("room_parent");
    harness.nextSelectedSnapshot = Promise.resolve(roomSnapshot("room_parent"));
    const appInfo = deferred<DesktopAppInfo>();
    harness.nextAppInfo = appInfo.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const refresh = harness.state.refresh();
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "room_parent", task: taskSummary("task_during_root_timeout"),
      });
      await assert.rejects(refresh, /root room refresh snapshot timed out/);
      assert.deepEqual(
        harness.selectedSnapshot.value?.tasks.map((task) => task.id),
        ["task_during_root_timeout"],
      );

      appInfo.resolve({} as DesktopAppInfo);
      await flushAsync();
    });

    assert.deepEqual(
      harness.selectedSnapshot.value?.tasks.map((task) => task.id),
      ["task_during_root_timeout"],
    );
  });

  it("catches fire-and-forget refresh failures and releases the barrier", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot();
    harness.nextStreamReady = Promise.reject(new Error("refresh stream failed"));

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.state.handleRefreshRoom();
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "focus_a", task: taskSummary("task_after_scheduled_failure"),
      });
    });

    assert.deepEqual(
      harness.selectedSnapshot.value?.tasks.map((task) => task.id),
      ["task_after_scheduled_failure"],
    );
  });

  it("runs exactly one reconciliation when degraded startup later reaches verified SSE", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = null;
    const streamReady = deferred<void>();
    harness.nextStreamReady = streamReady.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const initial = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: true, verified: false,
      });
      streamReady.resolve();
      await initial;
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a"]);

      harness.nextSelectedSnapshot = Promise.resolve(focusSnapshot());
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: false, verified: true,
      });
      await flushAsync();
    });

    assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_a"]);
  });

  it("queues verified recovery until the degraded initial barrier accepts its snapshot", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = null;
    const streamReady = deferred<void>();
    const initialSnapshot = deferred<DesktopRoomSnapshot>();
    const reconciliation = deferred<DesktopRoomSnapshot>();
    harness.nextStreamReady = streamReady.promise;
    harness.nextSelectedSnapshot = initialSnapshot.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const initial = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: true, verified: false,
      });
      streamReady.resolve();
      await flushAsync();
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a"]);

      harness.nextSelectedSnapshot = reconciliation.promise;
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: false, verified: true,
      });
      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "focus_a", task: taskSummary("task_during_barrier"),
      });
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a"]);

      initialSnapshot.resolve(focusSnapshot());
      await initial;
      await flushAsync();
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_a"]);

      // The degraded marker remains until this accepted reconciliation. A
      // duplicate verified frame must not start a third fetch.
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: false, verified: true,
      });
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_a"]);
      reconciliation.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        tasks: [taskSummary("task_during_barrier")],
      }));
      await flushAsync();

      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: false, verified: true,
      });
      await flushAsync();
    });

    assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_a"]);
    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_during_barrier"]);
  });

  it("a stale room gap recovery cannot clear the next room's event buffer", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot();
    const roomA = deferred<DesktopRoomSnapshot>();
    harness.nextSelectedSnapshot = roomA.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: true, verified: true,
      });
      await flushAsync();

      const roomB = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = roomB.promise;
      harness.activeEntry.value = focusEntry("focus_b", "Focus B");
      const refreshB = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "focus_b", task: taskSummary("task_b"),
      });

      roomA.resolve(focusSnapshot());
      await flushAsync();
      roomB.resolve(roomSnapshot("focus_b", { kind: "focus", parentRoomId: "room_parent" }));
      await refreshB;
    });

    assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "focus_b");
    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_b"]);
  });

  it("ignores late verified recovery from a degraded room after the barrier switches", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = null;
    const roomA = deferred<DesktopRoomSnapshot>();
    harness.nextSelectedSnapshot = roomA.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const refreshA = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: true, verified: false,
      });

      const roomB = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = roomB.promise;
      harness.activeEntry.value = focusEntry("focus_b", "Focus B");
      const refreshB = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "focus_b", task: taskSummary("task_b"),
      });

      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: false, verified: true,
      });
      await flushAsync();
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_b"]);

      roomB.resolve(roomSnapshot("focus_b", { kind: "focus", parentRoomId: "room_parent" }));
      await refreshB;
      roomA.resolve(focusSnapshot());
      await refreshA;
    });

    assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "focus_b");
    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_b"]);
    assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_b"]);
  });

  it("ignores a late degraded gap from the prior room while the next barrier is active", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = null;
    const roomA = deferred<DesktopRoomSnapshot>();
    harness.nextSelectedSnapshot = roomA.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const refreshA = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();

      const roomB = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = roomB.promise;
      harness.activeEntry.value = focusEntry("focus_b", "Focus B");
      const refreshB = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "focus_b", task: taskSummary("task_b"),
      });

      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: true, verified: false,
      });
      await flushAsync();
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_b"]);

      roomB.resolve(roomSnapshot("focus_b", { kind: "focus", parentRoomId: "room_parent" }));
      await refreshB;
      roomA.resolve(focusSnapshot());
      await refreshA;
    });

    assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "focus_b");
    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_b"]);
    assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_b"]);
  });

  it("moves stream ownership when cached parent selection skips a snapshot barrier", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot();
    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      harness.getSnapshotRequests.length = 0;

      harness.selectedSnapshot.value = roomSnapshot("room_parent");
      await harness.state.syncSelectedRoomStream("room_parent");
      const rootRecovery = deferred<DesktopRoomSnapshot>();
      harness.nextSelectedSnapshot = rootRecovery.promise;
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: true, verified: false,
      });
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "room_parent", gap: true, verified: false,
      });
      await flushAsync();
      assert.deepEqual(harness.getSnapshotRequests, ["room_parent"]);

      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "room_parent", task: taskSummary("task_parent"),
      });
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "room_parent", gap: false, verified: true,
      });
      rootRecovery.resolve(roomSnapshot("room_parent"));
      await flushAsync();
    });

    assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "room_parent");
    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_parent"]);
    assert.deepEqual(harness.getSnapshotRequests, ["room_parent"]);
  });

  it("retires a completed degraded barrier when the next room starts loading", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = null;
    const roomAReady = deferred<void>();
    const roomA = deferred<DesktopRoomSnapshot>();
    harness.nextStreamReady = roomAReady.promise;
    harness.nextSelectedSnapshot = roomA.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const refreshA = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: true, verified: false,
      });
      roomAReady.resolve();
      await flushAsync();
      roomA.resolve(focusSnapshot());
      await refreshA;

      const roomB = deferred<DesktopRoomSnapshot>();
      harness.nextStreamReady = Promise.resolve();
      harness.nextSelectedSnapshot = roomB.promise;
      harness.activeEntry.value = focusEntry("focus_b", "Focus B");
      const refreshB = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      // Preserve the stale visible room that made snapshotMatches(A) unsafe as
      // an ownership check while B's authoritative snapshot is still pending.
      harness.selectedSnapshot.value = focusSnapshot();
      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "focus_b", task: taskSummary("task_b"),
      });
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: false, verified: true,
      });
      await flushAsync();
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_b"]);

      roomB.resolve(roomSnapshot("focus_b", { kind: "focus", parentRoomId: "room_parent" }));
      await refreshB;
    });

    assert.equal(harness.selectedSnapshot.value?.roomIdentifier, "focus_b");
    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_b"]);
    assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_b"]);
  });

  it("carries degraded recovery authority into a repeated same-room barrier", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = null;
    const firstReady = deferred<void>();
    const firstSnapshot = deferred<DesktopRoomSnapshot>();
    harness.nextStreamReady = firstReady.promise;
    harness.nextSelectedSnapshot = firstSnapshot.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const firstRefresh = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: true, verified: false,
      });
      firstReady.resolve();
      await flushAsync();
      firstSnapshot.resolve(focusSnapshot());
      await firstRefresh;

      const secondSnapshot = deferred<DesktopRoomSnapshot>();
      const reconciliation = deferred<DesktopRoomSnapshot>();
      harness.nextStreamReady = Promise.resolve();
      harness.nextSelectedSnapshot = secondSnapshot.promise;
      const secondRefresh = harness.state.refreshSelectedSnapshot(harness.rootRoomSnapshot.value);
      await flushAsync();
      harness.state.handleRoomStreamEvent({
        type: "task_update", roomIdentifier: "focus_a", task: taskSummary("task_during_second_barrier"),
      });
      harness.nextSelectedSnapshot = reconciliation.promise;
      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: false, verified: true,
      });
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_a"]);

      secondSnapshot.resolve(focusSnapshot());
      await secondRefresh;
      await flushAsync();
      assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_a", "focus_a"]);
      reconciliation.resolve(roomSnapshot("focus_a", {
        kind: "focus",
        parentRoomId: "room_parent",
        tasks: [taskSummary("task_during_second_barrier")],
      }));
      await flushAsync();

      harness.state.handleRoomStreamEvent({
        type: "open", roomIdentifier: "focus_a", gap: false, verified: true,
      });
      await flushAsync();
    });

    assert.deepEqual(harness.getSnapshotRequests, ["focus_a", "focus_a", "focus_a"]);
    assert.deepEqual(
      harness.selectedSnapshot.value?.tasks.map((task) => task.id),
      ["task_during_second_barrier"],
    );
  });

  it("applies a task_update to the snapshot without scheduling a full refresh", () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot();

    harness.state.handleRoomStreamEvent({
      type: "task_update",
      roomIdentifier: "focus_a",
      task: taskSummary("task_1"),
    });

    assert.deepEqual(harness.selectedSnapshot.value?.tasks.map((task) => task.id), ["task_1"]);
    assert.deepEqual(harness.metadataRefreshCalls, []);
    assert.deepEqual(harness.getSnapshotRequests, []);
  });

  it("applies a github_event to the snapshot without scheduling a full refresh", () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot();

    harness.state.handleRoomStreamEvent({
      type: "github_event",
      roomIdentifier: "focus_a",
      event: githubRoomEvent("ghe_1"),
    });

    assert.deepEqual(
      harness.selectedSnapshot.value?.githubEvents?.events.map((event) => event.id),
      ["ghe_1"],
    );
    assert.deepEqual(harness.metadataRefreshCalls, []);
  });

  it("applies reasoning update and removal without scheduling a full refresh", () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot();

    harness.state.handleRoomStreamEvent({
      type: "reasoning_update",
      roomIdentifier: "focus_a",
      session: reasoningSession("reason_1"),
    });
    assert.deepEqual(
      harness.selectedSnapshot.value?.reasoningSessions.map((session) => session.id),
      ["reason_1"],
    );

    harness.state.handleRoomStreamEvent({
      type: "reasoning_remove",
      roomIdentifier: "focus_a",
      sessionId: "reason_1",
    });
    assert.deepEqual(harness.selectedSnapshot.value?.reasoningSessions, []);
    assert.deepEqual(harness.metadataRefreshCalls, []);
  });

  it("appends an ordinary agent message without scheduling a refresh", () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot([roomMessage("msg_1", "Existing")]);

    harness.state.handleRoomStreamEvent({
      type: "message",
      roomIdentifier: "focus_a",
      message: agentMessage("msg_2"),
    });

    assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1", "msg_2"]);
    assert.deepEqual(harness.metadataRefreshCalls, []);
  });

  it("schedules a refresh when a message references a thread root outside the loaded window", () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot([roomMessage("msg_1", "Existing")]);

    harness.state.handleRoomStreamEvent({
      type: "message",
      roomIdentifier: "focus_a",
      message: threadReplyMessage("msg_2", "msg_missing"),
    });

    assert.deepEqual(messageIds(harness.selectedSnapshot.value), ["msg_1", "msg_2"]);
    assert.equal(harness.metadataRefreshCalls.length, 1);
  });

  it("does not schedule a refresh for a reply whose root is in the loaded window", () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot([roomMessage("msg_1", "Root")]);

    harness.state.handleRoomStreamEvent({
      type: "message",
      roomIdentifier: "focus_a",
      message: threadReplyMessage("msg_2", "msg_1", "msg_1"),
    });

    assert.deepEqual(harness.metadataRefreshCalls, []);
  });

  it("refetches only artifacts on artifact_update instead of the whole snapshot", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = focusSnapshot();
    harness.nextArtifacts = [sharedArtifact("artifact:pr:1")];

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.state.handleRoomStreamEvent({
        type: "artifact_update",
        roomIdentifier: "focus_a",
        artifactIdentityKey: "artifact:pr:1",
        artifact: null,
      });
      await flushAsync();
    });

    assert.deepEqual(harness.getArtifactsRequests, ["focus_a"]);
    assert.deepEqual(harness.getSnapshotRequests, []);
    assert.deepEqual(harness.metadataRefreshCalls, []);
    assert.deepEqual(
      harness.selectedSnapshot.value?.roomArtifacts.map((artifact) => artifact.identityKey),
      ["artifact:pr:1"],
    );
  });
});

function createHarness(options: {
  deliveryRepairRetryMs?: number;
  snapshotTimeoutMs?: number;
} = {}): {
  accountRooms: Ref<DesktopAccountRoomEntry[]>;
  activeEntry: Ref<SidebarEntry>;
  getSnapshotRequests: Array<string | null>;
  deliveryRepairs: Array<{ roomIdentifier: string; repair: DesktopRoomDeliveryRepair }>;
  deliveryRepairFailures: number;
  getArtifactsRequests: Array<string>;
  metadataRefreshCalls: Array<number | undefined>;
  nextArtifacts: DesktopRoomSharedArtifact[];
  listAccountRoomsCalls: Array<DesktopAccountRoomListOptions | undefined>;
  nextAccountRooms: DesktopAccountRoomEntry[];
  nextAppInfo: Promise<DesktopAppInfo>;
  nextSelectedSnapshot: Promise<DesktopRoomSnapshot>;
  nextStreamReady: Promise<void>;
  repairStreamDeliveryAvailable: boolean;
  rootRoomSnapshot: Ref<DesktopRoomSnapshot | null>;
  selectedSnapshot: Ref<DesktopRoomSnapshot | null>;
  sessionGeneration: Ref<number>;
  settingsAccountRooms: Ref<DesktopAccountRoomEntry[]>;
  state: ReturnType<typeof useDesktopAppData>;
  windowBridge: object;
} {
  const rootRoomSnapshot = ref<DesktopRoomSnapshot | null>(roomSnapshot("room_parent", {
    focusRooms: [
      focusRoomInfo("focus_a", "Focus A"),
      focusRoomInfo("focus_b", "Focus B"),
    ],
  }));
  const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
  const activeEntry = ref<SidebarEntry>(focusEntry("focus_a", "Focus A"));
  const accountRooms = ref<DesktopAccountRoomEntry[]>([]);
  const settingsAccountRooms = ref<DesktopAccountRoomEntry[]>([]);
  const sessionGeneration = ref(0);
  const getSnapshotRequests: Array<string | null> = [];
  const deliveryRepairs: Array<{ roomIdentifier: string; repair: DesktopRoomDeliveryRepair }> = [];
  const getArtifactsRequests: Array<string> = [];
  const metadataRefreshCalls: Array<number | undefined> = [];
  const listAccountRoomsCalls: Array<DesktopAccountRoomListOptions | undefined> = [];
  const harness = {
    nextSelectedSnapshot: Promise.resolve(roomSnapshot("focus_a", {
      kind: "focus",
      parentRoomId: "room_parent",
    })),
    nextAccountRooms: [] as DesktopAccountRoomEntry[],
    nextArtifacts: [] as DesktopRoomSharedArtifact[],
    nextAppInfo: Promise.resolve({} as DesktopAppInfo),
    nextStreamReady: Promise.resolve(),
    deliveryRepairFailures: 0,
    repairStreamDeliveryAvailable: true,
  };

  const state = useDesktopAppData({
    accountRooms,
    activeEntry,
    appInfo: ref<DesktopAppInfo | null>(null),
    authStatus: ref<DesktopAuthStatus | null>(null),
    currentParentRoom: computed(() => parentEntry()),
    diagnostics: ref<DiagnosticsSnapshot | null>(null),
    loading: ref(false),
    mcpInstallState: ref<DesktopMcpInstallState | null>(null),
    reconcileActiveEntry: () => undefined,
    rememberRootRoomSnapshot: () => undefined,
    recentRootRooms: ref<RecentRootRoom[]>([]),
    repoStatus: ref<RepoStatus | null>(null),
    resolveSelectedRoomIdentifier: () => activeEntry.value.type === "room" ? activeEntry.value.roomIdentifier : null,
    rootRoomSnapshot,
    scheduleLiveMetadataRefresh: (delayMs?: number) => {
      metadataRefreshCalls.push(delayMs);
    },
    sessionGeneration,
    selectedMcpTargetIds: ref<DesktopMcpInstallTargetId[]>([]),
    selectedRootRoomIdentifier: ref("room_parent"),
    selectedSnapshot,
    settingsAccountRooms,
    deliveryRepairRetryMs: options.deliveryRepairRetryMs,
    snapshotTimeoutMs: options.snapshotTimeoutMs,
    syncRoomStream: async () => harness.nextStreamReady,
    workers: ref<WorkerSnapshot[]>([]),
  });

  return {
    accountRooms,
    activeEntry,
    deliveryRepairs,
    get deliveryRepairFailures() {
      return harness.deliveryRepairFailures;
    },
    set deliveryRepairFailures(value: number) {
      harness.deliveryRepairFailures = value;
    },
    getSnapshotRequests,
    getArtifactsRequests,
    metadataRefreshCalls,
    listAccountRoomsCalls,
    get nextArtifacts() {
      return harness.nextArtifacts;
    },
    set nextArtifacts(value: DesktopRoomSharedArtifact[]) {
      harness.nextArtifacts = value;
    },
    get nextAccountRooms() {
      return harness.nextAccountRooms;
    },
    set nextAccountRooms(value: DesktopAccountRoomEntry[]) {
      harness.nextAccountRooms = value;
    },
    get nextAppInfo() {
      return harness.nextAppInfo;
    },
    set nextAppInfo(value: Promise<DesktopAppInfo>) {
      harness.nextAppInfo = value;
    },
    get nextSelectedSnapshot() {
      return harness.nextSelectedSnapshot;
    },
    get nextStreamReady() {
      return harness.nextStreamReady;
    },
    set nextStreamReady(value: Promise<void>) {
      harness.nextStreamReady = value;
    },
    set nextSelectedSnapshot(value: Promise<DesktopRoomSnapshot>) {
      harness.nextSelectedSnapshot = value;
    },
    get repairStreamDeliveryAvailable() {
      return harness.repairStreamDeliveryAvailable;
    },
    set repairStreamDeliveryAvailable(value: boolean) {
      harness.repairStreamDeliveryAvailable = value;
    },
    rootRoomSnapshot,
    selectedSnapshot,
    sessionGeneration,
    settingsAccountRooms,
    state,
    windowBridge: {
      letagentsDesktop: {
        app: {
          getInfo: async (): Promise<DesktopAppInfo> => harness.nextAppInfo,
        },
        auth: {
          getStatus: async (): Promise<DesktopAuthStatus> => ({} as DesktopAuthStatus),
        },
        diagnostics: {
          getSnapshot: async (): Promise<DiagnosticsSnapshot> => ({} as DiagnosticsSnapshot),
        },
        room: {
          startStream: async () => harness.nextStreamReady,
          get repairStreamDelivery() {
            if (!harness.repairStreamDeliveryAvailable) return undefined;
            return async (
              roomIdentifier: string,
              repair: DesktopRoomDeliveryRepair,
            ): Promise<void> => {
              deliveryRepairs.push({ roomIdentifier, repair });
              if (harness.deliveryRepairFailures > 0) {
                harness.deliveryRepairFailures -= 1;
                throw new Error("repair handoff unavailable");
              }
            };
          },
          getSnapshot: async (roomIdentifier: string | null): Promise<DesktopRoomSnapshot> => {
            getSnapshotRequests.push(roomIdentifier);
            return harness.nextSelectedSnapshot;
          },
          listAccountRooms: async (
            options?: DesktopAccountRoomListOptions,
          ): Promise<DesktopAccountRoomEntry[]> => {
            listAccountRoomsCalls.push(options);
            return harness.nextAccountRooms;
          },
          getArtifacts: async (roomIdentifier: string): Promise<DesktopRoomSharedArtifact[]> => {
            getArtifactsRequests.push(roomIdentifier);
            return harness.nextArtifacts;
          },
        },
        repos: {
          getStatus: async (): Promise<RepoStatus> => repoStatusFixture(),
          openRoom: async (): Promise<DesktopRepoRoomSelection> => canceledOpenRoom(),
        },
        setup: {
          getMcpInstallState: async (): Promise<DesktopMcpInstallState> => ({
            completed: true,
            completedAt: null,
            selectedTargetId: null,
            targets: [],
          }),
        },
        workers: {
          list: async (): Promise<WorkerSnapshot[]> => [],
        },
      },
    },
  };
}

async function withDesktopBridge<T>(
  value: object,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
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

describe("useDesktopAppData session invalidation", () => {
  it("drops a pre-sign-out root and account refresh that resolves after the session is cleared", async () => {
    const harness = createHarness();
    const appInfo = deferred<DesktopAppInfo>();
    harness.nextAppInfo = appInfo.promise;
    harness.nextAccountRooms = [accountRoomEntry("private_room")];

    await withDesktopBridge(harness.windowBridge, async () => {
      const refresh = harness.state.refresh();
      await flushAsync();

      harness.state.invalidateSession();
      harness.rootRoomSnapshot.value = null;
      harness.selectedSnapshot.value = null;
      harness.accountRooms.value = [];
      harness.settingsAccountRooms.value = [];

      appInfo.resolve({} as DesktopAppInfo);
      await refresh;
    });

    assert.equal(harness.rootRoomSnapshot.value, null);
    assert.equal(harness.selectedSnapshot.value, null);
    assert.deepEqual(harness.accountRooms.value, []);
    assert.deepEqual(harness.settingsAccountRooms.value, []);
  });
});

describe("useDesktopAppData refreshAccountRooms", () => {
  it("issues a single include-archived fetch and splits archived from visible rooms", async () => {
    const harness = createHarness();
    harness.nextAccountRooms = [
      accountRoomEntry("room_visible", { archived: false }),
      accountRoomEntry("room_archived", { archived: true }),
    ];

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.state.refreshAccountRooms();
    });

    assert.deepEqual(harness.listAccountRoomsCalls, [
      { includeArchived: true, limit: 100 },
    ]);
    assert.deepEqual(
      harness.accountRooms.value.map((room) => room.roomIdentifier),
      ["room_visible"],
    );
    assert.deepEqual(
      harness.settingsAccountRooms.value.map((room) => room.roomIdentifier),
      ["room_visible", "room_archived"],
    );
  });
});

function accountRoomEntry(
  roomIdentifier: string,
  overrides: Partial<DesktopAccountRoomEntry> = {},
): DesktopAccountRoomEntry {
  return {
    roomIdentifier,
    displayName: roomIdentifier,
    name: roomIdentifier,
    kind: "main",
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    focusStatus: null,
    role: "participant",
    source: null,
    pinned: false,
    archived: false,
    canLeave: true,
    canDelete: false,
    deleteReason: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
    latestMessageId: null,
    latestMessageAt: null,
    gitRoom: null,
    focusRooms: [],
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function parentEntry(): RoomEntry {
  return {
    id: "room:parent:room_parent",
    type: "room",
    kind: "parent",
    roomIdentifier: "room_parent",
    title: "Parent Room",
    meta: "Room",
    sectionLabel: "Room",
    headline: "Parent Room",
    description: "",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    source: "current",
  };
}

function focusEntry(roomIdentifier: string, title = roomIdentifier): RoomEntry {
  return {
    id: `room:focus:${roomIdentifier}`,
    type: "room",
    kind: "focus",
    roomIdentifier,
    title,
    meta: "Focus room",
    sectionLabel: "Focus Room",
    headline: title,
    description: "",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    source: "current",
  };
}

function roomSnapshot(
  identifier: string,
  options: {
    kind?: DesktopRoomInfo["kind"];
    parentRoomId?: string | null;
    focusRooms?: DesktopFocusRoomInfo[];
    tasks?: DesktopRoomSnapshot["tasks"];
    messages?: DesktopRoomMessage[];
  } = {},
): DesktopRoomSnapshot {
  const kind = options.kind || "main";
  return {
    roomIdentifier: identifier,
    access: {
      status: "ready",
      title: "",
      message: "",
      roomIdentifier: identifier,
      deviceFlowUrl: null,
      code: null,
      httpStatus: null,
    },
    room: {
      identifier,
      code: "",
      name: identifier,
      displayName: identifier,
      role: "admin",
      authenticated: true,
      kind,
      parentRoomId: options.parentRoomId ?? null,
      focusKey: kind === "focus" ? identifier : null,
      sourceTaskId: null,
      focusStatus: kind === "focus" ? "active" : null,
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
      roomIdentifier: identifier,
      defaultMode: "cloud",
      overrideMode: "inherit",
      effectiveMode: "cloud",
      isLocalRoom: false,
      localRoom: null,
      databasePath: "",
      localFilesPath: "",
    },
    focusRooms: options.focusRooms || [],
    tasks: options.tasks || [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    reasoningSessions: [],
    recentActivity: [],
    roomArtifacts: [],
    messages: options.messages || [],
    githubEvents: null,
  };
}

function nonReadySnapshot(
  identifier: string,
  status: DesktopRoomSnapshot["access"]["status"],
): DesktopRoomSnapshot {
  const snapshot = roomSnapshot(identifier);
  return {
    ...snapshot,
    access: {
      ...snapshot.access,
      status,
    },
    room: null,
    messages: [],
  };
}

function focusRoomInfo(identifier: string, displayName: string): DesktopFocusRoomInfo {
  return {
    roomId: identifier,
    identifier,
    name: identifier,
    displayName,
    code: null,
    kind: "focus",
    attachmentsEnabled: true,
    parentRoomId: "room_parent",
    focusKey: identifier,
    sourceTaskId: null,
    focusStatus: "active",
    focusParentVisibility: null,
    focusActivityScope: null,
    focusGitHubEventRouting: null,
    focusSettings: null,
    focusArchivedAt: null,
    concludedAt: null,
    conclusionSummary: null,
    conclusionDetails: null,
    gitRoom: null,
    createdAt: "2026-07-02T00:00:00.000Z",
  };
}

function roomMessage(id: string, text: string): DesktopRoomMessage {
  return {
    id,
    sender: "EmmyMay",
    text,
    attachments: [],
    agentPromptKind: null,
    source: "browser",
    timestamp: `2026-07-02T00:00:0${id.replace("msg_", "")}.000Z`,
    actorLabel: null,
    agentIdentity: null,
    threadRootId: id,
    threadReplyToId: null,
    thread: null,
    replyTo: null,
  };
}

function messageIds(snapshot: DesktopRoomSnapshot | null): string[] {
  return snapshot?.messages.map((message) => message.id) || [];
}

function focusSnapshot(messages: DesktopRoomMessage[] = []): DesktopRoomSnapshot {
  return roomSnapshot("focus_a", {
    kind: "focus",
    parentRoomId: "room_parent",
    messages,
  });
}

function agentMessage(id: string): DesktopRoomMessage {
  return {
    ...roomMessage(id, id),
    source: "agent",
  };
}

function threadReplyMessage(
  id: string,
  threadRootId: string,
  threadReplyToId: string | null = null,
): DesktopRoomMessage {
  return {
    ...roomMessage(id, id),
    source: "agent",
    threadRootId,
    threadReplyToId,
  };
}

function taskSummary(id: string): DesktopTaskSummary {
  return { id, title: id, status: "todo" } as DesktopTaskSummary;
}

function githubRoomEvent(id: string): DesktopGitHubRoomEvent {
  return {
    id,
    eventType: "pull_request",
    action: "opened",
    githubObjectId: null,
    githubObjectUrl: null,
    title: null,
    state: null,
    actorLogin: null,
    metadata: {},
    linkedTaskId: null,
    createdAt: "2026-07-02T00:00:00.000Z",
  };
}

function reasoningSession(id: string): DesktopReasoningSession {
  return { id, createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" } as DesktopReasoningSession;
}

function sharedArtifact(identityKey: string): DesktopRoomSharedArtifact {
  return {
    roomId: "focus_a",
    identityKey,
    provider: "github",
    kind: "pull_request",
    artifactId: null,
    artifactNumber: null,
    title: null,
    url: null,
    ref: null,
    state: null,
    detail: null,
    source: "github_event",
    firstSeenAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    linkedTaskIds: [],
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForDesktop(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for desktop repair state");
    await flushAsync();
  }
}

function repoStatusFixture(): RepoStatus {
  return {
    rootPath: "/Users/emmy/Projects/letagents",
    branch: "staging",
    worktrees: [],
  };
}

function canceledOpenRoom(): DesktopRepoRoomSelection {
  return {
    canceled: true,
    repoPath: null,
    repoStatus: null,
    roomIdentifier: null,
    source: null,
    snapshot: null,
    error: null,
    warning: null,
  };
}
