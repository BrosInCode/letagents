import { readonly, ref } from "vue";

const storageKey = "letagents:hide-pinned-messages";

export function readPinnedMessagesHidden(): boolean {
  try { return window.localStorage.getItem(storageKey) === "true"; }
  catch { return false; }
}

const hidden = ref(readPinnedMessagesHidden());

/** A personal display preference; pin membership remains in the room store. */
export function usePinnedMessageVisibility() {
  function togglePinnedMessages(): void {
    hidden.value = !hidden.value;
    try { window.localStorage.setItem(storageKey, String(hidden.value)); }
    catch { /* Keep the current view usable when local storage is unavailable. */ }
  }
  return { pinnedMessagesHidden: readonly(hidden), togglePinnedMessages };
}
