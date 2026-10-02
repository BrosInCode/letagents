import { computed, onScopeDispose, shallowRef, watch, type Ref } from "vue";
import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import { createMessageSearchController, type MessageSearchState } from "../../../../../../../../shared/message-search-controller.mjs";
import type { MessageSearchHit } from "../../../../../../../../shared/ui/MessageSearchResults.vue";
import { desktopIpc } from "../../../../ipc/index.js";
import { parseSenderIdentity } from "../desktop-chat-message/identity";

/**
 * Search the room's whole history on the server while the find strip is open.
 * The strip's own find keeps stepping through the messages already on screen;
 * this adds every match the room has ever had.
 */
export function useDesktopRoomHistorySearch(options: {
  roomIdentifier: Readonly<Ref<string>>;
  /** False for a room kept on this computer: it has no server history. */
  cloudRoom: Readonly<Ref<boolean>>;
  open: Readonly<Ref<boolean>>;
  query: Readonly<Ref<string>>;
}) {
  const available = computed(() => options.cloudRoom.value
    && Boolean(options.roomIdentifier.value)
    && typeof desktopIpc.room?.searchMessages === "function");

  const controller = createMessageSearchController<DesktopRoomMessage>({
    search: (query, before) => desktopIpc.room.searchMessages!(options.roomIdentifier.value, query, before),
    onChange: () => { state.value = controller.state; },
  });
  const state = shallowRef<MessageSearchState<DesktopRoomMessage>>(controller.state);

  watch(
    () => [options.roomIdentifier.value, available.value, options.open.value, options.query.value] as const,
    ([roomIdentifier, canSearch, open, query], previous) => {
      // Another room's results must never show under this room's search.
      if (previous && previous[0] !== roomIdentifier) controller.reset();
      if (canSearch && open) controller.setQuery(query);
      else controller.reset();
    },
    { immediate: true },
  );
  onScopeDispose(() => controller.reset());

  const hits = computed<MessageSearchHit[]>(() => state.value.hits.map((message) => ({
    id: message.id,
    sender: message.agentIdentity?.displayName || parseSenderIdentity(message).displayName || message.sender,
    timestamp: message.timestamp,
    text: message.displayText || message.text,
  })));

  return { state, hits, loadMore: () => controller.loadMore() };
}
