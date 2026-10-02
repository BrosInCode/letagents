import { computed, getCurrentInstance, provide, ref, watch, type InjectionKey, type Ref } from "vue";
import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import { roomMessageVisibleText } from "../../../../domain/attention-response";

export const roomSearchCommandKey: InjectionKey<(query: string) => void> = Symbol("room-search-command");

export function useDesktopRoomSearch(
  messages: Readonly<Ref<readonly DesktopRoomMessage[]>>,
  agentNames: () => ReadonlyMap<string, string> | null = () => null,
) {
  const searchOpen = ref(false);
  const searchQuery = ref("");
  const activeSearchIndex = ref(0);

  const normalizedSearchQuery = computed(() => searchQuery.value.trim().toLowerCase());
  const searchResults = computed(() => {
    const query = normalizedSearchQuery.value;
    if (!query) return [];
    return messages.value.filter((message) => {
      // What people read and what was sent both match, so "@Amber" finds a
      // Needs-you answer as well as its raw handle does.
      const haystack = [
        message.sender,
        message.displayText || message.text,
        roomMessageVisibleText(message, agentNames()),
        message.replyTo?.displayText || message.replyTo?.text || "",
        message.replyTo ? roomMessageVisibleText(message.replyTo, agentNames()) : "",
        ...message.attachments.map((attachment) => attachment.fileName || attachment.name || ""),
      ].join("\n").toLowerCase();
      return haystack.includes(query);
    });
  });
  const activeSearchMessageId = computed(() => searchResults.value[activeSearchIndex.value]?.id || null);
  const searchSummary = computed(() => {
    if (!normalizedSearchQuery.value) return "Type to search this room.";
    if (!searchResults.value.length) return "No messages found.";
    return `${activeSearchIndex.value + 1} of ${searchResults.value.length}`;
  });

  watch(searchResults, (results) => {
    if (activeSearchIndex.value >= results.length) {
      activeSearchIndex.value = Math.max(0, results.length - 1);
    }
  });

  function toggleSearch(): void {
    searchOpen.value = !searchOpen.value;
  }

  function closeSearch(): void {
    searchOpen.value = false;
    searchQuery.value = "";
    activeSearchIndex.value = 0;
  }

  function moveSearch(delta: 1 | -1): void {
    const count = searchResults.value.length;
    if (!count) return;
    activeSearchIndex.value = (activeSearchIndex.value + delta + count) % count;
  }

  function openSearchWithQuery(query: string): void {
    searchOpen.value = true;
    searchQuery.value = query;
    activeSearchIndex.value = 0;
  }

  if (getCurrentInstance()) provide(roomSearchCommandKey, openSearchWithQuery);

  return {
    searchOpen,
    searchQuery,
    searchResults,
    activeSearchMessageId,
    searchSummary,
    toggleSearch,
    closeSearch,
    moveSearch,
    openSearchWithQuery,
  };
}
