import type { ComputedRef, Ref } from "vue";
import type { DesktopRoomSnapshot, WorkerSnapshot } from "../../../electron/ipc-types";
import { mergeRoomSnapshotMessages, roomSnapshotsMatch } from "../domain/desktop-room-snapshots";
import { normalizeRoomIdentifier } from "../domain/sidebar-rooms";
import { desktopIpc } from "../ipc/index.js";

interface DesktopRoomLiveSyncOptions {
  rootRoomSnapshot: Ref<DesktopRoomSnapshot | null>;
  selectedRoomIdentifier: ComputedRef<string | null>;
  selectedSnapshot: Ref<DesktopRoomSnapshot | null>;
  workers: Ref<WorkerSnapshot[]>;
}

export function useDesktopRoomLiveSync(options: DesktopRoomLiveSyncOptions) {
  let liveMetadataRefreshTimer: number | null = null;
  let liveMetadataRefreshInterval: number | null = null;
  let liveMetadataRefreshSequence = 0;

  async function refreshSelectedRoomSnapshotFromServer(): Promise<void> {
    const roomIdentifier = options.selectedRoomIdentifier.value;
    if (!roomIdentifier) return;
    const refreshSequence = ++liveMetadataRefreshSequence;
    const [snapshot, nextWorkers] = await Promise.all([
      desktopIpc.room.getSnapshot(roomIdentifier),
      desktopIpc.workers.list().catch(() => options.workers.value),
    ]);
    if (
      refreshSequence !== liveMetadataRefreshSequence
      || normalizeRoomIdentifier(options.selectedRoomIdentifier.value) !== normalizeRoomIdentifier(roomIdentifier)
    ) {
      return;
    }
    options.workers.value = nextWorkers;
    options.selectedSnapshot.value = mergeRoomSnapshotMessages(options.selectedSnapshot.value, snapshot);
    if (options.rootRoomSnapshot.value && roomSnapshotsMatch(options.rootRoomSnapshot.value, snapshot)) {
      options.rootRoomSnapshot.value = mergeRoomSnapshotMessages(options.rootRoomSnapshot.value, snapshot);
    }
  }

  function scheduleLiveMetadataRefresh(delayMs = 800): void {
    if (liveMetadataRefreshTimer) {
      window.clearTimeout(liveMetadataRefreshTimer);
    }
    liveMetadataRefreshTimer = window.setTimeout(() => {
      liveMetadataRefreshTimer = null;
      void refreshSelectedRoomSnapshotFromServer().catch(() => undefined);
    }, delayMs);
  }

  function clearLiveMetadataRefreshTimer(): void {
    if (!liveMetadataRefreshTimer) return;
    window.clearTimeout(liveMetadataRefreshTimer);
    liveMetadataRefreshTimer = null;
  }

  function startLiveMetadataRefreshInterval(): void {
    clearLiveMetadataRefreshInterval();
    liveMetadataRefreshInterval = window.setInterval(() => {
      void refreshSelectedRoomSnapshotFromServer().catch(() => undefined);
    }, 5_000);
  }

  function clearLiveMetadataRefreshInterval(): void {
    if (!liveMetadataRefreshInterval) return;
    window.clearInterval(liveMetadataRefreshInterval);
    liveMetadataRefreshInterval = null;
  }

  async function syncSelectedRoomStream(roomIdentifier: string | null): Promise<void> {
    if (!desktopIpc.room?.startStream) return;
    if (!roomIdentifier) {
      clearLiveMetadataRefreshInterval();
      await desktopIpc.room.stopStream();
      return;
    }
    const latestMessageId = options.selectedSnapshot.value?.messages.at(-1)?.id || null;
    await desktopIpc.room.startStream(roomIdentifier, latestMessageId);
    startLiveMetadataRefreshInterval();
  }

  return {
    clearLiveMetadataRefreshInterval,
    clearLiveMetadataRefreshTimer,
    scheduleLiveMetadataRefresh,
    syncSelectedRoomStream,
  };
}
