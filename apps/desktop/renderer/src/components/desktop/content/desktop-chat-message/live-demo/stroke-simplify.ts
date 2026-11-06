import { LIVE_DEMO, type LiveDemoPoint } from "./protocol";

/** How far (demo px) a saved stroke may stray from the pen's path. */
export const STROKE_TOLERANCE = 0.8;

const round1 = (value: number): number => Math.round(value * 10) / 10;

function distanceToLine(p: LiveDemoPoint, a: LiveDemoPoint, b: LiveDemoPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / length;
}

/** Ramer-Douglas-Peucker: the fewest points of `points` that stay within `tolerance` of the path. */
export function simplifyPoints(points: readonly LiveDemoPoint[], tolerance: number): LiveDemoPoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  // A stack, not recursion: a long stroke has thousands of points.
  const spans: Array<[number, number]> = [[0, points.length - 1]];
  while (spans.length > 0) {
    const [start, end] = spans.pop()!;
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let index = start + 1; index < end; index++) {
      const distance = distanceToLine(points[index], points[start], points[end]);
      if (distance > farthestDistance) {
        farthest = index;
        farthestDistance = distance;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    spans.push([start, farthest], [farthest, end]);
  }
  return points.filter((_, index) => keep[index] === 1);
}

/** At most `max` points, evenly spread, keeping the first and the last. */
export function thinPoints(points: readonly LiveDemoPoint[], max: number): LiveDemoPoint[] {
  if (points.length <= max) return [...points];
  if (max <= 1) return points.length > 0 ? [points[points.length - 1]] : [];
  const thinned: LiveDemoPoint[] = [];
  for (let index = 0; index < max; index++) {
    thinned.push(points[Math.round((index * (points.length - 1)) / (max - 1))]);
  }
  return thinned;
}

/**
 * The points to save for a finished stroke: repeats removed, simplified, to a
 * tenth of a pixel, and never more than `maxPoints`. A tap gives a stroke of
 * two equal points, which draws as a dot.
 */
export function simplifyStroke(
  points: readonly LiveDemoPoint[],
  maxPoints: number = LIVE_DEMO.strokePoints,
  tolerance: number = STROKE_TOLERANCE,
): LiveDemoPoint[] {
  const distinct: LiveDemoPoint[] = [];
  for (const point of points) {
    const previous = distinct[distinct.length - 1];
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) distinct.push(point);
  }
  if (distinct.length === 0) return [];
  const tenth = (point: LiveDemoPoint): LiveDemoPoint => [round1(point[0]), round1(point[1])];
  if (distinct.length === 1) return [tenth(distinct[0]), tenth(distinct[0])];
  let simplified = simplifyPoints(distinct, tolerance);
  // A huge scribble: allow a little more error until it fits.
  for (let widen = tolerance; simplified.length > maxPoints && widen < 1000;) {
    widen *= 1.6;
    simplified = simplifyPoints(distinct, widen);
  }
  if (simplified.length > maxPoints) simplified = thinPoints(simplified, maxPoints);
  return simplified.map(tenth);
}
