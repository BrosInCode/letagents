import { LIVE_DEMO, type DemoMark } from "./protocol";

function byAge(a: DemoMark, b: DemoMark): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Oldest first, one mark per id, at most LIVE_DEMO.marksPerDemo (the oldest go first). */
export function normalizeMarks(marks: readonly DemoMark[]): DemoMark[] {
  const byId = new Map<string, DemoMark>();
  for (const mark of marks) byId.set(mark.id, mark);
  const sorted = [...byId.values()].sort(byAge);
  return sorted.length > LIVE_DEMO.marksPerDemo ? sorted.slice(-LIVE_DEMO.marksPerDemo) : sorted;
}

/** Adds a mark, or replaces the one with its id (the same mark arrives by REST and by frame). */
export function mergeMark(marks: readonly DemoMark[], mark: DemoMark): DemoMark[] {
  return normalizeMarks([...marks, mark]);
}

export function removeMark(marks: readonly DemoMark[], id: string): DemoMark[] {
  return marks.some((mark) => mark.id === id) ? marks.filter((mark) => mark.id !== id) : [...marks];
}

export type MarkChange = { t: "mark"; mark: DemoMark } | { t: "unmark"; id: string };

/**
 * The marks the server listed, plus the changes that arrived while the list was
 * on its way (they are newer than the list, or already in it).
 */
export function applyMarkChanges(listed: readonly DemoMark[], changes: readonly MarkChange[]): DemoMark[] {
  let marks = normalizeMarks(listed);
  for (const change of changes) {
    marks = change.t === "mark" ? mergeMark(marks, change.mark) : removeMark(marks, change.id);
  }
  return marks;
}

/** A short line for a mark in the list. */
export function describeMark(mark: DemoMark): string {
  if (mark.kind === "stroke") return "Drawing";
  const text = mark.text.replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 59)}…` : text || "Pin";
}

export type StrokeMark = Extract<DemoMark, { kind: "stroke" }>;

/**
 * What to paint on the layer of saved strokes. A mark is never changed once
 * saved, so a stroke that is already on the canvas stays, and a newer one is
 * drawn on top of it, which is where it belongs. The whole layer is painted
 * again when:
 * - it was cleared (a new size or scale),
 * - a stroke went away, or
 * - a stroke that is not on the canvas sorts before one that is (by `createdAt`,
 *   then id). That happens when a stroke drawn live is painted before the saved
 *   list arrives: painting the older ones now would put them on top of it.
 */
export function planMarkPaint(
  drawn: ReadonlySet<string>,
  marks: readonly DemoMark[],
  layerCleared: boolean,
): { full: boolean; paint: StrokeMark[]; ids: Set<string> } {
  const strokes = marks.filter((mark): mark is StrokeMark => mark.kind === "stroke").sort(byAge);
  const ids = new Set(strokes.map((mark) => mark.id));
  let full = layerCleared;
  if (!full) for (const id of drawn) if (!ids.has(id)) { full = true; break; }
  if (!full) {
    let newerThanDrawn = false;
    for (const mark of strokes) {
      if (!drawn.has(mark.id)) newerThanDrawn = true;
      else if (newerThanDrawn) {
        // A stroke on the canvas comes after one that is not: that one belongs under it.
        full = true;
        break;
      }
    }
  }
  return { full, paint: full ? strokes : strokes.filter((mark) => !drawn.has(mark.id)), ids };
}
