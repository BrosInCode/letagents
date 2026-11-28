import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref, type WatchSource } from "vue";
import {
  SIDEBAR_ACTIVE_ROW_VISIBLE_SHARE,
  sidebarActiveRowEdge,
  type SidebarDockEdge,
} from "../domain/sidebar-active-dock";

/**
 * Watches the open room's row in the scrolled room list. `edge` names the
 * list edge the row has left by (the dock waits there), or null while enough
 * of the row shows. An IntersectionObserver reports the row, so scrolling
 * costs no work on the main thread between threshold crossings.
 */
export function useSidebarActiveRoomDock(options: {
  list: Ref<HTMLElement | null>;
  activeRow: () => HTMLElement | null;
  enabled: () => boolean;
  /** Anything that can replace, hide or move the open room's row. */
  sources: WatchSource[];
}) {
  const edge = ref<SidebarDockEdge | null>(null);
  /** The list's top inside its positioned parent, where a top dock sits. */
  const listTop = ref(0);
  let observer: IntersectionObserver | null = null;
  let observedRow: HTMLElement | null = null;
  let scrolledList: HTMLElement | null = null;
  let frame = 0;

  // The observer reports only threshold crossings, so a jump from below the
  // list to above it (End key, a dragged scrollbar) would leave the dock on
  // the wrong edge. While the dock shows, a scroll re-reads which side the
  // row is on, at most once a frame.
  function measure(): void {
    frame = 0;
    const list = options.list.value;
    if (!list || !observedRow || edge.value === null) return;
    edge.value = sidebarActiveRowEdge(observedRow.getBoundingClientRect(), list.getBoundingClientRect());
  }
  function handleScroll(): void {
    // A row that was leaving when it was picked (a collapsing group) is gone
    // now: watch its stand-in instead.
    if (observedRow && !observedRow.isConnected) {
      observe();
      return;
    }
    if (edge.value !== null && !frame) frame = requestAnimationFrame(measure);
  }

  function disconnect(): void {
    observer?.disconnect();
    observer = null;
    observedRow = null;
    scrolledList?.removeEventListener("scroll", handleScroll);
    scrolledList = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function observe(): void {
    const list = options.list.value;
    const row = options.enabled() ? options.activeRow() : null;
    if (observer && row === observedRow && row?.isConnected) return;
    disconnect();
    edge.value = null;
    if (!list || !row || typeof IntersectionObserver === "undefined") return;
    observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry?.rootBounds) return;
      listTop.value = list.offsetTop;
      edge.value = sidebarActiveRowEdge(entry.boundingClientRect, entry.rootBounds);
    }, { root: list, threshold: [0, SIDEBAR_ACTIVE_ROW_VISIBLE_SHARE, 1] });
    observer.observe(row);
    observedRow = row;
    list.addEventListener("scroll", handleScroll, { passive: true });
    scrolledList = list;
  }

  /** Scrolls the open room's row to the middle of the list. */
  function reveal(): void {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    options.activeRow()?.scrollIntoView({ block: "center", inline: "nearest", behavior: reduceMotion ? "instant" : "smooth" });
  }

  watch(options.sources, () => { void nextTick(observe); }, { flush: "post" });
  onMounted(observe);
  onBeforeUnmount(disconnect);

  return { edge, listTop, reveal };
}
