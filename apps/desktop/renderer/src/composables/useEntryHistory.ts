import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import type { SidebarEntry } from "../components/desktop/types";

const HISTORY_LIMIT = 50;

/**
 * Back and forward through the places opened in this window: rooms, My work,
 * Messages, the Inbox, Settings. It works like a browser's history:
 *
 * 1. Opening a place puts the one before it on the back list and clears the
 *    forward list.
 * 2. Back opens the last place on the back list and puts the current one on
 *    the forward list; Forward does the reverse.
 * 3. A place that is gone (a room that was left or deleted) is skipped.
 *
 * Keys: ⌘[ and ⌘] (Ctrl on Windows and Linux), and a mouse's back and forward
 * buttons.
 */
export function useEntryHistory(options: {
  activeEntry: Ref<SidebarEntry>;
  /** Opens an entry the way a sidebar click does. */
  open: (entry: SidebarEntry) => void;
  /** The entry as it is now, or null when it no longer exists. */
  resolve: (entry: SidebarEntry) => SidebarEntry | null;
}) {
  const back = ref<SidebarEntry[]>([]);
  const forward = ref<SidebarEntry[]>([]);
  let travelling = false;

  watch(options.activeEntry, (entry, previous) => {
    if (travelling || !previous || entry.id === previous.id) return;
    back.value = [...back.value, previous].slice(-HISTORY_LIMIT);
    forward.value = [];
  }, { flush: "sync" });

  function travel(from: Ref<SidebarEntry[]>, to: Ref<SidebarEntry[]>): void {
    const current = options.activeEntry.value;
    const list = [...from.value];
    while (list.length) {
      const candidate = list.pop()!;
      const target = options.resolve(candidate);
      if (!target || target.id === current.id) continue;
      from.value = list;
      to.value = [...to.value, current].slice(-HISTORY_LIMIT);
      travelling = true;
      try { options.open(target); } finally { travelling = false; }
      return;
    }
    from.value = [];
  }

  const canGoBack = computed(() => back.value.length > 0);
  const canGoForward = computed(() => forward.value.length > 0);
  const goBack = () => travel(back, forward);
  const goForward = () => travel(forward, back);

  function onKey(event: KeyboardEvent): void {
    const modifier = navigator.platform.startsWith("Mac") ? event.metaKey : event.ctrlKey;
    if (!modifier || event.altKey || event.shiftKey) return;
    if (event.key === "[" && canGoBack.value) { event.preventDefault(); goBack(); }
    else if (event.key === "]" && canGoForward.value) { event.preventDefault(); goForward(); }
  }
  function onMouse(event: MouseEvent): void {
    if (event.button === 3 && canGoBack.value) { event.preventDefault(); goBack(); }
    else if (event.button === 4 && canGoForward.value) { event.preventDefault(); goForward(); }
  }
  onMounted(() => {
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("mouseup", onMouse);
  });

  return { canGoBack, canGoForward, goBack, goForward };
}
