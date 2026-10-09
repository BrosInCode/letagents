import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import type { DesktopAuthAccount, DesktopRoomLatestMessage } from "../../../electron/ipc-types";
import { countUnreadRoomMessages, roomReadKey, type RoomReadMarkers, type RoomUnreadSnapshot } from "../domain/desktop-room-read-state";
import { desktopIpc } from "../ipc";

export function useDesktopUnreadCounts(options: {
  account: Readonly<Ref<DesktopAuthAccount | null>>;
  rooms: Readonly<Ref<DesktopRoomLatestMessage[]>>;
  readMarkers: Readonly<Ref<RoomReadMarkers>>;
  storageMode: Readonly<Ref<string>>;
}) {
  const snapshots = ref<Record<string, RoomUnreadSnapshot>>({});
  let revision = 0;
  let disposed = false;
  let running: Promise<void> | null = null;
  let refreshPending = false;

  const roomCounts = computed(() => {
    const counts: Record<string, number> = {};
    if (!options.account.value) return counts;
    for (const room of options.rooms.value) {
      const key = roomReadKey(room.roomIdentifier);
      if (!key) continue;
      const marker = options.readMarkers.value[key];
      const snapshot = snapshots.value[key];
      counts[key] = marker && marker !== room.latestMessageId && snapshot?.readMessageId === marker
        ? snapshot.count : 0;
    }
    return counts;
  });
  const totalCount = computed(() => Object.values(roomCounts.value).reduce((sum, count) => sum + count, 0));

  async function refresh(): Promise<void> {
    refreshPending = true;
    if (running) return running;
    running = (async () => {
      while (refreshPending && !disposed) {
        refreshPending = false;
        const currentRevision = revision;
        const account = options.account.value;
        const loadPage = desktopIpc.room?.getMessagesAfter;
        if (!account || !loadPage) continue;
        const rooms = [...new Map(options.rooms.value.map((room) => [roomReadKey(room.roomIdentifier), room])).values()];
        const isCurrent = () => !disposed && revision === currentRevision;
        // Only changed rooms need history, with at most four concurrent lookups.
        for (let index = 0; index < rooms.length && isCurrent(); index += 4) {
          await Promise.all(rooms.slice(index, index + 4).map(async (room) => {
            const key = roomReadKey(room.roomIdentifier);
            if (!key || !room.latestMessageId) return;
            const readMessageId = options.readMarkers.value[key];
            if (!readMessageId) return;
            const previous = snapshots.value[key];
            if (previous?.readMessageId === readMessageId && previous.latestMessageId === room.latestMessageId) return;
            try {
              const snapshot = await countUnreadRoomMessages({
                readMessageId,
                latestMessageId: room.latestMessageId,
                previous,
                ownSenderNames: [account.login, account.displayName || ""],
                loadPage: (after) => loadPage(room.roomIdentifier, after),
                isCurrent,
              });
              if (snapshot && isCurrent()) snapshots.value = { ...snapshots.value, [key]: snapshot };
            } catch {
              // Preserve the last known count on transient failure; the next tick retries.
            }
          }));
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  watch(() => [options.account.value?.id, options.storageMode.value], () => {
    revision += 1;
    snapshots.value = {};
  }, { flush: "sync" });
  watch(() => JSON.stringify([options.account.value?.id, options.storageMode.value, options.rooms.value, options.readMarkers.value]), () => {
    revision += 1;
    void refresh();
  }, { immediate: true });
  watch(totalCount, (count) => {
    void desktopIpc.notifications?.setBadgeCount?.(count).catch(() => undefined);
  }, { immediate: true });
  onScopeDispose(() => { disposed = true; revision += 1; });
  return { roomCounts, totalCount, refresh };
}
