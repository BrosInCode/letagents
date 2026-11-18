import { onBeforeUnmount, ref, watch } from "vue";
import type { DesktopRoomPage } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc";

const refreshRequests = new Set<() => void>();

/** The app itself pinned, approved or rolled back a page: the open room's tabs read again now. */
export function requestRoomPagesRefresh(): void {
  for (const refresh of refreshRequests) refresh();
}

/**
 * The room's pinned pages, the source of its page tabs. It stays empty for a
 * local room, for an app without the page bridge, and when the server has no
 * pages for the room or cannot be reached; the room then looks as it did.
 */
export function useRoomPages(roomIdentifier: () => string, enabled: () => boolean) {
  const roomPages = ref<DesktopRoomPage[]>([]);
  /** The list for the current room has arrived (or failed); until then a remembered page tab is kept. */
  const roomPagesLoaded = ref(false);
  let generation = 0;

  async function refreshRoomPages(): Promise<void> {
    const current = ++generation;
    const roomId = roomIdentifier();
    const list = desktopIpc.pages?.list;
    if (!enabled() || !roomId || !list) {
      roomPages.value = [];
      roomPagesLoaded.value = true;
      return;
    }
    let pages: DesktopRoomPage[] = [];
    try {
      pages = await list(roomId);
    } catch {
      // Pages are additive: a failed list leaves the room's own tabs as they are.
    }
    if (current !== generation) return;
    roomPages.value = Array.isArray(pages) ? pages : [];
    roomPagesLoaded.value = true;
  }

  watch([roomIdentifier, enabled], () => {
    roomPages.value = [];
    roomPagesLoaded.value = false;
    void refreshRoomPages();
  }, { immediate: true });

  // Someone pinned, unpinned or updated a page, or the stream may have missed that: read the list again.
  const refresh = () => {
    // Until the new list arrives, a tab just opened for a new page is not sent back to chat.
    roomPagesLoaded.value = false;
    void refreshRoomPages();
  };
  refreshRequests.add(refresh);
  const stopStream = desktopIpc.room?.onStreamEvent?.((event) => {
    if ((event.type === "resource_invalidation" && event.resource === "pages") || (event.type === "open" && event.gap)) refresh();
  }) ?? null;
  onBeforeUnmount(() => {
    refreshRequests.delete(refresh);
    stopStream?.();
  });

  return { roomPages, roomPagesLoaded, refreshRoomPages };
}
