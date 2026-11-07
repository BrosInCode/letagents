import { onBeforeUnmount, onMounted, onUpdated, ref, watch } from "vue";

/** One underline, shared by the desktop and web room headers. */
export function useSlidingTabIndicator(activeTab: () => string) {
  const tabsElement = ref<HTMLElement | null>(null);
  const indicatorElement = ref<HTMLElement | null>(null);
  let motion: MediaQueryList | undefined;
  let resizeObserver: ResizeObserver | undefined;
  const observed = new Set<Element>();
  let animateNextChange = false;
  let keyboard = false;
  let placed = false;

  function position(animate = false): void {
    const tabs = tabsElement.value;
    const indicator = indicatorElement.value;
    const selected = tabs?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!tabs || !indicator || !selected) {
      if (indicator) indicator.style.visibility = "hidden";
      placed = false;
      return;
    }
    const width = selected.offsetWidth;
    if (!width) return;
    const target = `translate(${selected.offsetLeft}px, ${selected.offsetTop + selected.offsetHeight - 2}px)`;
    // Content updates and ResizeObserver notifications must not restart a running move.
    if (placed && indicator.style.transform === target && indicator.style.width === `${width}px`) return;
    // CSS transitions retarget from the current visual position while labels
    // expand. Restarting a keyframe animation on every resize causes snapping.
    indicator.style.transition = animate && placed && !motion?.matches && !keyboard
      ? "transform 220ms cubic-bezier(.22,1,.36,1), width 180ms cubic-bezier(.22,1,.36,1)"
      : "none";
    indicator.style.width = `${width}px`;
    indicator.style.transform = target;
    indicator.style.visibility = "visible";
    placed = true;
  }

  function prepareTabChange(event: MouseEvent, tab: string): void {
    keyboard = event.detail === 0;
    animateNextChange = event.detail > 0 && tab !== activeTab();
  }

  function revealActive(): void {
    const tabs = tabsElement.value;
    const selected = tabs?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!tabs || !selected || !tabs.clientWidth) return;
    const left = selected.offsetLeft;
    const right = left + selected.offsetWidth;
    // Keep the selected label in the navigation viewport, never scroll the page.
    // ResizeObserver follows its expansion, so no second scroll animation is needed.
    if (left < tabs.scrollLeft || selected.offsetWidth > tabs.clientWidth) tabs.scrollLeft = left;
    else if (right > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = right - tabs.clientWidth;
  }
  function syncLayout(entries?: readonly ResizeObserverEntry[]): void {
    position(placed);
    const tabs = tabsElement.value;
    const selected = tabs?.querySelector('[aria-current="page"]');
    // An inactive label may expand on hover. Moving the strip then would move
    // the pointer's target; only the selected label or container may reveal it.
    if (entries?.some(entry => entry.target === tabs || entry.target === selected)) revealActive();
  }
  function syncMotion(): void {
    if (indicatorElement.value) indicatorElement.value.style.transition = "none";
    position();
  }
  function keyboardInput(): void { keyboard = true; syncMotion(); }
  function pointerInput(): void { keyboard = false; }
  function observeTabs(): void {
    const elements = tabsElement.value ? [tabsElement.value, ...tabsElement.value.querySelectorAll('button')] : [];
    for (const element of observed) if (!elements.includes(element as HTMLElement)) { resizeObserver?.unobserve(element); observed.delete(element); }
    for (const element of elements) if (!observed.has(element)) { resizeObserver?.observe(element); observed.add(element); }
  }

  watch(activeTab, () => {
    position(animateNextChange);
    revealActive();
    animateNextChange = false;
  }, { flush: "post" });
  onUpdated(() => { observeTabs(); syncLayout(); });
  onMounted(() => {
    motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    motion?.addEventListener("change", syncMotion);
    if (typeof ResizeObserver !== "undefined" && tabsElement.value) {
      resizeObserver = new ResizeObserver(syncLayout);
      observeTabs();
    }
    tabsElement.value?.addEventListener("keydown", keyboardInput);
    tabsElement.value?.addEventListener("pointerover", pointerInput);
    syncLayout();
    revealActive();
  });
  onBeforeUnmount(() => {
    tabsElement.value?.removeEventListener("keydown", keyboardInput);
    tabsElement.value?.removeEventListener("pointerover", pointerInput);
    resizeObserver?.disconnect();
    motion?.removeEventListener("change", syncMotion);
  });

  return { tabsElement, indicatorElement, prepareTabChange };
}
