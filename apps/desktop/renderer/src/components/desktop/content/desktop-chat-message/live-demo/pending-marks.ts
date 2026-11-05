import type { DemoMark, DemoMarkInput, LiveDemoPoint } from "./protocol";

/** What a mark is, without where it is saved or who made it. Undo puts a deleted mark back from this. */
export type MarkBody =
  | { kind: "stroke"; points: LiveDemoPoint[] }
  | { kind: "pin"; at: LiveDemoPoint; text: string };

/**
 * A mark of yours that the server does not have yet. It is drawn dashed while it
 * waits, and saved when the link is back, so a bad link loses nothing.
 */
export interface PendingMark {
  key: number;
  room: string;
  demo: string;
  body: MarkBody;
  /** A save failed at least once; the mark is shown as not saved. */
  waiting: boolean;
  attempts: number;
  /** Saves that failed while the connection said it was live: those are the ones that may never work. */
  liveFailures: number;
}

/** The wait before the next try, after `attempts` failed ones. */
export const PENDING_RETRY_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;
/** Failed saves while live after which a mark is given up (the server refuses it, say). */
export const PENDING_MAX_LIVE_FAILURES = 3;
/** Failed saves in all after which a mark is given up. */
export const PENDING_MAX_ATTEMPTS = 40;

export function pendingRetryDelay(attempts: number): number {
  return PENDING_RETRY_MS[Math.min(Math.max(attempts, 1), PENDING_RETRY_MS.length) - 1];
}

export function markBody(mark: DemoMark): MarkBody {
  return mark.kind === "stroke"
    ? { kind: "stroke", points: mark.points.map(([x, y]) => [x, y]) }
    : { kind: "pin", at: [mark.at[0], mark.at[1]], text: mark.text };
}

export function markInput(demo: string, body: MarkBody): DemoMarkInput {
  return body.kind === "stroke"
    ? { demo, kind: "stroke", points: body.points, anchor: null }
    : { demo, kind: "pin", at: body.at, text: body.text, anchor: null };
}

// The server keeps points to a tenth of a demo pixel, so a saved copy is within half of that.
const SAVED_POINT_SLACK = 0.051;

function samePoint(a: LiveDemoPoint, b: LiveDemoPoint): boolean {
  return Math.abs(a[0] - b[0]) <= SAVED_POINT_SLACK && Math.abs(a[1] - b[1]) <= SAVED_POINT_SLACK;
}

/**
 * True when a saved mark is this body. A save whose answer was lost still
 * reaches the server, and its broadcast copy tells the waiting mark it is saved.
 */
export function sameMarkBody(body: MarkBody, mark: DemoMark): boolean {
  if (body.kind === "pin") return mark.kind === "pin" && mark.text === body.text && samePoint(mark.at, body.at);
  if (mark.kind !== "stroke" || mark.points.length !== body.points.length) return false;
  return body.points.every((point, index) => samePoint(point, mark.points[index]));
}
