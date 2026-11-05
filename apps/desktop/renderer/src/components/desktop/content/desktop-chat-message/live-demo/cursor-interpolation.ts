/**
 * Remote cursors arrive about 20 times a second. Showing each one at once looks
 * jerky, so the cursor is drawn a little in the past (CURSOR_DELAY_MS) at a point
 * between the two samples that surround that moment. A frame loop reads the
 * position 60 times a second; a network frame only adds a sample.
 */

/** How far behind the newest sample a cursor is drawn: two frames of the 20/s stream. */
export const CURSOR_DELAY_MS = 100;
/** After a silence longer than this, the cursor glides to the next spot instead of jumping. */
export const CURSOR_GAP_MS = 300;
export const CURSOR_GLIDE_MS = 80;
export const CURSOR_MAX_SAMPLES = 12;

export interface CursorSample {
  /** When the sample arrived (ms, a monotonic clock). */
  at: number;
  x: number;
  y: number;
}

export interface CursorTrack {
  /** Oldest first. */
  samples: readonly CursorSample[];
}

export function newCursorTrack(): CursorTrack {
  return { samples: [] };
}

export function pushCursorSample(track: CursorTrack, x: number, y: number, now: number): CursorTrack {
  const last = track.samples[track.samples.length - 1];
  const at = last && now < last.at ? last.at : now;
  const samples = [...track.samples];
  if (last && at - last.at > CURSOR_GAP_MS) {
    // The old spot holds until just before the new sample, then the cursor glides.
    samples.push({ at: at - CURSOR_GLIDE_MS, x: last.x, y: last.y });
  }
  samples.push({ at, x, y });
  return { samples: samples.length > CURSOR_MAX_SAMPLES ? samples.slice(-CURSOR_MAX_SAMPLES) : samples };
}

/** Where to draw the cursor at `now`; `null` when it has no sample. Never runs ahead of the samples. */
export function cursorPositionAt(
  track: CursorTrack,
  now: number,
  delay = CURSOR_DELAY_MS,
): { x: number; y: number } | null {
  const samples = track.samples;
  if (samples.length === 0) return null;
  const time = now - delay;
  const first = samples[0];
  if (time <= first.at) return { x: first.x, y: first.y };
  const last = samples[samples.length - 1];
  if (time >= last.at) return { x: last.x, y: last.y };
  let next = 1;
  while (samples[next].at <= time) next++;
  const from = samples[next - 1];
  const to = samples[next];
  const span = to.at - from.at;
  const share = span > 0 ? (time - from.at) / span : 1;
  return { x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share };
}

/** True when the cursor has caught up with its newest sample, so a frame loop may rest. */
export function cursorSettled(track: CursorTrack, now: number, delay = CURSOR_DELAY_MS): boolean {
  const last = track.samples[track.samples.length - 1];
  return !last || now - delay >= last.at;
}

/** Drops the samples that can no longer be drawn: all but the last one at or before the drawn moment. */
export function pruneCursorTrack(track: CursorTrack, now: number, delay = CURSOR_DELAY_MS): CursorTrack {
  const time = now - delay;
  let keepFrom = 0;
  while (keepFrom + 1 < track.samples.length && track.samples[keepFrom + 1].at <= time) keepFrom++;
  return keepFrom === 0 ? track : { samples: track.samples.slice(keepFrom) };
}

/** The cursors of everyone in one demo. Plain data: a frame loop reads it, the router writes it. */
export interface CursorField {
  move(cid: string, x: number, y: number, now: number): void;
  /** The person's pointer left the demo. */
  gone(cid: string): void;
  /** Forgets everyone not in `keep` (people who left the demo). Returns true when someone went. */
  keepOnly(keep: ReadonlySet<string>): boolean;
  clear(): void;
  has(cid: string): boolean;
  cids(): string[];
  positionOf(cid: string, now: number): { x: number; y: number } | null;
  /** True while some cursor still moves toward its newest sample. */
  animating(now: number): boolean;
  prune(now: number): void;
}

export function createCursorField(): CursorField {
  const tracks = new Map<string, CursorTrack>();
  return {
    move(cid, x, y, now) {
      tracks.set(cid, pushCursorSample(tracks.get(cid) ?? newCursorTrack(), x, y, now));
    },
    gone(cid) {
      tracks.delete(cid);
    },
    keepOnly(keep) {
      let changed = false;
      for (const cid of [...tracks.keys()]) {
        if (keep.has(cid)) continue;
        tracks.delete(cid);
        changed = true;
      }
      return changed;
    },
    clear() {
      tracks.clear();
    },
    has: (cid) => tracks.has(cid),
    cids: () => [...tracks.keys()],
    positionOf(cid, now) {
      const track = tracks.get(cid);
      return track ? cursorPositionAt(track, now) : null;
    },
    animating(now) {
      for (const track of tracks.values()) if (!cursorSettled(track, now)) return true;
      return false;
    },
    prune(now) {
      for (const [cid, track] of tracks) {
        const pruned = pruneCursorTrack(track, now);
        if (pruned !== track) tracks.set(cid, pruned);
      }
    },
  };
}
