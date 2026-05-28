import type { AntigravityLane } from "./types.js";

/**
 * Pick the lane the snapshot should report on. Preference order:
 * most recent activity, then lowest percent remaining, then first lane.
 */
export function pickPrimaryLane(lanes: AntigravityLane[]): AntigravityLane {
  if (lanes.length === 1) return lanes[0]!;

  let recent = lanes[0]!;
  let recentAt = parseIsoMillis(recent.lastEventAt);
  for (let i = 1; i < lanes.length; i++) {
    const cur = lanes[i]!;
    const curAt = parseIsoMillis(cur.lastEventAt);
    if (curAt > recentAt) {
      recent = cur;
      recentAt = curAt;
    }
  }
  if (recentAt > 0) return recent;

  let lowest = lanes[0]!;
  for (let i = 1; i < lanes.length; i++) {
    if (lanes[i]!.percentRemaining < lowest.percentRemaining) {
      lowest = lanes[i]!;
    }
  }
  return lowest;
}

export function computePercentWindowDelta(
  prev: AntigravityLane | null | undefined,
  next: AntigravityLane | null | undefined,
): number | null {
  if (!prev || !next) return null;
  if (prev.laneId !== next.laneId) return null;
  if (
    !Number.isFinite(prev.percentRemaining)
    || !Number.isFinite(next.percentRemaining)
  ) return null;
  return next.percentRemaining - prev.percentRemaining;
}

function parseIsoMillis(value: string | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}
