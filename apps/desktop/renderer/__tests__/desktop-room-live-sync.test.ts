import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computed, effectScope, ref, type Ref } from "vue";

import type {
  DesktopRoomLiveMetadata,
  DesktopRoomAgentWork,
  DesktopRoomAgentWorkPollResult,
  DesktopRoomSnapshot,
  WorkerSnapshot,
} from "../../electron/ipc-types";
import { useDesktopRoomLiveSync } from "../src/composables/useDesktopRoomLiveSync";
import { mergeRoomSnapshotMessages } from "../src/domain/desktop-room-snapshots";

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

  it("coalesces invalidation bursts into one immediate authoritative poll", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
      harness.nextAgentWork = Promise.resolve(unchangedRoomAgentWork());
      harness.sync.invalidateSelectedRoomAgentWork(ROOM);
      harness.sync.invalidateSelectedRoomAgentWork(ROOM);
      harness.sync.invalidateSelectedRoomAgentWork("room_other");
      await harness.settle();
    });

    assert.deepEqual(harness.pollAgentWorkRequests, [
      { roomIdentifier: ROOM, cursor: null },
      { roomIdentifier: ROOM, cursor: WORK_CURSOR },
    ]);
  });

  it("accepts the canonical room identifier from the selected alias snapshot", async () => {
    const harness = createHarness();
    const canonicalRoom = "room_canonical";

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
      const snapshot = baseSnapshot();
      snapshot.roomIdentifier = canonicalRoom;
      snapshot.room.identifier = canonicalRoom;
      harness.selectedSnapshot.value = snapshot;
      harness.nextAgentWork = Promise.resolve(unchangedRoomAgentWork());
      harness.sync.invalidateSelectedRoomAgentWork(canonicalRoom);
      await harness.settle();
    });

    assert.equal(harness.pollAgentWorkRequests.length, 2);
  });

  it("runs one trailing poll when invalidation races an in-flight request", async () => {
    const harness = createHarness();
    const gate = deferred<DesktopRoomAgentWorkPollResult>();
    harness.nextAgentWork = gate.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
      assert.equal(harness.pollAgentWorkRequests.length, 1);
      harness.sync.invalidateSelectedRoomAgentWork(ROOM);
      harness.sync.invalidateSelectedRoomAgentWork(ROOM);
      await harness.settle();
      assert.equal(harness.pollAgentWorkRequests.length, 1);
      gate.resolve(changedRoomAgentWork());
      await harness.settle();
    });

    assert.equal(harness.pollAgentWorkRequests.length, 2);
  });

  it("runs one trailing poll after an invalidated in-flight request fails", async () => {
    const harness = createHarness();
    const gate = deferred<DesktopRoomAgentWorkPollResult>();
    harness.nextAgentWork = gate.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
      harness.sync.invalidateSelectedRoomAgentWork(ROOM);
      harness.sync.invalidateSelectedRoomAgentWork(ROOM);
      await harness.settle();
      assert.equal(harness.pollAgentWorkRequests.length, 1);
      harness.nextAgentWork = Promise.resolve(changedRoomAgentWork());
      gate.reject(new Error("transient poll failure"));
      await harness.settle();
    });

    assert.equal(harness.pollAgentWorkRequests.length, 2);
    assert.equal(harness.sync.roomAgentWorkStatus.value, "ready");
  });

  it("defers hidden-window invalidations until foreground catch-up", async () => {
    const harness = createHarness();

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      await harness.settle();
      const before = harness.pollAgentWorkRequests.length;
      harness.documentHidden = true;
      harness.sync.invalidateSelectedRoomAgentWork(ROOM);
      await harness.settle();
      assert.equal(harness.pollAgentWorkRequests.length, before);
      harness.documentHidden = false;
      await harness.sync.refreshSelectedRoomLiveMetadata();
    });

    assert.equal(harness.pollAgentWorkRequests.length, 2);
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

  it("coalesces overlapping full refreshes and applies the trailing canonical snapshot with the same merge semantics", async () => {
    const harness = createHarness();
    harness.currentRoomId.value = ROOM;
    harness.selectedSnapshot.value = snapshotWithEventData();
    harness.rootRoomSnapshot.value = snapshotWithEventData();
    const initial = harness.selectedSnapshot.value;
    const first = deferred<DesktopRoomSnapshot>();
    const trailing = deferred<DesktopRoomSnapshot>();
    harness.nextSnapshot = first.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      for (let index = 0; index < 10; index += 1) {
        harness.sync.scheduleLiveMetadataRefresh(0);
        await harness.runTimeout();
      }
      assert.deepEqual(harness.getSnapshotRequests, [ROOM]);
      assert.equal(harness.workersListCalls, 1);
      harness.nextSnapshot = trailing.promise;
      first.resolve(baseSnapshot());
      await harness.settle();
      assert.strictEqual(harness.selectedSnapshot.value, initial);
      assert.deepEqual(harness.getSnapshotRequests, [ROOM, ROOM]);
      assert.equal(harness.workersListCalls, 2);
      const canonical = snapshotWithEventData();
      canonical.messages[0]!.id = "backfilled_message";
      canonical.tasks = [{ id: "canonical_task" }] as DesktopRoomSnapshot["tasks"];
      trailing.resolve(canonical);
      await harness.settle();
      const expected = mergeRoomSnapshotMessages(initial, canonical);
      assert.deepEqual(harness.selectedSnapshot.value, expected);
      assert.deepEqual(harness.rootRoomSnapshot.value, expected);
    });
  });

  it("keeps the pending debounce deadline when an invalidated full read finishes first", async () => {
    const harness = createHarness();
    harness.currentRoomId.value = ROOM;
    harness.selectedSnapshot.value = snapshotWithEventData();
    const initial = harness.selectedSnapshot.value;
    const pending = deferred<DesktopRoomSnapshot>();
    harness.nextSnapshot = pending.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      harness.sync.scheduleLiveMetadataRefresh(800);
      pending.resolve(baseSnapshot());
      await harness.settle();
      assert.strictEqual(harness.selectedSnapshot.value, initial);
      assert.deepEqual(harness.getSnapshotRequests, [ROOM]);
      harness.nextSnapshot = Promise.resolve(baseSnapshot());
      await harness.runTimeout();
      assert.deepEqual(harness.getSnapshotRequests, [ROOM, ROOM]);
    });
  });

  it("keeps retained work polling during full backfill without letting metadata invalidate that backfill", async () => {
    const harness = createHarness();
    harness.currentRoomId.value = ROOM;
    harness.selectedSnapshot.value = baseSnapshot();
    const pending = deferred<DesktopRoomSnapshot>();
    harness.nextSnapshot = pending.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      await harness.sync.refreshSelectedRoomLiveMetadata();
      assert.deepEqual(harness.getLiveMetadataRequests, []);
      assert.equal(harness.workersListCalls, 1);
      assert.equal(harness.pollAgentWorkRequests.length, 1);
      assert.equal(harness.sync.roomAgentWorkStatus.value, "ready");
      pending.resolve(snapshotWithEventData());
      await harness.settle();
      assert.deepEqual(harness.selectedSnapshot.value?.messages.map(message => message.id), ["msg_1"]);
      await harness.sync.refreshSelectedRoomLiveMetadata();
      assert.deepEqual(harness.getLiveMetadataRequests, [ROOM]);
      assert.equal(harness.workersListCalls, 2);
      assert.deepEqual(harness.selectedSnapshot.value?.participants, liveMetadata().participants);
      assert.deepEqual(harness.selectedSnapshot.value?.messages.map(message => message.id), ["msg_1"]);
    });
  });

  it("rejects an older periodic metadata response that completes after a full snapshot", async () => {
    const harness = createHarness();
    harness.currentRoomId.value = ROOM;
    harness.selectedSnapshot.value = baseSnapshot();
    const pendingMetadata = deferred<DesktopRoomLiveMetadata>();
    harness.nextMetadata = pendingMetadata.promise;
    const canonical = snapshotWithEventData();
    canonical.participants = [{ participantKey: "canonical" }] as DesktopRoomSnapshot["participants"];
    harness.nextSnapshot = Promise.resolve(canonical);

    await withDesktopBridge(harness.windowBridge, async () => {
      const periodic = harness.sync.refreshSelectedRoomLiveMetadata();
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      assert.deepEqual(harness.selectedSnapshot.value?.participants, canonical.participants);
      pendingMetadata.resolve(liveMetadata());
      await periodic;
      assert.deepEqual(harness.selectedSnapshot.value?.participants, canonical.participants);
      assert.deepEqual(harness.selectedSnapshot.value?.messages.map(message => message.id), ["msg_1"]);
      await harness.sync.refreshSelectedRoomLiveMetadata();
      assert.equal(harness.getLiveMetadataRequests.length, 2);
      assert.deepEqual(harness.selectedSnapshot.value?.participants, liveMetadata().participants);
    });
  });

  it("releases failed full reads and retries only a pending or later invalidation", async () => {
    const harness = createHarness();
    harness.currentRoomId.value = ROOM;
    harness.selectedSnapshot.value = snapshotWithEventData();
    const initial = harness.selectedSnapshot.value;
    const first = deferred<DesktopRoomSnapshot>();
    const trailing = deferred<DesktopRoomSnapshot>();
    harness.nextSnapshot = first.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      harness.nextSnapshot = trailing.promise;
      first.reject(new Error("offline"));
      await harness.settle();
      assert.equal(harness.getSnapshotRequests.length, 2);
      trailing.reject(new Error("still offline"));
      await harness.settle();
      assert.equal(harness.getSnapshotRequests.length, 2);
      assert.strictEqual(harness.selectedSnapshot.value, initial);
      harness.nextSnapshot = Promise.resolve(baseSnapshot());
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      assert.equal(harness.getSnapshotRequests.length, 3);
      assert.deepEqual(harness.selectedSnapshot.value?.tasks, []);
    });
  });

  it("fences old account/session results and clears their pending debounce", async () => {
    const harness = createHarness();
    harness.currentRoomId.value = ROOM;
    harness.selectedSnapshot.value = snapshotWithEventData();
    const first = deferred<DesktopRoomSnapshot>();
    const second = deferred<DesktopRoomSnapshot>();
    harness.nextSnapshot = first.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      harness.sync.scheduleLiveMetadataRefresh(800);
      harness.accountId.value = "account_2";
      await harness.runTimeout();
      assert.equal(harness.getSnapshotRequests.length, 1);
      harness.nextSnapshot = second.promise;
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      harness.sessionGeneration.value += 1;
      const current = baseSnapshot();
      current.tasks = [{ id: "current-session" }] as DesktopRoomSnapshot["tasks"];
      harness.nextSnapshot = Promise.resolve(current);
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      first.resolve(snapshotWithEventData());
      second.resolve(snapshotWithEventData());
      await harness.settle();
      assert.equal(harness.getSnapshotRequests.length, 3);
      assert.deepEqual(harness.selectedSnapshot.value?.tasks, current.tasks);
    });
  });

  it("does not share reads across navigation away and back to the same room", async () => {
    const harness = createHarness();
    harness.currentRoomId.value = ROOM;
    harness.selectedSnapshot.value = snapshotWithEventData();
    const old = deferred<DesktopRoomSnapshot>();
    const current = deferred<DesktopRoomSnapshot>();
    harness.nextSnapshot = old.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      harness.sync.scheduleLiveMetadataRefresh(800);
      harness.currentRoomId.value = "room_other";
      harness.currentRoomId.value = ROOM;
      harness.nextSnapshot = current.promise;
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      old.resolve(baseSnapshot());
      await harness.settle();
      assert.deepEqual(harness.selectedSnapshot.value?.tasks, snapshotWithEventData().tasks);
      assert.equal(harness.getSnapshotRequests.length, 2);
      // An obsolete completion must not release the current read's ownership.
      await harness.sync.refreshSelectedRoomLiveMetadata();
      assert.deepEqual(harness.getLiveMetadataRequests, []);
      current.resolve(baseSnapshot());
      await harness.settle();
      assert.deepEqual(harness.selectedSnapshot.value?.tasks, []);
    });
  });

  it("discards old periodic results across account changes without blocking the new account read", async () => {
    const harness = createHarness();
    harness.currentRoomId.value = ROOM;
    harness.selectedSnapshot.value = baseSnapshot();
    const old = deferred<DesktopRoomLiveMetadata>();
    const current = deferred<DesktopRoomLiveMetadata>();
    harness.nextMetadata = old.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const priorRead = harness.sync.refreshSelectedRoomLiveMetadata();
      harness.accountId.value = "account_2";
      harness.nextMetadata = current.promise;
      const currentRead = harness.sync.refreshSelectedRoomLiveMetadata();
      old.resolve(liveMetadata());
      await priorRead;
      assert.deepEqual(harness.selectedSnapshot.value?.participants, []);
      await harness.sync.refreshSelectedRoomLiveMetadata();
      assert.equal(harness.getLiveMetadataRequests.length, 2);
      current.resolve(liveMetadata());
      await currentRead;
      assert.deepEqual(harness.selectedSnapshot.value?.participants, liveMetadata().participants);
    });
  });

  it("clears pending full reads and timers when the owner scope is disposed", async () => {
    const scope = effectScope();
    const harness = scope.run(() => createHarness())!;
    harness.currentRoomId.value = ROOM;
    harness.selectedSnapshot.value = snapshotWithEventData();
    const initial = harness.selectedSnapshot.value;
    const pending = deferred<DesktopRoomSnapshot>();
    harness.nextSnapshot = pending.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      harness.sync.scheduleLiveMetadataRefresh(800);
      scope.stop();
      pending.resolve(baseSnapshot());
      await harness.settle();
      await harness.runTimeout();
      await harness.runInterval();
      assert.equal(harness.getSnapshotRequests.length, 1);
      assert.deepEqual(harness.getLiveMetadataRequests, []);
      assert.equal(harness.clearIntervalCalls, 1);
      assert.strictEqual(harness.selectedSnapshot.value, initial);
    });
  });

  it("does not accept a full read or pending debounce from a stopped and reopened room stream", async () => {
    const harness = createHarness();
    harness.selectedSnapshot.value = snapshotWithEventData();
    const initial = harness.selectedSnapshot.value;
    const pending = deferred<DesktopRoomSnapshot>();
    harness.nextSnapshot = pending.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      await harness.sync.syncSelectedRoomStream(ROOM);
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      harness.sync.scheduleLiveMetadataRefresh(800);
      await harness.sync.syncSelectedRoomStream(null);
      await harness.sync.syncSelectedRoomStream(ROOM);
      pending.resolve(baseSnapshot());
      await harness.settle();
      await harness.runTimeout();
      assert.strictEqual(harness.selectedSnapshot.value, initial);
      assert.equal(harness.getSnapshotRequests.length, 1);
      harness.nextSnapshot = Promise.resolve(baseSnapshot());
      harness.sync.scheduleLiveMetadataRefresh(0);
      await harness.runTimeout();
      assert.deepEqual(harness.selectedSnapshot.value?.tasks, []);
      assert.equal(harness.getSnapshotRequests.length, 2);
    });
  });

  it("does not reinstall polling when a delayed stream start finishes after scope disposal", async () => {
    const scope = effectScope();
    const harness = scope.run(() => createHarness())!;
    const ready = deferred<void>();
    harness.nextStreamReady = ready.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const start = harness.sync.syncSelectedRoomStream(ROOM);
      scope.stop();
      ready.resolve();
      await start;
      assert.equal(harness.setIntervalCalls, 0);
      assert.deepEqual(harness.pollAgentWorkRequests, []);
    });
  });

  it("does not reinstall polling from a delayed stream start after a same-room stop and return", async () => {
    const harness = createHarness();
    const old = deferred<void>();
    const current = deferred<void>();
    harness.nextStreamReady = old.promise;

    await withDesktopBridge(harness.windowBridge, async () => {
      const priorStart = harness.sync.syncSelectedRoomStream(ROOM);
      await harness.sync.syncSelectedRoomStream(null);
      harness.nextStreamReady = current.promise;
      const currentStart = harness.sync.syncSelectedRoomStream(ROOM);
      old.resolve();
      await priorStart;
      assert.equal(harness.setIntervalCalls, 0);
      assert.deepEqual(harness.pollAgentWorkRequests, []);
      current.resolve();
      await currentStart;
      assert.equal(harness.setIntervalCalls, 1);
      assert.equal(harness.pollAgentWorkRequests.length, 1);
    });
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
    nextSnapshot: Promise.resolve(baseSnapshot()) as Promise<DesktopRoomSnapshot>,
    nextStreamReady: Promise.resolve() as Promise<void>,
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
          return state.nextSnapshot;
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
          await state.nextStreamReady;
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
    clearTimeout: () => { timeoutCallback = null; },
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
    workers,
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
    set nextSnapshot(value: Promise<DesktopRoomSnapshot>) {
      state.nextSnapshot = value;
    },
    set nextStreamReady(value: Promise<void>) {
      state.nextStreamReady = value;
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
      const callback = timeoutCallback;
      timeoutCallback = null;
      callback?.();
      await flush();
    },
    settle: flush,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
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
