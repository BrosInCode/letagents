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

/**
 * The part of the card that can be captured: the window only has the pixels
 * that are on screen. `complete` is false when the card reaches past the window.
 */
export function visibleCaptureRect(
  card: DesktopWindowRect,
  viewport: { width: number; height: number },
): { rect: DesktopWindowRect | null; complete: boolean } {
  const left = Math.max(0, card.x);
  const top = Math.max(0, card.y);
  const right = Math.min(viewport.width, card.x + card.width);
  const bottom = Math.min(viewport.height, card.y + card.height);
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
