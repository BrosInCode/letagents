import { LIVE_DEMO, type LiveDemoPoint } from "./protocol";

/** An ended stroke stays this long, so its saved copy can arrive and replace it. */
export const INK_LINGER_MS = 1_500;
/** A stroke that never ended (its drawer left) is dropped after this much silence. */
export const INK_STALE_MS = 10_000;
/** Strokes drawn at the same time by others. */
export const INK_MAX_STROKES = 32;

export interface LiveInkStroke {
  key: string;
  cid: string;
  points: LiveDemoPoint[];
  ended: boolean;
  /** When the last frame arrived. */
  updatedAt: number;
}

export interface InkFrame {
  cid: string;
  id: string;
  pts: readonly LiveDemoPoint[];
  end?: boolean;
}

/** The strokes other people are drawing right now. Plain data, like the cursor field. */
export interface InkField {
  apply(frame: InkFrame, now: number): void;
  /** Drops strokes that ended long ago or went silent. Returns true when one went. */
  prune(now: number): boolean;
  /** Forgets the strokes of everyone not in `keep`. Returns true when one went. */
  keepOnly(keep: ReadonlySet<string>): boolean;
  clear(): void;
  strokes(): readonly LiveInkStroke[];
}

export function createInkField(): InkField {
  const strokes = new Map<string, LiveInkStroke>();
  return {
    apply(frame, now) {
      const key = `${frame.cid}:${frame.id}`;
      let stroke = strokes.get(key);
      if (!stroke) {
        stroke = { key, cid: frame.cid, points: [], ended: false, updatedAt: now };
        strokes.set(key, stroke);
        while (strokes.size > INK_MAX_STROKES) strokes.delete(strokes.keys().next().value as string);
      }
      const room = LIVE_DEMO.strokePoints - stroke.points.length;
      if (room > 0) stroke.points.push(...frame.pts.slice(0, room));
      if (frame.end) stroke.ended = true;
      stroke.updatedAt = now;
    },
    prune(now) {
      let changed = false;
      for (const [key, stroke] of strokes) {
        const age = now - stroke.updatedAt;
        if (stroke.ended ? age >= INK_LINGER_MS : age >= INK_STALE_MS) {
          strokes.delete(key);
          changed = true;
        }
      }
      return changed;
    },
    keepOnly(keep) {
      let changed = false;
      for (const [key, stroke] of strokes) {
        if (keep.has(stroke.cid)) continue;
        strokes.delete(key);
        changed = true;
      }
      return changed;
    },
    clear() {
      strokes.clear();
    },
    strokes: () => [...strokes.values()],
  };
}
