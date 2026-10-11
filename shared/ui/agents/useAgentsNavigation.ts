import { nextTick, onBeforeUnmount, ref, type Ref } from "vue";
/** Keep room scroll and focus when returning from its archive; never animate keyboard navigation. */
export function useAgentsNavigation(
  view: Ref<"live" | "history">,
  root: Ref<HTMLElement | undefined>,
) {
  const pastButton = ref<HTMLButtonElement>();
  let previousScroll = 0;
  let scrollRoot: HTMLElement | null = null;
  let animation: Animation | undefined;
  function scrollContainer() {
    let node = root.value || null;
    while (node) {
      if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
      node = node.parentElement;
    }
    return document.scrollingElement as HTMLElement | null;
  }
  async function navigate(target: "live" | "history", event?: MouseEvent) {
    if (target === "history" && view.value === "live") {
      scrollRoot = scrollContainer();
      previousScroll = scrollRoot?.scrollTop || 0;
    }
    animation?.cancel();
    view.value = target;
    await nextTick();
    if (scrollRoot)
      scrollRoot.scrollTop = target === "live" ? previousScroll : 0;
    if (target === "live") pastButton.value?.focus({ preventScroll: true });
    else
      root.value
        ?.querySelector<HTMLElement>(".agents-archive h2")
        ?.focus({ preventScroll: true });
    if (
      event?.detail &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      animation = root.value?.animate(
        [
          { opacity: 0.3, transform: "translateY(6px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: 220, easing: "cubic-bezier(.22,1,.36,1)" },
      );
  }
  onBeforeUnmount(() => animation?.cancel());
  return { navigate, pastButton };
}
