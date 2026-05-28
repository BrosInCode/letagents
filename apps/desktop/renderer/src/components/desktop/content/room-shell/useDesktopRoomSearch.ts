import { computed, ref, watch, type Ref } from "vue";
import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";

export function useDesktopRoomSearch(messages: Readonly<Ref<readonly DesktopRoomMessage[]>>) {
  const searchOpen = ref(false);
  const searchQuery = ref("");
  const activeSearchIndex = ref(0);

  const normalizedSearchQuery = computed(() => searchQuery.value.trim().toLowerCase());
  const searchResults = computed(() => {
    const query = normalizedSearchQuery.value;
    if (!query) return [];
    return messages.value.filter((message) => {
      const haystack = [
        message.sender,
        message.text,
        message.replyTo?.text || "",
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

  return {
    searchOpen,
    searchQuery,
    searchResults,
    activeSearchMessageId,
    searchSummary,
    toggleSearch,
    closeSearch,
    moveSearch,
  };
}
