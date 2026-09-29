import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

/**
 * Keeps a section rail in step with a scrolling list of `[data-section]`
 * elements: the rail follows the scroll position, and a click on the rail
 * scrolls to its section.
 */
export function useSectionScrollSpy<SectionId extends string>(
  contentElement: Ref<HTMLElement | null>,
  firstSection: SectionId,
) {
  const activeSection = ref(firstSection) as Ref<SectionId>;
  const indicatorReady = ref(false);
  // A click names the section at once; the scroll that follows must not
  // re-announce every section it passes on the way.
  let lockedSection: SectionId | null = null;
  let lockTimer: ReturnType<typeof setTimeout> | undefined;

  function sectionElements(): HTMLElement[] {
    return Array.from(contentElement.value?.querySelectorAll<HTMLElement>("[data-section]") ?? []);
  }

  function syncActiveSection(): void {
    const content = contentElement.value;
    if (!content || lockedSection) return;
    const elements = sectionElements();
    if (!elements.length) return;
    const atEnd = content.scrollTop > 0 && content.scrollTop + content.clientHeight >= content.scrollHeight - 2;
    const line = content.scrollTop + content.clientHeight * 0.3;
    const current = atEnd
      ? elements[elements.length - 1]
      : elements.filter((element) => element.offsetTop <= line).pop() ?? elements[0];
    activeSection.value = current.dataset.section as SectionId;
  }

  function releaseSectionLock(): void {
    if (!lockedSection) return;
    lockedSection = null;
    clearTimeout(lockTimer);
    syncActiveSection();
  }

  function goToSection(id: SectionId): void {
    const content = contentElement.value;
    const target = sectionElements().find((element) => element.dataset.section === id);
    if (!content || !target) return;
    lockedSection = id;
    activeSection.value = id;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    content.scrollTo({ top: target.offsetTop - 22, behavior: reducedMotion ? "auto" : "smooth" });
    clearTimeout(lockTimer);
    lockTimer = setTimeout(() => { lockedSection = null; }, 700);
  }

  onMounted(() => {
    syncActiveSection();
    // The indicator takes its first position without sliding there.
    requestAnimationFrame(() => { indicatorReady.value = true; });
  });

  onBeforeUnmount(() => clearTimeout(lockTimer));

  return { activeSection, indicatorReady, syncActiveSection, releaseSectionLock, goToSection };
}
