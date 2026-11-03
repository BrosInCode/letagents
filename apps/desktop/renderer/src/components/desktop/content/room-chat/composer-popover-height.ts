// The popover's 6px offset plus a margin from the edge that would cut it off.
const EDGE_GAP = 14;

/**
 * The tallest a popover above `element` can be without being cut off: the
 * distance up to the nearest parent that clips, or to the top of the window.
 */
export function heightAboveElement(element: HTMLElement): number | null {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return null;
  let limit = 0;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (window.getComputedStyle(parent).overflowY !== "visible") {
      limit = parent.getBoundingClientRect().top;
      break;
    }
  }
  return Math.max(0, Math.floor(element.getBoundingClientRect().top - limit - EDGE_GAP));
}
