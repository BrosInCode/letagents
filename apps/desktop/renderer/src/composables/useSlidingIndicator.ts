import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref, type WatchSource } from "vue";

/**
 * The position of one sliding highlight under the active item of a row
 * (a segmented control, a tab bar). Give it the row and how to find the
 * active item; it returns CSS custom properties for the highlight.
 *
 * - The first placement does not animate (`moving` stays false), so the
 *   highlight never slides in from the corner when the row appears.
 * - It measures again when the active item changes and when the row resizes
 *   (a font loads, a label changes, the window narrows).
 * - Measures with offsetLeft/offsetWidth, so a row that scrolls sideways
 *   carries its highlight with it.
 */
export function useSlidingIndicator(
  root: Ref<HTMLElement | null>,
  activeSelector: string,
  activeKey: WatchSource<unknown>,
) {
  const box = ref<{ x: number; y: number; width: number; height: number } | null>(null);
  const moving = ref(false);
  let observer: ResizeObserver | undefined;
  let frame = 0;

  function place(): void {
    const active = root.value?.querySelector<HTMLElement>(activeSelector);
    box.value = active
      ? { x: active.offsetLeft, y: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight }
      : null;
  }

  onMounted(() => {
    place();
    // Turn on the slide only after the first placement has painted.
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { moving.value = true; }); });
    if (typeof ResizeObserver !== "undefined" && root.value) {
      observer = new ResizeObserver(() => place());
      observer.observe(root.value);
    }
  });
  watch(activeKey, () => { void nextTick(place); });
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
  });

  const style = computed(() => box.value
    ? {
        "--indicator-x": `${box.value.x}px`,
        "--indicator-y": `${box.value.y}px`,
        "--indicator-width": `${box.value.width}px`,
        "--indicator-height": `${box.value.height}px`,
      }
    : {});
  return { placed: computed(() => box.value !== null), moving, style, place };
}
