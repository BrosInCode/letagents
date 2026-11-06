import type { DesktopWindowRect } from "../../../../../../../electron/ipc-types";
import { LIVE_DEMO_COLORS, type DemoMark } from "./protocol";

/** The picture's file name: the demo's name without its extension, then " marked up.png". */
export function markupFileName(demoFileName: string): string {
  const base = demoFileName.replace(/[\\/]+/g, "-").replace(/\.x?html?$/i, "").trim();
  return `${base || "Demo"} marked up.png`;
}

// The palette's colours by name, in LIVE_DEMO_COLORS order, so a reader of the text can match the ink.
const COLOR_NAMES = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;

export function inkColorName(color: string): string {
  const index = LIVE_DEMO_COLORS.indexOf(color.toLowerCase());
  return index >= 0 ? COLOR_NAMES[index] ?? "grey" : "grey";
}

// The reply stays short enough to read; a long note is cut, and many pins are counted.
const NOTE_MAX = 200;
const PINS_LISTED = 20;

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What `markupNotes` reads of a mark; a mark not saved yet has no id or time. */
export type NoteMark =
  | { kind: "pin"; text: string; author: DemoMark["author"] }
  | { kind: "stroke"; author: DemoMark["author"] };

export interface MarkupNotes {
  /** Each pin by its number on the picture. */
  pins: Array<{ number: number; author: string; color: string; text: string }>;
  /** Who drew, with their ink colour, in the order they first drew. */
  inkBy: Array<{ author: string; color: string; colorName: string }>;
}

/**
 * What the picture cannot say by itself: a pin is a numbered dot, and its note
 * shows only on hover. An agent cannot hover, so the notes and the ink colours
 * go with the picture as text. Pin numbers match the dots (oldest first).
 */
export function markupNotes(marks: readonly NoteMark[]): MarkupNotes {
  const pins: MarkupNotes["pins"] = [];
  const inkBy = new Map<string, MarkupNotes["inkBy"][number]>();
  for (const mark of marks) {
    if (mark.kind === "pin") {
      pins.push({ number: pins.length + 1, author: mark.author.name, color: mark.author.color, text: oneLine(mark.text, NOTE_MAX) });
    } else if (!inkBy.has(mark.author.accountId)) {
      inkBy.set(mark.author.accountId, { author: mark.author.name, color: mark.author.color, colorName: inkColorName(mark.author.color) });
    }
  }
  return { pins, inkBy: [...inkBy.values()] };
}

/** The text of the thread reply that carries the picture: the person's note, then what the marks say. */
export function markupReplyText(demoFileName: string, notes: MarkupNotes, note = ""): string {
  const name = demoFileName.replace(/\s+/g, " ").trim() || "the demo";
  const marked = notes.pins.length > 0 || notes.inkBy.length > 0;
  const lines = [oneLine(note, 1_000), marked ? `Marked-up picture of the demo ${name}.` : `Picture of the demo ${name}.`].filter(Boolean);
  if (notes.pins.length > 0) {
    lines.push("", "Pins:");
    for (const pin of notes.pins.slice(0, PINS_LISTED)) lines.push(`${pin.number}. ${pin.author}: ${pin.text}`);
    if (notes.pins.length > PINS_LISTED) lines.push(`…and ${notes.pins.length - PINS_LISTED} more.`);
  }
  if (notes.inkBy.length > 0) {
    lines.push("", `Drawings: ${notes.inkBy.map((ink) => `${ink.author} (${ink.colorName})`).join(", ")}.`);
  }
  return lines.join("\n");
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
 * edges round inward (the top left up, the bottom right down), so a clip edge at
 * 700.2 stops at 700 and the picture never takes a strip of what lies past it. A
 * part smaller than a pixel counts as not on screen. The window only has the
 * pixels that are on screen. `complete` is false when the card reaches past any
 * of them.
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
  const x = Math.ceil(left);
  const y = Math.ceil(top);
  const width = Math.floor(right) - x;
  const height = Math.floor(bottom) - y;
  if (!(width >= 1 && height >= 1)) return { rect: null, complete: false };
  const complete = left <= card.x && top <= card.y && right >= card.x + card.width && bottom >= card.y + card.height;
  return { rect: { x, y, width, height }, complete };
}
