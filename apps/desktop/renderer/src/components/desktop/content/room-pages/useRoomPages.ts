import { ref, watch } from "vue";
import type { DesktopRoomPage } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc";

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

  return { roomPages, roomPagesLoaded, refreshRoomPages };
}
