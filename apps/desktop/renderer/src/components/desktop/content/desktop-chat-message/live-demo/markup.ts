import type { DesktopWindowRect } from "../../../../../../../electron/ipc-types";

/** The picture's file name: the demo's name without its extension, then " marked up.png". */
export function markupFileName(demoFileName: string): string {
  const base = demoFileName.replace(/[\\/]+/g, "-").replace(/\.x?html?$/i, "").trim();
  return `${base || "Demo"} marked up.png`;
}

/** The short text of the thread reply that carries the picture. */
export function markupReplyText(demoFileName: string, markCount: number): string {
  const name = demoFileName.replace(/\s+/g, " ").trim() || "the demo";
  return markCount > 0 ? `Marked-up picture of the demo ${name}.` : `Picture of the demo ${name}.`;
}

/** A box by its edges. An edge is infinite on a side that does not clip. */
export interface ClipBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function viewportBox(width: number, height: number): ClipBox {
  return { left: 0, top: 0, right: width, bottom: height };
}

/** What `clippingBoxes` needs to know about a tree of boxes (the page's elements, or a test's stand-ins). */
export interface ClipOps<T> {
  parent(node: T): T | null;
  /** The axes on which this node cuts off what is inside it (overflow hidden, scroll, auto or clip). */
  clips(node: T): { x: boolean; y: boolean };
  /** The node's padding box in window CSS px: what an overflow box shows, without its border and scrollbars. */
  box(node: T): DesktopWindowRect;
}

/**
 * The boxes that cut off `start`: those of every ancestor that clips. A picture
 * of the card must stay inside all of them, or it shows what lies outside the
 * chat (the composer below the message list, for one). An ancestor that does not
 * really contain the card (an absolutely placed card escapes it) only makes the
 * picture smaller, never larger.
 */
export function clippingBoxes<T>(start: T, ops: ClipOps<T>): ClipBox[] {
  const boxes: ClipBox[] = [];
  for (let node = ops.parent(start); node !== null; node = ops.parent(node)) {
    const { x, y } = ops.clips(node);
    if (!x && !y) continue;
    const box = ops.box(node);
    boxes.push({
      left: x ? box.x : Number.NEGATIVE_INFINITY,
      right: x ? box.x + box.width : Number.POSITIVE_INFINITY,
      top: y ? box.y : Number.NEGATIVE_INFINITY,
      bottom: y ? box.y + box.height : Number.POSITIVE_INFINITY,
    });
  }
  return boxes;
}

/** The page's own clipping boxes for an element. */
export function elementClippingBoxes(element: Element): ClipBox[] {
  return clippingBoxes<Element>(element, {
    parent: (node) => node.parentElement,
    clips: (node) => {
      const style = getComputedStyle(node);
      // An inline box or one with no box of its own has no overflow.
      if (style.display === "contents" || style.display === "inline") return { x: false, y: false };
      return { x: style.overflowX !== "visible", y: style.overflowY !== "visible" };
    },
    box: (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left + node.clientLeft, y: rect.top + node.clientTop, width: node.clientWidth, height: node.clientHeight };
    },
  });
}

/**
 * The part of the card that may be captured: where the card, the window and
 * every clipping box (see `clippingBoxes`) all overlap, in whole pixels. The
 * window only has the pixels that are on screen. `complete` is false when the
 * card reaches past any of them.
 */
export function visibleCaptureRect(
  card: DesktopWindowRect,
  clips: readonly ClipBox[],
): { rect: DesktopWindowRect | null; complete: boolean } {
  let left = card.x;
  let top = card.y;
  let right = card.x + card.width;
  let bottom = card.y + card.height;
  for (const clip of clips) {
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  if (right - left < 1 || bottom - top < 1) return { rect: null, complete: false };
  const rect = {
    x: Math.floor(left),
    y: Math.floor(top),
    width: Math.ceil(right) - Math.floor(left),
    height: Math.ceil(bottom) - Math.floor(top),
  };
  const complete = left <= card.x && top <= card.y && right >= card.x + card.width && bottom >= card.y + card.height;
  return { rect, complete };
}
