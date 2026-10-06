import { onBeforeUnmount, onMounted, onUpdated, ref, watch } from "vue";

/** One underline, shared by the desktop and web room headers. */
export function useSlidingTabIndicator(activeTab: () => string) {
  const tabsElement = ref<HTMLElement | null>(null);
  const indicatorElement = ref<HTMLElement | null>(null);
  let animation: Animation | null = null;
  let motion: MediaQueryList | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let animateNextChange = false;
  let placed = false;

  function position(animate = false): void {
    const tabs = tabsElement.value;
    const indicator = indicatorElement.value;
    const selected = tabs?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!tabs || !indicator || !selected) {
      animation?.cancel();
      if (indicator) indicator.style.visibility = "hidden";
      placed = false;
      return;
    }
    const width = selected.offsetWidth;
    if (!width) return;
    const target = `translate(${selected.offsetLeft}px, ${selected.offsetTop + selected.offsetHeight - 2}px)`;
    // Content updates and ResizeObserver notifications must not restart a running move.
    if (placed && indicator.style.transform === target && indicator.style.width === `${width}px`) return;
    const previous = indicator.getBoundingClientRect();
    const origin = tabs.getBoundingClientRect();
    animation?.cancel();
    animation = null;
    indicator.style.width = `${width}px`;
    indicator.style.transform = target;
    indicator.style.visibility = "visible";
    if (animate && placed && !motion?.matches && indicator.animate) {
      animation = indicator.animate([
        { transform: `translate(${previous.left - origin.left + tabs.scrollLeft}px, ${previous.top - origin.top + tabs.scrollTop}px) scaleX(${previous.width / width})` },
        { transform: `${target} scaleX(1)` },
      ], { duration: 240, easing: "cubic-bezier(.22, 1, .36, 1)" });
    }
    placed = true;
  }

  function prepareTabChange(event: MouseEvent, tab: string): void {
    animateNextChange = event.detail > 0 && tab !== activeTab();
  }

  function syncLayout(): void { position(); }
  function syncMotion(): void { animation?.cancel(); animation = null; position(); }

  watch(activeTab, () => {
    position(animateNextChange);
    animateNextChange = false;
  }, { flush: "post" });
  onUpdated(syncLayout);
  onMounted(() => {
    motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    motion?.addEventListener("change", syncMotion);
    if (typeof ResizeObserver !== "undefined" && tabsElement.value) {
      resizeObserver = new ResizeObserver(syncLayout);
      resizeObserver.observe(tabsElement.value);
    }
    syncLayout();
  });
  onBeforeUnmount(() => {
    animation?.cancel();
    resizeObserver?.disconnect();
    motion?.removeEventListener("change", syncMotion);
  });

  return { tabsElement, indicatorElement, prepareTabChange };
}
